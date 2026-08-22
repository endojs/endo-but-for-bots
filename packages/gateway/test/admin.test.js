// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeGateway,
  makeGatewayAdmin,
  makeGatewayBootstrap,
  makeAppsNameHub,
  defaultFeatureToggles,
} from '../index.js';

import {
  makeNodeCryptoPowers,
  generateNodeEd25519Keypair,
} from '../src/node-crypto-powers.js';

/** @import { ResourceLedger, GatewayConfig } from '../src/types.js' */

/**
 * @param {number} length
 * @param {number} [fill]
 */
const bytesOf = (length, fill = 0) => {
  const u = new Uint8Array(length);
  u.fill(fill);
  return u;
};

/**
 * @param {number} [initial]
 */
const makeFakeClock = (initial = 0) => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
  });
};

/**
 * @param {object} [opts]
 * @param {{[name: string]: string | undefined}} [opts.env]
 * @param {ResourceLedger} [opts.resourceLedger]
 * @param {Partial<GatewayConfig>} [opts.config]
 */
const standGateway = (opts = {}) =>
  makeGateway({
    powers: harden({
      env: opts.env,
      crypto: makeNodeCryptoPowers(),
      clock: makeFakeClock(),
      resourceLedger: opts.resourceLedger,
      // gitHttp is on by default and requires the serveRepo
      // adapter; admin tests don't exercise the Git path so they
      // supply a 401-everything stub.
      serveRepo: async () => undefined,
    }),
    config: opts.config,
  });

/**
 * Convenience: build a bootstrap directly and an admin facet on
 * top of its backplane, for tests that exercise the admin exo
 * without going through the full `makeGateway` shape.
 */
const standDirect = () => {
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  const admin = makeGatewayAdmin({
    backplane: {
      listRegisteredPeers: handle.listRegisteredPeers,
      deregisterByPublicKey: handle.deregisterByPublicKey,
      setRelayPolicyByPublicKey: handle.setRelayPolicyByPublicKey,
      addRelayCallerByPublicKey: handle.addRelayCallerByPublicKey,
      removeRelayCallerByPublicKey: handle.removeRelayCallerByPublicKey,
      pendingNonces: handle.pendingNonces,
    },
    apps,
  });
  return { apps, handle, admin };
};

// -- makeGatewayAdmin shape ---------------------------------------

test('makeGatewayAdmin requires a backplane and an AppsNameHub', t => {
  const apps = makeAppsNameHub();
  t.throws(() => makeGatewayAdmin(/** @type {any} */ ({ apps })), {
    message: /requires an admin backplane/,
  });
  const backplane = {
    listRegisteredPeers: () => harden([]),
    deregisterByPublicKey: () => false,
    pendingNonces: () => 0,
  };
  t.throws(() => makeGatewayAdmin(/** @type {any} */ ({ backplane })), {
    message: /requires an AppsNameHub/,
  });
});

test('GatewayAdmin is a hardened exo with discoverable methods', async t => {
  const { admin } = standDirect();
  t.true(Object.isFrozen(admin));
  const introspect = /** @type {any} */ (E(admin));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('listRegistrations'));
  t.true(methods.includes('deregisterRelay'));
  t.true(methods.includes('listVirtualHosts'));
  t.true(methods.includes('getResourceBalances'));
  t.true(methods.includes('getCounters'));
  t.true(methods.includes('setRelayPolicy'));
  t.true(methods.includes('addRelayCaller'));
  t.true(methods.includes('removeRelayCaller'));
});

// -- listRegistrations --------------------------------------------

test('listRegistrations reports the entries in the bootstrap', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 1);
  t.is(entries[0].publicKeys.length, 1);
});

test('listRegistrations is empty before any registration', async t => {
  const { admin } = standDirect();
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
});

test('listRegistrations omits deregistered entries', async t => {
  // Regression: a stale entry leaking through admin would
  // mislead an administrator into thinking a tombstoned key was
  // still claimed.
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).deregister();
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
});

// -- deregisterRelay ----------------------------------------------

test('deregisterRelay force-deregisters a registration by public key', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  const removed = await E(admin).deregisterRelay(kp.publicKey);
  t.true(removed);
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
});

test('deregisterRelay reports false when no registration claims the key', async t => {
  const { admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const removed = await E(admin).deregisterRelay(kp.publicKey);
  t.false(removed);
});

test('deregisterRelay clears every weblet published by the registration', async t => {
  // Regression: an admin tear-down must not leave orphaned
  // weblet entries on the registration's view; the table-side
  // entries are gone via `entry.weblets.clear()` in the bootstrap.
  const { handle, admin } = standDirect();
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
  await E(admin).deregisterRelay(kp.publicKey);
  // The registration handle on the daemon side now rejects
  // operations; from the admin's view, listRegistrations is empty.
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
  // The tombstoned registration's facet rejects further operations.
  await t.throwsAsync(() => E(registration).listWeblets(), {
    message: /has been deregistered/,
  });
});

test('deregisterRelay frees the public key for re-registration', async t => {
  // Regression: after an admin tear-down the daemon should be
  // able to come back online with the same key, same as the
  // self-initiated deregister path.
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued1.nonce,
    signature: kp.sign(issued1.hashedNonce),
  });
  await E(admin).deregisterRelay(kp.publicKey);
  const issued2 = await E(handle.bootstrap).challenge();
  await t.notThrowsAsync(() =>
    E(handle.bootstrap).register({
      publicKey: kp.publicKey,
      nonce: issued2.nonce,
      signature: kp.sign(issued2.hashedNonce),
    }),
  );
});

test('deregisterRelay rejects a wrong-length publicKey', async t => {
  const { admin } = standDirect();
  await t.throwsAsync(() => E(admin).deregisterRelay(bytesOf(16)), {
    message: /must be 32 bytes/,
  });
});

test('deregisterRelay rejects a non-bytes publicKey', async t => {
  const { admin } = standDirect();
  await t.throwsAsync(
    () => E(admin).deregisterRelay(/** @type {any} */ ('not-bytes')),
    { message: /must be a Uint8Array/ },
  );
});

test('deregisterRelay finds the entry by any of its public keys', async t => {
  // Regression for multi-key registrations (`addPublicKey`): the
  // admin must be able to tear down the registration using either
  // the original or the added key.
  const { handle, admin } = standDirect();
  const kp1 = await generateNodeEd25519Keypair();
  const kp2 = await generateNodeEd25519Keypair();
  const issued1 = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp1.publicKey,
    nonce: issued1.nonce,
    signature: kp1.sign(issued1.hashedNonce),
  });
  const issued2 = await E(handle.bootstrap).challenge();
  await E(registration).addPublicKey({
    publicKey: kp2.publicKey,
    nonce: issued2.nonce,
    signature: kp2.sign(issued2.hashedNonce),
  });
  // Force-deregister using the *added* key.
  const removed = await E(admin).deregisterRelay(kp2.publicKey);
  t.true(removed);
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
});

// -- listVirtualHosts ---------------------------------------------

test('listVirtualHosts snapshots the @apps NameHub', async t => {
  const { apps, admin } = standDirect();
  await E(apps).bind('chat.example.com', 'weblet-abc');
  await E(apps).bind('inbox.example.com', 'weblet-def');
  const hosts = await E(admin).listVirtualHosts();
  t.is(hosts.length, 2);
  const names = hosts.map(h => h.name).sort();
  t.deepEqual(names, ['chat.example.com', 'inbox.example.com']);
});

test('listVirtualHosts is empty before any bind', async t => {
  const { admin } = standDirect();
  const hosts = await E(admin).listVirtualHosts();
  t.is(hosts.length, 0);
});

// -- getResourceBalances ------------------------------------------

test('getResourceBalances returns empty when no ledger is wired', async t => {
  const { admin } = standDirect();
  const balances = await E(admin).getResourceBalances();
  t.deepEqual([...balances], []);
});

test('getResourceBalances reads through the supplied ledger', async t => {
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  const fakeLedger = harden({
    async listBalances() {
      return harden([
        harden({
          account: 'alice',
          compute: 100,
          storage: 1024,
          network: 2048,
        }),
      ]);
    },
  });
  const admin = makeGatewayAdmin({
    backplane: {
      listRegisteredPeers: handle.listRegisteredPeers,
      deregisterByPublicKey: handle.deregisterByPublicKey,
      setRelayPolicyByPublicKey: handle.setRelayPolicyByPublicKey,
      addRelayCallerByPublicKey: handle.addRelayCallerByPublicKey,
      removeRelayCallerByPublicKey: handle.removeRelayCallerByPublicKey,
      pendingNonces: handle.pendingNonces,
    },
    apps,
    resourceLedger: fakeLedger,
  });
  const balances = await E(admin).getResourceBalances();
  t.is(balances.length, 1);
  t.is(balances[0].account, 'alice');
  t.is(balances[0].compute, 100);
  t.is(balances[0].storage, 1024);
  t.is(balances[0].network, 2048);
});

// -- getCounters --------------------------------------------------

test('getCounters reports registration and weblet totals', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  const registration = await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await E(registration).publishWeblet({
    webletId: 'weblet-1',
    contentTreeRoot: 'a'.repeat(64),
    hasWebSocket: false,
  });
  await E(registration).publishWeblet({
    webletId: 'weblet-2',
    contentTreeRoot: 'b'.repeat(64),
    hasWebSocket: true,
  });
  const counters = await E(admin).getCounters();
  t.is(counters.totalRegistrations, 1);
  t.is(counters.totalWeblets, 2);
  t.is(typeof counters.pendingNonces, 'number');
});

test('getCounters surfaces outstanding nonces', async t => {
  const { handle, admin } = standDirect();
  // Issue two challenges without consuming them.
  await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).challenge();
  const counters = await E(admin).getCounters();
  t.is(counters.pendingNonces, 2);
});

// -- Gateway-side wiring ------------------------------------------

test('Gateway getAdmin returns the admin exo when adminDaemon is on', async t => {
  const g = standGateway();
  const admin = await E(g).getAdmin();
  t.truthy(admin);
  const hosts = await E(admin).listVirtualHosts();
  t.is(hosts.length, 0);
});

test('Gateway getAdmin throws when adminDaemon is disabled', async t => {
  // Regression: the surface contract demands a hard error so a
  // misconfigured embedder does not silently bypass the
  // "admin authority off the network" rule by getting an exo it
  // could then share over the HTTP / WS surface.
  const g = standGateway({
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        adminDaemon: false,
      },
    },
  });
  await t.throwsAsync(() => E(g).getAdmin(), {
    message: /Gateway admin is disabled/,
  });
});

test('Gateway getAdmin works when sockBootstrap is disabled', async t => {
  // Regression for the bootstrap-vs-admin split (#389): the admin
  // facet has its own access channel (the admin sock) and does
  // not depend on the bootstrap sock. A deployment that wants
  // admin reads of virtual hosts and the resource ledger without
  // exposing the bootstrap sock is a supported shape; the gateway
  // accessor returns the facet, and the registration view is the
  // documented empty list (no bootstrap means no registrations).
  //
  // Other features (OCapN-WS, captp-relay, git-HTTP, chat-hosting)
  // bring their own dependencies on `sockBootstrap` or other
  // toggles; this test enumerates the minimal feature set that
  // pins the admin's standalone behavior, independent of which
  // other phases have landed. The Git smart-HTTP handler
  // (Feature 3) is an independent powers axis (it needs
  // `serveRepo`); this shape disables it so the test stays
  // focused on the admin facet's bootstrap-independence rather
  // than the Git surface.
  const g = makeGateway({
    powers: { crypto: makeNodeCryptoPowers(), clock: makeFakeClock() },
    config: {
      enableFeatures: {
        chatHosting: false,
        virtualHosting: false,
        gitHttp: false,
        sockBootstrap: false,
        captpRelay: false,
        adminDaemon: true,
        ocapnWebSocket: false,
      },
    },
  });
  const admin = await E(g).getAdmin();
  t.truthy(admin);
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 0);
});

test('Gateway admin and bootstrap share the same registration view', async t => {
  // Regression: if a refactor accidentally constructs two
  // bootstraps for one gateway, the admin's listRegistrations
  // would miss entries the public bootstrap recorded.
  const g = standGateway();
  const bootstrap = await E(g).getBootstrap();
  const admin = await E(g).getAdmin();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(bootstrap).challenge();
  await E(bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 1);
});

test('Gateway admin and gateway share the same @apps NameHub', async t => {
  const g = standGateway();
  const apps = await E(g).getApps();
  const admin = await E(g).getAdmin();
  await E(apps).bind('via-gateway.example.com', 'weblet-xyz');
  const hosts = await E(admin).listVirtualHosts();
  const names = hosts.map(h => h.name);
  t.deepEqual([...names], ['via-gateway.example.com']);
});

test('Bootstrap does not expose getAdmin', async t => {
  // Regression for the bootstrap-vs-admin split (#389): any local
  // user daemon may hold a `GatewayBootstrap` (it is what they
  // call `register` on); none of those daemons should be able to
  // reach the `GatewayAdmin` facet through it. The admin facet
  // lives on a separate sock (`admin.sock`) gated by ACL such
  // that only the administrator OS account can connect.
  const g = standGateway();
  const bootstrap = await E(g).getBootstrap();
  const introspect = /** @type {any} */ (E(bootstrap));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.false(methods.includes('getAdmin'));
  const adminMethods = methods.filter(name =>
    name.toLowerCase().includes('admin'),
  );
  t.deepEqual([...adminMethods], []);
});

test('Gateway admin is reachable only via gateway.getAdmin', async t => {
  // The surface contract: there is no second accessor on the
  // gateway and no accessor on the bootstrap that hands out the
  // admin facet. This test pins the contract by enumerating the
  // gateway's method names and verifying the bootstrap exposes no
  // admin-shaped method; a refactor that accidentally added a
  // public accessor would surface here.
  const g = standGateway();
  const introspect = /** @type {any} */ (E(g));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  // Exactly one admin accessor on the gateway.
  const adminMethods = methods.filter(name =>
    name.toLowerCase().includes('admin'),
  );
  t.deepEqual([...adminMethods], ['getAdmin']);
  // Zero admin accessors on the bootstrap.
  const bootstrap = await E(g).getBootstrap();
  const bootstrapIntrospect = /** @type {any} */ (E(bootstrap));
  // eslint-disable-next-line no-underscore-dangle
  const bootstrapMethods = await bootstrapIntrospect.__getMethodNames__();
  const adminBootstrapMethods = bootstrapMethods.filter(name =>
    name.toLowerCase().includes('admin'),
  );
  t.deepEqual([...adminBootstrapMethods], []);
});

// -- Relay-policy admin operations (Phase 5 / Feature 6) ----------

/**
 * @param {ReturnType<typeof makeGatewayBootstrap>} handle
 * @param {{ publicKey: Uint8Array, privateKey: Uint8Array, sign: (m: Uint8Array) => Uint8Array }} keypair
 * @param {unknown} relayTarget
 * @param {'closed' | 'open'} [relayPolicy]
 */
const seedRelay = async (handle, keypair, relayTarget, relayPolicy) => {
  const issued = await E(handle.bootstrap).challenge();
  const args = harden({
    publicKey: keypair.publicKey,
    nonce: issued.nonce,
    signature: keypair.sign(issued.hashedNonce),
    relayTarget,
    ...(relayPolicy === undefined ? {} : { relayPolicy }),
  });
  return E(handle.bootstrap).registerRelay(args);
};

test('GatewayAdmin.setRelayPolicy flips a relay registration policy', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  await seedRelay(handle, kp, harden({ kind: 'relay-target' }));
  const prev = await E(admin).setRelayPolicy(kp.publicKey, 'open');
  t.is(prev, 'closed');
  const entries = await E(admin).listRegistrations();
  t.is(entries[0].relayPolicy, 'open');
});

test('GatewayAdmin.setRelayPolicy throws on unknown public keys', async t => {
  const { admin } = standDirect();
  await t.throwsAsync(() => E(admin).setRelayPolicy(bytesOf(32), 'open'), {
    message: /no registration claims/,
  });
});

test('GatewayAdmin.setRelayPolicy throws on non-relay registrations', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(() => E(admin).setRelayPolicy(kp.publicKey, 'open'), {
    message: /is not a relay registration/,
  });
});

test('GatewayAdmin.setRelayPolicy rejects unknown policy values', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  await seedRelay(handle, kp, harden({ kind: 'relay-target' }));
  await t.throwsAsync(
    () => E(admin).setRelayPolicy(kp.publicKey, /** @type {any} */ ('semi')),
    { message: /relayPolicy must be "closed" or "open"/ },
  );
});

test('GatewayAdmin.addRelayCaller / removeRelayCaller round-trip', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  await seedRelay(handle, kp, harden({ kind: 'relay-target' }));
  const callerKey = bytesOf(32);
  t.true(await E(admin).addRelayCaller(kp.publicKey, callerKey));
  t.false(await E(admin).addRelayCaller(kp.publicKey, callerKey));
  // Surface via listRegistrations.
  const entries = await E(admin).listRegistrations();
  t.is(entries[0].callerAllowlist?.length, 1);
  t.true(await E(admin).removeRelayCaller(kp.publicKey, callerKey));
  t.false(await E(admin).removeRelayCaller(kp.publicKey, callerKey));
});

test('GatewayAdmin.addRelayCaller throws on unknown public keys', async t => {
  const { admin } = standDirect();
  await t.throwsAsync(() => E(admin).addRelayCaller(bytesOf(32), bytesOf(32)), {
    message: /no registration claims/,
  });
});

test('GatewayAdmin.addRelayCaller throws on non-relay registrations', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  await t.throwsAsync(
    () => E(admin).addRelayCaller(kp.publicKey, bytesOf(32)),
    { message: /is not a relay registration/ },
  );
});

test('GatewayAdmin.addRelayCaller rejects wrong-length caller keys', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  await seedRelay(handle, kp, harden({ kind: 'relay-target' }));
  await t.throwsAsync(
    () => E(admin).addRelayCaller(kp.publicKey, bytesOf(16)),
    { message: /must be 32 bytes/ },
  );
});

test('listRegistrations surfaces relayPolicy and callerAllowlist on relay entries', async t => {
  // Regression: without surfacing these fields, an administrator
  // dump could not tell a closed-with-empty-list relay (effectively
  // unreachable) from an open relay (any peer admitted) by reading.
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  await seedRelay(handle, kp, harden({ kind: 'relay-target' }), 'open');
  const callerKey = bytesOf(32, 0x33);
  await E(admin).addRelayCaller(kp.publicKey, callerKey);
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 1);
  t.is(entries[0].relayPolicy, 'open');
  t.deepEqual([...(entries[0].callerAllowlist ?? [])], ['33'.repeat(32)]);
});

test('listRegistrations leaves relayPolicy / callerAllowlist undefined for register entries', async t => {
  const { handle, admin } = standDirect();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(handle.bootstrap).challenge();
  await E(handle.bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature: kp.sign(issued.hashedNonce),
  });
  const entries = await E(admin).listRegistrations();
  t.is(entries.length, 1);
  t.is(entries[0].relayPolicy, undefined);
  t.is(entries[0].callerAllowlist, undefined);
});
