// @ts-check
// The compaction plan (resources/agent-host/impl/providers/compaction.js
// `planCompaction`; designs/m8-interfaces.md 5.2, D-M8-4, D-M8-7, D-M8-14):
// candidates, the pin, the directive, the tail budget, the newest group as
// the fallback, every refusal of the plan, and image sizing. Records come
// from the real record log; the plan is pure, so no store or vat is needed.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { contextLimits } from '../../guest/lib/guards/context.js';
import { imageTextOf } from '../../guest/lib/image-guards.js';
/* eslint-enable import/no-relative-packages */
import {
  planCompaction,
  wireBytes,
} from '../../resources/agent-host/impl/providers/compaction.js';
import { compactionSkipTexts } from '../../resources/agent-host/impl/providers/compaction-texts.js';
import { askOf, imageEnvelope, makeTurnLog } from './_compaction-records.js';

/** @import { CompactionPlan as Plan } from '../../resources/agent-host/impl/providers/compaction.js' */

const SYSTEM = 'You are a test assistant.';
const TOOLS = harden([{ name: 'echo', description: 'echo', parameters: {} }]);

/** @param {number} n */
const filler = n => 'r'.repeat(n);

/**
 * `turns` completed turns with one tool call each (results of `size`
 * characters), then the current turn's start and the ask's record.
 * @param {number} turns
 * @param {number} size
 */
const history = (turns, size) => {
  const log = makeTurnLog();
  const done = [];
  for (let i = 0; i < turns; i += 1) {
    done.push(
      log.turn({
        rounds: [
          { text: `calling ${i}`, calls: [{ result: filler(size) }] },
          { text: `answer ${i}` },
        ],
      }),
    );
  }
  const current = log.turn({
    input: 'the directive',
    rounds: [],
    status: null,
  });
  const askedAt = log.started(current.turnId, 0);
  return { log, done, current, askedAt };
};

/**
 * @param {ReturnType<typeof history>} h
 * @param {Partial<import('../../resources/agent-host/impl/providers/compaction.js').CompactionAsk>} [fields]
 */
const planOf = (h, fields = {}) =>
  planCompaction({
    input: h.log.planInput(),
    ask: askOf({
      askedAt: h.askedAt,
      startIndex: h.current.startIndex,
      ...fields,
    }),
    system: SYSTEM,
    tools: TOOLS,
  });

/** @param {any} plan */
const contents = plan => plan.map((/** @type {any} */ e) => e.content);

test('the boundary is a cut among the candidates, within the tail budget', t => {
  const h = history(8, 2000);
  const plan = /** @type {Plan} */ (planOf(h));
  t.false('refuse' in plan);
  const record = h.log.records.at(plan.boundary);
  t.true(
    record.kind === 'turn-started' ||
      (record.kind === 'round-settled' && Number(record.round) > 0),
  );
  t.true(plan.boundary > 0 && plan.boundary <= h.askedAt);
  // Original bytes scaled by threshold over used (70 / 80).
  t.is(plan.headroomBytes, Math.floor((plan.originalBytes * 70) / 80));
  const baseBytes = wireBytes({
    system: SYSTEM,
    transcript: [{ kind: 'message', role: 'user', content: 'the directive' }],
    tools: TOOLS,
  });
  const budget = Math.floor(
    (plan.headroomBytes - baseBytes) / contextLimits.tailHeadroomDivisor,
  );
  // Groups are sized one by one; the joined array adds a comma per group.
  t.true(wireBytes(plan.retained) <= budget + 16);
  // The prefix holds the oldest completed work, the tail the newest turn.
  t.true(contents(plan.prefix).includes('input of t1'));
  t.true(contents(plan.retained).includes('the directive'));
  t.false(contents(plan.retained).includes('input of t1'));
  // The boundary is at or before the directive: it is in the tail itself.
  t.true(plan.boundary <= h.current.startIndex);
  t.false('directive' in plan);
  // One more group would not have fitted: the next cut back is a turn start
  // whose group holds a whole 2,000-character result.
  t.true(wireBytes(plan.retained) + 2000 > budget);
});

test('candidates start above the current boundary and the floor', t => {
  const h = history(8, 2000);
  const floor = h.done[6].startIndex;
  const plan = /** @type {Plan} */ (planOf(h, { floor }));
  t.false('refuse' in plan);
  t.true(plan.boundary >= floor);
  const boundary = h.done[7].startIndex;
  const later = /** @type {Plan} */ (planOf(h, { boundary }));
  t.true(later.boundary > boundary);
  // No candidate above the boundary: nothing to summarize.
  const none = planOf(h, { boundary: h.current.startIndex });
  t.deepEqual(none, { refuse: compactionSkipTexts.nothingToSummarize });
});

test('the newest group is the tail when none fits; the directive is anchored', t => {
  const log = makeTurnLog();
  log.turn({ rounds: [{ text: 'earlier' }] });
  const current = log.turn({
    input: 'keep this directive',
    rounds: [
      { text: 'step 0', calls: [{ result: filler(20_000) }] },
      { text: 'step 1', calls: [{ result: filler(20_000) }] },
    ],
    status: null,
  });
  const askedAt = log.started(current.turnId, 2);
  const plan = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in plan);
  // C_last: round 1's settlement (the newest candidate).
  t.is(plan.boundary, current.settled[1]);
  t.deepEqual(plan.directive, {
    kind: 'message',
    role: 'user',
    content: 'keep this directive',
  });
  t.false(contents(plan.retained).includes('keep this directive'));
  t.is(plan.retained[0].content, 'step 1');
  // Round 0's call and result are summarized, whole.
  const kinds = plan.prefix.map((/** @type {any} */ e) => e.kind);
  t.true(kinds.includes('tool-call') && kinds.includes('tool-result'));
});

test('an unresolved unknown outcome pins the boundary at its turn', t => {
  const log = makeTurnLog();
  const turns = [];
  for (let i = 0; i < 6; i += 1) {
    turns.push(
      log.turn({
        rounds: [
          {
            text: `t${i}`,
            calls: [{ result: filler(3000), unknown: i === 2 }],
          },
          { text: `after ${i}` },
        ],
        status: i === 2 ? 'outcome-unknown' : 'completed',
      }),
    );
  }
  const current = log.turn({ input: 'go on', rounds: [], status: null });
  const askedAt = log.started(current.turnId, 0);
  const ask = askOf({ askedAt, startIndex: current.startIndex });
  const pinned = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask,
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in pinned);
  t.true(pinned.boundary <= turns[2].startIndex);
  // The unknown outcome stays visible verbatim.
  t.true(
    pinned.retained.some(
      (/** @type {any} */ e) =>
        e.kind === 'tool-result' &&
        e.content.startsWith('Tool outcome unknown'),
    ),
  );
  // Resolved: the pin is gone and the boundary moves past it.
  log.resolve(turns[2].turnId);
  const later = log.turn({ input: 'next', rounds: [], status: null });
  const askedLater = log.started(later.turnId, 0);
  const freed = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt: askedLater, startIndex: later.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in freed);
  t.true(freed.boundary > turns[2].startIndex);
  t.true(
    freed.prefix.some(
      (/** @type {any} */ e) =>
        e.kind === 'tool-result' &&
        e.content.startsWith('Tool outcome unknown'),
    ),
  );
});

test('a pin at the first kept turn refuses as pinned', t => {
  const log = makeTurnLog();
  log.turn({
    rounds: [{ text: 'x', calls: [{ unknown: true }] }],
    status: 'outcome-unknown',
  });
  log.turn({ rounds: [{ text: 'y', calls: [{ result: filler(3000) }] }, {}] });
  const current = log.turn({ input: 'go', rounds: [], status: null });
  const askedAt = log.started(current.turnId, 0);
  t.deepEqual(
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    }),
    { refuse: compactionSkipTexts.pinnedByUnknownOutcome },
  );
});

test('refusals: nothing completed, a user request alone, the fixed parts', t => {
  // Round 0 of the first turn: no candidate above the boundary.
  const first = makeTurnLog();
  const only = first.turn({ input: 'hello', rounds: [], status: null });
  t.deepEqual(
    planCompaction({
      input: first.planInput(),
      ask: askOf({ askedAt: first.started(only.turnId, 0) }),
      system: SYSTEM,
      tools: TOOLS,
    }),
    { refuse: compactionSkipTexts.nothingToSummarize },
  );
  // A turn that never reached a provider is no completed work.
  const lone = makeTurnLog();
  lone.turn({ input: 'never sent', dispatched: false, status: 'interrupted' });
  const current = lone.turn({
    input: 'again',
    rounds: [{ text: 'working', calls: [{ result: filler(5000) }] }],
    status: null,
  });
  t.deepEqual(
    planCompaction({
      input: lone.planInput(),
      ask: askOf({
        askedAt: lone.started(current.turnId, 1),
        startIndex: current.startIndex,
      }),
      system: SYSTEM,
      tools: TOOLS,
    }),
    { refuse: compactionSkipTexts.nothingToSummarize },
  );
  // The system text alone over the headroom.
  const h = history(3, 100);
  t.deepEqual(
    planCompaction({
      input: h.log.planInput(),
      ask: askOf({ askedAt: h.askedAt, startIndex: h.current.startIndex }),
      system: 's'.repeat(100_000),
      tools: TOOLS,
    }),
    { refuse: compactionSkipTexts.headroomExceeded },
  );
});

test('a staged directive is read from the texts map', t => {
  const log = makeTurnLog();
  for (let i = 0; i < 3; i += 1) {
    log.turn({
      rounds: [{ text: 'a', calls: [{ result: filler(4000) }] }, {}],
    });
  }
  const current = log.turn({
    input: log.staged('a long staged directive'),
    rounds: [{ text: 'b', calls: [{ result: filler(30_000) }] }],
    status: null,
  });
  log.records.append({
    kind: 'round-settled',
    turnId: current.turnId,
    round: 1,
    text: 'c',
    callCount: 1,
    usage: log.records.at(current.settled[0]).usage,
    at: 1,
  });
  log.records.append({
    kind: 'tool-intents',
    turnId: current.turnId,
    round: 1,
    intents: [{ opId: 'last', callId: '', name: 'echo', args: '{}' }],
  });
  log.records.append({
    kind: 'tool-result',
    turnId: current.turnId,
    opId: 'last',
    name: 'echo',
    result: filler(30_000),
    failed: false,
  });
  const askedAt = log.started(current.turnId, 2);
  const plan = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in plan);
  t.true(plan.boundary > current.startIndex);
  t.is(plan.directive.content, 'a long staged directive');
});

test('an image result counts imageSizingBytes and its receipt, not its envelope', t => {
  const log = makeTurnLog();
  const envelope = imageEnvelope(300_000);
  log.turn({
    rounds: [
      {
        text: 'looking',
        calls: [
          {
            name: 'viewImage',
            args: '{"petName":"shot"}',
            result: log.staged(envelope),
          },
        ],
      },
      { text: 'seen' },
    ],
  });
  log.turn({
    rounds: [{ text: 'more', calls: [{ result: filler(500) }] }, {}],
  });
  const current = log.turn({ input: 'next', rounds: [], status: null });
  const askedAt = log.started(current.turnId, 0);
  const plan = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in plan);
  t.true(plan.originalBytes < 20_000, `${plan.originalBytes}`);
  t.true(plan.originalBytes > contextLimits.imageSizingBytes);
  // The envelope's bytes never count: the same history with a short
  // non-image result differs by about imageSizingBytes plus the receipt.
  const plain = makeTurnLog();
  plain.turn({
    rounds: [
      {
        text: 'looking',
        calls: [{ name: 'viewImage', args: '{"petName":"shot"}', result: '' }],
      },
      { text: 'seen' },
    ],
  });
  plain.turn({
    rounds: [{ text: 'more', calls: [{ result: filler(500) }] }, {}],
  });
  const now = plain.turn({ input: 'next', rounds: [], status: null });
  const other = /** @type {Plan} */ (
    planCompaction({
      input: plain.planInput(),
      ask: askOf({
        askedAt: plain.started(now.turnId, 0),
        startIndex: now.startIndex,
      }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  const receipt = imageTextOf.receipt('image/png');
  t.is(
    plan.originalBytes - other.originalBytes,
    contextLimits.imageSizingBytes + Buffer.byteLength(receipt),
  );
});

test('a sealed part and its latest marker: the previous summary leads the prefix', t => {
  const log = makeTurnLog();
  for (let i = 0; i < 6; i += 1) {
    log.turn({
      rounds: [{ text: `a${i}`, calls: [{ result: filler(2000) }] }, {}],
    });
  }
  const current = log.turn({ input: 'directive', rounds: [], status: null });
  const askedAt = log.started(current.turnId, 0);
  const sealed = harden([
    { kind: 'compaction', epoch: 1, summary: 'old summary' },
    { kind: 'message', role: 'user', content: 'sealed question' },
    { kind: 'message', role: 'assistant', content: 'sealed answer' },
    {
      kind: 'compaction',
      epoch: 2,
      summary: 'newer summary',
      directive: 'its directive',
    },
  ]);
  const plan = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(sealed),
      ask: askOf({ askedAt, startIndex: current.startIndex, epoch: 3 }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in plan);
  t.deepEqual(plan.prefix.slice(0, 4), [
    { kind: 'message', role: 'assistant', content: 'newer summary' },
    { kind: 'message', role: 'user', content: 'its directive' },
    { kind: 'message', role: 'user', content: 'sealed question' },
    { kind: 'message', role: 'assistant', content: 'sealed answer' },
  ]);
  t.false(plan.prefix.some((/** @type {any} */ e) => e.kind === 'compaction'));
  t.false(contents(plan.prefix).includes('old summary'));
});

test('a settled turn cut at a later round keeps its remainder in the tail', t => {
  const log = makeTurnLog();
  const cut = log.turn({
    rounds: [
      { text: 'round 0', calls: [{ result: filler(8000) }] },
      { text: 'round 1', calls: [{ result: filler(8000) }] },
      { text: 'round 2 of the cut turn' },
    ],
  });
  const current = log.turn({ input: 'short', rounds: [], status: null });
  const askedAt = log.started(current.turnId, 0);
  const plan = /** @type {Plan} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system: SYSTEM,
      tools: TOOLS,
    })
  );
  t.false('refuse' in plan);
  t.is(plan.boundary, cut.settled[2]);
  t.deepEqual(contents(plan.retained), ['round 2 of the cut turn', 'short']);
  t.true(contents(plan.prefix).includes('round 1'));
});
