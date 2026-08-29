// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';
import { passStyleOf } from '@endo/pass-style';

import {
  ok,
  facetThrew,
  limitExceeded,
  cancelled,
  poolExhausted,
  rateLimited,
  bridgeDown,
  nonzeroExit,
  parseError,
  INFER_RESULT_TYPES,
} from '../src/results.js';

test('ok result is a hardened, passable copyRecord', t => {
  const r = ok('hello', { inputTokens: 3, model: 'claude-opus-4-8' });
  t.is(r.type, 'ok');
  t.is(r.text, 'hello');
  t.true(Object.isFrozen(r));
  t.is(passStyleOf(r), 'copyRecord');
});

test('ok rejects a non-string text', t => {
  t.throws(() => ok(/** @type {any} */ (123)), {
    message: /text must be a string/,
  });
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

test('facet-threw produces a passable result for arbitrary thrown values', t => {
  // SES makes Object.prototype properties non-writable. Keep fast-check from
  // generating an own `valueOf` (or similar) that its shrinker later tries to
  // assign through the frozen inherited property.
  const safeObjectKey = fc
    .string()
    .filter(key => !Object.hasOwn(Object.prototype, key));
  fc.assert(
    fc.property(
      fc.string(),
      fc.anything({ key: safeObjectKey }),
      (method, caught) => {
      const result = facetThrew(method, caught);
      t.is(passStyleOf(result), 'copyRecord');
      t.is(passStyleOf(result.error), 'error');
      },
    ),
  );
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

test('rate-limited omits retryAfterMs when unset', t => {
  t.deepEqual({ ...rateLimited() }, { type: 'rate-limited' });
  t.deepEqual(
    { ...rateLimited(250) },
    { type: 'rate-limited', retryAfterMs: 250 },
  );
  t.true(Object.isFrozen(rateLimited()));
});

test('bridge-down coerces detail to a passable string', t => {
  const r = bridgeDown('socket closed');
  t.deepEqual({ ...r }, { type: 'bridge-down', detail: 'socket closed' });
  // A non-string detail is coerced, never dropped, so the record still marshals.
  t.is(bridgeDown(/** @type {any} */ (42)).detail, '42');
  t.is(passStyleOf(r), 'copyRecord');
});

test('nonzero-exit coerces the code to a number', t => {
  t.deepEqual({ ...nonzeroExit(137) }, { type: 'nonzero-exit', code: 137 });
  t.is(nonzeroExit(/** @type {any} */ ('2')).code, 2);
  t.is(passStyleOf(nonzeroExit(1)), 'copyRecord');
});

test('parse-error coerces detail to a passable string', t => {
  t.deepEqual(
    { ...parseError('unexpected token') },
    { type: 'parse-error', detail: 'unexpected token' },
  );
  t.is(parseError(/** @type {any} */ (undefined)).detail, 'undefined');
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
