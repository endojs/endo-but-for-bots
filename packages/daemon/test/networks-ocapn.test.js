// @ts-nocheck

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { E, Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { make as makeOcapnNetwork } from '../src/networks/ocapn.js';

/**
 * A stand-in for the `context` a network caplet receives: it exposes
 * cancellation and a disposal hook, the surface `networks/ocapn.js`
 * consumes.
 */
const makeMockContext = () => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  // The cancellation promise is a signal, not a result; swallow the
  // rejection so an unconsumed context does not trip AVA's
  // unhandled-rejection policy.
  cancelled.catch(() => {});
  return Far('Context', {
    whenCancelled: () => cancelled,
    cancel: (reason = Error('cancelled')) => cancel(reason),
    addDisposalHook: () => {},
  });
};

/**
 * A stand-in for the `@agent` powers a network caplet receives. The
 * transport only reads `getPeerInfo`, `greeter`, `gateway`, and
 * `lookup`.
 *
 * @param {string} nodeId
 * @param {string} label
 */
const makeMockPowers = (nodeId, label) => {
  const helloCalls = [];
  const storedValues = [];
  const gateway = Far('Gateway', {
    /** @param {string} id */
    provide: id => `${label}:value-for:${id}`,
  });
  const greeter = Far('Greeter', {
    hello: (remoteNodeId, _remoteGateway, _canceller, _cancelled) => {
      helloCalls.push(remoteNodeId);
      return gateway;
    },
  });
  const powers = Far('Powers', {
    getPeerInfo: () => harden({ node: nodeId, addresses: [] }),
    greeter: () => greeter,
    gateway: () => gateway,
    // No stored listen address — the transport falls back to an
    // ephemeral local port.
    lookup: name => {
      throw Error(`no such name ${name}`);
    },
    storeValue: (value, name) => {
      storedValues.push({ value, name });
    },
  });
  return { powers, gateway, greeter, helloCalls, storedValues };
};

test('OCapN-Noise transport conforms to the EndoNetwork interface', async t => {
  t.timeout(60_000);
  const context = makeMockContext();
  t.teardown(() => context.cancel());
  const nodeId = 'a'.repeat(64);
  const { powers, storedValues } = makeMockPowers(nodeId, 'A');

  const service = await makeOcapnNetwork(powers, context);

  const addresses = await E(service).addresses();
  t.is(addresses.length, 1);
  const [address] = addresses;
  t.true(address.startsWith('ocapn+noise+tcp://'));
  // The address must be a well-formed URL so the daemon's `makePeer`
  // can read its `.protocol`.
  const url = new URL(address);
  t.is(url.protocol, 'ocapn+noise+tcp:');
  // The address carries the daemon node id so a dialing peer can
  // cross-check the identity reported by the bootstrap object.
  t.is(url.searchParams.get('node'), nodeId);

  // The resolved OS-assigned listen address is persisted so the port
  // stays stable across restarts.
  t.deepEqual(
    storedValues.map(entry => entry.name),
    ['ocapn-listen-addr'],
  );
  t.regex(storedValues[0].value, /^127\.0\.0\.1:\d+$/);

  t.true(await E(service).supports(address));
  t.true(await E(service).supports('ocapn+noise+tcp:'));
  t.false(await E(service).supports('tcp+netstring+json+captp0:'));
});

test('OCapN-Noise transport carries a peer connection end to end', async t => {
  t.timeout(60_000);
  const contextA = makeMockContext();
  const contextB = makeMockContext();
  t.teardown(() => contextA.cancel());
  t.teardown(() => contextB.cancel());

  const a = makeMockPowers('a'.repeat(64), 'A');
  const b = makeMockPowers('b'.repeat(64), 'B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressB] = await E(serviceB).addresses();

  // A dials B: this opens an OCapN-Noise session, fetches B's
  // bootstrap object by swissnum, cross-checks B's reported node id,
  // and runs the `hello` handshake — the same handshake
  // `tcp-netstring.js` ran over CapTP.
  const connectionContext = makeMockContext();
  const remoteGateway = await E(serviceA).connect(addressB, connectionContext);

  // B's greeter saw A's node id during the handshake.
  t.deepEqual(b.helloCalls, ['a'.repeat(64)]);

  // The gateway `hello` returned is B's, reached over OCapN: a method
  // call on it round-trips to B and back.
  const result = await E(remoteGateway).provide('formula-x');
  t.is(result, 'B:value-for:formula-x');
});

test('OCapN-Noise transport rejects a peer whose identity does not match the address', async t => {
  t.timeout(60_000);
  const contextA = makeMockContext();
  const contextB = makeMockContext();
  t.teardown(() => contextA.cancel());
  t.teardown(() => contextB.cancel());

  const a = makeMockPowers('a'.repeat(64), 'A');
  const b = makeMockPowers('b'.repeat(64), 'B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressB] = await E(serviceB).addresses();
  // Rewrite the connection hint so it names a node other than the one
  // B's bootstrap will report.
  const tampered = new URL(addressB);
  tampered.searchParams.set('node', 'c'.repeat(64));

  const connectionContext = makeMockContext();
  await t.throwsAsync(
    () => E(serviceA).connect(tampered.href, connectionContext),
    { message: /OCapN peer identity mismatch/ },
  );
});
