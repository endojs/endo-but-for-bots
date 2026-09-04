/* global globalThis */
const {
  ArrayBuffer,
  DataView,
  Object,
  Reflect,
  Symbol,
  TypeError,
  Uint8Array,
  WeakMap,
  // Capture structuredClone before it can be scuttled.
  structuredClone: optStructuredClone,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const {
  freeze,
  defineProperty,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  setPrototypeOf,
  create,
  entries,
} = Object;
const { apply, ownKeys, construct } = Reflect;

// Capture the WeakMap prototype methods up front so we can use them with
// `apply` below, without exposing the `buffers` WeakMap to post-hoc
// prototype lookups or polymorphic dispatch.
const { get: weakmapGet, set: weakmapSet, has: weakmapHas } = WeakMap.prototype;

const { prototype: arrayBufferPrototype } = ArrayBuffer;
const {
  slice,
  transfer: optTransfer,
  resize: optResize,
  transferToFixedLength: optTransferToFixedLength,
} = arrayBufferPrototype;
// @ts-expect-error TS doesn't know it'll be there
const { get: arrayBufferByteLength } = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'byteLength',
);

// Capture the resizable-ArrayBuffer proposal's accessors when present. On
// platforms without that proposal (Node <= 18, Hermes), these are absent;
// the fallthrough branches in the lib property record short-circuit on
// brand membership and never reach the captured accessor in that case
// (an emulated immutable always has `detached === false`, `resizable ===
// false`, and `maxByteLength === byteLength`).
const optArrayBufferDetached = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'detached',
)?.get;
const optArrayBufferResizable = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'resizable',
)?.get;
const optArrayBufferMaxByteLength = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'maxByteLength',
)?.get;

const { prototype: dataViewPrototype } = DataView;
const {
  getBigInt64: dataViewGetBigInt64,
  getBigUint64: dataViewGetBigUint64,
  getFloat16: optDataViewGetFloat16,
  getFloat32: dataViewGetFloat32,
  getFloat64: dataViewGetFloat64,
  getInt8: dataViewGetInt8,
  getInt16: dataViewGetInt16,
  getInt32: dataViewGetInt32,
  getUint8: dataViewGetUint8,
  getUint16: dataViewGetUint16,
  getUint32: dataViewGetUint32,
  setBigInt64: dataViewSetBigInt64,
  setBigUint64: dataViewSetBigUint64,
  setFloat16: optDataViewSetFloat16,
  setFloat32: dataViewSetFloat32,
  setFloat64: dataViewSetFloat64,
  setInt8: dataViewSetInt8,
  setInt16: dataViewSetInt16,
  setInt32: dataViewSetInt32,
  setUint8: dataViewSetUint8,
  setUint16: dataViewSetUint16,
  setUint32: dataViewSetUint32,
} = dataViewPrototype;
// @ts-expect-error TS doesn't know it'll be there
const { get: dataViewBufferGetter } = getOwnPropertyDescriptor(
  dataViewPrototype,
  'buffer',
);
// @ts-expect-error TS doesn't know it'll be there
const { get: dataViewByteLengthGetter } = getOwnPropertyDescriptor(
  dataViewPrototype,
  'byteLength',
);
// @ts-expect-error TS doesn't know it'll be there
const { get: dataViewByteOffsetGetter } = getOwnPropertyDescriptor(
  dataViewPrototype,
  'byteOffset',
);

// %TypedArray% is the abstract superclass of all TypedArray constructors.
// `getPrototypeOf(Uint8Array)` reaches it via the constructor's prototype chain.
// Captured before the shim can shadow any of the global TypedArray constructors.
const TypedArray = getPrototypeOf(Uint8Array);

const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const { set: uint8ArraySet } = typedArrayPrototype;
// @ts-expect-error TS doesn't know it'll be there
const { get: typedArrayBufferGetter } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
);

// Capture all %TypedArrayPrototype% methods and accessors before the shim can
// shadow them. The five mutator methods are used for the brand-check throw /
// delegate pattern; all read-only methods are used for the amplifier-delegate
// pattern (plain wrappers delegate to the hidden genuine TypedArray).
const {
  copyWithin: typedArrayCopyWithin,
  entries: typedArrayEntries,
  every: typedArrayEvery,
  fill: typedArrayFill,
  filter: typedArrayFilter,
  find: typedArrayFind,
  findIndex: typedArrayFindIndex,
  findLast: typedArrayFindLast,
  findLastIndex: typedArrayFindLastIndex,
  forEach: typedArrayForEach,
  includes: typedArrayIncludes,
  indexOf: typedArrayIndexOf,
  join: typedArrayJoin,
  keys: typedArrayKeys,
  lastIndexOf: typedArrayLastIndexOf,
  map: typedArrayMap,
  reduce: typedArrayReduce,
  reduceRight: typedArrayReduceRight,
  reverse: typedArrayReverse,
  set: typedArraySet,
  slice: typedArraySlice,
  some: typedArraySome,
  sort: typedArraySort,
  subarray: typedArraySubarray,
  toLocaleString: typedArrayToLocaleString,
  toString: typedArrayToString,
  values: typedArrayValues,
  at: typedArrayAt,
  toReversed: typedArrayToReversed,
  toSorted: typedArrayToSorted,
  with: typedArrayWith,
} = typedArrayPrototype;

// Capture read-accessor getters for byteLength, byteOffset, and length.
// @ts-expect-error TS doesn't know they'll be there
const { get: typedArrayByteLengthGetter } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
);
// @ts-expect-error TS doesn't know they'll be there
const { get: typedArrayByteOffsetGetter } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset',
);
// @ts-expect-error TS doesn't know they'll be there
const { get: typedArrayLengthGetter } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length',
);
// Capture the genuine, `this`-sensitive `[Symbol.toStringTag]` getter. It reads
// the receiver's `[[TypedArrayName]]` internal slot, returning the flavor name
// (`'Uint8Array'`, …) for a genuine TypedArray and `undefined` for anything
// without the slot. The shim's replacement getter (below) delegates to this via
// the amplifier so an emulated wrapper resolves to its hidden genuine TypedArray
// first — closing the `Object.prototype.toString` fidelity gap.
// @ts-expect-error TS doesn't know it'll be there
const { get: typedArrayToStringTagGetter } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
);

/**
 * Copy a range of values from a genuine ArrayBuffer exotic object into a new
 * ArrayBuffer.
 *
 * @param {ArrayBuffer} realBuffer
 * @param {number} [start]
 * @param {number} [end]
 * @returns {ArrayBuffer}
 */
const arrayBufferSlice = (realBuffer, start = undefined, end = undefined) =>
  apply(slice, realBuffer, [start, end]);

/**
 * Move the contents of a genuine ArrayBuffer exotic object into a new fresh
 * ArrayBuffer and detach the original source.
 * We can only do this on platforms that support `structuredClone` or
 * `ArrayBuffer.prototype.transfer`.
 * On other platforms, we can still emulate
 * `ArrayBuffer.prototoype.sliceToImmutable`, but not
 * `ArrayBuffer.prototype.transferToImmutable`.
 * See the package README section "Platform support for `transferToImmutable`"
 * for the per-engine version thresholds and feature-testing guidance.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {ArrayBuffer}
 */
let optArrayBufferTransfer;

if (optTransfer) {
  optArrayBufferTransfer = arrayBuffer => apply(optTransfer, arrayBuffer, []);
} else if (optStructuredClone) {
  optArrayBufferTransfer = arrayBuffer => {
    // Hopefully, a zero-length slice is cheap, but still enforces that
    // `arrayBuffer` is a genuine `ArrayBuffer` exotic object.
    arrayBufferSlice(arrayBuffer, 0, 0);
    return optStructuredClone(arrayBuffer, {
      transfer: [arrayBuffer],
    });
  };
} else {
  // Assignment is redundant, but remains for clarity.
  optArrayBufferTransfer = undefined;
}

/**
 * If we could use classes with private fields everywhere, this would have
 * been a `this.#buffer` private field on an `ImmutableArrayBufferInternal`
 * class. But we cannot do so on Hermes. So, instead, we
 * emulate the `this.#buffer` private field, including its use as a brand check.
 * Maps from all and only emulated Immutable ArrayBuffers to real ArrayBuffers.
 *
 * @type {WeakMap<ArrayBuffer, ArrayBuffer>}
 */
const buffers = new WeakMap();

/**
 * Inverse map: genuine backing ArrayBuffer -> emulated immutable wrapper.
 * Every entry is installed alongside its inverse in `buffers`, so consumers
 * can rely on the two maps describing the same pairs.
 *
 * @type {WeakMap<ArrayBuffer, ArrayBuffer>}
 */
const reverseBuffers = new WeakMap();

const isEmulatedImmutable = buf => apply(weakmapHas, buffers, [buf]);

/**
 * Amplifier-with-this-fallthrough: returns the underlying genuine
 * `ArrayBuffer` when `arrayBuffer` is an emulated immutable buffer (in the
 * brand WeakMap), and returns `arrayBuffer` itself otherwise. This lets the
 * methods on the shared `ArrayBuffer.prototype` (after the shim install)
 * work as drop-in replacements for the genuine methods when invoked on a
 * genuine `ArrayBuffer`, while transparently reaching the underlying buffer
 * for the emulated-immutable case. The name aligns with the analogous
 * `amplifyTypedArray` on the freezable-TypedArray experiment branch.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {ArrayBuffer}
 */
const amplifyArrayBuffer = arrayBuffer => {
  const result = apply(weakmapGet, buffers, [arrayBuffer]);
  if (result !== undefined) {
    return result;
  }
  return arrayBuffer;
};

/**
 * A plain record of the properties the shim copies onto
 * `ArrayBuffer.prototype` to install immutable-ArrayBuffer support. This is
 * not a prototype of any object: emulated immutable buffers directly inherit
 * from `ArrayBuffer.prototype`, and the methods here become the ones the
 * (now shared) prototype dispatches to. Each method either calls
 * `amplifyArrayBuffer(this)` to reach the underlying buffer (read accessors,
 * `slice`, `sliceToImmutable`) or discriminates on brand WeakMap membership
 * and delegates to the captured genuine method on fallthrough (the mutators
 * `resize`, `transfer`, `transferToFixedLength`, `transferToImmutable`).
 *
 * Omits `constructor` so the original `ArrayBuffer.prototype.constructor` is unchanged.
 */
export const immutableArrayBufferLibProperties = {
  __proto__: null,
  /**
   * @this {ArrayBuffer}
   */
  get byteLength() {
    return apply(arrayBufferByteLength, amplifyArrayBuffer(this), []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get detached() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    // Genuine `ArrayBuffer.prototype.detached` is a stage-finished accessor
    // on platforms with the resizable-ArrayBuffer proposal. On older
    // platforms (Node <= 18, Hermes) it does not exist; the conservative
    // answer for a non-detached genuine buffer in that case is false.
    if (optArrayBufferDetached === undefined) {
      return false;
    }
    return apply(optArrayBufferDetached, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get maxByteLength() {
    if (isEmulatedImmutable(this)) {
      // For an emulated immutable buffer, maxByteLength is byteLength: it
      // cannot grow.
      return apply(arrayBufferByteLength, amplifyArrayBuffer(this), []);
    }
    if (optArrayBufferMaxByteLength === undefined) {
      return apply(arrayBufferByteLength, this, []);
    }
    return apply(optArrayBufferMaxByteLength, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get resizable() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    if (optArrayBufferResizable === undefined) {
      return false;
    }
    return apply(optArrayBufferResizable, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get immutable() {
    return isEmulatedImmutable(this);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [start]
   * @param {number} [end]
   */
  slice(start = undefined, end = undefined) {
    return arrayBufferSlice(amplifyArrayBuffer(this), start, end);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [start]
   * @param {number} [end]
   */
  sliceToImmutable(start = undefined, end = undefined) {
    // eslint-disable-next-line no-use-before-define
    return sliceBufferToImmutable(amplifyArrayBuffer(this), start, end);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newByteLength]
   */
  resize(newByteLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot resize an immutable ArrayBuffer');
    }
    if (optResize === undefined) {
      throw TypeError(
        'Cannot resize ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.resize',
      );
    }
    return apply(optResize, this, [newByteLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transfer(newLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot detach an immutable ArrayBuffer');
    }
    if (optTransfer === undefined) {
      throw TypeError(
        'Cannot transfer ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.transfer',
      );
    }
    return apply(optTransfer, this, [newLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transferToFixedLength(newLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot detach an immutable ArrayBuffer');
    }
    if (optTransferToFixedLength === undefined) {
      throw TypeError(
        'Cannot transferToFixedLength ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.transferToFixedLength',
      );
    }
    return apply(optTransferToFixedLength, this, [newLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transferToImmutable(newLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot detach an immutable ArrayBuffer');
    }
    // eslint-disable-next-line no-use-before-define
    if (optTransferBufferToImmutable === undefined) {
      throw TypeError(
        'Cannot transfer to immutable: underlying platform lacks transfer or structuredClone',
      );
    }
    // eslint-disable-next-line no-use-before-define
    return optTransferBufferToImmutable(this, newLength);
  },
};

// Better fidelity emulation of a class prototype: each property is
// non-enumerable, matching the shape `ArrayBuffer.prototype` itself uses.
for (const key of ownKeys(immutableArrayBufferLibProperties)) {
  defineProperty(immutableArrayBufferLibProperties, key, {
    enumerable: false,
  });
}
// Do not freeze: the shim passes these descriptors directly to
// `defineProperties`, and frozen descriptors (configurable: false,
// writable: false) would conflict with SES's later tamings. Leave the
// record unfrozen so descriptors are directly usable.

// Internal-test export. The helper itself is load-bearing for every
// method on `immutableArrayBufferLibProperties`, but the package's
// public export surface intentionally keeps it private (callers either
// touch the helper indirectly through `ArrayBuffer.prototype` methods
// or rely on `isBufferImmutable`). The export exists so the
// adversarial-tests skill can exercise the helper in isolation.
export { amplifyArrayBuffer as _amplifyArrayBufferForTests };

/**
 * Emulates what would have been the encapsulated `ImmutableArrayBufferInternal`
 * class constructor. This function takes the `realBuffer` which its
 * result encapsulates. Security demands that this result has exclusive access
 * to the `realBuffer` it is given, which its callers must ensure.
 *
 * The emulated immutable buffer directly inherits from `ArrayBuffer.prototype`.
 * The brand WeakMap is the sole discriminator: `ArrayBuffer.prototype`'s
 * methods (after the shim installs the lib properties) check brand membership
 * to decide whether to treat the receiver as immutable.
 *
 * @param {ArrayBuffer} realBuffer
 * @returns {ArrayBuffer}
 */
const makeImmutableArrayBufferInternal = realBuffer => {
  const result = /** @type {ArrayBuffer} */ (
    /** @type {unknown} */ ({
      __proto__: arrayBufferPrototype,
    })
  );
  // Install `[Symbol.toStringTag] = 'emulated immutable ArrayBuffer'` as an own
  // property of each emulated immutable buffer (not on the shared prototype,
  // which must retain the genuine `'ArrayBuffer'` tag so genuine instances
  // continue to read as `[object ArrayBuffer]`). This is the minimum
  // departure from designs/immutable-arraybuffer.md Move 2 paragraph 7 needed to keep
  // `concordance` (and any downstream consumer that sniffs the toStringTag)
  // from misrouting an emulated immutable through `Buffer.from`, which
  // throws because the emulated immutable is not a genuine exotic. With the
  // own-property slot in place, `Object.prototype.toString.call(immuAB)`
  // returns `'[object emulated immutable ArrayBuffer]'` and concordance routes the
  // value through its unrenderable-value path. Genuine ArrayBuffers
  // continue to inherit `'ArrayBuffer'` from the prototype. The tag spells
  // out `emulated` so no toStringTag-sniffing consumer can mistake the
  // wrapper for an actual `ArrayBuffer` (review of
  // endojs/endo-but-for-bots#475, gibson042).
  defineProperty(result, Symbol.toStringTag, {
    value: 'emulated immutable ArrayBuffer',
    writable: false,
    enumerable: false,
    configurable: false,
  });
  apply(weakmapSet, buffers, [result, realBuffer]);
  apply(weakmapSet, reverseBuffers, [realBuffer, result]);
  return result;
};
// Since `makeImmutableArrayBufferInternal` MUST not escape,
// this `freeze` is just belt-and-suspenders.
freeze(makeImmutableArrayBufferInternal);

/**
 * Internal brand check. Returns `true` when `buffer` is an emulated
 * immutable buffer (in the lib's brand WeakMap), `false` otherwise. After
 * the premise-2 fold-in the package no longer exports this from a public
 * entry point; callers use `buffer.immutable` (the accessor installed by
 * the shim on `ArrayBuffer.prototype`) or `Object.prototype.toString
 * .call(buffer) === '[object emulated immutable ArrayBuffer]'`. The internal export
 * lets the in-package tests (`test/lib-*.test.js`) reach the helper
 * directly without round-tripping through the prototype.
 *
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export const isBufferImmutable = buffer => isEmulatedImmutable(buffer);

/**
 * Creates an immutable slice of the given buffer. Internal helper used by
 * `immutableArrayBufferLibProperties.sliceToImmutable` and by the shim's
 * own install. After the premise-2 fold-in the package no longer exports
 * this from a public entry point; the internal export lets the in-package
 * tests reach it directly.
 *
 * @param {ArrayBuffer} buffer The original buffer.
 * @param {number} [start] The start index.
 * @param {number} [end] The end index.
 * @returns {ArrayBuffer} The sliced immutable ArrayBuffer.
 */
export const sliceBufferToImmutable = (
  buffer,
  start = undefined,
  end = undefined,
) => {
  let realBuffer = apply(weakmapGet, buffers, [buffer]);
  if (realBuffer === undefined) {
    realBuffer = buffer;
  }
  return makeImmutableArrayBufferInternal(
    arrayBufferSlice(realBuffer, start, end),
  );
};

let transferBufferToImmutable;
if (optArrayBufferTransfer) {
  /**
   * Transfer the contents to a new Immutable ArrayBuffer. Internal helper
   * used by `immutableArrayBufferLibProperties.transferToImmutable` and by
   * the shim's own install. Not part of the package's public export surface.
   *
   * @param {ArrayBuffer} buffer The original buffer.
   * @param {number} [newLength] The start index.
   * @returns {ArrayBuffer}
   */
  transferBufferToImmutable = (buffer, newLength = undefined) => {
    if (newLength === undefined) {
      buffer = optArrayBufferTransfer(buffer);
    } else if (optTransfer) {
      buffer = apply(optTransfer, buffer, [newLength]);
    } else {
      buffer = optArrayBufferTransfer(buffer);
      const oldLength = buffer.byteLength;

      if (newLength <= oldLength) {
        buffer = arrayBufferSlice(buffer, 0, newLength);
      } else {
        const oldTypedArray = new Uint8Array(buffer);
        const newTypedArray = new Uint8Array(newLength);
        apply(uint8ArraySet, newTypedArray, [oldTypedArray]);
        buffer = apply(typedArrayBufferGetter, newTypedArray, []);
      }
    }
    const result = makeImmutableArrayBufferInternal(buffer);
    return /** @type {ArrayBuffer} */ (/** @type {unknown} */ (result));
  };
} else {
  transferBufferToImmutable = undefined;
}

export const optTransferBufferToImmutable = transferBufferToImmutable;

// Freezable TypedArray emulation
//
// The design document is at:
//   packages/immutable-arraybuffer/designs/freezable-typedarray.md
//
// This section extends the immutable-ArrayBuffer lib surface with two exported bindings:
//   - makeEmulatedTypedArrayConstructor (export; factory for per-flavor emulated constructors)
//   - freezableTypedArrayLibProperties (export; property record the shim copies onto
//                                       %TypedArrayPrototype%)
//
// The following are module-internal:
//   - hiddenTypedArrays  (brand WeakMap)
//   - amplifyTypedArray  (returns the hidden genuine TypedArray or the receiver on fallthrough)
//   - emulatedTypedArrayBufferGetter  (getter for %TypedArrayPrototype%.buffer)
//
// The internal `buffers` and `reverseBuffers` WeakMaps from the ArrayBuffer
// side are reused for `view.buffer` redirections.

/**
 * Brand WeakMap for emulated freezable TypedArray wrappers. Maps each wrapper
 * to its hidden genuine TypedArray (the one constructed from the actual
 * underlying ArrayBuffer). The genuine TypedArray is the storage delegate;
 * the wrapper is the public-facing object.
 *
 * @type {WeakMap<TypedArray, TypedArray>}
 */
const hiddenTypedArrays = new WeakMap();

/**
 * Brand WeakMap for emulated DataView wrappers. The hidden genuine DataView
 * performs reads against the genuine backing ArrayBuffer while the ordinary
 * wrapper is safe to freeze.
 *
 * @type {WeakMap<DataView, DataView>}
 */
const hiddenDataViews = new WeakMap();

/**
 * Amplifier-with-this-fallthrough for freezable TypedArrays. Returns the
 * hidden genuine TypedArray when `typedArray` is an emulated freezable wrapper
 * (present in the brand WeakMap), and returns `typedArray` itself otherwise.
 * This lets the methods on `%TypedArrayPrototype%` (after the shim install)
 * work as drop-in replacements for genuine TypedArrays.
 *
 * @param {TypedArray} typedArray
 * @returns {TypedArray}
 */
const amplifyTypedArray = typedArray => {
  const result = apply(weakmapGet, hiddenTypedArrays, [typedArray]);
  if (result !== undefined) {
    return result;
  }
  return typedArray;
};

/**
 * Getter that replaces `%TypedArrayPrototype%.buffer`.
 * When `this` is an emulated freezable wrapper (registered in `hiddenTypedArrays`),
 * it returns the immutable ArrayBuffer wrapper via `reverseBuffers`. Otherwise
 * it delegates to the captured genuine `%TypedArrayPrototype%.buffer` getter.
 *
 * Declared via concise method syntax (inside a temporary object literal) rather
 * than a `function` declaration or `function`-keyword expression. A
 * `function`-keyword function has both `[[Construct]]` and `[[Call]]` behaviors
 * (callable with `new`) and an irrelevant `prototype` property pointing at an
 * extra object, so `freeze` of such a function is not equivalent to `harden`
 * and leaves behind hazardous mutability. An arrow function cannot be used
 * here because this getter must be `this`-sensitive. Concise method syntax
 * avoids both problems: the method has only `[[Call]]`, no `prototype`
 * property, and no `[[Construct]]`.
 *
 * The surrounding `const` binding avoids JavaScript function-declaration
 * hoisting. In the presence of an import cycle a hoisted function
 * declaration's value is available to an importing module before the exporting
 * module finishes initializing, which can expose uninitialized state. A `const`
 * binding produces a Temporal Dead Zone (TDZ) error for the early importer
 * instead.
 * Note: the ses-shim's compiler from JS ESM module code to JS evaluable code
 * does not implement TDZ correctly, so this cycle hazard may not be caught at
 * runtime under ses-shim.
 * XS uses native compartment and module support and does implement TDZ, so the
 * hazard would be caught there.
 * This particular PR introduces no such import cycle; the note is for future
 * maintainers.
 * See the README section "Function expressions versus declarations" for full
 * context (erights review comments 3439479281, 3439500526).
 */
const typedArrayGetters = {
  /** @type {(this: object) => ArrayBuffer} */
  get buffer() {
    const genuineTypedArray = apply(weakmapGet, hiddenTypedArrays, [this]);
    if (genuineTypedArray !== undefined) {
      // The hidden genuine TypedArray's buffer is the genuine backing buffer.
      const genuineArrayBuffer = apply(
        typedArrayBufferGetter,
        genuineTypedArray,
        [],
      );
      // Return the immutable wrapper (reverseBuffers maps genuine -> wrapper).
      const immutableWrapper = apply(weakmapGet, reverseBuffers, [
        genuineArrayBuffer,
      ]);
      if (immutableWrapper !== undefined) {
        return immutableWrapper;
      }
      return genuineArrayBuffer;
    }
    // Fallthrough: delegate to the genuine getter.
    return apply(typedArrayBufferGetter, this, []);
  },
};

// `getOwnPropertyDescriptor` returns `PropertyDescriptor | undefined`, but
// the `buffer` accessor was just defined on `typedArrayGetters` so the descriptor is
// always present. The `PropertyDescriptor` cast informs TypeScript of this.
const emulatedTypedArrayBufferGetter =
  /** @type {(this: object) => ArrayBuffer} */ (
    /** @type {PropertyDescriptor} */ (
      getOwnPropertyDescriptor(typedArrayGetters, 'buffer')
    ).get
  );

/**
 * Factory for per-flavor emulated constructors. Each emulated constructor replaces
 * the corresponding global TypedArray constructor (for example `Uint8Array`).
 * When called with an emulated immutable ArrayBuffer as the first argument, it
 * produces an emulated freezable TypedArray wrapper. For all other call shapes
 * it falls through to the genuine constructor via `Reflect.construct`.
 *
 * The wrapper is a plain ordinary object whose `[[Prototype]]` is
 * `OriginalConstructor.prototype`. This is the "drop-the-pseudo-prototype"
 * shape: no intermediate prototype exists between the wrapper and the genuine
 * prototype.
 *
 * @param {Function} OriginalConstructor - The genuine TypedArray constructor to wrap.
 * @returns {Function} A emulated constructor with the same `.name` and `.prototype`.
 */
export const makeEmulatedTypedArrayConstructor = OriginalConstructor => {
  /**
   * @param {...any} args
   * @returns {object}
   */
  function EmulatedTypedArray(...args) {
    // Determine whether the first argument is an emulated immutable
    // ArrayBuffer.
    const [firstArgument] = args;
    const isHidden =
      firstArgument !== undefined &&
      apply(weakmapHas, buffers, [firstArgument]);

    if (!isHidden) {
      // Fallthrough: delegate to the genuine constructor.
      return construct(
        OriginalConstructor,
        args,
        new.target ?? OriginalConstructor,
      );
    }

    // Emulated-immutable branch.
    // Retrieve the genuine backing ArrayBuffer from the `buffers` WeakMap.
    const genuineArrayBuffer = apply(weakmapGet, buffers, [firstArgument]);

    // Build the remaining constructor arguments using the genuine buffer.
    const [, ...restArgs] = args;
    const genuineTypedArray = construct(OriginalConstructor, [
      genuineArrayBuffer,
      ...restArgs,
    ]);

    // Create the emulated freezable wrapper as a plain object whose prototype
    // is OriginalConstructor.prototype (no intermediate prototype).
    const wrapper = create(OriginalConstructor.prototype);

    // Register the wrapper in the brand WeakMap (wrapper -> genuine TypedArray).
    apply(weakmapSet, hiddenTypedArrays, [wrapper, genuineTypedArray]);

    return wrapper;
  }

  // Preserve the constructor name for debugging and instanceof checks.
  defineProperty(EmulatedTypedArray, 'name', {
    value: OriginalConstructor.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // The `prototype` property must be the genuine prototype so that
  // `instanceof T` and `Object.getPrototypeOf(wrapper) === T.prototype`
  // both hold. We share the genuine prototype rather than creating a new one.
  EmulatedTypedArray.prototype = OriginalConstructor.prototype;

  // Set the `prototype.constructor` to the emulated constructor so that SES's
  // intrinsic walk finds consistency: after we install EmulatedTypedArray as
  // `globalThis.BigInt64Array` (for example), SES samples `BigInt64Array` and
  // resolves it to EmulatedTypedArray. It then walks the permit graph and checks
  // that `intrinsics.%BigInt64ArrayPrototype%.constructor === intrinsics.BigInt64Array`.
  // If `prototype.constructor` still points to the original constructor,
  // that check fails. Updating `prototype.constructor` to EmulatedTypedArray
  // ensures both pointers agree with the intrinsics map.
  //
  // This does NOT affect genuine TypedArray construction:
  // `new OriginalConstructor(realAb)` delegates to the captured genuine
  // constructor via `Reflect.construct`, which ignores `prototype.constructor`.
  defineProperty(OriginalConstructor.prototype, 'constructor', {
    value: EmulatedTypedArray,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // Set the emulated constructor's `[[Prototype]]` to `%TypedArray%` (the
  // abstract TypedArray superclass). SES's intrinsic walk validates that
  // each concrete TypedArray constructor inherits from `%TypedArray%` via the
  // constructor chain (`BigInt64Array.__proto__ === TypedArray`). A plain
  // function's default `Function.prototype` prototype would fail that check.
  setPrototypeOf(EmulatedTypedArray, TypedArray);

  // Copy the `BYTES_PER_ELEMENT` static property from the original constructor.
  // Callers such as `packages/captp/src/atomics.js` read this constant
  // directly off the constructor (`BigUint64Array.BYTES_PER_ELEMENT`,
  // `Int32Array.BYTES_PER_ELEMENT`). The shim replaces the global binding with
  // `EmulatedTypedArray`, so the property must be present on the replacement or
  // those reads return `undefined`, making arithmetic expressions produce NaN.
  //
  // `BYTES_PER_ELEMENT` is not inherited through the prototype chain on
  // TypedArray constructors; each concrete constructor carries its own own-
  // property value (8 for BigUint64Array, 4 for Int32Array, etc.).
  defineProperty(EmulatedTypedArray, 'BYTES_PER_ELEMENT', {
    // @ts-expect-error TS2339: BYTES_PER_ELEMENT exists on TypedArray constructors but not on Function
    value: OriginalConstructor.BYTES_PER_ELEMENT,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Do NOT freeze here. SES's `hardenIntrinsics` will freeze all
  // primordials (including the emulated constructors installed on globalThis)
  // as part of `lockdown()`. Pre-freezing would cause SES's pre-lockdown
  // consistency check ("all intrinsics must be unfrozen before repairIntrinsics")
  // to fail. The function is effectively immutable at runtime because the
  // only callers are the shim install path (which has already run) and
  // callers of the returned constructor.
  return EmulatedTypedArray;
};

/**
 * Property record the shim copies onto `%TypedArrayPrototype%`. Contains:
 *
 * - The `buffer`, `byteLength`, `byteOffset`, and `length` accessor
 *   replacements. Each discriminates on `hiddenTypedArrays` brand membership:
 *   on hit it delegates to the hidden genuine TypedArray (amplifier pattern);
 *   on miss it delegates to the captured genuine accessor (fallthrough).
 *
 * - Mutator-throws descriptors for the five mutator methods: `copyWithin`,
 *   `fill`, `reverse`, `set`, `sort`. On emulated freezable wrappers each
 *   throws `TypeError`; on genuine TypedArrays each delegates to the captured
 *   genuine method (the amplifier-with-this-fallthrough shape).
 *
 * - Amplifier-delegate wrappers for all remaining read-only `%TypedArrayPrototype%`
 *   methods. Plain ordinary wrappers cannot be passed as `this` to any native
 *   TypedArray method that checks for integer-indexed exotic internal slots.
 *   The amplifier resolves the wrapper to its hidden genuine TypedArray first,
 *   so the captured genuine method receives a valid `this`.
 *
 * The record's properties are made non-enumerable below, matching the shape
 * of the genuine `%TypedArrayPrototype%`.
 */
export const freezableTypedArrayLibProperties = {
  __proto__: null,

  // Accessors: `buffer`, `byteLength`, `byteOffset`, `length`

  /**
   * @this {object}
   * @returns {ArrayBuffer}
   */
  get buffer() {
    return apply(emulatedTypedArrayBufferGetter, this, []);
  },
  /**
   * @this {object}
   * @returns {number}
   */
  get byteLength() {
    return apply(typedArrayByteLengthGetter, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @returns {number}
   */
  get byteOffset() {
    return apply(typedArrayByteOffsetGetter, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @returns {number}
   */
  get length() {
    return apply(typedArrayLengthGetter, amplifyTypedArray(this), []);
  },

  // `[Symbol.toStringTag]`: amplify then read the genuine internal-slot tag

  /**
   * Replaces the genuine, `this`-sensitive `%TypedArrayPrototype%`
   * `[Symbol.toStringTag]` getter with a wrapper around it. On an emulated
   * freezable wrapper (brand-WeakMap member) it amplifies to the hidden genuine
   * TypedArray and reads *its* tag, so `Object.prototype.toString.call(wrapper)`
   * reads `'[object Uint8Array]'` — matching a genuine view. On a genuine
   * TypedArray it falls through to the genuine getter (amplifier returns `this`
   * unchanged); on any other receiver the genuine getter returns `undefined`,
   * exactly as before.
   *
   * This is the getter-wrapper fidelity fix from erights's review of
   * endojs/endo-but-for-bots#475 (comments 3817252816 / 3817264546): a
   * higher-fidelity repair than installing a `[Symbol.toStringTag]` *data*
   * property, which would patch only the `Object.prototype.toString` lookup
   * path and leave this getter still reporting `undefined` on a wrapper.
   * Because the getter and `Object.prototype.toString` now agree, any brand
   * check that captures *this* (shim-installed) getter — e.g.
   * `@endo/harden`'s `isTypedArray` if it captures after the shim installs —
   * observes an emulated wrapper as a TypedArray.
   *
   * @this {object}
   * @returns {string | undefined}
   */
  get [Symbol.toStringTag]() {
    return apply(typedArrayToStringTagGetter, amplifyTypedArray(this), []);
  },

  // Mutator methods: throw on emulated freezable wrappers

  /**
   * @this {object}
   * @param {number} [target]
   * @param {number} [start]
   * @param {number} [end]
   * @returns {object}
   */
  copyWithin(target = undefined, start = undefined, end = undefined) {
    if (apply(weakmapHas, hiddenTypedArrays, [this])) {
      throw TypeError(
        'Cannot copyWithin on a freezable TypedArray backed by an immutable ArrayBuffer',
      );
    }
    return apply(typedArrayCopyWithin, this, [target, start, end]);
  },
  /**
   * @this {object}
   * @param {any} [value]
   * @param {number} [start]
   * @param {number} [end]
   * @returns {object}
   */
  fill(value = undefined, start = undefined, end = undefined) {
    if (apply(weakmapHas, hiddenTypedArrays, [this])) {
      throw TypeError(
        'Cannot fill a freezable TypedArray backed by an immutable ArrayBuffer',
      );
    }
    return apply(typedArrayFill, this, [value, start, end]);
  },
  /**
   * @this {object}
   * @returns {object}
   */
  reverse() {
    if (apply(weakmapHas, hiddenTypedArrays, [this])) {
      throw TypeError(
        'Cannot reverse a freezable TypedArray backed by an immutable ArrayBuffer',
      );
    }
    return apply(typedArrayReverse, this, []);
  },
  /**
   * @this {object}
   * @param {any} array
   * @param {number} [offset]
   * @returns {void}
   */
  set(array = undefined, offset = undefined) {
    if (apply(weakmapHas, hiddenTypedArrays, [this])) {
      throw TypeError(
        'Cannot set on a freezable TypedArray backed by an immutable ArrayBuffer',
      );
    }
    return apply(typedArraySet, this, [array, offset]);
  },
  /**
   * @this {object}
   * @param {Function} [compareFn]
   * @returns {object}
   */
  sort(compareFn = undefined) {
    if (apply(weakmapHas, hiddenTypedArrays, [this])) {
      throw TypeError(
        'Cannot sort a freezable TypedArray backed by an immutable ArrayBuffer',
      );
    }
    return apply(typedArraySort, this, [compareFn]);
  },

  // Read-only method delegates: amplify then call the captured genuine method

  /**
   * @this {object}
   * @param {number} [index]
   * @returns {any}
   */
  at(index = undefined) {
    return apply(typedArrayAt, amplifyTypedArray(this), [index]);
  },
  /**
   * @this {object}
   * @returns {Iterator}
   */
  entries() {
    return apply(typedArrayEntries, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {boolean}
   */
  every(predicate = undefined, thisArg = undefined) {
    return apply(typedArrayEvery, amplifyTypedArray(this), [
      predicate,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {object}
   */
  filter(predicate = undefined, thisArg = undefined) {
    return apply(typedArrayFilter, amplifyTypedArray(this), [
      predicate,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {any}
   */
  find(predicate = undefined, thisArg = undefined) {
    return apply(typedArrayFind, amplifyTypedArray(this), [predicate, thisArg]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {number}
   */
  findIndex(predicate = undefined, thisArg = undefined) {
    return apply(typedArrayFindIndex, amplifyTypedArray(this), [
      predicate,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {any}
   */
  findLast(predicate = undefined, thisArg = undefined) {
    if (typedArrayFindLast === undefined) {
      throw TypeError(
        'TypedArray.prototype.findLast is not available on this platform',
      );
    }
    return apply(typedArrayFindLast, amplifyTypedArray(this), [
      predicate,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {number}
   */
  findLastIndex(predicate = undefined, thisArg = undefined) {
    if (typedArrayFindLastIndex === undefined) {
      throw TypeError(
        'TypedArray.prototype.findLastIndex is not available on this platform',
      );
    }
    return apply(typedArrayFindLastIndex, amplifyTypedArray(this), [
      predicate,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [callback]
   * @param {any} [thisArg]
   * @returns {void}
   */
  forEach(callback = undefined, thisArg = undefined) {
    return apply(typedArrayForEach, amplifyTypedArray(this), [
      callback,
      thisArg,
    ]);
  },
  /**
   * @this {object}
   * @param {any} searchElement
   * @param {number} [fromIndex]
   * @returns {boolean}
   */
  includes(searchElement = undefined, fromIndex = undefined) {
    return apply(typedArrayIncludes, amplifyTypedArray(this), [
      searchElement,
      fromIndex,
    ]);
  },
  /**
   * @this {object}
   * @param {any} searchElement
   * @param {number} [fromIndex]
   * @returns {number}
   */
  indexOf(searchElement = undefined, fromIndex = undefined) {
    return apply(typedArrayIndexOf, amplifyTypedArray(this), [
      searchElement,
      fromIndex,
    ]);
  },
  /**
   * @this {object}
   * @param {string} [separator]
   * @returns {string}
   */
  join(separator = undefined) {
    return apply(typedArrayJoin, amplifyTypedArray(this), [separator]);
  },
  /**
   * @this {object}
   * @returns {Iterator}
   */
  keys() {
    return apply(typedArrayKeys, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @param {any} searchElement
   * @param {number} [fromIndex]
   * @returns {number}
   */
  lastIndexOf(searchElement = undefined, fromIndex = undefined) {
    return apply(typedArrayLastIndexOf, amplifyTypedArray(this), [
      searchElement,
      fromIndex,
    ]);
  },
  /**
   * @this {object}
   * @param {Function} [callback]
   * @param {any} [thisArg]
   * @returns {object}
   */
  map(callback = undefined, thisArg = undefined) {
    return apply(typedArrayMap, amplifyTypedArray(this), [callback, thisArg]);
  },
  /**
   * @this {object}
   * @param {Function} [callback]
   * @param {any} [initialValue]
   * @returns {any}
   */
  reduce(callback = undefined, initialValue = undefined) {
    return apply(
      typedArrayReduce,
      amplifyTypedArray(this),
      arguments.length > 1 ? [callback, initialValue] : [callback],
    );
  },
  /**
   * @this {object}
   * @param {Function} [callback]
   * @param {any} [initialValue]
   * @returns {any}
   */
  reduceRight(callback = undefined, initialValue = undefined) {
    return apply(
      typedArrayReduceRight,
      amplifyTypedArray(this),
      arguments.length > 1 ? [callback, initialValue] : [callback],
    );
  },
  /**
   * @this {object}
   * @param {number} [start]
   * @param {number} [end]
   * @returns {object}
   */
  slice(start = undefined, end = undefined) {
    return apply(typedArraySlice, amplifyTypedArray(this), [start, end]);
  },
  /**
   * @this {object}
   * @param {Function} [predicate]
   * @param {any} [thisArg]
   * @returns {boolean}
   */
  some(predicate = undefined, thisArg = undefined) {
    return apply(typedArraySome, amplifyTypedArray(this), [predicate, thisArg]);
  },
  /**
   * @this {object}
   * @param {number} [begin]
   * @param {number} [end]
   * @returns {object}
   */
  subarray(begin = undefined, end = undefined) {
    const genuineTypedArray = apply(weakmapGet, hiddenTypedArrays, [this]);
    if (genuineTypedArray !== undefined) {
      // `this` is an emulated freezable wrapper. Delegate to the hidden genuine
      // TypedArray to get the sub-view genuine TypedArray, then wrap it in a new
      // emulated freezable wrapper so the safety contract (`sub.buffer === iab`)
      // holds for sub-views.
      const genuineSubarray = apply(typedArraySubarray, genuineTypedArray, [
        begin,
        end,
      ]);
      // `create(getPrototypeOf(this))` is sufficient rather than calling the
      // emulated constructor because the sub-view wrapper needs exactly three
      // things the parent wrapper already provides:
      //
      // 1. The right prototype. `getPrototypeOf(this)` is
      //    `OriginalConstructor.prototype`, the same prototype the
      //    emulated constructor would set via `create(OriginalConstructor.prototype)`.
      //    The shim's freezable behaviors live on that prototype (installed onto
      //    `%TypedArrayPrototype%`), so they are already inherited.
      //
      // 2. A `hiddenTypedArrays` registration. The line below registers
      //    `subWrapper -> genuineSubarray` in the brand WeakMap, which is what
      //    `amplifyTypedArray` and every method that discriminates on brand
      //    membership require. No other per-instance state is needed.
      //
      // 3. A `reverseBuffers` entry for `view.buffer` redirection. A sub-array
      //    shares its backing buffer with the parent; `typedArraySubarray` does
      //    not allocate a new buffer. The immutable ArrayBuffer constructor
      //    registered the genuine backing buffer's immutable wrapper, so the
      //    sub-view needs no new `reverseBuffers` entry.
      //
      // Static properties (`BYTES_PER_ELEMENT`) live on
      // `OriginalConstructor.prototype.constructor`, not on the instance, so
      // they are also already present via the prototype chain. There is no
      // instance state that the emulated constructor would add that `create` does
      // not already provide.
      const subWrapper = create(getPrototypeOf(this));
      apply(weakmapSet, hiddenTypedArrays, [subWrapper, genuineSubarray]);
      // `reverseBuffers` already maps the genuine backing buffer to the immutable
      // wrapper from when the parent wrapper was constructed; no new entry needed.
      return subWrapper;
    }
    return apply(typedArraySubarray, this, [begin, end]);
  },
  /**
   * @this {object}
   * @param {...any} args
   * @returns {string}
   */
  toLocaleString(...args) {
    return apply(typedArrayToLocaleString, amplifyTypedArray(this), args);
  },
  /**
   * @this {object}
   * @returns {string}
   */
  toString() {
    return apply(typedArrayToString, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @returns {Iterator}
   */
  values() {
    return apply(typedArrayValues, amplifyTypedArray(this), []);
  },
  /**
   * The default iterator for TypedArrays is `%TypedArrayPrototype%.values`.
   * In the baseline runtime `%TypedArrayPrototype%[Symbol.iterator]` is the
   * same function object as `%TypedArrayPrototype%.values`. After the shim
   * installs a new `values` wrapper, `Symbol.iterator` would still point at
   * the original genuine `values` function unless we re-install it here as
   * well. Without this entry, `for...of` loops and spread syntax on emulated
   * freezable wrappers throw `TypeError: this is not a typed array.`
   *
   * @this {object}
   * @returns {Iterator}
   */
  [Symbol.iterator]() {
    return apply(typedArrayValues, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @returns {object}
   */
  toReversed() {
    if (typedArrayToReversed === undefined) {
      throw TypeError(
        'TypedArray.prototype.toReversed is not available on this platform',
      );
    }
    return apply(typedArrayToReversed, amplifyTypedArray(this), []);
  },
  /**
   * @this {object}
   * @param {Function} [compareFn]
   * @returns {object}
   */
  toSorted(compareFn = undefined) {
    if (typedArrayToSorted === undefined) {
      throw TypeError(
        'TypedArray.prototype.toSorted is not available on this platform',
      );
    }
    return apply(typedArrayToSorted, amplifyTypedArray(this), [compareFn]);
  },
  /**
   * @this {object}
   * @param {number} [index]
   * @param {any} [value]
   * @returns {object}
   */
  with(index = undefined, value = undefined) {
    if (typedArrayWith === undefined) {
      throw TypeError(
        'TypedArray.prototype.with is not available on this platform',
      );
    }
    return apply(typedArrayWith, amplifyTypedArray(this), [index, value]);
  },
};

// Make all properties non-enumerable, matching %TypedArrayPrototype%'s shape.
for (const key of ownKeys(freezableTypedArrayLibProperties)) {
  defineProperty(freezableTypedArrayLibProperties, key, {
    enumerable: false,
  });
}
// Do not freeze: the shim passes these descriptors directly to
// `defineProperties`, and frozen descriptors (configurable: false,
// writable: false) would prevent SES's `tameLocaleMethods` from later
// replacing `toLocaleString`. Leave the record unfrozen so descriptors
// are directly usable.

/**
 * The eleven concrete TypedArray constructors that share `%TypedArrayPrototype%`.
 * The shim replaces each with a emulated constructor from `makeEmulatedTypedArrayConstructor`.
 *
 * @type {Array<{name: string, Constructor: Function}>}
 */
export const concreteTypedArrayConstructors = [
  { name: 'Int8Array', Constructor: Int8Array },
  { name: 'Int16Array', Constructor: Int16Array },
  { name: 'Int32Array', Constructor: Int32Array },
  { name: 'Uint8Array', Constructor: Uint8Array },
  { name: 'Uint8ClampedArray', Constructor: Uint8ClampedArray },
  { name: 'Uint16Array', Constructor: Uint16Array },
  { name: 'Uint32Array', Constructor: Uint32Array },
  { name: 'Float32Array', Constructor: Float32Array },
  { name: 'Float64Array', Constructor: Float64Array },
  { name: 'BigInt64Array', Constructor: BigInt64Array },
  { name: 'BigUint64Array', Constructor: BigUint64Array },
];

// Freezable DataView emulation

/** @param {DataView} view */
const amplifyDataView = view => {
  const result = apply(weakmapGet, hiddenDataViews, [view]);
  return result === undefined ? view : result;
};

/**
 * Replacement DataView constructor. Construction over a genuine mutable
 * ArrayBuffer delegates unchanged. Construction over an emulated immutable
 * buffer delegates all argument conversion and range validation to the
 * genuine constructor, then exposes an ordinary, freezable wrapper.
 *
 * @param {...any} args
 * @returns {DataView}
 */
export const EmulatedDataView = function EmulatedDataViewConstructor(...args) {
  if (new.target === undefined) {
    return apply(DataView, undefined, args);
  }
  const [buffer, ...rest] = args;
  if (!apply(weakmapHas, buffers, [buffer])) {
    return construct(DataView, args, new.target);
  }

  const genuineBuffer = apply(weakmapGet, buffers, [buffer]);
  const genuineView = construct(DataView, [genuineBuffer, ...rest]);
  const prototype =
    typeof new.target.prototype === 'object' && new.target.prototype !== null
      ? new.target.prototype
      : dataViewPrototype;
  const wrapper = /** @type {DataView} */ (create(prototype));
  apply(weakmapSet, hiddenDataViews, [wrapper, genuineView]);
  return wrapper;
};

defineProperty(EmulatedDataView, 'name', {
  value: 'DataView',
  writable: false,
  enumerable: false,
  configurable: true,
});
defineProperty(EmulatedDataView, 'length', {
  value: DataView.length,
  writable: false,
  enumerable: false,
  configurable: true,
});
EmulatedDataView.prototype = dataViewPrototype;

/**
 * @param {(...args: any[]) => any} method
 * @param {string} name
 * @returns {(...args: any[]) => any}
 */
const makeDataViewReader = (method, name) => {
  const holder = {
    /**
     * @this {DataView}
     * @param {...any} args
     */
    read(...args) {
      return apply(method, amplifyDataView(this), args);
    },
  };
  defineProperty(holder.read, 'name', { value: name, configurable: true });
  defineProperty(holder.read, 'length', {
    value: method.length,
    configurable: true,
  });
  return holder.read;
};

/**
 * @param {(...args: any[]) => any} method
 * @param {string} name
 * @returns {(...args: any[]) => any}
 */
const makeDataViewWriter = (method, name) => {
  const holder = {
    /**
     * @this {DataView}
     * @param {...any} args
     */
    write(...args) {
      if (apply(weakmapHas, hiddenDataViews, [this])) {
        throw TypeError(
          `Cannot ${name} through a DataView on an immutable ArrayBuffer`,
        );
      }
      return apply(method, this, args);
    },
  };
  defineProperty(holder.write, 'name', { value: name, configurable: true });
  defineProperty(holder.write, 'length', {
    value: method.length,
    configurable: true,
  });
  return holder.write;
};

export const freezableDataViewLibProperties = {
  __proto__: null,
  constructor: EmulatedDataView,
  /** @this {DataView} */
  get buffer() {
    const genuineView = apply(weakmapGet, hiddenDataViews, [this]);
    if (genuineView === undefined) {
      return apply(dataViewBufferGetter, this, []);
    }
    const genuineBuffer = apply(dataViewBufferGetter, genuineView, []);
    return apply(weakmapGet, reverseBuffers, [genuineBuffer]) ?? genuineBuffer;
  },
  /** @this {DataView} */
  get byteLength() {
    return apply(dataViewByteLengthGetter, amplifyDataView(this), []);
  },
  /** @this {DataView} */
  get byteOffset() {
    return apply(dataViewByteOffsetGetter, amplifyDataView(this), []);
  },
};

/** @type {Record<string, (...args: any[]) => any>} */
const dataViewReaders = {
  getBigInt64: dataViewGetBigInt64,
  getBigUint64: dataViewGetBigUint64,
  getFloat32: dataViewGetFloat32,
  getFloat64: dataViewGetFloat64,
  getInt8: dataViewGetInt8,
  getInt16: dataViewGetInt16,
  getInt32: dataViewGetInt32,
  getUint8: dataViewGetUint8,
  getUint16: dataViewGetUint16,
  getUint32: dataViewGetUint32,
};
if (optDataViewGetFloat16 !== undefined) {
  dataViewReaders.getFloat16 = optDataViewGetFloat16;
}
for (const [name, method] of entries(dataViewReaders)) {
  defineProperty(freezableDataViewLibProperties, name, {
    value: makeDataViewReader(method, name),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/** @type {Record<string, (...args: any[]) => any>} */
const dataViewWriters = {
  setBigInt64: dataViewSetBigInt64,
  setBigUint64: dataViewSetBigUint64,
  setFloat32: dataViewSetFloat32,
  setFloat64: dataViewSetFloat64,
  setInt8: dataViewSetInt8,
  setInt16: dataViewSetInt16,
  setInt32: dataViewSetInt32,
  setUint8: dataViewSetUint8,
  setUint16: dataViewSetUint16,
  setUint32: dataViewSetUint32,
};
if (optDataViewSetFloat16 !== undefined) {
  dataViewWriters.setFloat16 = optDataViewSetFloat16;
}
for (const [name, method] of entries(dataViewWriters)) {
  defineProperty(freezableDataViewLibProperties, name, {
    value: makeDataViewWriter(method, name),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

for (const key of ownKeys(freezableDataViewLibProperties)) {
  defineProperty(freezableDataViewLibProperties, key, { enumerable: false });
}
