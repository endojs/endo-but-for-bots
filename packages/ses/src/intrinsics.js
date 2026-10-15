import { cauterizeProperty } from './cauterize-property.js';
import {
  TypeError,
  WeakSet,
  arrayFilter,
  create,
  defineProperty,
  entries,
  freeze,
  getOwnPropertyDescriptor,
  getOwnPropertyDescriptors,
  globalThis,
  is,
  isPrimitive,
  hasOwn,
  values,
  weaksetHas,
} from './commons.js';

import {
  constantProperties,
  sharedGlobalPropertyNames,
  universalPropertyNames,
  permitted,
} from './permits.js';

/**
 * @import {Reporter} from './reporting-types.js'
 */

const isFunction = obj => typeof obj === 'function';

// Like defineProperty, but throws if it would modify an existing property.
// We use this to ensure that two conflicting attempts to define the same
// property throws, causing SES initialization to fail. Otherwise, a
// conflict between, for example, two of SES's internal permits might
// get masked as one overwrites the other. Accordingly, the thrown error
// complains of a "Conflicting definition".
function initProperty(obj, name, desc) {
  if (hasOwn(obj, name)) {
    const preDesc = getOwnPropertyDescriptor(obj, name);
    if (
      !preDesc ||
      !is(preDesc.value, desc.value) ||
      preDesc.get !== desc.get ||
      preDesc.set !== desc.set ||
      preDesc.writable !== desc.writable ||
      preDesc.enumerable !== desc.enumerable ||
      preDesc.configurable !== desc.configurable
    ) {
      throw TypeError(`Conflicting definitions of ${name}`);
    }
  }
  defineProperty(obj, name, desc);
}

// Like defineProperties, but throws if it would modify an existing property.
// This ensures that the intrinsics added to the intrinsics collector object
// graph do not overlap.
function initProperties(obj, descs) {
  for (const [name, desc] of entries(descs)) {
    initProperty(obj, name, desc);
  }
}

// sampleGlobals creates an intrinsics object, suitable for
// intrinsicsCollector.addIntrinsics, from the named properties of a global
// object.
function sampleGlobals(globalObject, newPropertyNames) {
  const newIntrinsics = { __proto__: null };
  for (const [globalName, intrinsicName] of entries(newPropertyNames)) {
    if (hasOwn(globalObject, globalName)) {
      newIntrinsics[intrinsicName] = globalObject[globalName];
    }
  }
  return newIntrinsics;
}

/**
 * @typedef {object} ParcelSample
 * @property {any} Parcel the shim-installed constructor
 * @property {(parcel: unknown) => Promise<unknown>} open
 * @property {(value: unknown) => boolean} isParcel
 * @property {object} prototype
 */

/**
 * Validate a pre-lockdown `globalThis.Parcel` and snapshot the members SES
 * delegates to, reading each by descriptor so that no getter or Proxy `get`
 * trap can substitute a different value later.
 * Returns `undefined` when no `Parcel` global is present.
 * Throws a `TypeError` for an accessor binding or a value that lacks the
 * `@endo/parcel` constructor shape.
 *
 * @param {object} globalObject
 * @returns {ParcelSample | undefined}
 */
export const sampleParcel = globalObject => {
  if (!hasOwn(globalObject, 'Parcel')) {
    return undefined;
  }
  // Read the binding by descriptor so no getter runs.
  const binding = getOwnPropertyDescriptor(globalObject, 'Parcel');
  if (binding === undefined || !hasOwn(binding, 'value')) {
    throw TypeError(
      'lockdown expected globalThis.Parcel to be a data property, not an accessor',
    );
  }
  const candidate = binding.value;
  /** @type {Record<string, any>} */
  const snapshot = { __proto__: null };
  /**
   * @param {string} name
   * @param {(value: unknown) => boolean} predicate
   */
  const hasOwnData = (name, predicate) => {
    const descriptor = getOwnPropertyDescriptor(candidate, name);
    if (
      descriptor === undefined ||
      !hasOwn(descriptor, 'value') ||
      !predicate(descriptor.value)
    ) {
      return false;
    }
    snapshot[name] = descriptor.value;
    return true;
  };
  // A class constructor's `prototype` is non-writable and non-configurable.
  // Requiring that pins the value: a Proxy candidate must then report the same
  // `prototype` to `completePrototypes`, which reads it by `[[Get]]`, as it
  // reported here by descriptor.
  const isLockedPrototype = () => {
    const descriptor = getOwnPropertyDescriptor(candidate, 'prototype');
    return (
      descriptor !== undefined &&
      descriptor.writable === false &&
      descriptor.configurable === false
    );
  };
  if (
    typeof candidate !== 'function' ||
    !hasOwnData('open', isFunction) ||
    !hasOwnData('locate', isFunction) ||
    !hasOwnData('isParcel', isFunction) ||
    !hasOwnData('prototype', value => !isPrimitive(value)) ||
    !isLockedPrototype()
  ) {
    throw TypeError(
      'lockdown expected globalThis.Parcel to be the @endo/parcel constructor, with a prototype and open, locate, and isParcel statics',
    );
  }
  return freeze({
    Parcel: candidate,
    open: snapshot.open,
    isParcel: snapshot.isParcel,
    prototype: snapshot.prototype,
  });
};

/**
 * @param {Reporter} reporter
 */
export const makeIntrinsicsCollector = reporter => {
  /** @type {Record<any, any>} */
  const intrinsics = create(null);
  let pseudoNatives;

  const addIntrinsics = newIntrinsics => {
    initProperties(intrinsics, getOwnPropertyDescriptors(newIntrinsics));
  };
  freeze(addIntrinsics);

  // For each intrinsic, if it has a `.prototype` property, use the
  // permits to find out the intrinsic name for that prototype and add it
  // to the intrinsics.
  const completePrototypes = () => {
    for (const [name, intrinsic] of entries(intrinsics)) {
      if (isPrimitive(intrinsic)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (!hasOwn(intrinsic, 'prototype')) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const permit = permitted[name];
      if (typeof permit !== 'object') {
        throw TypeError(`Expected permit object at permits.${name}`);
      }
      const namePrototype = permit.prototype;
      if (!namePrototype) {
        cauterizeProperty(
          intrinsic,
          'prototype',
          false,
          `${name}.prototype`,
          reporter,
        );
        // eslint-disable-next-line no-continue
        continue;
      }
      if (
        typeof namePrototype !== 'string' ||
        !hasOwn(permitted, namePrototype)
      ) {
        throw TypeError(`Unrecognized ${name}.prototype permits entry`);
      }
      const intrinsicPrototype = intrinsic.prototype;
      if (hasOwn(intrinsics, namePrototype)) {
        if (intrinsics[namePrototype] !== intrinsicPrototype) {
          throw TypeError(`Conflicting bindings of ${namePrototype}`);
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      intrinsics[namePrototype] = intrinsicPrototype;
    }
  };
  freeze(completePrototypes);

  const finalIntrinsics = () => {
    freeze(intrinsics);
    pseudoNatives = new WeakSet(arrayFilter(values(intrinsics), isFunction));
    return intrinsics;
  };
  freeze(finalIntrinsics);

  const isPseudoNative = obj => {
    if (!pseudoNatives) {
      throw TypeError(
        'isPseudoNative can only be called after finalIntrinsics',
      );
    }
    return weaksetHas(pseudoNatives, obj);
  };
  freeze(isPseudoNative);

  const intrinsicsCollector = {
    addIntrinsics,
    completePrototypes,
    finalIntrinsics,
    isPseudoNative,
  };
  freeze(intrinsicsCollector);

  addIntrinsics(constantProperties);
  addIntrinsics(sampleGlobals(globalThis, universalPropertyNames));

  return intrinsicsCollector;
};

/**
 * getGlobalIntrinsics()
 * Doesn't tame, delete, or modify anything. Samples globalObject to create an
 * intrinsics record containing only the permitted global variables, listed
 * by the intrinsic names appropriate for new globals, i.e., the globals of
 * newly constructed compartments.
 *
 * WARNING:
 * If run before lockdown, the returned intrinsics record will carry the
 * *original* unsafe (feral, untamed) bindings of these global variables.
 *
 * @param {object} globalObject
 * @param {Reporter} reporter
 */
export const getGlobalIntrinsics = (globalObject, reporter) => {
  // TODO pass a proper reporter to `makeIntrinsicsCollector`
  const { addIntrinsics, finalIntrinsics } = makeIntrinsicsCollector(reporter);

  addIntrinsics(sampleGlobals(globalObject, sharedGlobalPropertyNames));

  return finalIntrinsics();
};
