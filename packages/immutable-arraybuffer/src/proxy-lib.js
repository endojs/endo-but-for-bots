/* global globalThis */

// ---------------------------------------------------------------------------
// Proxy-based freezable TypedArray emulation (alternative, for comparison)
// ---------------------------------------------------------------------------
//
// The shipped emulation (`src/lib.js`, `makePseudoTypedArrayConstructor`) wraps
// the hidden genuine TypedArray in a *plain ordinary object*. Because a plain
// object is not an Integer-Indexed Exotic Object, it cannot intercept
// integer-indexed assignment: `view[0] = 42` on a non-frozen wrapper creates a
// wrapper-local own property that shadows the indexed read; the underlying
// immutable buffer is never touched.
//
// The design doc's section "Why not a Proxy wrapper?"
// (`designs/freezable-typedarray.md`) rejects a Proxy route for three stated
// reasons: (1) freezability is materially harder to preserve through the proxy
// invariants, (2) trap overhead on the hot indexed read/write path, and (3) the
// gain (a *throwing* write instead of a wrapper-local own property) is a small,
// asymmetric nicety rather than a safety property.
//
// This module implements the Proxy route anyway, as an *alternative for
// comparison* (not a replacement of the shipped plain-object wrapper), so those
// three objections can be checked empirically. See:
//   - test/proxy-freezability.test.js  (objection 1)
//   - test/proxy-benchmark.test.js     (objection 2)
//   - test/proxy-gain.test.js          (objection 3)
//
// Two proxy shapes are exported because the freezability objection splits into
// two empirically distinct answers:
//
//   makeIndexRejectingProxy      target === the genuine TypedArray. Reads and
//                                methods forward; integer-indexed assignment
//                                throws (the gain). `Object.freeze` THROWS,
//                                because the target is an integer-indexed exotic
//                                whose `[[DefineOwnProperty]]` refuses to make
//                                index "0" non-configurable. This is objection 1
//                                realized: the natural proxy is not freezable.
//
//   makeFreezableIndexRejectingProxy
//                                target === a freeze-able plain object; the
//                                genuine TypedArray is held in a closure. Reads
//                                and methods forward; integer-indexed assignment
//                                throws; `Object.freeze` SUCCEEDS. The cost is
//                                that reflection (`ownKeys`,
//                                `getOwnPropertyDescriptor`) no longer matches a
//                                genuine TypedArray, which is precisely the
//                                "materially harder and easy to get subtly
//                                wrong" the objection names.

const {
  Object,
  Proxy,
  Reflect,
  String,
  TypeError,
  Uint8Array,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const { create, defineProperty, getPrototypeOf, setPrototypeOf, hasOwn } =
  Object;
const { apply, construct, get: reflectGet, set: reflectSet } = Reflect;

/**
 * @typedef {Int8Array | Int16Array | Int32Array | Uint8Array
 *   | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array
 *   | Float64Array | BigInt64Array | BigUint64Array} AnyTypedArray
 */

// %TypedArray% is the abstract superclass of all TypedArray constructors,
// captured before any shim can shadow the global TypedArray constructors.
const TypedArray = getPrototypeOf(Uint8Array);

// The five enumerated mutator methods. On an emulated freezable view each must
// be prevented, because the hidden genuine TypedArray is backed by a genuine
// *mutable* ArrayBuffer (immutability is enforced by the emulation, not by the
// engine), so forwarding a mutator would write through to the backing store.
const mutatorMethodNames = ['copyWithin', 'fill', 'reverse', 'set', 'sort'];
const isMutatorName = key => {
  for (const name of mutatorMethodNames) {
    if (key === name) {
      return true;
    }
  }
  return false;
};

/**
 * Is `key` a CanonicalNumericIndexString — the exact key class that a genuine
 * Integer-Indexed Exotic Object's `[[Set]]` intercepts? This includes the
 * non-negative integer indices ("0", "1", ...) plus "-0" and non-integer
 * numeric strings like "1.5", "Infinity", "NaN". Symbol keys are never numeric
 * indices.
 *
 * @param {string | symbol} key
 * @returns {boolean}
 */
export const isIntegerIndexKey = key => {
  if (typeof key !== 'string') {
    return false;
  }
  if (key === '-0') {
    return true;
  }
  const n = +key;
  // Round-trips through Number: "0" -> 0 -> "0", "1.5" -> 1.5 -> "1.5",
  // "Infinity" -> Infinity -> "Infinity". "01" -> 1 -> "1" !== "01", rejected.
  return String(n) === key;
};

const integerIndexAssignmentError = () =>
  TypeError(
    'Cannot assign to an integer-indexed property of a freezable TypedArray backed by an immutable ArrayBuffer',
  );

const mutatorError = name => () => {
  throw TypeError(
    `Cannot ${name} a freezable TypedArray backed by an immutable ArrayBuffer`,
  );
};

/**
 * Build the `get` behaviour shared by both proxy shapes: resolve reads against
 * the hidden genuine TypedArray, redirect `buffer` to the immutable wrapper,
 * and replace the five mutator methods with throwing stand-ins.
 *
 * Method-valued reads are rebound to the genuine TypedArray, because a Proxy
 * does not carry a `[[TypedArrayName]]` internal slot: calling
 * `%TypedArray%.prototype.at` (etc.) with the proxy as `this` throws
 * "called on incompatible receiver". Rebinding every method call to the genuine
 * target is itself part of objection 2's overhead (a fresh closure per method
 * read).
 *
 * When `expandoTarget` is a distinct object from the genuine TypedArray (the
 * repaired proxy's plain target), its own non-index named properties win — that
 * is where forwarded named writes land, so reads of them must come back from
 * there rather than from the genuine TypedArray.
 *
 * @param {AnyTypedArray} genuineTypedArray
 * @param {ArrayBuffer} immutableBuffer - the immutable wrapper to hand back for `.buffer`.
 * @param {object} expandoTarget - object that owns forwarded named writes.
 */
const makeGet =
  (genuineTypedArray, immutableBuffer, expandoTarget) => (_target, key) => {
    if (key === 'buffer') {
      return immutableBuffer;
    }
    if (isMutatorName(key)) {
      return mutatorError(key);
    }
    if (
      expandoTarget !== genuineTypedArray &&
      !isIntegerIndexKey(key) &&
      hasOwn(expandoTarget, key)
    ) {
      return reflectGet(expandoTarget, key);
    }
    const value = reflectGet(genuineTypedArray, key);
    if (typeof value === 'function' && key !== 'constructor') {
      // Rebind the method to the genuine TypedArray so its internal-slot brand
      // check passes. Returns a fresh closure on every read — deliberately, to
      // make objection 2's overhead measurable rather than hidden.
      return (...args) => apply(value, genuineTypedArray, args);
    }
    return value;
  };

/**
 * The "natural" Proxy: target is the genuine TypedArray itself.
 *
 * - Integer-indexed reads forward to the genuine target (fast path, native).
 * - Integer-indexed assignment throws `TypeError` (the gain objection 3 names).
 * - Methods and accessors forward via the shared `get` (rebinding for `this`).
 * - `Object.freeze(view)` THROWS: `SetIntegrityLevel` walks the target's own
 *   integer-indexed keys and asks `[[DefineOwnProperty]]` to make each
 *   non-configurable, which an integer-indexed exotic refuses ("Cannot redefine
 *   property: 0"). This is objection 1: the natural proxy cannot be frozen.
 *
 * @param {AnyTypedArray} genuineTypedArray
 * @param {ArrayBuffer} immutableBuffer
 * @returns {object} a Proxy that rejects integer-indexed assignment
 */
export const makeIndexRejectingProxy = (genuineTypedArray, immutableBuffer) => {
  const get = makeGet(genuineTypedArray, immutableBuffer, genuineTypedArray);
  return new Proxy(genuineTypedArray, {
    get,
    set(_target, key, value) {
      if (isIntegerIndexKey(key)) {
        throw integerIndexAssignmentError();
      }
      return reflectSet(genuineTypedArray, key, value);
    },
  });
};

/**
 * The "repaired" Proxy: target is a freeze-able plain object whose
 * `[[Prototype]]` is the genuine flavor prototype; the genuine TypedArray is
 * held in the closure. Because the target is an ordinary object with no
 * integer-indexed exotic slots, `SetIntegrityLevel` completes and
 * `Object.freeze(view)` SUCCEEDS with `Object.isFrozen(view) === true`.
 *
 * The cost — objection 1's "materially harder and easy to get subtly wrong" —
 * is that the proxy's own-key reflection no longer matches a genuine
 * TypedArray. The plain target carries no "0".."n-1" keys, so `ownKeys`,
 * `getOwnPropertyDescriptor`, and enumeration diverge from a genuine view even
 * though bracket reads still work through the `get` trap. Making reflection
 * match too would require `ownKeys` / `getOwnPropertyDescriptor` /
 * `defineProperty` traps that re-introduce exactly the non-configurability
 * invariant that made the natural proxy unfreezable.
 *
 * @param {AnyTypedArray} genuineTypedArray
 * @param {ArrayBuffer} immutableBuffer
 * @param {Function} flavorPrototype - e.g. `Uint8Array.prototype`.
 * @returns {object} a freeze-able Proxy that rejects integer-indexed assignment
 */
export const makeFreezableIndexRejectingProxy = (
  genuineTypedArray,
  immutableBuffer,
  flavorPrototype = getPrototypeOf(genuineTypedArray),
) => {
  const target = create(flavorPrototype);
  const get = makeGet(genuineTypedArray, immutableBuffer, target);
  return new Proxy(target, {
    get,
    set(_target, key, value, receiver) {
      if (isIntegerIndexKey(key)) {
        throw integerIndexAssignmentError();
      }
      // Forward non-index writes to the plain target so ordinary frozen-object
      // semantics apply (a write after freeze is swallowed / throws in strict
      // mode, matching an ordinary object).
      return reflectSet(target, key, value, receiver);
    },
    getPrototypeOf() {
      return flavorPrototype;
    },
  });
};

// ---------------------------------------------------------------------------
// Drop-in pseudo-constructor (mirrors makePseudoTypedArrayConstructor)
// ---------------------------------------------------------------------------

// Capture the genuine ArrayBuffer.prototype.slice before any shim can shadow
// it, so the pseudo-constructor can recover a genuine mutable buffer holding
// the immutable buffer's bytes.
// eslint-disable-next-line no-restricted-globals
const { slice: arrayBufferSlice } = globalThis.ArrayBuffer.prototype;

/**
 * Factory for per-flavor Proxy-based pseudo-constructors, the Proxy analog of
 * `makePseudoTypedArrayConstructor`. When called with an emulated immutable
 * ArrayBuffer as the first argument (detected via `isBufferImmutable`), it
 * produces a *freezable* index-rejecting Proxy. For every other call shape it
 * falls through to the genuine constructor via `Reflect.construct`.
 *
 * The hidden genuine TypedArray is constructed over a genuine mutable copy of
 * the immutable buffer's bytes (`arrayBufferSlice`), so the emulation never
 * hands out a handle that can write to the caller's immutable buffer.
 *
 * @param {Function} OriginalConstructor
 * @param {(buffer: ArrayBuffer) => boolean} isBufferImmutable - from `./lib.js`.
 * @returns {Function}
 */
export const makeProxyPseudoTypedArrayConstructor = (
  OriginalConstructor,
  isBufferImmutable,
) => {
  /**
   * @param {...any} args
   * @returns {object}
   */
  function ProxyPseudoTypedArray(...args) {
    const [firstArg, ...restArgs] = args;
    const isHidden = firstArg !== undefined && isBufferImmutable(firstArg);
    if (!isHidden) {
      return construct(
        OriginalConstructor,
        args,
        new.target ?? OriginalConstructor,
      );
    }
    // Recover a genuine mutable buffer holding the immutable buffer's bytes.
    const genuineAB = apply(arrayBufferSlice, firstArg, []);
    const genuineTA = construct(OriginalConstructor, [genuineAB, ...restArgs]);
    return makeFreezableIndexRejectingProxy(
      genuineTA,
      firstArg,
      OriginalConstructor.prototype,
    );
  }

  defineProperty(ProxyPseudoTypedArray, 'name', {
    value: OriginalConstructor.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  ProxyPseudoTypedArray.prototype = OriginalConstructor.prototype;
  setPrototypeOf(ProxyPseudoTypedArray, TypedArray);
  return ProxyPseudoTypedArray;
};
