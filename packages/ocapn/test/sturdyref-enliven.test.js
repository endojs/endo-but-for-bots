// @ts-check

/**
 * @import { ExecutionContext } from 'ava'
 * @import { NonceLocator } from '../src/client/types.js'
 */

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { passStyleOf } from '@endo/pass-style';
import { enliven as enlivenSturdyRef, provideSturdyRef } from '@endo/sturdyref';
import { locationToLocationId } from '@endo/ocapn/client/util';
import { test, makeTestClient } from './_util.js';
import { getSturdyRefDetails } from '../src/client/sturdyrefs.js';

const SturdyRef = provideSturdyRef();

/**
 * Enliven a SturdyRef to an untyped remote reference.
 */
const enliven = /** @type {(ref: unknown) => Promise<any>} */ (
  enlivenSturdyRef
);

/**
 * Start a test client that shuts down when the test ends, pass or fail.
 *
 * @param {ExecutionContext} t
 * @param {Parameters<typeof makeTestClient>[0]} options
 * @returns {ReturnType<typeof makeTestClient>}
 */
const startClient = async (t, options) => {
  const kit = await makeTestClient(options);
  t.teardown(() => kit.client.shutdown());
  return kit;
};

/**
 * A counter, a mailbox that keeps whatever it is sent, and a registry
 * that serves both from a peer's nonce locator.
 */
const makeParty = () => {
  let count = 0;
  const counter = Far('Counter', {
    increment: () => {
      count += 1;
      return count;
    },
  });
  /** @type {unknown[]} */
  const received = [];
  const mailbox = Far('Mailbox', {
    /** @param {unknown} value */
    deliver: value => {
      received.push(value);
      return passStyleOf(value);
    },
    /** @param {unknown} ref */
    enlivenAndIncrement: async ref => E(enliven(ref)).increment(),
  });
  /** @type {Map<string, unknown>} */
  const locator = new Map();
  locator.set('counter', counter);
  locator.set('mailbox', mailbox);
  return { counter, mailbox, received, locator, getCount: () => count };
};

test('a SturdyRef enlivens at a remote peer through its bootstrap', async t => {
  const alice = makeParty();
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });

  // Alice mints a SturdyRef to her own counter and mails it to Bob.
  const toCounter = clientA.makeSturdyRef(locationA, 'counter');
  const bobMailbox = clientA.makeSturdyRef(locationB, 'mailbox');
  const mailbox = await enliven(bobMailbox);
  t.is(await E(mailbox).deliver(toCounter), 'sturdyRef');

  // Bob holds an OCapN SturdyRef of his own client's making: same
  // coordinates, but it enlivens through Bob's session to Alice.
  const [atBob] = bob.received;
  t.is(passStyleOf(atBob), 'sturdyRef');
  t.not(atBob, toCounter);
  const details = getSturdyRefDetails(/** @type {any} */ (atBob));
  if (!details) throw Error('expected an OCapN SturdyRef at Bob');
  t.is(details.location.designator, locationA.designator);

  const counter = await enliven(atBob);
  t.is(await E(counter).increment(), 1);
  t.is(await E(counter).increment(), 2);
  t.is(alice.getCount(), 2);
});

test('a SturdyRef returning home enlivens from the nonce locator', async t => {
  const alice = makeParty();
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });
  const { client: clientB, location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });

  // Bob mints a SturdyRef to his own counter and sends it to Alice, who
  // sends it back. Bob's decoded copy names Bob, so it enlivens from his
  // nonce locator without a network round trip, to the very object.
  const mailboxAtA = await clientB.enlivenSturdyRef(
    clientB.makeSturdyRef(locationA, 'mailbox'),
  );
  const toBobCounter = clientB.makeSturdyRef(locationB, 'counter');
  await E(mailboxAtA).deliver(toBobCounter);
  const [atAlice] = alice.received;

  const mailboxAtB = await clientA.enlivenSturdyRef(
    clientA.makeSturdyRef(locationB, 'mailbox'),
  );
  await E(mailboxAtB).deliver(atAlice);
  const [home] = bob.received;
  t.is(passStyleOf(home), 'sturdyRef');
  t.not(home, toBobCounter);
  t.is(await enliven(home), bob.counter);
});

test('a SturdyRef with non-ASCII secret bytes returns home intact', async t => {
  const secret = Uint8Array.of(0x80, 0xfe, 0x01);
  const bytesTarget = Far('BytesTarget', { ping: () => 'pong' });
  const bob = makeParty();
  /** @type {NonceLocator} */
  const bobLocator = {
    /** @param {string | Uint8Array} key */
    get: key => {
      if (typeof key === 'string') return bob.locator.get(key);
      return key.length === secret.length &&
        key.every((byte, i) => byte === secret[i])
        ? bytesTarget
        : undefined;
    },
  };
  const alice = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });
  const { client: clientB, location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bobLocator,
  });

  // Enlivened remotely, the bytes ride the bootstrap fetch verbatim.
  const remote = clientA.makeSturdyRef(locationB, secret);
  t.is(await E(enliven(remote)).ping(), 'pong');

  // Sent to Bob and enlivened there, these non-ASCII bytes reach his
  // locator verbatim.
  const mailboxAtB = await enliven(clientA.makeSturdyRef(locationB, 'mailbox'));
  await E(mailboxAtB).deliver(remote);
  const [home] = bob.received;
  t.is(await enliven(home), bytesTarget);

  // And a copy that traveled from Bob to Alice enlivens back at Bob.
  const mailboxAtA = await enliven(clientB.makeSturdyRef(locationA, 'mailbox'));
  await E(mailboxAtA).deliver(home);
  const [atAlice] = alice.received;
  t.is(await E(enliven(atAlice)).ping(), 'pong');
});

test('a byte secret minted at home resolves as a peer fetch would', async t => {
  const target = Far('Target', {});
  /** @type {Array<string | Uint8Array>} */
  const seen = [];
  /** @type {NonceLocator} */
  const locator = {
    /** @param {string | Uint8Array} key */
    get: key => {
      seen.push(key);
      return target;
    },
  };
  const { client, location } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => locator,
  });
  /** @param {Uint8Array} secret */
  const keyFor = async secret => {
    seen.length = 0;
    const value = await enliven(client.makeSturdyRef(location, secret));
    t.is(value, target);
    t.is(seen.length, 1);
    return seen[0];
  };

  // ASCII-range bytes, never sent over the wire, reach the locator as the
  // string they spell, so a locator keyed only by those bytes misses.
  t.is(await keyFor(new TextEncoder().encode('counter')), 'counter');
  // The empty secret is the empty string.
  t.is(await keyFor(Uint8Array.of()), '');
  // 0x00 is ASCII too, so a NUL byte survives into the string.
  t.is(await keyFor(Uint8Array.of(0x00, 0x61)), '\x00a');
  // 0x7f is the last ASCII byte and still decodes.
  t.is(await keyFor(Uint8Array.of(0x61, 0x7f)), 'a\x7f');
  // 0x80 is the first non-ASCII byte, so the raw bytes pass through, as
  // a fresh copy: the locator never holds the minter's own array.
  const nonAscii = Uint8Array.of(0x61, 0x80);
  const passed = /** @type {Uint8Array} */ (await keyFor(nonAscii));
  t.not(passed, nonAscii);
  t.deepEqual([...passed], [0x61, 0x80]);
  passed[0] = 0;
  t.deepEqual([...nonAscii], [0x61, 0x80]);
  // A frozen byte secret, the shape the CBOR reader decodes off the wire,
  // resolves exactly as its mutable twin does on both sides of 0x80.
  t.is(await keyFor(frozenBytes(Uint8Array.of(0x61, 0x7f))), 'a\x7f');
  t.deepEqual(
    [.../** @type {Uint8Array} */ (await keyFor(frozenBytes(nonAscii)))],
    [0x61, 0x80],
  );
});

test('a SturdyRef constructed from data connects on demand via its hints', async t => {
  const bob = makeParty();
  const { client: clientA, debug: debugA } = await startClient(t, {
    debugLabel: 'A',
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });
  const locationIdB = locationToLocationId(locationB);
  t.falsy(debugA.sessionManager.getActiveSession(locationIdB));

  // Only the recorded coordinates survive, as after a restart.
  const data = harden({
    peerId: locationB.designator,
    objectId: 'counter',
    designator: locationB.network ?? locationB.transport,
    hints: locationB.hints || undefined,
  });
  const ref = clientA.makeSturdyRefFromData(data);
  const counter = await enliven(ref);
  t.is(await E(counter).increment(), 1);
  t.truthy(
    debugA.sessionManager.getActiveSession(locationIdB),
    'enliven opened a session to the peer the hints name',
  );

  // A second enliven reuses the session and reaches the same object.
  const again = await enliven(clientA.makeSturdyRefFromData(data));
  t.is(again, counter);
});

test('a SturdyRef constructed from data with a byte objectId enlivens', async t => {
  const alice = makeParty();
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });
  /** @param {typeof locationA} location */
  const counterData = location => ({
    peerId: location.designator,
    objectId: new TextEncoder().encode('counter'),
    designator: location.network ?? location.transport,
    hints: location.hints || undefined,
  });

  // At a peer, the bytes ride the bootstrap fetch, which decodes them.
  const remote = await enliven(
    clientA.makeSturdyRefFromData(counterData(locationB)),
  );
  t.is(await E(remote).increment(), 1);
  t.is(bob.getCount(), 1);

  // At home, the same bytes reach the same string-keyed locator entry.
  const home = await enliven(
    clientA.makeSturdyRefFromData(counterData(locationA)),
  );
  t.is(home, alice.counter);
});

test('an unknown secret rejects without revealing it', async t => {
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });
  const secret = 'no-such-object-7f3a';

  const remote = clientA.makeSturdyRef(locationB, secret);
  const remoteError = await t.throwsAsync(() => SturdyRef.enliven(remote));
  t.false(String(remoteError?.message).includes(secret));

  const local = clientA.makeSturdyRef(locationA, secret);
  const localError = await t.throwsAsync(() => SturdyRef.enliven(local));
  t.false(String(localError?.message).includes(secret));

  // The bootstrap still answers a well-known secret afterward.
  const bootstrapB = clientA.makeSturdyRef(locationB, 'counter');
  t.is(await E(enliven(bootstrapB)).increment(), 1);
  t.is(bob.getCount(), 1);
});

test('an unknown non-ASCII byte secret rejects without revealing it', async t => {
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });
  // The ASCII decode fails on 0x80 and the raw-bytes lookup misses, so
  // neither the bytes nor the decoder's RangeError may reach the message.
  const secret = Uint8Array.of(0x61, 0x80, 0xfe);
  /** @param {unknown} error */
  const assertSilent = error => {
    const message = String(/** @type {Error} */ (error)?.message);
    t.false(/0x80|0xfe|offset|Non-ASCII/i.test(message), message);
    t.false(message.includes(String.fromCharCode(0x80)), message);
  };

  const remote = clientA.makeSturdyRef(locationB, secret);
  assertSilent(await t.throwsAsync(() => SturdyRef.enliven(remote)));

  const local = clientA.makeSturdyRef(locationA, secret);
  assertSilent(await t.throwsAsync(() => SturdyRef.enliven(local)));
});

test('an empty secret enlivens at a remote peer', async t => {
  const bob = makeParty();
  bob.locator.set('', bob.counter);
  const { client: clientA } = await startClient(t, { debugLabel: 'A' });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });

  // The empty string and the empty bytes both reach Bob's '' entry.
  t.is(await E(enliven(clientA.makeSturdyRef(locationB, ''))).increment(), 1);
  t.is(
    await E(
      enliven(clientA.makeSturdyRef(locationB, Uint8Array.of())),
    ).increment(),
    2,
  );
  t.is(bob.getCount(), 2);
});

test('a non-ASCII string secret at home reaches the locator unchanged', async t => {
  const alice = makeParty();
  alice.locator.set('caf\u00e9', alice.counter);
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });

  // Only a wire-origin secret is bytes; a string secret minted here skips
  // the ASCII boundary and keys the locator verbatim.
  t.is(
    await enliven(clientA.makeSturdyRef(locationA, 'caf\u00e9')),
    alice.counter,
  );
});

test('a SturdyRef enlivens inside a peer on its behalf', async t => {
  const alice = makeParty();
  const bob = makeParty();
  const { client: clientA, location: locationA } = await startClient(t, {
    debugLabel: 'A',
    makeDefaultSwissnumTable: () => alice.locator,
  });
  const { location: locationB } = await startClient(t, {
    debugLabel: 'B',
    makeDefaultSwissnumTable: () => bob.locator,
  });

  // Alice asks Bob to enliven a SturdyRef to Alice's counter and use it.
  const mailboxAtB = await enliven(clientA.makeSturdyRef(locationB, 'mailbox'));
  const toCounter = clientA.makeSturdyRef(locationA, 'counter');
  t.is(await E(mailboxAtB).enlivenAndIncrement(toCounter), 1);
  t.is(alice.getCount(), 1);
});
