// @ts-check
/* global process, setTimeout */

// Local NixOS host-administration caplet.
//
// This is an UNCONFINED module (it has Node.js APIs) that the daemon
// instantiates via `agent.makeUnconfined('@main', <this>, { resultName:
// 'controller-for-nixos-admin', env })`. It is the capability that lets a
// trusted admin agent EDIT and APPLY the host's NixOS configuration without
// SSH, and a suitable `performer` endowment for deployment workflows.
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
// `nixos-rebuild switch --flake $ENDO_NIXOS_CONFIG_DIR#<host>`, checks the
// installation's configured health criteria, and auto-rolls back to the last
// healthy generation on failure. PROTOCOL.md specifies the privileged half.
//
// SPOOL CONTRACT (id echo). Every request carries a caller-supplied `id` (the
// workflow engine passes its run-qualified `${runId}:${effectId}` invoke key;
// conversational callers may omit it and get a minted one). The applier:
//   - MUST atomically publish `protocol.json` for version 2, bound to the
//     current `/run/current-system` target as specified in PROTOCOL.md;
//   - MUST echo the request's `id` in `apply-status.json` while working;
//   - MUST write the terminal record — embedding that same raw `id` — to
//     `outcomes/<sanitized id>.json` when done (the caplet verifies the
//     embedded id, since sanitized file names can collide for exotic
//     caller-minted keys);
//   - MUST NOT leave a window in which neither `apply-request.json` nor
//     `apply-status.json` names the id: it may consume the request only once
//     the id-echoing status is durably published, or — simplest — leave the
//     request in place until the next submission overwrites it. A gap there
//     is the one remaining path to a double-apply: the caplet reads status
//     before ever submitting, but the applier does not take the submit lock,
//     so a sample inside such a window would look like a free slot;
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
// The current-system-bound protocol marker prevents a legacy or downgraded
// service from receiving even the first submission.
//
// SECURITY: applying NixOS config is root-equivalent — a committed change can
// carry activation scripts and systemd units the root service will build and
// run. The value here is not sandboxing but mediation: every change is
// git-committed (auditable), the privileged action is a fixed rebuild command
// (not arbitrary shell), and a failed apply auto-rolls-back.

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  readFile,
  rename,
  mkdir,
  readdir,
  rmdir,
  rm,
  open,
  lstat,
  readlink,
  realpath,
  statfs,
} from 'node:fs/promises';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  release,
  totalmem,
  uptime,
} from 'node:os';
import { basename, join, resolve, relative, dirname, sep } from 'node:path';

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
const APPLIER_PROTOCOL_VERSION = 2;
/** @param {string} value */
const sha256 = value =>
  createHash('sha256').update(value, 'utf8').digest('hex');
// Node exposes POSIX open flags as individual bit masks.
/* eslint-disable no-bitwise */
const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_NOFOLLOW =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW;
/* eslint-enable no-bitwise */

const StagedFileShape = M.splitRecord({ path: M.string(), text: M.string() });
// `text: null` records "the file did not exist", so revert removes it.
const PreviousFileShape = M.splitRecord(
  {
    path: M.string(),
    text: M.or(M.string(), M.null()),
  },
  { createdDirectories: M.arrayOf(M.string()) },
);

const NixosAdminInterface = M.interface('NixosAdmin', {
  getConfig: M.call().returns(M.promise()),
  getSystemInfo: M.call().returns(M.promise()),
  getVitals: M.call().returns(M.promise()),
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
  prebuildRev: M.call(M.string()).optional(M.string()).returns(M.promise()),
  apply: M.call(M.string()).optional(M.string()).returns(M.promise()),
  rollback: M.call().optional(M.string()).returns(M.promise()),
  verify: M.call(M.string()).optional(M.string()).returns(M.promise()),
  status: M.call().optional(M.string()).returns(M.promise()),
  getLog: M.call().optional(M.number()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Resolve `relPath` beneath `baseDir`, rejecting absolute paths, `..` escapes,
 * and anything under a `.git` directory at any depth. Exported for unit
 * testing; this is the single choke point that confines every file operation
 * to the NixOS config checkout (lexical confinement: symlinks inside the
 * checkout are not chased — stageFiles cannot create them, and the checkout is
 * owned by the applier's own mirror).
 *
 * The `.git` rule matches `walkFiles` and `fingerprintConfig`, which skip that
 * name at every depth. Rejecting only the top-level one would leave a nested
 * `sub/.git/…` writable yet outside both the listing and the config
 * fingerprint that binds a request to the exact content the service may build.
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
  if (rel.split(sep).includes('.git')) {
    throw new Error(`The .git directory is not editable: ${relPath}`);
  }
  return target;
};
harden(resolveWithin);

/**
 * Reject an existing symbolic link in any component beneath `baseDir`.
 * `resolveWithin` provides the lexical half of confinement; this check keeps a
 * tracked repository symlink from redirecting a subsequent file operation.
 * The configured base itself is trusted because it is supplied by the host
 * administrator and is commonly a stable deployment symlink.
 *
 * @param {string} baseDir
 * @param {string} target
 */
const assertNoSymlinkTraversal = async (baseDir, target) => {
  await null;
  const rel = relative(resolve(baseDir), target);
  let cursor = resolve(baseDir);
  for (const component of rel.split(sep)) {
    cursor = join(cursor, component);
    let info;
    try {
      // eslint-disable-next-line no-await-in-loop
      info = await lstat(cursor);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow config symlink: ${q(cursor)}`);
    }
  }
};

/**
 * Canonicalize a configured directory that may not exist yet. The lock
 * directory in particular lives on a tmpfs a reboot clears and the privileged
 * service reprovisions, so the daemon can legitimately start before it is
 * there; a bare `realpath` would then reject `make` and leave even the
 * read-only diagnostics (`status`, `getVitals`) unreachable until something
 * re-instantiated the caplet.
 *
 * Resolving the deepest existing ancestor and re-joining the missing tail
 * yields what `realpath` will return once the directory appears, so two
 * incarnations straddling its creation still compute the SAME lock path. A
 * path that is genuinely wrong is rejected loudly by the protocol-marker check
 * at the first submission instead of silently at startup.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
const canonicalize = async path => {
  await null;
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw error;
    }
  }
  const parent = dirname(absolute);
  if (parent === absolute) {
    return absolute;
  }
  return join(await canonicalize(parent), basename(absolute));
};

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
  const entries = await readdir(dir, { withFileTypes: true });
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

/**
 * Read an optional local-system text file. Host diagnostics are best effort:
 * an absent kernel pseudo-file must not make the whole status capability
 * unusable.
 *
 * @param {string} path
 * @returns {Promise<string | null>}
 */
const readOptionalText = async path => {
  await null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
const readOptionalLink = async path => {
  await null;
  try {
    return await readlink(path);
  } catch {
    return null;
  }
};

/**
 * Parse the shell-like KEY=VALUE subset used by os-release. NixOS emits
 * double-quoted or unquoted scalar values; only the standard backslash escapes
 * needed by os-release are decoded here.
 *
 * @param {string | null} text
 * @returns {Record<string, string>}
 */
const parseOsRelease = text => {
  /** @type {Record<string, string>} */
  const fields = {};
  if (text === null) {
    return fields;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      const [, key, source] = match;
      const quoted =
        source.length >= 2 &&
        ((source.startsWith('"') && source.endsWith('"')) ||
          (source.startsWith("'") && source.endsWith("'")));
      const value = quoted ? source.slice(1, -1) : source;
      fields[key] = value.replace(/\\([\\$"'`])/g, '$1');
    }
  }
  return fields;
};

/**
 * Read a byte count from Linux /proc/meminfo.
 *
 * @param {string | null} text
 * @param {string} field
 * @returns {bigint | null}
 */
const readMeminfoBytes = (text, field) => {
  if (text === null) {
    return null;
  }
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
  return match ? BigInt(match[1]) * 1024n : null;
};

/**
 * Best-effort filesystem capacity snapshot.
 *
 * @param {string} path
 */
const readFilesystemVitals = async path => {
  await null;
  try {
    const stats = await statfs(path, { bigint: true });
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    return harden({
      path,
      totalBytes,
      usedBytes: totalBytes - freeBytes,
      freeBytes,
      availableBytes,
    });
  } catch {
    return null;
  }
};

/**
 * Run one fixed diagnostic command without a shell. A missing executable,
 * timeout, or non-zero status still yields any stdout it produced; diagnostics
 * such as `systemctl is-system-running` intentionally use non-zero statuses
 * for useful states such as `degraded`.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string | null>}
 */
const runOptionalDiagnostic = (file, args) =>
  new Promise(resolveDiagnostic => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
      (_error, stdout) => {
        const text = typeof stdout === 'string' ? stdout.trim() : '';
        resolveDiagnostic(text || null);
      },
    );
  });

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
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   systemPaths?: {
 *     osRelease?: string,
 *     currentSystem?: string,
 *     systemProfile?: string,
 *     configurationRevision?: string,
 *     meminfo?: string,
 *     uptime?: string,
 *     nixosVersion?: string,
 *     systemctl?: string,
 *     flock?: string,
 *     shell?: string,
 *   },
 * }} [options]
 */
export const make = async (_powers, _context, options = {}) => {
  await null;
  const env = (options && options.env) || {};
  /** @param {string} key */
  const readEnv = key =>
    Object.hasOwn(env, key) ? env[key] || '' : process.env[key] || '';
  const systemPaths = harden({
    osRelease: options.systemPaths?.osRelease || '/etc/os-release',
    currentSystem: options.systemPaths?.currentSystem || '/run/current-system',
    systemProfile:
      options.systemPaths?.systemProfile || '/nix/var/nix/profiles/system',
    configurationRevision: options.systemPaths?.configurationRevision || '',
    meminfo: options.systemPaths?.meminfo || '/proc/meminfo',
    uptime: options.systemPaths?.uptime || '/proc/uptime',
    nixosVersion:
      options.systemPaths?.nixosVersion ||
      '/run/current-system/sw/bin/nixos-version',
    systemctl:
      options.systemPaths?.systemctl || '/run/current-system/sw/bin/systemctl',
    flock: options.systemPaths?.flock || '/run/current-system/sw/bin/flock',
    shell: options.systemPaths?.shell || '/run/current-system/sw/bin/sh',
  });

  const configDir = readEnv('ENDO_NIXOS_CONFIG_DIR');
  const nixosDir = readEnv('ENDO_NIXOS_DIR');
  const lockDir =
    readEnv('ENDO_NIXOS_LOCK_DIR') || '/run/lock/endo-nixos-admin';
  const configured = Boolean(configDir && nixosDir);
  const canonicalConfigDir = configDir ? await canonicalize(configDir) : '';
  const canonicalLockDir = await canonicalize(lockDir);
  const machineHostname = hostname();
  // Most flakes name the local nixosConfiguration after the machine. Hosts
  // whose flake output uses another name can still override it explicitly.
  const host = readEnv('ENDO_NIXOS_HOST') || machineHostname;
  // Tests dial these down; the applier's work is minutes-grained in
  // production.
  const pollMs = Number(readEnv('ENDO_NIXOS_POLL_MS')) || 2000;
  const watchLimitMs =
    Number(readEnv('ENDO_NIXOS_WATCH_LIMIT_MS')) || DEFAULT_WATCH_LIMIT_MS;

  const requestPath = nixosDir ? join(nixosDir, 'apply-request.json') : '';
  const statusPath = nixosDir ? join(nixosDir, 'apply-status.json') : '';
  const logPath = nixosDir ? join(nixosDir, 'apply.log') : '';
  const outcomesDir = nixosDir ? join(nixosDir, 'outcomes') : '';
  const protocolPath = nixosDir ? join(nixosDir, 'protocol.json') : '';
  const submissionLockPath = nixosDir ? join(nixosDir, 'submit.lock') : '';
  const configLockPath = canonicalConfigDir
    ? join(canonicalLockDir, `${sha256(canonicalConfigDir)}.lock`)
    : '';

  // The DEPLOY spool is a separate, simpler spool belonging to the endo-deploy
  // systemd unit. Its request nonce correlates failures, while success is a
  // FACT ON DISK — the release marker.
  const stateDir =
    readEnv('ENDO_NIXOS_STATE_DIR') || (nixosDir ? dirname(nixosDir) : '');
  const deployDir = stateDir ? join(stateDir, 'deploy') : '';
  const releasesDir = stateDir ? join(stateDir, 'releases') : '';
  const deployRequestPath = deployDir ? join(deployDir, 'request.json') : '';
  const deployStatusPath = deployDir ? join(deployDir, 'status.json') : '';
  const deploySubmissionLockPath = deployDir
    ? join(deployDir, 'submit.lock')
    : '';

  /**
   * Has a release been built to completion? The marker is what the deploy unit
   * touches only after a build finishes, so it distinguishes a finished tree
   * from one an interrupted build left behind.
   *
   * @param {string} rev
   * @returns {Promise<boolean>}
   */
  const releaseBuilt = async rev => {
    await null;
    if (!/^[0-9a-f]{40}$/.test(rev)) {
      throw new Error(`Invalid release revision ${q(rev)}.`);
    }
    if (!releasesDir) return false;
    try {
      await readFile(join(releasesDir, rev, '.deploy-complete'), 'utf8');
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  };

  const config = harden({
    configDir,
    canonicalConfigDir,
    nixosDir,
    stateDir,
    lockDir,
    canonicalLockDir,
    host,
    hostname: machineHostname,
    configured,
  });

  /** @param {string} path */
  const resolveConfigPath = async path => {
    const target = resolveWithin(configDir, path);
    await assertNoSymlinkTraversal(configDir, target);
    return target;
  };

  /**
   * Read a config file without following a final-component symlink. Parent
   * components are protected by `assertNoSymlinkTraversal` while the shared
   * checkout lock excludes every compliant writer.
   *
   * @param {string} target
   */
  const readConfigText = async target => {
    const handle = await open(target, READ_NOFOLLOW);
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  };

  /**
   * @param {string} target
   * @param {string} text
   */
  const writeConfigText = async (target, text) => {
    const handle = await open(target, WRITE_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
  };

  /**
   * @param {string} path
   * @returns {Promise<string | null>}
   */
  const readConfigFileOrAbsent = async path => {
    const target = await resolveConfigPath(path);
    try {
      return await readConfigText(target);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  /**
   * Record the absent parent directories that a staged file write may create.
   * Paths are ordered deepest-first so compensation can remove an empty leaf
   * before its parent without ever using recursive deletion.
   *
   * @param {string} target
   * @returns {Promise<string[]>}
   */
  const missingConfigParents = async target => {
    await null;
    const root = resolve(configDir);
    const missing = [];
    for (
      let cursor = dirname(target);
      cursor !== root;
      cursor = dirname(cursor)
    ) {
      let exists = true;
      try {
        // eslint-disable-next-line no-await-in-loop
        await lstat(cursor);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          missing.push(relative(root, cursor));
          exists = false;
        } else {
          throw error;
        }
      }
      if (exists) {
        break;
      }
    }
    return missing;
  };

  /**
   * Remove only directories that were absent before staging, and only while
   * they are empty. ENOTEMPTY means another restored/staged file still needs
   * the directory, so a later record may safely try it again.
   *
   * @param {ReadonlyArray<string>} directories
   */
  const removeCreatedConfigParents = async directories => {
    await null;
    for (const directory of directories) {
      // eslint-disable-next-line no-await-in-loop
      const target = await resolveConfigPath(directory);
      try {
        // eslint-disable-next-line no-await-in-loop
        await rmdir(target);
      } catch (error) {
        const { code } = /** @type {NodeJS.ErrnoException} */ (error);
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          throw error;
        }
      }
    }
  };

  /** Stable identity and NixOS generation information for this local host. */
  const readSystemInfo = async () => {
    const [osReleaseText, currentSystem, profile, configurationRevision] =
      await Promise.all([
        readOptionalText(systemPaths.osRelease),
        readOptionalLink(systemPaths.currentSystem),
        readOptionalLink(systemPaths.systemProfile),
        systemPaths.configurationRevision
          ? readOptionalText(systemPaths.configurationRevision)
          : runOptionalDiagnostic(systemPaths.nixosVersion, [
              '--configuration-revision',
            ]),
      ]);
    const osRelease = parseOsRelease(osReleaseText);
    const generationMatch =
      profile === null ? null : /(?:^|\/)system-(\d+)-link$/.exec(profile);
    const processors = cpus();
    return harden({
      hostname: machineHostname,
      flakeHost: host,
      operatingSystem: harden({
        id: osRelease.ID || null,
        name: osRelease.NAME || null,
        prettyName: osRelease.PRETTY_NAME || null,
        versionId: osRelease.VERSION_ID || null,
        buildId: osRelease.BUILD_ID || null,
        isNixOS: osRelease.ID === 'nixos',
      }),
      kernel: harden({ release: release(), architecture: arch() }),
      cpu: harden({
        logicalCores: processors.length,
        model: processors[0]?.model.trim() || null,
      }),
      nixos: harden({
        currentSystem,
        currentGeneration:
          generationMatch === null ? null : Number(generationMatch[1]),
        configurationRevision:
          configurationRevision === null
            ? null
            : configurationRevision.trim() || null,
      }),
    });
  };

  /** Current resource-usage snapshot for this local host. */
  const readVitals = async () => {
    const [
      meminfo,
      uptimeText,
      rootFilesystem,
      nixStoreFilesystem,
      systemdState,
    ] = await Promise.all([
      readOptionalText(systemPaths.meminfo),
      readOptionalText(systemPaths.uptime),
      readFilesystemVitals('/'),
      readFilesystemVitals('/nix'),
      runOptionalDiagnostic(systemPaths.systemctl, ['is-system-running']),
    ]);
    let totalBytes = readMeminfoBytes(meminfo, 'MemTotal');
    let availableBytes = readMeminfoBytes(meminfo, 'MemAvailable');
    if (totalBytes === null || availableBytes === null) {
      try {
        totalBytes ??= BigInt(totalmem());
        availableBytes ??= BigInt(freemem());
      } catch {
        // A constrained host can deny these libuv sysinfo queries.
      }
    }
    const swapTotalBytes = readMeminfoBytes(meminfo, 'SwapTotal');
    const swapFreeBytes = readMeminfoBytes(meminfo, 'SwapFree');
    let uptimeSeconds = Number(uptimeText?.split(/\s+/, 1)[0]);
    if (!Number.isFinite(uptimeSeconds)) {
      try {
        uptimeSeconds = uptime();
      } catch {
        uptimeSeconds = Number.NaN;
      }
    }
    let averages = [Number.NaN, Number.NaN, Number.NaN];
    try {
      averages = loadavg();
    } catch {
      // A constrained host may deny the kernel query. Report nulls below.
    }
    const [oneMinute, fiveMinutes, fifteenMinutes] = averages;
    return harden({
      sampledAt: new Date().toISOString(),
      systemdState,
      uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : null,
      loadAverage: harden({
        oneMinute: Number.isFinite(oneMinute) ? oneMinute : null,
        fiveMinutes: Number.isFinite(fiveMinutes) ? fiveMinutes : null,
        fifteenMinutes: Number.isFinite(fifteenMinutes) ? fifteenMinutes : null,
      }),
      memory:
        totalBytes === null || availableBytes === null
          ? null
          : harden({
              totalBytes,
              usedBytes: totalBytes - availableBytes,
              availableBytes,
            }),
      swap:
        swapTotalBytes === null || swapFreeBytes === null
          ? null
          : harden({
              totalBytes: swapTotalBytes,
              usedBytes: swapTotalBytes - swapFreeBytes,
              freeBytes: swapFreeBytes,
            }),
      filesystems: harden({
        root: rootFilesystem,
        nixStore: nixStoreFilesystem,
      }),
    });
  };

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
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {unknown} value
   */
  const isConfigFingerprint = (action, value) =>
    action === 'rollback'
      ? value === null
      : typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

  /**
   * Validate an outcome record read from `outcomes/<sanitized id>.json`.
   * The embedded raw id must match the requested one — sanitized names can
   * collide, and returning another operation's record would either skip a
   * needed action or misreport one.
   *
   * @param {any} record
   * @param {string} id
   * @param {string} protocolFingerprint
   * @param {'build' | 'switch' | 'rollback'} [action]
   * @param {string} [message]
   * @param {string | null} [expectedConfigFingerprint]
   */
  const assertOutcomeRecord = (
    record,
    id,
    protocolFingerprint,
    action,
    message,
    expectedConfigFingerprint,
  ) => {
    if (
      record === null ||
      typeof record !== 'object' ||
      (record.phase !== 'ok' && record.phase !== 'error')
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
    if (record.protocolFingerprint !== protocolFingerprint) {
      throw new Error(
        `Outcome for ${q(id)} belongs to another host configuration; ` +
          'refusing to reuse it under the current protocol marker.',
      );
    }
    if (
      (record.action !== 'build' &&
        record.action !== 'switch' &&
        record.action !== 'rollback') ||
      !isConfigFingerprint(record.action, record.configFingerprint)
    ) {
      throw new Error(
        `Malformed outcome record for ${q(id)}: invalid action or ` +
          'configFingerprint.',
      );
    }
    if (
      action !== undefined &&
      (record.action !== action ||
        record.fingerprint !==
          operationFingerprint(
            action,
            message || '',
            record.configFingerprint,
            protocolFingerprint,
          ) ||
        (expectedConfigFingerprint !== undefined &&
          record.configFingerprint !== expectedConfigFingerprint))
    ) {
      throw new Error(
        `Idempotency key ${q(id)} is already bound to ${q(record.action)} ` +
          `with fingerprint ${q(record.fingerprint)}, not ${q(action)} with ` +
          `the supplied audit note. Refusing to reuse it for another operation.`,
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
      // The applier appends to and rotates this log, so it can shrink between
      // the stat and the read. Decoding the whole buffer would pad a failure
      // diagnostic with the NUL bytes the short read left behind.
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      return new TextDecoder().decode(bytes.subarray(0, bytesRead));
    } catch {
      return '';
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
    }
  };

  /**
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {string} message
   * @param {string | null} configFingerprint
   * @param {string} protocolFingerprint
   */
  const operationFingerprint = (
    action,
    message,
    configFingerprint,
    protocolFingerprint,
  ) =>
    sha256(
      JSON.stringify({
        action,
        message,
        configFingerprint,
        protocolFingerprint,
      }),
    );

  /**
   * A present request is never equivalent to an empty slot. Validate every
   * field before deciding whether to attach, wait, or replace a verified
   * settled request.
   *
   * @param {any} request
   * @param {string} protocolFingerprint
   */
  const assertApplyRequest = (request, protocolFingerprint) => {
    const malformed = () =>
      new Error(
        'Malformed or foreign apply request occupies the spool; refusing to ' +
          'overwrite ambiguous privileged work.',
      );
    if (
      request === null ||
      typeof request !== 'object' ||
      (request.action !== 'build' &&
        request.action !== 'switch' &&
        request.action !== 'rollback') ||
      typeof request.id !== 'string' ||
      request.id === '' ||
      typeof request.message !== 'string' ||
      typeof request.nonce !== 'string' ||
      request.nonce === '' ||
      !isConfigFingerprint(request.action, request.configFingerprint)
    ) {
      throw malformed();
    }
    // A well-formed request under a different marker is a reconfigured host,
    // not a corrupt spool — and it says so, because the operator's next move
    // differs. Checked before the operation fingerprint, which is computed
    // against the CURRENT marker and would otherwise report every such
    // request as malformed.
    if (request.protocolFingerprint !== protocolFingerprint) {
      throw new Error(
        'The pending request belongs to another host configuration; ' +
          'refusing to infer settlement under the current marker.',
      );
    }
    if (
      request.fingerprint !==
      operationFingerprint(
        request.action,
        request.message,
        request.configFingerprint,
        protocolFingerprint,
      )
    ) {
      throw malformed();
    }
    sanitizeId(request.id);
  };

  /**
   * Run a transaction under a kernel-owned lock. On the supported NixOS host,
   * util-linux `flock` holds a protected filesystem inode: the kernel releases
   * it on close, crash, or SIGKILL, and a stale pathname is harmless.
   * Non-Linux development hosts use an exclusive file with no unsafe
   * stale-owner recovery.
   *
   * @template T
   * @param {string} lockPath
   * @param {number} deadline
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  const withKernelLock = async (lockPath, deadline, job) => {
    await null;
    if (process.platform !== 'linux') {
      await mkdir(dirname(lockPath), { recursive: true });
      let handle;
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          handle = await open(lockPath, 'wx', 0o600);
          break;
        } catch (lockError) {
          if (
            /** @type {NodeJS.ErrnoException} */ (lockError).code !== 'EEXIST'
          ) {
            throw lockError;
          }
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for lock ${q(lockPath)}.`, {
              cause: lockError,
            });
          }
          // eslint-disable-next-line no-await-in-loop
          await delay(Math.min(pollMs, 250));
        }
      }
      try {
        return await job();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    }

    await mkdir(dirname(lockPath), { recursive: true });
    const timeoutSeconds = Math.max(
      1,
      Math.ceil((deadline - Date.now()) / 1000),
    );
    const child = spawn(
      systemPaths.flock,
      [
        '--exclusive',
        '--no-fork',
        '--timeout',
        String(timeoutSeconds),
        lockPath,
        systemPaths.shell,
        '-c',
        'printf "locked\\n"; IFS= read -r _',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    // A lock holder reaped mid-transaction (the OOM killer during a long
    // fingerprint walk, an operator's kill) leaves a broken pipe. Without a
    // listener the release write below raises EPIPE as an unhandled stream
    // error, which is an uncaught exception that takes the whole daemon down
    // instead of surfacing as an ordinary lock failure. The close status is
    // what actually reports the loss, so these listeners only swallow.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    /** @type {Promise<{ code: number | null, signal: string | null }>} */
    const closed = new Promise(resolveClosed => {
      child.once('close', (code, signal) => {
        resolveClosed({ code, signal });
      });
    });
    let ready = false;
    const acquired = new Promise((resolveReady, rejectReady) => {
      child.once('error', error => {
        rejectReady(
          new Error(`Could not start flock for ${q(lockPath)}.`, {
            cause: error,
          }),
        );
      });
      child.stdout.once('data', chunk => {
        if (String(chunk).startsWith('locked\n')) {
          ready = true;
          resolveReady(undefined);
        } else {
          rejectReady(
            new Error(`Unexpected flock handshake for ${q(lockPath)}.`),
          );
        }
      });
      child.once('close', (code, signal) => {
        if (!ready) {
          rejectReady(
            new Error(
              `Could not acquire lock ${q(lockPath)}: ${stderr.trim() || `flock exited ${code ?? signal}`}`,
            ),
          );
        }
      });
    });
    try {
      await acquired;
    } catch (error) {
      child.stdin.destroy();
      child.kill('SIGKILL');
      await closed;
      throw error;
    }
    // The lock must be released, and the holder's exit inspected, before either
    // result is reported — so the job's settlement is held here rather than
    // propagated through a `finally`.
    /** @type {{ ok: true, value: T } | { ok: false, error: unknown }} */
    let outcome;
    try {
      outcome = { ok: true, value: await job() };
    } catch (jobError) {
      outcome = { ok: false, error: jobError };
    }
    child.stdin.end('\n');
    const { code, signal } = await closed;
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (code !== 0 || signal !== null) {
      // The holder released the lock on its own — the kernel dropped it the
      // moment that process died, so the transaction just completed was NOT
      // exclusive and another process may have made the same decision under
      // it. A submit decision is root-equivalent, so refuse to acknowledge it.
      throw new Error(
        `Lock holder for ${q(lockPath)} exited (${signal || `status ${code}`}) ` +
          'before the transaction released it; the kernel freed the lock ' +
          'early, so this transaction was not exclusive.',
      );
    }
    return outcome.value;
  };

  /**
   * Durably replace a JSON file. Both the temporary file and containing
   * directory are flushed, so an acknowledged publication survives power loss.
   *
   * @param {string} path
   * @param {Record<string, unknown>} value
   */
  const writeDurableJson = async (path, value) => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const tmp = `${path}.${process.pid}.${nextNonce().replaceAll(':', '_')}.tmp`;
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, path);
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close().catch(() => {});
      await rm(tmp, { force: true });
    }
  };

  /**
   * Fingerprint the exact regular-file contents the service is authorized to
   * build. Symlinks and special files are rejected so the digest cannot omit
   * an input that Nix later follows. The privileged service must reproduce
   * this digest immediately before building or committing.
   */
  const fingerprintConfig = async () => {
    const hash = createHash('sha256');
    /** @param {string} directory */
    const visit = async directory => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => {
        if (left.name < right.name) return -1;
        if (left.name > right.name) return 1;
        return 0;
      });
      for (const entry of entries) {
        if (entry.name !== '.git') {
          const target = join(directory, entry.name);
          const relPath = relative(resolve(configDir), target);
          // Re-stat rather than trusting the directory entry; an unexpected
          // replacement during traversal fails closed.
          // eslint-disable-next-line no-await-in-loop
          const info = await lstat(target);
          if (info.isSymbolicLink()) {
            throw new Error(
              `Refusing to fingerprint config symlink ${q(relPath)}.`,
            );
          }
          const pathBytes = new TextEncoder().encode(relPath);
          hash.update(info.isDirectory() ? 'd' : 'f');
          hash.update(`${pathBytes.byteLength}:`);
          hash.update(pathBytes);
          hash.update(`${info.mode % 4096}:`);
          if (info.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await visit(target);
          } else {
            if (!info.isFile()) {
              throw new Error(
                `Refusing to fingerprint special config file ${q(relPath)}.`,
              );
            }
            // eslint-disable-next-line no-await-in-loop
            await assertNoSymlinkTraversal(configDir, target);
            // eslint-disable-next-line no-await-in-loop
            const handle = await open(target, READ_NOFOLLOW);
            let bytes;
            try {
              // eslint-disable-next-line no-await-in-loop
              bytes = await handle.readFile();
            } finally {
              // eslint-disable-next-line no-await-in-loop
              await handle.close();
            }
            hash.update(`${bytes.byteLength}:`);
            hash.update(bytes);
          }
        }
      }
    };
    await visit(resolve(configDir));
    return hash.digest('hex');
  };

  /** @param {Record<string, unknown>} request */
  const writeRequest = request => writeDurableJson(requestPath, request);

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
   * @param {'build' | 'switch' | 'rollback'} action
   * @param {string} message
   * @param {string} protocolFingerprint
   * @param {string | null} configFingerprint
   */
  const awaitOutcome = async (
    id,
    action,
    message,
    protocolFingerprint,
    configFingerprint,
  ) => {
    await null;
    const outcomePath = outcomePathFor(id);
    const deadline = Date.now() + watchLimitMs;
    let idlessPolls = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await readDecisive(outcomePath);
      if (outcome !== undefined) {
        assertOutcomeRecord(
          outcome,
          id,
          protocolFingerprint,
          action,
          message,
          configFingerprint,
        );
        return settle(outcome);
      }
      // eslint-disable-next-line no-await-in-loop
      const status = await readDecisive(statusPath);
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
      } else if (status !== undefined) {
        idlessPolls = 0;
      }
      if (
        status?.id === id &&
        (status.fingerprint !==
          operationFingerprint(
            action,
            message,
            configFingerprint,
            protocolFingerprint,
          ) ||
          status.protocolFingerprint !== protocolFingerprint ||
          status.configFingerprint !== configFingerprint)
      ) {
        throw new Error(
          `Status for ${q(id)} has the wrong request fingerprint; refusing ` +
            'to attach to an ambiguous privileged operation.',
        );
      }
      if (status !== undefined && status.id !== undefined && status.id !== id) {
        // Conclude supersession only from DEFINITE reads: the request file
        // read must succeed (or be a true ENOENT) and not name us.
        // eslint-disable-next-line no-await-in-loop
        const request = await readDecisive(requestPath);
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
  /** @type {Promise<unknown>} */
  let queueTail = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  const enqueue = job => {
    const run = queueTail.then(job, job);
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Require a marker written by the currently installed applier and return a
   * stable digest that every request, status, and outcome must echo.
   */
  const assertApplierProtocol = async () => {
    const [protocol, currentSystem] = await Promise.all([
      readDecisive(protocolPath),
      readOptionalLink(systemPaths.currentSystem),
    ]);
    if (
      protocol?.version !== APPLIER_PROTOCOL_VERSION ||
      protocol?.idEcho !== true ||
      protocol?.outcomes !== true ||
      currentSystem === null ||
      protocol?.system !== currentSystem ||
      protocol?.host !== host ||
      protocol?.configDir !== canonicalConfigDir ||
      protocol?.lockDir !== canonicalLockDir
    ) {
      throw new Error(
        `The nixos applier at ${q(nixosDir)} does not advertise protocol ` +
          `${APPLIER_PROTOCOL_VERSION} with idEcho and outcomes for the ` +
          `current system ${q(currentSystem)}, host ${q(host)}, and checkout ` +
          `${q(canonicalConfigDir)}, and lock directory ` +
          `${q(canonicalLockDir)}. Install a compatible ` +
          'privileged service before submitting operations.',
      );
    }
    return sha256(
      JSON.stringify({
        version: APPLIER_PROTOCOL_VERSION,
        idEcho: true,
        outcomes: true,
        host,
        configDir: canonicalConfigDir,
        lockDir: canonicalLockDir,
      }),
    );
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
      // The entire empty-slot check and publication is one cross-process
      // transaction. The local queue preserves call order within this object;
      // this lock prevents another object/process from making the same empty
      // decision concurrently.
      // eslint-disable-next-line no-await-in-loop
      const decision = await withKernelLock(
        submissionLockPath,
        deadline,
        async () => {
          const protocolFingerprint = await assertApplierProtocol();
          const recorded = await readDecisive(outcomePathFor(id));
          if (recorded !== undefined) {
            assertOutcomeRecord(
              recorded,
              id,
              protocolFingerprint,
              action,
              message,
            );
            return { kind: 'settled', record: recorded };
          }
          const pending = await readDecisive(requestPath);
          if (pending !== undefined) {
            assertApplyRequest(pending, protocolFingerprint);
          }
          if (pending !== undefined && pending.id === id) {
            if (
              pending.action !== action ||
              pending.fingerprint !==
                operationFingerprint(
                  action,
                  message,
                  pending.configFingerprint,
                  protocolFingerprint,
                ) ||
              pending.protocolFingerprint !== protocolFingerprint ||
              !isConfigFingerprint(action, pending.configFingerprint)
            ) {
              throw new Error(
                `Idempotency key ${q(id)} is pending for another operation; ` +
                  'refusing to attach with different arguments.',
              );
            }
            return {
              kind: 'watch',
              protocolFingerprint,
              configFingerprint: pending.configFingerprint,
            };
          }
          const status = await readDecisive(statusPath);
          if (status !== undefined && status.id === id) {
            if (
              status.action !== action ||
              status.fingerprint !==
                operationFingerprint(
                  action,
                  message,
                  status.configFingerprint,
                  protocolFingerprint,
                ) ||
              status.protocolFingerprint !== protocolFingerprint ||
              !isConfigFingerprint(action, status.configFingerprint)
            ) {
              throw new Error(
                `Idempotency key ${q(id)} is active for another operation; ` +
                  'refusing to attach with different arguments.',
              );
            }
            return {
              kind: 'watch',
              protocolFingerprint,
              configFingerprint: status.configFingerprint,
            };
          }
          if (
            pending !== undefined &&
            typeof pending.id === 'string' &&
            pending.id !== '' &&
            pending.id !== id
          ) {
            const foreign = await readDecisive(outcomePathFor(pending.id));
            if (foreign === undefined) {
              return { kind: 'wait' };
            }
            // A sanitized-name collision is not evidence that the foreign
            // operation settled and must never free the single request slot.
            assertOutcomeRecord(foreign, pending.id, protocolFingerprint);
          }
          // An EMPTY request slot is not evidence of an idle applier. The
          // service may consume `apply-request.json` once its status echoes
          // the id, so from that moment until the terminal record the status
          // is the ONLY evidence that the machine is mid-operation. Treating
          // the gap as free stacks a second operation onto a switch that is
          // still being health-checked — and if that switch fails and
          // auto-rolls back, the queued one activates over the rollback.
          // Only a TERMINAL foreign status frees the slot: requiring an
          // outcome file here instead would wedge every later submission if
          // an operator ever pruned `outcomes/`.
          if (
            status !== undefined &&
            typeof status.id === 'string' &&
            status.id !== '' &&
            status.id !== id &&
            status.phase !== 'ok' &&
            status.phase !== 'error'
          ) {
            return { kind: 'wait' };
          }
          const configFingerprint =
            action === 'rollback'
              ? null
              : await withKernelLock(
                  configLockPath,
                  deadline,
                  fingerprintConfig,
                );
          await writeRequest({
            action,
            message,
            id,
            fingerprint: operationFingerprint(
              action,
              message,
              configFingerprint,
              protocolFingerprint,
            ),
            configFingerprint,
            protocolFingerprint,
            nonce: nextNonce(),
          });
          return { kind: 'watch', protocolFingerprint, configFingerprint };
        },
      );
      if (decision.kind === 'settled') {
        return settle(decision.record);
      }
      if (decision.kind === 'watch') {
        const { protocolFingerprint, configFingerprint } = decision;
        if (
          typeof protocolFingerprint !== 'string' ||
          (typeof configFingerprint !== 'string' && configFingerprint !== null)
        ) {
          throw new Error('Internal error: watch decision lacks fingerprints.');
        }
        return awaitOutcome(
          id,
          action,
          message,
          protocolFingerprint,
          configFingerprint,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Request ${id} waited out the watch limit behind another; giving up.`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
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

  /** @param {Record<string, unknown>} request */
  const writeDeployRequest = request =>
    writeDurableJson(deployRequestPath, request);

  /**
   * Watch one revision until its release marker or correlated failure appears.
   *
   * @param {string} rev
   * @param {string} nonce
   * @param {number} deadline
   */
  const awaitPrebuild = async (rev, nonce, deadline) => {
    await null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      if (await releaseBuilt(rev)) {
        return harden({ ok: true, phase: 'ok', rev, reused: false });
      }
      // eslint-disable-next-line no-await-in-loop
      const status = await readDecisive(deployStatusPath);
      if (status !== undefined) {
        assertPrebuildStatus(status);
      }
      if (
        status?.phase === 'error' &&
        status.rev === rev &&
        status.nonce === nonce
      ) {
        return harden({
          ok: false,
          phase: 'error',
          rev,
          message: String(status.message || 'prebuild failed'),
        });
      }
      if (Date.now() > deadline) {
        return harden({
          ok: false,
          phase: 'timeout',
          rev,
          message: `prebuild of ${rev} did not finish within the watch limit`,
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  };

  /** @param {any} request */
  const assertPrebuildRequest = request => {
    if (
      request === null ||
      typeof request !== 'object' ||
      request.action !== 'prebuild' ||
      typeof request.rev !== 'string' ||
      !/^[0-9a-f]{40}$/.test(request.rev) ||
      typeof request.nonce !== 'string' ||
      request.nonce === ''
    ) {
      throw new Error(
        'Malformed prebuild request occupies the deploy spool; refusing to ' +
          'overwrite ambiguous work.',
      );
    }
  };

  /** @param {any} status */
  const assertPrebuildStatus = status => {
    if (
      status === null ||
      typeof status !== 'object' ||
      typeof status.rev !== 'string' ||
      !/^[0-9a-f]{40}$/.test(status.rev) ||
      typeof status.nonce !== 'string' ||
      status.nonce === '' ||
      (status.phase !== 'queued' &&
        status.phase !== 'building' &&
        status.phase !== 'ok' &&
        status.phase !== 'error')
    ) {
      throw new Error(
        'Malformed prebuild status occupies the deploy spool; refusing to ' +
          'infer or overwrite ambiguous work.',
      );
    }
  };

  /**
   * Publish or attach to a prebuild without clobbering another deploy request.
   * The deploy protocol correlates by revision, whose completed release marker
   * is the durable idempotency fact.
   *
   * @param {string} rev
   * @param {string | undefined} key
   */
  const drivePrebuild = async (rev, key) => {
    await null;
    const deadline = Date.now() + watchLimitMs;
    const nonce = key !== undefined ? String(key) : mintId('prebuild');
    if (await releaseBuilt(rev)) {
      return harden({ ok: true, phase: 'ok', rev, reused: true });
    }
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const decision = await withKernelLock(
        deploySubmissionLockPath,
        deadline,
        async () => {
          await null;
          if (await releaseBuilt(rev)) {
            return 'reused';
          }
          const [request, status] = await Promise.all([
            readDecisive(deployRequestPath),
            readDecisive(deployStatusPath),
          ]);
          if (request !== undefined) {
            assertPrebuildRequest(request);
          }
          if (status !== undefined) {
            assertPrebuildStatus(status);
          }
          if (request?.rev === rev) {
            const requestFailed =
              status?.rev === rev &&
              status.nonce === request.nonce &&
              status.phase === 'error';
            if (request.nonce === nonce || !requestFailed) {
              return { kind: 'watch', nonce: request.nonce };
            }
          } else if (status?.rev === rev) {
            if (status.nonce === nonce || status.phase !== 'error') {
              return { kind: 'watch', nonce: status.nonce };
            }
          }
          if (request !== undefined) {
            const foreignBuilt = await releaseBuilt(request.rev);
            const foreignFailed =
              status?.rev === request.rev &&
              status.nonce === request.nonce &&
              status.phase === 'error';
            if (!foreignBuilt && !foreignFailed) {
              return 'wait';
            }
          } else if (
            status?.rev !== undefined &&
            status.rev !== rev &&
            status.phase !== 'ok' &&
            status.phase !== 'error'
          ) {
            return 'wait';
          }
          await writeDeployRequest({
            action: 'prebuild',
            rev,
            nonce,
          });
          return { kind: 'watch', nonce };
        },
      );
      if (decision === 'reused') {
        return harden({ ok: true, phase: 'ok', rev, reused: true });
      }
      if (typeof decision === 'object' && decision.kind === 'watch') {
        return awaitPrebuild(rev, decision.nonce, deadline);
      }
      if (Date.now() > deadline) {
        return harden({
          ok: false,
          phase: 'timeout',
          rev,
          message: `prebuild of ${rev} waited behind another deploy request`,
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  };

  return makeExo('NixosAdmin', NixosAdminInterface, {
    /** Static host config (paths + flake host) for orientation. */
    async getConfig() {
      return config;
    },

    /** Stable identity and NixOS generation details for the local machine. */
    async getSystemInfo() {
      return readSystemInfo();
    },

    /** Live systemd, load, memory, swap, uptime, and capacity snapshot. */
    async getVitals() {
      return readVitals();
    },

    /**
     * List every tracked config file (relative paths), optionally beneath a
     * subdirectory. Skips the `.git` directory.
     *
     * @param {string} [subdir]
     */
    async listFiles(subdir) {
      requireConfigured();
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          await null;
          const root = subdir
            ? await resolveConfigPath(subdir)
            : resolve(configDir);
          const files = await walkFiles(root, resolve(configDir));
          files.sort();
          return harden(files);
        },
      );
    },

    /**
     * Read one config file as UTF-8 text.
     *
     * @param {string} path
     */
    async readFile(path) {
      requireConfigured();
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          const target = await resolveConfigPath(path);
          return readConfigText(target);
        },
      );
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
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          const target = await resolveConfigPath(path);
          await mkdir(dirname(target), { recursive: true });
          await assertNoSymlinkTraversal(configDir, target);
          await writeConfigText(target, text);
          return harden({
            path,
            bytes: new TextEncoder().encode(text).byteLength,
          });
        },
      );
    },

    /**
     * The Endo commit this host is configured to run, as recorded in
     * `endo.rev`. This is the configured revision, which is the running one
     * only once the config has been applied.
     */
    async getEndoRev() {
      requireConfigured();
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          const text = await readConfigFileOrAbsent(ENDO_REV_FILE);
          // No pin file: the host still tracks services.endo.defaultBranch.
          return text === null ? '' : text.trim();
        },
      );
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
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          const target = await resolveConfigPath(ENDO_REV_FILE);
          const before = await readConfigFileOrAbsent(ENDO_REV_FILE);
          const previous = before === null ? '' : before.trim();
          if (trimmed === '') {
            await rm(target, { force: true });
            return harden({ path: ENDO_REV_FILE, rev: '', previous });
          }
          await mkdir(configDir, { recursive: true });
          await assertNoSymlinkTraversal(configDir, target);
          // The trailing newline is load-bearing for readability, not parsing.
          await writeConfigText(target, `${trimmed}\n`);
          return harden({ path: ENDO_REV_FILE, rev: trimmed, previous });
        },
      );
    },

    /**
     * Stage a batch of whole-file edits, capturing each file's previous
     * contents (`text: null` when it did not exist) so `revertFiles` can
     * restore them. A file that exists but cannot be read REFUSES the whole
     * stage (a lost capture would make the change unrevertable), and a
     * failure while writing restores the already-written prefix before
     * throwing, so a failed stage leaves the checkout as it found it.
     *
     * @param {ReadonlyArray<{ path: string, text: string }>} files
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async stageFiles(files, _key) {
      requireConfigured();
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          await null;
          /** @type {Array<{ path: string, text: string | null, createdDirectories: string[] }>} */
          const previous = [];
          const paths = [];
          for (const { path } of files) {
            // eslint-disable-next-line no-await-in-loop
            const target = await resolveConfigPath(path);
            let before = null;
            try {
              // eslint-disable-next-line no-await-in-loop
              before = await readConfigText(target);
            } catch (readError) {
              if (/** @type {any} */ (readError).code !== 'ENOENT') {
                throw new Error(
                  `stageFiles: cannot capture previous contents of ${q(path)}; refusing to stage.`,
                  { cause: readError },
                );
              }
            }
            // Capture directory topology before any batch write so a later
            // compensation can restore the exact fingerprinted tree.
            // eslint-disable-next-line no-await-in-loop
            const createdDirectories = await missingConfigParents(target);
            previous.push({ path, text: before, createdDirectories });
            paths.push(path);
          }
          let written = 0;
          let attempted = 0;
          try {
            for (let index = 0; index < files.length; index += 1) {
              const { path, text } = files[index];
              attempted = index + 1;
              // eslint-disable-next-line no-await-in-loop
              const target = await resolveConfigPath(path);
              // eslint-disable-next-line no-await-in-loop
              await mkdir(dirname(target), { recursive: true });
              // eslint-disable-next-line no-await-in-loop
              await assertNoSymlinkTraversal(configDir, target);
              // eslint-disable-next-line no-await-in-loop
              await writeConfigText(target, text);
              written += 1;
            }
          } catch (writeError) {
            /** @type {Array<{ path: string, error: unknown }>} */
            const restorationFailures = [];
            // Restore in reverse write order and retain every failure. A caller
            // must know when checkout residue could ride into a later apply.
            for (let index = attempted - 1; index >= 0; index -= 1) {
              const { path, text } = previous[index];
              try {
                const target =
                  text === null
                    ? resolveWithin(configDir, path)
                    : // eslint-disable-next-line no-await-in-loop
                      await resolveConfigPath(path);
                if (text === null) {
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    await rm(target, { force: true });
                  } catch (error) {
                    // A non-directory parent proves the captured target is
                    // absent. A later record restores that parent itself.
                    const { code } = /** @type {NodeJS.ErrnoException} */ (
                      error
                    );
                    if (code !== 'ENOTDIR' && code !== 'ERR_FS_EISDIR') {
                      throw error;
                    }
                  }
                } else {
                  // eslint-disable-next-line no-await-in-loop
                  await mkdir(dirname(target), { recursive: true });
                  // eslint-disable-next-line no-await-in-loop
                  await assertNoSymlinkTraversal(configDir, target);
                  // eslint-disable-next-line no-await-in-loop
                  await writeConfigText(target, text);
                }
              } catch (restorationError) {
                restorationFailures.push({ path, error: restorationError });
              }
            }
            const createdDirectories = [
              ...new Set(
                previous
                  .slice(0, attempted)
                  .flatMap(record => record.createdDirectories),
              ),
            ].sort((left, right) => right.length - left.length);
            try {
              await removeCreatedConfigParents(createdDirectories);
            } catch (restorationError) {
              restorationFailures.push({
                path: '<created directories>',
                error: restorationError,
              });
            }
            if (restorationFailures.length > 0) {
              const failedPaths = restorationFailures.map(
                ({ path, error }) =>
                  `${q(path)} (${/** @type {Error} */ (error).message})`,
              );
              throw new Error(
                `stageFiles failed after ${written} of ${files.length} writes; ` +
                  `restoration also failed for ${failedPaths.join(', ')}. ` +
                  'The checkout may contain partial changes.',
                { cause: writeError },
              );
            }
            throw new Error(
              `stageFiles failed after ${written} of ${files.length} writes; ` +
                'the written prefix was restored.',
              { cause: writeError },
            );
          }
          return harden({ paths: harden(paths), previous: harden(previous) });
        },
      );
    },

    /**
     * Restore files captured by `stageFiles` — the compensation for an
     * abandoned change. Entries with `text: null` are removed (the stage
     * created them). Naturally idempotent.
     *
     * @param {ReadonlyArray<{
     *   path: string,
     *   text: string | null,
     *   createdDirectories?: ReadonlyArray<string>,
     * }>} previous
     * @param {string} [_key] - workflow idempotency key (unused)
     */
    async revertFiles(previous, _key) {
      requireConfigured();
      return withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        async () => {
          await null;
          const paths = [];
          for (const { path, text } of previous) {
            const target =
              text === null
                ? resolveWithin(configDir, path)
                : // eslint-disable-next-line no-await-in-loop
                  await resolveConfigPath(path);
            if (text === null) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await rm(target, { force: true });
              } catch (error) {
                const { code } = /** @type {NodeJS.ErrnoException} */ (error);
                if (code !== 'ENOTDIR' && code !== 'ERR_FS_EISDIR') {
                  throw error;
                }
              }
            } else {
              // eslint-disable-next-line no-await-in-loop
              await mkdir(dirname(target), { recursive: true });
              // eslint-disable-next-line no-await-in-loop
              await assertNoSymlinkTraversal(configDir, target);
              // eslint-disable-next-line no-await-in-loop
              await writeConfigText(target, text);
            }
            paths.push(path);
          }
          const createdDirectories = [
            ...new Set(
              previous.flatMap(record => record.createdDirectories || []),
            ),
          ].sort((left, right) => right.length - left.length);
          await removeCreatedConfigParents(createdDirectories);
          return harden({ paths: harden(paths) });
        },
      );
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
     * Build a revision's release WITHOUT activating it: no `current` flip, no
     * daemon restart, nothing the running system depends on. Settlement-shaped
     * like the verbs above.
     *
     * This exists so an approval-gated deploy can establish that a revision
     * BUILDS before anyone approves an apply, and so that the apply is then a
     * symlink flip rather than a cold `yarn install` inside activation — the
     * shape that avoids doing package installation work during activation.
     *
     * Idempotent by construction rather than by key: the success condition is
     * the release marker on disk, so a re-dispatch of an already-built
     * revision returns at once without asking the applier for anything. That
     * is also why an unfinished build is never mistaken for a finished one.
     *
     * @param {string} rev - full 40-character lowercase commit hash
     * @param {string} [key] - workflow idempotency key, used as the request
     *   nonce so two identical requests are distinguishable
     */
    async prebuildRev(rev, key) {
      requireConfigured();
      const trimmed = String(rev).trim();
      if (!/^[0-9a-f]{40}$/.test(trimmed)) {
        throw makeError(
          X`prebuildRev needs a full 40-character lowercase commit hash, got ${q(rev)}`,
        );
      }
      if (key !== undefined && String(key) === '') {
        throw new Error('prebuildRev requires a non-empty idempotency key.');
      }
      if (!deployRequestPath) {
        throw makeError(
          X`prebuildRev: this daemon has no deploy spool to build through.`,
        );
      }
      return enqueue(() => drivePrebuild(trimmed, key));
    },

    /**
     * Commit the current edits and `nixos-rebuild switch` — settlement-shaped.
     * The root service checks installation-defined health criteria afterward
     * and auto-rolls back to the last healthy generation on failure. A commit
     * message is REQUIRED because it is the audit record.
     *
     * An apply MAY restart this daemon. If the caller's promise dies with the
     * process, a workflow run recovers by re-dispatch (same key → the recorded
     * outcome, never a second apply), and a conversational caller verifies
     * with `getEndoRev()`/`status()` on its next turn.
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
     * NOT a way around a stuck applier. The spool has one request slot, so a
     * rollback queues behind whatever occupies it and gives up only at the
     * watch limit (`ENDO_NIXOS_WATCH_LIMIT_MS`, a day by default) — an
     * applier that died mid-operation holds the slot for that long. This verb
     * is the undo for an apply that COMPLETED and left the host wrong; when
     * the privileged service itself is wedged, the escape hatch is the
     * privileged side directly (`nixos-rebuild --rollback` as root), which is
     * the authority this caplet deliberately does not hold.
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
      const endoRev = await withKernelLock(
        configLockPath,
        Date.now() + watchLimitMs,
        () => readConfigFileOrAbsent(ENDO_REV_FILE),
      );
      const runningRev = endoRev === null ? '' : endoRev.trim();
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
      const absentStatus = harden({
        state: /** @type {'absent'} */ ('absent'),
      });
      const [systemInfo, vitals, status] = await Promise.all([
        readSystemInfo(),
        readVitals(),
        statusPath ? readJsonFile(statusPath) : Promise.resolve(absentStatus),
      ]);
      return harden({
        config,
        systemInfo,
        vitals,
        status: status.state === 'ok' ? status.value : null,
        statusRead: status.state,
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
          "NixosAdmin: inspect and manage this local host's NixOS " +
          'configuration. getSystemInfo()/getVitals()/status() report host ' +
          'identity, the current generation, and resource health. ' +
          'listFiles(subdir?) / readFile(path) / writeFile(path, text) edit ' +
          'the endo-owned flake checkout; stageRev(rev) pins the Endo commit ' +
          "this host runs ('' removes the pin; getEndoRev() reads it); " +
          'stageFiles/revertFiles stage and undo whole-file batches. ' +
          'build/apply/rollback are SETTLEMENT-SHAPED: they submit to the ' +
          'root applier and return its terminal outcome ({ ok, phase, ..., ' +
          'log? on failure }) — no polling. Each takes an optional trailing ' +
          'idempotency key; repeating a key returns the recorded outcome ' +
          'instead of re-submitting. apply(message) commits + switches with ' +
          'health-checked auto-rollback. An apply may restart this daemon; ' +
          'verify with getEndoRev()/status() afterward. ' +
          'Applying is ROOT-EQUIVALENT — build() first and confirm with the ' +
          'user before apply().',
        getSystemInfo:
          'getSystemInfo() -> hostname, flake host, OS, kernel, CPU, and ' +
          'current NixOS generation details.',
        getVitals:
          'getVitals() -> sampled systemd state, uptime, load, memory, swap, ' +
          'and root/Nix store filesystem capacity.',
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
          'auto-rollback; waits for the terminal outcome. Activation may ' +
          'restart the daemon, so the call may not return — check afterward.',
        rollback:
          'rollback(key?) -> reactivate the last system generation that ' +
          'passed its health check; waits for the terminal outcome. It ' +
          'queues behind any operation already in the spool, so it undoes a ' +
          'COMPLETED apply rather than rescuing a stuck applier.',
        verify:
          'verify(rev, key?) -> { ok, runningRev, phase? }: is the checkout ' +
          'pinned to rev? A pure read.',
        status:
          'status() -> { config, systemInfo, vitals, status, statusRead } ' +
          'for the host and applier right now.',
        getLog: 'getLog(maxBytes?) -> tail of the apply log.',
      };
      return lines[method || ''] || lines[''];
    },
  });
};
harden(make);
