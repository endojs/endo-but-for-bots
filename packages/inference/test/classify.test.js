// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { M } from '@endo/patterns';

import {
  admissionRefusalResult,
  makeShapeClassifier,
} from '../src/classify.js';

/** @import { ShapeTable } from '../src/types.js' */

// The invalid-credential retry event the #1357 evidence probe captured on
// Claude Code 2.1.278, used here as a realistic pinned row.
const authRetryPattern = M.splitRecord({
  type: 'system',
  subtype: 'api_retry',
  error_status: 401,
  error: 'authentication_failed',
});

const rateLimitPattern = M.splitRecord({
  type: 'result',
  subtype: 'rate_limited',
  retry_after_ms: M.number(),
});

/** @type {ShapeTable} */
const table = harden({
  '2.1.278': [
    { pattern: authRetryPattern, result: { type: 'needs-auth' } },
    {
      pattern: rateLimitPattern,
      result: { type: 'rate-limited' },
      retryAfterMs: response =>
        /** @type {{ retry_after_ms: number }} */ (response).retry_after_ms,
    },
  ],
});

const authRetryEvent = () => ({
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  error_status: 401,
  error: 'authentication_failed',
});

test('a pinned row classifies on its own version', t => {
  const classifier = makeShapeClassifier(table);
  t.deepEqual(classifier.versions(), ['2.1.278']);
  t.deepEqual(classifier.classify('2.1.278', authRetryEvent()), {
    type: 'needs-auth',
  });
});

test('an unpinned version never classifies, even on an identical response', t => {
  const classifier = makeShapeClassifier(table);
  t.is(classifier.classify('2.1.279', authRetryEvent()), undefined);
  t.is(classifier.classify(undefined, authRetryEvent()), undefined);
});

test('an unrecognized response does not classify', t => {
  const classifier = makeShapeClassifier(table);
  t.is(
    classifier.classify('2.1.278', { ...authRetryEvent(), error_status: 500 }),
    undefined,
  );
  t.is(classifier.classify('2.1.278', 'not an event'), undefined);
  t.is(
    classifier.classify('2.1.278', { type: 'system', callback: () => {} }),
    undefined,
    'a response that cannot be passed does not classify',
  );
});

test('a retry-later row carries the refill time it reads', t => {
  const classifier = makeShapeClassifier(table);
  t.deepEqual(
    classifier.classify('2.1.278', {
      type: 'result',
      subtype: 'rate_limited',
      retry_after_ms: 30_000,
    }),
    { type: 'rate-limited', retryAfterMs: 30_000 },
  );
  t.deepEqual(
    classifier.classify('2.1.278', {
      type: 'result',
      subtype: 'rate_limited',
      retry_after_ms: -1,
    }),
    { type: 'rate-limited' },
    'a nonsensical refill time is dropped',
  );
});

test('the table may not write ok or needs-containment', t => {
  t.throws(() =>
    makeShapeClassifier(
      /** @type {any} */ (
        harden({
          '1.0.0': [
            { pattern: M.any(), result: { type: 'ok', text: 'forged' } },
          ],
        })
      ),
    ),
  );
  t.throws(() =>
    makeShapeClassifier(
      /** @type {any} */ (
        harden({
          '1.0.0': [
            { pattern: M.any(), result: { type: 'needs-containment' } },
          ],
        })
      ),
    ),
  );
});

test('a refill reader belongs only on a retry-later row', t => {
  t.throws(
    () =>
      makeShapeClassifier(
        harden({
          '1.0.0': [
            {
              pattern: M.any(),
              result: { type: 'needs-auth' },
              retryAfterMs: () => 1,
            },
          ],
        }),
      ),
    { message: /meaningless/ },
  );
});

test('an admission refusal maps to the tag of the same name', t => {
  t.deepEqual(admissionRefusalResult({ reason: 'rate-limited' }), {
    type: 'rate-limited',
  });
  t.deepEqual(
    admissionRefusalResult({ reason: 'usage-exhausted', retryAfterMs: 9 }),
    { type: 'usage-exhausted', retryAfterMs: 9 },
  );
  t.deepEqual(admissionRefusalResult({ reason: 'budget-exhausted' }), {
    type: 'budget-exhausted',
  });
  t.throws(() =>
    admissionRefusalResult(/** @type {any} */ ({ reason: 'needs-auth' })),
  );
});
