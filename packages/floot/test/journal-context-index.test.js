// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeTurnJournal } from '../src/turn-journal.js';

/* eslint-disable no-await-in-loop */
const options = harden({ input: 'input', backendId: 'codex', modelId: 'sol' });
const checkpoint = summary => ({
  kind: 'compaction',
  summary,
  retainedTail: [],
});
const fixture = () => {
  const store = new Map();
  const reads = [];
  let fault;
  const powers = Far('IndexStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => {
      reads.push(name);
      return store.get(name);
    },
    storeValue: (value, name) => {
      if (fault?.matches(name) && !fault.after)
        throw Error('Publication fault');
      if (store.has(name)) throw Error('Overwrite forbidden');
      store.set(name, value);
      if (fault?.matches(name) && fault.after) throw Error('Publication fault');
    },
    remove: name => store.delete(name),
  });
  return {
    store,
    reads,
    powers,
    setFault: value => {
      fault = value;
    },
  };
};
const finishMore = async (journal, count) => {
  for (let index = 0; index < Number(count); index += 1) {
    const id = await journal.begin(options);
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
};
const latestSnapshot = f =>
  [...f.store.keys()]
    .filter(name => name.startsWith('floot-turn-snapshot-'))
    .sort()
    .at(-1);

test('archive index chooses numeric dispatch and last ordinal, not late publication', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const old = await journal.begin(options);
  await journal.recordTranscript(old, '0', checkpoint('old'));
  await journal.append(old, {
    type: 'tool-intent',
    callId: 'host',
    name: 'exec',
    args: '{}',
  });
  await journal.append(old, { type: 'finish', state: 'completed' });
  const current = await journal.begin(options);
  await journal.recordTranscript(current, '0', checkpoint('first'));
  await journal.recordTranscript(
    current,
    '1',
    checkpoint('latest'.repeat(2000)),
  );
  await journal.append(current, { type: 'finish', state: 'completed' });
  await finishMore(journal, 290);
  const initial = (await journal.readView()).archivedCheckpoint;
  t.like(initial, { turnId: current, ordinal: '1' });
  await journal.append(old, {
    type: 'tool-result',
    callId: 'host',
    result: 'late',
  });
  await journal.resolve(old, 'Effect checked');
  await finishMore(journal, 80);
  t.deepEqual((await journal.readView()).archivedCheckpoint, initial);
  f.reads.length = 0;
  const revived = makeTurnJournal(f.powers);
  t.deepEqual((await revived.readView()).archivedCheckpoint, initial);
  const pages = f.reads.filter(name => name.startsWith('floot-turn-archive-'));
  t.is(pages.length, 1);
  t.true(pages[0].endsWith(initial.chunk.padStart(20, '0')));
  t.false(f.reads.some(name => name.startsWith('floot-turn-content-')));
  const snapshot = f.store.get(latestSnapshot(f));
  t.is(snapshot.version, 2);
  t.deepEqual(snapshot.archivedCheckpoint, initial);
});

test('fresh journal exposes explicit null archived checkpoint', async t => {
  t.is(
    (await makeTurnJournal(fixture().powers).readView()).archivedCheckpoint,
    null,
  );
});

test('snapshot index rejects missing, malformed, out-of-range, and mismatched pointers', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.recordTranscript(id, '0', checkpoint('summary'));
  await journal.append(id, { type: 'finish', state: 'completed' });
  await finishMore(journal, 290);
  const name = latestSnapshot(f);
  const original = f.store.get(name);
  const cases = [
    undefined,
    { ...original.archivedCheckpoint, chunk: 0 },
    { ...original.archivedCheckpoint, chunk: `${original.archiveChunks}` },
    { ...original.archivedCheckpoint, ordinal: '65536' },
    { ...original.archivedCheckpoint, sequence: '1' },
    { ...original.archivedCheckpoint, ordinal: '1' },
    { ...original.archivedCheckpoint, extra: true },
  ];
  for (const pointer of cases) {
    f.store.set(name, harden({ ...original, archivedCheckpoint: pointer }));
    await t.throwsAsync(makeTurnJournal(f.powers).readView(), {
      message: /[Aa]rchived checkpoint/,
    });
  }
});

for (const target of ['archive', 'snapshot']) {
  for (const after of [false, true]) {
    test(`index publication recovers ${after ? 'after' : 'before'} ${target} store failure`, async t => {
      const f = fixture();
      const journal = makeTurnJournal(f.powers);
      const id = await journal.begin(options);
      await journal.recordTranscript(id, '0', checkpoint('summary'));
      await journal.append(id, { type: 'finish', state: 'completed' });
      // Arm at the first archival publication, not an earlier retained-only snapshot.
      let archiveSeen = false;
      f.setFault({
        after,
        matches: name => {
          if (name.startsWith('floot-turn-archive-')) archiveSeen = true;
          return archiveSeen && name.startsWith(`floot-turn-${target}-`);
        },
      });
      await t.throwsAsync(finishMore(journal, 290), {
        message: 'Publication fault',
      });
      await t.throwsAsync(journal.readView());
      f.setFault(undefined);
      const revived = makeTurnJournal(f.powers);
      const view = await revived.readView();
      if (target === 'snapshot' && after) {
        t.is(view.archivedCheckpoint.turnId, id);
        t.true(Number(view.archivedTurns) > 0);
      } else {
        t.is(view.archivedCheckpoint, null);
        t.is(view.archivedTurns, 0);
        t.true(view.retained.some(record => record.turnId === id));
      }
      await finishMore(revived, 80);
      t.is(
        (await makeTurnJournal(f.powers).readView()).archivedCheckpoint.turnId,
        id,
      );
    });
  }
}
