import harden from '@endo/harden';

/**
 * @import {SturdyRefObject} from './types.js';
 */

const { apply, getOwnPropertyDescriptor, getPrototypeOf, ownKeys } = Reflect;
const { isFrozen, prototype: objectPrototype } = Object;
const { toStringTag } = Symbol;

/**
 * Reads an own data property without invoking an accessor, which could throw
 * or answer differently each time.
 *
 * @param {object} object
 * @param {PropertyKey} key
 * @returns {unknown} the value, or `undefined` if there is no such own data
 * property
 */
const getOwnDataValue = (object, key) => {
  const desc = getOwnPropertyDescriptor(object, key);
  return desc !== undefined && 'value' in desc ? desc.value : undefined;
};

/**
 * Like the `remotable` family's tag records, the properties of a SturdyRef
 * prototype must be non-enumerable data properties.
 *
 * @param {object} object
 * @param {PropertyKey} key
 * @param {unknown} expected
 * @returns {boolean}
 */
const hasOwnHiddenDataValue = (object, key, expected) => {
  const desc = getOwnPropertyDescriptor(object, key);
  return (
    desc !== undefined &&
    'value' in desc &&
    !desc.enumerable &&
    desc.value === expected
  );
};

/**
 * A SturdyRef is passable, analogous to a presence: it has object identity
 * and no data. Pass-style recognizes one using the `SturdyRef.isSturdyRef`
 * brand check of its global's `SturdyRef` constructor, as installed by
 * `@endo/sturdyref` (see that package's README). It never uses `instanceof`,
 * because a prototype chain can be forged with `Object.create`, and it never
 * reads anything from the ref, because a ref is opaque.
 *
 * Pass-style does not depend on `@endo/sturdyref`. It senses
 * `globalThis.SturdyRef`, which the shim installs first-wins and then never
 * replaces. Note that `globalThis` is the global of the compartment that
 * loaded this module. A child compartment sees the same constructor only when
 * the shim was installed before `lockdown`, which makes `SturdyRef` a shared
 * intrinsic.
 *
 * Pass-style trusts the first constructor it finds that is frozen, together
 * with its `isSturdyRef` static and its `prototype`, and then captures it, so
 * a SturdyRef stays a SturdyRef for as long as this module lives, as
 * `passStyleOf`'s memo requires. The global binding itself cannot be required
 * to be locked, because a child compartment's copy of a shared intrinsic is
 * writable. A constructor installed by something other than the shim could
 * therefore be trusted. To bound what such an impostor can do, the brand
 * check is only ever asked about a candidate that is shaped like a SturdyRef:
 * frozen, with no own properties, and inheriting directly from the captured
 * `SturdyRef.prototype`. That prototype must itself be shaped like the
 * shim's: inheriting directly from `Object.prototype`, with only its
 * `constructor` and its `Symbol.toStringTag` of `'SturdyRef'`, both
 * non-enumerable data properties, so an impostor cannot give its refs
 * inherited behavior. Pass-style reads the constructor's `isSturdyRef` and
 * `prototype` only as own data properties, so a global carrying a throwing
 * accessor is simply not trusted. `passStyleOf` also asks only after every
 * other pass style has declined the candidate. So an impostor never sees an object of any
 * other pass style, and can only make passable empty objects that inherit from
 * its own prototype, which would otherwise be rejected
 * (`test/sturdyref-lying-global.test.js` pins this bound). A brand check that
 * throws, or returns anything other than `true`, rejects the candidate.
 *
 * @type {((value: object) => boolean) | undefined}
 */
let brandCheck;

/**
 * @returns {((value: object) => boolean) | undefined}
 */
const provideBrandCheck = () => {
  if (brandCheck === undefined) {
    const SturdyRef = /** @type {any} */ (globalThis).SturdyRef;
    if (typeof SturdyRef !== 'function' || !isFrozen(SturdyRef)) {
      return undefined;
    }
    const isSturdyRef = getOwnDataValue(SturdyRef, 'isSturdyRef');
    const prototype = getOwnDataValue(SturdyRef, 'prototype');
    if (
      typeof isSturdyRef !== 'function' ||
      !isFrozen(isSturdyRef) ||
      typeof prototype !== 'object' ||
      prototype === null ||
      !isFrozen(prototype) ||
      getPrototypeOf(prototype) !== objectPrototype ||
      ownKeys(prototype).length !== 2 ||
      !hasOwnHiddenDataValue(prototype, 'constructor', SturdyRef) ||
      !hasOwnHiddenDataValue(prototype, toStringTag, 'SturdyRef')
    ) {
      return undefined;
    }
    brandCheck = value => {
      if (getPrototypeOf(value) !== prototype || ownKeys(value).length !== 0) {
        return false;
      }
      try {
        return apply(isSturdyRef, SturdyRef, [value]) === true;
      } catch {
        return false;
      }
    };
  }
  return brandCheck;
};

/**
 * @param {object} candidate an object that is already known to be frozen
 * @returns {candidate is SturdyRefObject}
 */
export const isSturdyRefObject = candidate => {
  const check = provideBrandCheck();
  return check !== undefined && check(candidate);
};
harden(isSturdyRefObject);
