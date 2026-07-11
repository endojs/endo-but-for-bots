// @ts-check

import '@endo/init/debug.js';

import { setImmediate as setImmediateNode } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeGateway,
  DEFAULT_BIND_ADDRESS,
  defaultFeatureToggles,
} from '../index.js';
import {
  makeNodeCryptoPowers,
  generateNodeEd25519Keypair,
} from '../src/node-crypto-powers.js';

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
 * Default powers triple. The bootstrap registrar (Feature 4) is on
 * by default and requires crypto + clock; the tests inject the
 * Node-backed adapters so they exercise the same wiring an embedder
 * uses in production.
 *
 * @param {object} [opts]
 * @param {{[name: string]: string | undefined}} [opts.env]
 */
const defaultPowers = (opts = {}) =>
  harden({
    env: opts.env,
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    // gitHttp is on by default (Feature 3) and requires the
    // serveRepo adapter; tests that don't exercise the Git path
    // get a stub that 401s every request.
    serveRepo: async () => undefined,
  });

/**
 * Convenience: every legacy test wants the default powers; new
 * tests opt out by passing `{ powers: ... }` themselves.
 *
 * @param {Parameters<typeof makeGateway>[0]} [args]
 */
const gateway = (args = {}) =>
  makeGateway({
    ...args,
    powers: args.powers ?? defaultPowers(),
  });

test('makeGateway returns a hardened exo', t => {
  t.true(Object.isFrozen(gateway()));
});

test('makeGateway defaults to ENDO_HTTP_ADDR fallback', async t => {
  const g = gateway();
  t.is(await E(g).getBindAddress(), DEFAULT_BIND_ADDRESS);
});

test('makeGateway reads ENDO_HTTP_ADDR from powers.env', async t => {
  const g = gateway({
    powers: defaultPowers({ env: { ENDO_HTTP_ADDR: '127.0.0.1:0' } }),
  });
  t.is(await E(g).getBindAddress(), '127.0.0.1:0');
});

test('makeGateway env beats explicit config', async t => {
  // Per the design's Configuration Model: environment is the
  // third (last-wins) layer. If a refactor inverts this order,
  // an operator's `ENDO_HTTP_ADDR` is silently ignored when the
  // host also supplies a `bindAddress` in config.
  const g = gateway({
    powers: defaultPowers({ env: { ENDO_HTTP_ADDR: '127.0.0.1:0' } }),
    config: { bindAddress: '0.0.0.0:9999' },
  });
  t.is(await E(g).getBindAddress(), '127.0.0.1:0');
});

test('makeGateway with explicit config and no env honors config', async t => {
  const g = gateway({ config: { bindAddress: '127.0.0.1:8920' } });
  t.is(await E(g).getBindAddress(), '127.0.0.1:8920');
});

test('makeGateway with bracketed IPv6 round-trips the address', async t => {
  const g = gateway({ config: { bindAddress: '[::1]:3469' } });
  t.is(await E(g).getBindAddress(), '[::1]:3469');
});

test('Gateway lifecycle: start then stop', async t => {
  const g = gateway();
  await E(g).start();
  await E(g).stop();
  t.pass();
});

test('Gateway start is idempotent', async t => {
  const g = gateway();
  await E(g).start();
  await E(g).start();
  t.pass();
});

test('Gateway start after stop is an error', async t => {
  // A restart after stop is a follow-on responsibility (the
  // network surface and registration table reset are not yet
  // designed). Until then, stop is terminal; this assertion
  // pins the contract.
  const g = gateway();
  await E(g).start();
  await E(g).stop();
  await t.throwsAsync(() => E(g).start(), {
    message: /has been stopped and cannot restart/,
  });
});

test('Gateway stop is idempotent', async t => {
  const g = gateway();
  await E(g).stop();
  await E(g).stop();
  t.pass();
});

test('Gateway getApps returns an AppsNameHub', async t => {
  const g = gateway();
  const apps = await E(g).getApps();
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-id-abc');
});

test('Gateway getApps returns the same hub on repeated calls', async t => {
  // Repeated calls must return the same hub; otherwise bindings
  // a host agent installs on one call vanish on the next.
  const g = gateway();
  const apps1 = await E(g).getApps();
  await E(apps1).bind('chat.example.com', 'weblet-id-abc');
  const apps2 = await E(g).getApps();
  t.is(await E(apps2).lookup('chat.example.com'), 'weblet-id-abc');
});

test('Gateway getConfig returns the merged, hardened config', async t => {
  const g = gateway({
    config: {
      bindAddress: '127.0.0.1:0',
      enableFeatures: { ...defaultFeatureToggles, gitHttp: false },
    },
  });
  const cfg = await E(g).getConfig();
  t.is(cfg.bindAddress, '127.0.0.1:0');
  t.false(cfg.enableFeatures.gitHttp);
  t.true(Object.isFrozen(cfg));
  t.true(Object.isFrozen(cfg.enableFeatures));
});

// -- Phase 2 additions: bootstrap (Feature 4) --------------------

test('Gateway getBootstrap returns the bootstrap exo when sockBootstrap is on', async t => {
  const g = gateway();
  const bootstrap = await E(g).getBootstrap();
  t.truthy(bootstrap);
  // Smoke-test the exo: it must expose `challenge` and round-trip a
  // registration.
  const issued = await E(bootstrap).challenge();
  t.is(issued.nonce.byteLength, 32);
  t.is(issued.hashedNonce.byteLength, 32);
});

test('Gateway getBootstrap throws when sockBootstrap is off', async t => {
  // Regression: the accessor must be a hard error rather than a
  // silent no-op when the feature is disabled, so a misconfigured
  // embedder fails loudly.
  const g = gateway({
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        sockBootstrap: false,
        adminDaemon: false,
        captpRelay: false,
        // ocapnWebSocket depends on sockBootstrap (per the Phase 4
        // dependency check); turn it off too so the validator
        // accepts the sockBootstrap=false configuration.
        ocapnWebSocket: false,
      },
    },
  });
  await t.throwsAsync(() => E(g).getBootstrap(), {
    message: /Gateway bootstrap is disabled/,
  });
});

test('makeGateway throws when sockBootstrap is on but crypto is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: /** @type {any} */ ({
          clock: makeFakeClock(),
        }),
      }),
    { message: /sockBootstrap requires powers.crypto/ },
  );
});

test('makeGateway throws when sockBootstrap is on but clock is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: /** @type {any} */ ({
          crypto: makeNodeCryptoPowers(),
        }),
      }),
    { message: /sockBootstrap requires powers.clock/ },
  );
});

test('bootstrap.getApps returns the same hub as gateway.getApps', async t => {
  // The bootstrap shares the gateway's apps NameHub so a binding
  // installed over the sock is visible to the HTTP routing path. If
  // a refactor accidentally creates a second hub for the bootstrap,
  // the gateway routes traffic to bindings that no sock client can
  // install.
  const g = gateway();
  const fromGateway = await E(g).getApps();
  const bootstrap = await E(g).getBootstrap();
  const fromBootstrap = await E(bootstrap).getApps();
  await E(fromBootstrap).bind('via-bootstrap.example.com', 'weblet-abc');
  t.is(await E(fromGateway).lookup('via-bootstrap.example.com'), 'weblet-abc');
});

test('bootstrap.getBindAddress reflects the gateway bind', async t => {
  const g = gateway({ config: { bindAddress: '[::1]:4242' } });
  const bootstrap = await E(g).getBootstrap();
  t.is(await E(bootstrap).getBindAddress(), '[::1]:4242');
});

// -- Phase 7 additions: formula-backed apps NameHub (Feature 2) --------

/**
 * A minimal in-memory `AppsFormulaStore` fake the gateway-side
 * wiring tests inject. Mirrors the apps-formula test's
 * `makeFakeStore` but kept local so the two test files don't
 * couple.
 *
 * @param {object} [opts]
 * @param {ReadonlyArray<{name: string, webletFormulaId: string}>} [opts.seed]
 */
const makeAppsStoreFake = (opts = {}) => {
  const persisted = new Map(
    (opts.seed ?? []).map(({ name, webletFormulaId }) => [
      name,
      webletFormulaId,
    ]),
  );
  return harden({
    async listBindings() {
      return harden(
        [...persisted].map(([name, webletFormulaId]) =>
          harden({ name, webletFormulaId }),
        ),
      );
    },
    /**
     * @param {string} name
     * @param {string} webletFormulaId
     */
    async writeBinding(name, webletFormulaId) {
      persisted.set(name, webletFormulaId);
    },
    /** @param {string} name */
    async deleteBinding(name) {
      persisted.delete(name);
    },
  });
};

test('Gateway uses the in-memory apps hub when appsFormulaStore is omitted', async t => {
  // Phase-1 carry-forward: when no formula store is supplied, the
  // in-memory hub keeps phase-1 behavior. Regression: a refactor
  // that always wires the formula-backed hub would tie the gateway
  // to a daemon-side store the embedder may not have.
  const g = gateway();
  const apps = await E(g).getApps();
  // The in-memory hub does not expose whenReady; reaching for it
  // throws because the exo interface does not include it.
  await t.throwsAsync(() => E(/** @type {any} */ (apps)).whenReady(), {
    message: /method.*whenReady/,
  });
});

test('Gateway uses the formula-backed apps hub when appsFormulaStore is supplied', async t => {
  // Regression: if a refactor stops consulting
  // `powers.appsFormulaStore` in makeGateway, the gateway silently
  // reverts to in-memory and a binding installed on one process
  // does not survive restart.
  const fake = makeAppsStoreFake({
    seed: [{ name: 'chat.example.com', webletFormulaId: 'weblet-chat' }],
  });
  const g = gateway({
    powers: { ...defaultPowers(), appsFormulaStore: fake },
  });
  const apps = await E(g).getApps();
  // Hydration round-trip: the seed becomes a lookup-able binding.
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-chat');
});

test('Gateway.start awaits formula-backed hub hydration', async t => {
  // Regression: if a refactor drops the start-time await, a broken
  // formula store does not surface until the first bind/lookup,
  // contradicting the fail-closed posture from
  // designs/gateway-package.md § Feature 2.
  /** @type {(value: unknown) => void} */
  let listResolve = () => {};
  /** @type {Promise<unknown>} */
  const listPromise = new Promise(resolve => {
    listResolve = resolve;
  });
  /** @type {any} */
  const slowStore = harden({
    async listBindings() {
      return listPromise;
    },
    async writeBinding() {
      // unused in this test; deliberately a no-op
    },
    async deleteBinding() {
      // unused in this test; deliberately a no-op
    },
  });
  const g = gateway({
    powers: { ...defaultPowers(), appsFormulaStore: slowStore },
  });
  // Capture the start promise; it should not resolve until the
  // store's listBindings resolves.
  const startP = E(g).start();
  // The microtask queue settles; startP is still pending.
  await setImmediateNode();
  let settled = false;
  void startP.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await setImmediateNode();
  t.false(settled);
  // Now resolve the store; start should complete.
  listResolve([]);
  await startP;
});

test('Gateway.start surfaces formula-backed hub hydration failures', async t => {
  /** @type {any} */
  const brokenStore = harden({
    async listBindings() {
      throw new Error('store offline');
    },
    async writeBinding() {
      // unused in this test; deliberately a no-op
    },
    async deleteBinding() {
      // unused in this test; deliberately a no-op
    },
  });
  const g = gateway({
    powers: { ...defaultPowers(), appsFormulaStore: brokenStore },
  });
  await t.throwsAsync(() => E(g).start(), { message: 'store offline' });
});

test('Gateway formula-backed bindings persist through the supplied store', async t => {
  // A bind on the gateway-exposed hub writes through to the store;
  // a second gateway constructed against the same store rehydrates
  // the binding. This is the cross-restart round-trip that motivates
  // Feature 2.
  const fake = makeAppsStoreFake();
  const g1 = gateway({
    powers: { ...defaultPowers(), appsFormulaStore: fake },
  });
  const apps1 = await E(g1).getApps();
  await E(apps1).bind('chat.example.com', 'weblet-id-abc');
  // Simulated restart: a fresh gateway sharing the same store.
  const g2 = gateway({
    powers: { ...defaultPowers(), appsFormulaStore: fake },
  });
  const apps2 = await E(g2).getApps();
  t.is(await E(apps2).lookup('chat.example.com'), 'weblet-id-abc');
});

test('bootstrap-mediated register and publishWeblet round-trip end to end', async t => {
  // End-to-end through the gateway: an embedder calls
  // `getBootstrap`, completes a challenge/response, registers, and
  // publishes a weblet. Asserts the gateway's wiring composes
  // correctly across config.js + bootstrap.js + node-crypto-powers.
  const g = gateway();
  const bootstrap = await E(g).getBootstrap();
  const kp = await generateNodeEd25519Keypair();
  const issued = await E(bootstrap).challenge();
  const signature = kp.sign(issued.hashedNonce);
  const registration = await E(bootstrap).register({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature,
  });
  await E(registration).publishWeblet({
    webletId: 'weblet-abc',
    contentTreeRoot: 'a'.repeat(64),
    hasWebSocket: true,
  });
  const weblets = await E(registration).listWeblets();
  t.is(weblets.length, 1);
  t.is(weblets[0].webletId, 'weblet-abc');
});
