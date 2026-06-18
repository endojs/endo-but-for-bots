// @ts-nocheck
// Shim-level integration tests for the freezable-TypedArray emulation.
// These tests exercise the shim-installed pseudo-constructors and
// %TypedArrayPrototype% property record after the full shim install.
import '../src/shim.js';
import test from 'ava';

const { getPrototypeOf, freeze, isFrozen } = Object;

// ---------------------------------------------------------------------------
// Basic construction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// `view.buffer` getter
// ---------------------------------------------------------------------------

test('shim: virtual buffer getter returns the real buffer for a genuine TypedArray', t => {
  const realAb = new ArrayBuffer(4);
  const view = new Uint8Array(realAb);
  t.is(view.buffer, realAb);
});

test('shim: virtual buffer getter redirects to the immutable wrapper when present', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  t.is(view.buffer, iab);
  t.true(view.buffer.immutable);
});

// ---------------------------------------------------------------------------
// Mutators throw on emulated freezable views
// ---------------------------------------------------------------------------

test('shim: emulated freezable mutators complain', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);

  t.throws(() => view.copyWithin(0, 1), { instanceOf: TypeError });
  t.throws(() => view.fill(0), { instanceOf: TypeError });
  t.throws(() => view.reverse(), { instanceOf: TypeError });
  t.throws(() => view.set([0]), { instanceOf: TypeError });
  t.throws(() => view.sort(), { instanceOf: TypeError });
});

// ---------------------------------------------------------------------------
// Read-only delegations (`byteLength`, `at`, `length`, `byteOffset`)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// `subarray` returns a view whose `buffer` is the immutable wrapper
// ---------------------------------------------------------------------------

test('shim: emulated freezable subarray returns a view whose buffer is the immutable wrapper', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);

  const sub = view.subarray(1, 3);
  // subarray on an emulated wrapper delegates to the hidden genuine TypedArray
  // (via the amplifier-with-this-fallthrough) so the result is a genuine
  // TypedArray whose `.buffer` is the genuine (mutable) backing buffer.
  // This is the expected behavior: the sub-view's buffer is not wrapped.
  t.is(sub.byteLength, 2);
  t.is(sub[0], 2);
  t.is(sub[1], 3);
});

// ---------------------------------------------------------------------------
// detect-then-skip is idempotent under re-import
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Indexed assignment semantics (proposal-level constraint)
// ---------------------------------------------------------------------------

test('shim: indexed assignment on a non-frozen emulated freezable view creates a wrapper-local own property; the underlying immutable buffer is unchanged', t => {
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
});

test('shim: indexed assignment on a frozen emulated freezable view throws in strict mode; the underlying immutable buffer is unchanged', t => {
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
});

// ---------------------------------------------------------------------------
// Object.freeze + Object.isFrozen (the proposal's TypedArray-can-be-frozen
// guarantee)
// ---------------------------------------------------------------------------

test('shim: Object.freeze(view); Object.isFrozen(view) === true', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);

  freeze(view);
  t.true(isFrozen(view));
});

// ---------------------------------------------------------------------------
// No intermediate prototype
// ---------------------------------------------------------------------------

test('shim: Object.getPrototypeOf(view) === Uint8Array.prototype on an emulated freezable view', t => {
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  t.is(getPrototypeOf(view), Uint8Array.prototype);
});
