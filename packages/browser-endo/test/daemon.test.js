// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { parseLocator } from '@endo/daemon/locator.js';
import { start, stop, makeEndoClient } from '@endo/daemon';
import { makeBrowserEndo } from '../src/index.js';
import { startRelay } from './helpers.js';

// Real daemon storage/import plus browser peer, rather than two copies of a
// test-only protocol implementation agreeing with one another.
test.serial(
  'browser imports daemon counter and daemon imports browser object through existing peer setup',
  async t => {
    t.timeout(45_000);
    const options = await startRelay(t);
    const root = await mkdtemp(join(tmpdir(), 'bendo-'));
    const config = {
      statePath: join(root, 'state'),
      ephemeralStatePath: join(root, 'run'),
      cachePath: join(root, 'cache'),
      sockPath: join(root, 'endo.sock'),
      address: '127.0.0.1:0',
    };
    const lifetime = makePromiseKit();
    lifetime.promise.catch(() => {});
    t.teardown(async () => {
      await stop(config);
      lifetime.reject(new Error('Test finished'));
      await rm(root, { recursive: true, force: true });
    });
    await start(config);
    const client = await makeEndoClient(
      'browser-test',
      config.sockPath,
      lifetime.promise,
    );
    const host = E(client.getBootstrap()).host();
    await E(host).makeUnconfined(
      '@main',
      new URL('../../daemon/src/networks/ws-relay.js', import.meta.url).href,
      {
        powersName: '@agent',
        resultName: 'browser-test-network',
        env: {
          WS_RELAY_URL: options.relay,
          WS_RELAY_DOMAIN: options.relayDomain,
        },
      },
    );
    await E(host).move(['browser-test-network'], ['@nets', 'ws-relay']);
    await E(host).makeUnconfined(
      '@main',
      new URL('../src/counter.js', import.meta.url).href,
      { powersName: '@agent', resultName: 'counter' },
    );
    const locator = await E(host).locate('counter');
    if (!locator) throw new Error('Counter locator missing');
    const browser = makeBrowserEndo(options);
    t.teardown(browser.close);
    // Agent formula identity and relay transport identity are distinct.
    const agentLocator = await E(host).locate('@agent');
    if (!agentLocator) throw new Error('Agent locator missing');
    const info = await E(host).getPeerInfo();
    t.not(parseLocator(agentLocator).node, info.node);
    const browserHost = /** @type {any} */ (await browser.import(agentLocator));
    t.deepEqual(await E(browserHost).getPeerInfo(), info);
    const counter = await browser.import(locator);
    t.deepEqual(await E(counter).snapshot(), { value: 0n, revision: 0n });
    await E(await E(counter).makeIncrementer()).increment(1n);
    const daemonCounter = /** @type {any} */ (E(host).lookup('counter'));
    t.deepEqual(await E(daemonCounter).snapshot(), { value: 1n, revision: 1n });
    const localLocator = await browser.export(
      Far('Browser Echo', { echo: value => value }),
    );
    await E(host).adoptFromLocator(localLocator, ['browser-echo']);
    const echo = /** @type {any} */ (E(host).lookup('browser-echo'));
    t.is(await E(echo).echo('browser peer'), 'browser peer');
    const disconnected = browser.whenDisconnected(agentLocator);
    await stop(config);
    await disconnected;
    t.pass('Agent alias observes its transport disconnect');
  },
);
