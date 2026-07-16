// @ts-check
/* global process, console */

// A live, standalone demonstration of TWO Pet Daemons pairing through the
// invite/accept workflow over OCapN-Noise (Noise IK + CBOR) on the
// TCP transport, followed by a real capability round-trip.
//
// This is the forked-two-daemon shape the `_multiplayer-suite.js` test
// exercises, rendered as a self-contained runnable so the pairing and the
// remote method call can be watched end to end. Each `start()` spawns an
// independent daemon OS process; the only installed network is
// `@nets/ocapn`, so the invitation's connection hints necessarily
// advertise `ocapn+noise+tcp` and the accepting daemon dials back through
// that netlayer.
//
// Run from packages/daemon:  node demo/two-daemon-invite-accept/run.mjs
//
// To demonstrate the WebSocket transport instead, set OCAPN_WS=1 — the
// same Noise+CBOR session layer runs, only the byte stream underneath
// changes (`ocapn+noise+ws`).

import '@endo/init/debug.js';

import os from 'os';
import url from 'url';
import path from 'path';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '../../index.js';
import { parseLocator } from '../../src/locator.js';

const dirname = url.fileURLToPath(new URL('../..', import.meta.url)).toString();

const useWs = Boolean(process.env.OCAPN_WS);
const listenAddrName = useWs ? 'ws-listen-addr' : 'ocapn-listen-addr';
const expectedProtocol = useWs ? 'ocapn+noise+ws' : 'ocapn+noise+tcp';

const log = (...args) => console.log('demo:', ...args);

/** @param {string} label */
const makeConfig = label => {
  const root = ['tmp', 'demo-two-daemon', `${label}-${process.pid}`];
  const tag = `${label}-${process.pid}`.slice(-40);
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    // Keep the unix socket path within the ~108-char limit.
    sockPath: path.join(os.tmpdir(), `endo-demo-${tag}.sock`),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * Boot a daemon, connect a client, install the OCapN-Noise network at
 * `@nets/ocapn`, and return the host facet.
 *
 * @param {string} label
 * @param {Promise<never>} cancelled
 */
const bootDaemon = async (label, cancelled) => {
  const config = makeConfig(label);
  await purge(config);
  await start(config);
  const { getBootstrap } = await makeEndoClient(
    `demo-${label}`,
    config.sockPath,
    cancelled,
  );
  const host = E(getBootstrap()).host();

  // Ask the daemon to bind an OCapN-Noise listener, then install the
  // network module at `@nets/ocapn` — the only network this daemon
  // knows, so every advertised hint is an ocapn+noise hint.
  await E(host).storeValue('127.0.0.1:0', listenAddrName);
  const modulePath = path.join(dirname, 'src/networks/ocapn.js');
  await E(host).makeUnconfined('@main', url.pathToFileURL(modulePath).href, {
    powersName: '@agent',
    resultName: 'ocapn-network',
  });
  await E(host).move(['ocapn-network'], ['@nets', 'ocapn']);

  return { host, config };
};

const main = async () => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const configs = [];
  try {
    log(`transport = ${expectedProtocol}`);
    log('booting daemon A (inviter) ...');
    const { host: hostA, config: configA } = await bootDaemon('a', cancelled);
    configs.push(configA);
    log('booting daemon B (acceptor) ...');
    const { host: hostB, config: configB } = await bootDaemon('b', cancelled);
    configs.push(configB);

    // ── invite / accept ─────────────────────────────────────────────
    log('A: invite("bob") — creating a durable invitation');
    const invitation = await E(hostA).invite('bob');
    const invitationLocator = await E(invitation).locate();
    log('A: invitation locator =');
    log(`   ${invitationLocator}`);

    const { hints } = parseLocator(invitationLocator);
    log(`A: invitation advertises ${hints.length} connection hint(s):`);
    for (const hint of hints) {
      log(`   ${hint}`);
    }
    const advertises = hints.some(
      h => new URL(h).protocol.replace(/:$/, '') === expectedProtocol,
    );
    if (!advertises) {
      throw new Error(
        `expected an ${expectedProtocol} hint, got ${JSON.stringify(hints)}`,
      );
    }
    log(
      `A: ✓ hints advertise ${expectedProtocol} — pairing will route via @nets/ocapn`,
    );

    log('B: accept(<locator>, "alice") — completing the pairing');
    await E(hostB).accept(invitationLocator, 'alice');
    log("B: ✓ accepted; both daemons now hold each other's peer info");

    // ── capability round-trip ───────────────────────────────────────
    log('A: publish Far("Adder", { add }) as pet name "adder"');
    await E(hostA).evaluate(
      '@main',
      'Far("Adder", { add: (a, b) => a + b })',
      [],
      [],
      ['adder'],
    );
    const adderLocator = await E(hostA).locate('adder');
    log("B: adopt A's adder by locator and invoke E(adder).add(2, 3)");
    await E(hostB).storeLocator(['adder'], adderLocator);
    const sum = await E(hostB).evaluate(
      '@main',
      'E(adder).add(2, 3)',
      ['adder'],
      ['adder'],
    );
    log(`B: ← remote result = ${sum}`);
    if (sum !== 5) {
      throw new Error(`expected 5, got ${sum}`);
    }
    log('B: ✓ capability round-trip computed 2 + 3 = 5 over the Noise session');

    // Reference identity round-trip (pass-by-reference, not by-copy).
    log('A: publish Far("Echoer", { echo }) as pet name "echoer"');
    await E(hostA).evaluate(
      '@main',
      'Far("Echoer", { echo: value => value })',
      [],
      [],
      ['echoer'],
    );
    const echoerLocator = await E(hostA).locate('echoer');
    await E(hostB).storeLocator(['echoer'], echoerLocator);
    log('B: send a fresh Far token through E(echoer).echo and check identity');
    const survived = await E(hostB).evaluate(
      '@main',
      `
        const token = Far('Token', {});
        E(echoer).echo(token).then(alleged => token === alleged);
      `,
      ['echoer'],
      ['echoer'],
    );
    if (!survived) {
      throw new Error('Far identity did not survive the round-trip');
    }
    log('B: ✓ Far reference identity preserved across the netlayer');

    log('DEMO PASSED');
  } finally {
    await Promise.allSettled(configs.map(config => stop(config)));
    cancel(new Error('demo complete'));
  }
};

main().then(
  () => process.exit(0),
  err => {
    console.error('demo: FAILED', err);
    process.exit(1);
  },
);
