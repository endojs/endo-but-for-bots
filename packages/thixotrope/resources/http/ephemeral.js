// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import * as http from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

import { makeHttpListenerPowers } from './listener.js';

/** Native HTTP state belongs entirely to this disposable process. */
export const make = () => {
  const { listen } = makeHttpListenerPowers({
    http,
    setTimeout,
    clearTimeout: handle =>
      clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
  });
  /** @type {Map<number, {consumer: any, origins: string[], listener: any}>} */
  const routes = new Map();
  let chain = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const enqueue = operation => {
    const result = chain.then(operation);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
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
   * @param {number} port
   * @param {any} consumer
   * @param {{origins?: string[]}} policy
   */
  const bind = async (port, consumer, policy) => {
    const origins = harden([...(policy.origins ?? [])].sort());
    const standing = routes.get(port);
    if (standing) {
      if (standing.consumer !== consumer)
        throw Error('Port is already registered');
      const same =
        standing.origins.length === origins.length &&
        standing.origins.every((origin, index) => origin === origins[index]);
      if (same) return port;
      // Same consumer, new policy: the listener closes over its origins, so
      // it is replaced rather than edited.
      routes.delete(port);
      await standing.listener.close();
    }
    const listener = await listen({
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
        E(consumer).handle(harden({ method, path, body })),
      onError: error => console.error('HTTP listener failed:', error),
    });
    routes.set(port, { consumer, origins, listener });
    return port;
  };
  return Far('NativeHttpAdapter', {
    /**
     * @param {number} port
     * @param {any} consumer
     * @param {{origins?: string[]}} policy
     */
    bind: (port, consumer, policy) =>
      enqueue(() => bind(port, consumer, policy)),
    /** @param {number} port */
    unbind: port =>
      enqueue(async () => {
        const route = routes.get(port);
        if (!route) return false;
        await route.listener.close();
        routes.delete(port);
        return true;
      }),
    /** @param {Array<[number, any, {origins?: string[]}]>} entries */
    restore: entries =>
      enqueue(async () => {
        const results = [];
        for (const [port, consumer, policy] of entries) {
          // eslint-disable-next-line no-await-in-loop
          const result = await bind(port, consumer, policy).then(
            () => harden({ port }),
            error => harden({ port, error: String(error.message ?? error) }),
          );
          results.push(result);
        }
        return harden(results);
      }),
    ports: () => harden([...routes.keys()]),
  });
};
harden(make);
