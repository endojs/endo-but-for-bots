// @ts-check
/**
 * @import {
 *   AgentToOrchMessage,
 *   OrchToAgentMessage,
 * } from '../../protocol.types.js'
 */

import net from 'node:net';
import { unlinkSync } from 'node:fs';

import { makePromiseKit } from '@endo/promise-kit';

/**
 * @typedef {object} AgentLink
 * @property {() => Promise<void>} ready                Resolved when the agent sends its first `ready` message.
 * @property {(msg: OrchToAgentMessage) => void} send
 * @property {(handler: (msg: AgentToOrchMessage) => void) => void} onMessage
 * @property {(handler: () => void) => void} onClose
 * @property {() => void} close
 */

/**
 * @param {string} path
 */
const tryUnlink = path => {
  try {
    unlinkSync(path);
  } catch {
    // ignore — ENOENT is fine, anything else surfaces on listen()
  }
};

/**
 * Open a long-lived JSON-RPC link to the per-session runtime agent.
 *
 * Returns synchronously with three handles:
 *   - `ready`: resolves when the UDS is bound and accepting connections.
 *   - `link`: resolves with the AgentLink once the guest agent connects.
 *   - `stop()`: tear down the listening server before any guest has
 *     connected. Useful when `markReady` aborts mid-boot — the
 *     pre-connection server otherwise leaks until the next link
 *     consumer arrives. After a successful guest connection,
 *     `link.close()` is the right teardown handle.
 *
 * @param {{ agentSocketPath: string }} opts
 * @returns {{ ready: Promise<void>, link: Promise<AgentLink>, stop: () => void }}
 */
export const makeAgentLink = ({ agentSocketPath }) => {
  const linkKit = makePromiseKit();
  const readyKit = makePromiseKit();

  const server = net.createServer({ allowHalfOpen: false });
  /** @type {net.Socket | null} */
  let conn = null;
  /** @type {((msg: AgentToOrchMessage) => void)[]} */
  const messageHandlers = [];
  /** @type {(() => void)[]} */
  const closeHandlers = [];
  const agentReadyKit = makePromiseKit();

  // Server-level errors (bind failure, accept failure during startup, etc.)
  // must reject *both* settlement promises and close the server. Otherwise
  // `readyKit` stays pending and any caller awaiting `ready` deadlocks
  // (e.g. `markReady` awaits `agentPromise.ready` after spawning QEMU).
  server.once('error', err => {
    readyKit.reject(err);
    linkKit.reject(err);
    server.close(() => tryUnlink(agentSocketPath));
  });

  server.once('connection', socket => {
    conn = socket;
    socket.on('error', () => {
      // Peer (guest agent) may RST on teardown; suppress.
    });
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.length > 0) {
          try {
            const msg = /** @type {AgentToOrchMessage} */ (JSON.parse(line));
            if (msg.type === 'ready') agentReadyKit.resolve(undefined);
            for (const h of messageHandlers) h(msg);
          } catch (_e) {
            // Malformed line; ignore. Agent is untrusted so we don't crash.
          }
        }
      }
    });
    socket.once('close', () => {
      conn = null;
      for (const h of closeHandlers) h();
    });

    /** @type {AgentLink} */
    const link = harden({
      ready: () => agentReadyKit.promise,
      send: msg => {
        if (!conn) return;
        conn.write(`${JSON.stringify(msg)}\n`);
      },
      onMessage: handler => {
        messageHandlers.push(handler);
      },
      onClose: handler => {
        closeHandlers.push(handler);
      },
      close: () => {
        if (conn) conn.end();
        server.close();
      },
    });
    linkKit.resolve(link);
  });

  // Unlink any stale UDS left from a prior boot attempt that
  // crashed before close could unlink it, so a retry binds cleanly.
  tryUnlink(agentSocketPath);
  server.listen(agentSocketPath, () => readyKit.resolve(undefined));

  /**
   * Tear down the listening server *before* a guest connects.
   * Idempotent — safe to call after a successful `link.close()`.
   * Rejects the `link` promise if it hasn't resolved yet so callers
   * awaiting `agentPromise.link` don't deadlock.
   */
  const stop = () => {
    try {
      server.close(() => tryUnlink(agentSocketPath));
    } catch {
      // ignore — already closed
    }
    // If no guest ever connected, the link promise is still pending.
    // Reject it so any awaiter unblocks; resolved consumers see no
    // change (promise-kit resolve is one-shot).
    linkKit.reject(new Error('makeAgentLink.stop() before guest connect'));
  };

  return harden({
    ready: /** @type {Promise<void>} */ (readyKit.promise),
    link: /** @type {Promise<AgentLink>} */ (linkKit.promise),
    stop,
  });
};
harden(makeAgentLink);
