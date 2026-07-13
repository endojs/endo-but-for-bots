// @ts-check

/**
 * Portrait encoding helpers: near/broken designator formats and the
 * specials walker that swaps externally-owned tagged values (today,
 * OCapN sturdyrefs) for durable stand-ins before marshalling, and back
 * after unmarshalling.
 */

import harden from '@endo/harden';
import { objectMap } from '@endo/common/object-map.js';
import { passStyleOf, makeTagged, getTag } from '@endo/pass-style';
import { Fail, q } from '@endo/errors';

/**
 * @import { SpecialsCodec } from './types.js'
 * @import { Passable, CopyTagged } from '@endo/pass-style'
 */

/** Designator for a promise, restored as a broken promise. */
export const BROKEN_DESIGNATOR = 'b:';
harden(BROKEN_DESIGNATOR);

/**
 * @param {number} slot
 * @param {string} [facetName]
 */
export const formatNearDesignator = (slot, facetName = undefined) =>
  facetName === undefined ? `n:${slot}` : `n:${slot}.${facetName}`;
harden(formatNearDesignator);

/** @param {string} designator */
export const isNearDesignator = designator => designator.startsWith('n:');
harden(isNearDesignator);

/**
 * @param {string} designator
 * @returns {{ slot: number, facetName: string | undefined }}
 */
export const parseNearDesignator = designator => {
  isNearDesignator(designator) ||
    Fail`not a near designator: ${q(designator)}`;
  const rest = designator.slice(2);
  const dot = rest.indexOf('.');
  const slotText = dot < 0 ? rest : rest.slice(0, dot);
  const facetName = dot < 0 ? undefined : rest.slice(dot + 1);
  const slot = Number(slotText);
  (Number.isSafeInteger(slot) && slot > 0) ||
    Fail`malformed near designator: ${q(designator)}`;
  return harden({ slot, facetName });
};
harden(parseNearDesignator);

/**
 * Recursively rebuild a passable, giving `replaceTagged` first refusal
 * on every tagged node. Remotables, promises, and primitives pass
 * through untouched (by identity), so marshal slot conversion still
 * sees them.
 *
 * @param {Passable} value
 * @param {(tagged: CopyTagged) => Passable | undefined} replaceTagged
 * @returns {Passable}
 */
export const transformTaggeds = (value, replaceTagged) => {
  /** @param {Passable} node @returns {Passable} */
  const recur = node => {
    const style = passStyleOf(node);
    switch (style) {
      case 'copyArray': {
        return harden(
          /** @type {Passable[]} */ (node).map(child => recur(child)),
        );
      }
      case 'copyRecord': {
        return harden(
          objectMap(/** @type {Record<string, Passable>} */ (node), child =>
            recur(child),
          ),
        );
      }
      case 'tagged': {
        const tagged = /** @type {CopyTagged} */ (node);
        const replacement = replaceTagged(tagged);
        if (replacement !== undefined) {
          return replacement;
        }
        return makeTagged(getTag(tagged), recur(tagged.payload));
      }
      default: {
        return node;
      }
    }
  };
  return recur(value);
};
harden(transformTaggeds);

/**
 * @param {Passable} value
 * @param {SpecialsCodec} [specials]
 */
export const encodeSpecials = (value, specials) =>
  specials === undefined
    ? value
    : transformTaggeds(value, specials.encodeTagged);
harden(encodeSpecials);

/**
 * @param {Passable} value
 * @param {SpecialsCodec} [specials]
 */
export const decodeSpecials = (value, specials) =>
  specials === undefined
    ? value
    : transformTaggeds(value, tagged => {
        const decoded = specials.decodeTagged(tagged);
        return /** @type {Passable | undefined} */ (decoded);
      });
harden(decodeSpecials);
