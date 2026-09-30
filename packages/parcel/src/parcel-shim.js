/* The first copy to define `globalThis.Parcel` owns the private table.
 * Later copies adopt its visible initial or shared constructor.
 */

import harden from '@endo/harden';

/** @import { Parcel, ParcelOpenHook } from './types.js' */

const { defineProperty, freeze, getOwnPropertyDescriptor } = Object;
const { apply } = Reflect;

const SafeWeakMap = WeakMap;
const { get: weakMapGet, set: weakMapSet, has: weakMapHas } = WeakMap.prototype;
const SafePromise = Promise;
const { then: promiseThen } = Promise.prototype;
const SafeTypeError = TypeError;

const symbolForHarden = Symbol.for('harden');

const isHardenInstalled = () =>
  typeof (/** @type {any} */ (Object)[symbolForHarden]) === 'function' ||
  typeof (/** @type {any} */ (globalThis).harden) === 'function';

/**
 * @typedef {object} ParcelStatics
 * @property {(parcel: Parcel) => Promise<unknown>} open
 * @property {(value: unknown) => value is Parcel} isParcel
 */

/**
 * @typedef {(new (location: string, openHook: ParcelOpenHook) => Parcel) &
 *   ParcelStatics} SharedParcelConstructor
 */

/**
 * @typedef {SharedParcelConstructor & {
 *   locate: (parcel: Parcel) => string,
 * }} ParcelConstructor
 */

/** @typedef {ParcelConstructor | SharedParcelConstructor} AnyParcelConstructor */

/**
 * Make a fresh initial Parcel constructor with its own private table.
 *
 * @returns {ParcelConstructor}
 */
export const makeParcelConstructor = () => {
  /** @type {WeakMap<object, { location: string, openHook: ParcelOpenHook }>} */
  const details = new SafeWeakMap();

  class Parcel {
    /**
     * @param {string} location
     * @param {ParcelOpenHook} openHook
     */
    constructor(location, openHook) {
      if (new.target.prototype !== Parcel.prototype) {
        throw SafeTypeError(
          'Parcel construction requires the shared Parcel prototype',
        );
      }
      if (typeof location !== 'string') {
        throw SafeTypeError('Parcel location must be a string');
      }
      if (typeof openHook !== 'function') {
        throw SafeTypeError('Parcel open hook must be a function');
      }
      const parcel = /** @type {Parcel} */ (/** @type {unknown} */ (this));
      freeze(parcel);
      apply(weakMapSet, details, [parcel, freeze({ location, openHook })]);
    }

    /**
     * @param {unknown} value
     * @returns {value is Parcel}
     */
    static isParcel(value) {
      return apply(weakMapHas, details, [value]);
    }

    /**
     * @param {Parcel} parcel
     * @returns {Promise<unknown>}
     */
    static open(parcel) {
      const settled = new SafePromise(resolve => resolve(undefined));
      return apply(promiseThen, settled, [
        () => {
          const entry = apply(weakMapGet, details, [parcel]);
          if (entry === undefined) {
            throw SafeTypeError('Parcel.open: not a Parcel');
          }
          return apply(entry.openHook, undefined, [entry.location, parcel]);
        },
      ]);
    }

    /**
     * @param {Parcel} parcel
     * @returns {string}
     */
    static locate(parcel) {
      const entry = apply(weakMapGet, details, [parcel]);
      if (entry === undefined) {
        throw SafeTypeError('Parcel.locate expects a Parcel');
      }
      return entry.location;
    }
  }

  defineProperty(Parcel.prototype, Symbol.toStringTag, {
    value: 'Parcel',
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // Before lockdown SES still needs to repoint prototype.constructor while it
  // creates %SharedParcel%, so only instances are frozen at construction time.
  // A constructor created after lockdown can be hardened immediately.
  if (isHardenInstalled()) {
    harden(Parcel);
  }

  return /** @type {ParcelConstructor} */ (/** @type {unknown} */ (Parcel));
};

/**
 * @param {object} candidate
 * @param {PropertyKey} key
 */
const hasOwnFunctionDataProperty = (candidate, key) => {
  const descriptor = getOwnPropertyDescriptor(candidate, key);
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    typeof descriptor.value === 'function'
  );
};

/**
 * Validate without invoking any candidate accessor. An adopted constructor may
 * be either the initial form (with `locate`) or SES's shared form (without it).
 *
 * @param {unknown} candidate
 * @returns {candidate is AnyParcelConstructor}
 */
const isParcelConstructor = candidate => {
  if (typeof candidate !== 'function') {
    return false;
  }
  return (
    hasOwnFunctionDataProperty(candidate, 'open') &&
    hasOwnFunctionDataProperty(candidate, 'isParcel') &&
    getOwnPropertyDescriptor(candidate, 'prototype')?.value !== undefined &&
    (getOwnPropertyDescriptor(candidate, 'locate') === undefined ||
      hasOwnFunctionDataProperty(candidate, 'locate'))
  );
};

/**
 * Race to install or adopt the realm's visible Parcel constructor.
 *
 * @returns {AnyParcelConstructor}
 */
export const selectParcel = () => {
  const descriptor = getOwnPropertyDescriptor(globalThis, 'Parcel');
  if (descriptor !== undefined) {
    if (!('value' in descriptor) || !isParcelConstructor(descriptor.value)) {
      throw SafeTypeError(
        '@endo/parcel expected globalThis.Parcel to be an initial or shared Parcel constructor',
      );
    }
    const existing = descriptor.value;
    if (descriptor.configurable || descriptor.writable) {
      defineProperty(globalThis, 'Parcel', {
        value: existing,
        enumerable: descriptor.configurable ? false : descriptor.enumerable,
        writable: false,
        configurable: false,
      });
    }
    return existing;
  }

  if (isHardenInstalled()) {
    throw SafeTypeError(
      '@endo/parcel must install Parcel before lockdown unless a valid constructor is already visible',
    );
  }

  const Parcel = makeParcelConstructor();
  defineProperty(globalThis, 'Parcel', {
    value: Parcel,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Parcel;
};

/** @type {AnyParcelConstructor | undefined} */
let selected;

/** @returns {AnyParcelConstructor} */
export const provideParcel = () => {
  if (selected === undefined) {
    selected = selectParcel();
  }
  return selected;
};
