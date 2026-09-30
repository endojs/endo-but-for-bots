// @ts-check

import http from 'node:http';
import https from 'node:https';

/**
 * The slice of a fetch `Response` the registry reads from an upstream.
 *
 * @typedef {object} UpstreamResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {{ get: (name: string) => string | null }} headers
 * @property {AsyncIterable<Uint8Array> & { destroy?: () => void } | null} body
 */

/**
 * @typedef {(url: string, init?: {
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 *   redirect?: 'error',
 * }) => Promise<UpstreamResponse>} UpstreamFetch
 */

/**
 * A minimal GET-only fetch over `node:http`/`node:https`. The server runs
 * under SES lockdown, where Node's built-in `fetch` (undici) raises
 * unhandled override-mistake rejections when pooled connections are
 * destroyed; this adapter keeps the upstream path on the core HTTP client.
 * Redirects are never followed: a 3xx is returned as a non-ok status.
 *
 * @returns {UpstreamFetch}
 */
export const makeNodeFetch = () => {
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
  };
  return harden(
    (url, { headers = {}, signal } = {}) =>
      new Promise((resolve, reject) => {
        const target = new URL(url);
        const protocol = /** @type {'http:' | 'https:'} */ (target.protocol);
        const client = protocol === 'https:' ? https : http;
        if (!(protocol in agents)) {
          reject(Error(`Unsupported upstream protocol ${target.protocol}`));
          return;
        }
        const request = client.request(
          target,
          { method: 'GET', headers, agent: agents[protocol], signal },
          response => {
            const status = response.statusCode ?? 0;
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: {
                get: name => {
                  const value = response.headers[name.toLowerCase()];
                  if (value === undefined) return null;
                  return Array.isArray(value) ? value.join(', ') : value;
                },
              },
              body: {
                // After the headers arrive, an aborting signal destroys the
                // socket and the body fails with a plain ECONNRESET; surface
                // the signal's own TimeoutError instead, as in the request
                // phase below.
                async *[Symbol.asyncIterator]() {
                  try {
                    yield* response;
                  } catch (error) {
                    throw signal?.aborted ? signal.reason : error;
                  }
                },
                destroy: () => response.destroy(),
              },
            });
          },
        );
        request.on('error', error => {
          // Surface a timeout as the signal's own TimeoutError.
          reject(signal?.aborted ? signal.reason : error);
        });
        request.end();
      }),
  );
};
harden(makeNodeFetch);
