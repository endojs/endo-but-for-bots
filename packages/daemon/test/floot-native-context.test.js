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
  'hosted native context and dispatch requirement survive a daemon restart',
  async t => {
    t.timeout(120_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-nc-'),
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
      await null;
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'native-context-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    const modes = ['complete', 'failed', 'missing'];
    for (const mode of modes) {
      const sessionId = `native-${mode}`;
      // Explicitly initialize this test's current private-storage schema.
      // eslint-disable-next-line no-await-in-loop
      await E(host).storeValue(
        harden({ version: 1, sessionId }),
        `floot-private-turn-${sessionId.length}-${sessionId}-schema`,
      );
    }
    await E(host).provideWorker('native-context-worker');
    let fixture = await E(host).makeUnconfined(
      'native-context-worker',
      new URL('./_floot-native-context.js', import.meta.url).href,
      { powersName: '@agent', resultName: 'native-context-test' },
    );
    const expected = await E(fixture).expected();
    const before = new Map();
    for (const mode of modes) {
      // eslint-disable-next-line no-await-in-loop
      if (mode === 'complete') await E(fixture).seed(mode);
      else {
        // eslint-disable-next-line no-await-in-loop
        await t.throwsAsync(E(fixture).seed(mode), {
          message: /Synthetic native failure/,
        });
      }
      // eslint-disable-next-line no-await-in-loop
      const seeded = await E(fixture).inspect(mode);
      before.set(mode, seeded);
      t.is(seeded.calls, 1);
      t.is(seeded.turns[0].nativeContextFormat, expected.format);
      t.is(seeded.turns[0].state, mode === 'complete' ? 'completed' : 'failed');
      if (mode !== 'missing') {
        t.true(seeded.turns[0].transcriptComplete);
        t.true(
          seeded.turns[0].transcript.some(
            row => row.kind === 'native-context' && row.payloadRef,
          ),
        );
        t.deepEqual(
          seeded.transcript.find(row => row.kind === 'native-context'),
          expected,
        );
      } else {
        t.false(Boolean(seeded.turns[0].transcriptComplete));
      }
    }
    const archived = await E(fixture).archive('complete');
    t.true(Number(archived.archivedTurns) > 0);
    t.is(
      archived.archivedCheckpoint.turnId,
      before.get('complete').turns[0].turnId,
    );
    before.set('complete', await E(fixture).inspect('complete'));
    await E(fixture).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('native-context-test');
    const recalled = new Map();
    for (const mode of modes) {
      // Reconstruction deliberately omits nativeContextFormat in current options.
      // eslint-disable-next-line no-await-in-loop
      const restored = await E(fixture).inspect(mode);
      t.is(restored.calls, 0, 'formula reconstruction never sends inference');
      t.deepEqual(restored.transcript, before.get(mode).transcript);
      t.deepEqual(restored.history, before.get(mode).history);
      t.deepEqual(restored.turns, before.get(mode).turns);
      if (mode === 'missing') {
        // eslint-disable-next-line no-await-in-loop
        await t.throwsAsync(E(fixture).recall(mode), {
          message: /cannot conceal unresolved or recovered tool evidence/,
        });
        // eslint-disable-next-line no-await-in-loop
        t.is((await E(fixture).inspect(mode)).calls, 0);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const context = await E(fixture).recall(mode);
        t.deepEqual(context[0], expected);
        if (mode === 'failed')
          t.regex(
            context.at(-1).content,
            /Floot turn failed.*Synthetic native failure/s,
          );
      }
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await E(host).lookup(`native-${mode}-effect-proof`), {
        executions: 1,
      });
      // eslint-disable-next-line no-await-in-loop
      const final = await E(fixture).inspect(mode);
      t.is(final.calls, mode === 'missing' ? 0 : 1);
      recalled.set(mode, final);
    }
    await E(fixture).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('native-context-test');
    for (const mode of modes) {
      // The recall suffix and failed restoration attempt are durable too.
      // eslint-disable-next-line no-await-in-loop
      const final = await E(fixture).inspect(mode);
      t.is(final.calls, 0);
      t.deepEqual(final.transcript, recalled.get(mode).transcript);
      t.deepEqual(final.history, recalled.get(mode).history);
      t.deepEqual(final.turns, recalled.get(mode).turns);
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await E(host).lookup(`native-${mode}-effect-proof`), {
        executions: 1,
      });
    }
    await E(fixture).shutdown();
  },
);
