// @ts-check

/**
 * Shared argument checking and the `sha256Into` adapter used by every
 * `@endo/sha256` condition build.  Keeping the checks here means the
 * node, browser, and xs builds reject the same inputs with the same
 * errors, so a program that works on one platform cannot silently
 * accept a different domain on another.
 */

import harden from '@endo/harden';

/** Length in bytes of a SHA-256 digest. */
export const DIGEST_LENGTH = 32;

// `%TypedArray%.prototype`'s `length` accessor, captured at module load
// before any consumer can reach this module.  `instanceof Uint8Array`
// is not a brand check: a `Proxy` over a real `Uint8Array` satisfies it
// and can then answer a different length to each read, which for a
// digest is a wrong content address rather than an error.  The
// intrinsic getter reads the internal slot, so it refuses a proxy and
// ignores a subclass's own `length`, while still accepting a Node
// `Buffer`.  `@endo/hex/src/decode.js` captures intrinsics the same
// way and for the same reason.
const { get: intrinsicLength } = /** @type {PropertyDescriptor} */ (
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'length',
  )
);

/**
 * The true byte length of a typed array, read through the intrinsic
 * accessor.  Throws for anything that is not one.
 *
 * @param {unknown} bytes
 * @returns {number}
 */
export const byteLengthOf = bytes =>
  /** @type {() => number} */ (intrinsicLength).call(bytes);
harden(byteLengthOf);

/**
 * @param {unknown} bytes
 * @param {string} name
 * @returns {Uint8Array}
 */
export const assertBytes = (bytes, name) => {
  if (!(bytes instanceof Uint8Array)) {
    throw TypeError(
      `@endo/sha256: ${name} must be a Uint8Array, got ${typeof bytes}`,
    );
  }
  try {
    byteLengthOf(bytes);
  } catch (cause) {
    throw TypeError(
      `@endo/sha256: ${name} must be a real Uint8Array, not a proxy or lookalike`,
      { cause },
    );
  }
  return /** @type {Uint8Array} */ (bytes);
};
harden(assertBytes);

/**
 * Check the destination of a bring-your-own-buffer digest write.
 *
 * @param {Uint8Array} out
 * @param {number} offset
 */
export const assertRoomForDigest = (out, offset) => {
  assertBytes(out, 'out');
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw RangeError(
      `@endo/sha256: offset must be a non-negative safe integer, got ${offset}`,
    );
  }
  if (out.length - offset < DIGEST_LENGTH) {
    throw RangeError(
      `@endo/sha256: sha256Into needs ${DIGEST_LENGTH} bytes at offset ${offset}, got ${out.length - offset}`,
    );
  }
};
harden(assertRoomForDigest);

/**
 * Check a digest produced by a backing this package does not implement
 * itself.  A host function that returns a short buffer, a long one, or
 * a value the `Uint8Array` constructor merely tolerates (a number
 * yields a zero-filled array) would otherwise become a *wrong content
 * address* rather than an error, and every blob would share it.
 *
 * @param {Uint8Array} digest
 * @param {string} source
 * @returns {Uint8Array}
 */
export const assertDigest = (digest, source) => {
  if (!(digest instanceof Uint8Array) || digest.length !== DIGEST_LENGTH) {
    throw Error(
      `@endo/sha256: ${source} produced ${digest instanceof Uint8Array ? `${digest.length} bytes` : typeof digest}, expected a ${DIGEST_LENGTH}-byte digest`,
    );
  }
  return digest;
};
harden(assertDigest);

/**
 * Derive the `sha256Into` export from a one-shot `sha256`, for the
 * builds whose backing digest cannot write into a caller-supplied
 * buffer (`node:crypto` and the XS host functions both allocate their
 * own).  The pure-JS build overrides this with an implementation that
 * writes the result words straight into `out`.
 *
 * @param {(bytes: Uint8Array) => Uint8Array} sha256
 * @returns {(out: Uint8Array, bytes: Uint8Array, offset?: number) => number}
 */
export const makeSha256Into = sha256 => {
  const sha256Into = (out, bytes, offset = 0) => {
    assertRoomForDigest(out, offset);
    // Check the length before writing: a short digest would otherwise
    // leave stale destination bytes behind a return value of 32.
    out.set(assertDigest(sha256(bytes), 'the digest backing'), offset);
    return DIGEST_LENGTH;
  };
  return harden(sha256Into);
};
harden(makeSha256Into);
