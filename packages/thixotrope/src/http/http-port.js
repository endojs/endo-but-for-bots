// @ts-check
/** @import { HttpListenerPowers, HttpRequestDescription } from '../platform/http-listeners.js' */
/** @import { Logger } from '../platform/logging.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import { Fail, q } from '@endo/errors';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

import { makeInFlight } from '../in-flight.js';

const BODY_LIMIT = 64 * 1024;
const HEADER_LIMIT = 16 * 1024;
const MAX_REQUESTS = 16;
const DEADLINE_MS = 5000;

/**
 * SKETCH — see designs/manual-persistence-vats.md.
 *
 * Authority over one loopback port, as a host resource.
 *
 * Granted by description, so `makeResource('http-port', { port })` is authority
 * over that port and nothing else, and — being a resource — a guest's reference
 * to it is re-seated by the endpoint after a host restart rather than breaking.
 * That is what lets the durable manager keep holding it.
 *
 * Two things stay on this side because they cannot move:
 *
 * - **Admission.** `HttpListenerPowers.admit` is synchronous, so it cannot be a
 *   guest callback at all — the host has no way to await a vat mid-header. That
 *   it also runs before any body is read, and so lets a denied request cost no
 *   guest work, is a second reason rather than the deciding one.
 * - **Transport limits.** Body, header and request caps apply while bytes are
 *   arriving.
 *
 * Everything else — which ports are currently served, and by whom — belongs to
 * the ephemeral adapter vat, which is why nothing here is written down.
 *
 * @param {{ httpListeners: HttpListenerPowers, logging: Logger, timers: TimerPowers }} powers
 */
export const makeHttpPorts = ({ httpListeners, logging, timers }) => {
  const log = logging.sub('thixotrope', 'http');

  /** @type {Map<number, {handler: any, listener: any}>} */
  const bound = new Map();
  const requests = makeInFlight();
  let stopped = false;

  /**
   * @param {number} port
   * @param {HttpRequestDescription} request
   */
  const admit = (port, request) => {
    const authority = `127.0.0.1:${port}`;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      request.headers.host !== authority ||
      (origin !== undefined && origin !== `http://${authority}`) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      return /** @type {const} */ ({
        allowed: false,
        status: 403,
        body: 'Request origin is not permitted',
      });
    }
    return /** @type {const} */ ({ allowed: true });
  };

  /**
   * Release a port whose serving vat has gone.
   *
   * The adapter is ephemeral, so its retirement is expected, not exceptional —
   * but the socket is on this side and would otherwise stay open in front of a
   * handler that can never answer. A failed request is the first evidence the
   * host has, so it is where the check belongs.
   *
   * @param {number} port
   * @param {any} handler
   */
  const releaseIfGone = async (port, handler) => {
    try {
      // eslint-disable-next-line no-underscore-dangle
      await E(handler).__getMethodNames__();
      return false;
    } catch (_error) {
      const standing = bound.get(port);
      if (standing === undefined || standing.handler !== handler) return false;
      // Bookkeeping now, socket on the next turn. Closing a listener destroys
      // every socket on it, including the one still waiting for the answer
      // this request is about to return.
      bound.delete(port);
      log.info('releasing port', port, 'whose handler vat is gone');
      timers.setTimer(() => {
        void standing.listener
          .close()
          .catch(error => log.error('release failed:', error));
      }, 0);
      return true;
    }
  };

  /**
   * @param {unknown} description
   * @returns {object}
   */
  const resource = description => {
    const port = /** @type {number} */ (/** @type {any} */ (description)?.port);
    (Number.isInteger(port) && port > 0 && port < 65_536) ||
      Fail`Invalid HTTP port description ${q(description)}`;

    return Far('HttpPort', {
      help: () =>
        'listen(handler) binds this port for the host process lifetime and returns {binding}; binding.close() releases it. handler.handle({method,path,body}) must return {status,body}.',
      getPort: () => port,

      /** @param {any} handler */
      listen: async handler => {
        !stopped || Fail`HTTP ports are shut down`;
        (handler && handler[Symbol.for('passStyle')] === 'remotable') ||
          Fail`Expected a remotable handler`;
        const standing = bound.get(port);
        standing === undefined || Fail`Port ${q(port)} is already bound`;

        const entry = /** @type {any} */ ({ handler });
        entry.listener = await httpListeners.listen({
          port,
          host: '127.0.0.1',
          maxBodyBytes: BODY_LIMIT,
          maxResponseBytes: BODY_LIMIT,
          maxHeaderBytes: HEADER_LIMIT,
          maxRequests: MAX_REQUESTS,
          requestDeadlineMs: DEADLINE_MS,
          keepAliveTimeoutMs: 1,
          admit: request => admit(port, request),
          handle: request =>
            requests.track(
              (async () => {
                try {
                  const result = await E(handler).handle(
                    harden({
                      method: request.method,
                      path: request.path,
                      body: request.body,
                    }),
                  );
                  return harden({
                    status: /** @type {number} */ (result.status),
                    body: /** @type {string} */ (result.body),
                  });
                } catch (error) {
                  if (await releaseIfGone(port, handler))
                    return harden({
                      status: 503,
                      body: 'Service is no longer available',
                    });
                  throw error;
                }
              })(),
            ),
          onError: error => log.error('listener failed:', error),
        });
        bound.set(port, entry);

        return harden({
          binding: Far('HttpBinding', {
            close: async () => {
              const current = bound.get(port);
              if (current !== entry) return false;
              bound.delete(port);
              await entry.listener.close();
              return true;
            },
            getUrl: () => `http://127.0.0.1:${port}/`,
          }),
        });
      },
    });
  };

  return harden({
    resource,
    status: () => harden({ bound: BigInt(bound.size), stopped }),
    shutdown: async () => {
      stopped = true;
      const entries = [...bound.values()];
      bound.clear();
      await Promise.all(entries.map(({ listener }) => listener.close()));
      await requests.drain();
    },
  });
};
harden(makeHttpPorts);
