// @ts-check

import harden from '@endo/harden';
import { isPromise } from '@endo/promise-kit';
import { Fail, q, hideAndHardenFunction } from '@endo/errors';
import {
  PASS_STYLE,
  confirmTagRecord,
  isPrimitive,
} from './passStyle-helpers.js';
import { assertSafePromise } from './safe-promise.js';

/**
 * @import {Rejector} from '@endo/errors/rejector.js';
 * @import {PassStyleHelper} from './internal-types.js';
 * @import {PassStylePromise} from './types.js';
 */

const { getOwnPropertyDescriptors } = Object;
const { ownKeys } = Reflect;
const { toStringTag } = Symbol;

/**
 * The default `Symbol.toStringTag` for newly minted pass-style promise
 * carriers. The pass-style promise check below tolerates any string starting
 * with `'Promise'`, mirroring the convention from the native promise check
 * in `safe-promise.js`. Using the same `'Promise'` prefix is deliberate: it
 * keeps `String(token)` symmetric with native promises so debugging output
 * looks the same from the outside.
 */
const PASS_STYLE_PROMISE_TAG = 'Promise';

/**
 * @param {any} candidate
 * @param {Rejector} reject
 * @returns {candidate is PassStylePromise}
 */
const confirmPassStylePromise = (candidate, reject) => {
  // Each branch must short-circuit cleanly when reject is `false`.
  if (!confirmTagRecord(candidate, 'promise', reject)) {
    return false;
  }
  // confirmTagRecord already verified PASS_STYLE and Symbol.toStringTag are
  // own non-enumerable data properties; gather what's left.
  // Typecasts needed due to https://github.com/microsoft/TypeScript/issues/1863
  const passStyleKey = /** @type {unknown} */ (PASS_STYLE);
  const tagKey = /** @type {unknown} */ (toStringTag);
  const {
    [/** @type {string} */ (passStyleKey)]: _passStyleDesc,
    [/** @type {string} */ (tagKey)]: tagDesc,
    ...restDescs
  } = getOwnPropertyDescriptors(candidate);
  const restKeys = ownKeys(restDescs);
  // No own properties besides PASS_STYLE and Symbol.toStringTag. In
  // particular, an own `then` is forbidden here. The non-thenable contract
  // is the load-bearing invariant of this pass style: subscribers must call
  // `HandledPromise.subscribe` (or `HandledPromise.settle`) to observe
  // settlement; `await` will resolve to the carrier itself, not its target.
  return (
    (restKeys.length === 0 ||
      (reject &&
        reject`Pass-style promise has unexpected own properties: ${q(
          restKeys,
        )}`)) &&
    ((typeof tagDesc.value === 'string' &&
      tagDesc.value.startsWith(PASS_STYLE_PROMISE_TAG)) ||
      (reject &&
        reject`Pass-style promise [Symbol.toStringTag] must be a string starting with ${q(
          PASS_STYLE_PROMISE_TAG,
        )}: ${candidate}`))
  );
};
harden(confirmPassStylePromise);

/**
 * Returns whether the candidate is a pass-style promise carrier (the new
 * non-thenable token), as distinct from a native frozen Promise.
 *
 * @param {any} candidate
 * @returns {candidate is PassStylePromise}
 */
export const isPassStylePromise = candidate => {
  if (isPrimitive(candidate)) return false;
  if (candidate[PASS_STYLE] !== 'promise') return false;
  return confirmPassStylePromise(candidate, false);
};
hideAndHardenFunction(isPassStylePromise);

/**
 * The pass-style helper for both native promises and the new non-thenable
 * pass-style promise carrier produced by `makePromise()`.
 *
 * Both shapes report `passStyleOf(x) === 'promise'`. The two are
 * distinguishable at runtime by `isPromise(x)` (true for native promises,
 * false for pass-style promise carriers) and by `isPassStylePromise(x)`
 * (the inverse).
 *
 * @type {PassStyleHelper}
 */
export const PromiseHelper = harden({
  styleName: 'promise',

  confirmCanBeValid: (candidate, reject) => {
    if (isPrimitive(candidate)) {
      return reject && reject`A non-object cannot be a promise: ${candidate}`;
    }
    if (isPromise(candidate)) {
      return true;
    }
    if (candidate[PASS_STYLE] === 'promise') {
      return true;
    }
    return (
      reject &&
      reject`Pass-style promise must be a native Promise or have ${q(
        PASS_STYLE,
      )} ${q('promise')}: ${candidate}`
    );
  },

  assertRestValid: candidate => {
    if (isPromise(candidate)) {
      assertSafePromise(candidate);
      return;
    }
    confirmPassStylePromise(candidate, Fail);
  },
});

/**
 * Mints a fresh pass-style promise carrier: a frozen, non-thenable object
 * whose `passStyleOf` is `'promise'`. The returned token carries no
 * settlement state; producers that need to observe settlement do so through
 * `HandledPromise.subscribe` (or `HandledPromise.settle`), which lives in
 * `@endo/eventual-send`.
 *
 * The carrier:
 *   - has prototype `Object.prototype`;
 *   - is not a `Promise` instance (`x instanceof Promise === false`);
 *   - has no `then` method (own or inherited beyond `Object.prototype`);
 *   - has exactly two own properties, both symbol-keyed and
 *     non-enumerable: `[PASS_STYLE]: 'promise'` and
 *     `[Symbol.toStringTag]: 'Promise'`;
 *   - is hardened.
 *
 * Because the carrier has no `then` method, `await passStylePromise`
 * resolves to the carrier itself, not to any settlement target. This is
 * the deliberate contract; the caller must use `HandledPromise.settle`
 * (or `HandledPromise.subscribe`) to observe settlement.
 *
 * @returns {PassStylePromise}
 */
export const makePromise = () => {
  // We deliberately use `defineProperties` over `__proto__` syntax so that
  // both the PASS_STYLE and Symbol.toStringTag properties are non-enumerable
  // (the only shape this pass style admits). Object.prototype is the
  // prototype because the value must NOT inherit from Promise.prototype:
  // doing so would re-introduce a reachable `then` method through the
  // prototype chain, defeating the non-thenable invariant.
  const carrier = {};
  Object.defineProperties(carrier, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: PASS_STYLE_PROMISE_TAG },
  });
  return /** @type {PassStylePromise} */ (
    /** @type {unknown} */ (harden(carrier))
  );
};
harden(makePromise);
