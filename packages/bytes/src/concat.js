import harden from '@endo/harden';

/**
 * Concatenates a list of mutable `Uint8Array` chunks into a single contiguous
 * `Uint8Array`.
 *
 * Empty input yields an empty `Uint8Array`.
 *
 * @param {ReadonlyArray<Uint8Array>} inputs
 * @returns {Uint8Array}
 */
export const concatBytes = inputs => {
  let totalLength = 0;
  for (const chunk of inputs) {
    totalLength += chunk.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of inputs) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
harden(concatBytes);
