// @ts-check

/**
 * Browser (and `default`) build of `@endo/sha256/async`.
 *
 * This is the arm the async API exists for: it uses WebCrypto's
 * `crypto.subtle.digest('SHA-256', ...)`, the native, vetted digest a browser
 * ships.  The synchronous `@endo/sha256` cannot use it — `crypto.subtle.digest`
 * returns a `Promise` and its only in-graph consumer content-addresses inside a
 * synchronous exo factory (see `designs/platform-neutral-hash.md`) — so this
 * separately named async export is where WebCrypto finally reaches the browser.
 *
 * `crypto.subtle` is only present in a secure context; on an insecure `http://`
 * page (and in any environment a bundler steered to the `default` arm that has
 * no WebCrypto) it is `undefined`.  So this build falls back to the same
 * pure-JS digest the synchronous browser arm uses, and the fallback is decided
 * per call — never memoized, so a first digest taken before a secure context is
 * established cannot pin the pure-JS path for the process.
 */

import harden from '@endo/harden';

import { jsSha256 } from './sha256-js.js';
import { assertBytes, assertDigest, makeSha256IntoAsync } from './shared.js';

/**
 * The `SubtleCrypto` of the current realm, or `undefined` where WebCrypto is
 * unavailable.  Read fresh on every call rather than captured at module load:
 * `globalThis.crypto` can appear only once a page becomes a secure context.
 *
 * @returns {{ digest: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer> } | undefined}
 */
const getSubtle = () => {
  const { crypto } = /** @type {Record<string, any>} */ (globalThis);
  const subtle = crypto && crypto.subtle;
  return subtle && typeof subtle.digest === 'function' ? subtle : undefined;
};

/**
 * One-shot SHA-256 over binary input, backed by WebCrypto where present and by
 * the pure-JS digest otherwise.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>} the raw 32-byte digest
 */
export const sha256Async = async bytes => {
  const input = assertBytes(bytes, 'bytes');
  const subtle = getSubtle();
  if (subtle === undefined) {
    return jsSha256(input);
  }
  // Snapshot the bytes synchronously before awaiting: `input` may be a
  // length-tracking view whose contents or length could change across the
  // await, which would digest something other than what was validated.  The
  // copy also detaches the digest from any host scratch buffer.
  const snapshot = input.slice();
  const raw = await subtle.digest('SHA-256', snapshot);
  return assertDigest(new Uint8Array(raw), 'crypto.subtle.digest');
};
harden(sha256Async);

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out` at
 * `offset` and resolve to the number of bytes written.
 *
 * @type {(out: Uint8Array, bytes: Uint8Array, offset?: number) => Promise<number>}
 */
export const sha256IntoAsync = makeSha256IntoAsync(sha256Async);
