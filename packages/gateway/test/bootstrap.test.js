// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeGatewayBootstrap,
  makeAppsNameHub,
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
} from '../index.js';
import {
  makeNodeCryptoPowers,
  generateNodeEd25519Keypair,
} from '../src/node-crypto-powers.js';

/**
 * Helper: build a Uint8Array of the given length and fill byte.
 * Tests use this to construct invalid-length inputs.
 *
 * @param {number} length
 * @param {number} [fill]
 */
const bytesOf = (length, fill = 0) => {
  const u = new Uint8Array(length);
  u.fill(fill);
  return u;
};

/**
 * @param {number} initial
 */
const makeFakeClock = initial => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
  });
};

/**
 * Convenience: stand up a bootstrap with sensible defaults.
 *
 * @param {object} [opts]
 * @param {number} [opts.startMs]
 * @param {number} [opts.ttlMs]
 * @param {string} [opts.bindAddress]
 */
const stand = (opts = {}) => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(opts.startMs ?? 0);
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto,
    clock,
    apps,
    getBindAddress: () => opts.bindAddress ?? '0.0.0.0:3469',
    ttlMs: opts.ttlMs,
  });
  return { crypto, clock, apps, handle };
};

test('challenge returns a fresh nonce + hashed nonce + window', async t => {
  const { handle } = stand({ startMs: 1_000_000 });
  const issued = await E(handle.bootstrap).challenge();
  t.is(issued.nonce.byteLength, 32);
  t.is(issued.hashedNonce.byteLength, 32);
  t.is(typeof issued.issuedAt, 'number');
  t.is(typeof issued.expiresAt, 'number');
  t.true(issued.expiresAt > issued.issuedAt);
});

test('register accepts a valid challenge-response and returns a Registration', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const signature = kp.sign(issued.hashedNonce);
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature,
  });
  t.truthy(registration);
  const keys = await E(registration).listPublicKeys();
  t.is(keys.length, 1);
});

test('register rejects a missing args object', async t => {
  const { handle } = stand();
  await t.throwsAsync(
    () => E(handle.bootstrap).register(/** @type {any} */ (null)),
    { message: /register expects an args object/ },
  );
});

test('register rejects a wrong-length publicKey', async t => {
  const { handle } = stand();
  const issued = await E(handle.bootstrap).challenge();
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: bytesOf(16),
        nonce: issued.nonce,
        signature: bytesOf(ED25519_SIGNATURE_LENGTH),
      }),
    { message: new RegExp(`must be ${ED25519_PUBLIC_KEY_LENGTH} bytes`) },
  );
});

test('register rejects a wrong-length signature', async t => {
  const { handle } = stand();
  const issued = await E(handle.bootstrap).challenge();
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: bytesOf(ED25519_PUBLIC_KEY_LENGTH),
        nonce: issued.nonce,
        signature: bytesOf(16),
      }),
    { message: new RegExp(`must be ${ED25519_SIGNATURE_LENGTH} bytes`) },
  );
});

test('register rejects a signature under a foreign key', async t => {
  // Regression: this is the protocol's load-bearing property. If
  // the verifier short-circuits, one local user could register
  // another's public key.
  const { handle } = stand();
  const alice = await generateNodeEd25519Keypair();
  const eve = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  // Eve signs the challenge but submits Alice's public key.
  const eveSig = eve.sign(issued.hashedNonce);
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: alice.publicKey,
        nonce: issued.nonce,
        signature: eveSig,
      }),
    { message: /Proof-of-possession signature does not verify/ },
  );
});

test('register rejects a replay of the same nonce', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const signature = kp.sign(issued.hashedNonce);
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature,
  });
  // Second use of the same nonce must fail.
  const kp2 = await generateNodeEd25519Keypair();
  const sig2 = kp2.sign(issued.hashedNonce);
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: kp2.publicKey,
        nonce: issued.nonce,
        signature: sig2,
      }),
    { message: /Unknown or already-consumed nonce/ },
  );
});

test('register rejects an expired challenge', async t => {
  const { clock, handle } = stand({ ttlMs: 1000 });
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  clock.advance(2000);
  const signature = kp.sign(issued.hashedNonce);
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: kp.publicKey,
        nonce: issued.nonce,
        signature,
      }),
    { message: /(has expired|Unknown or already-consumed)/ },
  );
});

test('register rejects a duplicate public key', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued1.nonce,
    signature: kp.sign(issued1.hashedNonce),
  });
  // Same key, second challenge.
  const issued2 = await E(handle.bootstrap).challenge();
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).register({
        publicKey: kp.publicKey,
        nonce: issued2.nonce,
        signature: kp.sign(issued2.hashedNonce),
      }),
    { message: /already registered/ },
  );
});

test('registerRelay requires a relayTarget', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const signature = kp.sign(issued.hashedNonce);
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).registerRelay(
        /** @type {any} */ ({
          publicKey: kp.publicKey,
          nonce: issued.nonce,
          signature,
          // relayTarget omitted
        }),
      ),
    { message: /requires a relayTarget/ },
  );
});

test('registerRelay stores the relay target in the entry', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const fakeTarget = harden({ kind: 'relay-target' });
  await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: fakeTarget,
  });
  const entries = handle.listRegisteredPeers();
  t.is(entries.length, 1);
  t.is(entries[0].relayTarget, fakeTarget);
});

test('publishWeblet records a descriptor', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).publishWeblet({
    webletId: 'weblet-abc',
    contentTreeRoot: 'a'.repeat(64),
    hasWebSocket: true,
  });
  const list = await E(registration).listWeblets();
  t.is(list.length, 1);
  t.is(list[0].webletId, 'weblet-abc');
  t.is(list[0].contentTreeRoot, 'a'.repeat(64));
  t.true(list[0].hasWebSocket);
});

test('publishWeblet rejects an invalid contentTreeRoot', async t => {
  // Regression: if the validator accepts a non-hex value, the
  // gateway's CAS lookup will quietly skip it later and the
  // weblet fails to serve.
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(
    () =>
      E(registration).publishWeblet({
        webletId: 'weblet-abc',
        contentTreeRoot: 'not-hex',
        hasWebSocket: false,
      }),
    { message: /64 lowercase hex characters/ },
  );
});

test('publishWeblet rejects an invalid webletId', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(
    () =>
      E(registration).publishWeblet({
        webletId: 'has whitespace',
        contentTreeRoot: 'a'.repeat(64),
        hasWebSocket: false,
      }),
    { message: /webletId contains invalid characters/ },
  );
});

test('publishWeblet rejects a non-boolean hasWebSocket', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(
    () =>
      E(registration).publishWeblet(
        /** @type {any} */ ({
          webletId: 'weblet-abc',
          contentTreeRoot: 'a'.repeat(64),
          hasWebSocket: 'yes',
        }),
      ),
    { message: /hasWebSocket must be a boolean/ },
  );
});

test('unpublishWeblet removes the entry', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).publishWeblet({
    webletId: 'weblet-abc',
    contentTreeRoot: 'a'.repeat(64),
    hasWebSocket: false,
  });
  await E(registration).unpublishWeblet('weblet-abc');
  const list = await E(registration).listWeblets();
  t.is(list.length, 0);
});

test('addPublicKey extends the registration after a fresh challenge', async t => {
  const { handle } = stand();
  const kp1 = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp1.publicKey,
    nonce: issued1.nonce,
    signature: kp1.sign(issued1.hashedNonce),
  });
  const kp2 = await generateNodeEd25519Keypair();
  const issued2 = await E(handle.bootstrap).challenge();
  await E(registration).addPublicKey({
    publicKey: kp2.publicKey,
    nonce: issued2.nonce,
    signature: kp2.sign(issued2.hashedNonce),
  });
  const keys = await E(registration).listPublicKeys();
  t.is(keys.length, 2);
});

test('addPublicKey rejects a duplicate key', async t => {
  const { handle } = stand();
  const kp1 = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp1.publicKey,
    nonce: issued1.nonce,
    signature: kp1.sign(issued1.hashedNonce),
  });
  // Attempt to add the same key.
  const issued2 = await E(handle.bootstrap).challenge();
  await t.throwsAsync(
    () =>
      E(registration).addPublicKey({
        publicKey: kp1.publicKey,
        nonce: issued2.nonce,
        signature: kp1.sign(issued2.hashedNonce),
      }),
    { message: /is already registered/ },
  );
});

test('deregister tombstones every operation', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).deregister();
  await t.throwsAsync(() => E(registration).listWeblets(), {
    message: /has been deregistered/,
  });
  await t.throwsAsync(() => E(registration).listPublicKeys(), {
    message: /has been deregistered/,
  });
});

test('deregister is idempotent', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).deregister();
  await E(registration).deregister();
  t.pass();
});

test('deregister releases the public key for re-registration', async t => {
  // Regression for the lifecycle: a daemon that deregisters and
  // then restarts must be able to register the same key again.
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  const r1 = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued1.nonce,
    signature: kp.sign(issued1.hashedNonce),
  });
  await E(r1).deregister();
  const issued2 = await E(handle.bootstrap).challenge();
  await t.notThrowsAsync(() =>
    E(handle.bootstrap).register({
      publicKey: kp.publicKey,
      nonce: issued2.nonce,
      signature: kp.sign(issued2.hashedNonce),
    }),
  );
});

test('getBindAddress returns the injected value', async t => {
  const { handle } = stand({ bindAddress: '127.0.0.1:54321' });
  t.is(await E(handle.bootstrap).getBindAddress(), '127.0.0.1:54321');
});

test('getApps returns the shared AppsNameHub', async t => {
  const { apps, handle } = stand();
  const fromExo = await E(handle.bootstrap).getApps();
  // Bind on either side and observe on the other.
  await E(fromExo).bind('chat.example.com', 'weblet-id-abc');
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-id-abc');
});

test('listRegisteredPeers omits deregistered entries', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  t.is(handle.listRegisteredPeers().length, 1);
  await E(r).deregister();
  t.is(handle.listRegisteredPeers().length, 0);
});

test('GatewayBootstrap is a hardened exo with discoverable methods', async t => {
  const { handle } = stand();
  t.true(Object.isFrozen(handle.bootstrap));
  const introspect = /** @type {any} */ (E(handle.bootstrap));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('challenge'));
  t.true(methods.includes('register'));
  t.true(methods.includes('registerRelay'));
  t.true(methods.includes('getBindAddress'));
  t.true(methods.includes('getApps'));
});

test('Registration is a hardened exo with discoverable methods', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  t.true(Object.isFrozen(r));
  const introspect = /** @type {any} */ (E(r));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('publishWeblet'));
  t.true(methods.includes('unpublishWeblet'));
  t.true(methods.includes('addPublicKey'));
  t.true(methods.includes('deregister'));
});

test('makeGatewayBootstrap requires crypto, clock, apps, getBindAddress', t => {
  const apps = makeAppsNameHub();
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  t.throws(
    () =>
      makeGatewayBootstrap(
        /** @type {any} */ ({ clock, apps, getBindAddress: () => '' }),
      ),
    { message: /requires crypto/ },
  );
  t.throws(
    () =>
      makeGatewayBootstrap(
        /** @type {any} */ ({ crypto, apps, getBindAddress: () => '' }),
      ),
    { message: /requires clock/ },
  );
  t.throws(
    () =>
      makeGatewayBootstrap(
        /** @type {any} */ ({ crypto, clock, getBindAddress: () => '' }),
      ),
    { message: /requires an AppsNameHub/ },
  );
  t.throws(
    () => makeGatewayBootstrap(/** @type {any} */ ({ crypto, clock, apps })),
    { message: /requires a getBindAddress function/ },
  );
});

// -- Relay-policy fields on registerRelay (Feature 6 / Phase 5) ---

test('registerRelay defaults relayPolicy to "closed"', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  t.is(await E(r).getRelayPolicy(), 'closed');
  // listRegisteredPeers surfaces the policy.
  const entries = handle.listRegisteredPeers();
  t.is(entries[0].relayPolicy, 'closed');
  t.deepEqual([...(entries[0].callerAllowlist ?? [])], []);
});

test('registerRelay accepts an explicit open policy', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
    relayPolicy: 'open',
  });
  t.is(await E(r).getRelayPolicy(), 'open');
});

test('registerRelay rejects an unknown relayPolicy value', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await t.throwsAsync(
    () =>
      E(handle.bootstrap).registerRelay({
        publicKey: kp.publicKey,
        nonce: issued.nonce,
        signature: kp.sign(issued.hashedNonce),
        relayTarget: harden({ kind: 'relay-target' }),
        relayPolicy: /** @type {any} */ ('semi-open'),
      }),
    { message: /relayPolicy must be "closed" or "open"/ },
  );
});

// -- Registration handle: relay-policy mutators -------------------

test('Registration.setRelayPolicy flips the policy and returns the previous value', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  t.is(await E(r).setRelayPolicy('open'), 'closed');
  t.is(await E(r).getRelayPolicy(), 'open');
});

test('Registration relay-policy methods throw on a register (non-relay) registration', async t => {
  // Regression: a `register` (daemon) registration has no policy
  // entry; the relay-policy mutators must surface the type error
  // rather than silently storing state that the handler will never
  // consult.
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(() => E(r).setRelayPolicy('open'), {
    message: /not a relay registration/,
  });
  await t.throwsAsync(() => E(r).getRelayPolicy(), {
    message: /not a relay registration/,
  });
  await t.throwsAsync(() => E(r).addCallerPublicKey(bytesOf(32)), {
    message: /not a relay registration/,
  });
  await t.throwsAsync(() => E(r).removeCallerPublicKey(bytesOf(32)), {
    message: /not a relay registration/,
  });
  await t.throwsAsync(() => E(r).listCallerPublicKeys(), {
    message: /not a relay registration/,
  });
});

test('Registration.addCallerPublicKey adds a key and listCallerPublicKeys reports it', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  t.true(await E(r).addCallerPublicKey(bytesOf(32, 0x11)));
  // Idempotent on re-add.
  t.false(await E(r).addCallerPublicKey(bytesOf(32, 0x11)));
  const list = await E(r).listCallerPublicKeys();
  t.deepEqual([...list], ['11'.repeat(32)]);
});

test('Registration.removeCallerPublicKey removes a previously-added key', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  await E(r).addCallerPublicKey(bytesOf(32, 0x22));
  t.true(await E(r).removeCallerPublicKey(bytesOf(32, 0x22)));
  t.false(await E(r).removeCallerPublicKey(bytesOf(32, 0x22)));
  const list = await E(r).listCallerPublicKeys();
  t.deepEqual([...list], []);
});

test('Registration.relay-policy methods reject wrong-length caller keys', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  await t.throwsAsync(() => E(r).addCallerPublicKey(bytesOf(16)), {
    message: /must be 32 bytes/,
  });
  await t.throwsAsync(() => E(r).removeCallerPublicKey(bytesOf(16)), {
    message: /must be 32 bytes/,
  });
});

test('Registration relay-policy methods reject after deregister', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  await E(r).deregister();
  await t.throwsAsync(() => E(r).getRelayPolicy(), {
    message: /has been deregistered/,
  });
  await t.throwsAsync(() => E(r).setRelayPolicy('open'), {
    message: /has been deregistered/,
  });
  await t.throwsAsync(() => E(r).addCallerPublicKey(bytesOf(32)), {
    message: /has been deregistered/,
  });
});

// -- Bootstrap admin-backplane mutators ---------------------------

test('setRelayPolicyByPublicKey updates a relay registration in place', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  t.is(handle.setRelayPolicyByPublicKey(kp.publicKey, 'open'), 'closed');
  const entries = handle.listRegisteredPeers();
  t.is(entries[0].relayPolicy, 'open');
});

test('setRelayPolicyByPublicKey returns undefined for unknown keys', t => {
  const { handle } = stand();
  const unknown = new Uint8Array(32).fill(0xee);
  t.is(handle.setRelayPolicyByPublicKey(unknown, 'open'), undefined);
});

test('setRelayPolicyByPublicKey throws on a non-relay registration', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  t.throws(() => handle.setRelayPolicyByPublicKey(kp.publicKey, 'open'), {
    message: /is not a relay registration/,
  });
});

test('addRelayCallerByPublicKey / removeRelayCallerByPublicKey round-trip', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  const callerKey = bytesOf(32, 0x44);
  t.is(handle.addRelayCallerByPublicKey(kp.publicKey, callerKey), true);
  t.is(handle.addRelayCallerByPublicKey(kp.publicKey, callerKey), false);
  t.is(handle.removeRelayCallerByPublicKey(kp.publicKey, callerKey), true);
  t.is(handle.removeRelayCallerByPublicKey(kp.publicKey, callerKey), false);
});

test('addRelayCallerByPublicKey returns undefined for unknown public keys', t => {
  const { handle } = stand();
  const unknown = new Uint8Array(32).fill(0xee);
  t.is(
    handle.addRelayCallerByPublicKey(unknown, new Uint8Array(32).fill(0x55)),
    undefined,
  );
  t.is(
    handle.removeRelayCallerByPublicKey(unknown, new Uint8Array(32).fill(0x55)),
    undefined,
  );
});

test('lookupRegistrationByPublicKey surfaces the live policy entry', async t => {
  // Regression: the handler holds the live entry by reference so
  // admin / registrant mutations are visible immediately. If lookup
  // returned a snapshot, the allowlist updates would lag by one
  // session.
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  const result = handle.lookupRegistrationByPublicKey(kp.publicKey);
  t.truthy(result);
  t.truthy(result?.policy);
  t.is(result?.policy?.policy, 'closed');
  t.is(result?.policy?.callerAllowlist.size, 0);
  handle.addRelayCallerByPublicKey(kp.publicKey, bytesOf(32, 0x66));
  t.is(result?.policy?.callerAllowlist.size, 1);
});

test('lookupRegistrationByPublicKey returns no policy for a register (non-relay) entry', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const daemon = harden({ kind: 'daemon' });
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    daemon,
  });
  const result = handle.lookupRegistrationByPublicKey(kp.publicKey);
  t.is(result?.daemon, daemon);
  t.is(result?.policy, undefined);
});

test('Registration exo surfaces the new relay-policy methods in introspection', async t => {
  const { handle } = stand();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const r = await E(handle.bootstrap).registerRelay({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
    relayTarget: harden({ kind: 'relay-target' }),
  });
  const introspect = /** @type {any} */ (E(r));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('setRelayPolicy'));
  t.true(methods.includes('getRelayPolicy'));
  t.true(methods.includes('addCallerPublicKey'));
  t.true(methods.includes('removeCallerPublicKey'));
  t.true(methods.includes('listCallerPublicKeys'));
});
