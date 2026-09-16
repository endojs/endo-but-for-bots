// @ts-check
/** @import { HttpListenerPowers } from '../platform/http-listeners.js' */
/** @import { Logger } from '../platform/logging.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import { Fail, q } from '@endo/errors';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

import { makeInFlight } from '../in-flight.js';

// Ceilings, not policy. A guest may ask for less; it may not ask for more,
// because these are enforced while bytes are arriving and nothing on the guest
// side is in a position to do that.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_REQUESTS = 16;
const MAX_DEADLINE_MS = 30_000;

/**
 * @param {unknown} value @param {number} ceiling @param {number} fallback
 * @param ceiling
 * @param fallback
 */
const clamp = (value, ceiling, fallback) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, ceiling)
    : fallback;

/**
 * Authority to listen on one loopback port, granted to a guest.
 *
 * This is the whole of the host's involvement in HTTP. It opens the socket,
 * enforces the byte and time ceilings that can only be enforced while bytes
 * are arriving, and forwards both decisions — who is admitted, and what the
 * answer is — to the guest that holds it. No origin policy, no routing, no
 * knowledge of what is being served: those moved to the adapter vat, where a
 * user can change them.
 *
 * Granted by description, so `makeResource('http-port', { port })` is authority
 * over that port and nothing else. Being a resource, a guest's reference to it
 * is re-seated by the endpoint after a host restart rather than breaking, which
 * is what lets a durable manager go on holding it across incarnations.
 *
 * @param {{ httpListeners: HttpListenerPowers, logging: Logger, timers: TimerPowers }} powers
 */
export const makeHttpPorts = ({ httpListeners, logging, timers }) => {
  const log = logging.sub('thixotrope', 'http');

  /** @type {Map<number, {guest: any, listener: any}>} */
  const bound = new Map();
  const requests = makeInFlight();
  let stopped = false;

  /**
   * Release a port whose serving vat has gone.
   *
   * The adapter is ephemeral, so its death is expected rather than
   * exceptional — but the socket is on this side, and would otherwise stay open
   * in front of a guest that can never answer. A failed call is the first
   * evidence the host has, so it is where the check belongs.
   *
   * @param {number} port
   * @param {any} guest
   */
  const releaseIfGone = async (port, guest) => {
    try {
      // eslint-disable-next-line no-underscore-dangle
      await E(guest).__getMethodNames__();
      return false;
    } catch (_error) {
      const standing = bound.get(port);
      if (standing === undefined || standing.guest !== guest) return false;
      // Bookkeeping now, socket on the next turn. Closing a listener destroys
      // every socket on it, including the one still waiting for the answer
      // this request is about to return.
      bound.delete(port);
      log.info('releasing port', port, 'whose guest vat is gone');
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
        'listen(guest, limits?) binds this port and returns {binding}; the guest must answer admit({method,path,headers}) with {allowed} and handle({method,path,body}) with {status,body}. binding.close() releases the port.',
      getPort: () => port,

      /**
       * @param {any} guest answers `admit` and `handle`
       * @param {{maxBodyBytes?: number, maxRequests?: number, requestDeadlineMs?: number}} [limits]
       */
      listen: async (guest, limits = {}) => {
        !stopped || Fail`HTTP ports are shut down`;
        (guest && guest[Symbol.for('passStyle')] === 'remotable') ||
          Fail`Expected a remotable listener guest`;
        bound.has(port) === false || Fail`Port ${q(port)} is already bound`;

        const maxBodyBytes = clamp(
          limits.maxBodyBytes,
          MAX_BODY_BYTES,
          MAX_BODY_BYTES,
        );
        const entry = /** @type {any} */ ({ guest });
        entry.listener = await httpListeners.listen({
          port,
          host: '127.0.0.1',
          maxBodyBytes,
          maxResponseBytes: maxBodyBytes,
          maxHeaderBytes: MAX_HEADER_BYTES,
          maxRequests: clamp(limits.maxRequests, MAX_REQUESTS, MAX_REQUESTS),
          requestDeadlineMs: clamp(
            limits.requestDeadlineMs,
            MAX_DEADLINE_MS,
            5000,
          ),
          keepAliveTimeoutMs: 1,
          // Both decisions are the guest's. Admission reaches it before any
          // body is read, so refusing costs whoever the request was aimed at
          // nothing — the adapter answers, not the consumer behind it.
          admit: async request => {
            try {
              return await E(guest).admit(request);
            } catch (error) {
              if (await releaseIfGone(port, guest))
                return harden({
                  allowed: false,
                  status: 503,
                  body: 'Service is no longer available',
                });
              throw error;
            }
          },
          handle: request =>
            requests.track(
              (async () => {
                try {
                  return await E(guest).handle(request);
                } catch (error) {
                  if (await releaseIfGone(port, guest))
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
