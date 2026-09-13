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
  makeMcpSocketListener,
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
 * Construct an inert per-session MCP socket server owner.
 * Retain this kit before start(). close() fences transport admission immediately
 * and waits for startup, admitted host calls, and native listener closure before
 * removing the socket. Failed cleanup remains available for retry.
 * The caller exclusively owns the private socket directory and its stable
 * ancestry throughout this lifetime. Existing socket paths are not reconciled.
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
 * @param {typeof chmod} [options.setPermissions] - native permissions seam for tests.
 * @returns {{
 *   start: () => Promise<void>,
 *   socketDir: string,
 *   socketPath: string,
 *   socketName: string,
 *   stdioBridgeName: string,
 *   configFileName: string,
 *   innerDir: string,
 *   innerConfigPath: string,
 *   close: () => Promise<void>,
 * }}
 */
export const makeMcpSocketServer = ({
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
  setPermissions = chmod,
  writeConfig = async (destination, contents) => {
    await rm(destination, { force: true });
    await writeFile(destination, contents, { mode: 0o600 });
  },
}) => {
  const socketPath = path.join(socketDir, socketName);
  const listener = makeMcpSocketListener({
    socketPath,
    bridge,
    maxFrameLength,
    netModule,
  });
  /** @type {Promise<void> | undefined} */
  let starting;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;
  let socketOwned = false;
  const assertOpen = () => {
    if (stopped) throw Error('OpenCode MCP server is closed');
  };
  /** @param {string} nativePath */
  const inspect = async nativePath => {
    try {
      return await lstat(nativePath);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
      return undefined;
    }
  };

  const start = () => {
    assertOpen();
    starting ??= (async () => {
      const existing = await inspect(socketDir);
      assertOpen();
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
        throw Error('MCP socket directory must be a real directory');
      }
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      assertOpen();
      await setPermissions(socketDir, 0o700);
      assertOpen();
      if (await inspect(socketPath))
        throw Error('MCP socket path already exists');
      assertOpen();
      await installBridge(
        STDIO_BRIDGE_SPECIFIER,
        path.join(socketDir, STDIO_BRIDGE_NAME),
      );
      assertOpen();
      await writeConfig(
        path.join(socketDir, CONFIG_NAME),
        `${JSON.stringify(
          buildMcpConfig({ innerDir, socketName, serverName }),
          null,
          2,
        )}\n`,
      );
      assertOpen();
      // Under the caller's exclusive-placement contract, a file created by
      // this listen attempt belongs to this owner, even if startup fails.
      socketOwned = true;
      await listener.start();
      assertOpen();
      await setPermissions(socketPath, 0o600);
      assertOpen();
    })();
    return starting;
  };

  const close = () => {
    stopped = true;
    if (closing) return closing;
    const stoppedListener = listener.close();
    const attempt = (async () => {
      const results = await Promise.allSettled([
        stoppedListener,
        starting?.catch(() => {}),
      ]);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => /** @type {PromiseRejectedResult} */ (result).reason);
      if (failures.length)
        throw new AggregateError(failures, 'OpenCode MCP cleanup pending');
      if (socketOwned) {
        await rm(socketPath, { force: true });
        socketOwned = false;
      }
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };

  return harden({
    socketDir,
    socketPath,
    socketName,
    stdioBridgeName: STDIO_BRIDGE_NAME,
    configFileName: CONFIG_NAME,
    innerDir,
    innerConfigPath: `${innerDir}/${CONFIG_NAME}`,
    start,
    close,
  });
};
harden(makeMcpSocketServer);

/**
 * Transitional convenience entrypoint. A startup rejection is not cleanup
 * proof when rollback also fails. Owners needing a retry handle must retain
 * makeMcpSocketServer() before invoking start().
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
        'OpenCode MCP startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(startMcpSocketServer);
