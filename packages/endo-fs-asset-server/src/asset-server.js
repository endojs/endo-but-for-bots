// @ts-check
/* global btoa */
/**
 * A static asset server for `@endo/endo-fs` `Filesystem` caps.
 *
 * `makeAssetServer({ http, getRandomValues, ... })` starts an HTTP
 * server (over the injected `node:http`-shaped `http` power) and
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

import { contentTypeForName } from './mime.js';
import { AssetServerInterface, AssetMountInterface } from './type-guards.js';

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
 * Drain the file at `fileNode` to the HTTP response and finalize it.
 * Opens the file read-only, streams its bytes in `iterateBytesReader`
 * frames, always closes the `OpenFile`, and then either `end()`s the
 * response or — if the bytes read do not match the advertised
 * `Content-Length` — `destroy()`s the socket. The caller must have
 * already committed the `200` headers (including `Content-Length:
 * size`) and must not touch `res` afterwards.
 *
 * @param {object} fileNode  endo-fs File cap (or eref).
 * @param {bigint} size  the size advertised as `Content-Length`.
 * @param {import('node:http').ServerResponse} res
 */
const streamFile = async (fileNode, size, res) => {
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
      if (!res.write(chunk)) {
        // Respect backpressure: wait for the socket to drain before
        // requesting the next frame.
        await new Promise(resolve => res.once('drain', resolve));
      }
    }
  } finally {
    await E(openFile)
      .close()
      .catch(() => undefined);
  }
  if (written !== size) {
    // The file changed between the `getAttrs` stat and the read (only
    // possible on a writable backing). The advertised `Content-Length`
    // can no longer be honoured, so abort the socket — a half-open
    // response is better than one that hangs the client waiting for
    // bytes that will never arrive. Use a read-only mount to avoid
    // this entirely.
    res.destroy();
    return;
  }
  res.end();
};

/**
 * Build a static asset server over an injected HTTP power.
 *
 * @param {object} opts
 * @param {import('node:http')} opts.http  a `node:http`-shaped module
 *   exposing `createServer`.
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
  http,
  getRandomValues,
  port = 0,
  host = '127.0.0.1',
  publicBase = undefined,
  tokenBytes = 24,
}) => {
  if (!http || typeof http.createServer !== 'function') {
    throw makeError(
      X`makeAssetServer requires an http power with createServer`,
    );
  }
  if (typeof getRandomValues !== 'function') {
    throw makeError(X`makeAssetServer requires a getRandomValues power`);
  }

  /** @type {Map<string, AssetMount>} */
  const mounts = new Map();

  const mintToken = () =>
    toBase64Url(getRandomValues(new Uint8Array(tokenBytes)));

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handleRequest = async (req, res) => {
    // Establish an async boundary up front so the first real `await`
    // below is not nested (satisfies @jessie.js/safe-await-separator).
    await null;
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    // `req.url` is a path+query string; resolve against a dummy origin
    // to parse and decode the pathname uniformly.
    const requestUrl = new URL(req.url || '/', 'http://placeholder');
    /** @type {string[]} */
    let rawSegments;
    try {
      rawSegments = decodeURIComponent(requestUrl.pathname)
        .split('/')
        .filter(seg => seg !== '');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const token = rawSegments[0];
    const mount = token ? mounts.get(token) : undefined;
    if (!mount || mount.revoked) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }

    /** @type {string[]} */
    let pathSegments;
    try {
      pathSegments = normalizeSegments(rawSegments.slice(1));
    } catch {
      // Traversal / NUL bytes in the request path.
      res.writeHead(400);
      res.end();
      return;
    }

    // Resolve the request to a File cap, then read it. Any resolution
    // failure (missing path, a directory with no index, or an index
    // that is itself a directory) is a 404; we never commit a `200`
    // until the resolved node is confirmed to be a readable file.
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
        // index entry is itself a directory). Fall through to 404
        // rather than committing a 200 we cannot fulfil.
        throw makeError(X`not a readable file`);
      }
      const attrs = await E(node).getAttrs();
      size = /** @type {bigint} */ (attrs.size);
      fileNode = node;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeForName(fileName),
      'Content-Length': String(size),
      'Cache-Control': 'no-cache',
      // The capability lives in the URL path; never let a served page
      // forward it to another origin via the Referer header.
      'Referrer-Policy': 'no-referrer',
      // Served content may be untrusted; forbid MIME sniffing so the
      // declared Content-Type is authoritative.
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD' || size === 0n) {
      res.end();
      return;
    }
    // streamFile owns finalization: it end()s on success or destroy()s
    // the socket if the file changed under it (short read).
    await streamFile(fileNode, size, res);
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      // Diagnostics to stderr only; never to stdout (library rule).
      console.error(
        'asset-server: request failed',
        /** @type {Error} */ (error).message,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal error\n');
      } else {
        res.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = /** @param {Error} err */ err => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(undefined);
    });
  });

  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const boundPort = address.port;
  const origin =
    publicBase !== undefined && publicBase !== ''
      ? publicBase.replace(/\/+$/, '')
      : `http://${host}:${boundPort}`;

  let stopped = false;

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
    const basePath = normalizeSegments(
      /** @type {string | string[]} */ (serveOpts.subPath ?? []),
    );
    const index = serveOpts.index ?? 'index.html';
    if (typeof index !== 'string' || index === '') {
      throw makeError(X`serve index must be a non-empty string`);
    }

    const token = mintToken();
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
    await new Promise(resolve => server.close(() => resolve(undefined)));
  };

  return makeExo('AssetServer', AssetServerInterface, {
    serve,
    getAddress,
    stop,
    help: () =>
      `Static asset server at ${origin}. Call serve(filesystem) to mount a Filesystem under a fresh capability path; it returns { path, url, revoke }. The mount serves persistently until revoke.revoke().`,
  });
};
harden(makeAssetServer);
