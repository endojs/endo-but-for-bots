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
  // Events that arrive between the initial-creds resolve and the
  // caller's `.then(sub => sub.onRotate(...))` running get buffered
  // here. The caller's `.then` runs as a microtask after the broker's
  // initial reply lands, but `conn.on('data', ...)` can fire again
  // for a follow-up rotation before that microtask resolves — so
  // without buffering, the rotation would dispatch into an empty
  // `rotateHandlers` array and be silently dropped. Same for errors.
  // The first `onRotate` / `onError` call drains its buffer to the
  // newly-registered handler synchronously.
  /** @type {Credentials[]} */
  const pendingRotations = [];
  /** @type {string[]} */
  const pendingErrors = [];

  const conn = net.createConnection(socketPath);
  let buf = '';
  let receivedInitial = false;
  let closed = false;

  const dispatchRotation = (/** @type {Credentials} */ creds) => {
    if (rotateHandlers.length === 0) {
      pendingRotations.push(creds);
      return;
    }
    for (const h of rotateHandlers) h(creds);
  };
  const dispatchError = (/** @type {string} */ msg) => {
    if (errorHandlers.length === 0) {
      pendingErrors.push(msg);
      return;
    }
    for (const h of errorHandlers) h(msg);
  };

  conn.once('error', e => {
    if (!receivedInitial) initialKit.reject(e);
    dispatchError(/** @type {Error} */ (e).message);
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
          dispatchRotation(msg.credentials);
        }
      } else if (msg.type === 'error') {
        if (!receivedInitial) {
          initialKit.reject(new Error(msg.message ?? 'broker error'));
          conn.destroy();
          return;
        }
        dispatchError(msg.message ?? 'broker error');
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
          // Drain any rotations that arrived between initial and now.
          while (pendingRotations.length > 0) {
            const c = /** @type {Credentials} */ (pendingRotations.shift());
            h(c);
          }
        },
        onError(h) {
          errorHandlers.push(h);
          while (pendingErrors.length > 0) {
            const m = /** @type {string} */ (pendingErrors.shift());
            h(m);
          }
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
            // doesn't fire quickly. unref so a pending 50 ms timer
            // doesn't keep the orchestrator process alive past the
            // last awaiter when the subscription is the only thing
            // left running.
            setTimeout(() => resolve(undefined), 50).unref();
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
