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

import {
  DEFAULT_MAX_FRAME_LENGTH,
  listenMcpSocket,
} from '@endo/hosted-agent/mcp-socket.js';

import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @import net from 'node:net' */

const STDIO_BRIDGE_SPECIFIER = new URL(
  import.meta.resolve('@endo/hosted-agent/mcp-stdio-bridge.js'),
);

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
 * Start a per-session MCP socket server.
 *
 * @param {object} options
 * @param {string} options.socketDir - host directory to hold the socket, the
 *   stdio relay, and the MCP config. Created if absent. This whole directory is
 *   what the provisioner bind-mounts read-only into the slice.
 * @param {{ handleMessage: (message: any) => Promise<object | undefined> }} options.bridge
 * @param {number} [options.maxFrameLength] - longest frame accepted before the
 *   connection is dropped (default `DEFAULT_MAX_FRAME_LENGTH`).
 * @param {string} [options.socketName] - socket file name (default `mcp.sock`).
 * @param {string} [options.innerDir] - slice path the dir mounts at (default
 *   `/endo-mcp`); paths baked into the emitted `mcp.json` use it.
 * @param {string} [options.serverName] - MCP server key (default `endo`).
 * @param {typeof net} [options.netModule] - injectable for tests.
 * @param {(specifier: URL, destination: string) => Promise<void>} [options.installBridge]
 *   - copies the stdio relay into `socketDir`; injectable for tests.
 * @param {(destination: string, contents: string) => Promise<void>} [options.writeConfig]
 *   - writes the MCP config into `socketDir`; injectable for tests.
 * @returns {Promise<{
 *   socketDir: string,
 *   socketPath: string,
 *   socketName: string,
 *   stdioBridgeName: string,
 *   configFileName: string,
 *   innerDir: string,
 *   innerConfigPath: string,
 *   close: () => Promise<void>,
 * }>}
 */
export const startMcpSocketServer = async ({
  socketDir,
  bridge,
  maxFrameLength = DEFAULT_MAX_FRAME_LENGTH,
  socketName = DEFAULT_SOCKET_NAME,
  innerDir = DEFAULT_INNER_DIR,
  serverName = DEFAULT_SERVER_NAME,
  netModule,
  installBridge = async (specifier, destination) => {
    await copyFile(specifier, destination);
  },
  writeConfig = async (destination, contents) => {
    await writeFile(destination, contents);
  },
}) => {
  await mkdir(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, socketName);
  // A stale socket from a previous boot would make listen() throw EADDRINUSE.
  await rm(socketPath, { force: true });
  await installBridge(
    STDIO_BRIDGE_SPECIFIER,
    path.join(socketDir, STDIO_BRIDGE_NAME),
  );
  await writeConfig(
    path.join(socketDir, CONFIG_NAME),
    `${JSON.stringify(
      buildMcpConfig({ innerDir, socketName, serverName }),
      null,
      2,
    )}\n`,
  );

  const listener = await listenMcpSocket({
    socketPath,
    bridge,
    maxFrameLength,
    netModule,
  });

  // Idempotent: a lifecycle retry that already stopped the listener must not
  // trip over `server.close()` refusing a server that is not running.
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        await listener.close();
        await rm(socketPath, { force: true });
      })();
    }
    return closing;
  };

  return harden({
    socketDir,
    socketPath,
    socketName,
    stdioBridgeName: STDIO_BRIDGE_NAME,
    configFileName: CONFIG_NAME,
    innerDir,
    innerConfigPath: `${innerDir}/${CONFIG_NAME}`,
    close,
  });
};
harden(startMcpSocketServer);
