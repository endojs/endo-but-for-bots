// @ts-check
/* global setTimeout */
/**
 * @import { Credentials } from '../../protocol.types.js'
 */

import net from 'node:net';

import { makePromiseKit } from '@endo/promise-kit';

/**
 * Subscription handle returned by `subscribe(sessionId)`.
 *
 * `initial` — Credentials the broker sent in its first reply.
 *   Use these for BootConfig.
 * `onRotate(handler)` — register a callback for every subsequent
 *   credentials push. Handlers receive each fresh `Credentials`
 *   payload as the broker rotates.
 * `onError(handler)` — register a callback for broker error events
 *   on this subscription (e.g. IdP refresh failures).
 * `close()` — send unsubscribe + close the underlying UDS socket.
 *   Idempotent.
 *
 * @typedef {object} CredentialSubscription
 * @property {Credentials} initial
 * @property {(handler: (creds: Credentials) => void) => void} onRotate
 * @property {(handler: (message: string) => void) => void} onError
 * @property {() => Promise<void>} close
 */

/**
 * Open a per-session subscription to the broker. Resolves once the
 * broker has delivered the initial credentials; subsequent
 * rotations arrive via `onRotate`.
 *
 * @param {string} socketPath
 * @param {string} sessionId
 * @returns {Promise<CredentialSubscription>}
 */
const subscribe = (socketPath, sessionId) => {
  const initialKit = makePromiseKit();
  /** @type {((creds: Credentials) => void)[]} */
  const rotateHandlers = [];
  /** @type {((message: string) => void)[]} */
  const errorHandlers = [];

  const conn = net.createConnection(socketPath);
  let buf = '';
  let receivedInitial = false;
  let closed = false;

  conn.once('error', e => {
    if (!receivedInitial) initialKit.reject(e);
    for (const h of errorHandlers) h(/** @type {Error} */ (e).message);
  });
  conn.once('close', () => {
    if (!receivedInitial) {
      initialKit.reject(
        new Error('broker connection closed before initial credentials'),
      );
    }
    closed = true;
  });
  conn.on('data', chunk => {
    buf += chunk.toString('utf8');
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Broker shouldn't emit non-JSON; if it does, treat as
        // protocol violation and stop.
        if (!receivedInitial) {
          initialKit.reject(new Error(`broker emitted non-JSON: ${line}`));
        }
        conn.destroy();
        return;
      }
      if (msg.type === 'creds' && msg.credentials) {
        if (!receivedInitial) {
          receivedInitial = true;
          initialKit.resolve(msg.credentials);
        } else {
          for (const h of rotateHandlers) h(msg.credentials);
        }
      } else if (msg.type === 'error') {
        if (!receivedInitial) {
          initialKit.reject(new Error(msg.message ?? 'broker error'));
          conn.destroy();
          return;
        }
        for (const h of errorHandlers) h(msg.message ?? 'broker error');
      }
    }
  });

  conn.write(`${JSON.stringify({ type: 'subscribe', sessionId })}\n`);

  return /** @type {Promise<Credentials>} */ (initialKit.promise).then(
    initial =>
      harden({
        initial,
        onRotate(h) {
          rotateHandlers.push(h);
        },
        onError(h) {
          errorHandlers.push(h);
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            conn.write(
              `${JSON.stringify({ type: 'unsubscribe', sessionId })}\n`,
            );
          } catch {
            // socket already gone
          }
          await new Promise(resolve => {
            conn.once('close', resolve);
            conn.end();
            // Belt and suspenders: ensure we move on even if close
            // doesn't fire quickly.
            setTimeout(() => resolve(undefined), 50);
          });
        },
      }),
  );
};

/**
 * @param {{ socketPath: string }} opts
 */
export const makeBrokerClient = ({ socketPath }) => {
  return harden({
    /**
     * @param {string} sessionId
     * @returns {Promise<CredentialSubscription>}
     */
    subscribe(sessionId) {
      return subscribe(socketPath, sessionId);
    },
  });
};
harden(makeBrokerClient);
