// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { provideSturdyRef } from '@endo/sturdyref';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
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
  sturdyRefDataToDetails,
  sturdyRefDetailsToData,
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

test('the public SturdyRef mint takes no custom enliven', async t => {
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: 'tcp-test',
    transport: 'tcp',
    designator: '127.0.0.1:9999',
    hints: /** @type {const} */ (false),
  });
  // A caller-supplied enliven could resolve to something other than the
  // (location, secret) the codec writes, so the public mint ignores it.
  const decoy = Far('decoy', {});
  const sturdyRef = /** @type {any} */ (makeSturdyRef)(
    location,
    'a-secret',
    async () => decoy,
  );
  t.deepEqual(getSturdyRefDetails(sturdyRef), { location, secret: 'a-secret' });
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
  t.is(data.network, locationB.network ?? locationB.transport);
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
        /** @type {any} */ ({ peerId: 'p', network: 'tcp' }),
      ),
    { message: /objectId must be a string or bytes/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'p', objectId: 'x' }),
      ),
    { message: /network must be a string/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          network: 'tcp',
          extra: true,
        }),
      ),
    { message: /unexpected SturdyRef data properties extra/ },
  );
  const bytes = Uint8Array.of(0x80, 0x81);
  const ref = client.makeSturdyRefFromData({
    peerId: 'p',
    objectId: bytes,
    network: 'tcp',
  });
  t.deepEqual(getSturdyRefDetails(ref)?.secret, bytes);
  t.not(getSturdyRefDetails(ref)?.secret, bytes);
  bytes[0] = 0;
  t.deepEqual(getSturdyRefDetails(ref)?.secret, Uint8Array.of(0x80, 0x81));
  t.throws(() => client.makeSturdyRefFromData(/** @type {any} */ (null)), {
    message: /data must be an object/,
  });
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          network: 'tcp',
          [Symbol('smuggled')]: true,
        }),
      ),
    { message: /unexpected SturdyRef data properties/ },
  );
  t.deepEqual(client.getSturdyRefData(ref), {
    peerId: 'p',
    objectId: Uint8Array.of(0x80, 0x81),
    network: 'tcp',
  });
  t.is(client.getSturdyRefData(/** @type {any} */ (harden({}))), undefined);
  client.shutdown();
});

test('OCapN SturdyRef data checks peerId and hints, and round-trips hints', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 1, objectId: 'x', network: 'tcp' }),
      ),
    { message: /peerId must be a string/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          network: 'tcp',
          hints: null,
        }),
      ),
    { message: /hints must be a record of strings/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          network: 'tcp',
          hints: { port: 1234 },
        }),
      ),
    { message: /hints must be a record of strings/ },
  );
  t.throws(
    () =>
      client.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'p',
          objectId: 'x',
          network: 'tcp',
          hints: { host: 'h', [Symbol('smuggled')]: {} },
        }),
      ),
    { message: /hints must be a record of strings/ },
  );
  let reads = 0;
  const fickle = {
    get port() {
      reads += 1;
      return reads === 1 ? '1234' : {};
    },
  };
  const fickleRef = client.makeSturdyRefFromData({
    peerId: 'p',
    objectId: 'x',
    network: 'tcp',
    hints: /** @type {any} */ (fickle),
  });
  t.is(reads, 1);
  t.deepEqual(getSturdyRefDetails(fickleRef)?.location.hints, { port: '1234' });
  const data = {
    peerId: 'p',
    objectId: 'x',
    network: 'tcp',
    hints: { host: '127.0.0.1', port: '1234' },
  };
  const ref = client.makeSturdyRefFromData(data);
  t.deepEqual(getSturdyRefDetails(ref)?.location.hints, data.hints);
  t.deepEqual(client.getSturdyRefData(ref), data);
  client.shutdown();
});

test('a client reveals SturdyRef data only for refs it minted', async t => {
  const { client: clientA } = await makeTestClient({ debugLabel: 'A' });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });
  const data = { peerId: 'p', objectId: 'x', network: 'tcp' };
  const fromData = clientA.makeSturdyRefFromData(data);
  t.deepEqual(clientA.getSturdyRefData(fromData), data);
  t.is(clientB.getSturdyRefData(fromData), undefined);
  const location = /** @type {const} */ ({
    type: 'ocapn-peer',
    designator: 'p',
    transport: 'tcp',
    hints: false,
  });
  const minted = clientA.makeSturdyRef(location, 'y');
  t.truthy(clientA.getSturdyRefData(minted));
  t.is(clientB.getSturdyRefData(minted), undefined);
  clientA.shutdown();
  clientB.shutdown();
});

test('no SturdyRef data validation error reveals the objectId', t => {
  // The prefix keeps a short generated id from matching ordinary message text.
  const objectIds = fc.string({ minLength: 1 }).map(id => `swiss:${id}`);
  /** @type {Record<string, unknown>[]} */
  const invalid = [
    { peerId: 1, network: 'tcp' },
    { peerId: 'p' },
    { peerId: 'p', network: 'tcp', extra: true },
    { peerId: 'p', network: 'tcp', hints: null },
    { peerId: 'p', network: 'tcp', hints: { port: 1234 } },
  ];
  fc.assert(
    fc.property(objectIds, fc.constantFrom(...invalid), (objectId, base) => {
      let message = '';
      try {
        sturdyRefDataToDetails(/** @type {any} */ ({ ...base, objectId }));
      } catch (error) {
        message = /** @type {Error} */ (error).message;
      }
      return message !== '' && !message.includes(objectId);
    }),
  );
  t.pass();
});

test('mutating returned SturdyRef data bytes leaves the ref unchanged', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  const ref = client.makeSturdyRefFromData({
    peerId: 'p',
    objectId: Uint8Array.of(0x80, 0x81),
    network: 'tcp',
  });
  const data = client.getSturdyRefData(ref);
  const bytes = /** @type {Uint8Array} */ (data?.objectId);
  t.not(bytes, getSturdyRefDetails(ref)?.secret);
  bytes[0] = 0xff;
  t.deepEqual(getSturdyRefDetails(ref)?.secret, Uint8Array.of(0x80, 0x81));
  t.deepEqual(
    client.getSturdyRefData(ref)?.objectId,
    Uint8Array.of(0x80, 0x81),
  );
  client.shutdown();
});

test('a minted SturdyRef copies its location and secret', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  /** @type {Record<string, string>} */
  const hints = { host: '127.0.0.1' };
  const secret = Uint8Array.of(0x80, 0x81);
  /** @type {any} */
  const location = {
    type: 'ocapn-peer',
    designator: 'p',
    transport: 'tcp',
    hints,
  };
  const ref = client.makeSturdyRef(location, secret);
  // Mutate the caller's objects before the first read.
  secret[0] = 0;
  hints.host = 'evil.example';
  location.designator = 'q';
  t.deepEqual(client.getSturdyRefData(ref), {
    peerId: 'p',
    objectId: Uint8Array.of(0x80, 0x81),
    network: 'tcp',
    hints: { host: '127.0.0.1' },
  });
  // Reading the data does not freeze the caller's objects in place.
  hints.port = '1234';
  location.network = 'other';
  t.is(hints.port, '1234');
  t.is(location.network, 'other');
  client.shutdown();
});

test('OCapN SturdyRef data refuses non-enumerable extra properties', t => {
  const data = { peerId: 'p', objectId: 'x', network: 'tcp' };
  Object.defineProperty(data, 'smuggled', { value: true, enumerable: false });
  t.throws(() => sturdyRefDataToDetails(data), {
    message: /unexpected SturdyRef data properties smuggled/,
  });
});

/**
 * Arbitrary OCapN SturdyRef data, with string or byte object ids and with or
 * without hints.
 */
const sturdyRefDataArbitrary = fc
  .tuple(
    fc.string(),
    fc.oneof(fc.string(), fc.uint8Array()),
    fc.string(),
    fc.option(fc.array(fc.tuple(fc.string(), fc.string())), {
      nil: undefined,
    }),
  )
  .map(([peerId, objectId, network, hintEntries]) => ({
    peerId,
    objectId,
    network,
    ...(hintEntries === undefined
      ? {}
      : { hints: Object.fromEntries(hintEntries) }),
  }));

test('SturdyRef data round-trips through details', t => {
  fc.assert(
    fc.property(sturdyRefDataArbitrary, data =>
      isDeepStrictEqual(
        sturdyRefDetailsToData(sturdyRefDataToDetails(data)),
        data,
      ),
    ),
  );
  t.pass();
});

test('a client returns the data it constructed a SturdyRef from', async t => {
  const { client } = await makeTestClient({ debugLabel: 'A' });
  fc.assert(
    fc.property(sturdyRefDataArbitrary, data =>
      isDeepStrictEqual(
        client.getSturdyRefData(client.makeSturdyRefFromData(data)),
        data,
      ),
    ),
  );
  client.shutdown();
  t.pass();
});
