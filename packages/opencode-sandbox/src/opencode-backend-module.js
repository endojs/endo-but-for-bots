// @ts-check
/* global process */

/**
 * The `opencode-backend` caplet: a Floot hosted backend factory for the
 * opencode runtime, minted by `setup-hosted.js` with `@agent` host powers and
 * bound into the Floot controller profile under the conventional
 * `opencode-backend` name Floot's factory discovers.
 *
 * It composes the per-session provisioner
 * (`opencode-session-provisioner.js`) with the MCP tool bridge
 * (`mcp-bridge.js` over `mcp-socket-server.js`) and the hard-coded model
 * catalog and hands them to `makeOpencodeBackendFactory`. Floot only ever
 * holds the guarded factory facet; the host powers this caplet runs with
 * never cross that boundary.
 *
 * Formula env (all optional; `process.env` `ENDO_`-spellings are fallbacks):
 *   OPENCODE_CLIENT_NAME        Pet-name base for per-session clients.
 *   OPENCODE_CREDS_NAME         OpenCodeCredentials cap name (default
 *                               opencode-creds).
 *   OPENCODE_WORKSPACE_BASE_DIR Host base directory for per-session
 *                               workspaces.
 *   OPENCODE_CONFIG_BASE_DIR    Host base directory for per-session config
 *                               dirs.
 *   OPENCODE_SANDBOX_IMAGE      OCI rootfs for the slice.
 *   OPENCODE_MCP_DIR            Host base directory for per-session MCP
 *                               sockets.
 *
 * @module
 */

import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';

import { makeOpencodeBackendFactory } from './opencode-backend-factory.js';
import { makeOpencodeSessionProvisioner } from './opencode-session-provisioner.js';
import { makeMcpBridgeForToolSet } from './mcp-bridge.js';
import { startMcpSocketServer } from './mcp-socket-server.js';

/**
 * Resolve the provisioner configuration from the formula env and the daemon's
 * environment.
 *
 * @param {Record<string, string>} env
 */
export const resolveBackendConfig = env => {
  const workspaceBaseDir =
    env.OPENCODE_WORKSPACE_BASE_DIR ||
    process.env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'opencode-workspaces');
  return harden({
    clientBase:
      env.OPENCODE_CLIENT_NAME ||
      process.env.ENDO_OPENCODE_CLIENT_NAME ||
      'opencode-client',
    credentialsName:
      env.OPENCODE_CREDS_NAME ||
      process.env.ENDO_OPENCODE_CREDS_NAME ||
      'openrouter-auth',
    workspaceBaseDir,
    configBaseDir:
      env.OPENCODE_CONFIG_BASE_DIR ||
      process.env.ENDO_OPENCODE_CONFIG_DIR ||
      path.join(path.dirname(workspaceBaseDir), 'opencode-configs'),
    rootfs:
      env.OPENCODE_SANDBOX_IMAGE ||
      process.env.ENDO_OPENCODE_SANDBOX_IMAGE ||
      'oci:localhost/opencode:latest',
    // The socket directory path is stable per session: the persisted client
    // formula's read-only mount records it, so a revival after a daemon
    // restart must find the new listener at the same path.
    mcpBaseDir:
      env.OPENCODE_MCP_DIR ||
      process.env.ENDO_OPENCODE_MCP_DIR ||
      path.join(os.tmpdir(), 'opencode-mcp'),
  });
};
harden(resolveBackendConfig);

/**
 * Caplet entry point.
 *
 * @param {any} hostAgent - `@agent` host powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (hostAgent, _context, { env = {} } = {}) => {
  const {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
    mcpBaseDir,
  } = resolveBackendConfig(env);
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
  });
  const socketDirFor = sessionId => path.join(mcpBaseDir, sessionId);

  return makeOpencodeBackendFactory({
    provisionClient: async (sessionId, options) => {
      // The factory carries the Floot-side `workspaceHostPath`; the
      // provisioner names the same override `workspaceDir`.
      const { workspaceHostPath, ...rest } = options;
      await E(provisioner).provision(
        sessionId,
        harden({
          ...rest,
          ...(workspaceHostPath ? { workspaceDir: workspaceHostPath } : {}),
        }),
      );
      return E(provisioner).lookup(sessionId);
    },
    cancelClient: sessionId => E(provisioner).cancel(sessionId),
    removeSession: sessionId => E(provisioner).remove(sessionId),
    startToolBridge: async (sessionId, toolSet) => {
      const bridge = await makeMcpBridgeForToolSet(toolSet);
      const server = await startMcpSocketServer({
        socketDir: socketDirFor(sessionId),
        bridge,
      });
      return harden({
        socketDir: server.socketDir,
        innerDir: server.innerDir,
        configPath: server.innerConfigPath,
        pendingCalls: bridge.pendingCalls,
        close: server.close,
      });
    },
    removeToolBridge: async sessionId => {
      await rm(socketDirFor(sessionId), { recursive: true, force: true });
    },
  });
};
harden(make);
