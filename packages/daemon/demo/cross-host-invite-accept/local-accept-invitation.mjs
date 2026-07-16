// @ts-check
/* global process, console */

// The LOCAL half of a true cross-host Pet-Daemon ↔ Pet-Daemon pairing.
//
// Boots a full Endo Pet Daemon in THIS host (the garden container) with the
// `@nets/ocapn` OCapN-Noise network installed — the same network module the
// minion.town daemon runs — then accepts an invitation minted by the
// minion.town Pet Daemon and invokes a capability it published, across a
// single `wss://minion.town/ocapn-daemon` + Noise IK session.
//
// The minion daemon advertises a loopback `ws:url` hint (it binds
// 127.0.0.1:8930 inside its container, reachable from the world only through
// Caddy TLS on 443). The Noise handshake authenticates the location
// *designator* (the daemon's session public key), NOT the transport URL, so we
// rewrite just the `ws:url` transport hint in every advertised connection hint
// to the public endpoint before accepting. This is the same public-endpoint
// rewrite the bootstrap demo client carries.
//
// Because the container has no public address, the pairing is necessarily
// one-directional at the transport layer: the LOCAL daemon dials OUT to minion
// (reachable) — so minion is the inviter and publisher, local is the acceptor
// and caller. The CapTP session that local opens is bidirectional once
// established, which is what lets the invitation complete and the capability
// result flow back.
//
// Usage (from packages/daemon):
//   WS_URL_OVERRIDE=wss://minion.town/ocapn-daemon \
//   INVITATION='<locator>' ADDER='<locator>' \
//   node demo/cross-host-invite-accept/local-accept-invitation.mjs

import '@endo/init/debug.js';

import os from 'os';
import url from 'url';
import path from 'path';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '../../index.js';

const dirname = url.fileURLToPath(new URL('../..', import.meta.url)).toString();

const wsOverride =
  process.env.WS_URL_OVERRIDE || 'wss://minion.town/ocapn-daemon';
const invitationLocator = process.env.INVITATION;
const adderLocator = process.env.ADDER;

const log = (...args) => console.log('local:', ...args);

if (!invitationLocator) {
  console.error('set INVITATION=<locator minted on minion.town>');
  process.exit(2);
}

/**
 * Rewrite the `ws:url` transport hint in every connection-hint address of
 * an `endo://` locator to the public wss endpoint, preserving the Noise
 * designator (the identity the handshake actually authenticates).
 *
 * The locator carries hints as `@`-delimited, URL-encoded path components
 * after the formula address: `endo://{node}/{address}@{hint1}@{hint2}?…`.
 *
 * @param {string} locator
 * @param {string} override
 */
const rewritePublicWsUrl = (locator, override) => {
  const u = new URL(locator);
  const [address, ...hints] = u.pathname
    .replace(/^\//, '')
    .split('@')
    .map(decodeURIComponent);
  const rewritten = hints.map(at => {
    const a = new URL(at);
    const locParam = a.searchParams.get('loc');
    if (locParam) {
      const loc = JSON.parse(locParam);
      if (loc.hints && loc.hints['ws:url']) {
        loc.hints = { ...loc.hints, 'ws:url': override };
      }
      a.searchParams.set('loc', JSON.stringify(loc));
    }
    return a.href;
  });
  u.pathname = `/${[address, ...rewritten].map(encodeURIComponent).join('@')}`;
  return u.href;
};

const makeConfig = label => {
  const root = ['tmp', 'demo-cross-host', `${label}-${process.pid}`];
  const tag = `${label}-${process.pid}`.slice(-40);
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    sockPath: path.join(os.tmpdir(), `endo-xhost-${tag}.sock`),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const main = async () => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const config = makeConfig('local');
  try {
    log(`booting local Pet Daemon (state=${config.statePath})`);
    await purge(config);
    await start(config);
    const { getBootstrap } = await makeEndoClient(
      'xhost-local',
      config.sockPath,
      cancelled,
    );
    const host = E(getBootstrap()).host();

    // Install @nets/ocapn with a WS listener — the WS transport is what dials
    // minion. An ephemeral loopback bind is fine; local never needs to be
    // dialed back (minion can't reach the container anyway).
    log('installing @nets/ocapn (WS transport) ...');
    await E(host).storeValue('127.0.0.1:0', 'ws-listen-addr');
    const modulePath = path.join(dirname, 'src/networks/ocapn.js');
    await E(host).makeUnconfined('@main', url.pathToFileURL(modulePath).href, {
      powersName: '@agent',
      resultName: 'ocapn-network',
    });
    await E(host).move(['ocapn-network'], ['@nets', 'ocapn']);
    log('✓ @nets/ocapn installed locally');

    const rewrittenInvitation = rewritePublicWsUrl(
      invitationLocator,
      wsOverride,
    );
    log(`accepting minion.town invitation over ${wsOverride} ...`);
    log(`   designator-preserving rewrite applied to ws:url hint`);
    const acceptResult = await E(host).accept(rewrittenInvitation, 'minion');
    log(`✓ accept() resolved: ${JSON.stringify(acceptResult)}`);
    log(`✓ paired with minion.town Pet Daemon`);

    // Prove the invitation actually landed a durable guest under the pet name
    // we chose — the invite/accept workflow registered a real named peer, not
    // just an ephemeral dial.
    const namesAfterAccept = await E(host).list();
    log(`local pet names after accept: ${JSON.stringify(namesAfterAccept)}`);
    if (!namesAfterAccept.includes('minion')) {
      throw new Error('expected pet name "minion" after accepting invitation');
    }
    log('✓ invitation bound the minion.town peer under pet name "minion"');

    if (adderLocator) {
      const rewrittenAdder = rewritePublicWsUrl(adderLocator, wsOverride);
      log('adopting minion-published capability "adder" by locator ...');
      await E(host).storeLocator(['xadder'], rewrittenAdder);
      log('invoking E(adder).add(2, 3) across the wss+Noise edge ...');
      const sum = await E(host).evaluate(
        '@main',
        'E(adder).add(2, 3)',
        ['adder'],
        ['xadder'],
      );
      log(`← remote result: 2 + 3 = ${sum}`);
      if (sum !== 5) {
        throw new Error(`expected 5, got ${sum}`);
      }
      const greeting = await E(host).evaluate(
        '@main',
        'E(adder).greet("local Pet Daemon in the garden container")',
        ['adder'],
        ['xadder'],
      );
      log(`← remote greeting: ${JSON.stringify(greeting)}`);
      log('✓ capability round-trip across the cross-host Noise session');
    }

    log('CROSS-HOST DEMO PASSED');
  } finally {
    await stop(config).catch(() => {});
    cancel(new Error('demo complete'));
  }
};

main().then(
  () => process.exit(0),
  err => {
    console.error('local: FAILED', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
