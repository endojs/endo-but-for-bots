// @ts-nocheck
// Exercises the shim as used in a real HardenedJS realm: lockdown FIRST, then
// the shim installs and hardens after lockdown. Each test pins one property
// of the layer-1 SturdyRef contract (designs/sturdyref-shim-contract.md).

import '@endo/init';
import test from 'ava';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import {
  makeSturdyRef,
  enliven,
  isSturdyRef,
} from '../src/sturdyref-pony.js';
import {
  provideSturdyRef,
  selectSturdyRef,
  makeSturdyRefConstructor,
} from '../src/sturdyref-shim.js';

const { isFrozen, getPrototypeOf } = Object;

const makeHandler = live => ({ enliven: () => live });

test('installed after lockdown: hardened and functioning', async t => {
  const SturdyRef = provideSturdyRef();
  t.is(globalThis.SturdyRef, SturdyRef, 'installed at globalThis.SturdyRef');
  t.true(isFrozen(SturdyRef), 'constructor is hardened');
  t.true(isFrozen(SturdyRef.prototype), 'prototype is hardened');
  t.true(isFrozen(SturdyRef.enliven), 'enliven is hardened');
  t.true(isFrozen(SturdyRef.isSturdyRef), 'isSturdyRef is hardened');
  t.deepEqual(
    Reflect.ownKeys(SturdyRef.prototype),
    ['constructor', Symbol.toStringTag],
    'prototype carries only constructor and toStringTag',
  );

  const live = harden({ live: true });
  const ref = new SturdyRef(makeHandler(live));
  t.true(isFrozen(ref), 'ref is frozen');
  t.is(getPrototypeOf(ref), SturdyRef.prototype);
  t.is(Object.prototype.toString.call(ref), '[object SturdyRef]');
  t.true(SturdyRef.isSturdyRef(ref));
  t.is(await SturdyRef.enliven(ref), live, 'enlivens through the handler');
});

test('capture is handler-defined', async t => {
  const locator = harden({ kind: 'test-locator', endpoint: 'wormhole:abc' });
  const handler = {
    enliven(ref) {
      return harden({ locator, self: this, ref });
    },
  };
  const ref = makeSturdyRef(handler);
  const result = await enliven(ref);
  t.is(result.locator, locator, 'the handler closes over what it captures');
  t.is(result.self, handler, 'the hook is called with the handler as this');
  t.is(result.ref, ref, 'the hook receives the ref');
});

test('no location: opaque, no own keys, handler unreachable', t => {
  const handler = makeHandler('secret');
  const ref = makeSturdyRef(handler);
  t.deepEqual(Reflect.ownKeys(ref), [], 'no own keys');
  for (const key of Reflect.ownKeys(getPrototypeOf(ref))) {
    t.not(Reflect.get(getPrototypeOf(ref), key), handler);
  }
  t.throws(
    () => passStyleOf(ref),
    undefined,
    'passStyleOf rejects a SturdyRef',
  );
});

test('no identification: the same handler mints distinct refs', async t => {
  const handler = makeHandler('same');
  const a = makeSturdyRef(handler);
  const b = makeSturdyRef(handler);
  t.not(a, b, 'distinct refs');
  t.is(await enliven(a), 'same');
  t.is(await enliven(b), 'same');
});

test('enliven dispatches to the hook in a later turn', async t => {
  let called = false;
  const ref = makeSturdyRef({
    enliven: () => {
      called = true;
      return 'later';
    },
  });
  const p = enliven(ref);
  t.false(called, 'the hook has not run synchronously');
  t.is(await p, 'later');
  t.true(called);
});

test('enliven: a throwing hook rejects', async t => {
  const ref = makeSturdyRef({
    enliven: () => {
      throw Error('revoked');
    },
  });
  await t.throwsAsync(() => enliven(ref), { message: 'revoked' });
});

test('enliven: a non-SturdyRef rejects rather than throwing', async t => {
  let p;
  t.notThrows(() => {
    p = enliven(harden({}));
  });
  await t.throwsAsync(() => p, { message: /expects a SturdyRef/ });
  await t.throwsAsync(() => enliven(undefined), {
    message: /expects a SturdyRef/,
  });
});

test('enliven is read once, at construction', async t => {
  const handler = { enliven: () => 'original' };
  const ref = makeSturdyRef(handler);
  handler.enliven = () => 'replaced';
  t.is(await enliven(ref), 'original');
});

test('construction: a handler without enliven throws', t => {
  const SturdyRef = provideSturdyRef();
  t.throws(() => new SturdyRef({}), { message: /enliven/ });
  t.throws(() => new SturdyRef({ enliven: 'nope' }), { message: /enliven/ });
  t.throws(() => new SturdyRef(undefined), { message: /handler/ });
  t.throws(() => new SturdyRef('handler'), { message: /handler/ });
});

test('construction: calling without new throws', t => {
  const SturdyRef = provideSturdyRef();
  t.throws(() => SturdyRef(makeHandler(1)), { instanceOf: TypeError });
});

test('construction: a foreign new.target throws', t => {
  const SturdyRef = provideSturdyRef();
  // A caller-chosen prototype could give a branded ref a `then` or a
  // `toString`, making it anything but inert.
  function NT() {}
  NT.prototype = { then: resolve => resolve('pwned') };
  t.throws(() => Reflect.construct(SturdyRef, [makeHandler(1)], NT), {
    instanceOf: TypeError,
  });
  class Sub extends SturdyRef {}
  t.throws(() => new Sub(makeHandler(1)), { instanceOf: TypeError });
});

test('isSturdyRef is a brand check', t => {
  t.true(isSturdyRef(makeSturdyRef(makeHandler(1))));
  t.false(isSturdyRef(harden({})));
  t.false(isSturdyRef(undefined));
  t.false(isSturdyRef('SturdyRef'));
  t.false(isSturdyRef(Object.create(provideSturdyRef().prototype)));
});

// Layer 2 (SES) owns the permit and propagation of `SturdyRef` to child
// compartments. Until then, this pins the observed default rather than a
// confinement property: installed after lockdown without a SES permit, the
// global is not present in a child compartment.
test('default: installed after lockdown without a SES permit, a child compartment does not see SturdyRef', t => {
  provideSturdyRef();
  t.not(globalThis.SturdyRef, undefined, 'present on the start compartment');

  const child = new Compartment();
  t.is(child.evaluate('typeof SturdyRef'), 'undefined');
});

test('first-wins: selections converge on one constructor', async t => {
  const First = selectSturdyRef();
  const Second = selectSturdyRef();
  t.is(First, Second, 'both selections yield the one installed constructor');
  t.is(globalThis.SturdyRef, First);

  const ref = new First(makeHandler('converged'));
  t.true(Second.isSturdyRef(ref));
  t.is(await Second.enliven(ref), 'converged');

  // Control: an un-installed constructor has its OWN private WeakMap, proving
  // the convergence above is real and not an artifact of one shared closure.
  const isolated = makeSturdyRefConstructor();
  t.not(isolated, First);
  t.false(isolated.isSturdyRef(ref));
  await t.throwsAsync(() => isolated.enliven(ref), {
    message: /expects a SturdyRef/,
  });
});
