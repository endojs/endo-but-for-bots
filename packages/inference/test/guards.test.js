// @ts-check
// prefer-endo-primitives-exempt: projections and grants carry remotable functions
// (`buildMcpServer`, `release`), which only `Far` can make.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { matches, mustMatch } from '@endo/patterns';

import {
  AdmissionRefusalShape,
  ClassifiedResultShape,
  CredentialSourceInterface,
  InferLimitsShape,
  InferRequestShape,
  InferResultShape,
  InferenceBackendInterface,
  UsageRecordShape,
} from '../src/guards.js';
import { makeRecordingBackend, makeRequest } from './_fixtures.js';

/** @import { CredentialGrant, CredentialRefusal } from '../src/types.js' */

const everyResult = harden([
  { type: 'ok', text: 'done' },
  {
    type: 'ok',
    text: 'done',
    usage: { inputTokens: 2340, outputTokens: 143, turns: 3, durationMs: 4321 },
  },
  { type: 'needs-auth' },
  { type: 'usage-exhausted' },
  { type: 'usage-exhausted', retryAfterMs: 60_000 },
  { type: 'rate-limited', retryAfterMs: 0 },
  { type: 'budget-exhausted', retryAfterMs: 5 },
  { type: 'limit-exceeded', which: 'wall-clock' },
  { type: 'limit-exceeded', which: 'output-bytes' },
  { type: 'limit-exceeded', which: 'max-turns' },
  { type: 'cancelled' },
  { type: 'needs-containment' },
  { type: 'unavailable', detail: 'no result event' },
]);

test('every tag of the taxonomy matches InferResultShape', t => {
  for (const result of everyResult) {
    t.true(matches(result, InferResultShape), JSON.stringify(result));
  }
});

test('retired and malformed tags do not match InferResultShape', t => {
  const rejected = harden([
    { type: 'bridge-down' },
    { type: 'facet-threw' },
    { type: 'nonzero-exit' },
    { type: 'parse-error' },
    { type: 'pool-exhausted' },
    { type: 'unavailable', reason: 'renamed to detail' },
    { type: 'unavailable' },
    { type: 'limit-exceeded', which: 'budget' },
    { type: 'usage-exhausted', resetAt: 1 },
    { type: 'rate-limited', retryAfterMs: -1 },
    { type: 'ok' },
    { type: 'ok', text: 'x', usage: { costUsd: 0.08 } },
  ]);
  for (const result of rejected) {
    t.false(matches(result, InferResultShape), JSON.stringify(result));
  }
});

test('the classifier range excludes ok and needs-containment', t => {
  t.false(matches(harden({ type: 'ok', text: 'x' }), ClassifiedResultShape));
  t.false(
    matches(harden({ type: 'needs-containment' }), ClassifiedResultShape),
  );
  t.true(matches(harden({ type: 'needs-auth' }), ClassifiedResultShape));
});

test('limits must be positive numbers', t => {
  const good = { maxWallClockMs: 1, maxOutputBytes: 1, maxTurns: 1 };
  t.true(matches(harden(good), InferLimitsShape));
  t.false(matches(harden({ ...good, maxTurns: 0 }), InferLimitsShape));
  t.false(matches(harden({ ...good, maxWallClockMs: -5 }), InferLimitsShape));
  t.false(matches(harden({ ...good, maxOutputBytes: '1' }), InferLimitsShape));
  t.false(matches(harden({ ...good, maxTurns: NaN }), InferLimitsShape));
  t.false(
    matches(
      harden({ wallClockMs: 1, outputBytes: 1, maxTurns: 1 }),
      InferLimitsShape,
    ),
  );
});

test('a request admits a missing or unknown prompt origin', t => {
  t.true(matches(makeRequest(), InferRequestShape));
  t.true(
    matches(makeRequest({ promptOrigin: 'root-authored' }), InferRequestShape),
  );
  t.true(
    matches(makeRequest({ promptOrigin: 'something-else' }), InferRequestShape),
  );
});

test('a request requires a projection, limits, and a cancellation promise', t => {
  const request = makeRequest();
  const { cancelled: _cancelled, ...withoutCancelled } = request;
  t.false(matches(harden(withoutCancelled), InferRequestShape));
  t.throws(
    () =>
      mustMatch(
        harden({
          ...request,
          guest: { ...request.guest, buildMcpServer: () => {} },
        }),
        InferRequestShape,
      ),
    undefined,
    'a plain function is not a remotable',
  );
  t.false(
    matches(
      harden({ ...request, guest: { toolNames: [], formulaIdentifier: 'f' } }),
      InferRequestShape,
    ),
  );
  t.false(
    matches(harden({ ...request, secretIdentifier: 'x' }), InferRequestShape),
    'a request cannot name a credential',
  );
});

test('the backend interface guard rejects a malformed request', async t => {
  const { backend, requests } = makeRecordingBackend(
    harden({ type: 'cancelled' }),
  );
  const request = makeRequest();
  await t.throwsAsync(() =>
    backend.infer(
      /** @type {any} */ (harden({ ...request, limits: { maxTurns: 1 } })),
    ),
  );
  t.is(requests.length, 0);
  t.deepEqual(await backend.infer(request), { type: 'cancelled' });
});

test('the backend interface guard rejects a result outside the taxonomy', async t => {
  const backend = makeExo(
    'Broken',
    InferenceBackendInterface,
    /** @type {any} */ ({
      describe: () => harden({ provider: 'p', kind: 'k' }),
      infer: async () => harden({ type: 'bridge-down' }),
    }),
  );
  await t.throwsAsync(() => backend.infer(makeRequest()));
});

test('credential source interface admits a grant or a refusal', async t => {
  /** @type {Array<CredentialGrant | CredentialRefusal>} */
  const outcomes = [
    harden({
      type: 'granted',
      env: { TOKEN: 'lease' },
      release: Far('release', () => {}),
    }),
    harden({
      type: 'refused',
      admission: { reason: 'budget-exhausted', retryAfterMs: 10 },
    }),
  ];
  await Promise.all(
    outcomes.map(async outcome => {
      const source = makeExo('Source', CredentialSourceInterface, {
        acquire: async () => outcome,
      });
      t.is(await source.acquire(), outcome);
    }),
  );
  const leaky = makeExo(
    'Leaky',
    CredentialSourceInterface,
    /** @type {any} */ ({
      acquire: async () =>
        harden({
          type: 'granted',
          env: { TOKEN: 7 },
          release: Far('release', () => {}),
        }),
    }),
  );
  await t.throwsAsync(() => leaky.acquire());
});

test('admission refusal reasons are closed', t => {
  t.true(matches(harden({ reason: 'rate-limited' }), AdmissionRefusalShape));
  t.false(matches(harden({ reason: 'needs-auth' }), AdmissionRefusalShape));
  t.false(matches(harden({ reason: 'limit-exceeded' }), AdmissionRefusalShape));
});

test('a usage record carries a secretIdentifier and no credential field', t => {
  const record = harden({
    provider: 'anthropic',
    backendKind: 'claude-cli',
    secretIdentifier: 'secret:root-subscription',
    formulaIdentifier: 'formula:guest-1',
    latencyMs: 4971,
    resultType: 'ok',
  });
  mustMatch(record, UsageRecordShape);
  t.false(
    matches(harden({ ...record, credential: 'bytes' }), UsageRecordShape),
  );
  t.false(
    matches(harden({ ...record, resultType: 'bridge-down' }), UsageRecordShape),
  );
  t.true(
    matches(
      harden({
        ...record,
        runIdentifier: 'run-1',
        costEstimate: 0.006,
        verifiedEffect: true,
      }),
      UsageRecordShape,
    ),
  );
});
