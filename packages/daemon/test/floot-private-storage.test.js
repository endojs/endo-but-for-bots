// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeEndoClient, start, stop } from '../index.js';

test.serial(
  'private journal storage stays bounded, survives restart, and collects without killing its worker or siblings',
  async t => {
    t.timeout(60_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-ps-'),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: true,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'private-storage-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    let probe = await E(host).makeUnconfined(
      '@node',
      new URL('./_floot-private-storage.js', import.meta.url).href,
      { powersName: '@agent', resultName: 'private-storage-probe' },
    );
    const before = await E(host).list();
    await E(probe).seed('one', 512);
    await E(probe).seed('two', 2);
    t.deepEqual(
      (await E(host).list()).filter(name => !before.includes(name)),
      ['floot-private-sessions'],
    );
    t.is((await E(host).list('floot-private-sessions', 'one')).length, 514);
    t.deepEqual(await E(probe).read('one'), {
      count: 512,
      value: { event: 511 },
    });
    // Discard all incarnations: only directory-backed records can restore these.
    await stop(config);
    await start(config);
    host = await connect();
    probe = await E(host).lookup('private-storage-probe');
    t.deepEqual(await E(probe).read('one'), {
      count: 512,
      value: { event: 511 },
    });
    const directoryId = await E(host).identify('floot-private-sessions', 'one');
    const recordId = await E(host).identify(
      'floot-private-sessions',
      'one',
      'floot-turn-event-00000000000000000511',
    );
    const diagnostics = await E(host).diagnostics();
    await E(probe).retire('one');
    await E(probe).retire('one');
    await t.throwsAsync(E(diagnostics).getFormula(directoryId), {
      message: /unknown identifier|collect|not found/i,
    });
    await t.throwsAsync(E(diagnostics).getFormula(recordId), {
      message: /unknown identifier|collect|not found/i,
    });
    t.is(await E(probe).ping(), 'alive');
    t.deepEqual(await E(probe).read('two'), { count: 2, value: { event: 1 } });
    t.false(await E(host).has('floot-private-sessions', 'one'));
    await E(probe).retire('two');
    for (let index = 0; index < 8; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await E(probe).seed(`cycle-${index}`, 2);
      // eslint-disable-next-line no-await-in-loop
      await E(probe).retire(`cycle-${index}`);
    }
    t.deepEqual(await E(host).list('floot-private-sessions'), []);
    t.deepEqual(
      (await E(host).list()).filter(name => !before.includes(name)),
      ['floot-private-sessions'],
    );
    await stop(config);
    await start(config);
    host = await connect();
    probe = await E(host).lookup('private-storage-probe');
    t.is(await E(probe).ping(), 'alive');
    t.deepEqual(await E(host).list('floot-private-sessions'), []);
  },
);
