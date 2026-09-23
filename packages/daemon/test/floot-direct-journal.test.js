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
  'direct-provider ordered journal survives two cold daemon starts',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-dj-'),
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
        'direct-journal-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    await E(host).storeValue(
      harden({ version: 1, sessionId: 'direct-journal' }),
      'floot-private-turn-14-direct-journal-schema',
    );
    await E(host).provideWorker('direct-journal-worker');
    let agent = await E(host).makeUnconfined(
      'direct-journal-worker',
      new URL('./_floot-direct-journal.js', import.meta.url).href,
      {
        powersName: '@agent',
        resultName: 'direct-journal-agent',
      },
    );
    await t.throwsAsync(E(agent).seed(), {
      message: /Injected provider disconnect/,
    });
    const seeded = await E(agent).inspect();
    const expectedText = `${'Long dialogue '.repeat(800)}PRESERVE-TAIL`;
    t.is(seeded.calls, 2);
    t.is(seeded.turns.length, 1);
    t.is(seeded.turns[0].state, 'failed');
    t.true(
      seeded.turns[0].transcript.some(entry => entry.payloadRef !== undefined),
    );
    t.true(
      seeded.transcript.some(
        record => record.kind === 'message' && record.content === expectedText,
      ),
    );
    t.is(
      seeded.transcript.filter(record => record.kind === 'tool-result').length,
      1,
    );
    await E(agent).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    agent = await E(host).lookup('direct-journal-agent');
    const restored = await E(agent).inspect();
    t.is(restored.calls, 0);
    t.deepEqual(restored.transcript, seeded.transcript);
    t.deepEqual(restored.turns, seeded.turns);
    t.deepEqual(await E(host).lookup('direct-effect-proof'), { executions: 1 });
    const context = await E(agent).recall();
    t.true(context.some(message => message.content === expectedText));
    t.true(
      context.some(
        message =>
          message.role === 'tool' && message.content === 'Effect happened once',
      ),
    );
    t.true(
      context.some(message => message.content === 'Partial reply after effect'),
    );
    const recalled = await E(agent).inspect();
    t.is(recalled.calls, 1);
    t.is(recalled.turns.length, 2);
    t.is(recalled.turns[1].state, 'completed');
    t.true(recalled.turns[1].transcriptComplete);
    await E(agent).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    agent = await E(host).lookup('direct-journal-agent');
    const final = await E(agent).inspect();
    t.is(final.calls, 0);
    t.deepEqual(final.transcript, recalled.transcript);
    t.deepEqual(final.turns, recalled.turns);
    t.deepEqual(await E(host).lookup('direct-effect-proof'), { executions: 1 });
    await E(agent).shutdown();
  },
);
