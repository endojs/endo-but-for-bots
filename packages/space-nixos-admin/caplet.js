// @ts-check
/* global process */

// Hosted-Endo NixOS machine-admin caplet.
//
// This is an UNCONFINED module (it has Node.js APIs) that the daemon
// instantiates via `agent.makeUnconfined('@main', <this>, { resultName:
// 'controller-for-nixos-admin', env })`. It is the capability that lets a
// trusted admin agent EDIT and APPLY the host's NixOS configuration without
// SSH.
//
// It does NOT run `nixos-rebuild` itself: that needs real root, which the
// daemon (running as the unprivileged `endo` user) does not have. Mirroring the
// deploy caplet (@endo/space-endo-mgmt), it speaks to a root-owned systemd
// service through a tiny file spool:
//
//   - edits    files under $ENDO_NIXOS_CONFIG_DIR   (an endo-owned git checkout)
//   - writes   $ENDO_NIXOS_DIR/apply-request.json   (atomically) to trigger work
//   - reads    $ENDO_NIXOS_DIR/apply-status.json     for the applier's progress
//   - reads    $ENDO_NIXOS_DIR/apply.log             tail for diagnostics
//
// The root `endo-nixos-apply` service commits the checkout, runs
// `nixos-rebuild switch --flake $ENDO_NIXOS_CONFIG_DIR#<host>`, health-checks
// the daemon gateway, and auto-rolls-back to the previous generation on
// failure. See the endo-host repo's modules/endo-nixos-admin.nix for the other
// end.
//
// SECURITY: applying NixOS config is root-equivalent — a committed change can
// carry activation scripts and systemd units the root service will build and
// run. The value here is not sandboxing but mediation: every change is
// git-committed (auditable), the privileged action is a fixed rebuild command
// (not arbitrary shell), and a failed apply auto-rolls-back.

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';

// The config reads this file with `lib.fileContents`, so a revision bump is a
// one-line diff and setting it is a whole-file write of a validated hash rather
// than an edit to Nix source.
const ENDO_REV_FILE = 'endo.rev';

const NixosAdminInterface = M.interface('NixosAdmin', {
  getConfig: M.call().returns(M.promise()),
  listFiles: M.call().optional(M.string()).returns(M.promise()),
  readFile: M.call(M.string()).returns(M.promise()),
  writeFile: M.call(M.string(), M.string()).returns(M.promise()),
  getEndoRev: M.call().returns(M.promise()),
  setEndoRev: M.call(M.string()).returns(M.promise()),
  build: M.call().optional(M.string()).returns(M.promise()),
  apply: M.call(M.string()).returns(M.promise()),
  rollback: M.call().returns(M.promise()),
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
 * @param {string} dir
 * @param {string} base - repo root, for computing relative paths
 * @returns {Promise<string[]>}
 */
const walkFiles = async (dir, base) => {
  /** @type {string[]} */
  const out = [];
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

  const requestPath = nixosDir ? join(nixosDir, 'apply-request.json') : '';
  const statusPath = nixosDir ? join(nixosDir, 'apply-status.json') : '';
  const logPath = nixosDir ? join(nixosDir, 'apply.log') : '';

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
  // request is a distinct value and the applier's path-watcher always fires.
  let counter = 0;
  const nextNonce = () => {
    counter += 1;
    return `${new Date().toISOString()}#${counter}`;
  };

  /** @param {Record<string, unknown>} request */
  const writeRequest = async request => {
    requireConfigured();
    await mkdir(nixosDir, { recursive: true });
    const body = `${JSON.stringify(request)}\n`;
    const tmp = `${requestPath}.tmp`;
    // Write-then-rename so the applier's path unit only ever sees a complete
    // request file (rename is atomic on the same filesystem).
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, requestPath);
    return harden(request);
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
      try {
        const text = await readFile(join(configDir, ENDO_REV_FILE), 'utf8');
        return text.trim();
      } catch {
        // No pin file: the host still tracks services.endo.defaultBranch.
        return '';
      }
    },

    /**
     * Point the host at a different Endo commit. Nothing happens until
     * `build`/`apply` — this only stages the edit.
     *
     * Validating here rather than letting the write through means a bad
     * argument fails at the capability boundary, instead of as a Nix
     * evaluation error minutes later in someone else's log.
     *
     * @param {string} rev - full 40-character lowercase commit hash
     */
    async setEndoRev(rev) {
      requireConfigured();
      const trimmed = String(rev).trim();
      if (!/^[0-9a-f]{40}$/.test(trimmed)) {
        throw makeError(
          X`setEndoRev needs a full 40-character lowercase commit hash, got ${q(rev)}`,
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
     * Dry-run: stage the working tree and `nixos-rebuild build` the flake
     * WITHOUT activating it, so a broken config is caught before it can affect
     * the running system. Use this to validate edits before `apply`.
     *
     * @param {string} [message] - optional note recorded in status
     */
    async build(message) {
      return writeRequest({
        action: 'build',
        message: (message && String(message)) || '',
        nonce: nextNonce(),
      });
    },

    /**
     * Commit the current edits and `nixos-rebuild switch` the flake. The root
     * service health-checks the daemon gateway afterward and auto-rolls-back to
     * the previous generation if it does not come back healthy. A commit
     * message is REQUIRED (it is the audit record of the change).
     *
     * @param {string} message
     */
    async apply(message) {
      const trimmed = message && String(message).trim();
      if (!trimmed) {
        throw new Error('apply requires a non-empty commit message.');
      }
      return writeRequest({
        action: 'switch',
        message: trimmed,
        nonce: nextNonce(),
      });
    },

    /**
     * Emergency undo: reactivate the previous system generation (does not touch
     * the config checkout — fix the files and `apply` again to move forward).
     */
    async rollback() {
      return writeRequest({ action: 'rollback', nonce: nextNonce() });
    },

    /** Current applier status plus the static host config. */
    async status() {
      let status = null;
      if (statusPath) {
        try {
          status = JSON.parse(await readFile(statusPath, 'utf8'));
        } catch {
          status = null;
        }
      }
      return harden({ config, status });
    },

    /**
     * Tail of the apply log for diagnostics.
     *
     * @param {number} [maxBytes]
     */
    async getLog(maxBytes = 8192) {
      if (!logPath) return '';
      try {
        const text = await readFile(logPath, 'utf8');
        return text.length > maxBytes
          ? text.slice(text.length - maxBytes)
          : text;
      } catch {
        return '';
      }
    },

    /** @param {string} [method] */
    help(method) {
      const lines = {
        '':
          "NixosAdmin: edit and apply this host's NixOS configuration. " +
          'listFiles(subdir?) / readFile(path) / writeFile(path, text) edit the ' +
          'endo-owned flake checkout; getEndoRev()/setEndoRev(rev) read and ' +
          'set the Endo commit this host runs; build(message?) validates ' +
          'without activating; apply(message) commits + switches with ' +
          'health-checked auto-rollback; rollback() reactivates the last ' +
          'HEALTHY generation, restoring its Endo revision with it; ' +
          'status()/getLog() report progress. Applying is ROOT-EQUIVALENT — ' +
          'validate with build() and confirm with the user before apply().',
        listFiles:
          'listFiles(subdir?) -> string[] of relative config file paths.',
        readFile: 'readFile(path) -> UTF-8 contents of one config file.',
        writeFile: 'writeFile(path, text) -> stage an edit (not yet applied).',
        getEndoRev:
          'getEndoRev() -> the Endo commit this host is configured to run.',
        setEndoRev:
          'setEndoRev(rev) -> stage a different Endo commit (40-hex hash). ' +
          'Takes effect on apply(); a failed apply rolls the revision back ' +
          'with the generation.',
        build:
          'build(message?) -> dry-run nixos-rebuild build (no activation).',
        apply:
          'apply(message) -> commit + nixos-rebuild switch + auto-rollback.',
        rollback:
          'rollback() -> reactivate the last system generation that passed ' +
          'its health check (not merely the previous one, which may itself ' +
          'have been a failed apply).',
        status: 'status() -> { config, status } of the last apply.',
        getLog: 'getLog(maxBytes?) -> tail of the apply log.',
      };
      return lines[method || ''] || lines[''];
    },
  });
};
harden(make);
