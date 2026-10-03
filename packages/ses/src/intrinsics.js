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
// interinsicsCollector.addIntrinsics, from the named properties of a global
// object.
// An intrinsic named in `presampled` takes its value from there instead of a
// fresh read of the global object; an `undefined` value there means absent.
/**
 * @param {any} globalObject
 * @param {Record<string, string>} newPropertyNames
 * @param {Record<string, unknown>} [presampled]
 */
function sampleGlobals(
  globalObject,
  newPropertyNames,
  presampled = { __proto__: null },
) {
  const newIntrinsics = { __proto__: null };
  for (const [globalName, intrinsicName] of entries(newPropertyNames)) {
    if (hasOwn(presampled, intrinsicName)) {
      const value = presampled[intrinsicName];
      if (value !== undefined) {
        newIntrinsics[intrinsicName] = value;
      }
    } else if (hasOwn(globalObject, globalName)) {
      newIntrinsics[intrinsicName] = globalObject[globalName];
    }
  }
  return newIntrinsics;
}

/**
 * The `SturdyRef` permit admits any function under that global name, but SES
 * shares it with every compartment only because the `@endo/sturdyref` shim
 * confers no authority. Before admitting it, check for the shim's identifying
 * statics, `enliven` and `isSturdyRef`, as own data properties holding
 * functions, and for an own `prototype` data property holding an object, as
 * every class constructor has and an arrow or bound function lacks. The shim's
 * own `isSturdyRefConstructor` reads its statics by `[[Get]]`, so it also
 * accepts inherited or accessor statics; this check is stricter, and reads the
 * global binding and each property by descriptor, without running a getter,
 * refusing an accessor global. Unlike other universal globals, which `lockdown`
 * simply overwrites when configurable, an accessor `SturdyRef` throws even when
 * configurable: its getter could return a different value on each read.
 *
 * This is a misconfiguration guard, not an authority boundary: it catches an
 * unrelated application `SturdyRef` global or a broken shim, but any
 * constructor with those two statics passes, whatever it closes over.
 *
 * Returns the validated value as a record for `makeIntrinsicsCollector`, which
 * admits exactly that value rather than reading the global again: reading the
 * candidate's properties can run a Proxy trap that re-points the global.
 *
 * @param {object} globalObject
 * @returns {{ SturdyRef: unknown }}
 */
export const sampleSturdyRef = globalObject => {
  if (!hasOwn(globalObject, 'SturdyRef')) {
    return freeze({ __proto__: null, SturdyRef: undefined });
  }
  // Read the binding by descriptor so no getter runs.
  const binding = getOwnPropertyDescriptor(globalObject, 'SturdyRef');
  if (binding === undefined || !hasOwn(binding, 'value')) {
    throw TypeError(
      'lockdown expected globalThis.SturdyRef to be a data property, not an accessor',
    );
  }
  const candidate = binding.value;
  /**
   * @param {string} name
   * @param {(value: unknown) => boolean} predicate
   */
  const hasOwnData = (name, predicate) => {
    const descriptor = getOwnPropertyDescriptor(candidate, name);
    return (
      descriptor !== undefined &&
      hasOwn(descriptor, 'value') &&
      predicate(descriptor.value)
    );
  };
  if (
    typeof candidate !== 'function' ||
    !hasOwnData('enliven', isFunction) ||
    !hasOwnData('isSturdyRef', isFunction) ||
    !hasOwnData('prototype', value => !isPrimitive(value))
  ) {
    throw TypeError(
      'lockdown expected globalThis.SturdyRef to be the @endo/sturdyref constructor, with a prototype and enliven and isSturdyRef statics',
    );
  }
  return freeze({ __proto__: null, SturdyRef: candidate });
};

/**
 * @param {Reporter} reporter
 * @param {Record<string, unknown>} [presampled] universal intrinsics already
 * validated, admitted as given rather than read again from `globalThis`.
 */
export const makeIntrinsicsCollector = (
  reporter,
  presampled = { __proto__: null },
) => {
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
  addIntrinsics(sampleGlobals(globalThis, universalPropertyNames, presampled));

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
