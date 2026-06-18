/* global globalThis */

import {
  immutableArrayBufferLibProperties,
  freezableTypedArrayLibProperties,
  makePseudoTypedArrayConstructor,
  concreteTypedArrayCtors,
} from './lib.js';

const {
  ArrayBuffer,
  Object,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const {
  getOwnPropertyDescriptors,
  defineProperties,
  defineProperty,
  getPrototypeOf,
  entries,
} = Object;
const { prototype: arrayBufferPrototype } = ArrayBuffer;

// Stage-3 install policy: detect-then-skip.
//
// Both the Immutable ArrayBuffer proposal and the parallel Freezable
// TypedArray proposal are part of the same TC39 proposal, which has
// reached stage 3. At stage 3 or above our policy is detect-then-skip:
// if a prior installation (a native implementation, or a previously
// loaded shim) has already provided `sliceToImmutable` on
// `ArrayBuffer.prototype`, we defer to that installation rather than
// overwriting it. The native implementation always wins.
//
// `sliceToImmutable` is the load-bearing presence check: the proposal
// adds `sliceToImmutable`, `transferToImmutable`, and the `immutable`
// accessor as a unit, and any installer (native or shim) that provides
// one provides all three. Checking only one keeps the detect-then-skip
// branch deterministic.
//
// For proposals prior to stage 3 a warn-and-overwrite policy would be
// appropriate so the shim stays authoritative across partial or
// divergent platform implementations. The Immutable ArrayBuffer proposal
// is past that threshold.
if (!('sliceToImmutable' in arrayBufferPrototype)) {
  // ArrayBuffer-side install (from PR #435).
  defineProperties(
    arrayBufferPrototype,
    getOwnPropertyDescriptors(immutableArrayBufferLibProperties),
  );

  // Freezable TypedArray install (this PR).
  //
  // The %TypedArrayPrototype% is the shared abstract superclass prototype
  // that all eleven concrete TypedArray constructors (Int8Array, Uint8Array,
  // etc.) inherit through their own `.prototype`. Installing the property
  // record once on %TypedArrayPrototype% covers all eleven flavors.
  //
  // `getPrototypeOf(Uint8Array.prototype)` is the standard way to reach
  // %TypedArrayPrototype% in a non-strict environment without a dedicated
  // intrinsic name.
  const typedArrayPrototype = getPrototypeOf(
    // eslint-disable-next-line no-restricted-globals
    globalThis.Uint8Array.prototype,
  );

  // Install the lib property record onto %TypedArrayPrototype%.
  //
  // We do NOT use `getOwnPropertyDescriptors(freezableTypedArrayLibProperties)`
  // directly because that frozen record's descriptors carry `configurable: false`
  // and `writable: false`. Installing non-configurable descriptors would
  // prevent SES's `tameLocaleMethods` from later replacing `toLocaleString`
  // with a locale-tamed version (it expects the method to remain configurable).
  // We therefore reopen each descriptor to `configurable: true` (and
  // `writable: true` for data descriptors) so the install matches the
  // shape of the native %TypedArrayPrototype% methods.
  const libDescs = getOwnPropertyDescriptors(freezableTypedArrayLibProperties);
  /** @type {PropertyDescriptorMap} */
  const configurableDescs = {};
  for (const [key, desc] of entries(libDescs)) {
    const reopened = { ...desc, configurable: true };
    if ('value' in reopened) {
      reopened.writable = true;
    }
    configurableDescs[key] = reopened;
  }
  defineProperties(typedArrayPrototype, configurableDescs);

  // Replace each of the eleven concrete global TypedArray constructors with
  // the pseudo-constructor produced by the lib. The pseudo-constructor
  // discriminates on `hiddenBuffers` brand membership and falls through to
  // the genuine constructor for all other call shapes.
  for (const { name, Ctor } of concreteTypedArrayCtors) {
    const PseudoCtor = makePseudoTypedArrayConstructor(Ctor);
    defineProperty(
      // eslint-disable-next-line no-restricted-globals
      globalThis,
      name,
      {
        value: PseudoCtor,
        writable: true,
        enumerable: false,
        configurable: true,
      },
    );
  }
}
