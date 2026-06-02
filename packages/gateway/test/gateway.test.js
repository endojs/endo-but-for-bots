// @ts-check

import '@endo/init/debug.js';

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

test('Gateway getBootstrap returns the bootstrap exo when udsBootstrap is on', async t => {
  const g = gateway();
  const bootstrap = await E(g).getBootstrap();
  t.truthy(bootstrap);
  // Smoke-test the exo: it must expose `challenge` and round-trip a
  // registration.
  const issued = await E(bootstrap).challenge();
  t.is(issued.nonce.byteLength, 32);
  t.is(issued.hashedNonce.byteLength, 32);
});

test('Gateway getBootstrap throws when udsBootstrap is off', async t => {
  // Regression: the accessor must be a hard error rather than a
  // silent no-op when the feature is disabled, so a misconfigured
  // embedder fails loudly.
  const g = gateway({
    config: {
      enableFeatures: {
        ...defaultFeatureToggles,
        udsBootstrap: false,
        adminDaemon: false,
        captpRelay: false,
      },
    },
  });
  await t.throwsAsync(() => E(g).getBootstrap(), {
    message: /Gateway bootstrap is disabled/,
  });
});

test('makeGateway throws when udsBootstrap is on but crypto is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: /** @type {any} */ ({
          clock: makeFakeClock(),
        }),
      }),
    { message: /udsBootstrap requires powers.crypto/ },
  );
});

test('makeGateway throws when udsBootstrap is on but clock is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: /** @type {any} */ ({
          crypto: makeNodeCryptoPowers(),
        }),
      }),
    { message: /udsBootstrap requires powers.clock/ },
  );
});

test('bootstrap.getApps returns the same hub as gateway.getApps', async t => {
  // The bootstrap shares the gateway's apps NameHub so a binding
  // installed over UDS is visible to the HTTP routing path. If a
  // refactor accidentally creates a second hub for the bootstrap,
  // the gateway routes traffic to bindings that no UDS client can
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
