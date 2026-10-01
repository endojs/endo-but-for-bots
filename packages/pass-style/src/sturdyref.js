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
 * and no data. Pass-style senses `globalThis.SturdyRef` (installed first-wins
 * by `@endo/sturdyref`) rather than depending on that package, and asks its
 * `isSturdyRef` brand check rather than `instanceof`, which `Object.create`
 * can forge.
 *
 * The global binding cannot be required to be locked, because a child
 * compartment's copy of a shared intrinsic is writable, so an impostor
 * constructor could be trusted. The shape checks below bound that impostor:
 * it is only ever asked about a frozen, empty object inheriting directly from
 * a shim-shaped prototype, after every other pass style has declined it
 * (`test/sturdyref-lying-global.test.js`). The captured check stays fixed for
 * this module's lifetime, as `passStyleOf`'s memo requires.
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
