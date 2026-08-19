// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { test, testWithErrorUnwrapping, makeTestClient } from './_util.js';
import {
  getSturdyRefDetails,
  isSturdyRef,
  makeSturdyRef,
  makeSturdyRefTracker,
} from '../src/client/sturdyrefs.js';
import { ocapnPassStyleOf } from '../src/codecs/ocapn-pass-style.js';

testWithErrorUnwrapping('SturdyRef is a tagged type', async t => {
  const { client: clientA, location: locationB } = await makeTestClient({
    debugLabel: 'A',
  });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  t.is(passStyleOf(sturdyRef), 'tagged', 'passStyleOf returns tagged');
  t.is(
    ocapnPassStyleOf(sturdyRef),
    'sturdyref',
    'ocapnPassStyleOf returns sturdyref',
  );
  t.is(
    sturdyRef[Symbol.toStringTag],
    'ocapn-sturdyref',
    'has correct tag name',
  );
  t.is(sturdyRef.payload, undefined, 'payload is undefined');

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
  t.is(
    stringified,
    '[object ocapn-sturdyref]',
    'stringification shows tag name',
  );

  clientA.shutdown();
  clientB.shutdown();
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

test('SturdyRef snapshots and hardens raw-byte secrets', t => {
  const secret = Uint8Array.of(0x00, 0x80, 0xff);
  const sturdyRef = makeSturdyRef(
    {
      type: 'ocapn-peer',
      transport: 'tcp-test-only',
      designator: 'example.test',
      hints: false,
    },
    secret,
  );

  secret[1] = 0x01;
  const details = getSturdyRefDetails(sturdyRef);
  t.truthy(details);
  if (details && typeof details.secret !== 'string') {
    t.deepEqual(details.secret, Uint8Array.of(0x00, 0x80, 0xff));
    details.secret[2] = 0x02;
    const freshDetails = getSturdyRefDetails(sturdyRef);
    t.deepEqual(freshDetails?.secret, Uint8Array.of(0x00, 0x80, 0xff));
    t.true(Object.isFrozen(details));
  }
});

test('SturdyRef tracker does not retry locator failures', async t => {
  let calls = 0;
  const tracker = makeSturdyRefTracker({
    get: () => {
      calls += 1;
      throw TypeError('locator failure');
    },
  });

  await t.throwsAsync(tracker.lookup(Uint8Array.of(0x41).buffer), {
    instanceOf: TypeError,
    message: 'locator failure',
  });
  t.is(calls, 1);
});

test('SturdyRef tracker propagates byte validation failures', async t => {
  let calls = 0;
  const tracker = makeSturdyRefTracker({
    get: () => {
      calls += 1;
      return undefined;
    },
  });
  const proxy = new Proxy(Uint8Array.of(0x41), {});

  await t.throwsAsync(tracker.lookup(/** @type {any} */ (proxy)), {
    instanceOf: TypeError,
  });
  t.is(calls, 0);
});

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
