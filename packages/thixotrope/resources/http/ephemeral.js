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
  /** @type {Map<number, {consumer: any, listener: any}>} */
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
    const authority = `127.0.0.1:${port}`;
    const allowed = origins.length === 0 ? [`http://${authority}`] : origins;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      request.headers.host !== authority ||
      (origin !== undefined && !allowed.includes(origin)) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      return harden({
        allowed: /** @type {const} */ (false),
        status: 403,
        body: 'Request origin is not permitted',
      });
    }
    return harden({ allowed: /** @type {const} */ (true) });
  };

  /**
   * @param {number} port
   * @param {any} consumer
   * @param {{origins?: string[]}} policy
   */
  const bind = async (port, consumer, policy) => {
    const standing = routes.get(port);
    if (standing) {
      if (standing.consumer !== consumer)
        throw Error('Port is already registered');
      return port;
    }
    const origins = harden([...(policy.origins ?? [])]);
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
    routes.set(port, { consumer, listener });
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
