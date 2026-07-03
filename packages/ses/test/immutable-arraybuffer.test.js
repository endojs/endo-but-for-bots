import test from 'ava';
import '../index.js';
import {
  makeFreezableIndexRejectingProxy,
  makeIndexRejectingProxy,
} from '@endo/immutable-arraybuffer/proxy-lib.js';

const { isFrozen, getPrototypeOf } = Object;

lockdown();

test('ses Immutable ArrayBuffer shim installed and hardened', t => {
  const ab1 = new ArrayBuffer(0);
  const iab = ab1.sliceToImmutable();
  const iabProto = getPrototypeOf(iab);
  t.true(isFrozen(iabProto));
  t.true(isFrozen(iabProto.slice));
});

test('ses: emulated freezable Uint8Array is hardened and Object.isFrozen(view) === true after lockdown', t => {
  // After lockdown(), harden() has been applied to all primordials.
  // The emulated freezable wrapper is a plain object inheriting from
  // Uint8Array.prototype (a frozen prototype), so Object.isFrozen(view)
  // is true after `Object.freeze(view)` (which harden invokes transitively
  // via the prototype-walk phase).
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  // Object.freeze on a plain object succeeds (no integer-indexed exotic slots).
  Object.freeze(view);
  t.true(isFrozen(view));
});

test('ses: permits walk does not complain about %TypedArrayPrototype% slots the shim installs', t => {
  // If lockdown() completed without throwing a permits-walk TypeError, the
  // shim-installed slots (buffer accessor replacement, mutator-throws wrappers,
  // read-delegate wrappers) all fit within the existing %TypedArrayPrototype%
  // permits entry. This test asserts the post-lockdown surface is present.
  const tp = getPrototypeOf(Uint8Array.prototype);
  t.true('buffer' in tp);
  t.true('byteLength' in tp);
  t.true('copyWithin' in tp);
  t.true('fill' in tp);
  t.true('reverse' in tp);
  t.true('set' in tp);
  t.true('sort' in tp);
});

test('ses: emulated freezable view mutator methods still throw after lockdown', t => {
  // The harden phase freezes all primordials; verify the lib's discrimination
  // logic (brand WeakMap lookup) still works correctly after hardening.
  const iab = new ArrayBuffer(4).sliceToImmutable();
  const view = new Uint8Array(iab);
  t.throws(() => view.fill(0), { instanceOf: TypeError });
  t.throws(() => view.set([0]), { instanceOf: TypeError });
  t.throws(() => view.reverse(), { instanceOf: TypeError });
  t.throws(() => view.sort(), { instanceOf: TypeError });
  t.throws(() => view.copyWithin(0, 1), { instanceOf: TypeError });
});

// ---------------------------------------------------------------------------
// Proxy-based emulation variant (alternative, for comparison) under SES.
// Objection 1's SES half: does harden() freeze a Proxy wrapper transitively?
// See packages/immutable-arraybuffer/designs/freezable-typedarray.md
// ("Why not a Proxy wrapper?") and .../proxy-lib.js.
// ---------------------------------------------------------------------------

const proxyHidden = bytes => {
  const iab = new ArrayBuffer(bytes.length).sliceToImmutable();
  // A fresh immutable buffer starts zeroed; the exact bytes do not matter for
  // these freeze/harden assertions.
  return { iab, genuineTA: new Uint8Array(iab.slice(0)) };
};

test('ses (proxy variant): the freezable Proxy wrapper hardens transitively like a plain object', t => {
  const { iab, genuineTA } = proxyHidden([1, 2, 3, 4]);
  const view = makeFreezableIndexRejectingProxy(
    genuineTA,
    iab,
    Uint8Array.prototype,
  );
  t.notThrows(() => harden(view));
  t.true(isFrozen(view));
  // Reads still work after hardening; indexed assignment still throws.
  t.is(view.at(0), 0);
  t.throws(() => {
    view[0] = 9;
  }, { instanceOf: TypeError });
});

test('ses (proxy variant): the natural Proxy (target = genuine TypedArray) cannot be hardened', t => {
  const { iab, genuineTA } = proxyHidden([1, 2, 3, 4]);
  const view = makeIndexRejectingProxy(genuineTA, iab);
  // harden walks the object and Object.freezes it; freezing an integer-indexed
  // exotic target throws ("Cannot redefine property: 0"), so harden throws too.
  // This is objection 1: the natural proxy is not (harden-)freezable.
  t.throws(() => harden(view));
});
