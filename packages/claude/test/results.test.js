// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { passStyleOf } from '@endo/pass-style';

import {
  ok,
  facetThrew,
  limitExceeded,
  cancelled,
  poolExhausted,
  INFER_RESULT_TYPES,
} from '../src/results.js';

test('ok result is a hardened, passable copyRecord', t => {
  const r = ok('hello', { inputTokens: 3, model: 'claude-opus-4-8' });
  t.is(r.type, 'ok');
  t.is(r.text, 'hello');
  t.true(Object.isFrozen(r));
  t.is(passStyleOf(r), 'copyRecord');
});

test('ok rejects non-primitive usage values (would not marshal)', t => {
  t.throws(() => ok('x', { bad: /** @type {any} */ ({}) }), {
    message: /must be a number or string/,
  });
});

test('facet-threw carries a PASSABLE error, not the raw caught value', t => {
  // A non-Error thrown value would make passStyleOf reject; toPassableError fixes it.
  const r = facetThrew('writeText', { weird: 'object', not: 'an error' });
  t.is(r.type, 'facet-threw');
  t.is(r.method, 'writeText');
  t.is(passStyleOf(r.error), 'error');
  t.true(Object.isFrozen(r));
  // The whole record marshals.
  t.is(passStyleOf(r), 'copyRecord');
});

test('facet-threw preserves an Error message', t => {
  const r = facetThrew('list', new Error('nope'));
  t.is(r.error.message, 'nope');
});

test('limit-exceeded validates the axis', t => {
  t.is(limitExceeded('wall-clock').which, 'wall-clock');
  t.is(limitExceeded('output-bytes').which, 'output-bytes');
  t.is(limitExceeded('max-turns').which, 'max-turns');
  t.throws(() => limitExceeded(/** @type {any} */ ('nonsense')));
});

test('cancelled validates the phase', t => {
  t.is(cancelled('before-spawn').at, 'before-spawn');
  t.throws(() => cancelled(/** @type {any} */ ('whenever')));
});

test('poolExhausted omits retryAfterMs when unset', t => {
  t.deepEqual({ ...poolExhausted() }, { type: 'pool-exhausted' });
  t.deepEqual(
    { ...poolExhausted(500) },
    { type: 'pool-exhausted', retryAfterMs: 500 },
  );
});

test('the taxonomy enumerates all nine cases', t => {
  t.deepEqual([...INFER_RESULT_TYPES].sort(), [
    'bridge-down',
    'cancelled',
    'facet-threw',
    'limit-exceeded',
    'nonzero-exit',
    'ok',
    'parse-error',
    'pool-exhausted',
    'rate-limited',
  ]);
});
