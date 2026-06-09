/* global globalThis */

import {
  isBufferImmutable,
  sliceBufferToImmutable,
  optTransferBufferToImmutable as optXferBuf2Immu,
} from './immutable-arraybuffer-pony.js';
import {
  virtualTypedArrayBufferGetter,
  makePseudoTypedArrayConstructor,
} from './freezable-typedarray-pony.js';

const {
  ArrayBuffer,
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Object,
  Reflect,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

// Even though the imported one is not exported by the pony as a live binding,
// TS doesn't know that,
// so it cannot do its normal flow-based inference. By making and using a local
// copy, no problem.
const optTransferBufferToImmutable = optXferBuf2Immu;

const {
  defineProperties,
  defineProperty,
  getOwnPropertyDescriptors,
  getPrototypeOf,
} = Object;
const { ownKeys } = Reflect;
const { prototype: arrayBufferPrototype } = ArrayBuffer;

// Race-to-install: if a prior apparent native implementation has already
// installed the immutable-ArrayBuffer surface (the most characteristic of
// the new methods is `sliceToImmutable`), do nothing. The race here is
// the simpler form: detect-then-skip. Unlike the harden race
// (`endo/packages/harden/src/make-selector.js`), this shim does not pin
// a chosen implementation through a shared registered Symbol; it makes
// a unilateral check on `arrayBufferPrototype` and yields to any prior
// installer.
if (!('sliceToImmutable' in arrayBufferPrototype)) {
  const arrayBufferMethods = {
    /**
     * Creates an immutable slice of the given buffer.
     *
     * @this {ArrayBuffer} buffer The original buffer.
     * @param {number} [start] The start index.
     * @param {number} [end] The end index.
     * @returns {ArrayBuffer} The sliced immutable ArrayBuffer.
     */
    sliceToImmutable(start = undefined, end = undefined) {
      return sliceBufferToImmutable(this, start, end);
    },

    /**
     * @this {ArrayBuffer}
     */
    get immutable() {
      return isBufferImmutable(this);
    },

    ...(optTransferBufferToImmutable
      ? {
          /**
           * Transfer the contents to a new immutable ArrayBuffer
           *
           * @this {ArrayBuffer} buffer The original buffer.
           * @param {number} [newLength] The start index.
           * @returns {ArrayBuffer} The new immutable ArrayBuffer.
           */
          transferToImmutable(newLength = undefined) {
            return optTransferBufferToImmutable(this, newLength);
          },
        }
      : {}),
  };

  // Better fidelity emulation of a class prototype
  for (const key of ownKeys(arrayBufferMethods)) {
    defineProperty(arrayBufferMethods, key, {
      enumerable: false,
    });
  }

  defineProperties(
    arrayBufferPrototype,
    getOwnPropertyDescriptors(arrayBufferMethods),
  );

  // Replace each concrete global TypedArray constructor with a
  // pseudo-constructor built from the freezable TypedArray pony's
  // exports. The pseudo-constructor delegates to the original constructor
  // for every input that is not a hidden (immutable-backed) buffer, and
  // wraps emulated-freezable TypedArrays when the input is one. The
  // shim then replaces `%TypedArrayPrototype%.buffer`'s getter with the
  // virtual getter so genuine TypedArrays whose backing buffer is an
  // immutable wrapper return the wrapper rather than leaking the
  // genuine ArrayBuffer.
  const TypedArray = getPrototypeOf(Uint8Array);
  const { prototype: typedArrayPrototype } = TypedArray;

  /** @type {Array<{ name: string, Ctor: any }>} */
  const concreteTypedArrayCtors = [
    { name: 'BigInt64Array', Ctor: BigInt64Array },
    { name: 'BigUint64Array', Ctor: BigUint64Array },
    { name: 'Float32Array', Ctor: Float32Array },
    { name: 'Float64Array', Ctor: Float64Array },
    { name: 'Int8Array', Ctor: Int8Array },
    { name: 'Int16Array', Ctor: Int16Array },
    { name: 'Int32Array', Ctor: Int32Array },
    { name: 'Uint8Array', Ctor: Uint8Array },
    { name: 'Uint8ClampedArray', Ctor: Uint8ClampedArray },
    { name: 'Uint16Array', Ctor: Uint16Array },
    { name: 'Uint32Array', Ctor: Uint32Array },
  ];

  for (const { name, Ctor } of concreteTypedArrayCtors) {
    const Pseudo = makePseudoTypedArrayConstructor(Ctor);
    // eslint-disable-next-line no-restricted-globals
    defineProperty(globalThis, name, {
      value: Pseudo,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  defineProperty(typedArrayPrototype, 'buffer', {
    get: /** @type {() => any} */ (virtualTypedArrayBufferGetter),
    enumerable: false,
    configurable: true,
  });
}
