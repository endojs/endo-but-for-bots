import harden from '@endo/harden';

/**
 * @import {ParcelObject} from './types.js';
 */

const { apply, getOwnPropertyDescriptor, getPrototypeOf, ownKeys } = Reflect;
const { isFrozen, prototype: objectPrototype } = Object;
const { toStringTag } = Symbol;
const { get: weakMapGet, has: weakMapHas, set: weakMapSet } = WeakMap.prototype;

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
  const descriptor = getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
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
  const descriptor = getOwnPropertyDescriptor(object, key);
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    !descriptor.enumerable &&
    descriptor.value === expected
  );
};

/**
 * A Parcel is a passable dormant capability with no exposed data. Pass-style
 * senses `globalThis.Parcel` (installed first-wins by `@endo/parcel`) rather
 * than importing the shim, and asks its `isParcel` brand check rather than
 * `instanceof`, which `Object.create` can forge.
 *
 * The global binding cannot be required to be locked, because a child
 * compartment's copy of a shared intrinsic is writable, so an impostor
 * constructor could be trusted. The shape checks below bound that impostor:
 * it is only ever asked about a frozen, empty object inheriting directly from
 * a shim-shaped prototype, after every other pass style has declined it
 * (`test/parcel-pre-shim-fixture.js`). A rejected global may be replaced by a
 * later shim, but a captured valid check stays fixed for this module's
 * lifetime, as `passStyleOf`'s memo requires.
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
 * The brand check's answer for each candidate it was asked about. A frozen
 * `isParcel` can still close over mutable state, so its first answer is kept
 * to make classification stable.
 *
 * @type {WeakMap<object, boolean>}
 */
const decisions = new WeakMap();

/**
 * Validates the shape of a global Parcel constructor. Every step treats
 * `Parcel` as untrusted: a Proxy can run its traps during these reflective
 * operations, which cannot be avoided, but whatever it throws only declines
 * recognition.
 *
 * @param {unknown} Parcel
 * @returns {((value: object) => boolean) | undefined}
 */
const makeBrandCheck = Parcel => {
  if (typeof Parcel !== 'function' || !isFrozen(Parcel)) {
    return undefined;
  }
  const isParcel = getOwnDataValue(Parcel, 'isParcel');
  const prototype = getOwnDataValue(Parcel, 'prototype');
  if (
    typeof isParcel !== 'function' ||
    !isFrozen(isParcel) ||
    typeof prototype !== 'object' ||
    prototype === null ||
    !isFrozen(prototype) ||
    getPrototypeOf(prototype) !== objectPrototype ||
    ownKeys(prototype).length !== 2 ||
    !hasOwnHiddenDataValue(prototype, toStringTag, 'Parcel')
  ) {
    return undefined;
  }
  // A child compartment's shared constructor is not its prototype's
  // constructor, so only the constructor's shape is checked.
  const constructorDescriptor = getOwnPropertyDescriptor(
    prototype,
    'constructor',
  );
  const prototypeConstructor =
    constructorDescriptor !== undefined &&
    'value' in constructorDescriptor &&
    !constructorDescriptor.enumerable
      ? constructorDescriptor.value
      : undefined;
  if (
    typeof prototypeConstructor !== 'function' ||
    !isFrozen(prototypeConstructor) ||
    getOwnDataValue(prototypeConstructor, 'prototype') !== prototype ||
    getOwnDataValue(prototypeConstructor, 'isParcel') !== isParcel
  ) {
    return undefined;
  }
  return value => {
    if (getPrototypeOf(value) !== prototype || ownKeys(value).length !== 0) {
      return false;
    }
    if (apply(weakMapHas, decisions, [value])) {
      return apply(weakMapGet, decisions, [value]);
    }
    if (checking) {
      return false;
    }
    checking = true;
    let decision = false;
    try {
      decision = apply(isParcel, Parcel, [value]) === true;
    } catch {
      // A throwing brand check declines its candidate.
    } finally {
      checking = false;
    }
    apply(weakMapSet, decisions, [value, decision]);
    return decision;
  };
};

/**
 * @returns {((value: object) => boolean) | undefined}
 */
const provideBrandCheck = () => {
  if (brandCheck === undefined) {
    try {
      // Reading through the descriptor avoids invoking a hostile pre-shim
      // accessor on the global object.
      brandCheck = makeBrandCheck(getOwnDataValue(globalThis, 'Parcel'));
    } catch {
      return undefined;
    }
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
