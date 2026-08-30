// @ts-nocheck
// Shim-level regression tests pinning the `[Symbol.toStringTag]` fidelity
// contract of the freezable-TypedArray emulation.
//
// The shim replaces the genuine, `this`-sensitive
// `%TypedArrayPrototype%[Symbol.toStringTag]` getter with a wrapper around it.
// On an emulated freezable wrapper (a plain ordinary object created with
// `Object.create(Uint8Array.prototype)`, which has no `[[TypedArrayName]]`
// internal slot) the wrapper getter amplifies to the hidden genuine TypedArray
// and reads *its* tag, so `Object.prototype.toString.call(wrapper)` reads
// `'[object Uint8Array]'`, matching a genuine view. On a genuine TypedArray the
// wrapper falls through to the genuine getter; on any other receiver the genuine
// getter returns `undefined`, exactly as before.
//
// This is the getter-wrapper fidelity fix requested in erights's review of
// endojs/endo-but-for-bots#475 (review comments 3817252816 / 3817264546). It is
// a higher-fidelity repair than installing a `[Symbol.toStringTag]` *data*
// property, which would patch only the `Object.prototype.toString` lookup path
// and leave the getter itself still reporting `undefined` on a wrapper — the
// getter and `Object.prototype.toString` now agree instead.
//
// Consequently `[Symbol.toStringTag]` is NO LONGER an emulated-vs-genuine
// distinguisher. The single committed distinguisher remains `ArrayBuffer.isView`
// (pinned in `shim-typedarray.test.js`); downstream clients (`@endo/bytes` /
// `@endo/pass-style`) tell an emulated wrapper apart from a genuine `Uint8Array`
// via `isView`, never by sniffing `toStringTag`.
import '../src/shim.js';
import test from 'ava';

const { getPrototypeOf, getOwnPropertyDescriptor } = Object;
const { apply } = Reflect;

// After the shim installs, `%TypedArrayPrototype%[Symbol.toStringTag]` is the
// shim's wrapper getter (still an accessor with a getter function, not a data
// property).
const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const tagGetterDesc = getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
);
const shimTagGetter = tagGetterDesc.get;

const makeEmulatedWrapper = length => {
  const ab = new ArrayBuffer(length);
  // NOTE: `Array.from(arrayLike, mapFn)` relies on the map (relation) function.
  // There is a known XS defect where `Array.from` does not recognize the map
  // function argument; were this helper exercised under test262 on an affected
  // XS build, the fill would not run. It is inconsequential here (the fill only
  // seeds distinct bytes for identity assertions), but flagged so a future
  // test262 run of these shim-path cases is not surprised by it.
  new Uint8Array(ab).set(Array.from({ length }, (_, i) => i + 1));
  const iab = ab.sliceToImmutable();
  return new Uint8Array(iab);
};

test('shim installs a getter (not a data property) for %TypedArrayPrototype% toStringTag', t => {
  // The replacement remains an accessor with a getter function — the
  // getter-wrapper fix, NOT a `[Symbol.toStringTag]` data property (which would
  // be the flawed, lower-fidelity repair). It still reports the genuine tag for
  // a genuine view.
  t.is(typeof shimTagGetter, 'function');
  t.is(tagGetterDesc.set, undefined);
  t.false('value' in tagGetterDesc);
  t.is(apply(shimTagGetter, new Uint8Array(3), []), 'Uint8Array');
});

test('emulated freezable wrapper carries no own [Symbol.toStringTag]', t => {
  // The tag is supplied by the prototype's wrapper getter, not by an own data
  // property on the wrapper — the distinction between the getter-wrapper fix and
  // the flawed data-property fix.
  const wrapper = makeEmulatedWrapper(4);
  t.is(getOwnPropertyDescriptor(wrapper, Symbol.toStringTag), undefined);
});

test('shim toStringTag getter reports Uint8Array for an emulated wrapper', t => {
  // The wrapper getter amplifies the emulated wrapper to its hidden genuine
  // TypedArray and reads that TypedArray's internal-slot tag, so the getter now
  // reports the flavor name instead of `undefined`.
  const wrapper = makeEmulatedWrapper(4);
  t.is(apply(shimTagGetter, wrapper, []), 'Uint8Array');
  t.is(apply(shimTagGetter, new Uint8Array(4), []), 'Uint8Array');
});

test('shim toStringTag getter returns undefined for a non-TypedArray receiver', t => {
  // Fallthrough is preserved: on a receiver that is neither an emulated wrapper
  // nor a genuine TypedArray, the amplifier returns the receiver unchanged and
  // the genuine getter returns `undefined`.
  t.is(apply(shimTagGetter, {}, []), undefined);
  t.is(apply(shimTagGetter, [], []), undefined);
});

test('Object.prototype.toString reads emulated wrapper as its TypedArray flavor', t => {
  const wrapper = makeEmulatedWrapper(4);
  // The emulated wrapper now reads as a Uint8Array, matching a genuine view —
  // the toStringTag fidelity gap is closed. (The committed distinguisher is
  // `ArrayBuffer.isView`, not this.)
  t.is(Object.prototype.toString.call(wrapper), '[object Uint8Array]');
  t.is(
    Object.prototype.toString.call(new Uint8Array(4)),
    '[object Uint8Array]',
  );
});

test('the toStringTag fidelity holds after freezing the emulated wrapper', t => {
  const wrapper = Object.freeze(makeEmulatedWrapper(4));
  t.true(Object.isFrozen(wrapper));
  t.is(apply(shimTagGetter, wrapper, []), 'Uint8Array');
  t.is(Object.prototype.toString.call(wrapper), '[object Uint8Array]');
});
