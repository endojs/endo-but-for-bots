// @ts-check
// Transport for the per-session MCP bridge (@endo/hosted-agent/mcp-bridge.js): a Unix-domain
// socket the sandboxed opencode session connects to (via the plain-node stdio
// relay, mcp-stdio-bridge.mjs) to reach the session's Endo tools.
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

import { chmod, lstat, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
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
 * Build one opencode `mcp` server entry: a `local` server whose command is the
 * plain-node stdio relay INSIDE the slice, pointed at the bind-mounted socket.
 * Every path is a slice-internal path (the socket dir is bind-mounted read-only
 * at `innerDir`), and `node` is on the sandbox image PATH.
 *
 * @param {object} options
 * @param {string} options.innerDir - slice path the socket dir is mounted at.
 * @param {string} options.socketName
 * @param {string} [options.bridgeName] - stdio relay file name
 *   (default `mcp-stdio-bridge.mjs`).
 */
export const buildOpencodeMcpServer = ({
  innerDir,
  socketName,
  bridgeName = STDIO_BRIDGE_NAME,
}) =>
  harden({
    type: 'local',
    command: harden([
      'node',
      `${innerDir}/${bridgeName}`,
      `${innerDir}/${socketName}`,
    ]),
    enabled: true,
  });
harden(buildOpencodeMcpServer);

/**
 * The opencode-native `mcp` config block (unlike Claude Code's
 * `mcpServers`/`type: 'stdio'` shape).  Written beside the socket for
 * diagnostics; the authoritative copy is merged into
 * `OPENCODE_CONFIG_CONTENT` by `opencode-client-module.js`, which builds the
 * same entry via {@link buildOpencodeMcpServer}.
 *
 * @param {object} options
 * @param {string} options.innerDir - slice path the socket dir is mounted at.
 * @param {string} options.socketName
 * @param {string} options.serverName - MCP server key opencode sees the tools under.
 */
export const buildMcpConfig = ({ innerDir, socketName, serverName }) =>
  harden({
    mcp: {
      [serverName]: buildOpencodeMcpServer({ innerDir, socketName }),
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
    // Never follow a planted symlink at the destination.
    await rm(destination, { force: true });
    await copyFile(specifier, destination);
  },
  writeConfig = async (destination, contents) => {
    await rm(destination, { force: true });
    await writeFile(destination, contents, { mode: 0o600 });
  },
}) => {
  const existing = await lstat(socketDir).catch(() => undefined);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw Error('MCP socket directory must be a real directory');
  }
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await chmod(socketDir, 0o700);
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
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await listener.close();
    await rm(socketPath, { force: true });
    throw error;
  }

  // Idempotent: a lifecycle retry that already stopped the listener must not
  // trip over `server.close()` refusing a server that is not running.
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        await listener.close();
        await rm(socketPath, { force: true });
      })().catch(error => {
        // Retry failed filesystem cleanup, but keep a successful close cached:
        // an old owner must never unlink a successor using this socket path.
        closing = undefined;
        throw error;
      });
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
