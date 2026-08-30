const lenientTextDecoder = new TextDecoder();

/**
 * Return a genuine `Uint8Array` that `TextDecoder.decode` accepts.
 * Genuine mutable and immutable views pass through without allocation.
 * The ordinary-object wrapper produced by the
 * `@endo/immutable-arraybuffer` emulation is copied to a genuine mutable view.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
const toDecodable = bytes => {
  if (ArrayBuffer.isView(bytes)) {
    return bytes;
  }
  return new Uint8Array(/** @type {Uint8Array} */ (bytes).slice(0));
};

/**
 * Decodes UTF-8 bytes to a string, substituting U+FFFD for malformed input.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const decodeUtf8 = bytes =>
  lenientTextDecoder.decode(toDecodable(bytes));
