// @ts-check
/**
 * The page's connection to the gateway (m3-interfaces.md 9.2; R6-11..R6-14,
 * D-17). One WebSocket at a time, CapTP over binary frames of UTF-8 JSON,
 * `E(bootstrap).fetch(agent)` once per socket; on a close the overlay state
 * and a retry on the R6-14 schedule (0, 1, 2, 5, 10, 30 s, then every 30 s,
 * reset after a connection whose `fetch` succeeded). A socket that never
 * opened means nothing listens: "Server starting..." (D-17). A rejected
 * `fetch` stops retrying and shows its text.
 */
import { makeCapTP as defaultMakeCapTP } from '@endo/captp';
import { E } from '@endo/far';

import {
  connectDeadlineMs,
  reconnectDelaysMs,
} from '../../../resources/agent-host/impl/gateway/protocol.js';

/**
 * @typedef {'connecting' | 'open' | 'reconnecting' | 'starting' | 'refused'} ConnectionState
 */

/**
 * @typedef {object} ConnectionTimers
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * The delay before retry number `attempt` (0-based) after a lost or failed
 * connection.
 *
 * @param {number} attempt
 */
export const reconnectDelay = attempt =>
  reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)];

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {object} options
 * @param {string} options.url the WebSocket URL (`socketUrl`)
 * @param {string} options.agent the sign-in secret from the fragment
 * @param {any} options.WebSocket the WebSocket constructor
 * @param {ConnectionTimers} options.timers
 * @param {(state: ConnectionState, detail?: { powers?: any, message?: string }) => void} options.onState
 *   called on every state change; `open` carries the new connection's
 *   `GatewayPowers`, `refused` the rejection's text
 * @param {typeof defaultMakeCapTP} [options.makeCapTP]
 * @param {number} [options.deadlineMs] open + `fetch` deadline
 */
export const makeConnection = ({
  url,
  agent,
  WebSocket,
  timers,
  onState,
  makeCapTP = defaultMakeCapTP,
  deadlineMs = connectDeadlineMs,
}) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let attempt = 0;
  let stopped = false;
  let generation = 0;
  /** @type {any} */
  let retryTimer;
  /** @type {ConnectionState} */
  let state = 'connecting';
  /** @type {any} */
  let currentPowers;
  /** @type {string | undefined} */
  let refusal;
  /** @type {Array<{ resolve: (powers: any) => void, reject: (error: Error) => void }>} */
  let waiters = [];
  /** @type {any} */
  let socket;

  /**
   * @param {ConnectionState} next
   * @param {{ powers?: any, message?: string }} [detail]
   */
  const setState = (next, detail) => {
    state = next;
    onState(next, detail);
  };

  const settleWaiters = () => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      if (refusal !== undefined) waiter.reject(Error(refusal));
      else waiter.resolve(currentPowers);
    }
  };

  const scheduleRetry = () => {
    if (stopped) return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      // eslint-disable-next-line no-use-before-define
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    generation += 1;
    const mine = generation;
    let opened = false;
    let failed = false;
    /** @type {any} */
    let capTP;
    const ws = new WebSocket(url);
    socket = ws;
    ws.binaryType = 'arraybuffer';

    const deadline = timers.setTimeout(() => {
      if (mine !== generation || failed) return;
      // Neither open nor signed in in time: drop it; the close retries.
      try {
        ws.close(4000, 'deadline');
      } catch {
        // already closing
      }
      // A socket that never opens may never fire close either.
      // eslint-disable-next-line no-use-before-define
      lost();
    }, deadlineMs);

    const lost = () => {
      if (failed) return;
      failed = true;
      timers.clearTimeout(deadline);
      if (capTP) capTP.abort(Error('connection closed'));
      if (mine !== generation || stopped || refusal !== undefined) return;
      currentPowers = undefined;
      setState(opened ? 'reconnecting' : 'starting');
      scheduleRetry();
    };

    ws.onopen = () => {
      if (mine !== generation) return;
      opened = true;
      capTP = makeCapTP(
        'familiar',
        /** @param {Record<string, any>} message */
        message => {
          if (ws.readyState === 1) {
            ws.send(encoder.encode(JSON.stringify(message)));
          }
        },
        undefined,
        { gcImports: true },
      );
      const bootstrap = capTP.getBootstrap();
      E(bootstrap)
        .fetch(agent)
        .then(
          /** @param {any} powers */
          powers => {
            if (mine !== generation || failed || stopped) return;
            timers.clearTimeout(deadline);
            attempt = 0;
            currentPowers = powers;
            setState('open', { powers });
            settleWaiters();
          },
          /** @param {unknown} error */
          error => {
            if (mine !== generation || failed || stopped) return;
            if (ws.readyState !== 1) return; // the close handles it
            timers.clearTimeout(deadline);
            refusal = messageOf(error);
            setState('refused', { message: refusal });
            settleWaiters();
            failed = true;
            try {
              ws.close(1000, 'refused');
            } catch {
              // already closing
            }
          },
        );
    };
    /** @param {{ data: any }} event */
    ws.onmessage = event => {
      if (mine !== generation || !capTP) return;
      const { data } = event;
      const text =
        typeof data === 'string' ? data : decoder.decode(new Uint8Array(data));
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        ws.close(4002, 'protocol');
        return;
      }
      capTP.dispatch(message);
    };
    ws.onclose = lost;
    ws.onerror = () => {
      // A close event follows; a socket that never opened may only error.
      if (!opened) lost();
    };
  };

  setState('connecting');
  connect();

  return harden({
    /**
     * The current connection's `GatewayPowers`, or those of the next one to
     * sign in; rejects once a `fetch` was refused.
     *
     * @returns {Promise<any>}
     */
    powers: () => {
      if (refusal !== undefined) return Promise.reject(Error(refusal));
      if (state === 'open' && currentPowers)
        return Promise.resolve(currentPowers);
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    /** The current state. */
    state: () => state,
    /** Stop: close the socket, cancel any retry. Pages never need it. */
    close: () => {
      stopped = true;
      generation += 1;
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
      if (socket) {
        try {
          socket.close(1000, 'closed');
        } catch {
          // already closing
        }
      }
    },
  });
};
