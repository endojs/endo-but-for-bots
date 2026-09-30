// Install the realm's SturdyRef before anything below can make one.
import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { makeSturdyRefConstructor } from '@endo/sturdyref';

import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { deeplyFulfilled } from '../src/deeplyFulfilled.js';
import { Far } from '../src/make-far.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';

const { create, freeze } = Object;

/** @type {any} */
const { SturdyRef } = globalThis;

const makeRef = (value = 'revived') =>
  new SturdyRef({
    enliven: () => value,
  });

test('passStyleOf recognizes a SturdyRef', t => {
  const ref = makeRef();
  t.is(passStyleOf(ref), 'sturdyRef');
  t.true(isPassable(ref));
  // Memoized recognition gives the same answer.
  t.is(passStyleOf(ref), 'sturdyRef');
});

test('distinct SturdyRefs are distinct passables', t => {
  const handler = { enliven: () => 'same' };
  const a = new SturdyRef(handler);
  const b = new SturdyRef(handler);
  t.not(a, b);
  t.is(passStyleOf(a), 'sturdyRef');
  t.is(passStyleOf(b), 'sturdyRef');
});

test('a SturdyRef nests in pass-by-copy containers', t => {
  const ref = makeRef();
  t.is(passStyleOf(harden({ ref, note: 'hi' })), 'copyRecord');
  t.is(passStyleOf(harden([ref, ref])), 'copyArray');
  t.is(passStyleOf(makeTagged('box', ref)), 'tagged');
});

test('recognition is by brand, not by prototype', t => {
  const forged = freeze(create(SturdyRef.prototype));
  t.false(SturdyRef.isSturdyRef(forged));
  t.false(isPassable(forged));
  t.throws(() => passStyleOf(forged));
});

test('a PASS_STYLE marker cannot claim sturdyRef', t => {
  const forged = harden({ [PASS_STYLE]: 'sturdyRef' });
  t.throws(() => passStyleOf(forged), {
    message: /Unrecognized PassStyle: "sturdyRef"/,
  });
});

test('a ref from an uninstalled twin is not recognized', t => {
  // A constructor that lost the first-wins race has its own brand. Its refs
  // are not the realm's SturdyRefs, so pass-style rejects them.
  const Twin = makeSturdyRefConstructor();
  const stray = new Twin({ enliven: () => 'stray' });
  t.true(Twin.isSturdyRef(stray));
  t.false(SturdyRef.isSturdyRef(stray));
  t.throws(() => passStyleOf(stray));
});

test('a remotable is still a remotable', t => {
  const far = Far('Thing', { foo: () => 'foo' });
  t.false(SturdyRef.isSturdyRef(far));
  t.is(passStyleOf(far), 'remotable');
});

test('deeplyFulfilled leaves a SturdyRef as is', async t => {
  const ref = makeRef();
  const fulfilled = await deeplyFulfilled(ref);
  t.is(fulfilled, ref);
  const record = await deeplyFulfilled(harden({ ref }));
  t.is(record.ref, ref);
});

test('recognition does not enliven', async t => {
  let enlivened = 0;
  const ref = new SturdyRef({
    enliven: () => {
      enlivened += 1;
      return 'live';
    },
  });
  t.is(passStyleOf(ref), 'sturdyRef');
  await null;
  t.is(enlivened, 0);
  t.is(await SturdyRef.enliven(ref), 'live');
  t.is(enlivened, 1);
});

test('a ref constructed with a foreign newTarget is not recognized', t => {
  // The constructor brands whatever `this` it is given, so a ref can be made
  // to inherit from a prototype its maker controls. Recognition requires the
  // global's own prototype, so such a ref can never become a thenable later.
  function NewTarget() {}
  NewTarget.prototype = { poke: () => 'hi' };
  const ref = Reflect.construct(SturdyRef, [{ enliven: () => 'x' }], NewTarget);
  t.true(SturdyRef.isSturdyRef(ref));
  t.throws(() => passStyleOf(ref));

  class Subclass extends SturdyRef {}
  const sub = Reflect.construct(Subclass, [{ enliven: () => 'x' }]);
  t.true(SturdyRef.isSturdyRef(sub));
  t.throws(() => passStyleOf(sub));
});
