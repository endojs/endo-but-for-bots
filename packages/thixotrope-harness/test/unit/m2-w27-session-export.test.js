// @ts-check
// M2 W2.7 (m2-interfaces.md 7.1, 7.3): the session's delete fence, blob
// pages and export pages on the real session (guest/session/session.js over
// the W2.4 fakes), and the import state machine of `export.js` over a fake
// runner (the runner's import seams are W2.5's).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
import { makeSessionExport } from '../../guest/session/export.js';
import { makeQueue } from '../../guest/session/queue.js';
import { makeRecordLog } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import { AT, drain, makeQueueSession, requestId } from './_m2-queue-session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} preview */
const staged = preview =>
  harden({ blob: Far('Blob', {}), preview, bytes: 9000 });

/**
 * Every export page from the head to the end.
 * @param {any} internal
 */
const exportAll = internal => {
  const pages = [internal.exportState()];
  while (pages[pages.length - 1].next !== undefined) {
    pages.push(internal.exportState(pages[pages.length - 1].next));
  }
  return pages;
};

test('blob pages name every staged field of the kept records and the waiting entries', async t => {
  const s = await makeQueueSession();
  const big = staged('a long message');
  s.session.enqueueOnce(big, requestId(), AT);
  await drain();
  await s.finish('first');
  // Two waiting entries behind a running turn, one staged.
  await s.submit('running');
  const waiting = staged('waiting');
  s.session.enqueueOnce(waiting, requestId(), AT);
  await s.submit('inline');
  /** @type {any[]} */
  const blobs = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = s.internal.blobPage(cursor);
    t.true(matches(page, shapes.BlobPage));
    blobs.push(...page.blobs);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  t.true(blobs.includes(big.blob), 'the first turn input');
  t.true(blobs.includes(waiting.blob), 'a waiting entry');
  t.is(blobs.length, 2);
});

test('blob pages hold at most 64 handles and resume inside one record', async t => {
  const records = makeRecordLog();
  const intents = [];
  for (let i = 0; i < 100; i += 1) {
    intents.push(
      harden({
        opId: `t1/${i}`,
        callId: `c${i}`,
        name: 'echo',
        args: staged(`args ${i}`),
      }),
    );
  }
  records.append(
    harden({ kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 }),
  );
  records.append(
    harden({ kind: 'tool-intents', turnId: 't1', round: 0, intents }),
  );
  const queue = makeQueue();
  const runner = { current: () => undefined, usage: () => undefined };
  const lifecycle = makeSessionExport({
    records,
    queue,
    runner,
    config: harden({}),
    info: () => harden({}),
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  /** @type {any} */
  const first = lifecycle.blobPage();
  t.is(first.blobs.length, limits.blobResolveBatch);
  t.is(first.next, 'p1.64');
  /** @type {any} */
  const second = lifecycle.blobPage(first.next);
  t.is(second.blobs.length, 36);
  t.is(second.next, undefined);
  t.is(new Set([...first.blobs, ...second.blobs]).size, 100);
});

test('deleteSelf fences the session: new work is refused and the turn is cancelled', async t => {
  const s = await makeQueueSession();
  await s.submit('running');
  await s.submit('waiting');
  t.is(s.session.getCurrentTurn()?.turn.getStatus().state, 'running');
  s.internal.deleteSelf();
  await drain();
  t.throws(
    () => s.session.enqueueOnce(harden({ text: 'more' }), requestId(), AT),
    {
      message: texts.sessionDeleting,
    },
  );
  t.throws(() => s.session.startTurn(harden({ text: 'direct' }), AT), {
    message: texts.sessionDeleting,
  });
  s.internal.deleteSelf();
  const history = s.session.getHistoryPage();
  t.not(history.turns[0].state, 'running', 'cancelled');
  await t.throwsAsync(
    async () => s.internal.importState(harden({ part: 'head' })),
    {
      message: texts.sessionDeleting,
    },
  );
});

test('export pages: head, records from the kept start, queue, end; each within a frame', async t => {
  const s = await makeQueueSession();
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.submit(`turn ${i} ${'x'.repeat(6000)}`);
    // eslint-disable-next-line no-await-in-loop
    await s.finish(`answer ${i} ${'y'.repeat(6000)}`);
  }
  await s.submit('running');
  await s.submit('waiting one');
  await s.submit('waiting two');
  const pages = exportAll(s.internal);
  for (const page of pages) {
    t.true(matches(page, shapes.SessionExportPage), page.part);
    t.true(messageBytes(page) <= limits.frameBytes, page.part);
  }
  t.is(pages[0].part, 'head');
  t.is(pages[0].info.key, 's1');
  t.is(pages[0].next, 'r0');
  const recordPages = pages.filter(p => p.part === 'records');
  t.true(recordPages.length > 1, 'split by bytes');
  let next = 0;
  for (const page of recordPages) {
    t.is(page.from, next);
    next += page.records.length;
  }
  const all = recordPages.flatMap(p => p.records);
  t.is(all[0].kind, 'turn-started');
  t.is(all.filter(r => r.kind === 'turn-started').length, 7);
  const queue = pages.filter(p => p.part === 'queue');
  t.deepEqual(
    queue.flatMap(p => p.entries).map(e => e.submission.text),
    ['waiting one', 'waiting two'],
  );
  t.is(pages[pages.length - 1].part, 'end');
  t.throws(() => s.internal.exportState('z1'));
});

test('import: a new session only, records in order, resends answered, the queue held, end reported', async t => {
  const records = makeRecordLog();
  /** @type {any[]} */
  const reported = [];
  const runner = {
    current: () => undefined,
    usage: () => undefined,
    see: () => {},
    /** @type {any} */
    usageImported: undefined,
    /** @param {any} totals */
    importUsage: totals => {
      runner.usageImported = totals;
    },
    /** @param {any[]} added */
    importTurns: added => {
      for (const record of added) records.append(record);
    },
  };
  const queue = makeQueue();
  const lifecycle = makeSessionExport({
    records,
    queue,
    runner,
    config: harden({}),
    info: () => harden({}),
    rowReporter: Far('RowReporter', {
      changed: (/** @type {any} */ patch) => reported.push(patch),
    }),
  });
  t.throws(
    () =>
      lifecycle.importState(harden({ part: 'records', from: 0, records: [] })),
    { message: /no import is open/ },
  );
  const usage = harden({
    inputTokens: 5,
    outputTokens: 6,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    context: { usedTokens: 0, windowTokens: 0 },
    turns: 1,
    incompleteTurns: 0,
  });
  t.deepEqual(lifecycle.importState(harden({ part: 'head', usage })), {
    records: 0,
    complete: false,
  });
  t.is(runner.usageImported, usage);
  const turn = [
    harden({ kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 }),
    harden({
      kind: 'turn-settled',
      turnId: 't1',
      status: 'completed',
      at: 2,
    }),
  ];
  t.is(
    lifecycle.importState(harden({ part: 'records', from: 0, records: turn }))
      .records,
    2,
  );
  t.is(
    lifecycle.importState(harden({ part: 'records', from: 0, records: turn }))
      .records,
    2,
    'a resend is answered without effect',
  );
  t.throws(() =>
    lifecycle.importState(harden({ part: 'records', from: 5, records: turn })),
  );
  lifecycle.importState(
    harden({
      part: 'queue',
      entries: [
        { submission: { text: 'later' }, requestId: requestId(), at: AT },
      ],
    }),
  );
  t.is(queue.size(), 1);
  t.is(queue.holdReason(), 'restart', 'nothing starts by itself');
  t.deepEqual(lifecycle.importState(harden({ part: 'end' })), {
    records: 2,
    complete: true,
  });
  await drain();
  t.deepEqual(reported, [{ imported: true, messageCount: 1, queuedCount: 1 }]);
  t.true(matches(reported[0], shapes.RowPatch));
});

test('import seams W2.5 has not built say so', t => {
  const lifecycle = makeSessionExport({
    records: makeRecordLog(),
    queue: makeQueue(),
    runner: { current: () => undefined },
    config: harden({}),
    info: () => harden({}),
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  t.throws(
    () =>
      lifecycle.importState(
        harden({
          part: 'head',
          usage: harden({
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            context: { usedTokens: 0, windowTokens: 0 },
            turns: 0,
            incompleteTurns: 0,
          }),
        }),
      ),
    { message: textOf.notBuilt('importUsage') },
  );
});
