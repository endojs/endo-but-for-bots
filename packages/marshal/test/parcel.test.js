import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: this low-level marshal test cannot depend on @endo/exo, which depends on marshal.
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far, makeTagged, passStyleOf } from '@endo/pass-style';
import { makeArbitraries } from '@endo/pass-style/tools.js';
import { makeParcel } from '@endo/parcel';
import { fc as fastCheck } from '@fast-check/ava';

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

/** @import {Passable} from '@endo/pass-style' */

const makeTestParcel = () => makeParcel('test:marshal', () => 'opened');

/**
 * @param {Passable} inner
 * @param {'array' | 'record' | 'tagged'} kind
 * @returns {Passable}
 */
const wrapParcel = (inner, kind) => {
  switch (kind) {
    case 'array':
      return harden([inner]);
    case 'record':
      return harden({ inner });
    default:
      return makeTagged('parcelBox', inner);
  }
};

const wrapperPathArbitrary = fastCheck.array(
  fastCheck.constantFrom(
    /** @type {const} */ ('array'),
    /** @type {const} */ ('record'),
    /** @type {const} */ ('tagged'),
  ),
  { maxLength: 8 },
);

test('a Parcel cannot be rank-ordered', t => {
  const parcel = makeTestParcel();
  t.is(passStyleOf(parcel), 'parcel');
  const message = /"parcel" cannot be rank-ordered/;
  t.throws(() => compareRank(parcel, 5), { message });
  t.throws(() => compareRank(5, parcel), { message });
  t.throws(() => sortByRank(harden([1, parcel]), compareRank), { message });
  t.throws(() => getPassStyleCover('parcel'), { message });
  t.throws(() => compareRank(parcel, makeTestParcel()), { message });
});

test('distinct containers of the same Parcel cannot be rank-ordered', t => {
  const parcel = makeTestParcel();
  const message = /"parcel" cannot be rank-ordered/;
  t.throws(() => compareRank(harden([parcel]), harden([parcel])), {
    message,
  });
  t.throws(() => compareRank(harden({ parcel }), harden({ parcel })), {
    message,
  });
  t.throws(
    () =>
      compareRank(
        makeTagged('parcelBox', parcel),
        makeTagged('parcelBox', parcel),
      ),
    { message },
  );
  const shared = harden([parcel]);
  t.throws(() => compareRank(harden([shared]), harden([shared])), {
    message,
  });
  const remotable = Far('remotable', {});
  t.is(compareRank(harden([remotable]), harden([remotable])), 0);
});

test('a Parcel compares equal to itself without a rank', t => {
  // compareRank answers 0 for identical operands before it consults their
  // pass style, so only a Parcel compared with a different value throws.
  const parcel = makeTestParcel();
  t.is(compareRank(parcel, parcel), 0);
  const parcels = harden([parcel, parcel]);
  t.is(sortByRank(parcels, compareRank), parcels);
});

test('a singleton Parcel does not require a rank', t => {
  const singleton = harden([makeTestParcel()]);
  t.true(isRankSorted(singleton, compareRank));
  t.notThrows(() => assertRankSorted(singleton, compareRank));
  t.is(sortByRank(singleton, compareRank), singleton);
});

test('a Parcel cannot be encoded', t => {
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

test('a Parcel cannot be marshalled', t => {
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

test('Parcels beside generated passables remain unrankable and unmarshallable', async t => {
  const { arbPassable: passableArbitrary } = makeArbitraries(fastCheck);
  const parcelContextArbitrary = /** @type {any} */ (passableArbitrary);
  const marshals = /** @type {const} */ (['capdata', 'smallcaps']).map(
    serializeBodyFormat =>
      makeMarshal(undefined, undefined, { serializeBodyFormat }).toCapData,
  );
  await fastCheck.assert(
    fastCheck.property(parcelContextArbitrary, value => {
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
});

test('Parcels nested at any depth cannot be encoded or marshalled', t => {
  const encoders = /** @type {const} */ ([
    'legacyOrdered',
    'compactOrdered',
  ]).map(format => makeEncodePassable({ format }));
  const marshals = /** @type {const} */ (['capdata', 'smallcaps']).map(
    serializeBodyFormat =>
      makeMarshal(undefined, undefined, { serializeBodyFormat }).toCapData,
  );
  fastCheck.assert(
    fastCheck.property(wrapperPathArbitrary, path => {
      const context = path.reduce(wrapParcel, makeTestParcel());
      for (const encodePassable of encoders) {
        t.throws(() => encodePassable(context), { message: /"parcel"/ });
      }
      for (const toCapData of marshals) {
        t.throws(() => toCapData(context), {
          message: /a "parcel" cannot be marshalled/,
        });
      }
    }),
    { numRuns: 200 },
  );
});

test('a Parcel cannot pass through a membrane', t => {
  const message = /a "parcel" cannot be marshalled/;
  t.throws(() => makeDotMembraneKit(makeTestParcel()), { message });
  const { proxy } = makeDotMembraneKit(
    Far('holder', { getParcel: () => makeTestParcel() }),
  );
  t.throws(() => proxy.getParcel(), { message });
});
