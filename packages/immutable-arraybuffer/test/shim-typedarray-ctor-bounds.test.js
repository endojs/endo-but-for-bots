// @ts-nocheck
// Exhaustive, deterministic boundary coverage for the `byteOffset` and
// `length` constructor arguments of `new Ctor(iab, byteOffset, length)`, where
// `iab` is an emulated immutable ArrayBuffer produced by `.sliceToImmutable()`.
//
// This is the follow-up parked in PR #472 (Refs: #472, #468). erights gave the
// explicit go-ahead (comment 4857935559 on #472) to land this as *deterministic*
// coverage: for a space this small, exhaustive enumeration of the boundary
// classes gives complete coverage that probabilistic fast-check only
// approximates — so these are concrete, named cases and NO fast-check dev
// dependency was added.
//
// The pseudo-constructor forwards `[genuineAB, ...restArgs]` to the genuine
// constructor via `Reflect.construct` (`src/lib.js`
// `makePseudoTypedArrayConstructor`), so the emulated wrapper inherits the
// native constructor's boundary/error semantics. This file pins that
// inheritance across all eleven flavors: valid constructions read
// `byteOffset` / `byteLength` / `length` back correctly and keep the immutable
// wrapper as `.buffer`; out-of-range and misaligned arguments raise the native
// `RangeError` through the forwarding path.
import '../src/shim.js';
import test from 'ava';

const { getPrototypeOf } = Object;

// A byteLength that is a common multiple of every element size (1, 2, 4, 8),
// so `maxLength = BUFFER_BYTE_LENGTH / BYTES_PER_ELEMENT` is a whole number of
// elements for every flavor and mid-buffer aligned offsets always leave room.
const BUFFER_BYTE_LENGTH = 24;

// Each flavor carries its `BYTES_PER_ELEMENT` as a numeric literal (rather than
// reading `Ctor.BYTES_PER_ELEMENT`, which is typed `unknown`) so the arithmetic
// and boundary comparisons below operate on a known `number`.
/**
 * @type {Array<{name: string, Ctor: Function, bytesPerElement: number}>}
 */
const flavors = [
  { name: 'Int8Array', Ctor: Int8Array, bytesPerElement: 1 },
  { name: 'Int16Array', Ctor: Int16Array, bytesPerElement: 2 },
  { name: 'Int32Array', Ctor: Int32Array, bytesPerElement: 4 },
  { name: 'Uint8Array', Ctor: Uint8Array, bytesPerElement: 1 },
  { name: 'Uint8ClampedArray', Ctor: Uint8ClampedArray, bytesPerElement: 1 },
  { name: 'Uint16Array', Ctor: Uint16Array, bytesPerElement: 2 },
  { name: 'Uint32Array', Ctor: Uint32Array, bytesPerElement: 4 },
  { name: 'Float32Array', Ctor: Float32Array, bytesPerElement: 4 },
  { name: 'Float64Array', Ctor: Float64Array, bytesPerElement: 8 },
  { name: 'BigInt64Array', Ctor: BigInt64Array, bytesPerElement: 8 },
  { name: 'BigUint64Array', Ctor: BigUint64Array, bytesPerElement: 8 },
];

for (const { name, Ctor, bytesPerElement } of flavors) {
  const tName = label => `${name}: ${label}`;
  // Pin the literal `bytesPerElement` table against the runtime constant, so
  // the arithmetic and boundary comparisons below rest on a value the engine
  // agrees with.
  test(tName('BYTES_PER_ELEMENT'), t => {
    t.is(Ctor.BYTES_PER_ELEMENT, bytesPerElement);
  });

  // Element counts derived from the fixed buffer size for this flavor.
  const byteLength = BUFFER_BYTE_LENGTH;
  const maxLength = byteLength / bytesPerElement; // whole number: 24 is a multiple of bytesPerElement.
  // An aligned, nonzero, mid-buffer offset (one element in) that leaves room.
  const midByteOffset = bytesPerElement;
  const midInferredLength = maxLength - 1; // length omitted -> infers to end.
  const midExplicitLength = 1; // one element at the mid offset; always fits.

  const freshIab = () => new ArrayBuffer(byteLength).sliceToImmutable();

  // Every valid construction shares the same wrapper invariants: the prototype
  // is the genuine `Ctor.prototype`, `.buffer` redirects to the immutable
  // wrapper, and that wrapper reports `.immutable === true`.
  const assertWrapperInvariants = (t, view, iab) => {
    t.is(getPrototypeOf(view), Ctor.prototype);
    t.true(view instanceof Ctor);
    t.is(view.buffer, iab);
    t.true(view.buffer.immutable);
  };

  // -------------------------------------------------------------------------
  // Valid constructions
  // -------------------------------------------------------------------------

  test(
    tName('byteOffset omitted, length omitted -> full view over the buffer'),
    t => {
      const iab = freshIab();
      const view = new Ctor(iab);
      assertWrapperInvariants(t, view, iab);
      t.is(view.byteOffset, 0);
      t.is(view.byteLength, byteLength);
      t.is(view.length, maxLength);
    },
  );

  test(
    tName('byteOffset 0, explicit length 0 -> empty view at the start'),
    t => {
      const iab = freshIab();
      const view = new Ctor(iab, 0, 0);
      assertWrapperInvariants(t, view, iab);
      t.is(view.byteOffset, 0);
      t.is(view.byteLength, 0);
      t.is(view.length, 0);
    },
  );

  test(
    tName('byteOffset 0, explicit length = max that fits -> full view'),
    t => {
      const iab = freshIab();
      const view = new Ctor(iab, 0, maxLength);
      assertWrapperInvariants(t, view, iab);
      t.is(view.byteOffset, 0);
      t.is(view.byteLength, byteLength);
      t.is(view.length, maxLength);
    },
  );

  test(
    tName('aligned mid-buffer byteOffset, length omitted -> infers to end'),
    t => {
      const iab = freshIab();
      const view = new Ctor(iab, midByteOffset);
      assertWrapperInvariants(t, view, iab);
      t.is(view.byteOffset, midByteOffset);
      t.is(view.byteLength, byteLength - midByteOffset);
      t.is(view.length, midInferredLength);
    },
  );

  test(tName('aligned mid-buffer byteOffset, explicit fitting length'), t => {
    const iab = freshIab();
    const view = new Ctor(iab, midByteOffset, midExplicitLength);
    assertWrapperInvariants(t, view, iab);
    t.is(view.byteOffset, midByteOffset);
    t.is(view.byteLength, midExplicitLength * bytesPerElement);
    t.is(view.length, midExplicitLength);
  });

  test(
    tName('byteOffset = byteLength, length 0 -> empty view at the end'),
    t => {
      const iab = freshIab();
      const view = new Ctor(iab, byteLength, 0);
      assertWrapperInvariants(t, view, iab);
      t.is(view.byteOffset, byteLength);
      t.is(view.byteLength, 0);
      t.is(view.length, 0);
    },
  );

  // -------------------------------------------------------------------------
  // Error constructions (native RangeError forwarded via Reflect.construct)
  // -------------------------------------------------------------------------

  // Misalignment is only possible when an element spans more than one byte.
  if (bytesPerElement > 1) {
    test(
      tName('byteOffset not a multiple of BYTES_PER_ELEMENT -> RangeError'),
      t => {
        const iab = freshIab();
        // 1 is in range (< byteLength) but not a multiple of bytesPerElement (bytesPerElement > 1),
        // so the only defect is misalignment.
        t.throws(() => new Ctor(iab, 1), { instanceOf: RangeError });
      },
    );
  }

  test(tName('byteOffset past the end -> RangeError'), t => {
    const iab = freshIab();
    t.throws(() => new Ctor(iab, byteLength + bytesPerElement), {
      instanceOf: RangeError,
    });
  });

  test(
    tName(
      'aligned byteOffset but length one element past the max -> RangeError',
    ),
    t => {
      const iab = freshIab();
      // byteOffset 0 is valid; length maxLength + 1 requires one element more
      // than the buffer holds, so byteOffset + length*bytesPerElement > byteLength.
      t.throws(() => new Ctor(iab, 0, maxLength + 1), {
        instanceOf: RangeError,
      });
    },
  );
}
