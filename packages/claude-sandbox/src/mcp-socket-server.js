// @ts-check
// Transport for the per-session MCP bridge (@endo/hosted-agent/mcp-bridge.js): a Unix-domain
// socket the sandboxed Claude Code session connects to (via the plain-node
// stdio relay, mcp-stdio-bridge.mjs) to reach the session's Endo tools.
//
// The server lives in the hosted backend's daemon worker — OUTSIDE the
// guest container — and speaks newline-delimited JSON-RPC 2.0:
// each `\n`-terminated line is one decoded request handed to
// `bridge.handleMessage`, whose response (when the message is not a
// notification) is written back as one line. Only JSON ever crosses the socket.
//
// The socket, and a copy of the stdio relay, live in a per-session directory
// that the provisioner bind-mounts read-only into the slice. `close()` stops
// the listener and unlinks the socket; the caller removes the directory.

import { makeHostedMcpSocketServer } from '@endo/hosted-agent/mcp-server.js';

export const DEFAULT_SOCKET_NAME = 'mcp.sock';
export const STDIO_BRIDGE_NAME = 'mcp-stdio-bridge.mjs';
export const CONFIG_NAME = 'mcp.json';
export const DEFAULT_INNER_DIR = '/endo-mcp';
export const DEFAULT_SERVER_NAME = 'endo';
harden(DEFAULT_SOCKET_NAME);
harden(STDIO_BRIDGE_NAME);
harden(CONFIG_NAME);
harden(DEFAULT_INNER_DIR);
harden(DEFAULT_SERVER_NAME);

/**
 * The `--mcp-config` JSON Claude Code reads to launch the stdio bridge INSIDE
 * the slice. Every path is a slice-internal path (the socket dir is bind-mounted
 * read-only at `innerDir`), and `node` is on the sandbox image PATH.
 *
 * @param {object} options
 * @param {string} options.innerDir - slice path the socket dir is mounted at.
 * @param {string} options.socketName
 * @param {string} options.serverName - MCP server key Claude sees the tools under.
 */
export const buildMcpConfig = ({ innerDir, socketName, serverName }) =>
  harden({
    mcpServers: {
      [serverName]: {
        type: 'stdio',
        command: 'node',
        args: [`${innerDir}/${STDIO_BRIDGE_NAME}`, `${innerDir}/${socketName}`],
      },
    },
  });
harden(buildMcpConfig);

/**
 * Retained owner; the session supervisor keeps it before start can acquire.
 * @param {Omit<Parameters<typeof makeHostedMcpSocketServer>[0], 'buildConfig'>} options
 */
export const makeMcpSocketServer = options =>
  makeHostedMcpSocketServer({ ...options, buildConfig: buildMcpConfig });
harden(makeMcpSocketServer);

/**
 * Convenience for callers that do not retain partial startup. Native session
 * owners use makeMcpSocketServer directly so failed cleanup stays retryable.
 * @param {Parameters<typeof makeMcpSocketServer>[0]} options
 */
export const startMcpSocketServer = async options => {
  const server = makeMcpSocketServer(options);
  try {
    await server.start();
    return server;
  } catch (error) {
    try {
      await server.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Hosted MCP startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(startMcpSocketServer);
