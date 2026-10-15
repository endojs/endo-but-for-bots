// Install the realm's Parcel before anything below can make one.
import '@endo/parcel/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';

import { makeMarshal } from '../src/marshal.js';
import { decodeToJustin } from '../src/marshal-justin.js';
import { makePassableKit, passStylePrefixes } from '../src/encodePassable.js';
import { compareRank } from '../src/rankOrder.js';

/** @type {any} */
const { Parcel } = globalThis;

const locations = new WeakMap();
const makeParcel = location => {
  const parcel = new Parcel(location, loc => `opened:${loc}`);
  locations.set(parcel, location);
  return parcel;
};
const encodeParcel = parcel => locations.get(parcel);
const decodeParcel = location => makeParcel(location);
let parcelIsPassable = false;
try {
  parcelIsPassable = passStyleOf(makeParcel('test:probe')) === 'parcel';
} catch {
  // The shims-only configuration has not hardened the constructor yet.
}
const parcelTest = parcelIsPassable ? test : test.skip;

for (const serializeBodyFormat of /** @type {const} */ ([
  'capdata',
  'smallcaps',
])) {
  parcelTest(
    `Parcel round-trips inline through ${serializeBodyFormat}`,
    async t => {
      const { toCapData, fromCapData } = makeMarshal(undefined, undefined, {
        serializeBodyFormat,
        encodeParcel,
        decodeParcel,
      });
      const parcel = makeParcel('#ocapn=1&peer=alice&value=secret');
      const capData = toCapData(harden({ parcel, again: parcel }));
      t.deepEqual(capData.slots, []);
      const expectedBody =
        serializeBodyFormat === 'capdata'
          ? '{"again":{"@qclass":"parcel","location":"#ocapn=1&peer=alice&value=secret"},"parcel":{"@qclass":"parcel","location":"#ocapn=1&peer=alice&value=secret"}}'
          : `#{"again":"'#ocapn=1&peer=alice&value=secret","parcel":"'#ocapn=1&peer=alice&value=secret"}`;
      t.is(capData.body, expectedBody);

      const decoded = /** @type {any} */ (fromCapData(capData));
      t.is(passStyleOf(decoded.parcel), 'parcel');
      t.is(passStyleOf(decoded.again), 'parcel');
      t.is(
        await Parcel.open(decoded.parcel),
        'opened:#ocapn=1&peer=alice&value=secret',
      );
    },
  );

  parcelTest(`${serializeBodyFormat} requires explicit Parcel authority`, t => {
    const parcel = makeParcel('test:no-authority');
    const plain = makeMarshal(undefined, undefined, { serializeBodyFormat });
    t.throws(() => plain.toCapData(parcel), {
      message: /parcel unexpected/,
    });

    const body =
      serializeBodyFormat === 'capdata'
        ? '{"@qclass":"parcel","location":"test:no-authority"}'
        : `#"'test:no-authority"`;
    t.throws(() => plain.fromCapData({ body, slots: [] }), {
      message: /parcel unexpected/,
    });
  });
}

parcelTest('capdata validates an inline Parcel encoding', t => {
  const { fromCapData } = makeMarshal(undefined, undefined, { decodeParcel });
  t.throws(
    () =>
      fromCapData({
        body: '{"@qclass":"parcel","location":3}',
        slots: [],
      }),
    { message: /location must be a string/ },
  );
  t.throws(
    () =>
      fromCapData({
        body: '{"@qclass":"parcel","location":"x","index":0}',
        slots: [],
      }),
    { message: /unexpected encoded parcel properties/ },
  );
});

parcelTest('decodeToJustin renders a Parcel location inline', t => {
  const body = harden({ '@qclass': 'parcel', location: 'test:justin' });
  t.is(decodeToJustin(body), 'parcel("test:justin")');
  const compartment = new Compartment({
    parcel: location => makeParcel(location),
  });
  const parcel = compartment.evaluate(`(${decodeToJustin(body)})`);
  t.is(passStyleOf(parcel), 'parcel');
  t.is(encodeParcel(parcel), 'test:justin');
});

parcelTest('ordered encoding retains the t category for Parcel', t => {
  const parcel = makeParcel('test:ordered');
  const parcels = [parcel];
  for (const format of /** @type {const} */ ([
    'legacyOrdered',
    'compactOrdered',
  ])) {
    const { encodePassable, decodePassable } = makePassableKit({
      format,
      encodeParcel: value => `t${parcels.indexOf(value)}`,
      decodeParcel: encoding => parcels[Number(encoding.slice(1))],
    });
    const encoded = encodePassable(parcel);
    t.true(encoded.includes('t0'), encoded);
    t.is(decodePassable(encoded), parcel);
  }
  t.is(passStylePrefixes.parcel, 't');
  t.is(compareRank(parcel, makeParcel('test:other')), 0);
});
