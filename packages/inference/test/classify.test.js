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

test('a response that throws while hardened does not classify', t => {
  const classifier = makeShapeClassifier(table);
  const hostile = new Proxy(
    {},
    {
      ownKeys: () => {
        throw Error('hostile response');
      },
    },
  );
  t.is(classifier.classify('2.1.278', hostile), undefined);
});

test('a refill reader that throws leaves the row without a refill time', t => {
  const classifier = makeShapeClassifier(
    harden({
      '2.1.278': [
        {
          pattern: rateLimitPattern,
          result: { type: 'rate-limited' },
          retryAfterMs: () => {
            throw Error('missing header');
          },
        },
      ],
    }),
  );
  t.deepEqual(
    classifier.classify('2.1.278', {
      type: 'result',
      subtype: 'rate_limited',
      retry_after_ms: 30_000,
    }),
    { type: 'rate-limited' },
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
  t.deepEqual(
    classifier.classify('2.1.278', {
      type: 'result',
      subtype: 'rate_limited',
      retry_after_ms: 0,
    }),
    { type: 'rate-limited', retryAfterMs: 0 },
    'an immediate retry is kept',
  );
  // A finite delay past the safe-integer range is the case that tells the
  // explicit bound apart from a bare `Number.isFinite` check.
  for (const retryAfter of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 100]) {
    t.deepEqual(
      classifier.classify('2.1.278', {
        type: 'result',
        subtype: 'rate_limited',
        retry_after_ms: retryAfter,
      }),
      { type: 'rate-limited' },
      String(retryAfter),
    );
  }
});

test('an empty table classifies nothing', t => {
  const classifier = makeShapeClassifier(harden({}));
  t.deepEqual(classifier.versions(), []);
  t.is(classifier.classify('2.1.278', { type: 'result' }), undefined);
  const noRows = makeShapeClassifier(harden({ '2.1.278': [] }));
  t.deepEqual(noRows.versions(), ['2.1.278']);
  t.is(noRows.classify('2.1.278', { type: 'result' }), undefined);
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

test('an accessor entry cannot change its result after the check', t => {
  let reads = 0;
  const entry = {
    pattern: M.any(),
    get result() {
      reads += 1;
      return reads === 1
        ? harden({ type: 'needs-auth' })
        : harden({ type: 'ok', text: 'forged' });
    },
  };
  const classifier = makeShapeClassifier(
    /** @type {any} */ ({ '1.0.0': [entry] }),
  );
  t.deepEqual(classifier.classify('1.0.0', {}), { type: 'needs-auth' });
  t.deepEqual(classifier.classify('1.0.0', {}), { type: 'needs-auth' });
});

test('a table row is iterated once, so a second walk cannot swap entries', t => {
  const checked = harden({ pattern: M.any(), result: { type: 'needs-auth' } });
  const swapped = harden({
    pattern: M.any(),
    result: { type: 'ok', text: 'x' },
  });
  const entries = [checked];
  let walks = 0;
  Object.defineProperty(entries, Symbol.iterator, {
    value: function* iterate() {
      walks += 1;
      yield walks === 1 ? checked : swapped;
    },
  });
  const classifier = makeShapeClassifier(
    /** @type {any} */ ({ '1.0.0': entries }),
  );
  t.is(walks, 1);
  t.deepEqual(classifier.classify('1.0.0', {}), { type: 'needs-auth' });
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

test('a refill reader must be a function', t => {
  t.throws(
    () =>
      makeShapeClassifier(
        harden({
          '1.0.0': [
            {
              pattern: M.any(),
              result: { type: 'rate-limited' },
              retryAfterMs: /** @type {any} */ (1),
            },
          ],
        }),
      ),
    { message: /must be a function/ },
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
  t.throws(
    () =>
      admissionRefusalResult({
        reason: 'rate-limited',
        retryAfterMs: Infinity,
      }),
    undefined,
    'a refill time must be finite, as the classifier requires',
  );
});
