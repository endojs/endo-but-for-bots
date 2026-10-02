// @ts-check
/// <reference types="ses"/>
/* global process */

// The confined shape's harness-owned connection (designs/endo-guest-stdio-mcp.md
// § How the confinement properties change, shape 1).
//
// The broker runs in the harness process, OUTSIDE the confined `claude` tree.
// It holds the daemon connection, resolves the one guest by formula id, and
// serves that guest's confined tool catalog (the allow-list in `confined.js`)
// as newline-delimited JSON-RPC on a Unix socket in a private per-inference
// directory. A name outside the allow-list is absent from `tools/list` and
// refused at `tools/call`. The claude-spawned side is only `relay.mjs`, a
// plain-Node byte pipe between its stdio and that socket, so the confined tree
// never holds a daemon descriptor or the daemon socket path: the only socket it
// can name is this one, which is pinned to one guest.
//
// The relay is spawned through `env -i`, so it starts with an EMPTY
// environment. Claude Code merges its own whole environment into a stdio MCP
// server's (observed on 2.1.278 and 2.1.280, endo-but-for-bots#1369 gap 2), so
// without the scrub a credential in `claude`'s environment would reach the MCP
// child. The scrub does not rely on that merge order: whatever `claude` passes,
// `env -i` discards it before `node` starts.

import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGuestMcpServer, resolveGuest, readFormulaId } from './server.js';
import { makeAgentTools } from './agent-interface.js';
import { confinedToolNames, selectConfinedTools } from './confined.js';
import { serveStdio } from './stdio.js';

/** @import { ToolDeclaration } from '@endo/agent-tools/adapters/mcp.js' */
/** @import { DaemonConnection } from './types.js' */

/** The plain-Node relay the confined `claude` spawns (no SES, no imports but Node's). */
export const RELAY_PATH = fileURLToPath(
  new URL('./relay.mjs', import.meta.url),
);

export const BROKER_SOCKET_NAME = 'mcp.sock';

/**
 * Render the stdio transport that reaches a broker socket through the relay,
 * with the relay's environment emptied by `env -i`.
 *
 * @param {object} options
 * @param {string} options.socketPath - the broker socket.
 * @param {string} [options.nodePath] - absolute path of `node`.
 * @param {string} [options.envCommand] - absolute path of `env`.
 * @param {string} [options.relayPath]
 * @returns {{ kind: 'stdio', command: string, args: string[] }}
 */
export const makeRelayTransport = ({
  socketPath,
  nodePath = process.execPath,
  envCommand = '/usr/bin/env',
  relayPath = RELAY_PATH,
}) => {
  for (const value of [socketPath, nodePath, envCommand, relayPath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw TypeError(`relay transport paths must be absolute: ${value}`);
    }
  }
  // `env -i` with no NAME=VALUE operands: the relay's environment is empty.
  return harden({
    kind: 'stdio',
    command: envCommand,
    args: ['-i', nodePath, relayPath, socketPath],
  });
};
harden(makeRelayTransport);

/**
 * Stand up a broker for one guest over an already-open daemon connection.
 *
 * The caller owns `connection`; `close()` stops the listener and removes the
 * private directory but does not close the connection.
 *
 * @param {object} options
 * @param {DaemonConnection} options.connection
 * @param {string} options.formulaId - the guest's 64-hex formula number (or
 *   `<number>:<node>`).
 * @param {string} options.version - reported as the MCP server version.
 * @param {ReadonlyArray<ToolDeclaration<any>>} [options.tools] - the full
 *   declaration the confined catalog is selected from.
 * @param {ReadonlyArray<string>} [options.allowedToolNames] - the names served;
 *   defaults to the confined allow-list and replaces it (not intersected with
 *   it). Every other name is absent from `tools/list` and refused at
 *   `tools/call`.
 * @param {string} [options.parentDir] - where the private directory is made.
 * @param {string} [options.nodePath]
 * @param {string} [options.envCommand]
 * @param {(record: object) => void} [options.diagnose] - broker-side
 *   diagnostics (never written to the relay).
 */
export const startGuestBroker = async ({
  connection,
  formulaId,
  version,
  tools = makeAgentTools(),
  allowedToolNames = confinedToolNames,
  parentDir = os.tmpdir(),
  nodePath,
  envCommand,
  diagnose = () => {},
}) => {
  // The same validation the single-tenant server applies to its environment.
  readFormulaId({ ENDO_GUEST_FORMULA_ID: formulaId });
  const guest = await resolveGuest(connection.host, formulaId);
  // Only the allowed names are ever bound: every session's catalog, and so its
  // `tools/list` and its `tools/call` dispatch, is built over this selection.
  const served = harden(selectConfinedTools(tools, allowedToolNames));
  // Validates the served catalog once, before anything listens.
  const { catalog } = makeGuestMcpServer({ guest, version, tools: served });

  const dir = await fs.mkdtemp(path.join(parentDir, 'endo-mcp-broker-'));
  await fs.chmod(dir, 0o700);
  const socketPath = path.join(dir, BROKER_SOCKET_NAME);

  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf-8');
    let open = true;
    /** @param {string} line */
    const writeLine = line => {
      if (open) socket.write(`${line}\n`);
    };
    // A fresh MCP session per connection, bound to the one guest.
    const session = makeGuestMcpServer({
      guest,
      version,
      tools: served,
      connectionClosed: connection.closed,
      notify: message => writeLine(JSON.stringify(message)),
    });
    socket.on('error', error => {
      diagnose({ reason: 'relay-socket-error', message: error.message });
    });
    socket.on('close', () => {
      open = false;
      sockets.delete(socket);
    });
    serveStdio({
      input: socket,
      writeLine,
      handleLine: session.handleLine,
      onError: error =>
        diagnose({
          reason: 'internal-error',
          message: /** @type {Error} */ (error)?.message ?? String(error),
        }),
    }).then(
      () => socket.end(),
      error => {
        diagnose({ reason: 'internal-error', message: String(error) });
        socket.destroy();
      },
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  await fs.chmod(socketPath, 0o600);

  const transport = makeRelayTransport({ socketPath, nodePath, envCommand });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(() => resolve(undefined)));
    await fs.rm(dir, { recursive: true, force: true });
  };

  return harden({
    socketPath,
    toolsList: async () => catalog.tools,
    transport: async () => transport,
    close,
  });
};
harden(startGuestBroker);
