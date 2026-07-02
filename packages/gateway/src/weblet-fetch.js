// @ts-check

/**
 * @file Phase 11b: weblet content fetch + streaming for the gateway's
 *   HTTP listener.
 *
 * The Phase 11a listener (see `./http-listener.js`) routes a request
 * whose `Host` header resolves through the formula-backed `@apps`
 * NameHub (Phase 7) to a 501 placeholder carrying
 * `X-Endo-Weblet-Formula`. Phase 11b replaces that placeholder with
 * the real content-tree resolution path the design names under
 * `designs/gateway-package.md` § Feature 2 *content-tree resolution
 * path*: dereference the weblet formula on the originating user
 * daemon, walk the `readable-tree` `contentRoot` by the request's
 * path-suffix, and stream the matching `readable-blob` bytes from
 * the daemon's CAS to the HTTP response.
 *
 * The gateway-side scope of this PR is the **wiring** seam: a pure
 * module that takes the request's path-suffix and a `ServeWeblet`
 * adapter, normalizes the bare-root case to `/index.html`, invokes
 * the adapter, threads `If-None-Match` through, and maps the
 * adapter's disjoint-union result to a response shape with status,
 * headers, and an optional body reader. The daemon-side
 * implementation of the `ServeWeblet` adapter (the formula-graph
 * resolver, the readable-tree walker, the CAS-blob streamer) lands
 * in a separate PR; until then, embedders that toggle the
 * `serveWeblet` power get the wired path, and embedders that omit
 * it still see the 501 placeholder.
 *
 * ### Why a separate module
 *
 * The listener already carries the bind / accept / route-dispatch
 * machinery; layering the content fetch on top would push the
 * listener past 800 lines and would bundle the (testable in
 * isolation) lookup-and-streaming logic with the (only testable
 * end-to-end) Node-bound listener. Keeping the fetch in a separate
 * module lets a unit test exercise the result-shape mapping with
 * a stub adapter and lets the integration test reuse the same
 * listener-side wiring it already exercises for the Phase 11a 501
 * path.
 *
 * ### Fail-closed posture
 *
 * - `serveWeblet` undefined: the listener falls back to the
 *   Phase-11a 501. Embedders that have not wired a daemon-side
 *   adapter still observe routing.
 * - `serveWeblet` throws (formula not resolvable, daemon
 *   unreachable, CAS read fails): the gateway returns 500. The
 *   throw's message lands in the configured `logWarning` sink; the
 *   response body is a fixed `Internal Server Error\n` to avoid
 *   leaking implementation detail to an external observer.
 * - `serveWeblet` returns 404: the gateway returns 404 with the
 *   path in the body, mirroring the Phase 11a unbound-host path.
 * - `serveWeblet` returns 200: the gateway sets `Content-Type` from
 *   the adapter, sets `ETag` to the blob hash, optionally sets
 *   `Content-Length` (when the adapter knows the size), sets
 *   `Cache-Control: public, max-age=31536000, immutable` to honor
 *   the content-addressed semantics, and streams the body bytes
 *   to the response.
 * - `serveWeblet` returns 304: the gateway sends 304 with no body
 *   and echoes the `ETag` header.
 *
 * The `Cache-Control: public, max-age=31536000, immutable` policy
 * matches the design's "the hash IS the etag" framing under
 * `journal/library/sections/.../daemon-cas-management/...`: every
 * 200 response carries the content's hash in the ETag, so a client
 * that already holds the bytes for a given ETag can never receive
 * different bytes for the same ETag. The `immutable` directive lets
 * RFC-8246 clients skip even the conditional revalidation
 * (`If-None-Match`) round-trip for the duration of `max-age`. A
 * fork in the content tree (a new contentRoot) produces a new
 * ETag and the client re-fetches.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { Reader } from '@endo/stream' */
/**
 * @import {
 *   ForwardedRequest,
 *   ServeWeblet,
 *   ServeWebletArgs,
 *   ServeWebletResult,
 * } from './types.d.ts'
 */

/**
 * Bare-root requests (the `GET /` case, or the absent-path case the
 * gateway listener already maps to `/`) resolve to the manifest's
 * `entry` per `designs/familiar-app-ui-hosting.md`. The convention
 * across the design corpus is `index.html`; the gateway encodes
 * that default at the seam so a daemon-side adapter can stay
 * agnostic of HTTP convention.
 */
const DEFAULT_ENTRY_PATH = '/index.html';

/**
 * The Cache-Control header value applied to every 200 response. The
 * content-addressed semantics make every successful response
 * effectively immutable: a different content under the same ETag is
 * impossible by construction. RFC-8246 clients that honor
 * `immutable` skip even the conditional revalidation round-trip.
 *
 * The directive is shared with the response shape so a test can
 * assert on the exact string the gateway emits.
 */
export const CONTENT_ADDRESSED_CACHE_CONTROL =
  'public, max-age=31536000, immutable';
harden(CONTENT_ADDRESSED_CACHE_CONTROL);

/**
 * The fixed body string the gateway sends on a 500 path. Kept out
 * of the response producer so the listener-side error fallback
 * uses the same wording as the weblet-fetch internal failure.
 */
export const INTERNAL_SERVER_ERROR_BODY = 'Internal Server Error\n';
harden(INTERNAL_SERVER_ERROR_BODY);

/**
 * Normalize a request URL's pathname into the path-suffix the
 * `serveWeblet` adapter consumes. The Phase-11a listener does not
 * carry a virtual-host prefix on the path (the request's path is
 * already the per-weblet path after Host-header demux); we still
 * normalize the bare-root case to the manifest's entry default
 * here so the adapter never sees a `'/'` it has to special-case.
 *
 * Leading multi-slash sequences (`//x`) collapse to `/x`; a
 * trailing-slash directory (`/dir/`) keeps the trailing slash so
 * the adapter can map directory-indexes if it chooses. The gateway
 * does not currently invoke a directory-index resolver beyond the
 * top-level bare root; that's the adapter's choice.
 *
 * @param {string} pathname
 * @returns {string}
 */
export const normalizeWebletPath = pathname => {
  if (typeof pathname !== 'string' || pathname === '') {
    return DEFAULT_ENTRY_PATH;
  }
  if (pathname === '/') {
    return DEFAULT_ENTRY_PATH;
  }
  // Collapse leading repeated slashes; a `//foo` URL is technically
  // valid but most static-asset servers treat it as `/foo`.
  let normalized = pathname;
  while (normalized.length > 1 && normalized.startsWith('//')) {
    normalized = normalized.slice(1);
  }
  return normalized;
};
harden(normalizeWebletPath);

/**
 * The non-streaming portion of a weblet-fetch response: the status
 * and the headers the gateway sets on the `ServerResponse`. The
 * `body` is a separate field so the listener can `res.setHeader`
 * before consuming the reader.
 *
 * @typedef {object} WebletResponseHeaders
 * @property {number} status
 * @property {Array<[string, string]>} headers
 * @property {Reader<Uint8Array> | undefined} body
 *   Present on 200 only. On 304 and 404 the listener writes a
 *   short text body (or none) without reading a stream.
 * @property {string} [textBody]
 *   Present on 404 (the path-not-found phrase). On 200 the body
 *   is `body`; on 304 the body is empty.
 */

/**
 * Resolve a host-matched HTTP request to a weblet-fetch response
 * shape. Pure module: the listener supplies a `ServeWeblet`
 * adapter, this module decides what status / headers / body the
 * listener writes.
 *
 * The function never throws on a well-shaped input: a `ServeWeblet`
 * throw is caught and surfaced as a 500. The `logWarning` callback
 * (when present) receives the throw's message; the response body
 * is the fixed `INTERNAL_SERVER_ERROR_BODY` so an external observer
 * cannot enumerate adapter failure modes.
 *
 * @param {object} args
 * @param {string} args.webletFormulaId
 *   The formula identifier the gateway resolved through `apps.lookup`.
 * @param {string} args.pathSuffix
 *   The request's URL pathname (the listener passes `url.pathname`).
 * @param {string} [args.ifNoneMatch]
 *   The request's `If-None-Match` header, when present.
 * @param {ForwardedRequest} [args.forwarded]
 *   The Feature-9 X-Forwarded parse output.
 * @param {ServeWeblet} args.serveWeblet
 * @param {(message: string) => void} [args.logWarning]
 * @returns {Promise<WebletResponseHeaders>}
 */
export const fetchWebletResponse = async ({
  webletFormulaId,
  pathSuffix,
  ifNoneMatch,
  forwarded,
  serveWeblet,
  logWarning,
}) => {
  if (typeof webletFormulaId !== 'string' || webletFormulaId === '') {
    throw makeError(
      X`fetchWebletResponse requires a non-empty webletFormulaId, got ${q(webletFormulaId)}`,
    );
  }
  if (typeof serveWeblet !== 'function') {
    throw makeError(
      X`fetchWebletResponse requires a serveWeblet function power`,
    );
  }
  const normalizedPath = normalizeWebletPath(pathSuffix);
  /** @type {ServeWebletArgs} */
  const adapterArgs = {
    webletFormulaId,
    pathSuffix: normalizedPath,
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    ...(forwarded === undefined ? {} : { forwarded }),
  };
  /** @type {ServeWebletResult} */
  let result;
  try {
    result = await serveWeblet(adapterArgs);
  } catch (e) {
    const message = /** @type {Error} */ (e).message;
    if (typeof logWarning === 'function') {
      logWarning(
        `[Gateway] serveWeblet(${q(webletFormulaId)}, ${q(normalizedPath)}) threw: ${message}`,
      );
    }
    return harden({
      status: 500,
      headers: [
        /** @type {[string, string]} */ ([
          'content-type',
          'text/plain; charset=utf-8',
        ]),
      ],
      body: undefined,
      textBody: INTERNAL_SERVER_ERROR_BODY,
    });
  }
  if (result === null || typeof result !== 'object') {
    if (typeof logWarning === 'function') {
      logWarning(
        `[Gateway] serveWeblet returned a non-object result: ${q(result)}`,
      );
    }
    return harden({
      status: 500,
      headers: [
        /** @type {[string, string]} */ ([
          'content-type',
          'text/plain; charset=utf-8',
        ]),
      ],
      body: undefined,
      textBody: INTERNAL_SERVER_ERROR_BODY,
    });
  }
  if (result.status === 404) {
    return harden({
      status: 404,
      headers: [
        /** @type {[string, string]} */ ([
          'content-type',
          'text/plain; charset=utf-8',
        ]),
      ],
      body: undefined,
      textBody: `Not Found: ${normalizedPath}\n`,
    });
  }
  if (result.status === 304) {
    if (typeof result.etag !== 'string' || result.etag === '') {
      if (typeof logWarning === 'function') {
        logWarning(
          `[Gateway] serveWeblet returned 304 without a non-empty etag: ${q(result)}`,
        );
      }
      return harden({
        status: 500,
        headers: [
          /** @type {[string, string]} */ ([
            'content-type',
            'text/plain; charset=utf-8',
          ]),
        ],
        body: undefined,
        textBody: INTERNAL_SERVER_ERROR_BODY,
      });
    }
    return harden({
      status: 304,
      headers: [/** @type {[string, string]} */ (['etag', result.etag])],
      body: undefined,
    });
  }
  if (result.status === 200) {
    if (typeof result.contentType !== 'string' || result.contentType === '') {
      if (typeof logWarning === 'function') {
        logWarning(
          `[Gateway] serveWeblet returned 200 without a non-empty contentType: ${q(result)}`,
        );
      }
      return harden({
        status: 500,
        headers: [
          /** @type {[string, string]} */ ([
            'content-type',
            'text/plain; charset=utf-8',
          ]),
        ],
        body: undefined,
        textBody: INTERNAL_SERVER_ERROR_BODY,
      });
    }
    if (typeof result.etag !== 'string' || result.etag === '') {
      if (typeof logWarning === 'function') {
        logWarning(
          `[Gateway] serveWeblet returned 200 without a non-empty etag: ${q(result)}`,
        );
      }
      return harden({
        status: 500,
        headers: [
          /** @type {[string, string]} */ ([
            'content-type',
            'text/plain; charset=utf-8',
          ]),
        ],
        body: undefined,
        textBody: INTERNAL_SERVER_ERROR_BODY,
      });
    }
    if (result.body === null || typeof result.body !== 'object') {
      if (typeof logWarning === 'function') {
        logWarning(
          `[Gateway] serveWeblet returned 200 without a body reader: ${q(result)}`,
        );
      }
      return harden({
        status: 500,
        headers: [
          /** @type {[string, string]} */ ([
            'content-type',
            'text/plain; charset=utf-8',
          ]),
        ],
        body: undefined,
        textBody: INTERNAL_SERVER_ERROR_BODY,
      });
    }
    /** @type {Array<[string, string]>} */
    const headers = [
      /** @type {[string, string]} */ (['content-type', result.contentType]),
      /** @type {[string, string]} */ (['etag', result.etag]),
      /** @type {[string, string]} */ ([
        'cache-control',
        CONTENT_ADDRESSED_CACHE_CONTROL,
      ]),
    ];
    if (typeof result.size === 'number' && Number.isInteger(result.size)) {
      if (result.size < 0) {
        if (typeof logWarning === 'function') {
          logWarning(
            `[Gateway] serveWeblet returned a negative size ${q(result.size)}; suppressing Content-Length`,
          );
        }
      } else {
        headers.push(
          /** @type {[string, string]} */ ([
            'content-length',
            String(result.size),
          ]),
        );
      }
    }
    return harden({
      status: 200,
      headers,
      body: result.body,
    });
  }
  // An adapter that returns a status outside {200, 304, 404} is a
  // wiring bug; surface as 500 rather than passing through.
  if (typeof logWarning === 'function') {
    logWarning(
      `[Gateway] serveWeblet returned unsupported status ${q(
        /** @type {{status: unknown}} */ (result).status,
      )}; treating as 500`,
    );
  }
  return harden({
    status: 500,
    headers: [
      /** @type {[string, string]} */ ([
        'content-type',
        'text/plain; charset=utf-8',
      ]),
    ],
    body: undefined,
    textBody: INTERNAL_SERVER_ERROR_BODY,
  });
};
harden(fetchWebletResponse);
