// @ts-check

import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { passStyleOf } from '@endo/pass-style';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Assertions } from 'ava' */

/**
 * Build a projector that maps one passable operand into a value AVA's
 * `deepEqual` compares with passable semantics and renders legibly. Each
 * operand gets its own projector (and thus its own `seen` map), so
 * pass-by-reference leaves are compared by *sharing topology* rather than by JS
 * identity: a reference reused within an operand projects to the same index in
 * both operands, while a round-tripped reconstruction (a distinct JS object
 * occupying the same slot) still compares equal.
 *
 * The projection is:
 *
 * - byte-array leaves become objects carrying their hexadecimal contents, so
 *   immutable and emulated byte arrays compare by their bytes with a readable
 *   diff;
 * - `copyArray`, `copyRecord`, and `tagged` containers are rebuilt with their
 *   children projected recursively;
 * - `remotable` and `promise` leaves are pass-by-reference: each distinct
 *   reference projects to a marker carrying a stable index assigned on first
 *   encounter within the operand, so a reference shared across positions
 *   compares equal and an aliasing difference between the operands compares
 *   unequal;
 * - `error` leaves carry both that identity index and their `name`/`message`,
 *   so a reconstructed error compares by its copied diagnostic while aliasing
 *   is still tracked;
 * - atomic leaves (`undefined`, `null`, `boolean`, `number`, `bigint`,
 *   `string`, `symbol`) pass through unchanged for AVA's usual comparison.
 *
 * An unrecognized pass style throws, so a future pass-style addition surfaces
 * here rather than silently comparing by AVA's structural default.
 *
 * @returns {(value: unknown) => unknown}
 */
const makeProjector = () => {
  /** @type {WeakMap<object, number>} identity to stable per-operand index */
  const seen = new WeakMap();
  let nextIndex = 0;
  const indexOf = ref => {
    let index = seen.get(ref);
    if (index === undefined) {
      index = nextIndex;
      nextIndex += 1;
      seen.set(ref, index);
    }
    return index;
  };

  const project = value => {
    const passStyle = passStyleOf(/** @type {Passable} */ (value));
    switch (passStyle) {
      case 'undefined':
      case 'null':
      case 'boolean':
      case 'number':
      case 'bigint':
      case 'string':
      case 'symbol':
        return value;
      case 'byteArray': {
        const comparable = {
          value: encodeHex(/** @type {Uint8Array} */ (value)),
        };
        return Object.defineProperty(comparable, Symbol.toStringTag, {
          value: passStyle,
        });
      }
      case 'copyArray':
        return /** @type {Passable[]} */ (value).map(project);
      case 'copyRecord':
        return Object.fromEntries(
          Object.entries(/** @type {Record<string, Passable>} */ (value)).map(
            ([key, child]) => [key, project(child)],
          ),
        );
      case 'tagged': {
        const tagged = /** @type {{ payload: Passable }} */ (value);
        return Object.defineProperty(
          { payload: project(tagged.payload) },
          Symbol.toStringTag,
          { value: /** @type {object} */ (value)[Symbol.toStringTag] },
        );
      }
      case 'error': {
        const err = /** @type {Error} */ (value);
        const comparable = {
          index: indexOf(err),
          name: err.name,
          message: err.message,
        };
        return Object.defineProperty(comparable, Symbol.toStringTag, {
          value: passStyle,
        });
      }
      case 'promise':
      case 'remotable': {
        const comparable = { index: indexOf(/** @type {object} */ (value)) };
        return Object.defineProperty(comparable, Symbol.toStringTag, {
          value: passStyle,
        });
      }
      default:
        throw Fail`Unexpected pass style ${q(passStyle)}`;
    }
  };
  return project;
};

/**
 * Compare passables with AVA's structural diagnostics, representing byte-array
 * leaves as hexadecimal values so immutable and emulated byte arrays compare by
 * contents, comparing `remotable` and `promise` leaves by sharing topology, and
 * comparing `error` leaves by their copied `name`/`message` plus topology.
 *
 * @param {Assertions} t
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [message]
 * @returns {void}
 */
export const passablesEqual = (t, actual, expected, message = undefined) => {
  t.deepEqual(makeProjector()(actual), makeProjector()(expected), message);
};
harden(passablesEqual);
