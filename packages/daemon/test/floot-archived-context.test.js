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
  'archived checkpoint and late tool evidence survive a cold daemon restart',
  async t => {
    t.timeout(120_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-ac-'),
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
        'archived-context-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    await E(host).storeValue(
      harden({ version: 1, sessionId: 'archive-context' }),
      'floot-private-turn-15-archive-context-schema',
    );
    await E(host).provideWorker('archive-context-worker');
    let fixture = await E(host).makeUnconfined(
      'archive-context-worker',
      new URL('./_floot-archived-context.js', import.meta.url).href,
      { powersName: '@agent', resultName: 'archive-context-test' },
    );
    const ids = await E(fixture).seed();
    const seeded = await E(fixture).inspectArchive();
    t.true(Number(seeded.view.archivedTurns) > 0);
    t.is(seeded.view.archivedCheckpoint.turnId, ids.boundary);
    t.is(
      seeded.archived.find(turn => turn.turnId === ids.certified)
        .contextEvidence.kind,
      'no-tool-exceptions',
    );
    t.true(
      Number(seeded.archived.findIndex(turn => turn.turnId === ids.old)) >
        Number(seeded.archived.findIndex(turn => turn.turnId === ids.boundary)),
    );
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('archive-context-test');
    t.deepEqual(await E(fixture).inspectArchive(), seeded);
    t.is(await E(fixture).open(), 0);
    t.deepEqual(await E(fixture).contentReads(), []);
    const context = await E(fixture).recall();
    const contents = context.map(message => message.content || '').join('\n');
    t.false(contents.includes('OLD-TEXT-END'));
    t.false(contents.includes('KNOWN-SUMMARIZED'));
    t.true(contents.includes('ARCHIVED-SUMMARY'));
    t.true(contents.includes('RETAINED-TAIL'));
    t.is(contents.split('ARCHIVED-SUMMARY').length - 1, 1);
    t.is(contents.split('RETAINED-TAIL').length - 1, 1);
    t.true(
      context.some(
        message =>
          message.role === 'tool' && message.content === 'LATE-EFFECT-PROOF',
      ),
    );
    t.deepEqual(await E(fixture).contentReads(), []);
    t.deepEqual(await E(host).lookup('archive-effect-proof'), {
      executions: 1,
    });
    const recalled = await E(fixture).inspect();
    t.is(recalled.calls, 1);
    t.is(recalled.turns.at(-1).state, 'completed');
    t.is(recalled.turns.at(-1).input, 'Recall without repeating effects');
    t.true(
      recalled.history.some(message =>
        message.content?.includes('OLD-TEXT-END'),
      ),
    );
    const reads = await E(fixture).contentReads();
    const superseded = seeded.archived.find(turn => turn.turnId === ids.old)
      .transcript[0].payloadRef.name;
    const certifiedArgs = seeded.archived.find(
      turn => turn.turnId === ids.certified,
    ).transcript[0].payloadRef.name;
    t.true(reads.includes(superseded));
    t.true(reads.includes(certifiedArgs));
    await E(fixture).shutdown();
    await stop(config);
    await start(config);
    host = await connect();
    fixture = await E(host).lookup('archive-context-test');
    const final = await E(fixture).inspect();
    t.is(final.calls, 0);
    t.deepEqual(final.transcript, recalled.transcript);
    t.deepEqual(final.history, recalled.history);
    t.deepEqual(final.turns, recalled.turns);
    t.is(final.turns.at(-1).state, 'completed');
    t.deepEqual(await E(host).lookup('archive-effect-proof'), {
      executions: 1,
    });
    await E(fixture).shutdown();
  },
);
