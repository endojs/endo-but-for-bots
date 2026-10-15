import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: this low-level marshal test cannot depend on @endo/exo, which depends on marshal.
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far, passStyleOf } from '@endo/pass-style';

import {
  compareRank,
  getPassStyleCover,
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

const makeParcel = () => new Parcel('test:marshal', () => 'opened');

// Until marshal gives Parcels a representation, a Parcel can be neither
// rank-ordered nor encoded. Both must fail with a clear error.

parcelTest('a Parcel cannot be rank-ordered', t => {
  const parcel = makeParcel();
  t.is(passStyleOf(parcel), 'parcel');
  const message = /"parcel" cannot be rank-ordered/;
  t.throws(() => compareRank(parcel, 5), { message });
  t.throws(() => compareRank(5, parcel), { message });
  t.throws(() => sortByRank(harden([1, parcel]), compareRank), { message });
  t.throws(() => getPassStyleCover('parcel'), { message });
  t.throws(() => compareRank(parcel, makeParcel()), { message });
});

parcelTest('a Parcel compares equal to itself without a rank', t => {
  // compareRank answers 0 for identical operands before it consults their
  // pass style, so only a Parcel compared with a different value throws.
  const parcel = makeParcel();
  t.is(compareRank(parcel, parcel), 0);
  const parcels = harden([parcel, parcel]);
  t.is(sortByRank(parcels, compareRank), parcels);
});

parcelTest('a Parcel cannot be encoded', t => {
  const encodePassable = makeEncodePassable();
  t.throws(() => encodePassable(makeParcel()), {
    message: /"parcel"/,
  });
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
    t.throws(() => toCapData(makeParcel()), { message }, serializeBodyFormat);
    t.throws(
      () => toCapData(harden({ nested: [makeParcel()] })),
      { message },
      serializeBodyFormat,
    );
  }
});

parcelTest('a Parcel cannot pass through a membrane', t => {
  // The membrane serializes what crosses it, so the encoder's own refusal is
  // what stops a Parcel.
  const message = /a "parcel" cannot be marshalled/;
  t.throws(() => makeDotMembraneKit(makeParcel()), { message });
  const { proxy } = makeDotMembraneKit(
    Far('holder', { getParcel: () => makeParcel() }),
  );
  t.throws(() => proxy.getParcel(), { message });
});
