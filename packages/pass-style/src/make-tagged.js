import harden from '@endo/harden';
import { Fail } from '@endo/errors';
import { PASS_STYLE } from './pass-style-helpers.js';
import { assertPassable } from './pass-style-of.js';

/**
 * @import {Passable,CopyTagged} from './types.js'
 */

const { create, prototype: objectPrototype } = Object;

/**
 * @template {string} T
 * @template {Passable} P
 * @param {T} tag
 * @param {P} payload
 * @returns {CopyTagged<T,P>}
 */
export const makeTagged = (tag, payload) => {
  typeof tag === 'string' ||
    Fail`The tag of a tagged record must be a string: ${tag}`;
  assertPassable(harden(payload));
  return harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'tagged' },
      [Symbol.toStringTag]: { value: tag },
      payload: { value: payload, enumerable: true },
    }),
  );
};
harden(makeTagged);
