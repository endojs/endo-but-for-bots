// @ts-check
/* global process */

/**
 * The `claude-backend` caplet: a Floot hosted backend factory for the Claude
 * CLI runtime, minted by `setup-hosted.js` with `@agent` host powers and bound
 * into the Floot controller profile under the conventional `claude-backend`
 * name Floot's factory discovers.
 *
 * It composes the per-session provisioner (`claude-session-provisioner.js`)
 * with the MCP tool bridge (`mcp-bridge.js` over `mcp-socket-server.js`) and
 * hands both to `makeClaudeBackendFactory`. Floot only ever holds the
 * guarded factory facet; the host powers this caplet runs with never cross
 * that boundary.
 *
 * Formula env (all optional; `process.env` `ENDO_`-spellings are fallbacks):
 *   CLAUDE_CLIENT_NAME        Pet-name base for per-session clients.
 *   CLAUDE_CREDS_NAME         ClaudeCredentials cap name (default claude-creds).
 *   CLAUDE_WORKSPACE_BASE_DIR Host base directory for per-session workspaces.
 *   CLAUDE_CONFIG_BASE_DIR    Host base directory for per-session config dirs.
 *   CLAUDE_SANDBOX_IMAGE      OCI rootfs for the slice.
 *   CLAUDE_MCP_DIR            Host base directory for per-session MCP sockets.
 *
 * @module
 */

import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';

import { makeClaudeBackendFactory } from './claude-backend-factory.js';
import { makeClaudeSessionProvisioner } from './claude-session-provisioner.js';
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
    env.CLAUDE_WORKSPACE_BASE_DIR ||
    process.env.ENDO_CLAUDE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'claude-workspaces');
  return harden({
    clientBase:
      env.CLAUDE_CLIENT_NAME ||
      process.env.ENDO_CLAUDE_CLIENT_NAME ||
      'claude-client',
    credentialsName:
      env.CLAUDE_CREDS_NAME ||
      process.env.ENDO_CLAUDE_CREDS_NAME ||
      'claude-creds',
    workspaceBaseDir,
    configBaseDir:
      env.CLAUDE_CONFIG_BASE_DIR ||
      process.env.ENDO_CLAUDE_CONFIG_DIR ||
      path.join(path.dirname(workspaceBaseDir), 'claude-configs'),
    rootfs:
      env.CLAUDE_SANDBOX_IMAGE ||
      process.env.CLAUDE_SANDBOX_IMAGE ||
      process.env.ENDO_CLAUDE_SANDBOX_IMAGE ||
      'oci:localhost/claude-code:latest',
    // The socket directory path is stable per session: the persisted client
    // formula's read-only mount records it, so a revival after a daemon
    // restart must find the new listener at the same path.
    mcpBaseDir:
      env.CLAUDE_MCP_DIR ||
      process.env.ENDO_CLAUDE_MCP_DIR ||
      path.join(os.tmpdir(), 'claude-mcp'),
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
  const provisioner = makeClaudeSessionProvisioner(hostAgent, {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
  });
  const socketDirFor = sessionId => path.join(mcpBaseDir, sessionId);

  return makeClaudeBackendFactory({
    provisionClient: async (sessionId, options) => {
      await E(provisioner).provision(sessionId, options);
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
