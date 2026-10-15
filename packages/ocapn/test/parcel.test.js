// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import baseTest from '@endo/ses-ava/test.js';
import { test, testWithErrorUnwrapping, makeTestClient } from './_util.js';
import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
  swissnumToBytes,
} from '../src/client/util.js';
import {
  formatParcelLocation,
  isParcel,
  getParcelDetails,
  makeParcel,
  makeParcelTracker,
} from '../src/client/parcels.js';
import { ocapnPassStyleOf } from '../src/codecs/ocapn-pass-style.js';
import { AllCodecs, makeCodecTestKit } from './codecs/_codecs_util.js';

const Parcel = globalThis.Parcel;
const parcelIsInstalled =
  typeof Parcel === 'function' && Object.isFrozen(Parcel.prototype);
const parcelTest = parcelIsInstalled ? test : baseTest.skip;
const parcelTestWithErrorUnwrapping = parcelIsInstalled
  ? testWithErrorUnwrapping
  : baseTest.skip;

test('swissnum text conversion rejects U+0080 without changing raw bytes', t => {
  t.throws(() => encodeSwissnum('\u0080'), { instanceOf: RangeError });

  const swissNum = swissnumFromBytes(Uint8Array.of(0x80));
  t.throws(() => decodeSwissnum(swissNum), { instanceOf: RangeError });
  t.deepEqual([...swissnumToBytes(swissNum)], [0x80]);
});

test('Parcel lookup preserves non-ASCII swissnum bytes', async t => {
  /** @type {unknown[]} */
  const lookedUpSecrets = [];
  const tracker = makeParcelTracker({
    get: secret => {
      lookedUpSecrets.push(secret);
      return 'found';
    },
  });

  t.is(await tracker.lookup(swissnumFromBytes(Uint8Array.of(0x80))), 'found');
  const [lookedUpSecret] = lookedUpSecrets;
  t.true(lookedUpSecret instanceof Uint8Array);
  t.deepEqual([.../** @type {Uint8Array} */ (lookedUpSecret)], [0x80]);
});

parcelTestWithErrorUnwrapping('Parcel is a realm Parcel', async t => {
  const { client: clientA, location: locationB } = await makeTestClient({
    debugLabel: 'A',
  });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

  const parcel = clientA.makeParcel(locationB, 'test-object');

  t.true(Parcel.isParcel(parcel), 'brand check accepts it');
  t.is(passStyleOf(parcel), 'parcel', 'passStyleOf returns parcel');
  t.is(ocapnPassStyleOf(parcel), 'parcel', 'ocapnPassStyleOf returns parcel');
  t.is(Object.getPrototypeOf(parcel), Parcel.prototype);
  t.deepEqual(Reflect.ownKeys(parcel), [], 'no own properties');

  clientA.shutdown();
  clientB.shutdown();
});

parcelTestWithErrorUnwrapping(
  "Parcel doesn't expose secret/location",
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const parcel = clientA.makeParcel(locationB, 'test-object');

    t.false('location' in parcel, 'no location property');
    t.false('secret' in parcel, 'no secret property');
    t.false('swissNum' in parcel, 'no swissNum property');

    const stringified = String(parcel);
    t.is(stringified, '[object Parcel]', 'stringification shows no details');

    clientA.shutdown();
    clientB.shutdown();
  },
);

parcelTest('a Parcel minted without a client refuses to open', async t => {
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: 'tcp-test',
    transport: 'tcp',
    designator: '127.0.0.1:9999',
    hints: /** @type {const} */ (false),
  });
  const parcel = makeParcel(location, 'a-secret');
  t.true(isParcel(parcel));
  await t.throwsAsync(() => Parcel.open(parcel), {
    message: /minted without an OCapN client/,
  });
});

parcelTest('the public Parcel mint takes no custom open', async t => {
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: 'tcp-test',
    transport: 'tcp',
    designator: '127.0.0.1:9999',
    hints: /** @type {const} */ (false),
  });
  // A caller-supplied open could resolve to something other than the
  // (location, secret) the codec writes, so the public mint ignores it.
  const decoy = Far('decoy', {});
  const parcel = /** @type {any} */ (makeParcel)(
    location,
    'a-secret',
    async () => decoy,
  );
  t.deepEqual(getParcelDetails(parcel), { location, secret: 'a-secret' });
  await t.throwsAsync(() => Parcel.open(parcel), {
    message: /minted without an OCapN client/,
  });
});

parcelTest('a Parcel for another location scheme is refused by OCapN', t => {
  const foreign = new Parcel('other:elsewhere', () => 'elsewhere');
  t.is(ocapnPassStyleOf(foreign), 'parcel', 'takes the parcel codec');
  t.true(isParcel(foreign), 'it remains a realm Parcel');
  t.is(getParcelDetails(foreign), undefined);
  const { PassableCodec } = makeCodecTestKit();
  for (const codec of AllCodecs) {
    const writer = codec.makeWriter({ name: 'foreign Parcel' });
    const error = t.throws(() => PassableCodec.write(foreign, writer));
    let messages = '';
    for (let e = /** @type {any} */ (error); e; e = e.cause) {
      messages += `${e.message}\n`;
    }
    t.regex(messages, /Parcel location is not an OCapN location/);
  }
});

parcelTest('OCapN carries a Parcel it did not mint', t => {
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: 'tcp-test',
    transport: 'tcp',
    designator: '127.0.0.1:9999',
    hints: /** @type {const} */ (false),
  });
  const parcel = new Parcel(
    formatParcelLocation(location, 'shared-secret'),
    () => 'foreign-open-hook',
  );
  const { PassableCodec } = makeCodecTestKit();

  for (const codec of AllCodecs) {
    const writer = codec.makeWriter({ name: 'foreign OCapN Parcel' });
    PassableCodec.write(parcel, writer);
    const reader = codec.makeReader(writer.getBytes(), {
      name: 'foreign OCapN Parcel',
    });
    const received = PassableCodec.read(reader);
    const details = getParcelDetails(received);
    t.truthy(details);
    if (details) {
      t.like(details.location, {
        type: location.type,
        transport: location.transport,
        designator: location.designator,
        hints: location.hints,
      });
      t.deepEqual(
        [.../** @type {Uint8Array} */ (details.secret)],
        [...encodeSwissnum('shared-secret')],
      );
    }
  }
});

parcelTestWithErrorUnwrapping(
  'isParcel correctly identifies Parcels',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const parcel = clientA.makeParcel(locationB, 'test');

    t.true(isParcel(parcel), 'isParcel returns true for Parcel');
    t.false(isParcel({}), 'isParcel returns false for plain object');
    t.false(isParcel(null), 'isParcel returns false for null');
    t.false(isParcel(undefined), 'isParcel returns false for undefined');
    t.false(isParcel('string'), 'isParcel returns false for string');

    clientA.shutdown();
    clientB.shutdown();
  },
);

parcelTestWithErrorUnwrapping(
  'getParcelDetails returns correct details',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const parcel = clientA.makeParcel(locationB, 'test-object');

    const details = getParcelDetails(parcel);
    t.truthy(details, 'getParcelDetails returns details');
    if (details) {
      t.deepEqual(details.location, locationB, 'location matches');
      t.is(details.secret, 'test-object', 'secret matches');
    }

    const notAParcel = /** @type {any} */ ({});
    const noDetails = getParcelDetails(notAParcel);
    t.is(
      noDetails,
      undefined,
      'getParcelDetails returns undefined for non-Parcel',
    );

    clientA.shutdown();
    clientB.shutdown();
  },
);

parcelTest('client.openParcel() returns promise for fetched value', async t => {
  const testObjectTable = new Map();
  const testObject = Far('TestObject', {
    getValue: () => 42,
  });
  testObjectTable.set('test-object', testObject);

  const { client: clientA } = await makeTestClient({ debugLabel: 'A' });
  const { client: clientB, location: locationB } = await makeTestClient({
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => testObjectTable,
  });

  const parcel = clientA.makeParcel(locationB, 'test-object');

  const resolveResult = clientA.openParcel(parcel);
  t.truthy(resolveResult, 'openParcel returns something');
  t.truthy(resolveResult instanceof Promise, 'openParcel returns a promise');

  const resolved = await resolveResult;
  const value = await E(resolved).getValue();
  t.is(value, 42, 'fetched value works correctly');

  clientA.shutdown();
  clientB.shutdown();
});

parcelTest('Parcel.open() fetches through the minting client', async t => {
  const testObjectTable = new Map();
  testObjectTable.set(
    'test-object',
    Far('TestObject', {
      getValue: () => 42,
    }),
  );

  const { client: clientA } = await makeTestClient({ debugLabel: 'A' });
  const { client: clientB, location: locationB } = await makeTestClient({
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => testObjectTable,
  });

  const parcel = clientA.makeParcel(locationB, 'test-object');
  const resolved = /** @type {any} */ (await Parcel.open(parcel));
  t.is(await E(resolved).getValue(), 42);

  clientA.shutdown();
  clientB.shutdown();
});

parcelTest('Resolved values are not Parcels', async t => {
  const testObjectTable = new Map();
  const testObject = Far('TestObject', {
    getValue: () => 42,
  });
  testObjectTable.set('test-object', testObject);

  const { client: clientA } = await makeTestClient({ debugLabel: 'A' });
  const { client: clientB, location: locationB } = await makeTestClient({
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => testObjectTable,
  });

  const parcel = clientA.makeParcel(locationB, 'test-object');

  t.true(isParcel(parcel), 'parcel is a Parcel before resolve');

  const resolved = await clientA.openParcel(parcel);

  t.false(isParcel(resolved), 'resolved value is not a Parcel');

  const value = await E(resolved).getValue();
  t.is(value, 42, 'resolved value works correctly');

  clientA.shutdown();
  clientB.shutdown();
});

parcelTest('Parcel to self-location can be resolved', async t => {
  const testObjectTable = new Map();
  const testObject = Far('TestObject', {
    getValue: () => 42,
  });
  testObjectTable.set('test-object', testObject);

  const { client: clientA, location: locationA } = await makeTestClient({
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => testObjectTable,
  });

  const parcel = clientA.makeParcel(locationA, 'test-object');

  t.true(isParcel(parcel), 'parcel is a Parcel');

  const resolved = await clientA.openParcel(parcel);

  t.false(isParcel(resolved), 'resolved value is not a Parcel');

  const value = await E(resolved).getValue();
  t.is(value, 42, 'resolved self-location value works correctly');

  clientA.shutdown();
});
