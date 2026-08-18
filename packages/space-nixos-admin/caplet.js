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
// conversational callers may omit it and get a minted one). The applier:
//   - MUST echo the request's `id` in `apply-status.json` while working;
//   - MUST write the terminal record — embedding that same raw `id` — to
//     `outcomes/<sanitized id>.json` when done (the caplet verifies the
//     embedded id, since sanitized file names can collide for exotic
//     caller-minted keys);
//   - SHOULD leave `apply-request.json` in place until the next submission
//     overwrites it (if it consumes the file instead, the status echo covers
//     the gap — the caplet checks status before ever submitting);
//   - on upgrade to this contract, SHOULD clear or rewrite pre-contract spool
//     files (a status file without an `id` field makes the caplet refuse to
//     submit rather than risk an uncorrelatable root-equivalent action).
//
// The mutating verbs here are settlement-shaped: they submit, then watch for
// the outcome of their own id, and RETURN the terminal record. Re-invoking a
// verb with a key whose outcome is already recorded returns that record
// WITHOUT re-submitting — this is the property that keeps a workflow run's
// at-least-once re-dispatch from re-applying a config after the apply itself
// restarted the daemon (a re-apply here would restart it again: a loop).
// The decision tree never falls through to "submit" on ambiguity: an id-less
// status, an unreadable file at a decision point (after bounded retries), a
// mismatched outcome record, and a superseded request all fail LOUD instead.
// One known residue: on a fresh host whose applier has never written a status
// file, a legacy (non-echoing) applier is undetectable until after the first
// submission — one operation can escape before the watch's grace period
// raises the contract error; it is never re-submitted.
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
  open,
} from 'node:fs/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';

// The config reads this file with `lib.fileContents`, so a revision bump is a
// one-line diff and setting it is a whole-file write of a validated hash rather
// than an edit to Nix source.
const ENDO_REV_FILE = 'endo.rev';

// An unbounded watch would outlive any plausible rebuild; the charts own the
// real deadlines (`after` effects), this cap only prevents immortal loops —
// and, dialed down via ENDO_NIXOS_WATCH_LIMIT_MS in tests, keeps an
// abandoned watcher from holding a test worker open. Timers stay ref'd on
// purpose: an unref'd timer that is the only event-loop item never fires.
const DEFAULT_WATCH_LIMIT_MS = 24 * 60 * 60 * 1000;

// Bounded retries for unreadable files at submit-decision points: a torn or
// fd-starved read must not masquerade as "file absent" (that conversion was
// the one reviewed path to a re-submission loop), but a transient blip
// should not fail an operation either.
const DECISIVE_READ_ATTEMPTS = 3;

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
  status: M.call().optional(M.string()).returns(M.promise()),
  getLog: M.call().optional(M.number()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Resolve `relPath` beneath `baseDir`, rejecting absolute paths, `..` escapes,
 * and anything under the repo's `.git` directory. Exported for unit testing;
 * this is the single choke point that confines every file operation to the
 * NixOS config checkout (lexical confinement: symlinks inside the checkout
 * are not chased — stageFiles cannot create them, and the checkout is owned
 * by the applier's own mirror).
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
 * regardless of what the engine or a caller minted. NOT injective — the
 * outcome record's embedded raw id is verified on every read to make a
 * sanitized-name collision a loud contract error instead of a wrong
 * settlement. Exported for unit testing.
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
 * Tri-state JSON file read. `absent` is ONLY a true ENOENT; every other
 * failure (permissions, fd exhaustion, I/O error, torn/garbled content) is
 * `error` — the caller decides whether that is retryable or fatal, and a
 * submit decision must never treat it as absence.
 *
 * @param {string} path
 * @returns {Promise<{ state: 'absent' } | { state: 'ok', value: any } | { state: 'error', error: Error }>}
 */
const readJsonFile = async path => {
  await null;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (readError) {
    if (/** @type {any} */ (readError).code === 'ENOENT') {
      return harden({ state: 'absent' });
    }
    return harden({ state: 'error', error: /** @type {Error} */ (readError) });
  }
  try {
    return harden({ state: 'ok', value: JSON.parse(text) });
  } catch (parseError) {
    return harden({ state: 'error', error: /** @type {Error} */ (parseError) });
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
  // Tests dial these down; the applier's work is minutes-grained in
  // production.
  const pollMs = Number(readEnv('ENDO_NIXOS_POLL_MS')) || 2000;
  const watchLimitMs =
    Number(readEnv('ENDO_NIXOS_WATCH_LIMIT_MS')) || DEFAULT_WATCH_LIMIT_MS;

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

  /**
   * Read a file whose content decides whether to SUBMIT. Retries transient
   * errors a few times, then refuses loudly — never converts "cannot read"
   * into "does not exist".
   *
   * @param {string} path
   * @returns {Promise<any | undefined>} the parsed value, or undefined only
   *   on a true ENOENT
   */
  const readDecisive = async path => {
    await null;
    /** @type {Error | undefined} */
    let lastError;
    for (let attempt = 0; attempt < DECISIVE_READ_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await readJsonFile(path);
      if (result.state === 'absent') {
        return undefined;
      }
      if (result.state === 'ok') {
        return result.value;
      }
      lastError = result.error;
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
    throw new Error(
      `Refusing to decide against unreadable ${q(path)}: ${
        lastError ? lastError.message : 'unknown error'
      }`,
    );
  };

  /**
   * Validate an outcome record read from `outcomes/<sanitized id>.json`.
   * The embedded raw id must match the requested one — sanitized names can
   * collide, and returning another operation's record would either skip a
   * needed action or misreport one.
   *
   * @param {any} record
   * @param {string} id
   */
  const assertOutcomeRecord = (record, id) => {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.phase !== 'string'
    ) {
      throw new Error(
        `Malformed outcome record for ${q(id)}: expected { id, phase, ... }.`,
      );
    }
    if (record.id !== id) {
      throw new Error(
        `Outcome file for ${q(id)} holds a record for ${q(record.id)} — ` +
          'sanitized-name collision; refusing to settle from it.',
      );
    }
  };

  const readLogTail = async (maxBytes = 8192) => {
    if (!logPath) return '';
    await null;
    let handle;
    try {
      handle = await open(logPath, 'r');
      const { size } = await handle.stat();
      const start = size > maxBytes ? size - maxBytes : 0;
      const length = size - start;
      const bytes = new Uint8Array(length);
      await handle.read(bytes, 0, length, start);
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
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
   * Shape a VERIFIED outcome record for callers: the applier's terminal
   * record plus a computed `ok`, with a log tail attached on failure.
   *
   * @param {any} record
   */
  const settle = async record => {
    await null;
    const ok = record.phase === 'ok';
    const log = ok ? undefined : await readLogTail();
    return harden({
      ...record,
      ...(log !== undefined ? { log } : {}),
      ok,
    });
  };

  // How many consecutive polls may show an id-less status before the watch
  // concludes the applier predates the id-echo contract. Generous enough to
  // ride out one stale pre-upgrade status file being overwritten, short
  // enough to fail a genuinely legacy host in about a minute. Whatever the
  // conclusion, the watch NEVER falls back to re-submitting.
  const NO_ID_GRACE_POLLS = 30;

  /**
   * Await the terminal outcome for `id`, without ever submitting anything.
   * Transient read errors are inconclusive (retry next poll); an id-less
   * status beyond the grace, a verified-mismatched outcome record, a
   * superseded request, and the watch cap all throw.
   *
   * @param {string} id
   */
  const awaitOutcome = async id => {
    await null;
    const outcomePath = outcomePathFor(id);
    const deadline = Date.now() + watchLimitMs;
    let idlessPolls = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await readJsonFile(outcomePath);
      if (outcome.state === 'ok') {
        assertOutcomeRecord(outcome.value, id);
        return settle(outcome.value);
      }
      // eslint-disable-next-line no-await-in-loop
      const status = await readJsonFile(statusPath);
      if (status.state === 'ok' && status.value?.id === undefined) {
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
      } else if (status.state === 'ok') {
        idlessPolls = 0;
      }
      if (
        status.state === 'ok' &&
        status.value?.id !== undefined &&
        status.value.id !== id
      ) {
        // Conclude supersession only from DEFINITE reads: the request file
        // read must succeed (or be a true ENOENT) and not name us.
        // eslint-disable-next-line no-await-in-loop
        const request = await readJsonFile(requestPath);
        if (
          request.state === 'absent' ||
          (request.state === 'ok' && request.value?.id !== id)
        ) {
          // Someone else's request took the slot and ours left no outcome:
          // it was lost. Fail loudly; the caller (chart or human) decides
          // whether to submit a NEW operation under a NEW id.
          throw new Error(
            `Request ${id} was superseded without an outcome; not retrying.`,
          );
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Request ${id} saw no outcome within the watch limit; giving up.`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  };

  // One deployment operation at a time: the spool has a single request slot,
  // so submissions queue behind the previous operation's terminal outcome
  // (or failure). The queue position is reserved SYNCHRONOUSLY at the call,
  // so call order is queue order (no fast-path read races the reservation).
  // In-process only — incarnations do not overlap; across a restart the
  // on-disk request/outcome files carry the truth, and driveOperation's
  // foreign-pending wait below restores ordering against a previous
  // incarnation's still-unprocessed request.
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
   * The full submit-or-attach decision loop for one operation. Runs inside
   * the queue. NEVER submits when the id already has an outcome, a pending
   * request, or an in-flight status echo — the properties that make
   * at-least-once re-dispatch safe.
   *
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {string} message
   * @param {string} id
   */
  const driveOperation = async (action, message, id) => {
    await null;
    const deadline = Date.now() + watchLimitMs;
    for (;;) {
      // Already settled (the normal re-dispatch-after-restart path).
      // eslint-disable-next-line no-await-in-loop
      const recorded = await readDecisive(outcomePathFor(id));
      if (recorded !== undefined) {
        assertOutcomeRecord(recorded, id);
        return settle(recorded);
      }
      // Our own submission is already pending: attach, never rewrite.
      // eslint-disable-next-line no-await-in-loop
      const pending = await readDecisive(requestPath);
      if (pending !== undefined && pending.id === id) {
        return awaitOutcome(id);
      }
      // eslint-disable-next-line no-await-in-loop
      const status = await readDecisive(statusPath);
      if (status !== undefined && status.id === undefined) {
        // Refuse to submit against an applier that cannot echo ids back:
        // without the echo, a re-dispatch could not tell "done" from
        // "never ran" and this caplet would rather stop than loop.
        throw new Error(
          'The nixos applier does not echo request ids; update ' +
            'endo-nixos-admin.nix to the id-echo spool contract before ' +
            'using the settlement-shaped verbs.',
        );
      }
      if (status !== undefined && status.id === id) {
        // A consuming applier already picked our request up (the request
        // file is gone but the status echoes us): it is in flight —
        // possibly mid health-check on the other side of our own restart.
        // Watch; never write.
        return awaitOutcome(id);
      }
      let slotBusy = false;
      if (
        pending !== undefined &&
        typeof pending.id === 'string' &&
        pending.id !== '' &&
        pending.id !== id
      ) {
        // A previous incarnation's submission still holds the slot and has
        // no outcome yet: the slot is BUSY. Overwriting would destroy a
        // possibly-approved operation and later misreport it as
        // "superseded". Wait for its outcome (or its disappearance). An
        // id-less request file (pre-contract artifact) is stale by
        // definition — no new-contract operation is ever submitted without
        // an id — and is overwritten like an empty slot.
        // eslint-disable-next-line no-await-in-loop
        const foreign = await readJsonFile(outcomePathFor(pending.id));
        slotBusy = foreign.state !== 'ok';
      }
      if (slotBusy) {
        if (Date.now() > deadline) {
          throw new Error(
            `Request ${id} waited out the watch limit behind another; giving up.`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await delay(pollMs);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await writeRequest({ action, message, id, nonce: nextNonce() });
        return awaitOutcome(id);
      }
    }
  };

  /**
   * Reserve a queue slot (synchronously — call order is queue order) and
   * run the decision loop in it.
   *
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {string} message
   * @param {string | undefined} key
   */
  const submitAndAwait = (action, message, key) => {
    requireConfigured();
    const id = key !== undefined ? key : mintId(action);
    sanitizeId(id);
    return enqueue(() => driveOperation(action, message, id));
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
     * Stage a different Endo commit, or — with the empty string — remove the
     * pin entirely (restoring branch tracking). Nothing happens until
     * `build`/`apply`. Returns the previously staged revision (`''` when no
     * pin file existed) so compensation is a second `stageRev`: restaging
     * `previous` always restores the exact prior state, including "no pin".
     *
     * Validating here rather than letting the write through means a bad
     * argument fails at the capability boundary, instead of as a Nix
     * evaluation error minutes later in someone else's log.
     *
     * Naturally idempotent, so the trailing key is accepted for uniformity
     * and unused.
     *
     * @param {string} rev - full 40-character lowercase commit hash, or ''
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async stageRev(rev, _key) {
      requireConfigured();
      const trimmed = String(rev).trim();
      if (trimmed !== '' && !/^[0-9a-f]{40}$/.test(trimmed)) {
        throw makeError(
          X`stageRev needs a full 40-character lowercase commit hash (or '' to un-pin), got ${q(rev)}`,
        );
      }
      const target = join(configDir, ENDO_REV_FILE);
      const previous = await readFile(target, 'utf8')
        .then(text => text.trim())
        .catch(() => '');
      if (trimmed === '') {
        await rm(target, { force: true });
        return harden({ path: ENDO_REV_FILE, rev: '', previous });
      }
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
     * restore them. A file that exists but cannot be read REFUSES the whole
     * stage (a lost capture would make the change unrevertable), and a
     * failure while writing restores the already-written prefix before
     * throwing, so a failed stage leaves the checkout as it found it.
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
        let before = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          before = await readFile(target, 'utf8');
        } catch (readError) {
          if (/** @type {any} */ (readError).code !== 'ENOENT') {
            throw new Error(
              `stageFiles: cannot capture previous contents of ${q(path)}; refusing to stage.`,
              { cause: readError },
            );
          }
        }
        previous.push({ path, text: before });
        paths.push(path);
      }
      let written = 0;
      try {
        for (const { path, text } of files) {
          const target = resolveWithin(configDir, path);
          // eslint-disable-next-line no-await-in-loop
          await mkdir(dirname(target), { recursive: true });
          // eslint-disable-next-line no-await-in-loop
          await writeFile(target, text, 'utf8');
          written += 1;
        }
      } catch (writeError) {
        // Best-effort rollback of the written prefix, so a half-staged
        // change never rides into someone else's next apply.
        for (let index = 0; index < written; index += 1) {
          const { path, text } = previous[index];
          const target = resolveWithin(configDir, path);
          try {
            if (text === null) {
              // eslint-disable-next-line no-await-in-loop
              await rm(target, { force: true });
            } else {
              // eslint-disable-next-line no-await-in-loop
              await writeFile(target, text, 'utf8');
            }
          } catch {
            // The throw below already reports the stage as failed; a
            // rollback failure leaves at most the reported files dirty.
          }
        }
        throw new Error(
          `stageFiles failed after ${written} of ${files.length} writes; ` +
            'the written prefix was restored.',
          { cause: writeError },
        );
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
     * reports `ok: false`. `phase` passes through the applier's current
     * status so charts can additionally require a settled applier.
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
      const status = await readJsonFile(statusPath);
      const phase =
        status.state === 'ok' && typeof status.value?.phase === 'string'
          ? status.value.phase
          : undefined;
      return harden({
        ok: runningRev === trimmed,
        runningRev,
        ...(phase !== undefined ? { phase } : {}),
      });
    },

    /**
     * Current applier status plus the static host config. A pure read;
     * accepts the workflow engine's trailing key so charts can probe it.
     *
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async status(_key) {
      await null;
      const status = statusPath ? await readJsonFile(statusPath) : undefined;
      return harden({
        config,
        status:
          status !== undefined && status.state === 'ok' ? status.value : null,
      });
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
        __proto__: null,
        '':
          "NixosAdmin: edit and apply this host's NixOS configuration. " +
          'listFiles(subdir?) / readFile(path) / writeFile(path, text) edit ' +
          'the endo-owned flake checkout; stageRev(rev) pins the Endo commit ' +
          "this host runs ('' removes the pin; getEndoRev() reads it); " +
          'stageFiles/revertFiles stage and undo whole-file batches. ' +
          'build/apply/rollback are SETTLEMENT-SHAPED: they submit to the ' +
          'root applier and return its terminal outcome ({ ok, phase, ..., ' +
          'log? on failure }) — no polling. Each takes an optional trailing ' +
          'idempotency key; repeating a key returns the recorded outcome ' +
          'instead of re-submitting. apply(message) commits + switches with ' +
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
          "hash), or '' to remove the pin; returns { rev, previous } so " +
          'the pin can be restored exactly. Takes effect on apply(); a ' +
          'failed apply rolls the revision back with the generation.',
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
