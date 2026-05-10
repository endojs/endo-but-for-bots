// @ts-check

/// <reference types="ses" />

import harden from '@endo/harden';

const { Fail, quote: q } = assert;

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
 * **Rejection-without-subscribers retention.** A `reject(reason)` call with
 * no subscribers attached records the rejection on the producer record and
 * does NOT surface it through the host's unhandled-rejection path. The
 * recorded reason is delivered to subscribers attached after settlement
 * (the kit lets a producer mint and reject a carrier before any consumer
 * subscribes; e.g., a host that forwards the carrier as an opaque kref and
 * settles it from the kernel before downstream code attaches a subscriber).
 * Consumers that want host-level unhandled-rejection diagnostics should
 * route through `HandledPromise.settle(promise)` (which returns a native
 * Promise that participates in the host's standard rejection bookkeeping)
 * or `E.when(promise, ...)`. A pure-`subscribe` consumer that omits the
 * `onRejected` argument gets the standard "rethrow on next turn" default
 * (see `HandledPromise.subscribe`), which IS the host-side surfacing. The
 * only case in which the rejection is silently retained is the "produced,
 * rejected, no subscriber, no facade" case described above; that is the
 * intentional contract.
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
 * Make and register a fresh producer record for an externally-minted
 * carrier. Hosts that mint pass-style promise carriers via
 * `pass-style`'s `makePromise()` (CapTP, liveSlots-style kernels) MUST
 * call this before any consumer subscribes or before any external settle
 * is dispatched; without it, `subscribePassStylePromise` and the
 * external settle helpers fail loudly rather than silently install a
 * never-resolved producer record.
 *
 * Idempotent: a second call on the same carrier is a no-op (the existing
 * producer record is preserved).
 *
 * @param {object} carrier
 */
export const registerExternalPassStylePromise = carrier => {
  if (passStylePromiseProducers.has(carrier)) {
    return;
  }
  /** @type {PassStyleProducer} */
  const producer = {
    subscribers: [],
    settled: false,
    fulfilled: false,
    target: undefined,
    reason: undefined,
  };
  passStylePromiseProducers.set(carrier, producer);
};
freeze(registerExternalPassStylePromise);

/**
 * Register a subscriber on a pass-style promise carrier. The carrier MUST
 * already have a producer record, either from `makeSubscribableKit` here
 * or from a prior `registerExternalPassStylePromise` call by the host
 * that minted the carrier. Subscribing to an unknown carrier fails with
 * a diagnostic that quotes the carrier identity, so a typo / wrong-realm
 * carrier surfaces immediately rather than hanging forever.
 *
 * @param {object} carrier
 * @param {(target: any) => void} onFulfilled
 * @param {(reason: any) => void} onRejected
 */
export const subscribePassStylePromise = (carrier, onFulfilled, onRejected) => {
  const producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    Fail`Cannot subscribe to unregistered pass-style promise carrier ${q(
      carrier,
    )}: a producer record must be installed via makeSubscribableKit or registerExternalPassStylePromise before subscribing`;
    return;
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
 * eventual-send's subscriber notification. The carrier MUST already
 * have a producer record (via `registerExternalPassStylePromise` or
 * `makeSubscribableKit`); resolving an unregistered carrier fails with a
 * diagnostic that quotes the carrier identity.
 *
 * @param {object} carrier
 * @param {any} target
 */
export const resolveExternalPassStylePromise = (carrier, target) => {
  const producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    Fail`Cannot resolve unregistered pass-style promise carrier ${q(
      carrier,
    )}: a producer record must be installed via registerExternalPassStylePromise before settling`;
    return;
  }
  settleProducer(producer, true, target);
};
freeze(resolveExternalPassStylePromise);

/**
 * The rejection counterpart of `resolveExternalPassStylePromise`.
 *
 * **Retention semantics.** Like `makeSubscribableKit`'s `reject`, calling
 * this with no subscribers attached records the rejection on the producer
 * record without surfacing it through the host's unhandled-rejection path.
 * The recorded reason is delivered to subscribers attached after the
 * rejection. This is intentional: a host-driven settlement channel
 * (CapTP's `CTP_RESOLVE`, a kernel slot table) often signals settlement
 * before any local consumer has subscribed, and surfacing such a rejection
 * to the host's unhandled-rejection path would produce false positives.
 * Consumers that want host-level diagnostics should route through
 * `HandledPromise.settle` or `E.when` (both of which attach a synchronous
 * rejection handler that participates in the standard Promise unhandled-
 * rejection mechanism).
 *
 * @param {object} carrier
 * @param {any} reason
 */
export const rejectExternalPassStylePromise = (carrier, reason) => {
  const producer = passStylePromiseProducers.get(carrier);
  if (producer === undefined) {
    Fail`Cannot reject unregistered pass-style promise carrier ${q(
      carrier,
    )}: a producer record must be installed via registerExternalPassStylePromise before settling`;
    return;
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
