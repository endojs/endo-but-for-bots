// @ts-check
// Per-session growth (J-9152, C-7): a session keeps records, not exos, for
// settled turns. 1,000 turns through the real session (queue, receipts,
// history pages) with in-memory fakes that keep nothing; then a full
// collection and a count of the exos still reachable. Before J-9152 every
// Turn was kept for the session's life (1,000 live Turn exos here).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

// Before any guest module: they read the counting defineExoClass.
import { liveExos } from './_m1a-count-exos.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeSession } from '../../guest/session/session.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const drain = () => new Promise(resolve => setImmediate(resolve));

const AT = 1_700_000_000_000;
const TURNS = 1000;

/**
 * @param {number} n
 * @param {number} at
 */
const requestId = (n, at) =>
  `${at}-00000000-0000-4000-8000-${`${n}`.padStart(12, '0')}`;

const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * A session whose fake adapter keeps no turn: each lease settles at its
 * release, and the one pending round request is cleared once answered.
 */
const setup = () => {
  /** @type {{ req: any }} */
  const pending = { req: undefined };
  /** @type {Map<any, () => void>} */
  const leases = new Map();
  const endpoint = Far('Endpoint', {
    holdTurn: (/** @type {any} */ turn) =>
      new Promise(resolve => {
        leases.set(turn, () => resolve(undefined));
      }),
    releaseTurn: (/** @type {any} */ turn) => {
      leases.get(turn)?.();
      leases.delete(turn);
    },
    startRound: (/** @type {any} */ req) => {
      pending.req = req;
    },
    cancelRound: () => {},
    armDeadline: () => {},
    disarm: () => {},
  });
  const publisher = Far('LivePublisher', { publish: () => {} });
  const ports = harden({ endpoint, publisher, tools: [], since: AT - 1 });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', { liveChannel: () => publisher });
  const rowReporter = Far('RowReporter', { changed: () => {} });
  const config = harden({
    key: 's1',
    title: 'growth',
    backendTitle: 'fake',
    modelId: 'scripted',
    preset: harden({ label: 'chat-only' }),
    createdAt: AT,
    userInitiated: true,
  });
  const { session } = makeSession({
    config,
    services: { backend, host },
    rowReporter,
  });
  return { session, pending, leases };
};

/**
 * Run `count` plain turns. A function of its own, so its locals (the last
 * round request, its sink) are gone when it returns: a suspended async
 * frame keeps its locals.
 * @param {ReturnType<typeof setup>} rig
 * @param {number} count
 */
const runTurns = async ({ session, pending }, count) => {
  for (let n = 1; n <= count; n += 1) {
    const at = AT + n;
    session.enqueueOnce(harden({ text: `message ${n}` }), requestId(n, at), at);
    // eslint-disable-next-line no-await-in-loop
    await drain();
    const { req } = pending;
    pending.req = undefined;
    req.sink.dispatching(0);
    req.sink.roundFinal(
      harden({ round: 0, text: `answer ${n}`, toolCalls: [], usage, at }),
    );
    // eslint-disable-next-line no-await-in-loop
    await drain();
  }
};

/**
 * Read every history page and an old receipt; returns what the reads saw.
 * @param {any} session
 */
const readAll = session => {
  let pages = 0;
  let turnsSeen = 0;
  let page = session.getHistoryPage();
  for (;;) {
    pages += 1;
    turnsSeen += page.turns.length;
    if (page.next === undefined) break;
    page = session.getHistoryPage(page.next);
  }
  const receipt = session.getSubmissionReceipt(requestId(1, AT + 1));
  const status = receipt?.turn.getStatus();
  const same =
    session.getSubmissionReceipt(requestId(1, AT + 1))?.turn === receipt?.turn;
  return { pages, turnsSeen, state: receipt?.state, status, same };
};

test('1,000 settled turns leave a bounded number of live exos', async t => {
  const rig = setup();
  const { session, leases } = rig;
  await drain();
  await runTurns(rig, TURNS);
  t.is(session.getUsage().turns, TURNS);
  t.is(leases.size, 0, 'every lease released');

  // Turns are minted from records and only the recent ones are kept.
  const read = readAll(session);
  t.is(read.turnsSeen, TURNS);
  t.true(read.pages >= TURNS / limits.historyPageTurns);
  t.is(read.state, 'started');
  t.is(read.status.turnId, 't1');
  t.is(read.status.state, 'completed');
  t.true(read.same, 'the same handle while it is recent');

  const counts = await liveExos();
  t.log(JSON.stringify(counts));
  t.is(counts.made.Turn >= TURNS, true);
  t.true(
    (counts.live.Turn ?? 0) <= limits.retainedTurnHandles,
    `live Turns ${counts.live.Turn} <= ${limits.retainedTurnHandles}`,
  );
  t.is(counts.live.TurnSink ?? 0, 0, 'no sink outlives its turn');
  t.is(counts.live.QueueEntry ?? 0, 0, 'no claimed entry is kept');
});
