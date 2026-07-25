// @ts-check
// Transport for the per-session MCP bridge (src/mcp-bridge.js): a Unix-domain
// socket the sandboxed Claude Code session connects to (via the plain-node
// stdio relay, mcp-stdio-bridge.mjs) to reach Floot's Endo tools.
//
// The server lives in the Floot daemon worker — OUTSIDE the credential-bearing
// container — and speaks newline-delimited JSON-RPC 2.0: each `\n`-terminated
// line is one decoded request handed to `bridge.handleMessage`, whose response
// (when the message is not a notification) is written back as one line. Only
// JSON ever crosses the socket.
//
// The socket, and a copy of the stdio relay, live in a per-session directory
// that the provisioner bind-mounts read-only into the slice. `close()` stops
// the listener and unlinks the socket; the caller removes the directory.

import net from 'node:net';
import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STDIO_BRIDGE_SPECIFIER = new URL(
  './mcp-stdio-bridge.mjs',
  import.meta.url,
);

const DEFAULT_SOCKET_NAME = 'mcp.sock';
const STDIO_BRIDGE_NAME = 'mcp-stdio-bridge.mjs';
const CONFIG_NAME = 'mcp.json';
const DEFAULT_INNER_DIR = '/endo-mcp';
const DEFAULT_SERVER_NAME = 'endo';

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
const buildMcpConfig = ({ innerDir, socketName, serverName }) => ({
  mcpServers: {
    [serverName]: {
      type: 'stdio',
      command: 'node',
      args: [`${innerDir}/${STDIO_BRIDGE_NAME}`, `${innerDir}/${socketName}`],
    },
  },
});

/**
 * Split accumulated socket bytes into complete newline-delimited frames,
 * returning the frames and the trailing partial line to carry over.
 *
 * @param {string} buffer
 * @returns {{ lines: string[], rest: string }}
 */
const takeLines = buffer => {
  /** @type {string[]} */
  const lines = [];
  let rest = buffer;
  let nl = rest.indexOf('\n');
  while (nl >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line !== '') lines.push(line);
    nl = rest.indexOf('\n');
  }
  return { lines, rest };
};
harden(takeLines);

/**
 * Start a per-session MCP socket server.
 *
 * @param {object} options
 * @param {string} options.socketDir - host directory to hold the socket, the
 *   stdio relay, and the MCP config. Created if absent. This whole directory is
 *   what the provisioner bind-mounts read-only into the slice.
 * @param {{ handleMessage: (message: any) => Promise<object | undefined> }} options.bridge
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
  socketName = DEFAULT_SOCKET_NAME,
  innerDir = DEFAULT_INNER_DIR,
  serverName = DEFAULT_SERVER_NAME,
  netModule = net,
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

  /** @type {Set<import('node:net').Socket>} */
  const connections = new Set();

  const server = netModule.createServer(connection => {
    connections.add(connection);
    connection.setEncoding('utf8');
    let buffer = '';
    // Serialize replies so out-of-order tool completions never interleave two
    // JSON frames on the wire.
    let writeChain = Promise.resolve();

    connection.on('data', chunk => {
      // `setEncoding('utf8')` above makes chunks strings at runtime; the node
      // typings still widen the event payload to Buffer, so coerce explicitly.
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { lines, rest } = takeLines(buffer);
      buffer = rest;
      for (const line of lines) {
        /** @type {any} */
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // A malformed frame gets a JSON-RPC parse error with a null id.
          writeChain = writeChain.then(() => {
            connection.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32_700, message: 'Parse error' },
              })}\n`,
            );
          });
          // eslint-disable-next-line no-continue
          continue;
        }
        writeChain = writeChain.then(async () => {
          let response;
          try {
            response = await bridge.handleMessage(message);
          } catch (error) {
            response = {
              jsonrpc: '2.0',
              id: message && message.id !== undefined ? message.id : null,
              error: {
                code: -32_603,
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
          if (response !== undefined && !connection.destroyed) {
            connection.write(`${JSON.stringify(response)}\n`);
          }
        });
      }
    });

    const drop = () => connections.delete(connection);
    connection.on('close', drop);
    connection.on('error', drop);
  });

  server.on('error', error => {
    console.error(
      `[floot-mcp] socket server error (${socketPath}):`,
      error instanceof Error ? error.message : String(error),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });

  const close = async () => {
    for (const connection of connections) {
      try {
        connection.destroy();
      } catch {
        // already gone
      }
    }
    connections.clear();
    await new Promise(resolve => server.close(() => resolve(undefined)));
    await rm(socketPath, { force: true });
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

export {
  takeLines,
  buildMcpConfig,
  STDIO_BRIDGE_NAME,
  DEFAULT_SOCKET_NAME,
  DEFAULT_INNER_DIR,
  CONFIG_NAME,
};
