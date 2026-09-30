// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { provideSturdyRef } from '@endo/sturdyref';
import { test, testWithErrorUnwrapping, makeTestClient } from './_util.js';
import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
  swissnumToBytes,
} from '../src/client/util.js';
import {
  isSturdyRef,
  getSturdyRefDetails,
  makeSturdyRef,
  makeSturdyRefTracker,
} from '../src/client/sturdyrefs.js';
import { ocapnPassStyleOf } from '../src/codecs/ocapn-pass-style.js';
import { AllCodecs, makeCodecTestKit } from './codecs/_codecs_util.js';

const SturdyRef = provideSturdyRef();

test('swissnum text conversion rejects U+0080 without changing raw bytes', t => {
  t.throws(() => encodeSwissnum('\u0080'), { instanceOf: RangeError });

  const swissNum = swissnumFromBytes(Uint8Array.of(0x80));
  t.throws(() => decodeSwissnum(swissNum), { instanceOf: RangeError });
  t.deepEqual([...swissnumToBytes(swissNum)], [0x80]);
});

test('SturdyRef lookup preserves non-ASCII swissnum bytes', async t => {
  /** @type {unknown[]} */
  const lookedUpSecrets = [];
  const tracker = makeSturdyRefTracker({
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

testWithErrorUnwrapping('SturdyRef is a realm SturdyRef', async t => {
  const { client: clientA, location: locationB } = await makeTestClient({
    debugLabel: 'A',
  });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  t.true(SturdyRef.isSturdyRef(sturdyRef), 'brand check accepts it');
  t.is(passStyleOf(sturdyRef), 'sturdyRef', 'passStyleOf returns sturdyRef');
  t.is(
    ocapnPassStyleOf(sturdyRef),
    'sturdyref',
    'ocapnPassStyleOf returns sturdyref',
  );
  t.is(Object.getPrototypeOf(sturdyRef), SturdyRef.prototype);
  t.deepEqual(Reflect.ownKeys(sturdyRef), [], 'no own properties');

  clientA.shutdown();
  clientB.shutdown();
});

testWithErrorUnwrapping("SturdyRef doesn't expose secret/location", async t => {
  const { client: clientA, location: locationB } = await makeTestClient({
    debugLabel: 'A',
  });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  t.false('location' in sturdyRef, 'no location property');
  t.false('secret' in sturdyRef, 'no secret property');
  t.false('swissNum' in sturdyRef, 'no swissNum property');

  const stringified = String(sturdyRef);
  t.is(stringified, '[object SturdyRef]', 'stringification shows no details');

  clientA.shutdown();
  clientB.shutdown();
});

test('a SturdyRef minted without a client refuses to enliven', async t => {
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: 'tcp-test',
    transport: 'tcp',
    designator: '127.0.0.1:9999',
    hints: /** @type {const} */ (false),
  });
  const sturdyRef = makeSturdyRef(location, 'a-secret');
  t.true(isSturdyRef(sturdyRef));
  await t.throwsAsync(() => SturdyRef.enliven(sturdyRef), {
    message: /minted without an OCapN client/,
  });
});

test('a foreign realm SturdyRef is not an OCapN SturdyRef', t => {
  const foreign = /** @type {any} */ (
    new SturdyRef({ enliven: () => 'elsewhere' })
  );
  t.is(ocapnPassStyleOf(foreign), 'sturdyref', 'takes the sturdyref codec');
  t.false(isSturdyRef(foreign), 'but OCapN has no details for it');
  t.is(getSturdyRefDetails(foreign), undefined);
  const { PassableCodec } = makeCodecTestKit();
  for (const codec of AllCodecs) {
    const writer = codec.makeWriter({ name: 'foreign SturdyRef' });
    const error = t.throws(() => PassableCodec.write(foreign, writer));
    let messages = '';
    for (let e = /** @type {any} */ (error); e; e = e.cause) {
      messages += `${e.message}\n`;
    }
    t.regex(messages, /SturdyRef was not minted by OCapN/);
  }
});

testWithErrorUnwrapping(
  'isSturdyRef correctly identifies SturdyRefs',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test');

    t.true(isSturdyRef(sturdyRef), 'isSturdyRef returns true for SturdyRef');
    t.false(isSturdyRef({}), 'isSturdyRef returns false for plain object');
    t.false(isSturdyRef(null), 'isSturdyRef returns false for null');
    t.false(isSturdyRef(undefined), 'isSturdyRef returns false for undefined');
    t.false(isSturdyRef('string'), 'isSturdyRef returns false for string');

    clientA.shutdown();
    clientB.shutdown();
  },
);

testWithErrorUnwrapping(
  'getSturdyRefDetails returns correct details',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

    const details = getSturdyRefDetails(sturdyRef);
    t.truthy(details, 'getSturdyRefDetails returns details');
    if (details) {
      t.deepEqual(details.location, locationB, 'location matches');
      t.is(details.secret, 'test-object', 'secret matches');
    }

    const notASturdyRef = /** @type {any} */ ({});
    const noDetails = getSturdyRefDetails(notASturdyRef);
    t.is(
      noDetails,
      undefined,
      'getSturdyRefDetails returns undefined for non-SturdyRef',
    );

    clientA.shutdown();
    clientB.shutdown();
  },
);

test('client.enlivenSturdyRef() returns promise for fetched value', async t => {
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

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  const resolveResult = clientA.enlivenSturdyRef(sturdyRef);
  t.truthy(resolveResult, 'enlivenSturdyRef returns something');
  t.truthy(
    resolveResult instanceof Promise,
    'enlivenSturdyRef returns a promise',
  );

  const resolved = await resolveResult;
  const value = await E(resolved).getValue();
  t.is(value, 42, 'fetched value works correctly');

  clientA.shutdown();
  clientB.shutdown();
});

test('SturdyRef.enliven() fetches through the minting client', async t => {
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

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');
  const resolved = /** @type {any} */ (await SturdyRef.enliven(sturdyRef));
  t.is(await E(resolved).getValue(), 42);

  clientA.shutdown();
  clientB.shutdown();
});

test('Resolved values are not SturdyRefs', async t => {
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

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  t.true(isSturdyRef(sturdyRef), 'sturdyRef is a SturdyRef before resolve');

  const resolved = await clientA.enlivenSturdyRef(sturdyRef);

  t.false(isSturdyRef(resolved), 'resolved value is not a SturdyRef');

  const value = await E(resolved).getValue();
  t.is(value, 42, 'resolved value works correctly');

  clientA.shutdown();
  clientB.shutdown();
});

test('SturdyRef to self-location can be resolved', async t => {
  const testObjectTable = new Map();
  const testObject = Far('TestObject', {
    getValue: () => 42,
  });
  testObjectTable.set('test-object', testObject);

  const { client: clientA, location: locationA } = await makeTestClient({
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => testObjectTable,
  });

  const sturdyRef = clientA.makeSturdyRef(locationA, 'test-object');

  t.true(isSturdyRef(sturdyRef), 'sturdyRef is a SturdyRef');

  const resolved = await clientA.enlivenSturdyRef(sturdyRef);

  t.false(isSturdyRef(resolved), 'resolved value is not a SturdyRef');

  const value = await E(resolved).getValue();
  t.is(value, 42, 'resolved self-location value works correctly');

  clientA.shutdown();
});

test('a SturdyRef reconstructed from its data enlivens like the original', async t => {
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

  const original = clientA.makeSturdyRef(locationB, 'test-object');
  const data = clientA.getSturdyRefData(original);
  if (!data) throw Error('expected SturdyRef data');
  t.is(data.peerId, locationB.designator);
  t.is(data.objectId, 'test-object');
  t.is(data.designator, locationB.network ?? locationB.transport);
  t.true(Object.isFrozen(data));

  const reconstructed = clientA.makeSturdyRefFromData(data);
  t.not(reconstructed, original);
  t.is(passStyleOf(reconstructed), 'sturdyRef');
  t.deepEqual(getSturdyRefDetails(reconstructed), {
    location: {
      type: 'ocapn-peer',
      designator: locationB.designator,
      transport: locationB.network ?? locationB.transport,
      hints: locationB.hints,
    },
    secret: 'test-object',
  });
  const resolved = /** @type {any} */ (await SturdyRef.enliven(reconstructed));
  t.is(await E(resolved).getValue(), 42);

  clientA.shutdown();
  clientB.shutdown();
});

test('constructing an OCapN SturdyRef from data validates the data', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'p', designator: 'tcp' }),
      ),
    { message: /objectId must be a string or bytes/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'p', objectId: 'x' }),
      ),
    { message: /designator must be a string/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          designator: 'tcp',
          extra: true,
        }),
      ),
    { message: /unexpected SturdyRef data properties extra/ },
  );
  const bytes = Uint8Array.of(0x80, 0x81);
  const ref = client.makeSturdyRefFromData({
    peerId: 'p',
    objectId: bytes,
    designator: 'tcp',
  });
  t.is(getSturdyRefDetails(ref)?.secret, bytes);
  t.deepEqual(client.getSturdyRefData(ref), {
    peerId: 'p',
    objectId: bytes,
    designator: 'tcp',
  });
  t.is(client.getSturdyRefData(/** @type {any} */ (harden({}))), undefined);
  client.shutdown();
});

test('OCapN SturdyRef data checks peerId and hints, and round-trips hints', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 1, objectId: 'x', designator: 'tcp' }),
      ),
    { message: /peerId must be a string/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          designator: 'tcp',
          hints: null,
        }),
      ),
    { message: /hints must be a record/ },
  );
  const data = {
    peerId: 'p',
    objectId: 'x',
    designator: 'tcp',
    hints: { host: '127.0.0.1', port: '1234' },
  };
  const ref = client.makeSturdyRefFromData(data);
  t.deepEqual(getSturdyRefDetails(ref)?.location.hints, data.hints);
  t.deepEqual(client.getSturdyRefData(ref), data);
  client.shutdown();
});
