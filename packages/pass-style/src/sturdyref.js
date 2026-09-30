import harden from '@endo/harden';

/**
 * @import {SturdyRef} from './types.js';
 */

const { apply } = Reflect;

/**
 * A SturdyRef is passable, analogous to a presence: it has object identity
 * and no data. Pass-style recognizes one using the realm's
 * `SturdyRef.isSturdyRef` brand check alone, per the layer-1 shim contract
 * (`designs/sturdyref-shim-contract.md`). It never uses `instanceof`, because
 * a prototype chain can be forged with `Object.create`, and it never reads
 * anything from the ref, because a ref is opaque.
 *
 * Pass-style does not depend on `@endo/sturdyref`. It senses the realm's
 * `globalThis.SturdyRef`, which the shim installs first-wins and then never
 * replaces. Until some copy of the shim has installed it, no ref that this
 * realm shares can exist, so nothing is recognized. Once found, the brand
 * check is captured, so a SturdyRef stays a SturdyRef for the life of the
 * realm, as `passStyleOf`'s memo requires.
 *
 * @type {((value: object) => boolean) | undefined}
 */
let brandCheck;

/**
 * @param {object} candidate an object that is already known to be frozen
 * @returns {candidate is SturdyRef}
 */
export const isSturdyRefObject = candidate => {
  if (brandCheck === undefined) {
    const SturdyRef = /** @type {any} */ (globalThis).SturdyRef;
    if (typeof SturdyRef !== 'function') {
      return false;
    }
    const { isSturdyRef } = SturdyRef;
    if (typeof isSturdyRef !== 'function') {
      return false;
    }
    brandCheck = value => apply(isSturdyRef, SturdyRef, [value]) === true;
  }
  return brandCheck(candidate);
};
harden(isSturdyRefObject);
