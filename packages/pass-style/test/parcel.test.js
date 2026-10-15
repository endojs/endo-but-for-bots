import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: this low-level pass-style test cannot depend on @endo/exo, which depends on pass-style.
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

const makeParcel = (value = 'opened') => new Parcel('test:parcel', () => value);

parcelTest('passStyleOf recognizes a Parcel', t => {
  const parcel = makeParcel();
  t.is(passStyleOf(parcel), 'parcel');
  t.true(isPassable(parcel));
  // Memoized recognition gives the same answer.
  t.is(passStyleOf(parcel), 'parcel');
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
  const parcel = makeParcel();
  t.is(passStyleOf(harden({ parcel, note: 'hi' })), 'copyRecord');
  t.is(passStyleOf(harden([parcel, parcel])), 'copyArray');
  t.is(passStyleOf(makeTagged('box', parcel)), 'tagged');
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
  const parcel = makeParcel();
  const fulfilled = await deeplyFulfilled(parcel);
  t.is(fulfilled, parcel);
  const record = await deeplyFulfilled(harden({ parcel }));
  t.is(record.parcel, parcel);
});

parcelTest('recognition does not open', async t => {
  let opened = 0;
  const parcel = new Parcel('test:recognition', () => {
    opened += 1;
    return 'live';
  });
  t.is(passStyleOf(parcel), 'parcel');
  await null;
  t.is(opened, 0);
  t.is(await Parcel.open(parcel), 'live');
  t.is(opened, 1);
});

parcelTest('the constructor rejects a foreign subclass prototype', t => {
  class Subclass extends Parcel {}
  // @ts-expect-error The inherited type correctly exposes no public subclass
  // constructor; the runtime call verifies that bypassing it is also rejected.
  t.throws(() => new Subclass('test:subclass', () => 'x'), {
    message: /shared Parcel prototype/,
  });
});
