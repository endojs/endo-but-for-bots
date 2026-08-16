// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import {
  provideRunJournal,
  findChainBreak,
  hashRecord,
  canonicalJson,
  foldRecords,
  makeInterpreter,
  simulateRun,
} from '../src/index.js';
import {
  featureChange,
  featureChangeParticipants,
} from './fixtures/feature-change.js';

const makeRunDirectory = async () => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  return E(root).makeDirectory('run-1', {});
};

const makeNow = () => {
  let tick = 0;
  return () => {
    tick += 1;
    return tick;
  };
};

test('canonical JSON is key-order independent', t => {
  t.is(
    canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }),
    canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
  );
  t.is(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test('append, reload, and fold reproduce the live run state', async t => {
  const runDirectory = await makeRunDirectory();
  const interpreter = makeInterpreter(featureChange);
  const journal = await provideRunJournal(runDirectory, {
    runId: 'run-1',
    now: makeNow(),
  });

  const begin = interpreter.begin({
    runId: 'run-1',
    input: { request: 'add dark mode', branch: 'feat/dark-mode' },
    participants: featureChangeParticipants,
  });
  await journal.append(begin);
  let runState = foldRecords(journal.records());
  t.truthy(runState);
  await journal.append(
    interpreter.handle(
      /** @type {NonNullable<typeof runState>} */ (runState),
      harden({ type: 'effect.settled', as: 'implementation', ref: 'ref:1' }),
    ),
  );
  runState = foldRecords(journal.records());
  t.is(
    /** @type {NonNullable<typeof runState>} */ (runState).state,
    'reviewing',
  );

  // Effect records carry deterministic idempotency keys.
  const issued = journal
    .records()
    .filter(record => record.type === 'effect.issued');
  t.deepEqual(
    issued.map(record => record.idempotencyKey),
    issued.map(record => `run-1:${record.seq}:${record.as}`),
  );

  // A fresh journal over the same directory sees the same records, and
  // folding them reproduces the state exactly.
  const reloaded = await provideRunJournal(runDirectory, {
    runId: 'run-1',
    now: makeNow(),
  });
  t.deepEqual(reloaded.records(), journal.records());
  t.deepEqual(foldRecords(reloaded.records()), runState);

  // readFrom serves a gapless tail for seq-resume syncing.
  const tail = reloaded.readFrom(3);
  t.is(tail[0].seq, 3);
  t.is(tail[tail.length - 1].seq, journal.records().length);
});

test('the hash chain verifies and detects tampering', async t => {
  const runDirectory = await makeRunDirectory();
  const interpreter = makeInterpreter(featureChange);
  const journal = await provideRunJournal(runDirectory, {
    runId: 'run-1',
    now: makeNow(),
  });
  await journal.append(
    interpreter.begin({
      runId: 'run-1',
      input: { request: 'r', branch: 'b' },
      participants: featureChangeParticipants,
    }),
  );
  const started = foldRecords(journal.records());
  await journal.append(
    interpreter.handle(
      /** @type {NonNullable<typeof started>} */ (started),
      harden({ type: 'effect.settled', as: 'implementation', ref: 'ref:1' }),
    ),
  );
  const records = journal.records();
  t.true(records.length >= 4);
  t.is(findChainBreak(records), undefined);
  t.is(records[0].prev, '');
  t.is(records[1].prev, hashRecord(records[0]));

  // Doctoring a middle record breaks the chain at its successor.
  const doctored = records.map((record, i) =>
    i === 0 ? harden({ ...record, at: 999 }) : record,
  );
  t.is(findChainBreak(doctored), records[1].seq);

  // A gap breaks the chain at the first missing seq.
  t.is(findChainBreak(records.filter(({ seq }) => seq !== 2)), 3);
});

test('a corrupted segment fails the reload rather than loading silently', async t => {
  const runDirectory = await makeRunDirectory();
  const interpreter = makeInterpreter(featureChange);
  const journal = await provideRunJournal(runDirectory, {
    runId: 'run-1',
    now: makeNow(),
  });
  await journal.append(
    interpreter.begin({
      runId: 'run-1',
      input: { request: 'r', branch: 'b' },
      participants: featureChangeParticipants,
    }),
  );
  const eventsDirectory = await E(runDirectory).lookup('events');
  await E(eventsDirectory).write('00000001.json', 'not json\n');
  const warnings = [];
  await t.throwsAsync(
    provideRunJournal(runDirectory, {
      runId: 'run-1',
      now: makeNow(),
      warn: message => warnings.push(message),
    }),
    { message: /Journal chain of run .* breaks/u },
  );
  t.is(warnings.length, 1);
});

test('snapshots round-trip and support tail folding', async t => {
  const runDirectory = await makeRunDirectory();
  const interpreter = makeInterpreter(featureChange);
  const journal = await provideRunJournal(runDirectory, {
    runId: 'run-1',
    now: makeNow(),
  });
  await journal.append(
    interpreter.begin({
      runId: 'run-1',
      input: { request: 'r', branch: 'b' },
      participants: featureChangeParticipants,
    }),
  );
  const runState = foldRecords(journal.records());
  await journal.writeSnapshot({
    throughSeq: /** @type {NonNullable<typeof runState>} */ (runState)
      .throughSeq,
    state: runState,
  });
  const snapshot = /** @type {{ throughSeq: number, state: unknown }} */ (
    await journal.readSnapshot()
  );
  t.deepEqual(snapshot.state, runState);
  t.is(journal.readFrom(snapshot.throughSeq + 1).length, 0);
});

test('the simulator and the journal agree on the same event stream', async t => {
  const sim = simulateRun(featureChange, {
    input: { request: 'r', branch: 'b' },
    participants: featureChangeParticipants,
  });
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });

  const runDirectory = await makeRunDirectory();
  const interpreter = makeInterpreter(featureChange);
  const journal = await provideRunJournal(runDirectory, {
    runId: 'sim',
    now: makeNow(),
  });
  await journal.append(
    interpreter.begin({
      runId: 'sim',
      input: { request: 'r', branch: 'b' },
      participants: featureChangeParticipants,
    }),
  );
  const midState = foldRecords(journal.records());
  await journal.append(
    interpreter.handle(
      /** @type {NonNullable<typeof midState>} */ (midState),
      harden({ type: 'effect.settled', as: 'implementation', ref: 'ref:1' }),
    ),
  );

  const durable = foldRecords(journal.records());
  t.is(/** @type {NonNullable<typeof durable>} */ (durable).state, sim.state);
  t.deepEqual(
    /** @type {NonNullable<typeof durable>} */ (durable).context,
    sim.context,
  );
});
