// @ts-check
// M1b W1b.1 in the session vat (guest/session/{turn,queue,session,staging}.js;
// designs/m1b-interfaces.md sections 2.3, 3.2, 3.3 and 5): the progress
// checkpoint kept outside the log and replaced, appended as one Partial only
// when a round ends without roundFinal; staged submissions, replies, native
// context and tool outcomes carried unchanged; Turn.getContent; the tool
// seams W1b.4 builds on. In-memory fakes, no timers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, shapes } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeSession } from '../../guest/session/session.js';
import { toolTable } from '../../guest/session/tool-table.js';
import {
  blobsOf,
  fieldBytes,
  isStaged,
  previewOf,
  sameSubmission,
} from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit, matches } = /** @type {GuestGlobals} */ (
  globalThis
);

const drain = () => new Promise(resolve => setImmediate(resolve));
const AT = 1_700_000_000_000;
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * @param {string} preview
 * @param {number} [bytes]
 */
const staged = (preview, bytes = 50_000) =>
  harden({ blob: Far('Blob', {}), preview, bytes });

/**
 * A session over fake ports. `rounds` gets each RoundRequest; leases are
 * pending until released or broken by hand.
 * @param {{ table?: readonly any[], services?: Record<string, any> }} [options]
 */
const setup = async ({ table, services: extra = {} } = {}) => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const published = [];
  const endpoint = Far('Endpoint', {
    holdTurn: () => {
      const kit = makePromiseKit();
      leases.push(kit);
      return kit.promise;
    },
    releaseTurn: () => undefined,
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => undefined,
    armDeadline: () => undefined,
    disarm: () => undefined,
  });
  const publisher = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      published.push(batch);
    },
  });
  const ports = harden({
    endpoint,
    publisher,
    tools: [],
    since: AT - 1000,
    writers: Far('BlobWriters', {}),
  });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', { liveChannel: () => publisher });
  const services = harden({ backend, host, ...extra });
  const { session } = makeSession(
    {
      config: harden({
        key: 's1',
        title: 't',
        backendTitle: 'fake',
        modelId: 'm',
        preset: { label: 'chat-only' },
        createdAt: AT,
        userInitiated: true,
      }),
      services,
      rowReporter: Far('RowReporter', { changed: () => undefined }),
    },
    table === undefined ? undefined : harden({ toolTable: table }),
  );
  await drain();
  const last = () => rounds[rounds.length - 1];
  const kinds = () =>
    session
      .getHistoryPage()
      .turns[0].records.map((/** @type {any} */ r) => r.kind);
  const events = () =>
    published.flatMap(b => b.events.map((/** @type {any} */ e) => e));
  return { session, rounds, leases, last, kinds, events, ports, services };
};

/**
 * Start a turn and dispatch round 0; returns its sink.
 * @param {any} s
 * @param {any} [submission]
 */
const start = async (s, submission = harden({ text: 'hi' })) => {
  s.session.enqueueOnce(submission, requestId(), AT);
  await drain();
  const req = s.last();
  req.sink.dispatching(0);
  return req;
};

/**
 * @param {number} round
 * @param {any} text
 * @param {readonly any[]} [toolCalls]
 * @param {any} [nativeContext]
 */
const result = (round, text, toolCalls = [], nativeContext = undefined) =>
  harden({
    round,
    text,
    toolCalls,
    usage,
    at: AT + 1,
    ...(nativeContext === undefined ? {} : { nativeContext }),
  });

const progress = (/** @type {number} */ round, /** @type {any} */ partial) =>
  harden({ round, partial, tail: partial.preview, at: AT + 1 });

test('staging helpers', t => {
  const s = staged('p', 9000);
  t.true(isStaged(s));
  t.false(isStaged('x'));
  t.false(isStaged(harden({ text: 'x' })));
  t.is(fieldBytes(s), 9000);
  t.is(fieldBytes('é'), 2);
  t.is(previewOf(staged('abcdef'), 3), 'abc');
  t.is(previewOf('abcdef', 2), 'ab');
  t.true(sameSubmission(harden({ text: 'a' }), harden({ text: 'a' })));
  t.false(sameSubmission(harden({ text: 'a' }), staged('a', 1)));
  t.true(sameSubmission(staged('a', 9000), staged('a', 9000)));
  t.false(sameSubmission(staged('a', 9000), staged('a', 9001)));
  const intents = harden({
    kind: 'tool-intents',
    turnId: 't1',
    round: 0,
    intents: [
      { opId: 'o', callId: 'c', name: 'echo', args: s },
      { opId: 'p', callId: 'd', name: 'echo', args: '{}' },
    ],
  });
  t.deepEqual(blobsOf(intents), [s.blob]);
});

test('progress: checkpoints replace each other outside the log; a round with roundFinal records no Partial', async t => {
  const s = await setup();
  const req = await start(s);
  req.sink.progress(progress(0, staged('one')));
  req.sink.progress(progress(0, staged('two')));
  t.deepEqual(s.kinds(), ['turn-started', 'dispatched'], 'nothing recorded');
  req.sink.roundFinal(result(0, 'done'));
  await drain();
  t.deepEqual(s.kinds(), [
    'turn-started',
    'dispatched',
    'round-settled',
    'turn-settled',
  ]);
});

test('progress: a cancel while the round streams appends the latest checkpoint as one Partial', async t => {
  const s = await setup();
  const req = await start(s);
  const latest = staged('latest');
  req.sink.progress(progress(0, staged('older')));
  req.sink.progress(progress(1, staged('other round'))); // ignored
  req.sink.progress(progress(0, latest));
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  const records = s.session.getHistoryPage().turns[0].records;
  const partials = records.filter(
    (/** @type {any} */ r) => r.kind === 'partial',
  );
  t.is(partials.length, 1);
  t.is(partials[0].text, latest);
  t.true(matches(partials[0], shapes.Partial));
  t.deepEqual(
    records.map((/** @type {any} */ r) => r.kind),
    ['turn-started', 'dispatched', 'partial', 'turn-settled'],
  );
  // A checkpoint after the settle is ignored.
  req.sink.progress(progress(0, staged('late')));
  t.is(
    s.session
      .getHistoryPage()
      .turns[0].records.filter((/** @type {any} */ r) => r.kind === 'partial')
      .length,
    1,
  );
});

test('progress: roundFailed uses its own partial when it has one, else the checkpoint; one Partial either way', async t => {
  const s = await setup();
  const req = await start(s);
  req.sink.progress(progress(0, staged('checkpoint')));
  req.sink.roundFailed(harden({ round: 0, reason: 'boom', at: AT + 2 }));
  await drain();
  let records = s.session.getHistoryPage().turns[0].records;
  t.deepEqual(
    records
      .filter((/** @type {any} */ r) => r.kind === 'partial')
      .map((/** @type {any} */ r) => r.text.preview),
    ['checkpoint'],
  );
  const req2 = await start(s);
  req2.sink.progress(progress(0, staged('checkpoint 2')));
  const own = staged('own partial');
  req2.sink.roundFailed(
    harden({ round: 0, reason: 'boom', at: AT + 2, partial: own }),
  );
  await drain();
  records = s.session.getHistoryPage().turns[0].records;
  const partials = records.filter(
    (/** @type {any} */ r) => r.kind === 'partial',
  );
  t.is(partials.length, 1);
  t.is(partials[0].text, own);
});

test('progress: recovery after a restart mid-stream keeps the checkpoint as the Partial', async t => {
  const s = await setup();
  const req = await start(s);
  const latest = staged('streamed so far');
  req.sink.progress(progress(0, latest));
  s.leases[0].reject(Error(`ocapn hub: ${RETIRED_TEXT}`));
  await drain();
  const page = s.session.getHistoryPage();
  t.is(page.turns[0].state, 'outcome-unknown');
  const partials = page.turns[0].records.filter(
    (/** @type {any} */ r) => r.kind === 'partial',
  );
  t.is(partials.length, 1);
  t.is(partials[0].text, latest);
});

test('staged submission: TurnStarted, round 0, events and receipts carry the StagedText; duplicates by bytes and preview', async t => {
  const s = await setup();
  const submission = staged('a long message', 20_000);
  const id = requestId();
  const receipt = s.session.enqueueOnce(submission, id, AT);
  t.is(receipt.state, 'started');
  await drain();
  const req = s.last();
  t.is(req.append[0].input, submission);
  t.is(s.session.getCurrentTurn().input, submission);
  const start0 = s
    .events()
    .find((/** @type {any} */ e) => e.type === 'turn-start');
  t.is(start0.input, submission);
  // A retry stages a new blob for the same text: same bytes and preview.
  const again = s.session.enqueueOnce(staged('a long message', 20_000), id, AT);
  t.true(again.duplicate);
  t.throws(
    () => s.session.enqueueOnce(staged('a long message', 20_001), id, AT),
    {
      message: texts.requestIdReused,
    },
  );
  t.throws(
    () => s.session.enqueueOnce(harden({ text: 'a long message' }), id, AT),
    {
      message: texts.requestIdReused,
    },
  );
  // A staged message waiting in the queue shows its preview.
  s.session.enqueueOnce(
    staged('x'.repeat(limits.messagePreviewUnits), 30_000),
    requestId(),
    AT,
  );
  const [row] = s.session.listPending().entries;
  t.is(row.preview, 'x'.repeat(limits.messagePreviewUnits));
  // Direct start with a staged submission once idle.
  req.sink.roundFinal(result(0, 'ok'));
  await drain();
});

test('staged reply and native context: RoundSettled, TurnSettled.final and the final event carry the same StagedText', async t => {
  const s = await setup();
  const req = await start(s);
  const reply = staged('reply', 1_048_576);
  const native = staged('', 300);
  req.sink.roundFinal(result(0, reply, [], native));
  await drain();
  const records = s.session.getHistoryPage().turns[0].records;
  const settled = records.find(
    (/** @type {any} */ r) => r.kind === 'round-settled',
  );
  t.is(settled.text, reply);
  t.is(settled.nativeContext, native);
  const final = records.find(
    (/** @type {any} */ r) => r.kind === 'turn-settled',
  );
  t.is(final.final, reply);
  t.true(
    s.session.getHistoryPage().turns[0].cut,
    'a staged turn is marked cut',
  );
  const finalEvent = s
    .events()
    .find((/** @type {any} */ e) => e.type === 'final');
  t.is(finalEvent.text, reply);
});

test('Turn.getContent: the turn records in full and in log order, in pages; unknown cursors refused', async t => {
  const s = await setup();
  const req = await start(s);
  // A round of 64 echo calls answered with 7 KB each: the turn is over a frame.
  const calls = Array.from({ length: 8 }, (_, i) =>
    harden({ callId: `c${i}`, name: 'nope', args: 'y'.repeat(7000) }),
  );
  req.sink.roundFinal(result(0, 'a', calls));
  await drain();
  s.last().sink.roundFinal(result(1, 'z'.repeat(8000)));
  await drain();
  const { turn } = s.session.getHistoryPage().turns[0];
  /** @type {any[]} */
  const all = [];
  let cursor;
  let pages = 0;
  do {
    const page = turn.getContent(cursor);
    pages += 1;
    all.push(...page.records);
    cursor = page.next;
  } while (cursor !== undefined);
  t.true(pages > 1, `${pages} pages`);
  t.deepEqual(
    all.map(r => r.kind),
    [
      'turn-started',
      'dispatched',
      'round-settled',
      'tool-intents',
      ...calls.map(() => 'tool-result'),
      'round-settled',
      'turn-settled',
    ],
  );
  t.is(all[all.length - 1].final, 'z'.repeat(8000), 'in full, not a preview');
  t.throws(() => turn.getContent('c999'), { message: texts.badCursor });
  t.throws(() => turn.getContent('h1'), { message: texts.badCursor });
});

test('tool seams: context, available(ports, services), deadline routing, staged outcomes recorded unchanged', async t => {
  /** @type {any[]} */
  const seen = [];
  /** @type {any[]} */
  const deadlines = [];
  /** @type {any[]} */
  const kits = [];
  const execVat = Far('ExecHandle', {});
  const entry = harden({
    name: 'probe',
    site: 'guest',
    describe: () =>
      harden({ name: 'probe', description: 'p', parameters: '{}' }),
    available: (/** @type {any} */ ports, /** @type {any} */ services) =>
      ports?.writers !== undefined && services?.execVat === execVat,
    execute: (
      /** @type {any} */ request,
      /** @type {any} */ _ports,
      /** @type {any} */ context,
    ) => {
      seen.push({ request, context });
      const kit = makePromiseKit();
      kits.push(kit);
      return kit.promise;
    },
    deadline: (/** @type {any} */ request, /** @type {any} */ context) => {
      deadlines.push({ request, context });
    },
  });
  const s = await setup({
    table: harden([...toolTable, entry]),
    services: { execVat },
  });
  const req = await start(s);
  t.true(req.tools.some((/** @type {any} */ d) => d.name === 'probe'));
  const args = staged('{"code":', 9000);
  req.sink.roundFinal(
    result(0, '', [
      harden({ callId: 'a', name: 'probe', args }),
      harden({ callId: 'b', name: 'probe', args: '{}' }),
    ]),
  );
  await drain();
  t.is(seen.length, 2);
  const [{ request, context }] = seen;
  t.is(request.args, args, 'staged args reach the entry unchanged');
  t.is(context.turn, s.session.getCurrentTurn().turn);
  t.is(context.turnId, 't1');
  t.is(context.round, 0);
  t.is(context.generation, 1);
  t.is(context.services.execVat, execVat);
  t.is(context.endpoint, s.ports.endpoint);
  req.sink.deadline(harden({ opId: request.opId }));
  req.sink.deadline(harden({ opId: 'unknown' }));
  t.is(deadlines.length, 1);
  t.is(deadlines[0].request.opId, request.opId);
  t.is(deadlines[0].context, context);
  const okText = staged('result', 40_000);
  const failedText = staged('Error: long', 40_000);
  kits[0].resolve(harden({ status: 'ok', text: okText }));
  kits[1].resolve(harden({ status: 'failed', text: failedText }));
  await drain();
  // After the result, a deadline for that op is ignored.
  req.sink.deadline(harden({ opId: request.opId }));
  t.is(deadlines.length, 1);
  const results = s.session
    .getHistoryPage()
    .turns[0].records.filter(
      (/** @type {any} */ r) => r.kind === 'tool-result',
    );
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.result, r.failed]),
    [
      [okText, false],
      [failedText, true],
    ],
  );
});

test('M1b follow-ups (J-9363): a retry whose staged text differs only past its preview is refused, by digest', async t => {
  const s = await setup();
  const id = requestId();
  /** @param {string} digest */
  const withDigest = digest =>
    harden({
      blob: Far('Blob', {}),
      preview: 'same first units',
      bytes: 20_000,
      digest,
    });
  s.session.enqueueOnce(withDigest('a'.repeat(64)), id, AT);
  // The same text staged again (a new blob, the same digest): a duplicate.
  t.true(s.session.enqueueOnce(withDigest('a'.repeat(64)), id, AT).duplicate);
  // Another text with the same length and preview: not the same submission.
  t.throws(() => s.session.enqueueOnce(withDigest('b'.repeat(64)), id, AT), {
    message: texts.requestIdReused,
  });
});
