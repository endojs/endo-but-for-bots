// @ts-nocheck
// Coverage for the byteArray brand check after narrowing to the
// plain-frozen-`Uint8Array` shape only.
//
// The brand check now accepts exactly one shape: a plain frozen
// `Uint8Array` whose backing buffer is a plain frozen immutable
// `ArrayBuffer`. Raw immutable `ArrayBuffer` values, previously
// accepted, are no longer recognised as `byteArray`.
//
// The "plain" Uint8Array definition accepts exactly two well-formed
// wrapper shapes:
//   - Emulated path: no own indexed properties at all, regardless of
//     length. The `@endo/immutable-arraybuffer` shim produces this shape;
//     any own indexed property is post-construction tampering and is
//     rejected even when the value agrees with the underlying buffer byte.
//   - Native path: exactly `length`-many own indexed properties, each an
//     enumerable data property whose value matches the underlying buffer
//     byte. This is the shape a spec-conformant engine will produce once
//     the Immutable ArrayBuffer proposal ships natively.
// Non-index own properties are rejected on both paths.
//
// The first section asserts that raw immutable `ArrayBuffer` values are
// now rejected. The second section covers the surviving
// `Uint8Array`-on-IAB acceptance shape and its tampering rejections.
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { passStyleOf } from '../src/passStyleOf.js';

const { defineProperty, freeze, getOwnPropertyDescriptor } = Object;
const { ownKeys } = Reflect;

// The `@endo/immutable-arraybuffer` shim installs under a stage-3
// detect-then-skip policy: on an engine that already ships native Immutable
// ArrayBuffer support (current XS does), the shim steps aside and
// `new Uint8Array(iab)` is a GENUINE integer-indexed view rather than the
// emulated plain-object wrapper. On such a native engine the emulated-wrapper
// observations do NOT hold, because there is no emulated wrapper to observe:
//   - `ArrayBuffer.isView(view)` is `true`, not `false`, so the wrapper carries
//     exactly `length`-many own indexed properties rather than zero;
//   - the buffer's `[Symbol.toStringTag]` is inherited `'ArrayBuffer'` on the
//     prototype, not the shim's own `'emulated immutable ArrayBuffer'` slot;
//   - an indexed assignment (`view[i] = x`) is a silent no-op over an immutable
//     buffer, never an own OrdinarySet shadow, so the tamper scenario is
//     unreachable;
//   - `defineProperty` at an integer index throws on the genuine
//     integer-indexed exotic (out-of-range or accessor descriptors are
//     rejected) rather than installing an observable own property.
// Gate the tests that assert those emulated-only shapes so they run under the
// shim and skip under native, rather than baking in the (now obsolete)
// assumption that no engine ships native support. The byte-value and structural
// assertions that hold on both paths (acceptance of a genuine frozen
// Uint8Array, byteOffset/length span checks, non-index / expando rejections)
// stay unguarded. See endojs/endo-but-for-bots#475 (erights review).
const emulationActive = !ArrayBuffer.isView(
  new Uint8Array(new ArrayBuffer(0).sliceToImmutable()),
);
const emulatedOnlyTest = emulationActive ? test : test.skip;

// Raw immutable ArrayBuffer is no longer a byteArray.

test('byteArray rejects a raw immutable ArrayBuffer (previously accepted)', t => {
  // Before the narrowing, an immutable `ArrayBuffer` produced by
  // `sliceToImmutable` was recognised as a `byteArray`. The accepted shape
  // is now `Uint8Array`-only; raw IAB values must be wrapped in
  // `new Uint8Array(iab)` and hardened by producers. After the narrowing,
  // a raw IAB hits no brand-matching helper and falls through to the
  // remotable check, which rejects it because an `ArrayBuffer` is not a
  // remotable.
  const iab = harden(new ArrayBuffer(0).sliceToImmutable());
  t.throws(() => passStyleOf(iab));
});

emulatedOnlyTest(
  'byteArray rejects a raw immutable ArrayBuffer with the standard toStringTag slot',
  t => {
    // Sanity check: the lib still installs `[Symbol.toStringTag]` as a
    // non-enumerable, non-writable, non-configurable data property whose
    // value is the string `'emulated immutable ArrayBuffer'`. That slot used to be
    // tolerated by the `byteArray` acceptance arm for raw IAB; the entire
    // arm is gone now, so the slot is moot for raw IAB acceptance. The
    // backing-buffer sub-check still tolerates exactly this slot when the
    // IAB is reached via a `Uint8Array` wrapper.
    const iab = new ArrayBuffer(0).sliceToImmutable();
    const descriptor = getOwnPropertyDescriptor(iab, Symbol.toStringTag);
    t.deepEqual(descriptor, {
      value: 'emulated immutable ArrayBuffer',
      writable: false,
      enumerable: false,
      configurable: false,
    });
    t.throws(() => passStyleOf(harden(iab)));
  },
);

// Plain frozen Uint8Array backed by plain frozen immutable ArrayBuffer.

test('byteArray accepts a plain frozen Uint8Array backed by an immutable ArrayBuffer', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);
  harden(view);
  t.is(passStyleOf(view), 'byteArray');
});

test('byteArray accepts a plain frozen Uint8Array on a zero-length immutable ArrayBuffer (emulated, no own indexed properties)', t => {
  const iab = new ArrayBuffer(0).sliceToImmutable();
  const view = new Uint8Array(iab);
  harden(view);
  t.is(passStyleOf(view), 'byteArray');
});

// Whole-buffer span (restrictive, issue #573).
//
// A byteArray view must cover its entire backing buffer one-to-one. A
// sub-view (`byteOffset > 0`, or a `length` shorter than the buffer's
// `byteLength`) is rejected, so a marshalled byteArray never conveys a
// hidden tail of its backing buffer beyond what the view reveals. The
// restrictive form is tracked for possible relaxation at
// https://github.com/endojs/endo-but-for-bots/issues/573 .

test('byteArray accepts a whole-buffer-spanning view (byteOffset 0, length === buffer.byteLength)', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = ab.sliceToImmutable();
  const view = new Uint8Array(iab);
  // Witness the whole-buffer span explicitly.
  t.is(view.byteOffset, 0);
  t.is(view.length, iab.byteLength);
  harden(view);
  t.is(passStyleOf(view), 'byteArray');
});

test('byteArray rejects a sub-view with a non-zero byteOffset', t => {
  // A window into the middle of a larger immutable buffer. Its bytes are a
  // strict subset of the buffer, so the buffer carries more data than the
  // view reveals: the data-reachability hazard the restrictive span check
  // closes. Producers must re-slice such a window into its own immutable
  // buffer (via `frozenBytes`) to obtain a byteArray.
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const iab = ab.sliceToImmutable();
  const sub = new Uint8Array(iab, 2, 4);
  t.is(sub.byteOffset, 2);
  harden(sub);
  t.throws(() => passStyleOf(sub), {
    message: /must span its whole backing buffer.*byteOffset 0/,
  });
});

test('byteArray rejects a sub-view shorter than its backing buffer (byteOffset 0, short length)', t => {
  // A prefix window: byteOffset is 0 but the view stops short of the
  // buffer's end, leaving a hidden tail. Rejected for the same
  // data-reachability reason.
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const iab = ab.sliceToImmutable();
  const sub = new Uint8Array(iab, 0, 4);
  t.is(sub.byteOffset, 0);
  t.is(sub.length, 4);
  t.not(sub.length, iab.byteLength);
  harden(sub);
  t.throws(() => passStyleOf(sub), {
    message: /must span its whole backing buffer.*must equal buffer byteLength/,
  });
});

test('frozenBytes of a sub-view re-slices into a whole-buffer-spanning byteArray', t => {
  // `frozenBytes` slices the view's window into a fresh immutable buffer,
  // so the value it produces always spans its whole buffer one-to-one and
  // passes the restrictive check even when the input is a sub-view.
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const window = new Uint8Array(ab, 2, 4);
  const passable = frozenBytes(window);
  t.is(passable.byteOffset, 0);
  t.is(passable.length, passable.buffer.byteLength);
  t.is(passStyleOf(passable), 'byteArray');
  t.deepEqual([...passable], [3, 4, 5, 6]);
});

emulatedOnlyTest(
  'byteArray accepts a plain frozen non-empty emulated Uint8Array with no own indexed properties',
  t => {
    // The emulated freezable-TypedArray wrapper is a plain ordinary object
    // with no own integer-indexed properties regardless of length. Data is
    // accessible through the prototype-chain amplifier that resolves to the
    // hidden genuine TypedArray. This test confirms the acceptance criterion
    // is "no own indexed properties" rather than "zero length".
    const ab = new ArrayBuffer(8);
    new Uint8Array(ab).set([10, 20, 30, 40, 50, 60, 70, 80]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);
    // Verify the emulated wrapper has no own indexed properties.
    t.deepEqual(
      ownKeys(view).filter(k => typeof k === 'string' && /^\d+$/.test(k)),
      [],
    );
    harden(view);
    t.is(passStyleOf(view), 'byteArray');
  },
);

test('byteArray rejects a Uint8Array backed by a mutable ArrayBuffer', t => {
  // A `Uint8Array` on a mutable backing buffer cannot be frozen on either
  // the emulated or the native path: integer-indexed exotic slots are
  // non-configurable accessor-like properties and `Object.freeze` is
  // defined to reject them. `passStyleOf` therefore rejects the wrapper
  // with the "Cannot pass mutable typed arrays" message at the early
  // `isFrozen` gate, before any helper is consulted.
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const view = new Uint8Array(ab);
  t.throws(() => passStyleOf(view), {
    message: /Cannot pass mutable typed arrays/,
  });
});

emulatedOnlyTest(
  'byteArray rejects a Uint8Array on an immutable ArrayBuffer with a shadowing index that disagrees with the buffer',
  t => {
    // The emulated wrapper is a plain ordinary object whose `[[Prototype]]`
    // is `Uint8Array.prototype`. Before freezing, `view[0] = 99` succeeds
    // by creating an own data property on the wrapper that shadows the
    // prototype-based integer-indexed read. The underlying immutable
    // buffer's byte 0 is unchanged. After freezing, the wrapper carries an
    // own enumerable data property `'0'` whose value (99) disagrees with
    // the byte the underlying buffer would yield (10). Depending on harden
    // taming, either harden leaves the numeric property writable and the frozen
    // gate rejects it, or the byteArray validator catches the disagreement.
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([10, 20, 30, 40]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);
    view[0] = 99;
    harden(view);
    t.throws(() => passStyleOf(view), {
      message: /Cannot pass mutable typed arrays|must equal underlying byte/,
    });
  },
);

emulatedOnlyTest(
  'byteArray rejects an emulated Uint8Array whose own indexed property matches the buffer byte',
  t => {
    // On the emulated path the wrapper is a plain ordinary object with no own
    // indexed properties; any own indexed property is post-construction
    // tampering. The brand check rejects the wrapper even when the own
    // property's value happens to agree with the underlying buffer byte,
    // because an emulated wrapper (`ArrayBuffer.isView === false`) must have
    // zero own indexed properties (not one, not length-many: zero).
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([10, 20, 30, 40]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);
    // Write the same value the buffer already holds at index 0.
    view[0] = 10;
    harden(view);
    t.throws(() => passStyleOf(view), {
      message:
        /Cannot pass mutable typed arrays|own indexed-property count.*does not match its shape.*emulated wrapper needs 0/,
    });
  },
);

emulatedOnlyTest(
  'byteArray rejects a Uint8Array on an immutable ArrayBuffer with an out-of-range own index',
  t => {
    // An own data property whose key is a canonical integer but whose
    // index is at or beyond the wrapper's `length`. This shape can arise
    // on the emulated path through a deliberate `defineProperty` after
    // construction; the brand check rejects it as not in `[0, length)`.
    const ab = new ArrayBuffer(2);
    new Uint8Array(ab).set([1, 2]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);
    defineProperty(view, '2', {
      value: 3,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    freeze(view);
    t.throws(() => passStyleOf(view), {
      message: /must be below length/,
    });
  },
);

test('byteArray rejects a Uint8Array on an immutable ArrayBuffer with a non-index own property', t => {
  // An own data property whose key is not a canonical integer. The
  // brand check rejects all such keys regardless of descriptor shape.
  const iab = new ArrayBuffer(0).sliceToImmutable();
  const view = new Uint8Array(iab);
  defineProperty(view, 'extra', {
    value: 'hello',
    writable: false,
    enumerable: false,
    configurable: false,
  });
  harden(view);
  t.throws(() => passStyleOf(view), {
    message: /must not have own non-index properties/,
  });
});

test('byteArray rejects a Uint8Array on an immutable ArrayBuffer with a non-canonical numeric key', t => {
  // A key like `'01'` or `'1.5'` is not a canonical integer index per
  // `CanonicalNumericIndexString`. The brand check rejects it as a
  // non-index own property even though `Number(key)` is finite.
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  defineProperty(view, '01', {
    value: 0,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  freeze(view);
  t.throws(() => passStyleOf(view), {
    message: /must not have own non-index properties/,
  });
});

emulatedOnlyTest(
  'byteArray rejects a Uint8Array on an immutable ArrayBuffer with an accessor own property at an integer index',
  t => {
    // An accessor own property at a canonical index key is not a data
    // property of the spec-required shape; reject it. The wrapper's
    // shape after this `defineProperty` plus `freeze` is observable as a
    // canonical index key with an accessor descriptor; the brand check
    // rejects on the missing `value` slot.
    const ab = new ArrayBuffer(2);
    new Uint8Array(ab).set([1, 2]);
    const iab = ab.sliceToImmutable();
    const view = new Uint8Array(iab);
    defineProperty(view, '0', {
      get: () => 1,
      enumerable: true,
      configurable: false,
    });
    freeze(view);
    t.throws(() => passStyleOf(view), {
      message: /must be an enumerable number-valued data property/,
    });
  },
);

test('byteArray rejects a Uint8Array whose backing immutable ArrayBuffer carries an extraneous own property', t => {
  // The backing-buffer sub-check still walks the IAB's own keys with the
  // canonical allowlist (`[Symbol.toStringTag]` only). A buffer carrying
  // an unallowed own data property fails the sub-check before the
  // wrapper's own keys are walked.
  const iab = new ArrayBuffer(2).sliceToImmutable();
  defineProperty(iab, 'tampered', {
    value: 1,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  const view = new Uint8Array(iab);
  harden(view);
  t.throws(() => passStyleOf(view), {
    message: /ByteArrays must not have own properties/,
  });
});

test('passStyleOf fall-through blames element type, not mutability, for a non-Uint8Array typed array', t => {
  // A genuine TypedArray claimed by no helper falls through to the late
  // guard in `passStyleOf`. That guard is only reachable when the early
  // `isFrozen` gate is bypassed: under unsafe harden taming (`isFrozen`
  // returns true for unfrozen objects) on the shim leg, or on a native
  // Immutable-ArrayBuffer engine for a genuine frozen TypedArray over an
  // immutable buffer. Under safe taming these values are instead caught by
  // the early gate with the (accurate) mutable message; see the
  // `@endo/marshal` `stringify` errors test.
  //
  // `Object.isFrozen({}) === true` reliably detects the unsafe taming
  // (isFrozen is unreliable there), which is the only way to reach the
  // fall-through on this (shim) leg.
  if (!Object.isFrozen({})) {
    t.pass('safe taming: late guard unreachable on this leg');
    return;
  }
  // A non-`Uint8Array` typed array fails for its element type. The message
  // must not blame mutability (erights review,
  // endojs/endo-but-for-bots#475): a frozen non-`Uint8Array` typed array
  // over an immutable buffer reaches this same guard, where mutability is
  // genuinely not the problem.
  const int16 = harden(new Int16Array(1));
  const int16Err = t.throws(() => passStyleOf(int16), {
    message: /Cannot pass typed arrays other than Uint8Array/,
  });
  t.notRegex(int16Err.message, /mutable/);
  // A `Uint8Array` reaches this guard only with a mutable backing buffer
  // (an immutable-backed one is always claimed by the byteArray helper),
  // so "mutable" remains accurate for it.
  const u8 = harden(new Uint8Array(1));
  t.throws(() => passStyleOf(u8), {
    message: /Cannot pass mutable typed arrays/,
  });
});
