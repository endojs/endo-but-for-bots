import {
  immutableArrayBufferLibProperties,
  freezableTypedArrayLibProperties,
  freezableDataViewLibProperties,
  makeEmulatedTypedArrayConstructor,
  concreteTypedArrayConstructors,
  EmulatedDataView,
} from './lib.js';

// eslint-disable-next-line no-restricted-globals
const { ArrayBuffer, Object } = globalThis;

const {
  getOwnPropertyDescriptors,
  defineProperties,
  defineProperty,
  getPrototypeOf,
} = Object;
const { prototype: arrayBufferPrototype } = ArrayBuffer;

// Stage-3 install policy: first evaluation wins.
//
// Both the Immutable ArrayBuffer proposal and the parallel Freezable
// TypedArray proposal are part of the same TC39 proposal, which has
// reached stage 3. The first evaluation in a realm publishes its private
// view constructors. Later evaluations, including evaluations of another
// physical copy of this package, defer to that winner. This keeps all installed
// methods and emulated constructors tied to one set of WeakMaps.
//
// The winning evaluation still uses `sliceToImmutable` to decide whether the
// engine already provides the stage-3 proposal. In that case it leaves the
// native implementation intact and publishes a predicate that always returns
// false because this evaluation creates no emulated views.
//
// For proposals prior to stage 3 a warn-and-overwrite policy would be
// appropriate so the shim stays authoritative across partial or
// divergent platform implementations. The Immutable ArrayBuffer proposal
// is past that threshold.
if (!('sliceToImmutable' in arrayBufferPrototype)) {
  // ArrayBuffer-side install (immutable ArrayBuffer shim).
  defineProperties(
    arrayBufferPrototype,
    getOwnPropertyDescriptors(immutableArrayBufferLibProperties),
  );

  // Freezable TypedArray install.
  //
  // The %TypedArrayPrototype% is the shared abstract superclass prototype
  // that all eleven concrete TypedArray constructors (Int8Array, Uint8Array,
  // etc.) inherit through their own `.prototype`. Installing the property
  // record once on %TypedArrayPrototype% covers all eleven flavors.
  //
  // `getPrototypeOf(Uint8Array.prototype)` is the standard way to reach
  // %TypedArrayPrototype% without a dedicated
  // intrinsic name.
  const typedArrayPrototype = getPrototypeOf(
    // eslint-disable-next-line no-restricted-globals
    globalThis.Uint8Array.prototype,
  );

  // Install the lib property record onto %TypedArrayPrototype%.
  //
  // `freezableTypedArrayLibProperties` is an unfrozen record whose
  // descriptors are configurable and writable (matching the shape of the
  // native %TypedArrayPrototype% methods), so we can pass them directly
  // to `defineProperties` without reopening.
  defineProperties(
    typedArrayPrototype,
    getOwnPropertyDescriptors(freezableTypedArrayLibProperties),
  );

  // Replace each of the eleven concrete global TypedArray constructors with
  // the emulated constructor produced by the lib. The emulated constructor
  // discriminates on `buffers` brand membership and falls through to
  // the genuine constructor for all other call shapes.
  for (const { name, Constructor } of concreteTypedArrayConstructors) {
    const EmulatedConstructor = makeEmulatedTypedArrayConstructor(Constructor);
    defineProperty(
      // eslint-disable-next-line no-restricted-globals
      globalThis,
      name,
      {
        value: EmulatedConstructor,
      },
    );
  }

  defineProperties(
    // eslint-disable-next-line no-restricted-globals
    globalThis.DataView.prototype,
    getOwnPropertyDescriptors(freezableDataViewLibProperties),
  );
  defineProperty(
    // eslint-disable-next-line no-restricted-globals
    globalThis,
    'DataView',
    { value: EmulatedDataView },
  );
}
