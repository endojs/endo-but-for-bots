// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeJournalUsageReader } from '../src/journal-usage.js';
import { usageCounts } from './helpers/usage.js';

const barrier = () => {
  let resolve = () => {};
  const promise = new Promise(done => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
};

test('overlapping usage projections keep their pinned cut when the older read completes last', async t => {
  t.timeout(5000);
  const started = barrier();
  const release = barrier();
  t.teardown(release.resolve);
  const first = {
    turnId: '1',
    terminal: true,
    state: 'completed',
    usage: { inputTokens: 1, context: { usedTokens: 10, windowTokens: 1000 } },
  };
  const second = {
    turnId: '3',
    terminal: true,
    state: 'failed',
    usage: { inputTokens: 2, context: { usedTokens: 20, windowTokens: 0 } },
  };
  const third = {
    turnId: '5',
    terminal: true,
    state: 'completed',
    usage: { inputTokens: 4, context: { usedTokens: 30, windowTokens: 0 } },
  };
  let views = 0;
  let newReads = 0;
  const readUsage = makeJournalUsageReader(
    harden({
      async readView() {
        views += 1;
        return views === 1
          ? { archivedTurns: 1, archiveCursor: 'old', retained: [second] }
          : { archivedTurns: 2, archiveCursor: 'new', retained: [third] };
      },
      async listArchivedPage(cursor) {
        if (cursor === 'old') {
          started.resolve();
          await release.promise;
          return { records: [first], next: null };
        }
        newReads += 1;
        return { records: [first, second], next: null };
      },
    }),
  );
  const older = readUsage();
  await started.promise;
  const newer = await readUsage();
  t.deepEqual(newer, {
    ...usageCounts({ inputTokens: 7 }),
    turns: 2,
    incompleteTurns: 1,
    context: { usedTokens: 30, windowTokens: 1000 },
  });
  release.resolve();
  t.deepEqual(await older, {
    ...usageCounts({ inputTokens: 3 }),
    turns: 1,
    incompleteTurns: 1,
    context: { usedTokens: 20, windowTokens: 1000 },
  });
  // The older aggregate may replace the accelerator, but cannot be reused for
  // the newer frontier. Rebuilding it changes cost, not the accounting result.
  t.deepEqual(await readUsage(), newer);
  t.is(newReads, 2);
  t.deepEqual(await readUsage(), newer);
  t.is(newReads, 2);
});
