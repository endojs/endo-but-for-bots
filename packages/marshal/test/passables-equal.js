// @ts-check

import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { passStyleOf } from '@endo/pass-style';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Assertions } from 'ava' */

/**
 * Convert byte-array leaves into ordinary objects that AVA can compare and
 * render. Other passables retain AVA's usual `deepEqual` behavior.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
const makeComparable = value => {
  const passStyle = passStyleOf(value);
  switch (passStyle) {
    case 'byteArray': {
      const comparable = {
        value: encodeHex(/** @type {Uint8Array} */ (value)),
      };
      return Object.defineProperty(comparable, Symbol.toStringTag, {
        value: passStyle,
      });
    }
    case 'copyArray':
      return /** @type {Passable[]} */ (value).map(makeComparable);
    case 'copyRecord':
      return Object.fromEntries(
        Object.entries(/** @type {Record<string, Passable>} */ (value)).map(
          ([key, child]) => [key, makeComparable(child)],
        ),
      );
    case 'tagged': {
      const tagged = /** @type {{ payload: Passable }} */ (value);
      return Object.defineProperty(
        { payload: makeComparable(tagged.payload) },
        Symbol.toStringTag,
        { value: /** @type {object} */ (value)[Symbol.toStringTag] },
      );
    }
    default:
      return value;
  }
};

/**
 * Compare passables with AVA's structural diagnostics, representing byte-array
 * leaves as hexadecimal values so immutable and emulated byte arrays compare
 * by contents.
 *
 * @param {Assertions} t
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [message]
 * @returns {void}
 */
export const passablesEqual = (t, actual, expected, message = undefined) => {
  t.deepEqual(makeComparable(actual), makeComparable(expected), message);
};
harden(passablesEqual);
