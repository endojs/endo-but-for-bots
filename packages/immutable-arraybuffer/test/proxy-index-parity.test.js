// @ts-nocheck
// Property-assignment / integer-indexed PARITY, emulated vs genuine, on this
// (Node) platform. The reviewer asked to confirm what the assignment surface
// does — throw / silent-swallow / own-property creation / write-through — for
// each of: a genuine (non-emulated) TypedArray, the shipped plain-object
// wrapper, and the Proxy wrapper. The cross-platform (Node + XS) half of the
// same matrix runs through test262-runner; see
// test/test262/immutable-arraybuffer/ and packages/test262-runner.
import '../src/shim.js';
import test from 'ava';
import { makeFreezableIndexRejectingProxy } from '../src/proxy-lib.js';

const { freeze, isFrozen } = Object;
// `.at(0)` via dynamic dispatch works for all three shapes: the genuine
// TypedArray natively, the plain-object wrapper through the shim's amplifying
// `at`, and the Proxy through its method-rebinding `get` trap. (A `.call` with
// an explicit `Uint8Array.prototype.at` would fail the Proxy's internal-slot
// brand check, which is itself part of why the Proxy needs the get trap.)
const at0 = v => v.at(0);

const immutableOf = bytes => {
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab.sliceToImmutable();
};
const proxyView = iab =>
  makeFreezableIndexRejectingProxy(
    new Uint8Array(iab.slice(0)),
    iab,
    Uint8Array.prototype,
  );

// ---------------------------------------------------------------------------
// Integer-indexed READ parity (fresh view, no prior write)
// ---------------------------------------------------------------------------

test('parity: integer-indexed READ — genuine and Proxy agree; plain-object diverges', t => {
  const genuine = new Uint8Array([10, 20, 30, 40]);
  const plain = new Uint8Array(immutableOf([10, 20, 30, 40]));
  const proxy = proxyView(immutableOf([10, 20, 30, 40]));

  // Genuine reads the byte.
  t.is(genuine[0], 10);
  // The Proxy wrapper matches the genuine TypedArray: `view[0]` reads the byte.
  t.is(proxy[0], 10);
  // The plain-object wrapper does NOT: a plain object has no integer-indexed
  // slot, so `view[0]` is `undefined` even though `view.at(0)` reads the byte.
  // (This contradicts designs/freezable-typedarray.md's worked example, which
  // claims `view[0]` returns the byte; see the design update in this PR.)
  t.is(plain[0], undefined);
  t.is(at0(plain), 10);
});

// ---------------------------------------------------------------------------
// Integer-indexed WRITE parity on a NON-frozen view
// ---------------------------------------------------------------------------

test('parity: integer-indexed WRITE (non-frozen) — write-through vs own-property vs throw', t => {
  // Genuine over a mutable buffer: write-through.
  const genuine = new Uint8Array([10, 20, 30, 40]);
  genuine[0] = 42;
  t.is(genuine[0], 42);
  t.is(at0(genuine), 42);

  // Plain-object wrapper: creates a wrapper-local own property; buffer untouched.
  const plain = new Uint8Array(immutableOf([10, 20, 30, 40]));
  plain[0] = 42;
  t.is(plain[0], 42); // shadowing own property
  t.is(at0(plain), 10); // buffer unchanged

  // Proxy wrapper: the write throws; buffer untouched.
  const proxy = proxyView(immutableOf([10, 20, 30, 40]));
  t.throws(
    () => {
      proxy[0] = 42;
    },
    { instanceOf: TypeError },
  );
  t.is(at0(proxy), 10);
});

// ---------------------------------------------------------------------------
// Integer-indexed WRITE parity on a FROZEN view
// ---------------------------------------------------------------------------

test('parity: freeze + integer-indexed WRITE — genuine unfreezable, plain swallows, proxy throws', t => {
  // A genuine TypedArray cannot be frozen at all.
  t.throws(() => freeze(new Uint8Array([10, 20, 30, 40])), {
    instanceOf: TypeError,
  });

  // Plain-object wrapper: freezes; in strict mode (this ES module) the write
  // throws because a frozen ordinary object rejects a new own property '0'
  // (it is silently swallowed in sloppy mode — see the design's worked example).
  // The frozen wrapper has no own '0', so the read-back is undefined.
  const plain = new Uint8Array(immutableOf([10, 20, 30, 40]));
  freeze(plain);
  t.true(isFrozen(plain));
  t.throws(
    () => {
      plain[0] = 42;
    },
    { instanceOf: TypeError },
  );
  t.is(plain[0], undefined);
  t.is(at0(plain), 10);

  // Proxy wrapper: freezes; the write throws (the set trap runs before the
  // frozen-object check, so it throws in both strict and sloppy mode); buffer
  // untouched.
  const proxy = proxyView(immutableOf([10, 20, 30, 40]));
  freeze(proxy);
  t.true(isFrozen(proxy));
  t.throws(
    () => {
      proxy[0] = 42;
    },
    { instanceOf: TypeError },
  );
  t.is(at0(proxy), 10);
});

// ---------------------------------------------------------------------------
// Named (non-index) property assignment parity
// ---------------------------------------------------------------------------

test('parity: NON-index property assignment forwards on all three (non-frozen)', t => {
  const genuine = new Uint8Array([1, 2]);
  genuine.foo = 7;
  t.is(genuine.foo, 7);

  const plain = new Uint8Array(immutableOf([1, 2]));
  plain.foo = 7;
  t.is(plain.foo, 7);

  const proxy = proxyView(immutableOf([1, 2]));
  proxy.foo = 7;
  t.is(proxy.foo, 7);
});
