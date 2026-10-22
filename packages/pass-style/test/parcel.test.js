import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: this low-level pass-style test cannot depend on @endo/exo, which depends on pass-style.
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { makeParcel } from '@endo/parcel';
import { fc as fastCheck } from '@fast-check/ava';
import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { deeplyFulfilled } from '../src/deeplyFulfilled.js';
import { Far } from '../src/make-far.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';
import { isParcelObject } from '../src/parcel.js';
import { makeArbitraries } from '../tools.js';

const { create, freeze, getPrototypeOf, isFrozen } = Object;
const { ownKeys } = Reflect;

/** @type {any} */
const { Parcel } = globalThis;

test('passStyleOf recognizes a Parcel', t => {
  const parcel = makeParcel('test:parcel', () => 'opened');
  t.is(passStyleOf(parcel), 'parcel');
  t.true(isPassable(parcel));
  // Memoized recognition gives the same answer.
  t.is(passStyleOf(parcel), 'parcel');
});

test('distinct Parcels are distinct passables', t => {
  const openHook = () => 'same';
  const a = new Parcel('test:same', openHook);
  const b = new Parcel('test:same', openHook);
  t.not(a, b);
  t.is(passStyleOf(a), 'parcel');
  t.is(passStyleOf(b), 'parcel');
});

test('a Parcel nests in pass-by-copy containers', t => {
  const parcel = makeParcel('test:parcel', () => 'opened');
  t.is(passStyleOf(harden({ parcel, note: 'hi' })), 'copyRecord');
  t.is(passStyleOf(harden([parcel, parcel])), 'copyArray');
  t.is(passStyleOf(makeTagged('box', parcel)), 'tagged');
});

test('Parcel passability composes with generated passables', async t => {
  const { arbPassable: passableArbitrary } = makeArbitraries(fastCheck);
  await fastCheck.assert(
    fastCheck.property(
      passableArbitrary,
      fastCheck.string(),
      (value, location) => {
        const parcel = makeParcel(location, () => value);
        t.is(passStyleOf(harden([parcel, value])), 'copyArray');
        t.is(passStyleOf(harden({ parcel, value })), 'copyRecord');
        t.is(
          passStyleOf(makeTagged('parcelBox', harden([parcel, value]))),
          'tagged',
        );
      },
    ),
  );
});

test('Parcels nested at any depth are passable', t => {
  /**
   * @param {unknown} inner
   * @param {'array' | 'record' | 'tagged'} kind
   */
  const wrapParcel = (inner, kind) => {
    switch (kind) {
      case 'array':
        return harden([inner]);
      case 'record':
        return harden({ inner });
      default:
        return makeTagged('parcelBox', /** @type {any} */ (inner));
    }
  };
  fastCheck.assert(
    fastCheck.property(
      fastCheck.array(
        fastCheck.constantFrom(
          /** @type {const} */ ('array'),
          /** @type {const} */ ('record'),
          /** @type {const} */ ('tagged'),
        ),
        { maxLength: 8 },
      ),
      path => {
        const context = path.reduce(
          wrapParcel,
          /** @type {unknown} */ (makeParcel('test:parcel', () => 'opened')),
        );
        t.true(isPassable(context));
      },
    ),
    { numRuns: 200 },
  );
});

test('an object shaped like a Parcel is not a Parcel', t => {
  const parcel = makeParcel('test:parcel', () => 'opened');
  const impostor = freeze(create(Parcel.prototype));
  t.is(getPrototypeOf(impostor), getPrototypeOf(parcel));
  t.true(isFrozen(impostor));
  t.deepEqual(ownKeys(impostor), ownKeys(parcel));
  t.false(Parcel.isParcel(impostor));
  t.false(isParcelObject(impostor));
  t.false(isPassable(impostor));
  t.throws(() => passStyleOf(impostor));
});

test('a PASS_STYLE marker cannot claim parcel', t => {
  const forged = harden({ [PASS_STYLE]: 'parcel' });
  t.throws(() => passStyleOf(forged), {
    message: /Unrecognized PassStyle: "parcel"/,
  });
});

test('a remotable is still a remotable', t => {
  const far = Far('Thing', { foo: () => 'foo' });
  t.false(Parcel.isParcel(far));
  t.is(passStyleOf(far), 'remotable');
});

test('deeplyFulfilled leaves a Parcel as is', async t => {
  const parcel = makeParcel('test:parcel', () => 'opened');
  const fulfilled = await deeplyFulfilled(parcel);
  t.is(fulfilled, parcel);
  const record = await deeplyFulfilled(harden({ parcel }));
  t.is(record.parcel, parcel);
});

test('recognition does not open', async t => {
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

test('the constructor rejects a foreign subclass prototype', t => {
  class Subclass extends Parcel {}
  // @ts-expect-error The inherited type correctly exposes no public subclass
  // constructor; the runtime call verifies that bypassing it is also rejected.
  t.throws(() => new Subclass('test:subclass', () => 'x'), {
    message: /shared Parcel prototype/,
  });
});
