// @ts-check

/// <reference types="ses" />

import harden from '@endo/harden';

/**
 * Subscription support for pass-style promise carriers, layered alongside
 * `HandledPromise`. The carrier shape itself (`[PASS_STYLE]: 'promise'`,
 * `[Symbol.toStringTag]` starting with `'Promise'`) is defined by
 * `@endo/pass-style/src/promise.js`. To avoid a dependency cycle (pass-style
 * already depends on eventual-send), this module re-creates carriers
 * locally inside `makeSubscribableKit`, using the same well-known
 * `Symbol.for('passStyle')` registry so that the result is recognized by
 * `passStyleOf` as the same `'promise'` pass style.
 *
 * This module is imported by `handled-promise.js`, which is part of the
 * pre-lockdown shim path. We use single-level `freeze` (not `harden`)
 * at module-init time, mirroring `handled-promise.js`'s discipline:
 * post-lockdown the SES intrinsics are hardened, so a one-level freeze
 * on each exported function is sufficient. See the comment near the end
 * of `handled-promise.js` for the precedent.
 */

const { defineProperties, freeze } = Object;
const { toStringTag } = Symbol;

/**
 * Same value as `@endo/pass-style`'s `PASS_STYLE` (registered symbol).
 * Re-derived here from `Symbol.for` rather than imported, to keep
 * `@endo/eventual-send` independent of `@endo/pass-style`.
 */
const PASS_STYLE = Symbol.for('passStyle');

const PASS_STYLE_PROMISE_TAG = 'Promise';

/**
 * @typedef {object} PassStyleProducer
 * @property {Array<{onFulfilled: (target: any) => void, onRejected: (reason: any) => void}>} subscribers
 * @property {boolean} settled
 * @property {boolean} fulfilled
 * @property {any} target
 * @property {any} reason
 */

/**
 * Producer state for pass-style promise carriers minted by
 * `makeSubscribableKit`. Carriers minted by `pass-style`'s `makePromise()`
 * directly (i.e., outside this kit) do NOT appear in this map; subscribers
 * to such a carrier wait indefinitely (the host is responsible for its own
 * subscription mechanism, like CapTP's slot table).
 *
 * The map keys the carrier (which is hardened/frozen) to its producer
 * record. Values include a `subscribers` list, a `settled` flag, and the
 * recorded settlement target or rejection reason.
 *
 * @type {WeakMap<object, PassStyleProducer>}
 */
const passStylePromiseProducers = new WeakMap();

/**
 * @param {any} candidate
 * @returns {boolean} Whether `candidate` is a pass-style promise carrier
 *   (the non-thenable shape recognized by `@endo/pass-style`).
 *   This duck-types the carrier shape to avoid importing pass-style;
 *   `passStyleOf` enforces the full contract on the way in.
 */
export const isPassStylePromiseShape = candidate => {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate[PASS_STYLE] !== 'promise') return false;
  // A native Promise has `then`. A pass-style carrier does not.
  // We check the `then` property to discriminate from the native fast-path.
  // (A safer discrimination would consult `passStyleOf`, but we cannot
  // depend on `pass-style` from this module.)
  if (typeof candidate.then === 'function') return false;
  return true;
};
freeze(isPassStylePromiseShape);

/**
 * Mints a fresh pass-style promise carrier matching the shape recognized
 * by `@endo/pass-style`'s `passStyleOf` and `makePromise`.
 *
 * @returns {object}
 */
const makeCarrier = () => {
  const carrier = {};
  defineProperties(carrier, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: PASS_STYLE_PROMISE_TAG },
  });
  return harden(carrier);
};

/**
 * Schedule a producer notification on the next turn. Pass-style promise
 * subscribers (analogous to native `Promise.prototype.then` callbacks)
 * always fire on a future turn, never synchronously, even when the
 * underlying state is already settled at the time of the subscribe call.
 *
 * @param {() => void} thunk
 */
const onNextTurn = thunk => {
  // We use a native Promise microtask, mirroring the host's `Promise.then`
  // semantics. This is independent of any HandledPromise machinery.
  // Errors are caught and logged; see `settleProducer`'s comments about
  // why subscribe is fire-and-forget by contract.
  Promise.resolve()
    .then(thunk)
    .catch(reason => {
      // eslint-disable-next-line no-console
      console.error('pass-style promise turn threw:', reason);
    });
};

/**
 * @param {PassStyleProducer} producer
 * @param {(target: any) => void} onFulfilled
 * @param {(reason: any) => void} onRejected
 */
const enqueueSubscriber = (producer, onFulfilled, onRejected) => {
  if (producer.settled) {
    // Already settled: fire on the next turn with the recorded outcome.
    onNextTurn(() => {
      if (producer.fulfilled) {
        onFulfilled(producer.target);
      } else {
        onRejected(producer.reason);
      }
    });
    return;
  }
  producer.subscribers.push({ onFulfilled, onRejected });
};

/**
 * Settle the producer, notifying all current and future subscribers.
 * Fire-once: a second call is a no-op (the producer-side contract is that
 * settlement is final on the carrier).
 *
 * @param {PassStyleProducer} producer
 * @param {boolean} fulfilled
 * @param {any} value
 */
const settleProducer = (producer, fulfilled, value) => {
  if (producer.settled) {
    // Silently ignore a second settle; native Promise semantics treat the
    // first settle as authoritative. Producers that want to detect the
    // violation can keep their own `settled` flag in their closure.
    return;
  }
  producer.settled = true;
  producer.fulfilled = fulfilled;
  if (fulfilled) {
    producer.target = value;
  } else {
    producer.reason = value;
  }
  const { subscribers } = producer;
  // Drop the subscriber list immediately so callbacks added after settle
  // go through the `producer.settled` path, not this one.
  producer.subscribers = [];
  if (subscribers.length === 0) {
    // No current subscribers. A rejection without any subscriber is
    // silently retained on the producer record; subsequent subscribers
    // (added after settle) still see it through the
    // `producer.settled` path. We do NOT trigger the host's
    // unhandled-rejection path here because pass-style subscribers can
    // legitimately attach later (after the producer settles). The
    // promise-returning facades (`HandledPromise.settle`, `E.when`)
    // always attach a rejection handler synchronously, so user code that
    // routes through them sees the rejection normally.
    return;
  }
  onNextTurn(() => {
    for (const { onFulfilled, onRejected } of subscribers) {
      try {
        if (fulfilled) {
          onFulfilled(value);
        } else {
          onRejected(value);
        }
      } catch (subscriberError) {
        // Subscriber threw. We have no chained promise to reject (subscribe
        // is fire-and-forget by contract), and reporting via the host's
        // unhandled-rejection path would compete with the producer's own
        // rejection (if any). Defer to a silent swallow; users who need
        // error propagation should compose through the promise-returning
        // `HandledPromise.settle`, which surfaces both producer rejections
        // and downstream throw-through-then via the standard Promise
        // unhandled-rejection mechanism.
        // eslint-disable-next-line no-console
        console.error('pass-style promise subscriber threw:', subscriberError);
      }
    }
  });
};

/**
 * Mint a pass-style promise carrier together with its private settler.
 *
 * The returned `promise` is a pass-style promise carrier (frozen,
 * non-thenable, `passStyleOf(promise) === 'promise'`). The `settle` and
 * `reject` callbacks are the producer-side closure-private resolvers; the
 * carrier itself exposes none of that state.
 *
 * `settle` and `reject` are fire-once; subsequent calls are silently
 * ignored, mirroring native `Promise` semantics.
 *
 * Subscribers added through `HandledPromise.subscribe(promise, cb, errCb)`
 * (or, transitively, observers calling `HandledPromise.settle(promise)`)
 * are notified on the next turn after `settle` or `reject` fires.
 *
 * @returns {{ promise: object, settle: (target: any) => void, reject: (reason: any) => void }}
 */
export const makeSubscribableKit = () => {
  const promise = makeCarrier();
  /** @type {PassStyleProducer} */
  const producer = {
    subscribers: [],
    settled: false,
    fulfilled: false,
    target: undefined,
    reason: undefined,
  };
  passStylePromiseProducers.set(promise, producer);
  /**
   * @param {any} target
   */
  const settle = target => {
    settleProducer(producer, true, target);
  };
  /**
   * @param {any} reason
   */
  const reject = reason => {
    settleProducer(producer, false, reason);
  };
  return harden({ promise, settle, reject });
};
freeze(makeSubscribableKit);

/**
 * Register a subscriber on a pass-style promise carrier. If the carrier is
 * known to this module (because it came from `makeSubscribableKit` here),
 * the subscriber is enqueued on the producer; otherwise, the subscriber
 * is enqueued in a "pending" state awaiting an external producer
 * registration. Callers that pass an unknown carrier are responsible for
 * driving its settlement via a host-specific channel (e.g., CapTP's slot
 * table).
 *
 * @param {object} carrier
 * @param {(target: any) => void} onFulfilled
 * @param {(reason: any) => void} onRejected
 */
export const subscribePassStylePromise = (carrier, onFulfilled, onRejected) => {
  let producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    // Carrier minted outside this module (e.g., directly via
    // `pass-style`'s `makePromise()`). Lazily install a producer record
    // so a subsequent host-driven `resolveExternalPassStylePromise` can
    // settle it. Without that resolution, the subscriber waits forever
    // (analogous to a native promise that never settles).
    /** @type {PassStyleProducer} */
    producer = {
      subscribers: [],
      settled: false,
      fulfilled: false,
      target: undefined,
      reason: undefined,
    };
    passStylePromiseProducers.set(carrier, producer);
  }
  enqueueSubscriber(producer, onFulfilled, onRejected);
};
freeze(subscribePassStylePromise);

/**
 * Settle a pass-style promise carrier from outside (e.g., the host
 * runtime, CapTP, or a kernel). Idempotent: a second call after settlement
 * is a no-op.
 *
 * Used by hosts (CapTP, liveSlots-like kernels) that mint carriers via
 * `pass-style`'s `makePromise()` and track settlement in their own slot
 * tables; calling this function bridges their settlement signal to
 * eventual-send's subscriber notification.
 *
 * @param {object} carrier
 * @param {any} target
 */
export const resolveExternalPassStylePromise = (carrier, target) => {
  let producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    /** @type {PassStyleProducer} */
    producer = {
      subscribers: [],
      settled: false,
      fulfilled: false,
      target: undefined,
      reason: undefined,
    };
    passStylePromiseProducers.set(carrier, producer);
  }
  settleProducer(producer, true, target);
};
freeze(resolveExternalPassStylePromise);

/**
 * The rejection counterpart of `resolveExternalPassStylePromise`.
 *
 * @param {object} carrier
 * @param {any} reason
 */
export const rejectExternalPassStylePromise = (carrier, reason) => {
  let producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    /** @type {PassStyleProducer} */
    producer = {
      subscribers: [],
      settled: false,
      fulfilled: false,
      target: undefined,
      reason: undefined,
    };
    passStylePromiseProducers.set(carrier, producer);
  }
  settleProducer(producer, false, reason);
};
freeze(rejectExternalPassStylePromise);

/**
 * @param {any} candidate
 * @returns {boolean}
 */
export const isThenable = candidate =>
  candidate !== null &&
  (typeof candidate === 'object' || typeof candidate === 'function') &&
  typeof candidate.then === 'function';
freeze(isThenable);

/**
 * Assertion helper: a producer is created for an externally-minted carrier
 * the first time a subscriber attaches. This is exposed only for tests.
 *
 * @param {object} carrier
 * @returns {boolean}
 */
export const hasProducerForTesting = carrier =>
  passStylePromiseProducers.has(carrier);
freeze(hasProducerForTesting);
