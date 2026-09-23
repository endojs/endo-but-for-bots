// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import os from 'os';
import url from 'url';
import path from 'path';
import crypto from 'crypto';
import baseTest from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';
import { start, stop, restart, purge, makeEndoClient } from '../index.js';
import {
  formatLocator,
  formatLocatorWithHints,
  idFromLocator,
  parseLocator,
} from '../src/locator.js';

// Guest-locator adoption across two real daemons over the OCapN-Noise
// network (`designs/daemon-locator-reference.md`, Minion Town guest
// federation integration plan, stage 1). Daemon A hosts a guest and
// shares its `endo://` locator; daemon B adopts it with
// `adoptFromLocator`, uses the remote guest, and re-acquires it after a
// restart of B. The negative cases check that a bad locator never
// leaves a pet name behind that only *looks* like a successful adoption.

// Like the multiplayer suite, these tests load the network module with
// makeUnconfined, a Node-only path.
const skipNoNodeWorker =
  process.env.ENDO_BIN && !process.env.ENDO_NODE_WORKER_BIN;
const test = skipNoNodeWorker
  ? Object.assign(baseTest.skip, {
      serial: baseTest.serial.skip,
      beforeEach: baseTest.beforeEach,
      afterEach: baseTest.afterEach,
    })
  : baseTest;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

let configCounter = 0;

/** @param {string} title */
const makeConfig = title => {
  const tag = `${title
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .slice(0, 24)}-${process.pid}-${configCounter}`;
  configCounter += 1;
  const root = path.join(dirname, 'tmp', `adopt-${tag}`);
  return {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? String.raw`\\?\pipe\endo-adopt-${tag}.sock`
        : path.join(os.tmpdir(), `endo-adopt-${tag}.sock`),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    gcEnabled: true,
  };
};

/**
 * @param {ReturnType<typeof makeConfig>} config
 * @param {Promise<never>} cancelled
 */
const connectHost = async (config, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  return E(getBootstrap()).host();
};

/** @param {any} t */
const prepareDaemon = async t => {
  const { reject: cancel, promise } = makePromiseKit();
  const cancelled = /** @type {Promise<never>} */ (promise);
  cancelled.catch(() => {});
  const config = makeConfig(t.title);
  t.context.push({ config, cancel });
  await purge(config);
  await start(config);
  const host = await connectHost(config, cancelled);
  await E(host).storeValue('127.0.0.1:0', 'ocapn-listen-addr');
  const serviceLocation = url.pathToFileURL(
    path.join(dirname, 'src/networks/ocapn.js'),
  ).href;
  await E(host).makeUnconfined('@main', serviceLocation, {
    powersName: '@agent',
    resultName: 'test-network',
  });
  await E(host).move(['test-network'], ['@nets', 'ocapn']);
  return { host, config, cancelled };
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  const configs = /** @type {any[]} */ (t.context);
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel } of configs) {
    cancel(Error('teardown'));
  }
});

const randomNode = () => crypto.randomBytes(32).toString('hex');

/**
 * Daemon A provisions a guest (standing in for a Minion Town account
 * guest), writes a value into the guest's own store, and returns the
 * guest agent's shareable locator.
 *
 * @param {any} hostA
 */
const provisionGuest = async hostA => {
  await E(hostA).provideGuest('alice-handle', { agentName: 'alice' });
  const guest = await E(hostA).lookup('alice');
  await E(guest).storeValue('hello from A', 'greeting');
  const locator = /** @type {string} */ (await E(hostA).locate('alice'));
  return { guest, locator };
};

test.serial(
  'adopts a remote guest by locator, uses it, and re-acquires it after restart',
  async t => {
    const { host: hostA } = await prepareDaemon(t);
    const {
      host: hostB,
      config: configB,
      cancelled: cancelledB,
    } = await prepareDaemon(t);

    const { guest: guestA, locator } = await provisionGuest(hostA);
    const { formulaType, hints } = parseLocator(locator);
    t.is(formulaType, 'guest');
    t.true(hints.length > 0, 'the shared locator carries connection hints');

    // An unsupported hint ahead of the real one does not prevent
    // adoption over the supported candidate.
    const withUnknownHint = formatLocatorWithHints(
      idFromLocator(locator),
      formulaType,
      ['unknown+transport://127.0.0.1:1/', ...hints],
    );
    await E(hostB).adoptFromLocator(withUnknownHint, 'remote-alice');

    // A real method call through the imported guest, both directions.
    const remoteGuest = await E(hostB).lookup('remote-alice');
    t.is(await E(remoteGuest).lookup('greeting'), 'hello from A');
    await E(remoteGuest).storeValue('hello from B', 'reply');
    t.is(await E(guestA).lookup('reply'), 'hello from B');

    // A locator for the same node whose hint names a different peer key
    // does not redirect the peer B already knows: B keeps its
    // authenticated route, which still provides the genuine value.
    await E(hostB).adoptFromLocator(
      formatLocatorWithHints(
        idFromLocator(locator),
        formulaType,
        hints.map(hint => {
          const hintUrl = new URL(hint);
          hintUrl.searchParams.set('node', randomNode());
          return hintUrl.href;
        }),
      ),
      'retargeted',
    );
    t.is(
      await E(E(hostB).lookup('retargeted')).lookup('greeting'),
      'hello from A',
    );

    // The adoption is durable: after B restarts, the pet name still
    // resolves and the remote guest is re-acquired over a fresh session.
    await restart(configB);
    const hostB2 = await connectHost(configB, cancelledB);
    t.true((await E(hostB2).list()).includes('remote-alice'));
    const reacquired = await E(hostB2).lookup('remote-alice');
    t.is(await E(reacquired).lookup('greeting'), 'hello from A');
    t.is(await E(reacquired).lookup('reply'), 'hello from B');
    t.is(
      await E(E(hostB2).lookup('retargeted')).lookup('greeting'),
      'hello from A',
      'the known route survived the retargeted locator',
    );

    // What this does NOT establish: A retaining the guest on B's behalf.
    // A never learns B's retention set, because B holds no agent on A
    // (an anonymous bearer holder, unlike an invitation peer), so A's own
    // names are what keep the guest alive. A Minion Town account store
    // retains its guests independently.
  },
);

test.serial(
  'a locator that cannot be adopted leaves no pet name behind',
  async t => {
    const { host: hostA } = await prepareDaemon(t);
    const { host: hostB } = await prepareDaemon(t);
    const { locator } = await provisionGuest(hostA);
    const { formulaType, hints, number, node } = parseLocator(locator);
    const id = idFromLocator(locator);

    const cases = [
      {
        label: 'malformed locator',
        locator: 'endo://not-a-node/also-not-a-number?type=guest',
        message: /Invalid locator/,
      },
      {
        label: 'remote locator without hints',
        locator: formatLocator(id, formulaType),
        message: /without connection hints/,
      },
      {
        label: 'no mutually supported route',
        locator: formatLocatorWithHints(id, formulaType, [
          'unknown+transport://127.0.0.1:1/',
          'not a url',
        ]),
        message: /No mutually supported route/,
      },
      {
        label: 'hint names a different peer key',
        locator: formatLocatorWithHints(
          id,
          formulaType,
          hints.map(hint => {
            const hintUrl = new URL(hint);
            hintUrl.searchParams.set('node', randomNode());
            return hintUrl.href;
          }),
        ),
        message: /identity mismatch/,
      },
      {
        label: 'formula the peer does not host',
        locator: formatLocatorWithHints(
          `${randomNode()}:${node}`,
          formulaType,
          hints,
        ),
        message: /did not provide/,
      },
      {
        label: 'formula for a node the peer does not hold',
        locator: formatLocatorWithHints(
          `${number}:${randomNode()}`,
          formulaType,
          hints,
        ),
        message: /did not provide/,
      },
    ];
    for (const [index, { label, locator: bad, message }] of cases.entries()) {
      const name = `bad-${index}`;
      // eslint-disable-next-line no-await-in-loop
      const error = await t.throwsAsync(
        () => E(hostB).adoptFromLocator(bad, name),
        { message },
        label,
      );
      const { number: badNumber } = (() => {
        try {
          return parseLocator(bad);
        } catch {
          return { number: 'also-not-a-number' };
        }
      })();
      t.false(
        error.message.includes(badNumber),
        `${label}: the error does not echo the bearer formula number`,
      );
      // eslint-disable-next-line no-await-in-loop
      t.false((await E(hostB).list()).includes(name), `${label}: not stored`);
    }
  },
);

test.serial(
  'the daemon OCapN endpoint redeems a guest formula by direct fetch and still serves the peer entry',
  async t => {
    const { host: hostA } = await prepareDaemon(t);
    const { guest: guestA, locator } = await provisionGuest(hostA);
    const [hint] = parseLocator(locator).hints;
    const location = JSON.parse(
      /** @type {string} */ (new URL(hint).searchParams.get('loc')),
    );

    // A plain OCapN client, not an Endo daemon: it runs no greeter
    // handshake and presents the bearer formula identifier as the
    // swissnum of `bootstrap.fetch`.
    const network = makeOcapnNoiseNetwork({ codec: cborCodec });
    network.addSigningKeys(network.generateSigningKeys());
    await network.addTransport(
      makeTcpTransport({ host: '127.0.0.1', port: 0 }),
    );
    const client = await makeOcapn({
      codec: cborCodec,
      network: /** @type {any} */ (network),
      locator: new Map(),
      debugLabel: 'direct-fetch-client',
    });
    t.teardown(() => client.shutdown());

    const fetchSecret = secret =>
      client.enlivenSturdyRef(client.makeSturdyRef(location, secret));

    // The same guest the account host provisioned, not a copy.
    const fetched = await fetchSecret(idFromLocator(locator));
    t.is(await E(fetched).lookup('greeting'), 'hello from A');
    await E(fetched).storeValue('direct', 'via-fetch');
    t.is(await E(guestA).lookup('via-fetch'), 'direct');

    // Misses are uniform and do not disturb a session below its bound.
    for (const secret of [
      `${randomNode()}:${randomNode()}`,
      'not-a-formula-identifier',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => fetchSecret(secret));
    }
    t.is(await E(fetched).lookup('greeting'), 'hello from A');

    // The well-known peer entry is composed ahead of the formula
    // locator, so existing peer traffic keeps working.
    const entry = await fetchSecret('endo-peer-entry');
    t.is(typeof (await E(entry).getNodeId()), 'string');
  },
);
