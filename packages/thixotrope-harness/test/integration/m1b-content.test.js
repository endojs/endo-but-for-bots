// @ts-check
/**
 * M1b acceptance 2 and 7 (milestones.md M1b), observable through the public
 * objects of a real daemon and the fake provider's log (W1b.6):
 *
 * 2. An `exec` returning 100,000 characters is cut to 32,768 units with the
 *    exact R4-46 marker, without splitting a surrogate pair (the test puts
 *    one across the cut); the fake provider receives exactly that text in
 *    the next round (its `context` line's digest of the turn equals the
 *    digest of the transcript this test builds from the text it computed).
 * 7. A 1 MiB scripted reply and a 300 KiB `exec` body: the transcript
 *    content is complete through `Turn.getContent` and `Content`; the next
 *    round's provider request contains the full reply; an exec body over
 *    `execSourceBytes` gets the "exec source too large" result. A 200 KiB
 *    exec body under the limit is staged, read by the exec vat in pages and
 *    evaluated whole (its side effect is visible to the next call).
 *
 * State: the m1b template (real session and exec programs, default pool).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-content -- \
 *     corepack yarn test test/integration/m1b-content.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { boundToolOutput } from '../../guest/lib/bounded.js';
import { textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
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
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import {
  contextLine,
  expectedTurnTranscript,
  isStaged,
  loadTexts,
  readField,
  runTurn,
  turnDigest,
  turnRecords,
} from './_m1b.js';

takeIntegrationLock(test, 'm1b content test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

// ---- acceptance 2: the rendered exec result is exactly 100,000 units
// (a string renders as its JSON text: two quotes), with a surrogate pair
// whose high half is the last unit the cut would keep.
const RENDERED_UNITS = 100_000;
const MARKER_UNITS = textOf.truncationMarker(RENDERED_UNITS).length;
const CUT_AT = limits.toolOutputUnits - MARKER_UNITS;
// Rendered index CUT_AT - 1 is the high surrogate: string index CUT_AT - 2.
const A_UNITS = CUT_AT - 2;
const B_UNITS = RENDERED_UNITS - 2 - A_UNITS - 2;
const EXPECTED_STRING = `${'a'.repeat(A_UNITS)}\u{1F600}${'b'.repeat(B_UNITS)}`;
const EXPECTED_RENDERED = JSON.stringify(EXPECTED_STRING, null, 2);
const EXPECTED_CUT = boundToolOutput(EXPECTED_RENDERED);
const CUT_CODE = `return 'a'.repeat(${A_UNITS}) + '\\u{1F600}' + 'b'.repeat(${B_UNITS});`;

// ---- acceptance 7
/** 64 chunks of 16 KiB (ASCII) and one of multi-byte text: 1 MiB + 6 units. */
const BIG_PIECE = '0123456789abcdef';
const BIG_TAIL = 'é\u{1F600}中!';
const BIG_REPLY = `${BIG_PIECE.repeat(1024 * 64)}${BIG_TAIL}`;
/** About 205 KB of statements: staged, under execSourceBytes. */
const STAGED_LINE = 'globalThis.n = (globalThis.n ?? 0) + 1;\n';
const STAGED_REPEAT = 5000;
/** About 300 KiB: over execSourceBytes. */
const TOO_LARGE_LINE = `// ${'p'.repeat(60)}\n`;
const TOO_LARGE_REPEAT = 4800;

/** @param {string} code */
const execCall = code => ({ name: 'exec', args: JSON.stringify({ code }) });

const script = harden({
  turns: [
    {
      input: 'exec cut',
      rounds: [
        {
          chunks: [{ text: 'cutting' }],
          toolCalls: [execCall(CUT_CODE)],
          usage,
        },
        { chunks: [{ text: 'seen the cut' }], usage },
      ],
    },
    {
      input: 'big reply',
      rounds: [
        {
          chunks: [
            ...Array.from({ length: 64 }, () => ({
              text: BIG_PIECE,
              repeat: 1024,
            })),
            { text: BIG_TAIL },
          ],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ok' }) }],
          nativeContext: 'native of the big reply',
          usage,
        },
        { chunks: [{ text: 'after the big reply' }], usage },
      ],
    },
    {
      input: 'exec staged',
      rounds: [
        {
          chunks: [{ text: 'staged source' }],
          toolCalls: [
            {
              name: 'exec',
              code: { text: STAGED_LINE, repeat: STAGED_REPEAT },
            },
          ],
          usage,
        },
        { chunks: [{ text: 'ran' }], usage },
      ],
    },
    {
      input: 'exec n',
      rounds: [
        {
          chunks: [{ text: 'n?' }],
          toolCalls: [execCall('return n;')],
          usage,
        },
        { chunks: [{ text: 'got n' }], usage },
      ],
    },
    {
      input: 'exec too large',
      rounds: [
        {
          chunks: [{ text: 'too large' }],
          toolCalls: [
            {
              name: 'exec',
              code: { text: TOO_LARGE_LINE, repeat: TOO_LARGE_REPEAT },
            },
          ],
          usage,
        },
        { chunks: [{ text: 'refused' }], usage },
      ],
    },
    { rounds: [{ chunks: [{ text: 'hello' }], usage }] },
  ],
});

/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  const template = await execTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  const session = await slice.createSession(made.backend, 'content');
  const live = await slice.subscribe(session);
  t.teardown(() => live.stop());
  const content = await E(slice.admin).content();
  return { state, slice, made, session, live, content };
};

/** A lone surrogate anywhere. */
const LONE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The round-1 context line of a turn, and the digest of the turn as this
 * test expects the provider to have received it (its records before round
 * 1, staged texts read through Content).
 * @param {any} made
 * @param {any} content
 * @param {string} turnId
 * @param {any[]} records
 */
const roundOneContext = async (made, content, turnId, records) => {
  const [line] = await waitFor(
    () => {
      const lines = contextLine(made.log(), turnId, 1);
      return lines.length ? lines : undefined;
    },
    10_000,
    'the round 1 context line',
  );
  const before = records.filter(
    r => r.round === undefined || Number(r.round) < 1,
  );
  const textOfField = await loadTexts(content, before);
  const expected = expectedTurnTranscript(before, textOfField);
  const received = line.turnDigests.split(' ');
  return { line, expected, lastReceived: received[received.length - 1] };
};

run(
  '2: an exec result of 100,000 units is cut to 32,768 with the marker, no split pair; the provider gets exactly that',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, made, session, live, content } = await open(t);
    t.is(EXPECTED_RENDERED.length, RENDERED_UNITS);
    // The cut would split the pair: the high surrogate is dropped.
    t.is(EXPECTED_CUT.length, limits.toolOutputUnits - 1);
    const t0 = performance.now();
    const { turn, turnId, end } = await runTurn(
      slice,
      session,
      live,
      'exec cut',
      120_000,
    );
    const turnMs = round1(performance.now() - t0);
    t.is(end.status, 'completed');
    const records = await turnRecords(turn);
    const result = records.find(r => r.kind === 'tool-result');
    t.falsy(result.failed);
    t.true(isStaged(result.result), 'the cut result is staged');
    const text = await readField(content, result.result);
    t.true(text.length <= limits.toolOutputUnits);
    t.true(
      text.endsWith(textOf.truncationMarker(RENDERED_UNITS)),
      'the exact R4-46 marker',
    );
    t.false(LONE.test(text), 'no surrogate pair is split');
    t.is(text, EXPECTED_CUT);
    t.is(result.result.bytes, Buffer.byteLength(EXPECTED_CUT));
    // The live tool_result event carries the same staged handle's preview.
    const { line, expected, lastReceived } = await roundOneContext(
      made,
      content,
      turnId,
      records,
    );
    t.is(expected.find(r => r.kind === 'tool-result')?.content, EXPECTED_CUT);
    t.is(
      lastReceived,
      turnDigest(expected),
      'the provider got exactly the cut',
    );
    emit({
      metric: 'm1b.acceptance2',
      turnMs,
      resultUnits: text.length,
      resultBytes: result.result.bytes,
      contextMs: line.ms,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  },
);

run(
  '7: a 1 MiB reply and a 300 KiB exec body: content complete, the next round gets the full reply, too large refused',
  async t => {
    t.timeout(4.5 * 60_000);
    const { slice, made, session, live, content } = await open(t);

    // ---- the 1 MiB reply
    const t0 = performance.now();
    const big = await runTurn(slice, session, live, 'big reply', 180_000);
    const bigMs = round1(performance.now() - t0);
    t.is(big.end.status, 'completed');
    const records = await turnRecords(big.turn);
    const settled = records.find(
      r => r.kind === 'round-settled' && r.round === 0,
    );
    t.true(isStaged(settled.text));
    t.is(settled.text.bytes, Buffer.byteLength(BIG_REPLY));
    const tRead = performance.now();
    const replyText = await readField(content, settled.text);
    const readMs = round1(performance.now() - tRead);
    t.is(replyText.length, BIG_REPLY.length);
    t.true(replyText === BIG_REPLY, 'the reply is complete through Content');
    t.is(
      await readField(content, settled.nativeContext),
      'native of the big reply',
    );
    const { line, expected, lastReceived } = await roundOneContext(
      made,
      content,
      big.turnId,
      records,
    );
    t.true(
      expected.some(r => r.role === 'assistant' && r.content === BIG_REPLY),
    );
    t.is(
      lastReceived,
      turnDigest(expected),
      'the next round received the full reply',
    );
    t.true(Number(line.bytes) > BIG_REPLY.length);

    // ---- a 205 KB exec body: staged, read in pages, evaluated whole
    const staged = await runTurn(slice, session, live, 'exec staged', 120_000);
    t.is(staged.end.status, 'completed');
    const stagedRecords = await turnRecords(staged.turn);
    const stagedIntent = stagedRecords.find(r => r.kind === 'tool-intents')
      .intents[0];
    t.true(isStaged(stagedIntent.args), 'the exec source is staged');
    const stagedArgs = JSON.stringify({
      code: STAGED_LINE.repeat(STAGED_REPEAT),
    });
    t.is(await readField(content, stagedIntent.args), stagedArgs);
    const ranResult = stagedRecords.find(r => r.kind === 'tool-result');
    t.falsy(ranResult.failed, String(ranResult.result).slice(0, 200));
    const n = await runTurn(slice, session, live, 'exec n', 60_000);
    const nResult = (await turnRecords(n.turn)).find(
      r => r.kind === 'tool-result',
    );
    t.is(nResult.result, String(STAGED_REPEAT), 'every staged line ran once');

    // ---- a 300 KiB exec body: refused
    const tooLargeArgs = JSON.stringify({
      code: TOO_LARGE_LINE.repeat(TOO_LARGE_REPEAT),
    });
    const argsBytes = Buffer.byteLength(tooLargeArgs);
    t.true(argsBytes > limits.execSourceBytes);
    const large = await runTurn(
      slice,
      session,
      live,
      'exec too large',
      120_000,
    );
    t.is(large.end.status, 'completed');
    const largeRecords = await turnRecords(large.turn);
    const largeIntent = largeRecords.find(r => r.kind === 'tool-intents')
      .intents[0];
    t.is(
      await readField(content, largeIntent.args),
      tooLargeArgs,
      'the 300 KiB body is complete in the transcript',
    );
    const refusal = largeRecords.find(r => r.kind === 'tool-result');
    t.true(refusal.failed);
    t.true(
      String(refusal.result).includes(
        textOf.execSourceTooLarge(argsBytes, limits.execSourceBytes),
      ),
      String(refusal.result),
    );
    // The session keeps working.
    const next = await runTurn(slice, session, live, 'hi');
    t.is(next.end.status, 'completed');
    emit({
      metric: 'm1b.acceptance7',
      replyTurnMs: bigMs,
      replyBytes: settled.text.bytes,
      replyReadMs: readMs,
      roundOneContextMs: line.ms,
      roundOneContextBytes: line.bytes,
      stagedSourceBytes: Buffer.byteLength(stagedArgs),
      tooLargeBytes: argsBytes,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  },
);
