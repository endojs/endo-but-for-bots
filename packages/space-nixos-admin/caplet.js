// @ts-check
/* global process, setTimeout */

// Hosted-Endo NixOS machine-admin caplet.
//
// This is an UNCONFINED module (it has Node.js APIs) that the daemon
// instantiates via `agent.makeUnconfined('@main', <this>, { resultName:
// 'controller-for-nixos-admin', env })`. It is the capability that lets a
// trusted admin agent EDIT and APPLY the host's NixOS configuration without
// SSH, and the `performer` endowment of the deploy workflow charts (see
// designs/floot-admin-deploy-workflows.md).
//
// It does NOT run `nixos-rebuild` itself: that needs real root, which the
// daemon (running as the unprivileged `endo` user) does not have. Mirroring the
// deploy caplet (@endo/space-endo-mgmt), it speaks to a root-owned systemd
// service through a tiny file spool:
//
//   - edits    files under $ENDO_NIXOS_CONFIG_DIR   (an endo-owned git checkout)
//   - writes   $ENDO_NIXOS_DIR/apply-request.json   (atomically) to trigger work
//   - reads    $ENDO_NIXOS_DIR/apply-status.json     for the applier's progress
//   - reads    $ENDO_NIXOS_DIR/outcomes/<id>.json    for per-operation outcomes
//   - reads    $ENDO_NIXOS_DIR/apply.log             tail for diagnostics
//
// The root `endo-nixos-apply` service commits the checkout, runs
// `nixos-rebuild switch --flake $ENDO_NIXOS_CONFIG_DIR#<host>`, health-checks
// the daemon gateway, and auto-rolls-back to the previous generation on
// failure. See the endo-host repo's modules/endo-nixos-admin.nix for the other
// end.
//
// SPOOL CONTRACT (id echo). Every request carries a caller-supplied `id` (the
// workflow engine passes its run-qualified `${runId}:${effectId}` invoke key;
// conversational callers may omit it and get a minted one). The applier MUST
// echo that `id` in `apply-status.json` while working and MUST write the
// terminal record to `outcomes/<sanitized id>.json` when done. The mutating
// verbs here are settlement-shaped: they submit, then watch for the outcome
// of their own id, and RETURN the terminal record. Re-invoking a verb with a
// key whose outcome is already recorded returns that record WITHOUT
// re-submitting — this is the property that keeps a workflow run's
// at-least-once re-dispatch from re-applying a config after the apply itself
// restarted the daemon (a re-apply here would restart it again: a loop).
// The decision tree therefore never falls through to "submit" on ambiguity:
// a status file that does not carry ids is a contract violation and throws.
//
// SECURITY: applying NixOS config is root-equivalent — a committed change can
// carry activation scripts and systemd units the root service will build and
// run. The value here is not sandboxing but mediation: every change is
// git-committed (auditable), the privileged action is a fixed rebuild command
// (not arbitrary shell), and a failed apply auto-rolls-back.

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  readdir,
  rm,
} from 'node:fs/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';

// The config reads this file with `lib.fileContents`, so a revision bump is a
// one-line diff and setting it is a whole-file write of a validated hash rather
// than an edit to Nix source.
const ENDO_REV_FILE = 'endo.rev';

// An unbounded watch would outlive any plausible rebuild; the charts own the
// real deadlines (`after` effects), this cap only prevents immortal loops.
const WATCH_LIMIT_MS = 24 * 60 * 60 * 1000;

const StagedFileShape = M.splitRecord({ path: M.string(), text: M.string() });
// `text: null` records "the file did not exist", so revert removes it.
const PreviousFileShape = M.splitRecord({
  path: M.string(),
  text: M.or(M.string(), M.null()),
});

const NixosAdminInterface = M.interface('NixosAdmin', {
  getConfig: M.call().returns(M.promise()),
  listFiles: M.call().optional(M.string()).returns(M.promise()),
  readFile: M.call(M.string()).returns(M.promise()),
  writeFile: M.call(M.string(), M.string()).returns(M.promise()),
  getEndoRev: M.call().returns(M.promise()),
  stageRev: M.call(M.string()).optional(M.string()).returns(M.promise()),
  stageFiles: M.call(M.arrayOf(StagedFileShape))
    .optional(M.string())
    .returns(M.promise()),
  revertFiles: M.call(M.arrayOf(PreviousFileShape))
    .optional(M.string())
    .returns(M.promise()),
  build: M.call().optional(M.string(), M.string()).returns(M.promise()),
  apply: M.call(M.string()).optional(M.string()).returns(M.promise()),
  rollback: M.call().optional(M.string()).returns(M.promise()),
  verify: M.call(M.string()).optional(M.string()).returns(M.promise()),
  status: M.call().returns(M.promise()),
  getLog: M.call().optional(M.number()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Resolve `relPath` beneath `baseDir`, rejecting absolute paths, `..` escapes,
 * and anything under the repo's `.git` directory. Exported for unit testing;
 * this is the single choke point that confines every file operation to the
 * NixOS config checkout.
 *
 * @param {string} baseDir - absolute config-checkout directory
 * @param {string} relPath - caller-supplied path, relative to baseDir
 * @returns {string} absolute, validated path within baseDir
 */
export const resolveWithin = (baseDir, relPath) => {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new Error('A non-empty relative path is required.');
  }
  const base = resolve(baseDir);
  const target = resolve(base, relPath);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes the config directory: ${relPath}`);
  }
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) {
    throw new Error(`The .git directory is not editable: ${relPath}`);
  }
  return target;
};
harden(resolveWithin);

/**
 * Idempotency keys become outcome file names, so they must be filesystem-safe
 * regardless of what the engine or a caller minted. Exported for unit testing.
 *
 * @param {string} id
 * @returns {string}
 */
export const sanitizeId = id => {
  if (typeof id !== 'string' || id === '') {
    throw new Error('A non-empty request id is required.');
  }
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
};
harden(sanitizeId);

/**
 * @param {string} dir
 * @param {string} base - repo root, for computing relative paths
 * @returns {Promise<string[]>}
 */
const walkFiles = async (dir, base) => {
  /** @type {string[]} */
  const out = [];
  await null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name === '.git') {
      // Skip the repo's git metadata directory.
    } else if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      const nested = await walkFiles(full, base);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push(relative(base, full));
    }
  }
  return out;
};

/** @param {number} ms */
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/**
 * @param {string} path
 * @returns {Promise<any | undefined>} parsed JSON, or undefined when the file
 *   is absent or unreadable (a torn read retries on the next poll).
 */
const readJson = async path => {
  await null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * @param {unknown} _powers - unused (the caplet acts through files + spool)
 * @param {unknown} _context
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export const make = async (_powers, _context, options = {}) => {
  const env = (options && options.env) || {};
  const readEnv = key => env[key] || process.env[key] || '';

  const configDir = readEnv('ENDO_NIXOS_CONFIG_DIR');
  const nixosDir = readEnv('ENDO_NIXOS_DIR');
  const host = readEnv('ENDO_NIXOS_HOST') || 'endo-server';
  // Tests dial this down; the applier's work is minutes-grained in production.
  const pollMs = Number(readEnv('ENDO_NIXOS_POLL_MS')) || 2000;

  const requestPath = nixosDir ? join(nixosDir, 'apply-request.json') : '';
  const statusPath = nixosDir ? join(nixosDir, 'apply-status.json') : '';
  const logPath = nixosDir ? join(nixosDir, 'apply.log') : '';
  const outcomesDir = nixosDir ? join(nixosDir, 'outcomes') : '';

  const config = harden({
    configDir,
    nixosDir,
    host,
    configured: Boolean(configDir && nixosDir),
  });

  const requireConfigured = () => {
    if (!config.configured) {
      throw new Error(
        'NixOS admin is not configured on this daemon ' +
          '(ENDO_NIXOS_CONFIG_DIR / ENDO_NIXOS_DIR are unset).',
      );
    }
  };

  // Monotonic within this incarnation; combined with the wall clock so every
  // physical request write is a distinct value and the applier's path-watcher
  // always fires. Freshness only — `id` carries the operation's identity.
  let counter = 0;
  const nextNonce = () => {
    counter += 1;
    return `${new Date().toISOString()}#${counter}`;
  };
  const mintId = action => `local:${action}:${nextNonce()}`;

  const outcomePathFor = id => join(outcomesDir, `${sanitizeId(id)}.json`);

  const readOutcome = async id => readJson(outcomePathFor(id));
  const readStatus = async () => readJson(statusPath);
  const readRequest = async () => readJson(requestPath);

  const readLogTail = async (maxBytes = 8192) => {
    await null;
    if (!logPath) return '';
    try {
      const text = await readFile(logPath, 'utf8');
      return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
    } catch {
      return '';
    }
  };

  /** @param {Record<string, unknown>} request */
  const writeRequest = async request => {
    await mkdir(nixosDir, { recursive: true });
    const body = `${JSON.stringify(request)}\n`;
    const tmp = `${requestPath}.tmp`;
    // Write-then-rename so the applier's path unit only ever sees a complete
    // request file (rename is atomic on the same filesystem).
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, requestPath);
  };

  /**
   * Shape an outcome record for callers: the applier's terminal record plus
   * a computed `ok`, with a log tail attached on failure.
   *
   * @param {any} outcome
   */
  const settle = async outcome => {
    await null;
    const ok = outcome.phase === 'ok';
    return harden({
      ...outcome,
      ...(ok ? {} : { log: await readLogTail() }),
      ok,
    });
  };

  /**
   * Await the terminal outcome for `id`, without ever re-submitting.
   * Throws on a status file that predates the id-echo contract, on the
   * request being superseded without an outcome, and on the watch cap.
   *
   * @param {string} id
   */
  // How many consecutive polls may show an id-less status before the watch
  // concludes the applier predates the id-echo contract. Generous enough to
  // ride out one stale pre-upgrade status file being overwritten, short
  // enough to fail a genuinely legacy host in about a minute. Whatever the
  // conclusion, the watch NEVER falls back to re-submitting.
  const NO_ID_GRACE_POLLS = 30;

  const awaitOutcome = async id => {
    await null;
    const deadline = Date.now() + WATCH_LIMIT_MS;
    let idlessPolls = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await readOutcome(id);
      if (outcome !== undefined) {
        return settle(outcome);
      }
      // eslint-disable-next-line no-await-in-loop
      const status = await readStatus();
      if (status !== undefined && status.id === undefined) {
        // Never guess against an id-less status: guessing wrong on an apply
        // means re-applying, and a re-apply restarts the machine again. A
        // bounded grace tolerates one stale pre-upgrade status file.
        idlessPolls += 1;
        if (idlessPolls > NO_ID_GRACE_POLLS) {
          throw new Error(
            'The nixos applier does not echo request ids; update ' +
              'endo-nixos-admin.nix to the id-echo spool contract before ' +
              'using the settlement-shaped verbs.',
          );
        }
      } else {
        idlessPolls = 0;
      }
      if (status !== undefined && status.id !== undefined && status.id !== id) {
        // eslint-disable-next-line no-await-in-loop
        const request = await readRequest();
        if (request === undefined || request.id !== id) {
          // Someone else's request took the slot and ours left no outcome:
          // it was lost. Fail loudly; the caller (chart or human) decides
          // whether to submit a NEW operation under a NEW id.
          throw new Error(
            `Request ${id} was superseded without an outcome; not retrying.`,
          );
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Request ${id} saw no outcome within 24h; giving up.`);
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  };

  // One deployment operation at a time: the spool has a single request slot,
  // so submissions queue behind the previous operation's terminal outcome
  // (or failure). In-process only — incarnations do not overlap, and across
  // a restart the on-disk request/outcome files carry the truth.
  let queueTail = Promise.resolve();
  const enqueue = job => {
    const run = queueTail.then(job, job);
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Submit `action` under idempotency key `id` and await its outcome.
   * NEVER submits when the id already has an outcome or a pending request —
   * the property that makes at-least-once re-dispatch safe.
   *
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {string} message
   * @param {string | undefined} key
   */
  const submitAndAwait = async (action, message, key) => {
    requireConfigured();
    const id = key !== undefined ? key : mintId(action);
    sanitizeId(id);
    // Fast paths that must NOT wait behind the queue: an already-recorded
    // outcome (re-dispatch after a restart) and an already-pending request
    // (a duplicate dispatch racing its twin).
    const recorded = await readOutcome(id);
    if (recorded !== undefined) {
      return settle(recorded);
    }
    const pending = await readRequest();
    if (pending !== undefined && pending.id === id) {
      return awaitOutcome(id);
    }
    return enqueue(async () => {
      // Re-check under the queue lock: the state may have advanced while
      // this operation waited its turn.
      const nowRecorded = await readOutcome(id);
      if (nowRecorded !== undefined) {
        return settle(nowRecorded);
      }
      const nowPending = await readRequest();
      if (nowPending === undefined || nowPending.id !== id) {
        // Refuse to submit against an applier that cannot echo ids back:
        // without the echo, a re-dispatch could not tell "done" from
        // "never ran" and this caplet would rather stop than loop.
        const status = await readStatus();
        if (status !== undefined && status.id === undefined) {
          throw new Error(
            'The nixos applier does not echo request ids; update ' +
              'endo-nixos-admin.nix to the id-echo spool contract before ' +
              'using the settlement-shaped verbs.',
          );
        }
        await writeRequest({ action, message, id, nonce: nextNonce() });
      }
      return awaitOutcome(id);
    });
  };

  return makeExo('NixosAdmin', NixosAdminInterface, {
    /** Static host config (paths + flake host) for orientation. */
    async getConfig() {
      return config;
    },

    /**
     * List every tracked config file (relative paths), optionally beneath a
     * subdirectory. Skips the `.git` directory.
     *
     * @param {string} [subdir]
     */
    async listFiles(subdir) {
      requireConfigured();
      const root = subdir
        ? resolveWithin(configDir, subdir)
        : resolve(configDir);
      const files = await walkFiles(root, resolve(configDir));
      files.sort();
      return harden(files);
    },

    /**
     * Read one config file as UTF-8 text.
     *
     * @param {string} path
     */
    async readFile(path) {
      requireConfigured();
      const target = resolveWithin(configDir, path);
      return readFile(target, 'utf8');
    },

    /**
     * Write (create or overwrite) one config file. Parent directories are
     * created as needed. Nothing is applied until `build`/`apply` is called.
     * The single-file conversational form of `stageFiles`.
     *
     * @param {string} path
     * @param {string} text
     */
    async writeFile(path, text) {
      requireConfigured();
      if (typeof text !== 'string') {
        throw new Error('writeFile: text must be a string.');
      }
      const target = resolveWithin(configDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
      return harden({ path, bytes: text.length });
    },

    /**
     * The Endo commit this host is configured to run, as recorded in
     * `endo.rev`. This is the configured revision, which is the running one
     * only once the config has been applied.
     */
    async getEndoRev() {
      requireConfigured();
      await null;
      try {
        const text = await readFile(join(configDir, ENDO_REV_FILE), 'utf8');
        return text.trim();
      } catch {
        // No pin file: the host still tracks services.endo.defaultBranch.
        return '';
      }
    },

    /**
     * Stage a different Endo commit. Nothing happens until `build`/`apply`.
     * Returns the previously staged revision so compensation (un-pinning an
     * abandoned proposal) is a second `stageRev`.
     *
     * Validating here rather than letting the write through means a bad
     * argument fails at the capability boundary, instead of as a Nix
     * evaluation error minutes later in someone else's log.
     *
     * Naturally idempotent: re-staging the same revision is a no-op write,
     * so the trailing key is accepted for uniformity and unused.
     *
     * @param {string} rev - full 40-character lowercase commit hash
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async stageRev(rev, _key) {
      requireConfigured();
      const trimmed = String(rev).trim();
      if (!/^[0-9a-f]{40}$/.test(trimmed)) {
        throw makeError(
          X`stageRev needs a full 40-character lowercase commit hash, got ${q(rev)}`,
        );
      }
      const target = join(configDir, ENDO_REV_FILE);
      const previous = await readFile(target, 'utf8')
        .then(text => text.trim())
        .catch(() => '');
      await mkdir(configDir, { recursive: true });
      // The trailing newline is load-bearing for readability, not for parsing:
      // `lib.fileContents` strips exactly one, and a file without it shows up
      // in every diff as "no newline at end of file".
      await writeFile(target, `${trimmed}\n`, 'utf8');
      return harden({ path: ENDO_REV_FILE, rev: trimmed, previous });
    },

    /**
     * Stage a batch of whole-file edits, capturing each file's previous
     * contents (`text: null` when it did not exist) so `revertFiles` can
     * restore them. Naturally idempotent for identical input.
     *
     * @param {Array<{ path: string, text: string }>} files
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async stageFiles(files, _key) {
      requireConfigured();
      await null;
      /** @type {Array<{ path: string, text: string | null }>} */
      const previous = [];
      const paths = [];
      for (const { path } of files) {
        const target = resolveWithin(configDir, path);
        // eslint-disable-next-line no-await-in-loop
        const before = await readFile(target, 'utf8').catch(() => null);
        previous.push({ path, text: before });
        paths.push(path);
      }
      for (const { path, text } of files) {
        const target = resolveWithin(configDir, path);
        // eslint-disable-next-line no-await-in-loop
        await mkdir(dirname(target), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await writeFile(target, text, 'utf8');
      }
      return harden({ paths: harden(paths), previous: harden(previous) });
    },

    /**
     * Restore files captured by `stageFiles` — the compensation for an
     * abandoned change. Entries with `text: null` are removed (the stage
     * created them). Naturally idempotent.
     *
     * @param {Array<{ path: string, text: string | null }>} previous
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async revertFiles(previous, _key) {
      requireConfigured();
      await null;
      const paths = [];
      for (const { path, text } of previous) {
        const target = resolveWithin(configDir, path);
        if (text === null) {
          // eslint-disable-next-line no-await-in-loop
          await rm(target, { force: true });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await mkdir(dirname(target), { recursive: true });
          // eslint-disable-next-line no-await-in-loop
          await writeFile(target, text, 'utf8');
        }
        paths.push(path);
      }
      return harden({ paths: harden(paths) });
    },

    /**
     * Validate the staged config by building it WITHOUT activating —
     * settlement-shaped: waits for the applier's terminal outcome and
     * returns `{ ok, phase, ..., log? }`.
     *
     * @param {string} [note] - recorded in status for the audit trail
     * @param {string} [key] - workflow idempotency key
     */
    async build(note, key) {
      return submitAndAwait('build', (note && String(note)) || '', key);
    },

    /**
     * Commit the current edits and `nixos-rebuild switch` — settlement-shaped.
     * The root service health-checks the daemon gateway afterward and
     * auto-rolls-back to the previous generation if it does not come back
     * healthy. A commit message is REQUIRED (it is the audit record).
     *
     * A SUCCESSFUL apply restarts this daemon, so the caller's promise dies
     * with the process; a workflow run recovers by re-dispatch (same key →
     * the recorded outcome, never a second apply), and a conversational
     * caller verifies with `getEndoRev()`/`status()` on its next turn.
     *
     * @param {string} message
     * @param {string} [key] - workflow idempotency key
     */
    async apply(message, key) {
      const trimmed = message && String(message).trim();
      if (!trimmed) {
        throw new Error('apply requires a non-empty commit message.');
      }
      return submitAndAwait('switch', trimmed, key);
    },

    /**
     * Emergency undo — settlement-shaped: reactivate the last HEALTHY
     * generation (not merely the previous one, which may itself have been a
     * failed apply). Does not touch the staged edits. Like `apply`, a
     * successful rollback restarts the daemon.
     *
     * @param {string} [key] - workflow idempotency key
     */
    async rollback(key) {
      return submitAndAwait('rollback', '', key);
    },

    /**
     * Post-apply readback: does the checkout's pinned revision match `rev`?
     * A pure read (safe under at-least-once re-dispatch). The caplet
     * answering at all is itself evidence the daemon came back; after an
     * auto-rollback the applier has rewound `endo.rev`, so the mismatch
     * reports `ok: false`.
     *
     * @param {string} rev - full 40-character lowercase commit hash
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async verify(rev, _key) {
      requireConfigured();
      const trimmed = String(rev).trim();
      if (!/^[0-9a-f]{40}$/.test(trimmed)) {
        throw makeError(
          X`verify needs a full 40-character lowercase commit hash, got ${q(rev)}`,
        );
      }
      const runningRev = await readFile(join(configDir, ENDO_REV_FILE), 'utf8')
        .then(text => text.trim())
        .catch(() => '');
      const status = await readStatus();
      return harden({
        ok: runningRev === trimmed,
        runningRev,
        ...(status !== undefined && status.phase !== undefined
          ? { phase: status.phase }
          : {}),
      });
    },

    /** Current applier status plus the static host config. */
    async status() {
      await null;
      const status = statusPath ? ((await readStatus()) ?? null) : null;
      return harden({ config, status });
    },

    /**
     * Tail of the apply log for diagnostics.
     *
     * @param {number} [maxBytes]
     */
    async getLog(maxBytes = 8192) {
      return readLogTail(maxBytes);
    },

    /** @param {string} [method] */
    help(method) {
      const lines = {
        '':
          "NixosAdmin: edit and apply this host's NixOS configuration. " +
          'listFiles(subdir?) / readFile(path) / writeFile(path, text) edit ' +
          'the endo-owned flake checkout; stageRev(rev) pins the Endo commit ' +
          'this host runs (getEndoRev() reads it); stageFiles/revertFiles ' +
          'stage and undo whole-file batches. build/apply/rollback are ' +
          'SETTLEMENT-SHAPED: they submit to the root applier and return its ' +
          'terminal outcome ({ ok, phase, ..., log? on failure }) — no ' +
          'polling. Each takes an optional trailing idempotency key; ' +
          'repeating a key returns the recorded outcome instead of ' +
          're-submitting. apply(message) commits + switches with ' +
          'health-checked auto-rollback, and a SUCCESSFUL apply restarts ' +
          'this daemon (verify with getEndoRev()/status() afterward). ' +
          'Applying is ROOT-EQUIVALENT — build() first and confirm with the ' +
          'user before apply().',
        listFiles:
          'listFiles(subdir?) -> string[] of relative config file paths.',
        readFile: 'readFile(path) -> UTF-8 contents of one config file.',
        writeFile:
          'writeFile(path, text) -> stage one edit (not yet applied); the ' +
          'single-file form of stageFiles.',
        getEndoRev:
          'getEndoRev() -> the Endo commit this host is configured to run.',
        stageRev:
          'stageRev(rev, key?) -> stage a different Endo commit (40-hex ' +
          'hash); returns { rev, previous } so the pin can be restored. ' +
          'Takes effect on apply(); a failed apply rolls the revision back ' +
          'with the generation.',
        stageFiles:
          'stageFiles([{ path, text }], key?) -> stage whole-file edits; ' +
          'returns { paths, previous } for revertFiles.',
        revertFiles:
          'revertFiles(previous, key?) -> restore files captured by ' +
          'stageFiles (text: null entries are removed).',
        build:
          'build(note?, key?) -> dry-run nixos-rebuild build (no ' +
          'activation); waits for and returns the terminal outcome.',
        apply:
          'apply(message, key?) -> commit + nixos-rebuild switch + ' +
          'auto-rollback; waits for the terminal outcome. Success restarts ' +
          'the daemon, so the call may never return — check afterward.',
        rollback:
          'rollback(key?) -> reactivate the last system generation that ' +
          'passed its health check; waits for the terminal outcome.',
        verify:
          'verify(rev, key?) -> { ok, runningRev, phase? }: is the checkout ' +
          'pinned to rev? A pure read.',
        status: 'status() -> { config, status } of the applier right now.',
        getLog: 'getLog(maxBytes?) -> tail of the apply log.',
      };
      return lines[method || ''] || lines[''];
    },
  });
};
harden(make);
