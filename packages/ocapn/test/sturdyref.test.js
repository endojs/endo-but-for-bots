// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { test, testWithErrorUnwrapping, makeTestClient } from './_util.js';
import { isSturdyRef, getSturdyRefLocator } from '../src/client/sturdyrefs.js';
import { ocapnPassStyleOf } from '../src/codecs/ocapn-pass-style.js';
import { formatSturdyRefUri } from '../index.js';

testWithErrorUnwrapping('SturdyRef is a first-class pass-style', async t => {
  const { client: clientA, location: locationB } = await makeTestClient({
    debugLabel: 'A',
  });
  const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

  const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

  t.is(passStyleOf(sturdyRef), 'sturdyRef', 'passStyleOf returns sturdyref');
  t.is(
    ocapnPassStyleOf(sturdyRef),
    'sturdyRef',
    'ocapnPassStyleOf returns sturdyref',
  );
  t.is(
    sturdyRef[Symbol.toStringTag],
    'SturdyRef',
    'has the SturdyRef tag name',
  );
  t.is(
    /** @type {any} */ (sturdyRef).payload,
    undefined,
    'is opaque: no payload',
  );

  clientA.shutdown();
  clientB.shutdown();
});

testWithErrorUnwrapping(
  'SturdyRef is opaque: neither location nor secret is a property',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

    // The SturdyRef is fully opaque: it reveals nothing about where it
    // points. The (location, secret) locator is held off-band in the
    // realm-global mapping, reachable only through the closely-held
    // `SturdyRef` namespace, never as a property on the SturdyRef.
    t.false('location' in sturdyRef, 'no location property');
    t.false('secret' in sturdyRef, 'no secret property');
    t.false('swissNum' in sturdyRef, 'no swissNum property');
    t.deepEqual(Reflect.ownKeys(sturdyRef), [], 'no own properties');
    let protoChainLeak = false;
    for (
      let p = Object.getPrototypeOf(sturdyRef);
      p !== null;
      p = Object.getPrototypeOf(p)
    ) {
      if (
        Reflect.ownKeys(p).some(
          k => k === 'secret' || k === 'swissNum' || k === 'location',
        )
      ) {
        protoChainLeak = true;
      }
    }
    t.false(protoChainLeak, 'no locator anywhere on the prototype chain');

    const stringified = String(sturdyRef);
    t.is(stringified, '[object SturdyRef]', 'stringification shows tag name');

    clientA.shutdown();
    clientB.shutdown();
  },
);

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
  'the off-band locator is reachable only through the closely-held mapping',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

    // The realm-global mapping (installed by the first-wins shim) retains the
    // (location, secret) locator keyed by the opaque SturdyRef's identity.
    const locator = getSturdyRefLocator(sturdyRef);
    t.truthy(locator, 'getSturdyRefLocator returns the off-band locator');
    if (locator) {
      t.deepEqual(locator.location, locationB, 'location matches');
      t.is(locator.secret, 'test-object', 'secret matches');
    }

    const notASturdyRef = /** @type {any} */ ({});
    const noLocator = getSturdyRefLocator(notASturdyRef);
    t.is(
      noLocator,
      undefined,
      'getSturdyRefLocator returns undefined for non-SturdyRef',
    );

    clientA.shutdown();
    clientB.shutdown();
  },
);

testWithErrorUnwrapping(
  'client.reveal answers for a SturdyRef this client minted',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

    const details = clientA.reveal(sturdyRef);
    t.truthy(details, 'reveal returns details for a minted ref');
    if (details) {
      t.deepEqual(details.location, locationB, 'revealed location matches');
      t.is(details.secret, 'test-object', 'revealed secret matches');
    }

    // A non-SturdyRef reveals nothing.
    t.is(
      clientA.reveal(/** @type {any} */ ({})),
      undefined,
      'reveal returns undefined for a non-SturdyRef',
    );

    clientA.shutdown();
  },
);

testWithErrorUnwrapping(
  'client.reveal is scoped to the minting instance — foreign-instance mints reveal undefined',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });
    const { client: clientB } = await makeTestClient({ debugLabel: 'B' });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'secret-swiss');

    // The minting session manager reveals its own ref…
    t.truthy(clientA.reveal(sturdyRef), 'the minting client reveals its ref');
    // …but a sibling instance in the same realm does NOT, even though
    // both share the realm-wide details map. This is the confinement
    // property: reveal answers only for what THIS session manager minted
    // or materialized from the wire (design cut 2, foreign-instance
    // mints → undefined).
    t.is(
      clientB.reveal(sturdyRef),
      undefined,
      'a foreign instance reveals nothing for another instance mint',
    );

    clientA.shutdown();
    clientB.shutdown();
  },
);

testWithErrorUnwrapping(
  'reveal is closely-held: absent from the SturdyRef surface, and no toString URI leak',
  async t => {
    const { client: clientA, location: locationB } = await makeTestClient({
      debugLabel: 'A',
    });

    const sturdyRef = clientA.makeSturdyRef(locationB, 'test-object');

    // `reveal` lives on the client (closely-held), never as a property
    // of the SturdyRef or anywhere on its prototype chain.
    t.false('reveal' in sturdyRef, 'reveal is not a property of the ref');

    // No-location for the URI form: a SturdyRef never stringifies to its
    // `ocapn://…` URI. Stringification yields only the opaque tag.
    t.is(String(sturdyRef), '[object SturdyRef]', 'String() shows the tag');
    t.is(`${sturdyRef}`, '[object SturdyRef]', 'template shows the tag');
    t.false(
      String(sturdyRef).includes('ocapn://'),
      'no ocapn:// URI in the string form',
    );

    // Sweep every value reachable from the ref's own keys and whole
    // prototype chain (invoking getters): none is an `ocapn://` URI and
    // none carries the swiss-num secret bytes.
    const secretBytes = new TextEncoder().encode('test-object');
    /**
     * @param {Uint8Array} hay
     * @param {Uint8Array} needle
     * @returns {boolean}
     */
    const bytesContain = (hay, needle) => {
      for (let i = 0; i + needle.length <= hay.length; i += 1) {
        let match = true;
        for (let j = 0; j < needle.length; j += 1) {
          if (hay[i + j] !== needle[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    };
    for (
      let o = sturdyRef;
      o !== null && o !== undefined;
      o = Object.getPrototypeOf(o)
    ) {
      for (const key of Reflect.ownKeys(o)) {
        const desc = Object.getOwnPropertyDescriptor(o, key);
        let value;
        if (desc && 'value' in desc) {
          value = desc.value;
        } else if (desc && typeof desc.get === 'function') {
          value = desc.get.call(sturdyRef);
        }
        if (typeof value === 'string') {
          t.false(value.includes('ocapn://'), `no URI under ${String(key)}`);
          t.false(
            bytesContain(new TextEncoder().encode(value), secretBytes),
            `no secret under ${String(key)}`,
          );
        }
      }
    }

    // The URI is genuinely obtainable, but ONLY through the two
    // closely-held operations together — `reveal` for the secret and the
    // separate module-level `formatSturdyRefUri` — never from the ref
    // alone. This proves the confinement is non-vacuous.
    const details = clientA.reveal(sturdyRef);
    t.truthy(details);
    if (details) {
      const uri = formatSturdyRefUri({
        location: details.location,
        swissNum: new TextEncoder().encode(
          /** @type {string} */ (details.secret),
        ),
      });
      t.true(uri.startsWith('ocapn://'), 'reveal + codec can emit the URI');
      t.true(uri.includes('/s/'), 'the emitted URI carries a swiss-num');
    }

    clientA.shutdown();
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
