// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

/** @import { ExecutionContext } from 'ava' */

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { provideSturdyRef } from '@endo/sturdyref';
import { test, makeTestClient } from './_util.js';
import { locationToLocationId } from '../src/client/util.js';
import { getSturdyRefDetails } from '../src/client/sturdyrefs.js';

const SturdyRef = provideSturdyRef();

/**
 * Enliven a SturdyRef to an untyped remote reference.
 *
 * @param {unknown} ref
 * @returns {Promise<any>}
 */
const enliven = ref => SturdyRef.enliven(/** @type {any} */ (ref));

/**
 * Start a test client that shuts down when the test ends, pass or fail.
 *
 * @param {ExecutionContext} t
 * @param {Parameters<typeof makeTestClient>[0]} options
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
  /** @type {any} */
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

  // Sent to Bob and enlivened there, they reach his locator verbatim.
  const mailboxAtB = await enliven(clientA.makeSturdyRef(locationB, 'mailbox'));
  await E(mailboxAtB).deliver(remote);
  const [home] = bob.received;
  t.is(await enliven(home), bytesTarget);

  // And a copy that travelled from Bob to Alice enlivens back at Bob.
  const mailboxAtA = await enliven(clientB.makeSturdyRef(locationA, 'mailbox'));
  await E(mailboxAtA).deliver(home);
  const [atAlice] = alice.received;
  t.is(await E(enliven(atAlice)).ping(), 'pong');
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
