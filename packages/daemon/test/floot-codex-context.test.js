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
  'Codex client native capture and journal restoration cross two daemon restarts',
  async t => {
    t.timeout(120_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-cx-'),
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
        'codex-context-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    await E(host).storeValue(
      harden({ version: 1, sessionId: 'codex-context' }),
      'floot-private-turn-13-codex-context-schema',
    );
    await E(host).provideWorker('codex-context-worker');
    let fixture = await E(host).makeUnconfined(
      'codex-context-worker',
      new URL('./_floot-codex-context.js', import.meta.url).href,
      { powersName: '@agent', resultName: 'codex-context-test' },
    );
    t.deepEqual((await E(fixture).inspect()).requests, []);
    await E(fixture).converse();
    const seeded = await E(fixture).inspect();
    t.is(seeded.starts, 1);
    t.deepEqual(seeded.acknowledgements, ['turn-seed']);
    t.is(seeded.turns[0].state, 'completed');
    t.is(seeded.turns[0].backendCheckpoint, 'turn-seed');
    t.true(seeded.turns[0].transcriptComplete);
    const seedCheckpoint = seeded.transcript.find(
      row => row.kind === 'native-context',
    );
    t.deepEqual(JSON.parse(seedCheckpoint.payload).capture, seeded.captures[0]);
    t.deepEqual(seedCheckpoint.context, []);
    t.truthy(
      seeded.turns[0].transcript.find(row => row.kind === 'native-context')
        .payloadRef,
    );
    t.deepEqual(await E(host).lookup('codex-context-effect'), {
      executions: 1,
    });
    await E(fixture).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('codex-context-test');
    const revived = await E(fixture).inspect();
    t.deepEqual(
      revived.requests,
      [],
      'formula reconstruction sends no app-server requests',
    );
    t.is(revived.starts, 0);
    t.deepEqual(revived.transcript, seeded.transcript);
    t.deepEqual(revived.turns, seeded.turns);
    t.deepEqual(revived.history, seeded.history);
    await E(fixture).converse();
    const recalled = await E(fixture).inspect();
    t.is(recalled.starts, 1);
    t.is(recalled.restores.length, 1);
    t.deepEqual(recalled.restores[0].capture, seeded.captures[0]);
    t.is(recalled.restores[0].target.sessionId, 'native-restored');
    t.not(recalled.restores[0].target.sessionId, seeded.captures[0].sessionId);
    t.true(
      recalled.savedStates.some(
        state =>
          state.threadId === 'native-restored' &&
          state.recovery?.baseTurnId === 'rollout-1' &&
          state.recovery.previousCheckpoint === 'turn-seed',
      ),
    );
    t.false(
      recalled.requests.some(request =>
        ['thread/revert', 'thread/inject_items'].includes(request.method),
      ),
    );
    t.deepEqual(recalled.acknowledgements, ['turn-recalled']);
    t.deepEqual(
      recalled.turns.map(turn => turn.state),
      ['completed', 'completed'],
    );
    const checkpoints = recalled.transcript.filter(
      row => row.kind === 'native-context',
    );
    t.is(checkpoints.length, 2);
    t.deepEqual(
      JSON.parse(checkpoints[1].payload).capture,
      recalled.captures[0],
    );
    t.is(recalled.captures[0].sessionId, 'native-restored');
    t.deepEqual(await E(host).lookup('codex-context-effect'), {
      executions: 1,
    });
    await E(fixture).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('codex-context-test');
    const final = await E(fixture).inspect();
    t.deepEqual(final.requests, []);
    t.is(final.starts, 0);
    t.deepEqual(final.turns, recalled.turns);
    t.deepEqual(final.transcript, recalled.transcript);
    t.deepEqual(final.history, recalled.history);
    t.deepEqual(await E(host).lookup('codex-context-effect'), {
      executions: 1,
    });
    await E(fixture).shutdown();
  },
);
