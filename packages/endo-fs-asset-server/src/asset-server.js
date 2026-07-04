// @ts-check
/* global btoa */
/**
 * A static asset server for `@endo/platform/fs/extended` `Filesystem`
 * caps, built on the platform-agnostic HTTP server interface
 * `@endo/platform/http/server`.
 *
 * `makeAssetServer({ backend, getRandomValues, ... })` binds an HTTP
 * server via the injected platform `backend` (e.g.
 * `makeNodeHttpBackend({ http })` from `@endo/platform/http/node`) and
 * returns an `AssetServer` exo. Each `serve(filesystem)` call:
 *
 *   1. mints a fresh, unguessable capability path segment (the
 *      "token"),
 *   2. registers the Filesystem under that token, and
 *   3. returns `{ path, url, revoke }`.
 *
 * Requests to `/{token}/some/path` walk the Filesystem and stream the
 * file's bytes back with a guessed `Content-Type`. The token in the
 * URL *is* the capability: there is no other authorization check, so
 * the token must stay secret. A mount serves persistently until its
 * `revoke()` is called (or the server stops), so the same path keeps
 * resolving across any number of requests.
 *
 * This module owns only the request *handler* — a pure
 * `(request) => response` function over the platform HTTP value shapes.
 * All socket I/O, request decoding, and response streaming (with
 * backpressure) live in the injected backend, so the same handler runs
 * under any platform that supplies one.
 *
 * The endo-fs cap surface used here is the read slice of
 * `FilesystemInterface` / `DirectoryInterface` / `FileInterface` /
 * `OpenFileInterface`: `root()`, `lookup(name)`, `getAttrs()`,
 * `open({ read: true })`, and `OpenFile.read(offset, length)`. All
 * sends are pipelined with `E` so a deep path walk costs one CapTP
 * batch rather than one round-trip per segment.
 */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeError, X, q } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { makeHttpServer } from '@endo/platform/http/server';

import { contentTypeForName } from './mime.js';
import { AssetServerInterface, AssetMountInterface } from './type-guards.js';

/** @import { HttpRequest, HttpResponse } from '@endo/platform/http/server' */

const textEncoder = new TextEncoder();

/**
 * Build a small plain-text {@link HttpResponse}. Used for the 400 /
 * 404 / 405 error paths.
 *
 * @param {number} status
 * @param {string} text
 * @returns {HttpResponse}
 */
const plainResponse = (status, text) => ({
  status,
  headers: [['Content-Type', 'text/plain; charset=utf-8']],
  body: textEncoder.encode(text),
});

/**
 * Coerce a `string | string[]` path argument into a flat array of
 * non-empty, non-traversal segments. Each string element is split on
 * `/`. Rejects `.`/`..` and embedded NUL bytes so a served path can
 * never escape the Filesystem root.
 *
 * @param {string | string[]} pathArg
 * @returns {string[]}
 */
export const normalizeSegments = pathArg => {
  const raw = typeof pathArg === 'string' ? [pathArg] : pathArg;
  /** @type {string[]} */
  const out = [];
  for (const part of raw) {
    if (typeof part !== 'string') {
      throw makeError(X`asset-server path expects strings, got ${q(part)}`);
    }
    for (const seg of part.split('/')) {
      if (seg === '.' || seg === '..') {
        throw makeError(
          X`asset-server path rejects traversal segment ${q(seg)} in ${q(pathArg)}`,
        );
      }
      if (seg.includes('\0')) {
        throw makeError(X`asset-server path rejects NUL byte in ${q(seg)}`);
      }
      if (seg !== '') {
        out.push(seg);
      }
    }
  }
  return out;
};
harden(normalizeSegments);

/**
 * URL-safe base64 (RFC 4648 §5) of a byte array, without padding.
 * Portable across SES realms, XS, and browsers (`btoa` is a global).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const toBase64Url = bytes => {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/**
 * @typedef {object} AssetMount
 * @property {object} filesystem  endo-fs Filesystem cap (or eref).
 * @property {string[]} basePath  sub-path within the Filesystem that
 *   the mount is rooted at.
 * @property {string} index  directory index file name.
 * @property {boolean} revoked
 */

/**
 * An async iterable over a file's bytes, suitable as an
 * {@link HttpResponse} body. Opens the file read-only, streams its
 * bytes in `iterateBytesReader` frames, always closes the `OpenFile`,
 * and — if the bytes read do not match the advertised `Content-Length`
 * — throws at the end so the backend aborts the connection rather than
 * sending a body that disagrees with the committed headers. A
 * read-only mount avoids the mismatch entirely.
 *
 * @param {object} fileNode  endo-fs File cap (or eref).
 * @param {bigint} size  the size advertised as `Content-Length`.
 * @returns {AsyncGenerator<Uint8Array>}
 */
const readFileBody = async function* readFileBody(fileNode, size) {
  // Accommodate backings that emit the whole payload in one base64
  // frame; without this the default 100 KB cap on `M.string()` would
  // reject anything bigger. Mirrors endo-fs-exec's drainBytesReader.
  const stringLengthLimit = Math.max(
    100_000,
    Math.ceil((Number(size) * 4) / 3) + 1024,
  );
  let written = 0n;
  const openFile = await E(fileNode).open({ read: true });
  try {
    const reader = await E(openFile).read(0n, size);
    for await (const chunk of iterateBytesReader(/** @type {any} */ (reader), {
      stringLengthLimit,
    })) {
      written += BigInt(chunk.length);
      yield chunk;
    }
  } finally {
    await E(openFile)
      .close()
      .catch(() => undefined);
  }
  if (written !== size) {
    throw makeError(
      X`asset-server: file changed under read (${q(written)} != ${q(size)})`,
    );
  }
};

/**
 * Build a static asset server over an injected platform HTTP backend.
 *
 * @param {object} opts
 * @param {import('@endo/platform/http/server').HttpBackend} opts.backend
 *   the platform HTTP backend factory (e.g.
 *   `makeNodeHttpBackend({ http })` from `@endo/platform/http/node`).
 * @param {(bytes: Uint8Array) => Uint8Array} opts.getRandomValues
 *   fills a byte array with cryptographically strong random values
 *   (e.g. `globalThis.crypto.getRandomValues`). Used to mint
 *   unguessable capability paths.
 * @param {number} [opts.port]  port to listen on; `0` (default) asks
 *   the OS to assign one.
 * @param {string} [opts.host]  interface to bind; defaults to
 *   `127.0.0.1` (loopback only).
 * @param {string} [opts.publicBase]  origin to advertise in returned
 *   URLs (e.g. `https://assets.example`) when the server sits behind
 *   a proxy. Defaults to `http://{host}:{port}`.
 * @param {number} [opts.tokenBytes]  entropy per capability path;
 *   defaults to 24 bytes (192 bits).
 * @returns {Promise<object>} an `AssetServer` exo.
 */
export const makeAssetServer = async ({
  backend,
  getRandomValues,
  port = 0,
  host = '127.0.0.1',
  publicBase = undefined,
  tokenBytes = 24,
}) => {
  if (typeof backend !== 'function') {
    throw makeError(X`makeAssetServer requires a platform http backend`);
  }
  if (typeof getRandomValues !== 'function') {
    throw makeError(X`makeAssetServer requires a getRandomValues power`);
  }

  /** @type {Map<string, AssetMount>} */
  const mounts = new Map();

  const mintToken = () =>
    toBase64Url(getRandomValues(new Uint8Array(tokenBytes)));

  /**
   * The platform HTTP request handler: resolve `/{token}/path` to a
   * file in the mounted Filesystem and return its bytes as a streamed
   * response body.
   *
   * @param {HttpRequest} request
   * @returns {Promise<HttpResponse>}
   */
  const handler = async request => {
    // Establish an async boundary up front so the first real `await`
    // below is not nested (satisfies @jessie.js/safe-await-separator).
    await null;
    const { method } = request;
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        status: 405,
        headers: [
          ['Allow', 'GET, HEAD'],
          ['Content-Type', 'text/plain; charset=utf-8'],
        ],
        body: textEncoder.encode('Method not allowed\n'),
      };
    }

    // `request.url` is a path+query string; resolve against a dummy
    // origin to parse and decode the pathname uniformly.
    const requestUrl = new URL(request.url || '/', 'http://placeholder');
    /** @type {string[]} */
    let rawSegments;
    try {
      rawSegments = decodeURIComponent(requestUrl.pathname)
        .split('/')
        .filter(seg => seg !== '');
    } catch {
      return plainResponse(400, 'Bad request\n');
    }

    const token = rawSegments[0];
    const mount = token ? mounts.get(token) : undefined;
    if (!mount || mount.revoked) {
      return plainResponse(404, 'Not found\n');
    }

    /** @type {string[]} */
    let pathSegments;
    try {
      pathSegments = normalizeSegments(rawSegments.slice(1));
    } catch {
      // Traversal / NUL bytes in the request path.
      return plainResponse(400, 'Bad request\n');
    }

    // Resolve the request to a File cap. Any resolution failure
    // (missing path, a directory with no index, or an index that is
    // itself a directory) is a 404; we never return a `200` until the
    // resolved node is confirmed to be a readable file.
    let fileNode;
    let size;
    let fileName = pathSegments[pathSegments.length - 1] || mount.index;
    try {
      const segments = [...mount.basePath, ...pathSegments];
      // Pipeline the walk: never await between segments so the whole
      // root -> lookup -> lookup chain dispatches in one CapTP batch.
      let node = /** @type {any} */ (E(mount.filesystem).root());
      for (const seg of segments) {
        node = E(node).lookup(seg);
      }
      // Distinguish File from Directory via CapTP introspection rather
      // than duck-typing (which would emit a failed call per probe).
      // eslint-disable-next-line no-underscore-dangle
      let methods = await E(node).__getMethodNames__();
      if (!methods.includes('open')) {
        // Directory (or other non-file): serve its index file, and
        // label the response by the index's name, not the directory's.
        node = E(node).lookup(mount.index);
        fileName = mount.index;
        // eslint-disable-next-line no-underscore-dangle
        methods = await E(node).__getMethodNames__();
      }
      if (!methods.includes('open')) {
        // The resolved node is still not a readable file (e.g. the
        // index entry is itself a directory). Fall through to 404.
        throw makeError(X`not a readable file`);
      }
      const attrs = await E(node).getAttrs();
      size = /** @type {bigint} */ (attrs.size);
      fileNode = node;
    } catch {
      return plainResponse(404, 'Not found\n');
    }

    const headers = [
      ['Content-Type', contentTypeForName(fileName)],
      ['Content-Length', String(size)],
      ['Cache-Control', 'no-cache'],
      // The capability lives in the URL path; never let a served page
      // forward it to another origin via the Referer header.
      ['Referrer-Policy', 'no-referrer'],
      // Served content may be untrusted; forbid MIME sniffing so the
      // declared Content-Type is authoritative.
      ['X-Content-Type-Options', 'nosniff'],
    ];
    if (method === 'HEAD' || size === 0n) {
      return { status: 200, headers };
    }
    return { status: 200, headers, body: readFileBody(fileNode, size) };
  };

  const httpServer = makeHttpServer({
    backend,
    handler,
    address: { host, port },
  });
  await E(httpServer).start();
  const bound = /** @type {{ host: string, port: number }} */ (
    await E(httpServer).whenBound()
  );
  const boundPort = bound.port;
  const origin =
    publicBase !== undefined && publicBase !== ''
      ? publicBase.replace(/\/+$/, '')
      : `http://${host}:${boundPort}`;

  let stopped = false;

  /**
   * Register `filesystem` under `token` and return its `{ path, url,
   * revoke }` handle. Shared by `serve` (random token) and `serveAt`
   * (caller-chosen token). Replaces any existing mount at `token`.
   *
   * @param {string} token  the first path segment the mount answers to.
   * @param {object} filesystem  endo-fs Filesystem cap (or eref).
   * @param {object} [serveOpts]
   * @param {string | string[]} [serveOpts.subPath]
   * @param {string} [serveOpts.index]
   */
  const registerMount = (token, filesystem, serveOpts = {}) => {
    const basePath = normalizeSegments(
      /** @type {string | string[]} */ (serveOpts.subPath ?? []),
    );
    const index = serveOpts.index ?? 'index.html';
    if (typeof index !== 'string' || index === '') {
      throw makeError(X`serve index must be a non-empty string`);
    }

    /** @type {AssetMount} */
    const mount = { filesystem, basePath, index, revoked: false };
    mounts.set(token, mount);

    const path = `/${token}/`;
    const url = `${origin}${path}`;

    const revoke = makeExo('AssetMount', AssetMountInterface, {
      revoke: () => {
        mount.revoked = true;
        mounts.delete(token);
      },
      getPath: () => path,
      getUrl: () => url,
      isRevoked: () => mount.revoked,
      help: () =>
        `Revoker for the Filesystem served at ${url}. Call revoke() to stop serving it.`,
    });

    return harden({ path, url, revoke });
  };

  /**
   * @param {object} filesystem  endo-fs Filesystem cap (or eref).
   * @param {object} [serveOpts]
   * @param {string | string[]} [serveOpts.subPath]  sub-path within
   *   the Filesystem to serve as the mount root.
   * @param {string} [serveOpts.index]  directory index file name;
   *   defaults to `index.html`.
   */
  const serve = (filesystem, serveOpts = {}) => {
    if (stopped) {
      throw makeError(X`asset-server has been stopped`);
    }
    if (filesystem === undefined || filesystem === null) {
      throw makeError(X`serve requires a Filesystem cap`);
    }
    return registerMount(mintToken(), filesystem, serveOpts);
  };

  /**
   * Serve a Filesystem at a caller-chosen, STABLE path segment instead
   * of a random token. Unlike `serve`, the resulting URL is
   * predictable, so it survives being re-registered on every process
   * start — the basis for a persistent static site whose config (not a
   * minted token) is the source of truth. Because the path is chosen,
   * treat it as public unless you pick an unguessable segment yourself.
   *
   * @param {string} pathSegment  a single non-empty, non-traversal path
   *   segment (the mount token), e.g. `site`.
   * @param {object} filesystem  endo-fs Filesystem cap (or eref).
   * @param {object} [serveOpts]
   * @param {string | string[]} [serveOpts.subPath]
   * @param {string} [serveOpts.index]
   */
  const serveAt = (pathSegment, filesystem, serveOpts = {}) => {
    if (stopped) {
      throw makeError(X`asset-server has been stopped`);
    }
    if (filesystem === undefined || filesystem === null) {
      throw makeError(X`serveAt requires a Filesystem cap`);
    }
    const segs = normalizeSegments(pathSegment);
    if (segs.length !== 1) {
      throw makeError(
        X`serveAt requires a single non-empty, non-traversal path segment, got ${q(pathSegment)}`,
      );
    }
    return registerMount(segs[0], filesystem, serveOpts);
  };

  const getAddress = () => harden({ host, port: boundPort, origin });

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const mount of mounts.values()) {
      mount.revoked = true;
    }
    mounts.clear();
    await E(httpServer).stop();
  };

  return makeExo('AssetServer', AssetServerInterface, {
    serve,
    serveAt,
    getAddress,
    stop,
    help: () =>
      `Static asset server at ${origin}. Call serve(filesystem) to mount a Filesystem under a fresh capability path, or serveAt(pathSegment, filesystem) for a stable, chosen path; both return { path, url, revoke }. Mounts serve persistently until revoke.revoke().`,
  });
};
harden(makeAssetServer);
