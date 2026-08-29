// @ts-check
/* global process */

import { readFileSync, writeFileSync } from 'node:fs';

import { E } from '@endo/eventual-send';
import { makeError, X } from '@endo/errors';

import { makeCodexClient } from './codex-client.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

/** @import { FarRef } from '@endo/eventual-send' */

/**
 * Per-session CodexClient formula. The workspace is projected over 9P, while
 * the host-managed Codex home is a direct read/write bind shared by all Codex
 * sessions on this machine. Only the thread id is persisted separately per
 * Floot session; auth.json remains machine-scoped and writable by the CLI.
 *
 * @param {FarRef<object>} powers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [contextWrapper]
 */
export const make = (powers, _context, contextWrapper = {}) => {
  /** @type {any} */
  const sessionPowers = powers;
  const env = contextWrapper.env ?? process.env;
  const sessionId = env.SESSION_ID;
  if (!sessionId) throw makeError(X`codex-client-module: SESSION_ID required`);
  const workspaceMountPoint = env.WORKSPACE_MOUNT_POINT;
  if (!workspaceMountPoint) {
    throw makeError(X`codex-client-module: WORKSPACE_MOUNT_POINT required`);
  }
  const threadStateFile = env.THREAD_STATE_FILE;
  if (!threadStateFile) {
    throw makeError(X`codex-client-module: THREAD_STATE_FILE required`);
  }

  const workspacePetName =
    env.WORKSPACE_PET_NAME || `codex-${sessionId}-workspace`;
  const workspacePath = env.WORKSPACE_PATH || '/workspace';
  const codexHomeInnerDir = env.CODEX_HOME_INNER_DIR || '/codex-home';
  const backend = env.BACKEND || 'podman';
  const network = env.NETWORK || 'private';
  const model = env.MODEL || undefined;
  const mcpConfigPath = env.MCP_CONFIG_PATH || undefined;
  const mcpInnerDir = env.MCP_INNER_DIR || '/endo-mcp';
  const parsedRootfs = parseRootfs(env.CODEX_ROOTFS, {
    defaultImage: env.DEFAULT_IMAGE || undefined,
  });

  const resolveThreadId = () => {
    try {
      const value = readFileSync(threadStateFile, 'utf8').trim();
      return /^[0-9a-f-]{32,64}$/i.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  /** @param {string} threadId */
  const persistThreadId = threadId => {
    writeFileSync(threadStateFile, `${threadId}\n`, { mode: 0o600 });
  };

  /**
   * @param {readonly import('./codex-client.js').ExtraMountSpec[]} [extraMounts]
   */
  const provision = async (extraMounts = harden([])) => {
    const sandboxFactory = await E(sessionPowers).sandboxFactory();
    const fsMounter = await E(sessionPowers).fsMounter();
    const fs = await E(sessionPowers).filesystem();
    const codexHomeMount = await E(sessionPowers).codexHomeMount();
    if (!fs) throw makeError(X`codex-sandbox: no Filesystem cap was provided`);
    if (!codexHomeMount) {
      throw makeError(X`codex-sandbox: no Codex home Mount cap was provided`);
    }

    /** @type {any} */
    let mountHandle = null;
    try {
      mountHandle = await E(fsMounter).mount(
        fs,
        workspaceMountPoint,
        harden({ lazyUnmount: true }),
      );
      const workspaceCap = await E(sessionPowers).provideMount(
        workspaceMountPoint,
        workspacePetName,
      );
      const mcpCap = mcpConfigPath
        ? (await E(sessionPowers).mcpMount()) || null
        : null;
      const mounts = [
        { cap: workspaceCap, innerPath: workspacePath, mode: 'rw' },
        { cap: codexHomeMount, innerPath: codexHomeInnerDir, mode: 'rw' },
        ...(mcpCap
          ? [{ cap: mcpCap, innerPath: mcpInnerDir, mode: 'ro' }]
          : []),
        ...extraMounts.map(({ cap, innerPath, mode }) => ({
          cap,
          innerPath,
          mode,
        })),
      ];
      const slice = await E(sandboxFactory).make(
        harden({
          rootfs: parsedRootfs,
          mounts,
          network,
          env: {},
          cwd: workspacePath,
          backend,
        }),
      );
      return harden({
        slice,
        mountHandle,
        removeMount: () => E(sessionPowers).removeMount(),
      });
    } catch (error) {
      if (mountHandle) {
        await E(mountHandle)
          .unmount()
          .catch(() => {});
      }
      throw error;
    }
  };

  return makeCodexClient({
    sessionId,
    createdAt: env.CREATED_AT || new Date().toISOString(),
    provision,
    workspaceMountPoint,
    workspacePath,
    backend,
    rootfsLabel: rootfsLabel(parsedRootfs),
    model,
    mcpConfigPath,
    env: {
      HOME: '/tmp/codex-user',
      XDG_CONFIG_HOME: '/tmp/codex-user/.config',
      CODEX_HOME: codexHomeInnerDir,
    },
    resolveThreadId,
    persistThreadId,
  });
};
harden(make);
