// @ts-check
import { makeError, q, X } from '@endo/errors';

/**
 * Validate a `(offset, length)` read window against a device size, with
 * uniform diagnostics. Shared by every `BlockDevice` implementation so
 * that an out-of-range read fails the same way everywhere rather than
 * returning a short or zero-padded buffer.
 *
 * @param {number} offset
 * @param {number} length
 * @param {number} size
 */
export const assertReadRange = (offset, length, size) => {
  if (!Number.isInteger(offset) || offset < 0) {
    throw makeError(
      X`Read offset must be a non-negative integer, got ${q(offset)}`,
    );
  }
  if (!Number.isInteger(length) || length < 0) {
    throw makeError(
      X`Read length must be a non-negative integer, got ${q(length)}`,
    );
  }
  if (offset + length > size) {
    throw makeError(
      X`Read of ${q(length)} bytes at ${q(offset)} exceeds device size ${q(size)}`,
    );
  }
};
harden(assertReadRange);
