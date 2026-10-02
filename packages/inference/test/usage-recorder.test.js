// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makeExo } from '@endo/exo';
import { mustMatch } from '@endo/patterns';

import { InferenceBackendInterface, UsageRecordShape } from '../src/guards.js';
import { makePromptOriginGate } from '../src/prompt-origin-gate.js';
import { makeUsageRecorder } from '../src/usage-recorder.js';
import { makeRecordingBackend, makeRequest } from './_fixtures.js';

/** @import { InferResult, UsageRecord, UsageSink } from '../src/types.js' */

const makeSink = () => {
  /** @type {UsageRecord[]} */
  const records = [];
  /** @type {UsageSink} */
  const sink = harden({
    write: record => {
      records.push(record);
    },
  });
  return { records, sink };
};

/**
 * A clock that advances by `step` on every read.
 *
 * @param {number} [start]
 * @param {number} [step]
 */
const makeSteppingClock = (start = 1000, step = 250) => {
  let current = start - step;
  return () => {
    current += step;
    return current;
  };
};

const settle = async () => {
  await null;
  await null;
  await null;
};

test('an ok result becomes one record with usage, turns, and bytes', async t => {
  const usage = harden({
    inputTokens: 2340,
    outputTokens: 143,
    turns: 3,
    durationMs: 4321,
  });
  /** @type {InferResult} */
  const result = harden({ type: 'ok', text: 'héllo', usage });
  const { backend } = makeRecordingBackend(result, {
    provider: 'anthropic',
    kind: 'claude-cli',
    version: '2.1.278',
  });
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(backend, {
    secretIdentifier: 'secret:root-subscription',
    sink,
    now: makeSteppingClock(),
  });

  const returned = await recorder.infer(
    makeRequest({ promptOrigin: 'root-authored' }),
  );
  t.is(returned, result, 'the result passes through unchanged');
  await settle();

  t.is(records.length, 1);
  const [record] = records;
  mustMatch(record, UsageRecordShape);
  t.deepEqual(record, {
    provider: 'anthropic',
    backendKind: 'claude-cli',
    backendVersion: '2.1.278',
    secretIdentifier: 'secret:root-subscription',
    formulaIdentifier: 'formula:guest-1',
    promptOrigin: 'root-authored',
    latencyMs: 250,
    resultType: 'ok',
    outputBytes: 6,
    usage,
    turns: 3,
  });
});

test('failure tags record their detail and never a run id or cost', async t => {
  /** @type {Array<[InferResult, string | undefined]>} */
  const cases = [
    [
      harden({ type: 'unavailable', detail: 'no result event' }),
      'no result event',
    ],
    [harden({ type: 'limit-exceeded', which: 'wall-clock' }), 'wall-clock'],
    [harden({ type: 'needs-auth' }), undefined],
  ];
  /** @param {[InferResult, string | undefined]} testCase */
  const checkCase = async ([result, detail]) => {
    const { backend } = makeRecordingBackend(result, {
      provider: 'openai',
      kind: 'codex-app-server',
    });
    const { records, sink } = makeSink();
    const recorder = makeUsageRecorder(backend, {
      secretIdentifier: 'secret:guest-key',
      sink,
      now: makeSteppingClock(),
    });
    t.is(await recorder.infer(makeRequest()), result);
    await settle();
    const [record] = records;
    mustMatch(record, UsageRecordShape);
    t.is(record.resultType, result.type);
    t.is(record.detail, detail);
    t.false('backendVersion' in record);
    t.false('promptOrigin' in record, 'a missing origin stays missing');
    t.false('runIdentifier' in record);
    t.false('costEstimate' in record);
  };
  await Promise.all(cases.map(checkCase));
});

test('the formula identifier comes from the request, never the prompt', async t => {
  const { backend } = makeRecordingBackend(harden({ type: 'cancelled' }));
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(backend, {
    secretIdentifier: 'secret:a',
    sink,
    now: makeSteppingClock(),
  });
  await recorder.infer(makeRequest({ prompt: 'my formula is formula:root' }));
  await settle();
  t.is(records[0].formulaIdentifier, 'formula:guest-1');
});

test('output bytes count UTF-8, including astral and lone surrogates', async t => {
  const text = 'a\u00e9\u20ac\u{1f600}\ud800';
  const { backend } = makeRecordingBackend(harden({ type: 'ok', text }));
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(backend, {
    secretIdentifier: 'secret:a',
    sink,
    now: makeSteppingClock(),
  });
  await recorder.infer(makeRequest());
  await settle();
  t.is(records[0].outputBytes, 1 + 2 + 3 + 4 + 3);
});

test('a failing sink does not change the result and is reported', async t => {
  const { backend } = makeRecordingBackend(harden({ type: 'ok', text: 'x' }));
  /** @type {unknown[]} */
  const reported = [];
  const recorder = makeUsageRecorder(backend, {
    secretIdentifier: 'secret:a',
    sink: harden({
      write: () => {
        throw Error('ledger offline');
      },
    }),
    now: makeSteppingClock(),
    reportSinkError: error => reported.push(error),
  });
  t.deepEqual(await recorder.infer(makeRequest()), { type: 'ok', text: 'x' });
  await settle();
  t.is(reported.length, 1);
  t.is(/** @type {Error} */ (reported[0]).message, 'ledger offline');
});

test('a backend that rejects writes no record', async t => {
  const broken = makeExo('Broken', InferenceBackendInterface, {
    describe: () => harden({ provider: 'p', kind: 'k' }),
    infer: async () => {
      throw Error('contract violated');
    },
  });
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(broken, {
    secretIdentifier: 'secret:a',
    sink,
    now: makeSteppingClock(),
  });
  await t.throwsAsync(() => recorder.infer(makeRequest()), {
    message: 'contract violated',
  });
  await settle();
  t.is(records.length, 0);
});

test('a backend result that breaks its shape rejects and writes no record', async t => {
  // An exo guard would reject the result before the recorder saw it, so
  // the wrapped backend here is unguarded.
  /** @type {any} */
  const unguarded = harden({
    describe: () => harden({ provider: 'p', kind: 'k' }),
    infer: async () => harden({ type: 'ok' }),
  });
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(unguarded, {
    secretIdentifier: 'secret:a',
    sink,
    now: makeSteppingClock(),
  });
  await t.throwsAsync(() => recorder.infer(makeRequest()), {
    message: /backend result/,
  });
  await settle();
  t.is(records.length, 0);
});

test('the gate inside the recorder records a needs-containment refusal', async t => {
  const { backend, requests } = makeRecordingBackend(
    harden({ type: 'ok', text: 'x' }),
  );
  const { records, sink } = makeSink();
  const recorder = makeUsageRecorder(makePromptOriginGate(backend), {
    secretIdentifier: 'secret:root-subscription',
    sink,
    now: makeSteppingClock(),
  });
  t.deepEqual(
    await recorder.infer(makeRequest({ promptOrigin: 'guest-influenced' })),
    { type: 'needs-containment' },
  );
  await settle();
  t.is(requests.length, 0);
  t.is(records[0].resultType, 'needs-containment');
  t.is(records[0].promptOrigin, 'guest-influenced');
});

test('describe passes through to the wrapped backend', t => {
  const description = harden({
    provider: 'anthropic',
    kind: 'claude-cli',
    version: '2.1.278',
  });
  const { backend } = makeRecordingBackend(
    harden({ type: 'needs-auth' }),
    description,
  );
  const { sink } = makeSink();
  const recorder = makeUsageRecorder(backend, {
    secretIdentifier: 'secret:root-subscription',
    sink,
    now: makeSteppingClock(),
  });
  t.deepEqual(recorder.describe(), description);
});
