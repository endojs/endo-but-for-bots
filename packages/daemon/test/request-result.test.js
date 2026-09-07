// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makePromiseKit } from '@endo/promise-kit';

import { start, stop, makeEndoClient } from '../index.js';

test.serial(
  'request result edge follows an unanswered request across restart',
  async t => {
    // Keep Unix socket paths short even in a deeply nested worktree.
    const root = await mkdtemp(join(tmpdir(), 'endo-result-'));
    const config = {
      statePath: join(root, 'state'),
      ephemeralStatePath: join(root, 'run'),
      cachePath: join(root, 'cache'),
      sockPath: join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      gcEnabled: true,
    };
    const { promise: cancelled, reject: cancel } = makePromiseKit();
    cancelled.catch(() => {});
    const connect = async () => {
      const client = await makeEndoClient(
        'result-test',
        config.sockPath,
        cancelled,
      );
      client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    t.teardown(async () => {
      cancel(Error('test complete'));
      await stop(config);
      await rm(root, { recursive: true, force: true });
    });
    await start(config);
    const host = await connect();
    await E(host).storeValue(10, 'ten');
    const guest = await E(host).provideGuest('guest', {
      agentName: 'guest-powers',
    });
    const messages = iterateReader(E(guest).followMessages());
    E.sendOnly(guest).request('@host', 'need a number');
    await messages.next();
    await stop(config);
    await start(config);
    const recovered = await connect();
    const request = (await E(recovered).listMessages()).find(
      m => m.type === 'request',
    );
    t.truthy(request);
    const resultP = E(recovered).lookup([
      '@mail',
      String(request.number),
      '@result',
    ]);
    resultP.catch(() => {});
    await E(recovered).resolve(request.number, 'ten');
    t.is(await resultP, 10);
  },
);
