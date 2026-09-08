// @ts-check
/**
 * Phase 1 of `designs/gateway-sites-publication.md`: the serving core.
 *
 * A pure HTTP request handler — `(HttpRequest) => Promise<HttpResponse>` over
 * `@endo/platform/http/server` — that serves the entries of a `readable-tree`
 * snapshot as browser resources. It owns no registry, no origin story, and no
 * mutable state: the snapshot is injected, so a later durable registry (Phase
 * 2) selects the current snapshot and hands it here.
 *
 * The `tree` is a `SnapshotTree`-shaped eref: `lookup(name | segments)`
 * resolves to a `SnapshotBlob` (a file) or a sub-`SnapshotTree` (a directory).
 * This is the surface `E(mount).snapshot()` / `checkin` produce
 * (`SnapshotBlobInterface` = `streamBase64` / `text` / `json` / `getInfo` /
 * `sha256`; `SnapshotTreeInterface` = `has` / `list` / `lookup` / `getInfo` /
 * `sha256`). A leaf's bytes are read by driving its `streamBase64` responder
 * through `iterateBytesReader`; its size and content hash come from
 * `getInfo()`.
 *
 * Because both blobs and trees expose `getInfo`, a resolved node is confirmed
 * to be a *file* by the presence of `streamBase64` (introspected via
 * `__getMethodNames__`) — never by `getInfo`. A path that resolves to a
 * directory with no readable index is a `404`, never a `200` we cannot fulfil.
 *
 * The response-policy and caching baseline (design § Browser boundaries,
 * § Caching) is applied to every response — success, conditional, and failure
 * alike. Path safety reuses `normalizeSegments` (rejects `.` / `..` / NUL) after
 * the handler percent-decodes the pathname; names are looked up within the tree
 * and never joined onto a host path.
 */

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { normalizeSegments } from './asset-server.js';
import { contentTypeForName } from './mime.js';

/** @import { HttpRequest, HttpResponse } from '@endo/platform/http/server' */

const textEncoder = new TextEncoder();

/**
 * The strict same-origin response-policy baseline. Confines scripts,
 * connections, forms, and loads to the publication's own origin; disables
 * object embedding and framing; suppresses `Referer`; disables MIME sniffing;
 * and applies cross-origin opener/embedder/resource isolation. CORS is off by
 * default (no `Access-Control-*`). A publisher may only tighten this.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const baselineSecurityHeaders = harden([
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  [
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
]);

/**
 * A small plain-text response carrying the security baseline. Used for the
 * 400 / 404 / 405 paths.
 *
 * @param {number} status
 * @param {string} text
 * @returns {HttpResponse}
 */
const plainResponse = (status, text) => ({
  status,
  headers: [
    ['Content-Type', 'text/plain; charset=utf-8'],
    ...baselineSecurityHeaders,
  ],
  body: textEncoder.encode(text),
});

/**
 * Case-insensitive lookup of a single request header value.
 *
 * @param {ReadonlyArray<readonly [string, string]>} headers
 * @param {string} name  lower-case header name
 * @returns {string | undefined}
 */
const getHeader = (headers, name) => {
  for (const [k, v] of headers) {
    if (k.toLowerCase() === name) {
      return v;
    }
  }
  return undefined;
};

/**
 * Whether an `If-None-Match` header value matches `etag`, per RFC 7232 §3.2:
 * a comma-separated list, `*` matches any current representation, and the
 * weak-comparison used for GET/HEAD ignores a leading `W/`.
 *
 * @param {string | undefined} headerValue
 * @param {string} etag  a strong tag of the form `"<hash>"`
 * @returns {boolean}
 */
const ifNoneMatchMatches = (headerValue, etag) => {
  if (headerValue === undefined) {
    return false;
  }
  const stripWeak = tag => tag.replace(/^W\//, '');
  const target = stripWeak(etag);
  return headerValue
    .split(',')
    .map(tag => tag.trim())
    .some(tag => tag === '*' || stripWeak(tag) === target);
};

/**
 * Stream a blob's bytes as an async iterable suitable for an
 * {@link HttpResponse} body, by driving the blob's `streamBase64` responder.
 * The snapshot is immutable and content-addressed, so its size cannot drift
 * between the `getInfo()` stat and this read — the streamed length always
 * matches the advertised `Content-Length`.
 *
 * @param {object} blob  a `SnapshotBlob` eref (`streamBase64`).
 * @param {bigint} size
 * @returns {AsyncGenerator<Uint8Array>}
 */
const readBlobBody = async function* readBlobBody(blob, size) {
  // Accommodate backings that emit the whole payload in one base64 frame;
  // without this the default 100 KB cap on `M.string()` rejects larger blobs.
  const stringLengthLimit = Math.max(
    100_000,
    Math.ceil((Number(size) * 4) / 3) + 1024,
  );
  for await (const chunk of iterateBytesReader(/** @type {any} */ (blob), {
    stringLengthLimit,
  })) {
    yield chunk;
  }
};

/**
 * @param {object} node  a resolved tree node (eref).
 * @returns {Promise<boolean>} whether it is a readable blob (has streamBase64).
 */
const isBlob = async node => {
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(node).__getMethodNames__();
  return methods.includes('streamBase64');
};

/**
 * Build the serving-core request handler over a single injected snapshot.
 *
 * @param {object} opts
 * @param {object} opts.tree  a `SnapshotTree` eref (the selected snapshot).
 * @param {string} [opts.index]  directory index file name; defaults to
 *   `index.html`.
 * @returns {(request: HttpRequest) => Promise<HttpResponse>}
 */
export const makeTreeRequestHandler = ({ tree, index = 'index.html' }) => {
  if (tree === undefined || tree === null) {
    throw makeError(X`makeTreeRequestHandler requires a tree`);
  }
  if (typeof index !== 'string' || index === '') {
    throw makeError(X`index must be a non-empty string, got ${q(index)}`);
  }

  /**
   * @param {HttpRequest} request
   * @returns {Promise<HttpResponse>}
   */
  const handler = async request => {
    // Async boundary so the first real await below is not nested
    // (satisfies @jessie.js/safe-await-separator).
    await null;
    const { method } = request;
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        status: 405,
        headers: [
          ['Allow', 'GET, HEAD'],
          ['Content-Type', 'text/plain; charset=utf-8'],
          ...baselineSecurityHeaders,
        ],
        body: textEncoder.encode('Method not allowed\n'),
      };
    }

    // `request.url` is a path+query; resolve against a dummy origin to parse
    // and decode the pathname uniformly.
    const requestUrl = new URL(request.url || '/', 'http://placeholder');
    /** @type {string[]} */
    let rawSegments;
    try {
      rawSegments = decodeURIComponent(requestUrl.pathname)
        .split('/')
        .filter(seg => seg !== '');
    } catch {
      // Malformed percent-encoding.
      return plainResponse(400, 'Bad request\n');
    }

    /** @type {string[]} */
    let pathSegments;
    try {
      pathSegments = normalizeSegments(rawSegments);
    } catch {
      // Traversal (`.`/`..`) or NUL byte.
      return plainResponse(400, 'Bad request\n');
    }

    // Resolve to a readable blob; a directory selects its index. Any failure
    // (missing path, directory with no readable index, index that is itself a
    // directory) is a 404 — we never emit a 200 we cannot fulfil. A file is
    // confirmed by the presence of `streamBase64`, not `getInfo` (both blobs
    // and trees expose `getInfo`).
    let blob;
    let fileName = pathSegments[pathSegments.length - 1] || index;
    /** @type {bigint} */
    let size;
    /** @type {string} */
    let hash;
    try {
      let node;
      if (pathSegments.length === 0) {
        node = E(tree).lookup(index);
        fileName = index;
        if (!(await isBlob(node))) {
          throw makeError(X`index is not a readable file`);
        }
      } else {
        node = E(tree).lookup(pathSegments);
        if (await isBlob(node)) {
          fileName = pathSegments[pathSegments.length - 1];
        } else {
          // A directory (or non-file): serve its index.
          node = E(node).lookup(index);
          fileName = index;
          if (!(await isBlob(node))) {
            throw makeError(X`index is not a readable file`);
          }
        }
      }
      const info = /** @type {{ hash: string, size: bigint }} */ (
        await E(node).getInfo()
      );
      size = info.size;
      hash = info.hash;
      blob = node;
    } catch {
      return plainResponse(404, 'Not found\n');
    }

    const etag = `"${hash}"`;
    /** @type {Array<[string, string]>} */
    const headers = [
      ['Content-Type', contentTypeForName(fileName)],
      ['Content-Length', String(size)],
      ['Cache-Control', 'private, no-cache'],
      ['ETag', etag],
      ...baselineSecurityHeaders,
    ];

    // Conditional request: revalidate against the current representation.
    if (ifNoneMatchMatches(getHeader(request.headers, 'if-none-match'), etag)) {
      return { status: 304, headers };
    }
    if (method === 'HEAD' || size === 0n) {
      return { status: 200, headers };
    }
    return { status: 200, headers, body: readBlobBody(blob, size) };
  };

  return harden(handler);
};
harden(makeTreeRequestHandler);
