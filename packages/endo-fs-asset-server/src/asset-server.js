// @ts-check
/* global btoa */
/**
 * A static asset server for `@endo/platform/fs/extended` `Filesystem`
 * caps, built on the platform-agnostic HTTP server interface
 * `@endo/platform/http/server`.
 *
 * `makeAssetServer({ backend, getRandomValues, ... })` binds an HTTP
 * server via the injected platform `backend` (e.g.
 * `makeNodeHttpBackend()` from `@endo/platform/http/node`) and
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
import { mountAsFilesystem } from '@endo/platform/fs/extended/from-mount.js';
import { readOnly as readOnlyFilesystem } from '@endo/platform/fs/extended/readonly.js';

import { contentTypeForName } from './mime.js';
import {
  AssetServerInterface,
  AssetServerRootInterface,
  AssetServerAdminInterface,
  AssetPublisherInterface,
  AssetMountInterface,
} from './type-guards.js';

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

/** @returns {HttpResponse} */
const unavailableResponse = () => ({
  status: 503,
  headers: [
    ['Content-Type', 'text/plain; charset=utf-8'],
    ['Retry-After', '5'],
  ],
  body: textEncoder.encode('Temporarily unavailable\n'),
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
 * What a served capability is, which decides how a read-only facet is taken
 * of it and how that facet is walked.
 *
 * @typedef {'filesystem' | 'mount' | 'git'} AssetKind
 */

/**
 * The pure-data record of one served item: everything but the capability.
 * This is what a store persists; `token` is the capability path and is kept
 * so an administrator can be shown a URL again.
 *
 * @typedef {object} AssetRecord
 * @property {1} version
 * @property {string} id  unguessable handle for revoking; never in a URL.
 * @property {string} token  the capability path segment.
 * @property {AssetKind} kind
 * @property {string[]} subPath  sub-path the mount is rooted at.
 * @property {string} index  directory index file name.
 * @property {string} label  free text for the administrator.
 * @property {number} createdAt  epoch milliseconds.
 */

/**
 * Where served items live. The server is the retention root for what it
 * serves: `retain` takes a READ-ONLY facet of the capability it is handed and
 * keeps that facet, and nothing else of the capability, until `release`. A
 * durable store (see `asset-server-module.js`) keeps it across restarts; the
 * default keeps it in memory, for tests and embedders with no store.
 *
 * @typedef {object} AssetStore
 * @property {(id: string, target: object, kind: AssetKind) => Promise<object>} retain
 *   Take a read-only facet of `target`, retain it under `id`, return it.
 * @property {(record: AssetRecord) => Promise<void>} record
 * @property {() => Promise<Array<AssetRecord | { id: string, unreadable: string }>>} load
 *   every record, any order; a record that could not be read or is not one
 *   comes back as `{ id, unreadable }`, so it is listed rather than hidden.
 *   Also the moment a store discards what a crash left half-retained.
 * @property {(id: string, kind: AssetKind) => Promise<object>} recall
 *   the retained read-only facet.
 * @property {(id: string) => Promise<boolean>} release  forget facet and
 *   record; whether there was anything to forget. Safe to repeat.
 */

/**
 * @typedef {object} AssetEntry
 * @property {AssetRecord} record
 * @property {'ready' | 'restoring' | 'unavailable' | 'unreadable'} status
 * @property {string} [error]
 * @property {(options?: { force?: boolean }) => Promise<object>} filesystem
 *   the walkable Filesystem; `force` ignores a remembered failure.
 * @property {() => Promise<object>} facet  the retained read-only facet.
 * @property {() => Promise<boolean>} alive  whether the target answers now;
 *   forgets a resolved Filesystem that does not, so the next request recalls.
 */

/**
 * Tell a Filesystem from a Mount from a Git workspace by the methods it
 * answers, the way `@endo/space-file-explorer` does. A capability that is none
 * of them is refused here, before anything is retained or a URL minted.
 *
 * @param {object} target
 * @returns {Promise<AssetKind>}
 */
export const classifyAssetTarget = async target => {
  let names;
  try {
    // eslint-disable-next-line no-underscore-dangle
    names = new Set(await E(target).__getMethodNames__());
  } catch (cause) {
    throw makeError(
      X`serve requires a Filesystem, Mount or Git capability; the given capability could not be introspected: ${q(/** @type {Error} */ (cause).message)}`,
    );
  }
  if (names.has('root') && names.has('statfs')) return 'filesystem';
  if (names.has('worktree') && names.has('status') && names.has('commit')) {
    return 'git';
  }
  if (
    names.has('lookup') &&
    names.has('readOnly') &&
    (names.has('makeDirectory') || names.has('writeText') || names.has('list'))
  ) {
    return 'mount';
  }
  throw makeError(
    X`serve requires a Filesystem, Mount or Git capability; got one with methods ${q([...names].sort())}`,
  );
};
harden(classifyAssetTarget);

/**
 * A read-only facet of `target`, not retained anywhere: what a store with no
 * durable attenuator keeps. A Git workspace is reduced to the read-only view
 * of its worktree, so what is served is the files as they are now, not the
 * last commit.
 *
 * @param {object} target
 * @param {AssetKind} kind
 * @returns {Promise<object>}
 */
export const takeReadOnlyFacet = async (target, kind) => {
  await null;
  if (kind === 'filesystem') return readOnlyFilesystem(target);
  if (kind === 'git') return E(E(target).readOnly()).worktree();
  return E(target).readOnly();
};
harden(takeReadOnlyFacet);

/**
 * The Filesystem the request path walks, over a retained read-only facet.
 *
 * @param {object} facet
 * @param {AssetKind} kind
 */
const walkable = (facet, kind) =>
  kind === 'filesystem'
    ? readOnlyFilesystem(facet)
    : mountAsFilesystem(facet, { posture: 'readOnly' });

/**
 * Ask the retained facet something only the target can answer. The walkable
 * Filesystem over a Mount is a local wrapper whose `root()` never leaves this
 * worker, so "does root() answer" proves nothing about a mount that has been
 * cancelled; `has` goes to the mount, and a Filesystem's `root()` to the
 * Filesystem.
 *
 * @param {object} facet
 * @param {AssetKind} kind
 * @param {string} index
 */
const probeTarget = async (facet, kind, index) => {
  await null;
  if (kind === 'filesystem') {
    await E(readOnlyFilesystem(facet)).root();
  } else {
    await E(facet).has(index);
  }
};

/** @returns {AssetStore} */
const makeMemoryStore = () => {
  /** @type {Map<string, object>} */
  const facets = new Map();
  /** @type {Map<string, AssetRecord>} */
  const records = new Map();
  return harden({
    retain: async (id, target, kind) => {
      const facet = await takeReadOnlyFacet(target, kind);
      facets.set(id, facet);
      return facet;
    },
    record: async record => {
      records.set(record.id, record);
    },
    load: async () => [...records.values()],
    recall: async id => {
      const facet = facets.get(id);
      if (facet === undefined) throw makeError(X`no retained facet for ${q(id)}`);
      return facet;
    },
    release: async id => {
      const had = facets.delete(id);
      return records.delete(id) || had;
    },
  });
};

/** How long a restored route may take to answer before a request gives up. */
const RESOLVE_TIMEOUT_MS = 15_000;
/** How long a failed resolution is remembered, matching `Retry-After`. */
const RESOLVE_BACKOFF_MS = 5000;

const toHex = bytes =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * @param {unknown} record
 * @returns {record is AssetRecord}
 */
const isAssetRecord = record => {
  const r = /** @type {any} */ (record);
  return (
    r !== null &&
    typeof r === 'object' &&
    r.version === 1 &&
    typeof r.id === 'string' &&
    /^[0-9a-f]{32}$/.test(r.id) &&
    typeof r.token === 'string' &&
    /^[A-Za-z0-9_-]{16,}$/.test(r.token) &&
    ['filesystem', 'mount', 'git'].includes(r.kind) &&
    Array.isArray(r.subPath) &&
    Number(r.subPath.length) <= 64 &&
    // Held to what `serve` would have stored: no traversal, no empty or
    // split segments.
    r.subPath.every(
      seg =>
        typeof seg === 'string' &&
        seg !== '' &&
        seg !== '.' &&
        seg !== '..' &&
        !seg.includes('/') &&
        !seg.includes('\0'),
    ) &&
    typeof r.index === 'string' &&
    r.index !== '' &&
    typeof r.label === 'string' &&
    typeof r.createdAt === 'number'
  );
};

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
 * Build a static asset server over an injected platform HTTP backend, as a kit
 * of facets over one route table:
 *
 * - `admin` — for whoever operates the server: list what is served, reach an
 *   item's retained read-only facet, drop a route, stop the server. It cannot
 *   serve, and cannot change what a route serves; its only mutation is
 *   removal.
 * - `publisher` — for whoever has something to serve: `serve(target)` and the
 *   release of an item by the `id` `serve` returned. It cannot list, and
 *   cannot reach anything it was not handed an `id` for.
 * - `root` — `admin()` and `publisher()`, nothing else: the value of the
 *   daemon formula, from which each facet is given a name of its own.
 * - `server` — serving and `stop()` in one facet, for embedders and tests
 *   that hold the whole server anyway.
 *
 * The server is the retention root for what it serves. On receipt `serve`
 * takes a read-only facet of the capability and that facet is all it keeps;
 * with a durable `store` the facet and the route survive a restart, and the
 * routes are restored here, before the listener opens, with no help from
 * whoever published them.
 *
 * @param {object} opts
 * @param {import('@endo/platform/http/server').HttpBackend} opts.backend
 *   the platform HTTP backend factory (e.g. `makeNodeHttpBackend()`
 *   from `@endo/platform/http/node`).
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
 * @param {AssetStore} [opts.store]  where served items are retained;
 *   defaults to memory, which survives nothing.
 * @param {() => number} [opts.now]
 * @returns {Promise<{ root: object, admin: object, publisher: object, server: object }>}
 */
export const makeAssetServerKit = async ({
  backend,
  getRandomValues,
  port = 0,
  host = '127.0.0.1',
  publicBase = undefined,
  tokenBytes = 24,
  store = makeMemoryStore(),
  now = Date.now,
}) => {
  if (typeof backend !== 'function') {
    throw makeError(X`makeAssetServer requires a platform http backend`);
  }
  if (typeof getRandomValues !== 'function') {
    throw makeError(X`makeAssetServer requires a getRandomValues power`);
  }

  /** Routes by capability path token. @type {Map<string, AssetEntry>} */
  const mounts = new Map();
  /** The same entries by id. @type {Map<string, AssetEntry>} */
  const entries = new Map();

  const mintToken = () =>
    toBase64Url(getRandomValues(new Uint8Array(tokenBytes)));
  const mintId = () => toHex(getRandomValues(new Uint8Array(16)));

  /**
   * A promise that rejects after `ms`, and a way to disarm it. A realm with
   * no timers waits without a bound, as it did before there was one.
   *
   * @param {number} ms
   */
  const deadline = ms => {
    const { setTimeout: set, clearTimeout: clear } = globalThis;
    if (typeof set !== 'function') {
      return { expired: new Promise(() => {}), disarm: () => {} };
    }
    /** @type {any} */
    let timer;
    const expired = new Promise((_, reject) => {
      timer = set(
        () => reject(makeError(X`the served target did not answer in time`)),
        ms,
      );
    });
    expired.catch(() => {});
    return { expired, disarm: () => clear(timer) };
  };

  /**
   * An entry whose Filesystem is resolved from the store on demand, one
   * attempt at a time and each attempt bounded. A failure is remembered only
   * for as long as the `Retry-After` it is answered with, so a target that
   * was briefly unreachable comes back by itself and one that is gone does
   * not cost a store lookup per request.
   *
   * @param {AssetRecord} record
   * @param {object} [knownFacet]
   * @returns {AssetEntry}
   */
  const makeEntry = (record, knownFacet = undefined) => {
    /** @type {object | undefined} */
    let facet = knownFacet;
    /** @type {object | undefined} */
    let filesystem =
      knownFacet === undefined ? undefined : walkable(knownFacet, record.kind);
    /** @type {Promise<object> | undefined} */
    let flight;
    /** @type {{ until: number, cause: unknown } | undefined} */
    let failed;
    /** @type {AssetEntry} */
    const entry = {
      record,
      status: knownFacet === undefined ? 'restoring' : 'ready',
      facet: async () => {
        await entry.filesystem();
        if (facet === undefined) {
          throw makeError(X`the served target is being recalled; try again`);
        }
        return facet;
      },
      alive: async () => {
        const probed = facet;
        if (probed === undefined) return false;
        try {
          await probeTarget(probed, record.kind, record.index);
          return true;
        } catch {
          // Only what was probed is forgotten: a request that held a dead
          // facet must not undo a recall another request already made.
          if (facet === probed) {
            facet = undefined;
            filesystem = undefined;
            entry.status = 'restoring';
          }
          return false;
        }
      },
      filesystem: ({ force = false } = {}) => {
        if (filesystem !== undefined) return Promise.resolve(filesystem);
        if (!force && failed !== undefined && now() < failed.until) {
          return Promise.reject(failed.cause);
        }
        flight ??= (async () => {
          const { expired, disarm } = deadline(RESOLVE_TIMEOUT_MS);
          try {
            const resolved = (async () => {
              const recalled = await store.recall(record.id, record.kind);
              const candidate = walkable(recalled, record.kind);
              // Prove it answers before calling it ready: a facet whose
              // backing is gone resolves and then fails every walk.
              await probeTarget(recalled, record.kind, record.index);
              return { recalled, candidate };
            })();
            resolved.catch(() => {});
            const { recalled, candidate } = await Promise.race([
              resolved,
              expired,
            ]);
            facet = recalled;
            filesystem = candidate;
            failed = undefined;
            entry.status = 'ready';
            entry.error = undefined;
            return candidate;
          } catch (cause) {
            failed = { until: now() + RESOLVE_BACKOFF_MS, cause };
            entry.status = 'unavailable';
            entry.error = String(/** @type {Error} */ (cause)?.message || cause);
            throw cause;
          } finally {
            disarm();
            flight = undefined;
          }
        })();
        return flight;
      },
    };
    return entry;
  };

  /**
   * A record the store holds and could not read. It has no token, so it is
   * no route; it is listed so the administrator can see and remove it.
   *
   * @param {string} id
   * @param {string} why
   * @returns {AssetEntry}
   */
  const makeUnreadableEntry = (id, why) => {
    const gone = () => Promise.reject(makeError(X`unreadable record ${q(id)}`));
    return {
      record: harden({
        version: 1,
        id,
        token: '',
        kind: 'filesystem',
        subPath: [],
        index: 'index.html',
        label: '',
        createdAt: 0,
      }),
      status: 'unreadable',
      error: why,
      facet: gone,
      filesystem: gone,
      alive: async () => false,
    };
  };

  // Restore what the store retained BEFORE the listener opens: a request
  // that arrives first would be told 404 for a URL that is about to work,
  // and a proxy may remember that. The facets resolve in the background — a
  // target that cannot be revived must not hold the listener, or the other
  // routes, hostage — and a store that cannot be read fails the server here,
  // with nothing bound.
  for (const loaded of await store.load()) {
    if (isAssetRecord(loaded)) {
      if (!mounts.has(loaded.token) && !entries.has(loaded.id)) {
        const entry = makeEntry(loaded);
        mounts.set(loaded.token, entry);
        entries.set(loaded.id, entry);
        entry.filesystem().catch(() => {});
      }
    } else {
      const { id, unreadable } = /** @type {any} */ (loaded);
      if (typeof id === 'string' && !entries.has(id)) {
        entries.set(id, makeUnreadableEntry(id, String(unreadable)));
      }
    }
  }

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
    const entry = token ? mounts.get(token) : undefined;
    if (!entry) {
      return plainResponse(404, 'Not found\n');
    }
    const mount = entry.record;
    let filesystem;
    try {
      filesystem = await entry.filesystem();
    } catch {
      // The route exists and its target does not answer: not a 404, which
      // would tell a visitor the link is wrong.
      return unavailableResponse();
    }

    /** @type {string[]} */
    let pathSegments;
    try {
      pathSegments = normalizeSegments(rawSegments.slice(1));
    } catch {
      // Traversal / NUL bytes in the request path.
      return plainResponse(400, 'Bad request\n');
    }
    // A published worktree has its repository beside its files. A link to a
    // site is not a grant of its history, and the link is now permanent.
    if (pathSegments.some(seg => seg.toLowerCase() === '.git')) {
      return plainResponse(404, 'Not found\n');
    }

    // Resolve the request to a File cap. Any resolution failure
    // (missing path, a directory with no index, or an index that is
    // itself a directory) is a 404; we never return a `200` until the
    // resolved node is confirmed to be a readable file.
    let fileNode;
    let size;
    let fileName = pathSegments[pathSegments.length - 1] || mount.index;
    try {
      const segments = [...mount.subPath, ...pathSegments];
      // Pipeline the walk: never await between segments so the whole
      // root -> lookup -> lookup chain dispatches in one CapTP batch.
      let node = /** @type {any} */ (E(filesystem).root());
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
      // A missing path and a Filesystem that has stopped answering both fail
      // the walk. Tell them apart, or a target whose worker restarted would
      // 404 for the rest of this incarnation while listed as ready: if the
      // target itself does not answer, forget it, so the next request
      // recalls it, and say "try again" rather than "no such page".
      if (!(await entry.alive())) {
        return unavailableResponse();
      }
      return plainResponse(404, 'Not found\n');
    }

    // Annotate as tuples: a bare array literal infers as `string[][]`,
    // which is not assignable to the response's
    // `ReadonlyArray<readonly [string, string]>` header shape.
    /** @type {Array<[string, string]>} */
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

  const urlFor = token => `${origin}/${token}/`;

  /**
   * Drop a route and what it retained. The route goes first, so a release
   * that fails in the store still stops the serving; and the store is asked
   * whether or not this incarnation knows the id, so a release that failed
   * once can be repeated until it holds, and one made after `stop()` is not
   * mistaken for done. A revocation that only happened in memory would bring
   * the URL back at the next restart.
   *
   * @param {string} id
   */
  const drop = async id => {
    if (!/^[0-9a-f]{32}$/.test(id)) return false;
    // eslint-disable-next-line no-use-before-define
    await serving.get(id)?.catch(() => {});
    const entry = entries.get(id);
    if (entry) {
      mounts.delete(entry.record.token);
      entries.delete(id);
    }
    const released = await store.release(id);
    return entry !== undefined || released;
  };

  /**
   * @param {string} id
   * @param {string} token
   */
  const makeRevoker = (id, token) => {
    let revoked = false;
    const url = urlFor(token);
    return makeExo('AssetMount', AssetMountInterface, {
      revoke: async () => {
        await drop(id);
        revoked = true;
      },
      getPath: () => `/${token}/`,
      getUrl: () => url,
      isRevoked: () => revoked || !entries.has(id),
      help: () =>
        `Revoker for the capability served at ${url}. Call revoke() to stop serving it.`,
    });
  };

  /**
   * Serve a Filesystem, Mount or Git capability under a fresh capability
   * path. The server takes a read-only facet of it on receipt and retains
   * that; nothing is served, and no URL is minted, for a capability it could
   * not retain or cannot walk.
   *
   * @param {object} target
   * @param {object} [serveOpts]
   * @param {string | string[]} [serveOpts.subPath]  sub-path within
   *   the target to serve as the mount root.
   * @param {string} [serveOpts.index]  directory index file name;
   *   defaults to `index.html`.
   * @param {string} [serveOpts.label]  free text shown to the administrator.
   * @param {string} [serveOpts.id]  the id to serve under, 32 lowercase hex
   *   characters of the caller's own randomness. A caller that records the id
   *   BEFORE it serves can never lose track of a route to a crash in between:
   *   `serve` with an id that already stands returns that route instead of
   *   making another, so the caller simply serves again.
   */
  const serveOnce = async (target, serveOpts = {}) => {
    await null;
    if (stopped) {
      throw makeError(X`asset-server has been stopped`);
    }
    if (target === undefined || target === null) {
      throw makeError(X`serve requires a Filesystem, Mount or Git capability`);
    }
    const subPath = normalizeSegments(
      /** @type {string | string[]} */ (serveOpts.subPath ?? []),
    );
    // What is retained per route is bounded here, since it is kept for as
    // long as the route stands.
    if (subPath.length > 64 || subPath.some(seg => seg.length > 255)) {
      throw makeError(X`serve subPath is too deep or has too long a segment`);
    }
    const index = serveOpts.index ?? 'index.html';
    if (
      typeof index !== 'string' ||
      index === '' ||
      index.length > 255 ||
      index.includes('/') ||
      index.includes('\0')
    ) {
      throw makeError(X`serve index must be a file name`);
    }
    const label = serveOpts.label ?? '';
    if (typeof label !== 'string' || label.length > 256) {
      throw makeError(X`serve label must be a string of at most 256 characters`);
    }
    const requestedId = serveOpts.id;
    if (
      requestedId !== undefined &&
      (typeof requestedId !== 'string' || !/^[0-9a-f]{32}$/.test(requestedId))
    ) {
      throw makeError(X`serve id must be 32 lowercase hex characters`);
    }
    if (requestedId !== undefined) {
      const standing = entries.get(requestedId);
      if (standing) {
        if (standing.status === 'unreadable') {
          throw makeError(X`serve id ${q(requestedId)} names an unreadable record`);
        }
        return harden({
          id: requestedId,
          path: `/${standing.record.token}/`,
          url: urlFor(standing.record.token),
          revoke: makeRevoker(requestedId, standing.record.token),
        });
      }
    }
    const kind = await classifyAssetTarget(target);

    const id = requestedId ?? mintId();
    if (entries.has(id)) {
      // Two serves raced on one id; the first stands.
      throw makeError(X`serve id ${q(id)} is already being served`);
    }
    const facet = await store.retain(id, target, kind);
    /** @type {AssetRecord} */
    const record = harden({
      version: 1,
      id,
      token: mintToken(),
      kind,
      subPath,
      index,
      label,
      createdAt: now(),
    });
    try {
      // Refuse a facet this server cannot walk here, rather than minting a
      // URL whose every request fails.
      await probeTarget(facet, kind, index);
      await E(walkable(facet, kind)).root();
      await store.record(record);
    } catch (cause) {
      await store.release(id).catch(() => {});
      throw cause;
    }
    const entry = makeEntry(record, facet);
    mounts.set(record.token, entry);
    entries.set(id, entry);

    const path = `/${record.token}/`;
    const url = urlFor(record.token);
    const revoke = makeRevoker(id, record.token);

    return harden({ id, path, url, revoke });
  };

  /**
   * Serves under a caller-chosen id, in flight. Nothing else reserves an id
   * between the check that it is free and the route standing, so two serves
   * of one id would both retain under one name and leave a second, unlisted,
   * unrevocable token; and a release would race the serve it was meant for.
   *
   * @type {Map<string, Promise<unknown>>}
   */
  const serving = new Map();

  /** @type {typeof serveOnce} */
  const serve = async (target, serveOpts = {}) => {
    const id = serveOpts?.id;
    if (typeof id !== 'string') return serveOnce(target, serveOpts);
    const earlier = serving.get(id);
    if (earlier) {
      // Whatever it came to, the route either stands now or does not.
      await earlier.catch(() => {});
      return serve(target, serveOpts);
    }
    const flight = serveOnce(target, serveOpts);
    serving.set(id, flight);
    try {
      return await flight;
    } finally {
      if (serving.get(id) === flight) serving.delete(id);
    }
  };

  const getAddress = () => harden({ host, port: boundPort, origin });

  /** @param {AssetEntry} entry */
  const describeEntry = entry =>
    entry.status === 'unreadable'
      ? harden({
          id: entry.record.id,
          status: entry.status,
          error: entry.error,
        })
      : describeRoute(entry);
  /** @param {AssetEntry} entry */
  const describeRoute = entry =>
    harden({
      id: entry.record.id,
      path: `/${entry.record.token}/`,
      url: urlFor(entry.record.token),
      kind: entry.record.kind,
      subPath: entry.record.subPath,
      index: entry.record.index,
      label: entry.record.label,
      createdAt: entry.record.createdAt,
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    });

  // Stopping closes the listener. It releases nothing: what the server
  // retains is served again by the next incarnation, and only a revocation
  // ends a route. The tables stay, so the administrator of a stopped server
  // still sees, and can still revoke, what the next one would serve.
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await E(httpServer).stop();
  };

  const release = async id => {
    if (typeof id !== 'string') throw makeError(X`release requires an id`);
    return drop(id);
  };

  // For whoever holds an id. The reason a target is unavailable is the
  // daemon's own wording and can name host paths the Mount interface hides,
  // so it is the administrator's to read, not the publisher's.
  const describe = id => {
    const entry = entries.get(id);
    if (!entry || entry.status === 'unreadable') return undefined;
    const { error: _error, ...rest } = describeRoute(entry);
    return harden(rest);
  };

  // `describe` reports what the last request found, which can be a failure
  // from minutes ago that nothing has retried. Someone about to act on
  // "unavailable" — Floot replaces such a route, and with it a URL already
  // handed out — asks the target now.
  const check = async id => {
    const entry = entries.get(id);
    if (!entry || entry.status === 'unreadable') return undefined;
    if (!(await entry.alive())) {
      await entry.filesystem({ force: true }).catch(() => {});
    }
    return describe(id);
  };

  const publisher = makeExo('AssetPublisher', AssetPublisherInterface, {
    serve,
    release,
    describe,
    check,
    getAddress,
    help: () =>
      `Publisher for the static asset server at ${origin}. serve(target) takes a read-only facet of a Filesystem, Mount or Git capability, retains it, and returns { id, path, url, revoke }; the route lasts until revoke.revoke() or release(id), across restarts.`,
  });

  const admin = makeExo('AssetServerAdmin', AssetServerAdminInterface, {
    list: () => harden([...entries.values()].map(describeEntry)),
    // The retained read-only facet, for inspecting what a route serves.
    getTarget: async id => {
      const entry = entries.get(id);
      if (!entry) throw makeError(X`no served item ${q(id)}`);
      return entry.facet();
    },
    revoke: release,
    getAddress,
    stop,
    help: () =>
      `Administrator of the static asset server at ${origin}. list() the served items, getTarget(id) for an item's read-only facet, revoke(id) to drop a route, stop() to close the listener. It cannot serve.`,
  });

  // What a formula's value is: the one object from which the two facets are
  // taken, held by whoever instantiated the server and handed to no one.
  const root = makeExo('AssetServerRoot', AssetServerRootInterface, {
    admin: () => admin,
    publisher: () => publisher,
    help: () =>
      `Static asset server at ${origin}. admin() is the operator's facet (list, getTarget, revoke, stop); publisher() is the serve-only facet to hand out. Give each its own name and hand out neither this object nor admin().`,
  });

  const server = makeExo('AssetServer', AssetServerInterface, {
    serve,
    release,
    describe,
    check,
    getAddress,
    stop,
    help: () =>
      `Static asset server at ${origin}. Call serve(target) to mount a Filesystem, Mount or Git capability under a fresh capability path; it returns { id, path, url, revoke }. The mount serves until revoke.revoke().`,
  });

  return harden({ root, admin, publisher, server });
};
harden(makeAssetServerKit);

/**
 * The whole server as one facet, retaining in memory unless given a store:
 * the shape this package had before it had an administrator.
 *
 * @param {Parameters<typeof makeAssetServerKit>[0]} opts
 */
export const makeAssetServer = async opts =>
  (await makeAssetServerKit(opts)).server;
harden(makeAssetServer);
