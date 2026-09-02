const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Return a genuine `Uint8Array` that `TextDecoder.decode` accepts.
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
 * Decodes UTF-8 bytes to a string and throws a `TypeError` for malformed input.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const strictDecodeUtf8 = bytes =>
  fatalTextDecoder.decode(toDecodable(bytes));
