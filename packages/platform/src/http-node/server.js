// @ts-check
/* global Buffer */

/**
 * @file Node backend for `@endo/platform/http/server`
 * (`@endo/platform/http/node`).
 *
 * Adapts `node:http` to the platform-agnostic {@link HttpBackend}
 * contract: it decodes each `IncomingMessage` into an
 * {@link HttpRequest}, calls the injected `dispatch`, and writes the
 * returned {@link HttpResponse} back over the `ServerResponse` —
 * streaming an async-iterable body with backpressure. It is the only
 * module in this seam that imports `node:http`, so a non-Node embedder
 * substitutes its own backend and the server core stays portable.
 *
 * `node:http` is injected rather than imported at top level so the
 * backend is testable with a fake and so a bundler can tree-shake it
 * out of a browser build.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/**
 * @import {
 *   HttpAddress,
 *   HttpBackend,
 *   HttpHandler,
 *   HttpRequest,
 * } from '../http/server.js'
 */

/**
 * Convert a chunk to the `Buffer` view `ServerResponse.write` expects
 * without copying the underlying bytes.
 *
 * @param {Uint8Array} chunk
 * @returns {Buffer}
 */
const toNodeBytes = chunk =>
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

/**
 * Recover the raw `[name, value]` header pairs from an
 * `IncomingMessage`. `rawHeaders` is a flat `[k0, v0, k1, v1, ...]`
 * array; pair it up preserving wire order and original case.
 *
 * @param {IncomingMessage} req
 * @returns {ReadonlyArray<readonly [string, string]>}
 */
const headerPairs = req => {
  /** @type {Array<readonly [string, string]>} */
  const pairs = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push(harden([raw[i], raw[i + 1]]));
  }
  return harden(pairs);
};

/**
 * Build a Node HTTP {@link HttpBackend}.
 *
 * @param {object} opts
 * @param {import('node:http')} opts.http  a `node:http`-shaped module
 *   exposing `createServer`.
 * @returns {HttpBackend}
 */
export const makeNodeHttpBackend = ({ http }) => {
  if (!http || typeof http.createServer !== 'function') {
    throw makeError(
      X`makeNodeHttpBackend requires an http power with createServer`,
    );
  }

  return ({ dispatch }) => {
    if (typeof dispatch !== 'function') {
      throw makeError(X`http backend requires a dispatch function`);
    }

    /** @type {import('node:http').Server | undefined} */
    let server;
    /** @type {Set<Promise<void>>} */
    const inflight = new Set();

    /**
     * Decode one request, dispatch it, and write the response. Owns
     * finalization: streams the body with backpressure and, if the
     * body iterator throws after headers are committed, destroys the
     * socket so the client sees a broken response rather than a body
     * that disagrees with the sent `Content-Length`.
     *
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     * @param {HttpHandler} handler
     */
    const serveOne = async (req, res, handler) => {
      // Establish an async boundary before the first real await so it
      // is not nested (satisfies @jessie.js/safe-await-separator).
      await null;
      /** @type {HttpRequest} */
      const request = harden({
        method: (req.method || 'GET').toUpperCase(),
        url: req.url || '/',
        headers: headerPairs(req),
      });
      const response = await handler(request);
      const { status, headers = [], body } = response;
      for (const [name, value] of headers) {
        res.setHeader(name, value);
      }
      res.writeHead(status);
      if (body === undefined) {
        res.end();
        return;
      }
      if (body instanceof Uint8Array) {
        res.end(toNodeBytes(body));
        return;
      }
      try {
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array)) {
            throw makeError(
              X`http response body yielded a non-Uint8Array chunk: ${q(typeof chunk)}`,
            );
          }
          // Skip zero-byte frames (some streams emit them at EOF); a
          // non-empty write that returns false means the socket buffer
          // is full, so await 'drain' before pulling the next chunk.
          if (chunk.byteLength > 0 && !res.write(toNodeBytes(chunk))) {
            await new Promise(resolve => res.once('drain', resolve));
          }
        }
        res.end();
      } catch (err) {
        // Headers are already committed; the cleanest signal to the
        // client is a connection drop.
        res.destroy(/** @type {Error} */ (err));
      }
    };

    const onRequest = (
      /** @type {IncomingMessage} */ req,
      /** @type {ServerResponse} */ res,
    ) => {
      const task = serveOne(req, res, dispatch).catch(err => {
        // A dispatch error (or a decode failure) before any bytes are
        // written becomes a 500; after that, abort.
        console.error(
          'platform/http: request failed',
          /** @type {Error} */ (err).message,
        );
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal error\n');
        } else {
          res.destroy();
        }
      });
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    };

    /** @type {(address: HttpAddress) => Promise<HttpAddress>} */
    const listen = address =>
      new Promise((resolve, reject) => {
        const host = address.host ?? '127.0.0.1';
        const port = address.port ?? 0;
        const httpServer = http.createServer(onRequest);
        server = httpServer;
        const onError = /** @param {Error} err */ err => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', onError);
          const addr = httpServer.address();
          if (addr === null || typeof addr === 'string') {
            reject(
              makeError(X`http backend: unexpected address shape ${q(addr)}`),
            );
            return;
          }
          resolve(
            harden({
              host: addr.address,
              port: addr.port,
              family: addr.family,
            }),
          );
        });
      });

    const close = async () => {
      const httpServer = server;
      if (httpServer === undefined) {
        return;
      }
      // Refuse new connections, then drain in-flight requests.
      await new Promise(resolve => httpServer.close(() => resolve(undefined)));
      await Promise.allSettled([...inflight]);
      server = undefined;
    };

    return harden({ listen, close });
  };
};
harden(makeNodeHttpBackend);
