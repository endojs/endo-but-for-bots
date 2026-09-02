// @ts-nocheck
// Shim-level integration tests for the freezable-TypedArray emulation.
// These tests exercise the shim-installed emulated constructors and
// %TypedArrayPrototype% property record after the full shim install.
import '../src/shim.js';
import test from 'ava';
import { emulatedOnlyTest } from './_emulated-only.js';

const { getPrototypeOf, freeze, isFrozen, keys, getOwnPropertyDescriptor } =
  Object;

// Basic construction

test('shim: global Uint8Array on an immutable ArrayBuffer wraps as emulated freezable', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = ab.sliceToImmutable();

  const view = new Uint8Array(iab);

  // The wrapper's prototype is Uint8Array.prototype (no intermediate prototype).
  t.is(getPrototypeOf(view), Uint8Array.prototype);
  t.true(view instanceof Uint8Array);

  // `view.buffer` returns the immutable wrapper, not the genuine backing buffer.
  t.is(view.buffer, iab);
  t.true(view.buffer.immutable);
});

test('shim: global Uint8Array on a regular ArrayBuffer forwards to the OriginalConstructor', t => {
  const realAb = new ArrayBuffer(4);
  new Uint8Array(realAb).set([10, 20, 30, 40]);

  const view = new Uint8Array(realAb);

  // Fallthrough path: genuine TypedArray.
  t.is(view.buffer, realAb);
  t.false(view.buffer.immutable);

  // Mutators succeed on the genuine view.
  view[0] = 99;
  t.is(view[0], 99);
});

// `view.buffer` getter

test('shim: emulated buffer getter returns the real buffer for a genuine TypedArray', t => {
  const realAb = new ArrayBuffer(4);
  const view = new Uint8Array(realAb);
  t.is(view.buffer, realAb);
});

test('shim: emulated buffer getter redirects to the immutable wrapper when present', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  t.is(view.buffer, iab);
  t.true(view.buffer.immutable);
});

// Mutators throw on emulated freezable views

test('shim: emulated freezable mutators complain', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);

  t.throws(() => view.copyWithin(0, 1), { instanceOf: TypeError });
  t.throws(() => view.fill(0), { instanceOf: TypeError });
  t.throws(() => view.reverse(), { instanceOf: TypeError });
  t.throws(() => view.set([0]), { instanceOf: TypeError });
  t.throws(() => view.sort(), { instanceOf: TypeError });
});

// Read-only delegations (`byteLength`, `at`, `length`, `byteOffset`)

test('shim: emulated freezable byteLength and at redirect via amplifyTypedArray', t => {
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab).set([10, 20, 30, 40, 50, 60, 70, 80]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  t.is(view.byteLength, 8);
  t.is(view.length, 8);
  t.is(view.byteOffset, 0);
  t.is(view.at(0), 10);
  t.is(view.at(7), 80);
});

// `subarray` returns a view whose `buffer` is the immutable wrapper

test('shim: emulated freezable subarray returns a wrapped view whose buffer is the immutable wrapper', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  const sub = view.subarray(1, 3);
  // `subarray` on an emulated wrapper now returns a new emulated wrapper
  // backed by the sub-view of the hidden genuine TypedArray. The safety
  // contract (`sub.buffer === iab`) is preserved: the sub-view's `.buffer`
  // redirects to the same immutable ArrayBuffer wrapper as the parent view.
  t.is(sub.byteLength, 2);
  t.is(sub.byteOffset, 1);
  // Indexed element access uses `at()` (the amplifier-delegate path) rather
  // than `sub[0]` (which would read an own property on the plain wrapper object,
  // returning `undefined` for unset indices, per the wrapper semantics).
  t.is(sub.at(0), 2);
  t.is(sub.at(1), 3);
  // Core safety-contract assertion: the sub-view's buffer is the immutable wrapper.
  t.is(sub.buffer, iab);
  t.true(sub.buffer.immutable);
  // Chained subarray must also preserve the immutable buffer reference.
  t.is(view.subarray(0, 2).subarray(0, 1).buffer, iab);
});

// Symbol.iterator: for...of and spread work on emulated freezable wrappers

test('shim: for...of loop works on an emulated freezable wrapper', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([10, 20, 30, 40]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  const collected = [];
  for (const v of view) {
    collected.push(v);
  }
  t.deepEqual(collected, [10, 20, 30, 40]);
});

test('shim: spread syntax works on an emulated freezable wrapper', t => {
  const ab = new ArrayBuffer(3);
  new Uint8Array(ab).set([7, 8, 9]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  t.deepEqual([...view], [7, 8, 9]);
});

test('shim: Symbol.iterator on %TypedArrayPrototype% matches the values wrapper after shim install', t => {
  // After the shim installs a `values` wrapper on %TypedArrayPrototype%, the
  // `Symbol.iterator` slot must point at the same (or equivalent) wrapper, not
  // the original genuine `values` function. This regression test pins the fix:
  // if `Symbol.iterator` is left pointing at the original genuine function,
  // `for...of` on a freezable wrapper throws `TypeError: this is not a typed array.`
  const ab = new ArrayBuffer(2);
  new Uint8Array(ab).set([1, 2]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  // Both iteration protocols must work on an emulated freezable wrapper.
  t.deepEqual([...view.values()], [1, 2]);
  const iterResult = [];
  for (const v of view) {
    iterResult.push(v);
  }
  t.deepEqual(iterResult, [1, 2]);
});

// detect-then-skip is idempotent under re-import

test('shim: detect-then-skip is idempotent under re-import', async t => {
  // The gate is keyed on `'sliceToImmutable' in ArrayBuffer.prototype`.
  // A second import of the shim must not overwrite the already-installed surface.
  const sliceFnBefore = ArrayBuffer.prototype.sliceToImmutable;

  // Dynamic re-import exercises the gate from a fresh module invocation.
  await import('../src/shim.js');

  t.is(
    ArrayBuffer.prototype.sliceToImmutable,
    sliceFnBefore,
    'second shim import did not replace the already-installed sliceToImmutable',
  );
});

// Indexed assignment semantics (proposal-level constraint)

emulatedOnlyTest(
  'shim: indexed assignment on a non-frozen emulated freezable view creates a wrapper-local own property; the underlying immutable buffer is unchanged',
  t => {
    const ab = new ArrayBuffer(4);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);

    // The underlying buffer's byte 0 is 0.
    t.is(Uint8Array.prototype.at.call(view, 0), 0);

    // Indexed assignment performs OrdinarySet on the plain wrapper, creating an
    // own data property '0' => 42.  The underlying buffer is not touched.
    view[0] = 42;

    // `view[0]` now reads the own property.
    t.is(view[0], 42);

    // But the underlying buffer's byte 0 is still 0.
    t.is(Uint8Array.prototype.at.call(view, 0), 0);
  },
);

emulatedOnlyTest(
  'shim: indexed assignment on a frozen emulated freezable view throws in strict mode; the underlying immutable buffer is unchanged',
  t => {
    // ES modules are implicitly strict. In strict mode, an indexed assignment
    // to a frozen ordinary object throws TypeError ("Cannot add property 0,
    // object is not extensible"). In non-strict mode the same assignment would
    // be silently swallowed. Both behaviors leave the underlying immutable
    // buffer unchanged; the proposal's buffer-immutability guarantee holds
    // regardless of mode. See designs/freezable-typedarray.md section
    // "Indexed assignment never modifies the underlying buffer", frozen example.
    const ab = new ArrayBuffer(4);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);

    freeze(view);
    t.true(isFrozen(view));

    // In strict mode (ES module), assigning to a frozen object throws.
    t.throws(
      () => {
        view[0] = 42;
      },
      { instanceOf: TypeError },
    );

    // The underlying buffer's byte 0 is still 0 (unchanged regardless of mode).
    t.is(Uint8Array.prototype.at.call(view, 0), 0);
  },
);

// The one committed emulated-vs-genuine fidelity loss: `ArrayBuffer.isView`
//
// An emulated freezable wrapper is a plain ordinary object with no
// `[[ViewedArrayBuffer]]` / `[[TypedArrayName]]` internal slots, so
// `ArrayBuffer.isView(wrapper)` is `false`, whereas a genuine `Uint8Array`
// (mutable, or native-immutable) reports `true`. This is the single
// distinguisher `@endo/bytes` and `@endo/pass-style` are entitled to rely on
// to tell an emulated wrapper apart from a genuine integer-indexed view, and
// the one the shim commits to preserve. This test fails first if a future
// change ever made an emulated wrapper report `isView === true`. See README
// "The one committed fidelity loss: an emulated wrapper is not
// `ArrayBuffer.isView`".

emulatedOnlyTest(
  'shim: emulated freezable wrapper is not ArrayBuffer.isView; a genuine view is (the committed fidelity loss)',
  t => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([10, 20, 30, 40]);
    const iab = ab.sliceToImmutable();
    const emulated = new Uint8Array(iab);

    // The committed distinguisher: the emulated wrapper is not a view.
    t.false(ArrayBuffer.isView(emulated));
    // A genuine mutable view is a view.
    t.true(ArrayBuffer.isView(new Uint8Array(4)));
    // The distinction survives freezing the wrapper.
    t.false(ArrayBuffer.isView(freeze(emulated)));
  },
);

// Indexed read semantics (an incidental consequence of the plain-object shape)
//
// Symmetric to the indexed-assignment constraint above: an integer-indexed
// *read* `view[i]` on a fresh emulated freezable wrapper returns `undefined`,
// never the underlying byte. The wrapper is a plain ordinary object whose
// prototype is `Uint8Array.prototype`; it carries no own indexed properties,
// and the shim installs no integer-indexed read accessor on
// %TypedArrayPrototype% that could intercept `view[i]` (the TC39 proposal
// offers no way to do so through the prototype chain). Bytes are readable only
// through the integer-indexed protocol (`view.at(i)`, `for..of`, spread).
//
// This `view[i] === undefined` behavior is a real but INCIDENTAL consequence
// of the wrapper being a plain object — the same plain-object nature that
// makes `ArrayBuffer.isView` report `false` (pinned above). It is NOT the
// committed distinguisher: `@endo/bytes` and `@endo/pass-style` discriminate
// via `ArrayBuffer.isView`, not by sniffing `view[i]`. This test records the
// companion observation (and the zero-own-index shape `@endo/pass-style`
// requires of an emulated wrapper). See README "Integer-indexed reads on
// emulated freezable views (an incidental consequence)".

emulatedOnlyTest(
  'shim: integer-indexed read on a fresh emulated freezable wrapper is undefined, not the underlying byte (incidental consequence)',
  t => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([10, 20, 30, 40]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);

    // The bytes are readable through the integer-indexed protocol, which the
    // shim redirects to the hidden genuine TypedArray.
    t.is(view.at(0), 10);
    t.is(view.at(3), 40);

    // But a direct integer-indexed read yields `undefined`, never the byte.
    // Non-zero source bytes make this unambiguous: a coincidental 0 cannot
    // masquerade as the "no such property" answer.
    t.is(view[0], undefined);
    t.is(view[1], undefined);
    t.is(view[2], undefined);
    t.is(view[3], undefined);

    // The wrapper carries no own indexed properties at all: the shape
    // `@endo/pass-style` requires of an emulated (non-view) `byteArray` wrapper.
    t.deepEqual(keys(view), []);
    t.is(getOwnPropertyDescriptor(view, 0), undefined);
  },
);

// Object.freeze + Object.isFrozen (the proposal's TypedArray-can-be-frozen
// guarantee)

test('shim: Object.freeze(view); Object.isFrozen(view) === true', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);

  freeze(view);
  t.true(isFrozen(view));
});

// No intermediate prototype

test('shim: Object.getPrototypeOf(view) === Uint8Array.prototype on an emulated freezable view', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  t.is(getPrototypeOf(view), Uint8Array.prototype);
});
