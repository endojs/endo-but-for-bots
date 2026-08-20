// @ts-check
/**
 * Reference content-addressed-store (CAS) consumer for `BlobRef`s
 * (DESIGN.md §6).
 *
 * `BlobRef.getInfo()` carries `{ algorithm, hash, size }`. Callers
 * pipeline it alongside the surrounding call (snapshot, read) so
 * the incremental round-trip is zero (DESIGN.md §4.10). A
 * consumer that maintains a local CAS keyed by `(algorithm,
 * hash)` can answer reads locally and skip re-streaming the blob's
 * bytes (`BlobRef.streamBase64()`) entirely on cache hits — the
 * central performance claim that motivates BlobRef in the first place.
 *
 * Two pieces:
 *
 * - `makeMemoryCas()` — minimal in-memory CAS: a `Map` from
 *   `${algorithm}:${hash}` to `Uint8Array`. Suitable for tests
 *   and small-scale callers; a disk-backed or distributed CAS
 *   that implements the same surface is a drop-in replacement.
 *
 * - `cacheBackedRead(blobRef, cas)` — the consumer. Calls
 *   `getInfo()` once, looks up the CAS, and either serves bytes
 *   from the cache (hit, no re-stream) or streams the blob once
 *   and populates the cache (miss). Returns the full content as a
 *   `Uint8Array`.
 *
 * The function returns the full content rather than a slice
 * because the CAS contract is whole-blob: the hash identifies
 * the entire payload. Callers who only want a range can slice
 * the returned `Uint8Array` themselves.
 */

import { createHash } from 'node:crypto';

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { encodeHex } from '@endo/hex';
import { encodeBase64 } from '@endo/base64';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

/**
 * @typedef {{ algorithm: string, hash: string, size: bigint }} BlobInfo
 * @typedef {{
 *   has: (info: BlobInfo) => boolean,
 *   get: (info: BlobInfo) => Uint8Array | undefined,
 *   put: (info: BlobInfo, bytes: Uint8Array) => void,
 *   size: number,
 * }} ContentAddressedStore
 */

/**
 * Build the lookup key for a `BlobInfo`. `algorithm:hash` is
 * sufficient — different files with the same SHA-256 (or other
 * algorithm) collision-free hash have the same bytes regardless
 * of any other field.
 *
 * @param {BlobInfo} info
 */
const keyOf = info => {
  if (typeof info.algorithm !== 'string' || typeof info.hash !== 'string') {
    throw makeError(
      X`CAS: BlobInfo must carry string algorithm + hash, got ${q(info)}`,
    );
  }
  return `${info.algorithm}:${info.hash}`;
};

/**
 * Build a fresh in-memory CAS.
 *
 * Backing is a plain `Map` whose iteration order tracks LRU (every
 * `get`/`put` moves the entry to the back of the Map). When the
 * caller passes `capacity`, `put` evicts least-recently-used entries
 * once the count exceeds the limit. The default is unbounded — same
 * shape as before, suitable for tests and short-lived consumers.
 * Long-running consumers should set `capacity` to keep memory
 * bounded.
 *
 * Not safe for use across vat boundaries (the CAS is a host-process
 * resource).
 *
 * @param {{ capacity?: number }} [opts]
 * @returns {ContentAddressedStore}
 */
export const makeMemoryCas = (opts = {}) => {
  const { capacity } = opts;
  if (capacity !== undefined) {
    if (
      typeof capacity !== 'number' ||
      !Number.isInteger(capacity) ||
      capacity <= 0
    ) {
      throw makeError(
        X`makeMemoryCas: capacity must be a positive integer, got ${q(capacity)}`,
      );
    }
  }
  /** @type {Map<string, Uint8Array>} */
  const map = new Map();
  // LRU via Map insertion order: `get` deletes + re-sets so the
  // most-recently-used entry sits at the back; eviction pops the
  // first (oldest) key.
  const touch = key => {
    const v = map.get(key);
    if (v !== undefined) {
      map.delete(key);
      map.set(key, v);
    }
    return v;
  };
  const evictIfFull = () => {
    if (capacity === undefined) return;
    while (map.size > capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  };
  return harden({
    has(info) {
      return map.has(keyOf(info));
    },
    get(info) {
      return touch(keyOf(info));
    },
    put(info, bytes) {
      const key = keyOf(info);
      // `set` on an existing key keeps insertion order; delete first
      // so the entry moves to the back.
      if (map.has(key)) map.delete(key);
      map.set(key, harden(new Uint8Array(bytes)));
      evictIfFull();
    },
    get size() {
      return map.size;
    },
  });
};
harden(makeMemoryCas);

/**
 * Fixed defensive per-frame base64 limit for a remote blob stream. It is a
 * constant — NOT derived from the sender-advertised `getInfo().size` — so a
 * remote that lies about its size cannot enlarge the per-frame `M.string()`
 * allocation the consumer will accept. Every producer in this codebase chunks
 * `streamBase64` at 48 KiB of raw bytes (`BASE64_CHUNK_RAW_BYTES`), which
 * base64-expands to ~64 KiB; 256 KiB leaves generous headroom for a one-shot
 * frame while still bounding a single hostile frame. A payload larger than one
 * frame arrives as many bounded frames, exactly as the streaming protocol
 * intends.
 */
export const MAX_FRAME_BASE64_LENGTH = 256 * 1024;

/**
 * Drain a `streamBase64`-bearing blob into a single `Uint8Array` via the
 * `@endo/exo-stream` consumer protocol, under a fixed per-frame bound and a
 * total bounded by the advertised size, so neither the per-frame nor the
 * aggregate allocation is chosen by the (untrusted) sender.
 *
 * @param {any} blobRef  a remotable exposing `streamBase64`
 * @param {bigint | number} expectedSize  the sender-advertised total; used only
 *   as an upper bound on how many bytes to buffer, never to raise the per-frame
 *   or aggregate ceiling above the fixed defensive limit.
 */
const drainBlobBytes = async (blobRef, expectedSize) => {
  const size =
    typeof expectedSize === 'bigint' ? Number(expectedSize) : expectedSize;
  // The advertised size bounds how many bytes we are willing to buffer, so a
  // source that lies small but streams forever is cut off early rather than
  // driving unbounded growth. Combined with the fixed per-frame limit, the
  // sender controls neither the per-frame nor the aggregate allocation.
  const maxTotal = Number.isSafeInteger(size) && size >= 0 ? size : 0;
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  const consumer = iterateBytesReader(blobRef, {
    stringLengthLimit: MAX_FRAME_BASE64_LENGTH,
  });
  for await (const chunk of consumer) {
    total += chunk.length;
    if (total > maxTotal) {
      throw makeError(
        X`CAS: blob delivered more than its advertised ${q(maxTotal)} bytes; refusing to buffer a size-lying source`,
      );
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

/**
 * Verify that drained remote bytes actually match the content address the
 * sender advertised via `getInfo()`, before they are inserted into the CAS
 * under `(algorithm, hash)`. Without this, a remote could return a truthful
 * `getInfo()` but stream *different* bytes (or lie about size), poisoning the
 * cache so a later honest read of the same address is served forged bytes — the
 * sender would in effect choose its own content-address key.
 *
 * Size is checked for every algorithm. The digest is recomputed and compared
 * for `sha256` (the algorithm the daemon content store and every `BlobRef`
 * producer here mint, and the one this cross-runtime module can recompute — the
 * browser `node:crypto` shim implements SHA-256 only). Bytes whose advertised
 * algorithm is not `sha256` are size-verified but not digest-verified here.
 *
 * @param {BlobInfo} info
 * @param {Uint8Array} bytes
 */
export const verifyContentAddress = (info, bytes) => {
  const expectedSize = Number(info.size);
  if (bytes.length !== expectedSize) {
    throw makeError(
      X`CAS: blob size ${q(bytes.length)} does not match advertised size ${q(info.size)}`,
    );
  }
  if (info.algorithm === 'sha256') {
    const digest = createHash('sha256').update(bytes).digest();
    // Producers spell the digest base64 (`BlobRef.getInfo`); the daemon store
    // spells it base64 too. Accept either the base64 or hex spelling so a
    // consumer is not wedged by an equivalent encoding of the same digest.
    const digestBase64 = encodeBase64(digest);
    const digestHex = encodeHex(digest);
    if (info.hash !== digestBase64 && info.hash !== digestHex) {
      throw makeError(
        X`CAS: sha256 content-address ${q(info.hash)} does not match the streamed bytes (${q(digestBase64)}); refusing to cache a forged content address`,
      );
    }
  }
};
harden(verifyContentAddress);

/**
 * Read a `BlobRef`'s bytes, consulting `cas` first. On cache
 * hit, the bytes are served locally without touching the wire.
 * On miss, stream the full content from the underlying blob,
 * populate the CAS, and return.
 *
 * `BlobRef.getInfo()` is always called (one round-trip); callers
 * that need to avoid even that round-trip should pipeline `getInfo`
 * alongside the call that produced the BlobRef — see
 * `withCachedReads` in `cached-fs.js` for the realisation.
 *
 * With `{ offset, length }`, returns a slice of the blob. The
 * full blob is still streamed on a miss because the CAS contract
 * is whole-blob (the hash names the entire payload); partial
 * reads couldn't be safely cached. The return is a copy of
 * the requested slice.
 *
 * @param {any} blobRef
 * @param {ContentAddressedStore} cas
 * @param {{ offset?: bigint, length?: bigint }} [range]
 * @returns {Promise<Uint8Array>}
 */
export const cacheBackedRead = async (blobRef, cas, range) => {
  const info = /** @type {BlobInfo} */ (await E(blobRef).getInfo());
  let bytes = cas.get(info);
  if (bytes === undefined) {
    // Miss: stream the full payload through the normal `streamBase64` blob
    // surface (the ranged `fetch` primitive is retired). Verify the streamed
    // bytes against the advertised content address BEFORE caching, so a remote
    // cannot poison the CAS by streaming bytes that differ from the
    // `(algorithm, hash, size)` it advertised.
    bytes = await drainBlobBytes(blobRef, info.size);
    verifyContentAddress(info, bytes);
    cas.put(info, bytes);
  }
  if (range === undefined) return bytes;
  const offset = range.offset === undefined ? 0 : Number(range.offset);
  const length =
    range.length === undefined ? bytes.length - offset : Number(range.length);
  if (offset < 0 || length < 0 || offset > bytes.length) {
    throw makeError(
      X`EINVAL: cacheBackedRead range out of bounds (offset=${q(offset)}, length=${q(length)}, size=${q(bytes.length)})`,
    );
  }
  const end = Math.min(offset + length, bytes.length);
  return bytes.slice(offset, end);
};
harden(cacheBackedRead);
