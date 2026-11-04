// @ts-check
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, makeEndoClient } from '@endo/daemon';

import { makeBrowserEndo } from '../src/index.js';
import { startRelay } from './helpers.js';

test.serial(
  'ephemeral browser reloads do not accumulate daemon retention records',
  async t => {
    t.timeout(45_000);
    const options = await startRelay(t);
    const root = await mkdtemp(join(tmpdir(), 'bendo-retention-'));
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
      'browser-retention-test',
      config.sockPath,
      lifetime.promise,
    );
    const host = E(client.getBootstrap()).host();
    await E(host).makeUnconfined(
      '@main',
      new URL('../../daemon/src/networks/ws-relay.js', import.meta.url).href,
      {
        powersName: '@agent',
        resultName: 'test-network',
        env: {
          WS_RELAY_URL: options.relay,
          WS_RELAY_DOMAIN: options.relayDomain,
        },
      },
    );
    await E(host).move(['test-network'], ['@nets', 'ws-relay']);
    await E(host).makeUnconfined(
      '@main',
      new URL('../../daemon/test/retention-count-fixture.js', import.meta.url)
        .href,
      {
        powersName: '@agent',
        resultName: 'retention-count',
        env: { DATABASE_PATH: join(config.statePath, 'endo.sqlite') },
      },
    );
    const probe = /** @type {any} */ (E(host).lookup('retention-count'));
    const baseline = await E(probe).count();
    const locator = await E(host).locate('@agent');
    if (!locator) throw new Error('Missing agent locator');
    const identities = new Set();
    for (let reload = 0; reload < 3; reload += 1) {
      const browser = makeBrowserEndo(options);
      t.teardown(browser.close);
      const imported = /** @type {any} */ (await browser.import(locator));
      identities.add(browser.getNodeId());
      await E(imported).getPeerInfo();
      const remoteProbe = await E(imported).lookup('retention-count');
      // This second round trip also lets the daemon process the initial peer
      // retention snapshot before we disconnect the tab.
      await E(remoteProbe).count();
      browser.close();
      await browser.closed;
    }
    t.is(identities.size, 3, 'every reload creates a distinct ephemeral peer');
    t.is(await E(probe).count(), baseline);
  },
);
