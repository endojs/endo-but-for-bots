// @ts-check
/* global harden, process */

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

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const MgmtInterface = M.interface('EndoMgmt', {
  getStatus: M.call().returns(M.promise()),
  requestUpdate: M.call().optional(M.string()).returns(M.promise()),
  requestRestart: M.call().returns(M.promise()),
  getLog: M.call().optional(M.number()).returns(M.promise()),
});

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

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

  /** @param {Record<string, unknown>} request */
  const writeRequest = async request => {
    if (!deployDir) {
      throw new Error(
        'Hosted management is not configured on this daemon ' +
          '(ENDO_DEPLOY_DIR is unset).',
      );
    }
    await mkdir(deployDir, { recursive: true });
    const body = `${JSON.stringify(request)}\n`;
    const tmp = `${requestPath}.tmp`;
    // Write-then-rename so the deployer's path unit only ever sees a complete
    // request file (rename is atomic on the same filesystem).
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, requestPath);
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
      const target = (branch && String(branch).trim()) || defaultBranch;
      if (!BRANCH_RE.test(target)) {
        throw new Error(`Invalid branch name: ${target}`);
      }
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
    async getLog(maxBytes = 8192) {
      if (!logPath) return '';
      try {
        const text = await readFile(logPath, 'utf8');
        return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
      } catch {
        return '';
      }
    },
  });
};
harden(make);
