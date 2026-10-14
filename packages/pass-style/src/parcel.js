import harden from '@endo/harden';

/**
 * @import {ParcelObject} from './types.js';
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
 * Like the `remotable` family's tag records, the properties of a Parcel
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
 * A Parcel is passable, analogous to a presence: it has object identity
 * and no data. Pass-style senses `globalThis.Parcel` (installed first-wins
 * by `@endo/parcel`) rather than depending on that package, and asks its
 * `isParcel` brand check rather than `instanceof`, which `Object.create`
 * can forge.
 *
 * The global binding cannot be required to be locked, because a child
 * compartment's copy of a shared intrinsic is writable, so an impostor
 * constructor could be trusted. The shape checks below bound that impostor:
 * it is only ever asked about a frozen, empty object inheriting directly from
 * a shim-shaped prototype, after every other pass style has declined it
 * (`test/parcel-lying-global.test.js`). The captured check stays fixed for
 * this module's lifetime, as `passStyleOf`'s memo requires.
 *
 * @type {((value: object) => boolean) | undefined}
 */
let brandCheck;

/**
 * Whether the brand check is already running. `passStyleOf`'s cycle guard is
 * per call, so an `isParcel` that calls back into `passStyleOf` would
 * otherwise recurse without bound. A reentrant check rejects its candidate.
 */
let checking = false;

/**
 * @returns {((value: object) => boolean) | undefined}
 */
const provideBrandCheck = () => {
  if (brandCheck === undefined) {
    const Parcel = /** @type {any} */ (globalThis).Parcel;
    if (typeof Parcel !== 'function' || !isFrozen(Parcel)) {
      return undefined;
    }
    const isParcel = getOwnDataValue(Parcel, 'isParcel');
    const prototype = getOwnDataValue(Parcel, 'prototype');
    const prototypeConstructor =
      typeof prototype === 'object' && prototype !== null
        ? getOwnDataValue(prototype, 'constructor')
        : undefined;
    if (
      typeof isParcel !== 'function' ||
      !isFrozen(isParcel) ||
      typeof prototype !== 'object' ||
      prototype === null ||
      !isFrozen(prototype) ||
      getPrototypeOf(prototype) !== objectPrototype ||
      ownKeys(prototype).length !== 2 ||
      typeof prototypeConstructor !== 'function' ||
      !isFrozen(prototypeConstructor) ||
      getOwnDataValue(prototypeConstructor, 'prototype') !== prototype ||
      getOwnDataValue(prototypeConstructor, 'isParcel') !== isParcel ||
      !hasOwnHiddenDataValue(prototype, toStringTag, 'Parcel')
    ) {
      return undefined;
    }
    brandCheck = value => {
      if (getPrototypeOf(value) !== prototype || ownKeys(value).length !== 0) {
        return false;
      }
      if (checking) {
        return false;
      }
      checking = true;
      try {
        return apply(isParcel, Parcel, [value]) === true;
      } catch {
        return false;
      } finally {
        checking = false;
      }
    };
  }
  return brandCheck;
};

/**
 * @param {object} candidate an object that is already known to be frozen
 * @returns {candidate is ParcelObject}
 */
export const isParcelObject = candidate => {
  const check = provideBrandCheck();
  return check !== undefined && check(candidate);
};
harden(isParcelObject);
