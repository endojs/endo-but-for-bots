import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: this low-level marshal test cannot depend on @endo/exo, which depends on marshal.
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far, makeTagged, passStyleOf } from '@endo/pass-style';
import { makeArbitraries } from '@endo/pass-style/tools.js';
import { makeParcel } from '@endo/parcel';
import { fc } from '@fast-check/ava';

import {
  compareRank,
  getPassStyleCover,
  isRankSorted,
  assertRankSorted,
  sortByRank,
} from '../src/rankOrder.js';
import { makeEncodePassable } from '../src/encodePassable.js';
import { makeMarshal } from '../src/marshal.js';
import { makeDotMembraneKit } from '../src/dot-membrane.js';

/** @type {any} */
const { Parcel } = globalThis;
// The shims-only AVA configuration installs Parcel before lockdown but does
// not harden it, and only a frozen Parcel is passable.
const parcelTest = Object.isFrozen(Parcel) ? test : test.skip;

/** @import {Passable} from '@endo/pass-style' */

const makeTestParcel = () => makeParcel('test:marshal', () => 'opened');

// Until marshal gives Parcels a representation, a Parcel can be neither
// rank-ordered nor encoded. Both must fail with a clear error.

parcelTest('a Parcel cannot be rank-ordered', t => {
  const parcel = makeTestParcel();
  t.is(passStyleOf(parcel), 'parcel');
  const message = /"parcel" cannot be rank-ordered/;
  t.throws(() => compareRank(parcel, 5), { message });
  t.throws(() => compareRank(5, parcel), { message });
  t.throws(() => sortByRank(harden([1, parcel]), compareRank), { message });
  t.throws(() => getPassStyleCover('parcel'), { message });
  t.throws(() => compareRank(parcel, makeTestParcel()), { message });
});

parcelTest('a Parcel compares equal to itself without a rank', t => {
  // compareRank answers 0 for identical operands before it consults their
  // pass style, so only a Parcel compared with a different value throws.
  const parcel = makeTestParcel();
  t.is(compareRank(parcel, parcel), 0);
  const parcels = harden([parcel, parcel]);
  t.is(sortByRank(parcels, compareRank), parcels);
});

parcelTest('a singleton Parcel does not require a rank', t => {
  const singleton = harden([makeTestParcel()]);
  t.true(isRankSorted(singleton, compareRank));
  t.notThrows(() => assertRankSorted(singleton, compareRank));
  t.is(sortByRank(singleton, compareRank), singleton);
});

parcelTest('a Parcel cannot be encoded', t => {
  const parcel = makeTestParcel();
  for (const format of /** @type {const} */ ([
    'legacyOrdered',
    'compactOrdered',
  ])) {
    const encodePassable = makeEncodePassable({ format });
    for (const value of [
      parcel,
      harden([parcel]),
      makeTagged('parcelBox', parcel),
    ]) {
      t.throws(() => encodePassable(value), { message: /"parcel"/ }, format);
    }
  }
});

parcelTest('a Parcel cannot be marshalled', t => {
  const message = /a "parcel" cannot be marshalled/;
  for (const serializeBodyFormat of /** @type {const} */ ([
    'capdata',
    'smallcaps',
  ])) {
    const { toCapData } = makeMarshal(undefined, undefined, {
      serializeBodyFormat,
    });
    t.throws(
      () => toCapData(makeTestParcel()),
      { message },
      serializeBodyFormat,
    );
    t.throws(
      () => toCapData(harden({ nested: [makeTestParcel()] })),
      { message },
      serializeBodyFormat,
    );
    t.throws(
      () => toCapData(makeTagged('parcelBox', makeTestParcel())),
      { message },
      serializeBodyFormat,
    );
  }
});

parcelTest(
  'generated Parcel contexts remain unrankable and unmarshalable',
  async t => {
    const { arbPassable } = makeArbitraries(fc);
    const parcelContextArbitrary = /** @type {any} */ (arbPassable);
    const marshals = /** @type {const} */ (['capdata', 'smallcaps']).map(
      serializeBodyFormat =>
        makeMarshal(undefined, undefined, { serializeBodyFormat }).toCapData,
    );
    await fc.assert(
      fc.property(parcelContextArbitrary, value => {
        const passable = /** @type {Passable} */ (value);
        const parcel = makeTestParcel();
        t.throws(() => compareRank(parcel, passable), {
          message: /"parcel" cannot be rank-ordered/,
        });
        for (const toCapData of marshals) {
          t.throws(() => toCapData(harden([parcel, passable])), {
            message: /a "parcel" cannot be marshalled/,
          });
        }
      }),
    );
  },
);

parcelTest('a Parcel cannot pass through a membrane', t => {
  // The membrane serializes what crosses it, so the encoder's own refusal is
  // what stops a Parcel.
  const message = /a "parcel" cannot be marshalled/;
  t.throws(() => makeDotMembraneKit(makeTestParcel()), { message });
  const { proxy } = makeDotMembraneKit(
    Far('holder', { getParcel: () => makeTestParcel() }),
  );
  t.throws(() => proxy.getParcel(), { message });
});
