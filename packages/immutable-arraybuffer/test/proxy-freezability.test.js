// @ts-nocheck
// Objection 1 (design "Why not a Proxy wrapper?"): freezability under the proxy
// invariants. These tests pin down, empirically, exactly where the proxy
// invariants bite and how far a "repaired" proxy has to depart from a genuine
// TypedArray's reflection to become freezable.
import '../src/shim.js';
import test from 'ava';
import {
  makeIndexRejectingProxy,
  makeFreezableIndexRejectingProxy,
} from '../src/proxy-lib.js';

const { freeze, isFrozen, getPrototypeOf, getOwnPropertyDescriptor } = Object;

// Build a hidden genuine TypedArray over a genuine mutable copy of an immutable
// buffer's bytes, exactly as the Proxy pseudo-constructor does internally.
const makeHidden = bytes => {
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const iab = ab.sliceToImmutable();
  const genuineTA = new Uint8Array(iab.slice(0));
  return { iab, genuineTA };
};

// ---------------------------------------------------------------------------
// The natural proxy (target === the genuine TypedArray) is NOT freezable.
// ---------------------------------------------------------------------------

test('objection 1: freeze on a genuine TypedArray throws (the baseline the proxy inherits)', t => {
  const genuine = new Uint8Array([1, 2, 3, 4]);
  const err = t.throws(() => freeze(genuine), { instanceOf: TypeError });
  // V8 phrasing: "Cannot freeze array buffer views with elements".
  t.regex(err.message, /freeze|redefine|configur/i);
});

test('objection 1: the natural proxy (target = genuine TA) cannot be frozen', t => {
  const { iab, genuineTA } = makeHidden([1, 2, 3, 4]);
  const view = makeIndexRejectingProxy(genuineTA, iab);

  // Reads and methods still work through the get trap...
  t.is(view[0], 1);
  t.is(view.byteLength, 4);
  t.is(view.at(1), 2);
  t.is(view.buffer, iab);

  // ...but Object.freeze throws. SetIntegrityLevel walks the target's own
  // integer-indexed keys and asks [[DefineOwnProperty]] to make index "0"
  // non-configurable; an integer-indexed exotic refuses. This is the exact
  // invariant that bites: "Cannot redefine property: 0".
  const err = t.throws(() => freeze(view), { instanceOf: TypeError });
  t.regex(err.message, /redefine|freeze|configur|0/i);
  t.false(isFrozen(view));
});

// ---------------------------------------------------------------------------
// The repaired proxy (target === a plain object) IS freezable, at a cost.
// ---------------------------------------------------------------------------

test('objection 1: the repaired proxy freezes cleanly and reports isFrozen === true', t => {
  const { iab, genuineTA } = makeHidden([1, 2, 3, 4]);
  const view = makeFreezableIndexRejectingProxy(
    genuineTA,
    iab,
    Uint8Array.prototype,
  );

  // Reads and methods work.
  t.is(view[0], 1);
  t.is(view.byteLength, 4);
  t.is(view.at(1), 2);
  t.is(view.buffer, iab);
  t.is(getPrototypeOf(view), Uint8Array.prototype);

  // Freeze succeeds (unlike the natural proxy and unlike a genuine TypedArray).
  t.notThrows(() => freeze(view));
  t.true(isFrozen(view));
});

test('objection 1: the cost — the repaired proxy diverges from a genuine TA in reflection', t => {
  const { iab, genuineTA } = makeHidden([1, 2, 3, 4]);
  const view = makeFreezableIndexRejectingProxy(
    genuineTA,
    iab,
    Uint8Array.prototype,
  );
  const genuine = new Uint8Array([1, 2, 3, 4]);

  // A genuine TypedArray enumerates its integer indices as own keys.
  t.deepEqual(Reflect.ownKeys(genuine), ['0', '1', '2', '3']);
  t.truthy(getOwnPropertyDescriptor(genuine, '0'));

  // The repaired proxy does NOT: bracket reads work through the get trap, but
  // the indices are not own properties of the freeze-able plain target. This is
  // the "materially harder and easy to get subtly wrong" the objection names —
  // making reflection match too would re-introduce the very non-configurability
  // invariant that made the natural proxy unfreezable.
  t.deepEqual(Reflect.ownKeys(view), []);
  t.is(getOwnPropertyDescriptor(view, '0'), undefined);
  // Yet the value is still readable:
  t.is(view[0], 1);
});

// ---------------------------------------------------------------------------
// Integer-indexed assignment throws on both proxy shapes (the shared behavior).
// ---------------------------------------------------------------------------

test('objection 1: integer-indexed assignment throws on the repaired proxy (before and after freeze)', t => {
  const { iab, genuineTA } = makeHidden([1, 2, 3, 4]);
  const view = makeFreezableIndexRejectingProxy(
    genuineTA,
    iab,
    Uint8Array.prototype,
  );
  t.throws(() => {
    view[0] = 99;
  }, { instanceOf: TypeError });
  freeze(view);
  t.throws(() => {
    view[0] = 99;
  }, { instanceOf: TypeError });
  // The underlying buffer's byte 0 is untouched throughout.
  t.is(view.at(0), 1);
});
