// @ts-check
/* global process */

// Hosted-Endo management caplet.
//
// This is an UNCONFINED module (it has Node.js APIs) that the daemon
// instantiates via `host.makeUnconfined('@main', <this>, { resultName:
// 'controller-for-endo-mgmt', env })`. It is the capability that lets a Chat
// client update and restart the daemon on a self-hosted server WITHOUT SSH.
//
// It does NOT perform the update/restart itself (the daemon cannot cleanly
// restart itself, and privileged actions belong outside the daemon). Instead
// it speaks to the host's `endo-deploy` service through a tiny file spool:
//
//   - writes  $ENDO_DEPLOY_DIR/request.json  (atomically) to trigger work
//   - reads   $ENDO_DEPLOY_DIR/status.json   for the deployer's progress
//   - reads   $ENDO_DEPLOY_DIR/deploy.log    tail for diagnostics
//
// See the endo-host repo's modules/endo-deploy.nix for the other end.

import { Fail, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MgmtInterface = M.interface('EndoMgmt', {
  getStatus: M.call().returns(M.promise()),
  requestUpdate: M.call().optional(M.string()).returns(M.promise()),
  requestRestart: M.call().returns(M.promise()),
  getLog: M.call().optional(M.number()).returns(M.promise()),
});

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const MAX_BRANCH_LENGTH = 255;
const DEFAULT_LOG_TAIL_BYTES = 8192;
const MAX_LOG_TAIL_BYTES = 1024 * 1024;

/**
 * Accept only branch names that a conservative reading of git's
 * `check-ref-format` would accept.
 *
 * The name crosses this boundary into a privileged deployer that fetches,
 * builds, and restarts it, so the check is deliberately stricter than "the
 * characters look harmless": a leading `-` can be read as a git option rather
 * than a refspec, and `..` escapes any directory the far end derives from the
 * name. Validating here rather than trusting the deployer to re-validate keeps
 * the guarantee with the capability that grants the authority.
 *
 * @param {string} branch
 * @returns {string} the same branch name, once validated
 */
const assertBranch = branch => {
  (branch.length > 0 && branch.length <= MAX_BRANCH_LENGTH) ||
    Fail`Branch name must be 1 to ${q(MAX_BRANCH_LENGTH)} characters: ${q(branch)}`;
  BRANCH_RE.test(branch) ||
    Fail`Branch name may only contain letters, digits, and ${q('._/-')}: ${q(branch)}`;
  !branch.includes('..') ||
    Fail`Branch name must not contain ${q('..')}: ${q(branch)}`;
  for (const part of branch.split('/')) {
    part.length > 0 ||
      Fail`Branch name must not have an empty path component: ${q(branch)}`;
    !part.startsWith('-') ||
      Fail`Branch name components must not start with ${q('-')}: ${q(branch)}`;
    !part.startsWith('.') ||
      Fail`Branch name components must not start with ${q('.')}: ${q(branch)}`;
    !part.endsWith('.lock') ||
      Fail`Branch name components must not end with ${q('.lock')}: ${q(branch)}`;
  }
  return branch;
};

/**
 * @param {unknown} _powers - unused (the caplet acts through the file spool)
 * @param {unknown} _context
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export const make = async (_powers, _context, options = {}) => {
  const env = (options && options.env) || {};
  const readEnv = key => env[key] || process.env[key] || '';

  const deployDir = readEnv('ENDO_DEPLOY_DIR');
  const repoUrl = readEnv('ENDO_MGMT_REPO_URL');
  const defaultBranch = readEnv('ENDO_MGMT_DEFAULT_BRANCH') || 'llm';

  const requestPath = deployDir ? join(deployDir, 'request.json') : '';
  const statusPath = deployDir ? join(deployDir, 'status.json') : '';
  const logPath = deployDir ? join(deployDir, 'deploy.log') : '';

  const config = harden({
    repoUrl,
    defaultBranch,
    deployDir,
    configured: Boolean(deployDir),
  });

  // Monotonic within this incarnation; combined with the wall clock so every
  // request is a distinct value and the deployer's path-watcher always fires.
  let counter = 0;
  const nextNonce = () => {
    counter += 1;
    return `${new Date().toISOString()}#${counter}`;
  };

  let tmpCounter = 0;

  /** @param {Record<string, unknown>} request */
  const writeRequest = async request => {
    deployDir ||
      Fail`Hosted management is not configured on this daemon (ENDO_DEPLOY_DIR is unset).`;
    await mkdir(deployDir, { recursive: true });
    const body = `${JSON.stringify(request)}\n`;
    // A scratch name unique per write. Two overlapping requests sharing one
    // scratch path can interleave their writes, and the `rename` would then
    // publish a torn file — precisely what write-then-rename is here to
    // prevent.
    tmpCounter += 1;
    const tmp = `${requestPath}.${process.pid}.${tmpCounter}.tmp`;
    // Write-then-rename so the deployer's path unit only ever sees a complete
    // request file (rename is atomic on the same filesystem).
    try {
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, requestPath);
    } catch (err) {
      // Leave no partial scratch file behind for the deployer to trip over.
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return request;
  };

  return makeExo('EndoMgmt', MgmtInterface, {
    /** Current deployer status plus the static host config. */
    async getStatus() {
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
     * Request an update to `branch` (defaults to the configured branch): the
     * host fetches it, rebuilds, and restarts with automatic rollback.
     *
     * @param {string} [branch]
     */
    async requestUpdate(branch) {
      const target = assertBranch((branch && branch.trim()) || defaultBranch);
      return harden(
        await writeRequest({
          action: 'deploy',
          branch: target,
          nonce: nextNonce(),
        }),
      );
    },

    /** Restart the daemon on the current release (no rebuild). */
    async requestRestart() {
      return harden(
        await writeRequest({ action: 'restart', nonce: nextNonce() }),
      );
    },

    /**
     * Tail of the deploy log for diagnostics.
     *
     * @param {number} [maxBytes]
     */
    async getLog(maxBytes = DEFAULT_LOG_TAIL_BYTES) {
      if (!logPath) return '';
      // `maxBytes` bounds an allocation rather than describing anything about
      // the domain, so clamp it to a range this daemon can afford instead of
      // trusting whatever the caller passed. NaN reads as "none"; an infinite
      // request reads as "as much as we allow".
      const requested = Math.trunc(maxBytes);
      const limit = Number.isNaN(requested)
        ? 0
        : Math.min(Math.max(requested, 0), MAX_LOG_TAIL_BYTES);
      if (limit === 0) return '';

      /** @type {Awaited<ReturnType<typeof open>> | undefined} */
      let handle;
      try {
        handle = await open(logPath, 'r');
        const { size } = await handle.stat();
        const length = Math.min(size, limit);
        if (length === 0) return '';
        // Seek to the tail rather than reading the file and discarding most of
        // it: the deploy log grows without bound, so slurping it whole to
        // return a few kilobytes puts the daemon's heap at the mercy of the
        // log's size.
        const bytes = new Uint8Array(length);
        await handle.read(bytes, 0, length, size - length);
        // A tail that begins mid-character decodes to a replacement character,
        // which is the right trade for a diagnostic tail.
        return new TextDecoder().decode(bytes);
      } catch {
        return '';
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  });
};
harden(make);
