// @ts-check
// Export and import keep the context window (guest/session/turn-import.js
// seam S-8, compaction.js `observe`; designs/m8-interfaces.md 4.5,
// acceptance 10): a session imported from a compacted one sends the same
// epoch and boundary and pages its context from the boundary; the window
// over an imported log takes the highest epoch; a seal request carries the
// window's epoch (archive.js seam S-9).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeSessionArchive } from '../../guest/session/archive.js';
import { makeContextWindow } from '../../guest/session/compaction.js';
import { makeContextSource } from '../../guest/session/context-source.js';
import { makeRecordLog } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import { makeFakeArchive } from './_m2-fake-archive.js';
import {
  AT,
  OVER,
  drain,
  makeCompactionSession,
  usageOf,
} from './_compaction-session.js';

/**
 * Every export page of a session, head to end, as a wire would carry them.
 * @param {any} internal
 */
const exportAll = internal => {
  const pages = [internal.exportState()];
  while (pages[pages.length - 1].next !== undefined) {
    pages.push(internal.exportState(pages[pages.length - 1].next));
  }
  return pages.map(({ next: _next, ...page }) =>
    harden(JSON.parse(JSON.stringify(page))),
  );
};

test('export then import of a compacted session: the next request starts from the same summary and boundary', async t => {
  const a = await makeCompactionSession();
  await a.turn('first', OVER);
  await a.submit('second');
  const req = a.last();
  req.sink.dispatching(0);
  const { startIndex } = req.compaction;
  req.sink.compacted(
    harden({
      round: 0,
      at: AT + 5,
      outcome: 'done',
      boundary: startIndex,
      summary: 'the summary',
    }),
  );
  await a.answer({ usage: usageOf(10, 100) });

  const b = await makeCompactionSession();
  for (const page of exportAll(a.internal)) b.internal.importState(page);
  await drain();
  t.deepEqual(b.records(), a.records());
  await b.submit('third');
  const next = b.last();
  t.like(next.base, { epoch: 1, boundary: startIndex });
  t.is(next.compaction, undefined, 'the reading is below the threshold');
  t.is(next.context.page().from, startIndex);
  const summary = next.context
    .page()
    .records.find((/** @type {any} */ r) => r.kind === 'compaction');
  t.like(summary, { epoch: 1, boundary: startIndex, summary: 'the summary' });
});

test('the window over an imported log takes the highest epoch; other records leave it', t => {
  const records = makeRecordLog();
  const window = makeContextWindow({ records });
  t.deepEqual(window.baseFields(), { epoch: 0 });
  const compaction = (/** @type {number} */ epoch, /** @type {number} */ b) =>
    harden({
      kind: 'compaction',
      turnId: 't1',
      round: 0,
      epoch,
      boundary: b,
      summary: 's',
      at: 1,
    });
  window.observe(
    harden({ kind: 'turn-started', turnId: 't1', input: 'x', at: 1 }),
    0,
  );
  window.observe(compaction(2, 7), 1);
  window.observe(compaction(1, 3), 2);
  t.deepEqual(window.baseFields(), { epoch: 2, boundary: 7 });
});

test('a seal request carries the window epoch', async t => {
  const records = makeRecordLog();
  const epoch = 3;
  const archive = makeSessionArchive({
    records,
    limits: harden({
      ...limits,
      archiveKeepTurns: 1,
      archiveSegmentTurns: 1,
    }),
    epoch: () => epoch,
  });
  const context = makeContextSource({ records, archive });
  const fake = makeFakeArchive();
  const usage = usageOf();
  for (const turnId of ['t1', 't2', 't3']) {
    records.append({ kind: 'turn-started', turnId, input: 'x', at: 1 });
    records.append({
      kind: 'round-settled',
      turnId,
      round: 0,
      text: 'y',
      callCount: 0,
      usage,
      at: 1,
    });
    records.append({
      kind: 'turn-settled',
      turnId,
      status: 'completed',
      at: 1,
    });
  }
  archive.maybeSeal({ ports: harden({ archive: fake.port }), context });
  await drain();
  t.true(fake.requests().length > 0);
  t.is(fake.requests()[0].epoch, epoch);
});
