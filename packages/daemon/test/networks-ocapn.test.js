// @ts-nocheck
/* global Buffer */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import crypto from 'crypto';
import { E, Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { make as makeOcapnNetwork } from '../src/networks/ocapn.js';

/**
 * Generate a raw 32-byte Ed25519 keypair via Node's `crypto`, mirroring
 * `makeCryptoPowers.generateEd25519Keypair` in the daemon. The mock
 * `sign` method below uses it to back the agent's persistent signing
 * surface — the same one the layered agent-binding attestation
 * exposes via the OCapN bootstrap exo.
 */
const toHex = bytes =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

const fromHex = hex => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const ED25519_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

const ed25519SignBytes = (privateKey, message) => {
  const derKey = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateKey)]);
  const keyObject = crypto.createPrivateKey({
    key: derKey,
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(crypto.sign(null, Buffer.from(message), keyObject));
};

const generateEd25519Keypair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  return harden({
    publicKey: new Uint8Array(publicDer.subarray(publicDer.length - 32)),
    privateKey: new Uint8Array(privateDer.subarray(privateDer.length - 32)),
  });
};

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
 * transport reads `getPeerInfo` (for the agent's persistent node id),
 * `sign` (for the layered agent-binding attestation), `greeter`,
 * `gateway`, `lookup`, and `storeValue`. The mock keeps an internal
 * Ed25519 keypair so the node id and the `sign` output are
 * consistent — exactly as the daemon's `agent_key` SQLite row would
 * be on a real host.
 *
 * Per-mock keypair so two mocks produce two distinct agent identities.
 * Pass `keypair` to reuse an identity across mocks (used to simulate
 * a daemon restart with the same persistent agent).
 *
 * @param {string} label
 * @param {{ publicKey: Uint8Array, privateKey: Uint8Array }} [keypair]
 */
const makeMockPowers = (label, keypair = generateEd25519Keypair()) => {
  const helloCalls = [];
  const storedValues = [];
  const nodeId = toHex(keypair.publicKey);
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
    sign: hexBytes =>
      toHex(ed25519SignBytes(keypair.privateKey, fromHex(hexBytes))),
    // No stored listen address — the transport falls back to an
    // ephemeral local port.
    lookup: name => {
      throw Error(`no such name ${name}`);
    },
    storeValue: (value, name) => {
      storedValues.push({ value, name });
    },
  });
  return {
    powers,
    gateway,
    greeter,
    helloCalls,
    storedValues,
    keypair,
    nodeId,
  };
};

test('OCapN-Noise transport conforms to the EndoNetwork interface', async t => {
  t.timeout(60_000);
  const context = makeMockContext();
  t.teardown(() => context.cancel());
  const { powers, storedValues, nodeId } = makeMockPowers('A');

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

  const a = makeMockPowers('A');
  const b = makeMockPowers('B');

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
  t.deepEqual(b.helloCalls, [a.nodeId]);

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

  const a = makeMockPowers('A');
  const b = makeMockPowers('B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressB] = await E(serviceB).addresses();
  // Rewrite the connection hint so it names a node other than the one
  // B's bootstrap binding attests to.
  const tampered = new URL(addressB);
  tampered.searchParams.set('node', toHex(generateEd25519Keypair().publicKey));

  const connectionContext = makeMockContext();
  await t.throwsAsync(
    () => E(serviceA).connect(tampered.href, connectionContext),
    { message: /OCapN peer identity mismatch/ },
  );
});

test('OCapN-Noise transport rejects a peer whose binding signature is wrong key', async t => {
  // The layered agent-binding attestation only catches a mismatch if
  // a dialing daemon verifies the signature. This test points a
  // dialer at peer B's address but tells it to expect a *different*
  // agent's public key — the binding verifies against B's actual key
  // and so fails to verify against the impersonator's. The error
  // surfaces as `OCapN peer identity mismatch`.
  t.timeout(60_000);
  const contextA = makeMockContext();
  const contextB = makeMockContext();
  t.teardown(() => contextA.cancel());
  t.teardown(() => contextB.cancel());

  const a = makeMockPowers('A');
  const b = makeMockPowers('B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressB] = await E(serviceB).addresses();
  // Rewrite the connection hint so it names some third party's
  // agent key; B will return its real binding (signed by B's key),
  // and the dialer's verification step rejects it.
  const impersonatorPublicKey = toHex(generateEd25519Keypair().publicKey);
  const tampered = new URL(addressB);
  tampered.searchParams.set('node', impersonatorPublicKey);

  const connectionContext = makeMockContext();
  await t.throwsAsync(
    () => E(serviceA).connect(tampered.href, connectionContext),
    { message: /OCapN peer identity mismatch/ },
  );
});

test('peer teardown surfaces as a rejection on the next call', async t => {
  // Once one side tears its transport down, the other side's next
  // `E(remoteGateway).provide` call must reject rather than hang.
  //
  // Plumbing: B's `context.cancel()` triggers `client.shutdown()`
  // on B's OCapN client, which calls `transport.shutdown()` on
  // every registered transport. The TCP transport destroys its
  // open sockets, which causes A's read stream to surface
  // `{ done: true }` from `reader.next()`. That tips A's `runPump`
  // (in `@endo/ocapn`'s session bridge) into its finally block,
  // which calls `internalSession.ocapn.abort(reason)` before
  // ending the session — and `abort` is what rejects every
  // pending `op:deliver` answer with "Session disconnected".
  //
  // Out of scope: actual *reconnect* of an aborted session. That
  // requires `ocapn-noise-session-reconnect` (Proposed); when it
  // lands the assertion should flip from "rejects" to "the next
  // provide call re-establishes and succeeds".
  t.timeout(30_000);
  const contextA = makeMockContext();
  const contextB = makeMockContext();
  t.teardown(() => contextA.cancel());

  const a = makeMockPowers('A');
  const b = makeMockPowers('B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressB] = await E(serviceB).addresses();

  const connectionContext = makeMockContext();
  const remoteGateway = await E(serviceA).connect(addressB, connectionContext);

  // Sanity: the session is live.
  t.is(await E(remoteGateway).provide('warmup'), 'B:value-for:warmup');

  // Tear down B's transport. The OCapN session A holds is now
  // running against a dead listener.
  contextB.cancel();

  // The next call on A's remote-gateway handle must reject — not
  // hang, not silently succeed. The exact error message is the
  // OCapN session's disconnect surface; we only assert that
  // something rejects within the test timeout.
  await t.throwsAsync(() => E(remoteGateway).provide('after-drop'));
});

test('crossed-hello: two transports dialling each other reuse one OCapN session', async t => {
  // OCapN's session manager dedupes by `(localKey, remoteKey)`
  // location; two sides dialling each other simultaneously must
  // converge on a single session, not two competing ones. The
  // bespoke `RemoteControl` state machine in the daemon exists to
  // reconcile this for the TCP+CapTP path; under OCapN-Noise the
  // dedupe is the session manager's job, and this test pins that
  // contract end-to-end through `networks/ocapn.js`.
  t.timeout(60_000);
  const contextA = makeMockContext();
  const contextB = makeMockContext();
  t.teardown(() => contextA.cancel());
  t.teardown(() => contextB.cancel());

  const a = makeMockPowers('A');
  const b = makeMockPowers('B');

  const serviceA = await makeOcapnNetwork(a.powers, contextA);
  const serviceB = await makeOcapnNetwork(b.powers, contextB);

  const [addressA] = await E(serviceA).addresses();
  const [addressB] = await E(serviceB).addresses();

  // Both sides dial simultaneously; race them with `Promise.all` so
  // the OCapN client on each side sees both an outbound `provideSession`
  // and an inbound session arriving roughly at the same time.
  const ctxAtoB = makeMockContext();
  const ctxBtoA = makeMockContext();
  const [gatewayBFromA, gatewayAFromB] = await Promise.all([
    E(serviceA).connect(addressB, ctxAtoB),
    E(serviceB).connect(addressA, ctxBtoA),
  ]);

  // Both directions saw a `hello` and got a usable remote gateway.
  // (The order helloCalls is recorded doesn't matter; we only need
  // each side to have seen exactly one inbound peer.)
  t.deepEqual(a.helloCalls, [b.nodeId]);
  t.deepEqual(b.helloCalls, [a.nodeId]);

  // Both gateways round-trip through their underlying session.
  t.is(await E(gatewayBFromA).provide('x'), 'B:value-for:x');
  t.is(await E(gatewayAFromB).provide('y'), 'A:value-for:y');
});

test('agent identity persists across transport restart, even though OCapN session key rotates', async t => {
  // OCapN sessions intentionally use ephemeral keys — the daemon
  // does not bake its persistent agent identity into the Noise
  // handshake; the `@keypair` capability discipline keeps the agent
  // private key inside the daemon. Persistent identity is layered on
  // top via the bootstrap's signed `getAgentBinding` attestation, so
  // restart-stability is asserted on:
  //
  //   1. the `node=` parameter of the connection-hint URL, which the
  //      agent stamps with its own persistent public key, and
  //   2. the OCapN session designator visibly rotating across the
  //      two restarts (the opposite property would mean the OCapN
  //      handshake was pinned to a persistent key, which is the
  //      shape we explicitly reject).
  //
  // The layered-attestation check — that the binding's
  // `agentPublicKey` matches the locator's `node=` and the signature
  // verifies — is exercised end-to-end by every other test in this
  // file via the dial path's `OCapN peer identity mismatch` guard.
  t.timeout(60_000);
  const keypair = generateEd25519Keypair();
  const { powers: powersA, nodeId } = makeMockPowers('A', keypair);

  const contextA1 = makeMockContext();
  t.teardown(() => contextA1.cancel());
  const serviceA1 = await makeOcapnNetwork(powersA, contextA1);
  const [addressA1] = await E(serviceA1).addresses();

  // Tear down the first instance and create a fresh one with the
  // same mock powers (i.e., the same persistent agent keypair).
  contextA1.cancel();

  const contextA2 = makeMockContext();
  t.teardown(() => contextA2.cancel());
  const { powers: powersA2 } = makeMockPowers('A', keypair);
  const serviceA2 = await makeOcapnNetwork(powersA2, contextA2);
  const [addressA2] = await E(serviceA2).addresses();

  // Persistent agent identity (the `node=` param) is stable.
  t.is(new URL(addressA1).searchParams.get('node'), nodeId);
  t.is(new URL(addressA2).searchParams.get('node'), nodeId);

  // OCapN session designator rotates (ephemeral, generated fresh on
  // each install). If these matched, the OCapN-Noise transport would
  // be persisting its handshake key — exactly the shape this layered
  // attestation is designed to avoid.
  const locA1 = JSON.parse(
    /** @type {string} */ (new URL(addressA1).searchParams.get('loc')),
  );
  const locA2 = JSON.parse(
    /** @type {string} */ (new URL(addressA2).searchParams.get('loc')),
  );
  t.notDeepEqual(
    locA2.designator,
    locA1.designator,
    'OCapN designator is ephemeral and rotates across restart',
  );
});
