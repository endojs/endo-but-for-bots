// @ts-check
/** @import { HttpListenerPowers, HttpRequest, HttpRequestDescription } from '../platform/http-listeners.js' */
/** @import { Logger } from '../platform/logging.js' */
import { Fail, q } from '@endo/errors';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

import { makeInFlight } from '../in-flight.js';

const BODY_LIMIT = 64 * 1024;
const HEADER_LIMIT = 16 * 1024;
const MAX_REQUESTS = 16;
const DEADLINE_MS = 5000;

/**
 * SKETCH — see designs/manual-persistence-vats.md. Not wired into the
 * supervisor, and the eager pin it depends on does not exist yet.
 *
 * The host half of an HTTP service whose desired state lives in a guest vat.
 *
 * Everything here is ephemeral, deliberately: no metadata file, no recipes, no
 * lifecycle, nothing to restore. A host incarnation that starts knowing
 * nothing is correct, because the vat that wanted the listener is the thing
 * that remembers, and it re-establishes on wake. Compare `http-services.js`,
 * which carries all of that because the recipes are on this side.
 *
 * The handler is an ordinary guest reference passed in by the vat. This
 * process holds it only for its own lifetime; it is never persisted and never
 * published under a secret, because there is no restart in which this side
 * would have to find it again.
 *
 * Two things stay here that could look like they belong in the vat:
 *
 * - **Admission.** The origin check runs before any body is read, so a denied
 *   request costs no guest work at all. Moving it into the vat would mean
 *   waking a vat to say no, which is a denial-of-service lever. The vat
 *   declares the authority; this side enforces it.
 * - **Transport limits.** Body, header and request caps have to be applied
 *   while the bytes are arriving.
 *
 * @param {{ httpListeners: HttpListenerPowers, logging: Logger }} powers
 */
export const makeHostListeners = ({ httpListeners, logging }) => {
  const log = logging.sub('thixotrope', 'http');

  /**
   * @typedef {object} Binding
   * @property {number} port
   * @property {bigint} generation
   * @property {any} handler
   * @property {import('../platform/http-listeners.js').HttpListener} listener
   */

  /** @type {Map<number, Binding>} */
  const bound = new Map();
  const requests = makeInFlight();
  let generations = 0n;
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
   * One request, delivered straight to the guest handler.
   *
   * The result is an ordinary answer, and an answer aborting when this process
   * dies is the behaviour we want: an in-flight request whose host is gone has
   * failed, and must not be resumed against a later incarnation. That is the
   * opposite of an alarm, and the reason this service needs nothing like the
   * restorable promise those use.
   *
   * @param {Binding} binding
   * @param {HttpRequest} request
   */
  const serve = async (binding, request) => {
    const result = await E(binding.handler).handle(
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
  };

  /**
   * The capability a vat is granted. Holding it is authority to occupy a
   * loopback port; the user grants it by inventory key, as with any resource.
   */
  const facet = () =>
    Far('HttpListeners', {
      help: () =>
        'listen({port, handler}) binds a loopback port to a guest handler for this host lifetime and returns {binding}; binding.close() releases it; binding.status() reports it. Re-call listen after a host restart.',

      /**
       * Idempotent within a host lifetime: asked twice for the same port and
       * the same handler, the second call returns the standing binding rather
       * than rebinding. That is what lets a vat reconcile unconditionally on
       * wake without checking whether this process is new.
       *
       * @param {{ port: number, handler: any }} options
       */
      listen: async ({ port, handler }) => {
        !stopped || Fail`HTTP listeners are shut down`;
        (Number.isInteger(port) && port > 0 && port < 65_536) ||
          Fail`Expected a port number, got ${q(port)}`;
        (handler && handler[Symbol.for('passStyle')] === 'remotable') ||
          Fail`Expected a remotable HTTP handler`;

        const standing = bound.get(port);
        if (standing !== undefined) {
          standing.handler === handler ||
            Fail`Port ${q(port)} is already bound to another handler`;
          return harden({ binding: bindingFacet(standing) });
        }

        generations += 1n;
        const generation = generations;
        /** @type {Binding} */
        const binding = /** @type {any} */ ({ port, generation, handler });
        binding.listener = await httpListeners.listen({
          port,
          host: '127.0.0.1',
          maxBodyBytes: BODY_LIMIT,
          maxResponseBytes: BODY_LIMIT,
          maxHeaderBytes: HEADER_LIMIT,
          maxRequests: MAX_REQUESTS,
          requestDeadlineMs: DEADLINE_MS,
          keepAliveTimeoutMs: 1,
          admit: request => admit(port, request),
          handle: request => requests.track(serve(binding, request)),
          onError: error => log.error('listener failed:', error),
        });
        bound.set(port, binding);
        return harden({ binding: bindingFacet(binding) });
      },

      /** Ports this process currently occupies. Reporting only. */
      list: () =>
        harden(
          [...bound.values()].map(({ port, generation }) =>
            harden({ port, generation, url: `http://127.0.0.1:${port}/` }),
          ),
        ),
    });

  /**
   * A handle to one binding, carrying the generation it was issued for.
   *
   * A vat's heap outlives this process, so it will still be holding handles
   * from incarnations that are gone — and after a rebind, a port it knows may
   * be occupied by a binding it never asked for. Checking the generation is
   * what stops a stale `close` from releasing its own replacement.
   *
   * @param {Binding} binding
   */
  const bindingFacet = binding =>
    Far('HttpBinding', {
      /** @returns {Promise<boolean>} whether this call released the port */
      close: async () => {
        const standing = bound.get(binding.port);
        if (
          standing === undefined ||
          standing.generation !== binding.generation
        )
          return false;
        bound.delete(binding.port);
        await standing.listener.close();
        return true;
      },
      status: () => {
        const standing = bound.get(binding.port);
        return harden({
          port: binding.port,
          generation: binding.generation,
          current: standing?.generation === binding.generation,
          url: `http://127.0.0.1:${binding.port}/`,
        });
      },
    });

  return harden({
    facet,
    status: () => harden({ bound: BigInt(bound.size), stopped }),
    shutdown: async () => {
      stopped = true;
      const listeners = [...bound.values()];
      bound.clear();
      await Promise.all(listeners.map(({ listener }) => listener.close()));
      await requests.drain();
    },
  });
};
harden(makeHostListeners);
