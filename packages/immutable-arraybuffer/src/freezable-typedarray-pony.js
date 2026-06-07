/* global globalThis */

import { makeInternalHeir } from './internal-heir.js';
import {
  hiddenBuffers,
  reverseHiddenBuffers,
  FERAL_GET_ARRAY_BUFFER,
} from './immutable-arraybuffer-pony-internal.js';

/**
 * @import {TypedArray} from './immutable-arraybuffer-pony-internal.js';
 */

const {
  Object,
  Reflect,
  WeakMap,
  TypeError,
  Uint8Array,
  Symbol,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const {
  freeze,
  getOwnPropertyDescriptor,
  getOwnPropertyDescriptors,
  defineProperties,
  getPrototypeOf,
  setPrototypeOf,
} = Object;
const { apply, construct } = Reflect;
const { get: weakMapGet, set: weakMapSet } = WeakMap.prototype;
const TypedArray = getPrototypeOf(Uint8Array);
const { prototype: typedArrayPrototype } = TypedArray;
const { iterator: symbolIterator, toStringTag: symbolToStringTag } = Symbol;

/**
 * If we could use classes with private fields everywhere, this would have
 * been a `this.#typedArray` private field on a `FreezableTypedArrayInternal`
 * class. But we currently cannot do so on Hermes. So, instead, we
 * emulate the `this.#typedArray` private field, including its use as a
 * brand check.
 * Maps from all and only emulated Freezable TypedArrays to genuine
 * TypedArrays.
 *
 * NOTE: this is for use within this module, and must not be accessible from
 * outside this package.
 *
 * @type {Pick<WeakMap<TypedArray, TypedArray>, 'get' | 'has' | 'set'>}
 */
const hiddenTypedArrays = new WeakMap();

/**
 * Returns the genuine TypedArray amplified from `freezableTA`. If
 * `freezableTA` is an emulated freezable TypedArray, returns the hidden
 * genuine TypedArray that the emulated wrapper amplifies. Otherwise
 * (`freezableTA` is itself a genuine TypedArray that the shim's
 * pseudo-constructor produced via the non-immutable fall-through path),
 * returns `freezableTA`.
 *
 * The fall-through to `freezableTA` is what lets the shim install the
 * pseudo-constructor as the global TypedArray ctor without breaking
 * standard TypedArray use: instances constructed from a non-hidden
 * first argument flow through `construct(OriginalConstructor, args,
 * new.target)`, end up with `PseudoTypedArrayPrototype` as their
 * prototype, and still need every inherited prototype method to work.
 *
 * @param {TypedArray} freezableTA
 */
const amplifyTypedArray = freezableTA => {
  return apply(weakMapGet, hiddenTypedArrays, [freezableTA]) || freezableTA;
};

/**
 * Used by the shim as the getter for a replacement of
 * `TypedArray.prototype.buffer`, so that this accessor does not leak
 * a hidden genuine ArrayBuffers even if a hidden genuine TypedArray leaks.
 *
 * As a brand check, it should pass if `this` is either a genuine TypedArray
 * or if it is one of our emulated freezable TypedArrays. Thus we
 * cannot use `getHiddenTypedArray` internally, since that brand check
 * only passes the emulated one.
 */
export const virtualTypedArrayBufferGetter = (() => {
  /** @type {ThisType<TypedArray>} */
  const obj = {
    get buffer() {
      const genuineTA = apply(weakMapGet, hiddenTypedArrays, [this]) || this;
      const genuineBuffer = apply(FERAL_GET_ARRAY_BUFFER, genuineTA, []);
      return (
        apply(weakMapGet, reverseHiddenBuffers, [genuineBuffer]) ||
        genuineBuffer
      );
    },
  };
  const { get: pseudoGetter } = /** @type {PropertyDescriptor} */ (
    getOwnPropertyDescriptor(obj, 'buffer')
  );
  return freeze(pseudoGetter);
})();

const freezableTypedArrayInternalPrototype = makeInternalHeir(
  typedArrayPrototype,
  'a freezable TypedArray',
  amplifyTypedArray,
  [
    // redirected queries (operate on the amplified genuine TypedArray and
    // return the result; the result is a primitive or a fresh object
    // distinct from `this`).
    //
    // `slice`, `subarray`, `with` and `toReversed`/`toSorted` belong here
    // too: they return new TypedArrays. When the amplified TypedArray's
    // backing buffer is in `reverseHiddenBuffers`, the new TypedArray's
    // `buffer` getter (the virtualTypedArrayBufferGetter installed on
    // %TypedArrayPrototype%) returns the immutable wrapper.
    'at',
    'byteLength',
    'byteOffset',
    'entries',
    'every',
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'forEach',
    'includes',
    'indexOf',
    'join',
    'keys',
    'lastIndexOf',
    'length',
    'map',
    'reduce',
    'reduceRight',
    'slice',
    'some',
    'subarray',
    'toLocaleString',
    'toReversed',
    'toSorted',
    'toString',
    'with',
    symbolIterator,
  ],
  [
    // complaining mutators
    'copyWithin',
    'fill',
    'reverse',
    'set',
    'sort',
  ],
  /** @type {ThisType<TypedArray>} */ ({
    // `buffer` is inherited from %TypedArrayPrototype%; the shim replaces
    // that getter with the virtualTypedArrayBufferGetter so the same
    // inherited slot does the right thing for genuine and emulated cases.
    [symbolToStringTag]: 'FreezableTypedArray',
  }),
);

/**
 * Could be used by the shim to replace all the concrete TypedArray constructors
 * with constructors that also accept an emulated immutable ArrayBuffer
 * argument.
 *
 * @param {any} OriginalConstructor
 */
export const makePseudoTypedArrayConstructor = OriginalConstructor => {
  const PseudoTypedArrayPrototype = {
    __proto__: freezableTypedArrayInternalPrototype,
    // eslint-disable-next-line no-use-before-define
    constructor: PseudoTypedArray,
    BYTES_PER_ELEMENT: OriginalConstructor.BYTES_PER_ELEMENT,
  };

  /**
   * @param {any[]} args
   */
  function PseudoTypedArray(...args) {
    if (new.target === undefined) {
      throw new TypeError(
        `Constructor ${OriginalConstructor.name} requires 'new'`,
      );
    }
    const firstArg = args[0];
    const hiddenBuffer = apply(weakMapGet, hiddenBuffers, [firstArg]);
    if (!hiddenBuffer) {
      return construct(OriginalConstructor, args, new.target);
    }
    if (args.length !== 1) {
      throw new TypeError(`only one ArrayBuffer argument expected`);
    }
    if (new.target !== PseudoTypedArray) {
      throw new TypeError(
        'emulated freezable TypedArray does not (yet?) support subclassing.',
      );
    }
    const hiddenTypedArray = construct(
      OriginalConstructor,
      [hiddenBuffer],
      PseudoTypedArray,
    );

    const freezableTypedArray = {
      __proto__: PseudoTypedArrayPrototype,
    };
    apply(weakMapSet, hiddenTypedArrays, [
      /** @type {TypedArray} */ (/** @type {unknown} */ (freezableTypedArray)),
      hiddenTypedArray,
    ]);
    return freezableTypedArray;
  }

  const constructorDescs = getOwnPropertyDescriptors(OriginalConstructor);
  constructorDescs.prototype.value = PseudoTypedArrayPrototype;

  defineProperties(PseudoTypedArray, constructorDescs);
  setPrototypeOf(PseudoTypedArray, TypedArray);
  return PseudoTypedArray;
};
freeze(makePseudoTypedArrayConstructor);
