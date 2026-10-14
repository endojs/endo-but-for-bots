// Install the realm's Parcel before anything below can make one.
import '@endo/parcel/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { deeplyFulfilled } from '../src/deeplyFulfilled.js';
import { Far } from '../src/make-far.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';

const { create, freeze } = Object;

/** @type {any} */
const { Parcel } = globalThis;

// The shims-only AVA configuration installs Parcel before lockdown but does
// not harden it. Parcel is passable only after lockdown has frozen the realm's
// constructor and prototype, so exercise the real integration in the lockdown
// configurations. The adversarial-global tests below cover shims-only mode.
const parcelTest = Object.isFrozen(Parcel) ? test : test.skip;

const makeRef = (value = 'opened') => new Parcel('test:parcel', () => value);

parcelTest('passStyleOf recognizes a Parcel', t => {
  const ref = makeRef();
  t.is(passStyleOf(ref), 'parcel');
  t.true(isPassable(ref));
  // Memoized recognition gives the same answer.
  t.is(passStyleOf(ref), 'parcel');
});

parcelTest('distinct Parcels are distinct passables', t => {
  const openHook = () => 'same';
  const a = new Parcel('test:same', openHook);
  const b = new Parcel('test:same', openHook);
  t.not(a, b);
  t.is(passStyleOf(a), 'parcel');
  t.is(passStyleOf(b), 'parcel');
});

parcelTest('a Parcel nests in pass-by-copy containers', t => {
  const ref = makeRef();
  t.is(passStyleOf(harden({ ref, note: 'hi' })), 'copyRecord');
  t.is(passStyleOf(harden([ref, ref])), 'copyArray');
  t.is(passStyleOf(makeTagged('box', ref)), 'tagged');
});

parcelTest('recognition is by brand, not by prototype', t => {
  const forged = freeze(create(Parcel.prototype));
  t.false(Parcel.isParcel(forged));
  t.false(isPassable(forged));
  t.throws(() => passStyleOf(forged));
});

parcelTest('a PASS_STYLE marker cannot claim parcel', t => {
  const forged = harden({ [PASS_STYLE]: 'parcel' });
  t.throws(() => passStyleOf(forged), {
    message: /Unrecognized PassStyle: "parcel"/,
  });
});

parcelTest('a remotable is still a remotable', t => {
  const far = Far('Thing', { foo: () => 'foo' });
  t.false(Parcel.isParcel(far));
  t.is(passStyleOf(far), 'remotable');
});

parcelTest('deeplyFulfilled leaves a Parcel as is', async t => {
  const ref = makeRef();
  const fulfilled = await deeplyFulfilled(ref);
  t.is(fulfilled, ref);
  const record = await deeplyFulfilled(harden({ ref }));
  t.is(record.ref, ref);
});

parcelTest('recognition does not open', async t => {
  let opened = 0;
  const ref = new Parcel('test:recognition', () => {
    opened += 1;
    return 'live';
  });
  t.is(passStyleOf(ref), 'parcel');
  await null;
  t.is(opened, 0);
  t.is(await Parcel.open(ref), 'live');
  t.is(opened, 1);
});

parcelTest('the constructor rejects a foreign newTarget', t => {
  class Subclass extends Parcel {}
  // @ts-expect-error The inherited type correctly exposes no public subclass
  // constructor; the runtime call verifies that bypassing it is also rejected.
  t.throws(() => new Subclass('test:subclass', () => 'x'), {
    message: /cannot be subclassed/,
  });
});
