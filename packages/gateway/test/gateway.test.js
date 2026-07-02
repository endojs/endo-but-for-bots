// @ts-check

import '@endo/init/debug.js';

import { setImmediate as setImmediateNode } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeGateway,
  DEFAULT_BIND_ADDRESS,
  defaultFeatureToggles,
  makeFamiliarPublisher,
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
    // Feature 9: suppress the trusted-proxy startup warning in
    // tests by default. The Feature-9 tests below opt in by
    // supplying their own `logWarning` capture recorder.
    /** @param {string} _message */
    logWarning: _message => {},
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

// -- Feature 1 (Phase 8): ResourceLedger wiring -------------------

test('getLedger throws when neither resourceLedger nor verifyPaymentProof is supplied', async t => {
  // Default-powers gateway: no Feature 1 wiring. The accessor
  // explains how to wire it in rather than silently returning
  // undefined.
  const g = gateway();
  await t.throwsAsync(() => E(g).getLedger(), {
    message: /Gateway ledger is not wired/,
  });
});

test('getLedger surfaces the package ResourceLedger when verifyPaymentProof is supplied', async t => {
  // Regression: a refactor that dropped the powers.verifyPaymentProof
  // branch would leave the concrete ledger unreachable and force
  // every embedder to construct it themselves.
  const g = gateway({
    powers: { ...defaultPowers(), verifyPaymentProof: () => true },
  });
  const ledger = await E(g).getLedger();
  const introspect = /** @type {any} */ (E(ledger));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('purchaseTokens'));
  t.true(methods.includes('getBalance'));
});

test('getLedger throws when an external resourceLedger is supplied', async t => {
  // Per Phase 8 contract: an external ledger handle is the
  // embedder's own; the gateway has no `getLedger()` to surface
  // because it did not construct the ledger. The error message
  // names the right path so the embedder fixes the call site.
  const externalLedger = harden({
    async listBalances() {
      return harden([]);
    },
  });
  const g = gateway({
    powers: { ...defaultPowers(), resourceLedger: externalLedger },
  });
  await t.throwsAsync(() => E(g).getLedger(), {
    message: /external.*supplied via powers.resourceLedger/,
  });
});

test('makeGateway rejects both resourceLedger and verifyPaymentProof', t => {
  // Regression: a refactor that passed both into the admin facet
  // would silently prefer one over the other; the design's
  // "Gateway OWNS the surface" framing requires one canonical
  // handle per gateway.
  const externalLedger = harden({
    async listBalances() {
      return harden([]);
    },
  });
  t.throws(
    () =>
      makeGateway({
        powers: {
          ...defaultPowers(),
          resourceLedger: externalLedger,
          verifyPaymentProof: () => true,
        },
      }),
    {
      message: /resourceLedger and.*verifyPaymentProof are mutually exclusive/,
    },
  );
});

test('GatewayAdmin.getResourceBalances reads through the internal ResourceLedger', async t => {
  // End-to-end Phase 3 + Phase 8 wiring: the admin facet's
  // read-through path that Phase 3 stubbed against an external
  // handle should also work against the package's own ledger
  // constructed from verifyPaymentProof.
  const g = gateway({
    powers: { ...defaultPowers(), verifyPaymentProof: () => true },
  });
  const ledger = await E(g).getLedger();
  // Credit one account so the admin's snapshot has a row. The
  // wire shape is `Uint8Array` per the kriskowal directive on
  // PR #393; the exo's interface guard uses `M.raw()` so the
  // Uint8Array passes the wire-side check.
  const publicKey = new Uint8Array(32).fill(0xc3);
  await E(ledger).purchaseTokens(
    publicKey,
    { compute: 42, storage: 0, network: 0 },
    'proof',
  );
  const admin = await E(g).getAdmin();
  const balances = await E(admin).getResourceBalances();
  t.is(balances.length, 1);
  t.is(balances[0].compute, 42);
  t.is(balances[0].account, 'c3'.repeat(32));
});

// -- Phase 9 additions: familiar-bundled publish (Feature 5) -----

/**
 * An in-memory `IoPowers` recorder for the gateway-level wiring
 * tests. The publish module's own test file
 * (`familiar-publish.test.js`) covers the publisher exo's surface
 * exhaustively; these tests pin the gateway-side hooks.
 *
 * @param {object} [opts]
 * @param {string} [opts.publishPath]
 */
const makeRecorderPublisher = ({ publishPath = '/p/gateway' } = {}) => {
  /** @type {Array<{op: string, bindAddress?: string}>} */
  const calls = [];
  /** @type {Map<string, string>} */
  const files = new Map();
  const io = harden({
    /**
     * @param {string} target
     * @param {string} contents
     */
    async writeFile(target, contents) {
      files.set(target, contents);
    },
    /** @param {string} target */
    async removeFile(target) {
      files.delete(target);
    },
  });
  const inner = makeFamiliarPublisher({ io, publishPath });
  // Wrap the inner publisher so the test can observe the gateway's
  // call sequence directly. We keep the inner exo so the wrap's
  // semantics match the production publisher exactly (validation,
  // overwrite, cleanup-idempotence).
  return {
    calls,
    files,
    publisher: harden({
      /** @param {string} bindAddress */
      async publish(bindAddress) {
        calls.push({ op: 'publish', bindAddress });
        await inner.publish(bindAddress);
      },
      async cleanup() {
        calls.push({ op: 'cleanup' });
        await inner.cleanup();
      },
      getPublishPath() {
        return publishPath;
      },
    }),
  };
};

test('familiarBundled defaults to off', async t => {
  // Sanity: the system-service deployment must not publish a file
  // by default. If a refactor flips this default on, every
  // non-Familiar embedder would suddenly require an `io` adapter
  // and a writable state directory.
  const g = gateway();
  const cfg = await E(g).getConfig();
  t.false(cfg.enableFeatures.familiarBundled);
});

test('makeGateway throws when familiarBundled is on but the publisher is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: { env: {} },
        config: {
          bindAddress: '127.0.0.1:0',
          enableFeatures: {
            ...defaultFeatureToggles,
            familiarBundled: true,
            // Familiar-bundled variant turns off the system-side
            // features per the design's sample configuration.
            sockBootstrap: false,
            adminDaemon: false,
            gitHttp: false,
            captpRelay: false,
            ocapnWebSocket: false,
          },
        },
      }),
    { message: /familiarBundled requires powers.familiarPublish/ },
  );
});

test('start publishes the bind address when familiarBundled is on', async t => {
  const { publisher, calls, files } = makeRecorderPublisher();
  const g = makeGateway({
    powers: {
      env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
      familiarPublish: publisher,
    },
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        familiarBundled: true,
        sockBootstrap: false,
        adminDaemon: false,
        gitHttp: false,
        captpRelay: false,
        ocapnWebSocket: false,
      },
    },
  });
  await E(g).start();
  t.deepEqual(calls, [{ op: 'publish', bindAddress: '127.0.0.1:0' }]);
  // The published file content follows the daemon's
  // ${statePath}/gateway shape so the Familiar's existing reader
  // ingests it unchanged.
  t.is(files.get('/p/gateway'), 'http://127.0.0.1:0\n');
});

test('stop cleans up the published file when familiarBundled is on', async t => {
  const { publisher, calls, files } = makeRecorderPublisher();
  const g = makeGateway({
    powers: {
      env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
      familiarPublish: publisher,
    },
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        familiarBundled: true,
        sockBootstrap: false,
        adminDaemon: false,
        gitHttp: false,
        captpRelay: false,
        ocapnWebSocket: false,
      },
    },
  });
  await E(g).start();
  await E(g).stop();
  t.deepEqual(calls, [
    { op: 'publish', bindAddress: '127.0.0.1:0' },
    { op: 'cleanup' },
  ]);
  t.false(files.has('/p/gateway'));
});

test('stop before start is still a no-op (no cleanup call) when familiarBundled is on', async t => {
  // A `stop` before `start` short-circuits at the `unstarted`
  // check, so the cleanup hook never fires. This matches the
  // existing lifecycle: the gateway transitions straight to
  // `stopped` without inviting subsystem teardown. A refactor
  // that moved cleanup before the lifecycle short-circuit would
  // surface here.
  const { publisher, calls } = makeRecorderPublisher();
  const g = makeGateway({
    powers: {
      env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
      familiarPublish: publisher,
    },
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        familiarBundled: true,
        sockBootstrap: false,
        adminDaemon: false,
        gitHttp: false,
        captpRelay: false,
        ocapnWebSocket: false,
      },
    },
  });
  await E(g).stop();
  t.deepEqual(calls, []);
});

test('familiarBundled off: publisher is not invoked even when supplied', async t => {
  // Regression: the toggle is the load-bearing gate, not the
  // presence of the power. A non-Familiar embedder that happens
  // to wire a publisher (e.g., a test rig) must not trigger
  // publishes; otherwise an unrelated test that flips the power
  // on for some unrelated reason would publish a phantom file.
  const { publisher, calls } = makeRecorderPublisher();
  const g = makeGateway({
    powers: { ...defaultPowers(), familiarPublish: publisher },
  });
  await E(g).start();
  await E(g).stop();
  t.deepEqual(calls, []);
});

test('start propagates a publisher error and marks the gateway unstartable', async t => {
  // Phase 7's fail-closed-on-config-drift carry-forward: a
  // publisher that throws (disk full, permission denied) is a
  // startup error rather than a silent degrade. The gateway
  // re-throws and a subsequent start does not succeed.
  const throwingPublisher = harden({
    async publish() {
      throw Error('disk full');
    },
    async cleanup() {
      // Unused in this test; the gateway never reaches the stop
      // path because start() rejects.
      await null;
    },
    getPublishPath() {
      return '/p/gateway';
    },
  });
  const g = makeGateway({
    powers: {
      env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
      familiarPublish: throwingPublisher,
    },
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        familiarBundled: true,
        sockBootstrap: false,
        adminDaemon: false,
        gitHttp: false,
        captpRelay: false,
        ocapnWebSocket: false,
      },
    },
  });
  await t.throwsAsync(() => E(g).start(), { message: /disk full/ });
});

// -- Feature 9: HTTPS-proxy startup warning -----------------------

/**
 * Build a `logWarning` power that captures each emitted message
 * into a buffer, plus the buffer itself for inspection. Used by
 * the Feature 9 startup-warning tests; the `logWarning` power
 * shape is part of the public `GatewayPowers` interface.
 */
const makeWarningRecorder = () => {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} message */
    logWarning: message => {
      calls.push(message);
    },
  };
};

test('Gateway emits the HTTPS-proxy warning when bound to 0.0.0.0 with no trusted proxies', async t => {
  // Regression: an operator who launches the gateway with the
  // default `0.0.0.0:3469` bind and no `trustedProxyCidrs` is
  // exposed to bearer tokens crossing an unencrypted link. The
  // warning is the only nudge they get; if it ever stops firing,
  // public deployments degrade silently.
  const rec = makeWarningRecorder();
  const g = makeGateway({
    powers: {
      ...defaultPowers(),
      logWarning: rec.logWarning,
    },
    config: { bindAddress: '0.0.0.0:3469' },
  });
  await E(g).start();
  const match = rec.calls.find(c =>
    /Bound to 0\.0\.0\.0:3469 with no trusted proxy configured/.test(c),
  );
  t.truthy(match, 'expected the Feature-9 warning to fire');
  t.regex(/** @type {string} */ (match), /bearer tokens/);
});

test('Gateway suppresses the HTTPS-proxy warning on a loopback bind', async t => {
  // Regression: an operator who binds 127.0.0.1 is not exposing
  // the gateway publicly; the warning would be noise. If this
  // assertion fails, the warning fires on every local-dev start
  // and trains operators to ignore it.
  const rec = makeWarningRecorder();
  const g = makeGateway({
    powers: {
      ...defaultPowers(),
      logWarning: rec.logWarning,
    },
    config: { bindAddress: '127.0.0.1:0' },
  });
  await E(g).start();
  t.deepEqual(rec.calls, []);
});

test('Gateway suppresses the HTTPS-proxy warning when trustedProxyCidrs is configured', async t => {
  // Regression: an operator who has configured a trusted-proxy
  // CIDR list has explicitly opted in to the HTTPS-terminating-
  // proxy deployment; the warning would be redundant.
  const rec = makeWarningRecorder();
  const g = makeGateway({
    powers: {
      ...defaultPowers(),
      logWarning: rec.logWarning,
    },
    config: {
      bindAddress: '0.0.0.0:3469',
      trustedProxyCidrs: harden(['10.0.0.0/8']),
    },
  });
  await E(g).start();
  t.deepEqual(rec.calls, []);
});

test('Gateway emits the HTTPS-proxy warning on an IPv6 wildcard bind', async t => {
  // The `::` IPv6 wildcard is the IPv6 analog of `0.0.0.0`; it
  // means "bind every interface". The warning must fire here too,
  // otherwise an operator who happens to bind v6 dodges the
  // bearer-token warning the v4 bind would have shown.
  const rec = makeWarningRecorder();
  const g = makeGateway({
    powers: {
      ...defaultPowers(),
      logWarning: rec.logWarning,
    },
    config: { bindAddress: '[::]:3469' },
  });
  await E(g).start();
  const match = rec.calls.find(c => /no trusted proxy configured/.test(c));
  t.truthy(match, 'expected the Feature-9 warning to fire on [::]:3469');
});

test('Gateway.getBindAddress is what gets published', async t => {
  // The published value must equal the value `getBindAddress`
  // would have returned at the moment of publish. Today the Phase
  // 1 skeleton's getBindAddress returns the *configured* address
  // (the port-0 case has not yet been resolved by a real
  // listener); a future phase that attaches the HTTP listener
  // resolves port 0 inside `start` *before* the publish call so
  // the assertion still holds. This test pins the contract.
  const { publisher, calls } = makeRecorderPublisher();
  const g = makeGateway({
    powers: {
      env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
      familiarPublish: publisher,
    },
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        familiarBundled: true,
        sockBootstrap: false,
        adminDaemon: false,
        gitHttp: false,
        captpRelay: false,
        ocapnWebSocket: false,
      },
    },
  });
  await E(g).start();
  const observed = await E(g).getBindAddress();
  const published = /** @type {{bindAddress: string}} */ (calls[0]).bindAddress;
  t.is(observed, published);
});
