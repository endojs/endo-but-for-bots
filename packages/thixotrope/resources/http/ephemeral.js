// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';
import * as http from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

import { makeAdapter } from '../../native-adapter.js';
import { makeHttpListenerPowers } from './listener.js';

/** @import { HttpRegistrationSpec } from './durable.js' */

/**
 * Native HTTP state belongs entirely to this disposable process: the adapter
 * kit keeps the bindings, this module binds and unbinds a listener.
 */
export const make = () => {
  const { listen } = makeHttpListenerPowers({
    http,
    setTimeout,
    clearTimeout: handle =>
      clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
  });
  /**
   * @param {number} port
   * @param {string[]} origins
   * @param {any} request
   */
  const admitRequest = (port, origins, request) => {
    // Loopback answers to both of its spellings; a browser at either one is
    // same-origin with itself, so both are allowed unless a policy says
    // otherwise.
    const authorities = [`127.0.0.1:${port}`, `localhost:${port}`];
    const allowed =
      origins.length === 0
        ? authorities.map(authority => `http://${authority}`)
        : origins;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    /** @param {string} body */
    const refuse = body =>
      harden({ allowed: /** @type {const} */ (false), status: 403, body });
    if (!authorities.includes(request.headers.host))
      return refuse('Request host is not this listener');
    if (origin !== undefined && !allowed.includes(origin))
      return refuse('Request origin is not permitted');
    if (site !== undefined && site !== 'same-origin' && site !== 'none')
      return refuse('Cross-site requests are not permitted');
    return harden({ allowed: /** @type {const} */ (true) });
  };
  /**
   * The manager sends origins sorted; sorting again here costs nothing and
   * keeps this side right about the set on its own.
   * @param {HttpRegistrationSpec} spec
   */
  const originsOf = spec => harden([...(spec.policy?.origins ?? [])].sort());
  /**
   * @param {HttpRegistrationSpec} a
   * @param {HttpRegistrationSpec} b
   */
  const sameOrigins = (a, b) => {
    const existing = originsOf(a);
    const wanted = originsOf(b);
    return (
      existing.length === wanted.length &&
      existing.every((origin, index) => origin === wanted[index])
    );
  };
  return makeAdapter({
    label: 'Port',
    /**
     * @param {HttpRegistrationSpec} existing
     * @param {HttpRegistrationSpec} wanted
     */
    same: (existing, wanted) =>
      existing.handler === wanted.handler && sameOrigins(existing, wanted),
    // Same consumer, new policy: the listener closes over its origins, so it
    // is replaced rather than edited.
    /**
     * @param {HttpRegistrationSpec} existing
     * @param {HttpRegistrationSpec} wanted
     */
    replaces: (existing, wanted) => existing.handler === wanted.handler,
    /**
     * @param {unknown} port
     * @param {HttpRegistrationSpec} spec
     */
    bind: (port, spec) => {
      if (typeof port !== 'number') throw Error('Expected a port');
      const { handler } = spec;
      const origins = originsOf(spec);
      return listen({
        port,
        host: '127.0.0.1',
        maxBodyBytes: 64 * 1024,
        maxResponseBytes: 64 * 1024,
        maxHeaderBytes: 16 * 1024,
        maxRequests: 16,
        requestDeadlineMs: 5000,
        keepAliveTimeoutMs: 1,
        admit: request => admitRequest(port, origins, request),
        handle: ({ method, path, body }) =>
          E(handler).handle(harden({ method, path, body })),
        onError: error => console.error('HTTP listener failed:', error),
      });
    },
    /** @param {{ close: () => Promise<unknown> }} listener */
    unbind: listener => listener.close(),
  });
};
harden(make);
