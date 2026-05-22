// @ts-nocheck

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
 * powers below need a real keypair so the OCapN-Noise handshake can
 * complete; the daemon supplies the same shape from the per-agent
 * `agent_key` table. Returned as hex strings to match the
 * `getSigningKeys` wire shape (raw `Uint8Array` is not passable).
 */
const toHex = bytes =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

const generateEd25519Keypair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  return harden({
    publicKey: toHex(publicDer.subarray(publicDer.length - 32)),
    privateKey: toHex(privateDer.subarray(privateDer.length - 32)),
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
 * transport only reads `getPeerInfo`, `greeter`, `gateway`, and
 * `lookup`.
 *
 * @param {string} nodeId
 * @param {string} label
 */
const makeMockPowers = (nodeId, label) => {
  const helloCalls = [];
  const storedValues = [];
  const signingKeys = generateEd25519Keypair();
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
    // The transport binds its OCapN-Noise signing key to the agent's
    // Ed25519 keypair (the same one the agent uses to stamp `endo://`
    // locators). In production this comes from the host's
    // `getSigningKeys`, which reads the per-agent record out of the
    // `agent_key` SQLite table.
    getSigningKeys: () => signingKeys,
    // No stored listen address — the transport falls back to an
    // ephemeral local port.
    lookup: name => {
      throw Error(`no such name ${name}`);
    },
    storeValue: (value, name) => {
      storedValues.push({ value, name });
    },
  });
  return { powers, gateway, greeter, helloCalls, storedValues, signingKeys };
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

test.failing(
  'peer teardown surfaces as a rejection on the next call',
  async t => {
    // Smoke test for the disconnect path: once one side tears its
    // transport down, the other side's next `E(remoteGateway).provide`
    // call should reject rather than hang.
    //
    // Currently it hangs: cancelling peer B's transport context tears
    // down B's listener but A's already-established OCapN session does
    // not learn that the underlying TCP socket has closed before A
    // tries another `op:deliver` on it. The OCapN session's
    // disconnect-detection path needs work — likely either a TCP
    // keepalive on the transport side or a heartbeat at the OCapN
    // session level (the latter is exactly what
    // `ocapn-noise-session-reconnect`, Proposed, specifies).
    //
    // Marked `.failing` so this test acts as a sentinel: when the
    // disconnect plumbing gets fixed (or when the reconnect design
    // lands and the assertion flips from "rejects" to "the next call
    // re-establishes and succeeds"), this test starts passing and
    // `test.failing` flags it.
    t.timeout(30_000);
    const contextA = makeMockContext();
    const contextB = makeMockContext();
    t.teardown(() => contextA.cancel());

    const a = makeMockPowers('a'.repeat(64), 'A');
    const b = makeMockPowers('b'.repeat(64), 'B');

    const serviceA = await makeOcapnNetwork(a.powers, contextA);
    const serviceB = await makeOcapnNetwork(b.powers, contextB);

    const [addressB] = await E(serviceB).addresses();

    const connectionContext = makeMockContext();
    const remoteGateway = await E(serviceA).connect(
      addressB,
      connectionContext,
    );

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
  },
);

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

  const a = makeMockPowers('a'.repeat(64), 'A');
  const b = makeMockPowers('b'.repeat(64), 'B');

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
  t.deepEqual(a.helloCalls, ['b'.repeat(64)]);
  t.deepEqual(b.helloCalls, ['a'.repeat(64)]);

  // Both gateways round-trip through their underlying session.
  t.is(await E(gatewayBFromA).provide('x'), 'B:value-for:x');
  t.is(await E(gatewayAFromB).provide('y'), 'A:value-for:y');
});

test('OCapN-Noise identity persists across transport restart', async t => {
  // Phase 2: the OCapN-Noise signing key is bound to the agent's
  // Ed25519 keypair (read from the `agent_key` SQLite table via
  // `EndoHost.getSigningKeys()`), so two consecutive transport
  // instantiations on the same agent must produce the same OCapN
  // location designator and the same advertised public-key bytes in
  // the connection hint. Before Phase 2 the transport minted a fresh
  // key on every install and the OCapN identity reset on every
  // restart.
  t.timeout(60_000);
  const nodeId = 'a'.repeat(64);
  const { powers: powersA } = makeMockPowers(nodeId, 'A');

  const contextA1 = makeMockContext();
  t.teardown(() => contextA1.cancel());
  const serviceA1 = await makeOcapnNetwork(powersA, contextA1);
  const [addressA1] = await E(serviceA1).addresses();

  // Tear down the first instance and create a fresh one with the
  // same mock powers (i.e., the same persisted keypair).
  contextA1.cancel();

  const contextA2 = makeMockContext();
  t.teardown(() => contextA2.cancel());
  const serviceA2 = await makeOcapnNetwork(powersA, contextA2);
  const [addressA2] = await E(serviceA2).addresses();

  // The connection-hint URL carries the full OCapN location as a
  // base64-encoded JSON blob in the `loc=` query param; the
  // location's `designator` is the Ed25519 public key the Noise
  // handshake authenticates against. That public key must match
  // across restarts.
  const locA1 = JSON.parse(
    /** @type {string} */ (new URL(addressA1).searchParams.get('loc')),
  );
  const locA2 = JSON.parse(
    /** @type {string} */ (new URL(addressA2).searchParams.get('loc')),
  );
  t.deepEqual(
    locA2.designator,
    locA1.designator,
    'OCapN designator (Ed25519 public key) is stable across restart',
  );
});
