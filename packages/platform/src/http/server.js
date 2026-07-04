// @ts-check

/**
 * @file Platform-agnostic HTTP server interface (`@endo/platform/http/server`).
 *
 * This is the portable seam named as a forward-pointer in
 * `designs/gateway-package.md` § "Planned factoring" and modelled on
 * the gateway's Node-bound `HttpListener` (see
 * `packages/gateway/src/http-listener.js`). It factors the HTTP
 * *lifecycle* — bind, drain, address discovery — out of any specific
 * runtime so the same server code runs under Node, a browser bundle,
 * or Endor via a conditionally-imported backend.
 *
 * The core here owns only platform-agnostic concerns:
 *
 *   - the `HttpServer` exo and its `start` / `stop` / `whenBound` /
 *     `getAddress` lifecycle, including idempotency and the
 *     bind-address promise; and
 *   - the request/response *value* shapes handlers speak in.
 *
 * All actual I/O — listening on a socket, decoding a request,
 * streaming a response body — lives behind an injected `backend`. The
 * Node backend is `@endo/platform/http/node`
 * (`makeNodeHttpBackend`).
 *
 * A handler is an ordinary function `(request) => response`:
 *
 *   - `request` is `{ method, url, headers }` — `headers` a flat list
 *     of `[name, value]` pairs (a request body surface is intentionally
 *     omitted from v1; add it when a consumer needs it).
 *   - `response` is `{ status, headers?, body? }` where `body` is a
 *     `Uint8Array` (buffered) or an `AsyncIterable<Uint8Array>`
 *     (streamed). The backend pumps a streamed body with backpressure
 *     and, if the body iterator throws mid-stream, aborts the
 *     connection rather than sending a body it cannot reconcile with
 *     the already-committed headers.
 */

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, X } from '@endo/errors';

/**
 * @typedef {object} HttpRequest
 * @property {string} method  the request method, uppercased (`GET`).
 * @property {string} url  the request target (path + query).
 * @property {ReadonlyArray<readonly [string, string]>} headers  raw
 *   header name/value pairs, in wire order, names as received.
 */

/**
 * A response body: either a fully-buffered byte array or an async
 * iterable of byte chunks the backend streams with backpressure.
 *
 * @typedef {Uint8Array | AsyncIterable<Uint8Array>} HttpBody
 */

/**
 * @typedef {object} HttpResponse
 * @property {number} status  the HTTP status code.
 * @property {ReadonlyArray<readonly [string, string]>} [headers]  raw
 *   response header pairs. Defaults to none.
 * @property {HttpBody} [body]  the response body. Omit for an empty
 *   body (e.g. a `HEAD` response or a bare status).
 */

/**
 * @typedef {object} HttpAddress
 * @property {string} host  the bound host / interface address.
 * @property {number} port  the bound port (resolved, never `0`).
 * @property {string} [family]  `'IPv4'` / `'IPv6'` when the backend
 *   reports it.
 */

/**
 * A request handler. Returns a response for each request; may be
 * async. A thrown handler surfaces as a `500` from the backend.
 *
 * @callback HttpHandler
 * @param {HttpRequest} request
 * @returns {Promise<HttpResponse> | HttpResponse}
 */

/**
 * The platform-specific listening primitive. `listen` binds and
 * resolves the actual `HttpAddress` (so an OS-assigned `port: 0` is
 * resolved to the real port); `close` stops accepting connections and
 * drains in-flight requests.
 *
 * @typedef {object} HttpConnection
 * @property {(address: HttpAddress) => Promise<HttpAddress>} listen
 * @property {() => Promise<void>} close
 */

/**
 * A backend factory: given the request `dispatch` function, returns a
 * fresh {@link HttpConnection}. The backend owns request decoding and
 * response streaming; it calls `dispatch` once per request.
 *
 * @callback HttpBackend
 * @param {{ dispatch: HttpHandler }} deps
 * @returns {HttpConnection}
 */

/**
 * Interface guard for the {@link HttpServer} exo. Mirrors the
 * gateway's `HttpListener` surface (`start` / `stop` / `whenBound` /
 * bound-address getter) with the conventional `help`.
 */
export const HttpServerInterface = M.interface('HttpServer', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
  whenBound: M.call().returns(M.promise()),
  getAddress: M.call().returns(M.any()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Build a platform-agnostic HTTP server exo over an injected backend.
 *
 * The returned exo does not listen until `start()` is called;
 * `whenBound()` resolves to the {@link HttpAddress} once bound (await
 * it to learn an OS-assigned port). `start()`/`stop()` are idempotent.
 *
 * @param {object} opts
 * @param {HttpBackend} opts.backend  the platform listening primitive
 *   factory (e.g. `makeNodeHttpBackend({ http })` from
 *   `@endo/platform/http/node`).
 * @param {HttpHandler} opts.handler  the request handler.
 * @param {HttpAddress} [opts.address]  the address to bind. Defaults
 *   to `{ host: '127.0.0.1', port: 0 }` (loopback, OS-assigned port).
 * @returns {object} an exo implementing {@link HttpServerInterface}.
 */
export const makeHttpServer = ({
  backend,
  handler,
  address = { host: '127.0.0.1', port: 0 },
}) => {
  if (typeof backend !== 'function') {
    throw makeError(X`makeHttpServer requires a backend factory function`);
  }
  if (typeof handler !== 'function') {
    throw makeError(X`makeHttpServer requires a handler function`);
  }

  const connection = backend({ dispatch: handler });

  /** @type {'unstarted' | 'starting' | 'started' | 'stopping' | 'stopped'} */
  let lifecycle = 'unstarted';
  /** @type {HttpAddress | undefined} */
  let boundAddress;

  /** @type {(address: HttpAddress) => void} */
  let resolveBound;
  /** @type {(reason: unknown) => void} */
  let rejectBound;
  /** @type {Promise<HttpAddress>} */
  const boundPromise = new Promise((resolve, reject) => {
    resolveBound = resolve;
    rejectBound = reject;
  });
  // Callers that care about a bind failure await start() or
  // whenBound() and see the rejection there; pre-observe it so an
  // unawaited whenBound() does not surface as an unhandled rejection.
  boundPromise.catch(() => {});

  const start = async () => {
    // Async boundary so the first real await below is not nested
    // (satisfies @jessie.js/safe-await-separator).
    await null;
    if (lifecycle === 'started' || lifecycle === 'starting') {
      await boundPromise;
      return;
    }
    if (lifecycle === 'stopping' || lifecycle === 'stopped') {
      throw makeError(X`HttpServer has been stopped and cannot restart`);
    }
    lifecycle = 'starting';
    try {
      boundAddress = await connection.listen(address);
      lifecycle = 'started';
      resolveBound(boundAddress);
    } catch (err) {
      lifecycle = 'unstarted';
      rejectBound(err);
      throw err;
    }
  };

  const stop = async () => {
    if (lifecycle === 'unstarted' || lifecycle === 'stopped') {
      lifecycle = 'stopped';
      return;
    }
    // A concurrent stop and the in-flight stop share the same close;
    // `connection.close()` is expected to be idempotent, so awaiting
    // it again is safe.
    lifecycle = 'stopping';
    await connection.close();
    lifecycle = 'stopped';
  };

  return makeExo(
    'HttpServer',
    HttpServerInterface,
    /** @type {any} */ ({
      start,
      stop,
      whenBound: () => boundPromise,
      getAddress: () => boundAddress,
      help: () =>
        `Platform HTTP server (${lifecycle}). Call start() to bind; whenBound() resolves to { host, port } once listening.`,
    }),
  );
};
harden(makeHttpServer);
