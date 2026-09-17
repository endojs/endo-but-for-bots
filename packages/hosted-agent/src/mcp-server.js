// @ts-check

import { chmod, lstat, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MAX_FRAME_LENGTH,
  makeMcpSocketListener,
} from './mcp-socket.js';

/** @import net from 'node:net' */

const STDIO_BRIDGE_SPECIFIER = new URL(
  import.meta.resolve('@endo/hosted-agent/mcp-stdio-bridge.js'),
);

const DEFAULT_SOCKET_NAME = 'mcp.sock';
const STDIO_BRIDGE_NAME = 'mcp-stdio-bridge.mjs';
const CONFIG_NAME = 'mcp.json';
const DEFAULT_INNER_DIR = '/endo-mcp';
const DEFAULT_SERVER_NAME = 'endo';

/**
 * Construct an inert per-session MCP socket server owner.
 * Retain this kit before start(). close() fences transport admission immediately
 * and waits for startup, admitted host calls, and native listener closure before
 * removing the socket. Failed cleanup remains available for retry.
 * The caller exclusively owns the private socket directory and its stable
 * ancestry throughout this lifetime. The daemon must prove the predecessor stopped before reusing this directory.
 *
 * @param {object} options
 * @param {(options: {innerDir: string, socketName: string, serverName: string}) => object} options.buildConfig
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
export const makeHostedMcpSocketServer = ({
  socketDir,
  bridge,
  buildConfig,
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
    if (stopped) throw Error('Hosted MCP server is closed');
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
      // The caller owns this directory exclusively and has reconciled its
      // predecessor. Unlinking a socket does NOT prove its listener is dead.
      // Refuse other inode kinds instead of destroying unrelated data.
      const existingSocket = await inspect(socketPath);
      if (existingSocket) {
        if (!existingSocket.isSocket()) {
          throw Error('MCP socket path is not a socket');
        }
        await rm(socketPath, { force: true });
      }
      assertOpen();
      await installBridge(
        STDIO_BRIDGE_SPECIFIER,
        path.join(socketDir, STDIO_BRIDGE_NAME),
      );
      assertOpen();
      await writeConfig(
        path.join(socketDir, CONFIG_NAME),
        `${JSON.stringify(
          buildConfig({ innerDir, socketName, serverName }),
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
        throw new AggregateError(failures, 'Hosted MCP cleanup pending');
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
harden(makeHostedMcpSocketServer);
