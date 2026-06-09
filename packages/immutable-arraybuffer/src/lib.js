/* global globalThis */

const {
  ArrayBuffer,
  Object,
  Reflect,
  TypeError,
  Uint8Array,
  WeakMap,
  // Capture structuredClone before it can be scuttled.
  structuredClone: optStructuredClone,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const { freeze, defineProperty, getOwnPropertyDescriptor, getPrototypeOf } =
  Object;
const { apply, ownKeys } = Reflect;

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
const arrayBufferDetached = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'detached',
)?.get;
const arrayBufferResizable = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'resizable',
)?.get;
const arrayBufferMaxByteLength = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'maxByteLength',
)?.get;

const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const { set: uint8ArraySet } = typedArrayPrototype;
// @ts-expect-error TS doesn't know it'll be there
const { get: uint8ArrayBuffer } = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
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
 * Currently, these known-deficient platforms are
 * - Hermes
 * - Node.js <= 16
 * - Apparently some versions of JavaScriptCore that are still of concern.
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
 * @type {Pick<WeakMap<ArrayBuffer, ArrayBuffer>, 'get' | 'has' | 'set'>}
 */
const buffers = new WeakMap();
// Avoid post-hoc prototype lookups.
for (const methodName of ['get', 'has', 'set']) {
  defineProperty(buffers, methodName, { value: buffers[methodName] });
}
// Safe because this WeakMap owns its has, get, and set methods.
// eslint-disable-next-line @endo/no-polymorphic-call
const isEmulatedImmutable = buf => buffers.has(buf);

/**
 * Amplifier-with-this-fallthrough: returns the underlying genuine
 * `ArrayBuffer` when `immuAB` is an emulated immutable buffer (in the brand
 * WeakMap), and returns `immuAB` itself otherwise. This lets the methods on
 * the shared `ArrayBuffer.prototype` (after the shim install) work as
 * drop-in replacements for the genuine methods when invoked on a genuine
 * `ArrayBuffer`, while transparently reaching the underlying buffer for the
 * emulated-immutable case. The name aligns with the analogous
 * `amplifyTypedArray` on the freezable-TypedArray experiment branch.
 *
 * @param {ArrayBuffer} immuAB
 * @returns {ArrayBuffer}
 */
const amplifyArrayBuffer = immuAB => {
  // Safe because this WeakMap owns its get method.
  // eslint-disable-next-line @endo/no-polymorphic-call
  const result = buffers.get(immuAB);
  if (result !== undefined) {
    return result;
  }
  return immuAB;
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
 * Omits `constructor` so `ArrayBuffer.prototype.constructor` is inherited.
 */
const immutableArrayBufferLibProperties = {
  __proto__: null,
  get byteLength() {
    return apply(arrayBufferByteLength, amplifyArrayBuffer(this), []);
  },
  get detached() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    // Genuine `ArrayBuffer.prototype.detached` is a stage-finished accessor
    // on platforms with the resizable-ArrayBuffer proposal. On older
    // platforms (Node <= 18, Hermes) it does not exist; the conservative
    // answer for a non-detached genuine buffer in that case is false.
    if (arrayBufferDetached === undefined) {
      return false;
    }
    return apply(arrayBufferDetached, this, []);
  },
  get maxByteLength() {
    if (isEmulatedImmutable(this)) {
      // For an emulated immutable buffer, maxByteLength is byteLength: it
      // cannot grow.
      return apply(arrayBufferByteLength, amplifyArrayBuffer(this), []);
    }
    if (arrayBufferMaxByteLength === undefined) {
      return apply(arrayBufferByteLength, this, []);
    }
    return apply(arrayBufferMaxByteLength, this, []);
  },
  get resizable() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    if (arrayBufferResizable === undefined) {
      return false;
    }
    return apply(arrayBufferResizable, this, []);
  },
  get immutable() {
    return isEmulatedImmutable(this);
  },
  slice(start = undefined, end = undefined) {
    return arrayBufferSlice(amplifyArrayBuffer(this), start, end);
  },
  sliceToImmutable(start = undefined, end = undefined) {
    // eslint-disable-next-line no-use-before-define
    return sliceBufferToImmutable(amplifyArrayBuffer(this), start, end);
  },
  resize(newByteLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot resize an immutable ArrayBuffer');
    }
    return apply(optResize, this, [newByteLength]);
  },
  transfer(newLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot detach an immutable ArrayBuffer');
    }
    return apply(optTransfer, this, [newLength]);
  },
  transferToFixedLength(newLength = undefined) {
    if (isEmulatedImmutable(this)) {
      throw TypeError('Cannot detach an immutable ArrayBuffer');
    }
    return apply(optTransferToFixedLength, this, [newLength]);
  },
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

export { immutableArrayBufferLibProperties };

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
  // Safe because this WeakMap owns its set method.
  // eslint-disable-next-line @endo/no-polymorphic-call
  buffers.set(result, realBuffer);
  return result;
};
// Since `makeImmutableArrayBufferInternal` MUST not escape,
// this `freeze` is just belt-and-suspenders.
freeze(makeImmutableArrayBufferInternal);

/**
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export const isBufferImmutable = buffer => isEmulatedImmutable(buffer);

/**
 * Creates an immutable slice of the given buffer. Internal helper used by
 * `immutableArrayBufferLibProperties.sliceToImmutable` and by the shim's
 * own install. Not part of the package's public export surface.
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
  // Safe because this WeakMap owns its get method.
  // eslint-disable-next-line @endo/no-polymorphic-call
  let realBuffer = buffers.get(buffer);
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
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (newLength <= oldLength) {
        buffer = arrayBufferSlice(buffer, 0, newLength);
      } else {
        const oldTA = new Uint8Array(buffer);
        const newTA = new Uint8Array(newLength);
        apply(uint8ArraySet, newTA, [oldTA]);
        buffer = apply(uint8ArrayBuffer, newTA, []);
      }
    }
    const result = makeImmutableArrayBufferInternal(buffer);
    return /** @type {ArrayBuffer} */ (/** @type {unknown} */ (result));
  };
} else {
  transferBufferToImmutable = undefined;
}

export const optTransferBufferToImmutable = transferBufferToImmutable;
