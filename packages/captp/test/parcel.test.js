import '@endo/parcel/shim.js';
// prefer-endo-primitives-exempt: CapTP fixtures use Far for one-off wire presences.
import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { locate } from '@endo/parcel';
import { makeCapTP, E } from '../src/captp.js';

/** @type {any} */
const { Parcel } = globalThis;

const makeParcelCodec = openLocation => {
  const make = location => {
    return new Parcel(location, openLocation);
  };
  return {
    make,
    encodeParcel: parcel => locate(parcel),
    decodeParcel: make,
  };
};

let parcelIsPassable = false;
try {
  const probe = new Parcel('test:probe', () => undefined);
  parcelIsPassable = passStyleOf(probe) === 'parcel';
} catch {
  // The shims-only configuration has not hardened Parcel yet.
}
const parcelTest = parcelIsPassable ? test : test.skip;

parcelTest('makeCapTP carries a Parcel inline without an s slot', async t => {
  const sent = [];
  const leftCodec = makeParcelCodec(location => `left:${location}`);
  const rightCodec = makeParcelCodec(location => `right:${location}`);
  const origin = rightCodec.make('test:durable');

  /** @type {any} */
  let right;
  const left = makeCapTP(
    'left',
    obj => {
      sent.push(obj);
      return right.dispatch(obj);
    },
    undefined,
    leftCodec,
  );
  right = makeCapTP(
    'right',
    obj => {
      sent.push(obj);
      return left.dispatch(obj);
    },
    Far('bootstrap', { getParcel: () => origin }),
    rightCodec,
  );

  const parcel = await E(left.getBootstrap()).getParcel();
  const parcelAgain = await E(left.getBootstrap()).getParcel();
  t.not(parcelAgain, parcel);
  t.is(passStyleOf(parcel), 'parcel');
  t.is(await Parcel.open(parcel), 'left:test:durable');
  t.is(await Parcel.open(parcelAgain), 'left:test:durable');

  const resolution = sent.find(
    message =>
      message.type === 'CTP_RETURN' &&
      message.result?.body?.includes('"@qclass":"parcel"'),
  );
  t.truthy(resolution);
  t.deepEqual(resolution.result.slots, []);
  t.regex(resolution.result.body, /"@qclass":"parcel"/);
  t.regex(resolution.result.body, /"location":"test:durable"/);
  t.false(resolution.result.body.includes('s+'));
});
