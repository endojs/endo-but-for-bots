// @ts-check
/**
 * M2 acceptance 2, 3 and 12 (milestones.md M2; m2-interfaces.md 10; W2.6)
 * through the daemon, on the scripted backend, from the m1a state template
 * (the real session program in a vat).
 *
 * 2. A response with three tool calls (an unknown tool, bad JSON, a call
 *    without an id) produces the R4-43 / R4-45 texts and a synthesized id
 *    (R4-42); the turn continues.
 * 3. At the round limit (R4-95: 1,024 rounds) a turn ends completed with
 *    the R4-47 text after exactly that many requests. The behaviour at the
 *    limit is proven in Node at a limit of 2
 *    (test/adapter/m2-w26-turns.test.js); the vat's limit is the constant
 *    `limits.maxToolRounds` (a vat test at a small limit needs a
 *    `SessionConfig` field, J-9480), and a turn of 1,024 rounds takes about
 *    5 minutes in a vat (J-0471). So the vat test here measures the round
 *    rate of an always-tool turn over a fixed window (60 s, process.md 3)
 *    and derives the 1,024-round time from it; it then cancels the turn.
 * 12. A failed turn and an outcome-unknown turn (SIGKILL while its tool
 *     runs) appear in the next round's context, the unknown result as
 *     "Tool outcome unknown"; a never-dispatched (cancelled before
 *     dispatching) turn does not (R4-32). Compared by the scripted
 *     provider's per-turn digests against transcripts written here by hand.
 *
 * Also: cancel mid-stream (the scripted stream is torn down, `cancelled`
 * logged) and cancel while a tool runs (not interrupted, its result
 * recorded, no next round) (R4-7, R4-49); the composed system prompt
 * reaches every request (R4-26, seam 1); `getUsage()`, the settle's `usage`
 * event and `usageOfRecords` agree (R4-33, R4-83).
 *
 * The turn deadline is not tested here: the Endpoint drops an armDeadline
 * sent with holdTurn in one crank (J-0475; test/adapter/m2-w26-turns.test.js
 * keeps it as a known failure).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-turns -- \
 *     corepack yarn test test/integration/m2-turns.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { usageOfRecords } from '../../guest/lib/journal-usage.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
/* eslint-enable import/no-relative-packages */
import { contextDigests } from '../../resources/agent-host/impl/providers/scripted.js';
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';

takeIntegrationLock(test, 'm2 turns test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  reasoningOutputTokens: 3,
};

/** Tool rounds of the long turn test 2 runs to completion. */
const PROBE_ROUNDS = 100;

/**
 * The round-rate window (process.md 3: 60 s a measured point);
 * M2_TURNS_WINDOW_MS shortens it for a local smoke only.
 */
const ROUND_WINDOW_MS = Number(process.env.M2_TURNS_WINDOW_MS ?? 60_000);

/**
 * Per-round times from the scripted log's `request` lines of one turn: the
 * gap between consecutive requests, median of the first and last 20.
 * @param {any[]} requests
 */
const roundTimes = requests => {
  const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
  /** @param {number[]} xs */
  const median = xs => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
  };
  return {
    rounds: requests.length,
    firstRoundsMs: median(gaps.slice(0, 20)),
    lastRoundsMs: median(gaps.slice(-20)),
    medianRoundMs: median(gaps),
  };
};

const BAD_JSON = '{"text": "unclosed';
const RISKY_ARGS = '{"text":"risky","delayMs":60000}';

const script = {
  turns: [
    {
      input: 'tools',
      rounds: [
        {
          chunks: [{ text: 'Let me try.' }],
          toolCalls: [
            { name: 'nope', args: '{}', callId: 'call-a' },
            { name: 'echo', args: BAD_JSON, callId: 'call-b' },
            { name: 'echo', args: '{"text":"fine"}' },
          ],
          usage,
        },
        { chunks: [{ text: 'All done.' }], usage },
      ],
    },
    {
      input: 'loop',
      rounds: [
        {
          toolCalls: [{ name: 'echo', args: '{"text":"again"}' }],
          usage,
          times: limits.maxToolRounds + 1,
        },
      ],
    },
    {
      input: 'rounds',
      rounds: [
        {
          toolCalls: [{ name: 'echo', args: '{"text":"round"}' }],
          usage,
          times: PROBE_ROUNDS,
        },
        { chunks: [{ text: 'finished' }], usage },
      ],
    },
    {
      input: 'stall',
      rounds: [{ chunks: [{ text: 'streaming' }], stall: 'untilCancel' }],
    },
    {
      input: 'slow tool',
      rounds: [
        {
          toolCalls: [
            { name: 'echo', args: '{"text":"slow result","delayMs":1500}' },
          ],
          usage,
        },
        { chunks: [{ text: 'never asked' }], usage },
      ],
    },
    {
      input: 'fail',
      rounds: [
        {
          chunks: [{ text: 'half an answer' }],
          error: 'upstream failed',
          usage,
        },
      ],
    },
    {
      input: 'never',
      rounds: [{ dispatchDelayMs: 30_000, chunks: [{ text: 'x' }] }],
    },
    {
      input: 'risky',
      rounds: [
        {
          chunks: [{ text: 'calling' }],
          toolCalls: [{ name: 'echo', args: RISKY_ARGS }],
          usage,
        },
      ],
    },
    { input: 'probe', rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
};

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(script));
  const session = await slice.createSession(made.backend);
  return { state, slice, session, ...made };
};

/**
 * Every record of one turn (Turn.getContent pages).
 * @param {any} turn
 */
const contentOf = async turn => {
  /** @type {any[]} */
  const out = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(turn).getContent(cursor);
    out.push(...page.records);
    if (page.next === undefined) return out;
    cursor = page.next;
  }
};

/**
 * Every record of the session, oldest turn first.
 * @param {any} session
 */
const allRecords = async session => {
  /** @type {any[]} */
  const previews = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(session).getHistoryPage(cursor);
    previews.push(...page.turns);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  previews.reverse();
  /** @type {any[]} */
  const out = [];
  for (const preview of previews) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await contentOf(preview.turn)));
  }
  return out;
};

/**
 * Submit through the Composer and return the started turn.
 * @param {any} slice
 * @param {any} session
 * @param {string} text
 */
const startTurn = async (slice, session, text) => {
  const receipt = await slice.submit(session, text);
  return waitFor(
    async () =>
      (await E(session).getSubmissionReceipt(receipt.requestId))?.turn,
    30_000,
    `the turn for ${text}`,
  );
};

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

run(
  '2: tool texts and a synthesized id; a 100-round turn; cancels; usage; the prompt reaches every request',
  async t => {
    t.timeout(4.5 * 60_000);
    const { slice, session, log } = await open(t);
    const sub = await slice.subscribe(session);
    t.teardown(() => sub.stop());

    // ---- acceptance 2
    const tools = await startTurn(slice, session, 'tools');
    t.is((await E(tools).whenFinished()).state, 'completed');
    const records = await contentOf(tools);
    const intents = records.find(r => r.kind === 'tool-intents').intents;
    t.deepEqual(
      intents.map((/** @type {any} */ i) => i.callId),
      ['call-a', 'call-b', textOf.synthesizedCallId(0, 2)],
    );
    const results = new Map(
      records.filter(r => r.kind === 'tool-result').map(r => [r.opId, r]),
    );
    const unknown = results.get(intents[0].opId);
    t.true(unknown.failed);
    t.true(
      unknown.result.startsWith(
        textOf.errorResult(textOf.unknownTool('nope', ['echo'])).slice(0, 30),
      ),
    );
    t.regex(unknown.result, /^Error: Unknown tool: "nope"\. Available tools: /);
    const bad = results.get(intents[1].opId);
    t.true(bad.failed);
    t.regex(
      bad.result,
      /^Error: could not parse tool arguments as JSON \(.+\)\. Re-send this tool call with valid JSON arguments\.$/,
    );
    t.false(results.get(intents[2].opId).failed);
    t.is(records.at(-1).final, 'All done.');
    const toolsTurnId = (await E(tools).getStatus()).turnId;
    t.deepEqual(
      log()
        .filter(l => l.kind === 'request' && l.turnId === toolsTurnId)
        .map(l => l.round),
      [0, 1],
      'the turn continued after the failed calls',
    );

    // The composed prompt (W2.6 resolver, factory copy, seam 1) is in every
    // request.
    const prompt = composeSystemPrompt({ spoken: false });
    const contexts = log().filter(l => l.kind === 'context');
    t.true(contexts.length >= 2);
    for (const line of contexts) {
      t.is(line.systemDigest, sha16(prompt));
      t.is(line.systemBytes, Buffer.byteLength(prompt));
    }

    // ---- a long turn: PROBE_ROUNDS tool rounds, then a text round. The
    // round limit's cost in a vat is the window test below.
    const t0 = performance.now();
    const many = await startTurn(slice, session, 'rounds');
    const manyStatus = await waitFor(
      async () => {
        const status = await E(many).getStatus();
        return status.state === 'running' ? undefined : status;
      },
      150_000,
      'the many-round turn',
      250,
    );
    const manyMs = performance.now() - t0;
    t.is(manyStatus.state, 'completed');
    const manyRequests = log().filter(
      l => l.kind === 'request' && l.turnId === manyStatus.turnId,
    );
    t.is(manyRequests.length, PROBE_ROUNDS + 1);
    emit({
      metric: 'm2.turns.rounds',
      unit: 'ms',
      ...roundTimes(manyRequests),
      ms: round1(manyMs),
    });

    // ---- cancel mid-stream: the scripted stream is torn down
    const stall = await startTurn(slice, session, 'stall');
    const stallId = (await E(stall).getStatus()).turnId;
    await waitFor(
      () => log().some(l => l.kind === 'request' && l.turnId === stallId),
      30_000,
      'the stalled request',
    );
    await E(stall).cancel();
    t.is((await E(stall).whenFinished()).state, 'cancelled');
    await waitFor(
      () => log().some(l => l.kind === 'cancelled' && l.turnId === stallId),
      10_000,
      'the provider to see the cancel',
    );
    await sub.until(
      e => e.type === 'end' && e.turnId === stallId && e.status === 'cancelled',
    );

    // ---- cancel while a tool runs: not interrupted, result recorded
    const slow = await startTurn(slice, session, 'slow tool');
    const slowId = (await E(slow).getStatus()).turnId;
    await waitFor(
      () =>
        log().some(
          l => l.kind === 'echo-start' && l.opId.startsWith(`${slowId}/`),
        ),
      30_000,
      'the slow tool',
    );
    await E(slow).cancel();
    t.is((await E(slow).getStatus()).state, 'cancelling');
    t.is((await E(slow).whenFinished()).state, 'cancelled');
    t.true(
      log().some(l => l.kind === 'echo-end' && l.opId.startsWith(`${slowId}/`)),
    );
    const slowResult = (await contentOf(slow)).find(
      r => r.kind === 'tool-result',
    );
    t.false(slowResult.failed);
    t.regex(slowResult.result, /slow result/);
    t.deepEqual(
      log()
        .filter(l => l.kind === 'request' && l.turnId === slowId)
        .map(l => l.round),
      [0],
      'no round after the cancel',
    );

    // ---- usage: getUsage, the last usage event and the records agree
    const totals = await E(session).getUsage();
    t.is(totals.turns, 4);
    t.is(totals.incompleteTurns, 2);
    t.deepEqual(usageOfRecords(await allRecords(session)), totals);
    const lastUsage = sub
      .events()
      .filter(e => e.type === 'usage')
      .at(-1);
    const { type: _type, turnId: _turnId, ...fromEvent } = lastUsage;
    t.deepEqual(fromEvent, totals);
    // Settled rounds: 2 of `tools`, PROBE_ROUNDS + 1 of `rounds`, 1 of
    // `slow tool` (`stall` was cancelled before its round settled).
    t.is(totals.inputTokens, usage.inputTokens * (2 + PROBE_ROUNDS + 1 + 1));
  },
);

run(
  '12: failed and outcome-unknown turns are in the next context; a never-dispatched one is not',
  async t => {
    t.timeout(4.5 * 60_000);
    const { state, slice, session, log } = await open(t);

    const fail = await startTurn(slice, session, 'fail');
    const failStatus = await E(fail).whenFinished();
    t.is(failStatus.state, 'failed');
    t.is(failStatus.error, 'upstream failed');

    const never = await startTurn(slice, session, 'never');
    const neverId = (await E(never).getStatus()).turnId;
    await waitFor(
      () => log().some(l => l.kind === 'round-start' && l.turnId === neverId),
      30_000,
      'the undispatched round',
    );
    await E(never).cancel();
    t.is((await E(never).whenFinished()).state, 'cancelled');
    t.false((await contentOf(never)).some(r => r.kind === 'dispatched'));
    t.false(log().some(l => l.kind === 'request' && l.turnId === neverId));

    const risky = await startTurn(slice, session, 'risky');
    const riskyId = (await E(risky).getStatus()).turnId;
    const start = await waitFor(
      () =>
        log().find(
          l => l.kind === 'echo-start' && l.opId.startsWith(`${riskyId}/`),
        ),
      30_000,
      'the risky tool',
    );
    const t0 = performance.now();
    await state.kill();
    const restarted = await state.restart();
    await slice.refresh();
    const again = await E(slice.factory).findSession('s1');
    const riskyState = await waitFor(
      async () => {
        const page = await E(again).getHistoryPage();
        const found = page.turns.find(
          (/** @type {any} */ p) => p.turnId === riskyId,
        );
        return found?.state === 'outcome-unknown' ? found : undefined;
      },
      60_000,
      'recovery of the risky turn',
      100,
    );
    emit({
      metric: 'm2.turns.restart',
      unit: 'ms',
      ...restarted,
      recoveredMs: round1(performance.now() - t0),
    });
    const riskyRecords = await contentOf(riskyState.turn);
    const unknown = riskyRecords.find(r => r.kind === 'tool-result');
    t.like(unknown, {
      opId: start.opId,
      result: texts.toolOutcomeUnknown,
      failed: true,
    });

    const probe = await startTurn(slice, again, 'probe');
    const probeId = (await E(probe).getStatus()).turnId;
    t.is((await E(probe).whenFinished()).state, 'completed');
    const line = log().find(
      l => l.kind === 'context' && l.turnId === probeId && l.round === 0,
    );
    t.truthy(line, 'the probe round logged its context');

    // The transcripts the projection must produce for these turns
    // (projection.js record shapes), written here from the script.
    const failTurn = [
      { kind: 'message', role: 'user', content: 'fail' },
      { kind: 'message', role: 'assistant', content: 'half an answer' },
    ];
    const neverTurn = [{ kind: 'message', role: 'user', content: 'never' }];
    const riskyTurn = [
      { kind: 'message', role: 'user', content: 'risky' },
      { kind: 'message', role: 'assistant', content: 'calling' },
      { kind: 'tool-call', id: start.opId, name: 'echo', args: RISKY_ARGS },
      {
        kind: 'tool-result',
        id: start.opId,
        content: texts.toolOutcomeUnknown,
        failed: true,
      },
    ];
    const probeTurn = [{ kind: 'message', role: 'user', content: 'probe' }];
    const expected = contextDigests([...failTurn, ...riskyTurn, ...probeTurn]);
    t.is(line.turnDigests, expected.turnDigests);
    t.is(line.records, expected.records);
    t.is(line.digest, expected.digest);
    const neverDigest = contextDigests(neverTurn).turnDigests;
    t.false(line.turnDigests.split(' ').includes(neverDigest));
  },
);

run(
  '3: the round rate of an always-tool turn over a fixed window; the 1,024-round time derived',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, session, log } = await open(t);
    // The `loop` script turn asks for a tool in every round, more rounds
    // than the limit, so only the window or the limit can end it.
    const loop = await startTurn(slice, session, 'loop');
    const loopId = (await E(loop).getStatus()).turnId;
    /** @param {any} l */
    const isRequest = l => l.kind === 'request' && l.turnId === loopId;
    const first = await waitFor(
      () => log().find(isRequest),
      30_000,
      'the first round of the loop turn',
    );
    // The window opens at the first request (the provider's clock).
    await delay(ROUND_WINDOW_MS);
    const status = await E(loop).getStatus();
    t.is(status.state, 'running', 'no limit or error ended the turn early');
    const inWindow = log().filter(
      l => isRequest(l) && l.at - first.at <= ROUND_WINDOW_MS,
    );
    // Rounds started after the first, within the window.
    const rounds = inWindow.length - 1;
    t.true(rounds > 0, 'the turn made rounds in the window');
    t.true(rounds < limits.maxToolRounds, 'the window ends before the limit');
    t.deepEqual(
      inWindow.map(l => l.round),
      inWindow.map((_, i) => i),
      'one request a round, in order',
    );
    await E(loop).cancel();
    t.is((await E(loop).whenFinished()).state, 'cancelled');
    // `roundTimes` counts requests; the window's samples are rounds.
    const { rounds: requests, ...times } = roundTimes(inWindow);
    const roundsPerSecond = (rounds * 1000) / ROUND_WINDOW_MS;
    emit({
      metric: 'm2.turns.roundRate',
      unit: 'rounds/s',
      window: ROUND_WINDOW_MS,
      samples: rounds,
      requests,
      roundsPerSecond: +roundsPerSecond.toFixed(2),
      ...times,
      // Derived, not run: the limit's rounds at the window's mean rate, and
      // at the window's last 20 gaps (any growth with the turn's length).
      limitRounds: limits.maxToolRounds,
      derivedLimitMs: Math.round(
        (limits.maxToolRounds * 1000) / roundsPerSecond,
      ),
      derivedLimitMsAtLast:
        times.lastRoundsMs === null
          ? null
          : Math.round(limits.maxToolRounds * times.lastRoundsMs),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  },
);
