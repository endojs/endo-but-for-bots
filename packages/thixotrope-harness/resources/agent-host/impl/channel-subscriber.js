// @ts-check
/**
 * What the session channel (`channels.js`) and the session list channel
 * (`list-channel.js`) share (HR-SYN-25): the bounded subscriber queue and
 * the rev reordering of published batches. Each channel keeps its own
 * deliveries, numbering, snapshot and interface guards.
 *
 * Subscriber. One per `subscribe()`: a queue bounded by deliveries and by
 * bytes (`queueLimit`, `queueBytes`; over either, the subscriber is closed
 * with `queueDeliveries` or `queueBytes`), its waiting `next()` callers
 * (answered on a microtask, so one publish arrives as one batch, at most
 * `limits.liveBatchDeliveries` per `next()`), and its facet (`exoName`
 * under `guard`). A closed subscriber answers every `next()` with
 * `{ deliveries: [], closed: true, reason }`, `reason` a close-reason key
 * (`shapes.CloseReason`); its channel's `onClose` gets the same key.
 *
 * Reordering. Batches carry the publisher's rev and are delivered in rev
 * order: the first sets the expected rev; a newer one is held until the
 * missing rev arrives, `reorderWaitMs` passes, or the held batches or
 * deliveries exceed `reorderWindowBatches` / `reorderBacklogDeliveries` (a
 * gap: the missing revs are given up and counted); an older or duplicate
 * one is dropped. Items that are not batches (the session channel's
 * deltas) may be held behind a held batch with `hold`, and are delivered
 * in arrival order once nothing before them is missing.
 *
 * Timers come from `schedule` (tests pass their own); `unrefSchedule` is
 * the adapter's default, a timer that does not keep the process alive.
 *
 * Node module (adapter); reads the guest prelude from `globalThis`.
 */
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {'client' | 'queueDeliveries' | 'queueBytes' | 'subscriberLimit'} CloseReason
 * @typedef {(fn: () => void, ms: number) => () => void} Schedule runs `fn`
 *   once after `ms`; returns a cancel function
 * @typedef {object} Subscriber
 * @property {(delivery: any, size: number) => void} push queue one
 *   delivery of `size` UTF-8 bytes (0 for a snapshot)
 * @property {(reason: CloseReason) => void} close
 * @property {any} facet the subscription exo
 * @property {() => boolean} isClosed
 * @property {() => number} queuedBytes
 * @property {() => number} queuedDeliveries
 */

/** @type {Schedule} */
export const unrefSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
harden(unrefSchedule);

/**
 * What a closed subscription answers to every `next()`.
 * @param {CloseReason} reason
 */
const closedBatch = reason => harden({ deliveries: [], closed: true, reason });

/**
 * One subscriber: its queue, its pending `next()` callers and its facet.
 * @param {object} options
 * @param {string} options.exoName
 * @param {any} options.guard the facet's interface guard
 * @param {number} options.queueLimit deliveries
 * @param {number} options.queueBytes UTF-8 bytes of queued deliveries
 * @param {(reason: CloseReason) => void} options.onClose removes it from its
 *   channel and records the reason
 * @returns {Subscriber}
 */
export const makeSubscriber = ({
  exoName,
  guard,
  queueLimit,
  queueBytes,
  onClose,
}) => {
  /** @type {any[]} */
  const queue = [];
  /** @type {number[]} bytes of each queued delivery, in step with `queue` */
  const sizes = [];
  let bytes = 0;
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  const waiters = [];
  /** @type {CloseReason | undefined} */
  let closedFor;
  let flushScheduled = false;

  const take = () => {
    const deliveries = queue.splice(0, limits.liveBatchDeliveries);
    for (const size of sizes.splice(0, deliveries.length)) bytes -= size;
    return harden({ deliveries });
  };

  /** Answer the waiting `next()` callers, oldest first, while there is anything to give. */
  const flush = () => {
    flushScheduled = false;
    while (waiters.length > 0 && queue.length > 0) {
      const waiter = /** @type {ReturnType<typeof makePromiseKit>} */ (
        waiters.shift()
      );
      waiter.resolve(take());
    }
  };

  /** @param {CloseReason} reason */
  const close = reason => {
    if (closedFor !== undefined) return;
    closedFor = reason;
    queue.length = 0;
    sizes.length = 0;
    bytes = 0;
    onClose(reason);
    for (const waiter of waiters.splice(0)) {
      waiter.resolve(closedBatch(reason));
    }
  };

  /**
   * Queue one delivery. A waiting `next()` is answered on a microtask, so the
   * events of one publish (or of one synchronous burst) arrive in one batch.
   * @param {any} delivery
   * @param {number} size
   */
  const push = (delivery, size) => {
    if (closedFor !== undefined) return;
    queue.push(delivery);
    sizes.push(size);
    bytes += size;
    if (queue.length > queueLimit) {
      close('queueDeliveries');
      return;
    }
    if (bytes > queueBytes) {
      close('queueBytes');
      return;
    }
    if (waiters.length > 0 && !flushScheduled) {
      flushScheduled = true;
      void Promise.resolve().then(flush);
    }
  };

  const facet = makeExo(exoName, guard, {
    async next() {
      if (closedFor !== undefined) return closedBatch(closedFor);
      if (queue.length > 0 && waiters.length === 0) return take();
      const waiter = makePromiseKit();
      waiters.push(waiter);
      return waiter.promise;
    },
    close() {
      close('client');
    },
  });

  return harden({
    push,
    close,
    facet,
    isClosed: () => closedFor !== undefined,
    queuedBytes: () => bytes,
    queuedDeliveries: () => queue.length,
  });
};
harden(makeSubscriber);

/**
 * The attached subscriber with the most queued bytes (then deliveries): the
 * one a subscribe beyond the bound closes.
 * @param {Iterable<Subscriber>} subscribers
 */
export const slowestOf = subscribers => {
  /** @type {Subscriber | undefined} */
  let worst;
  for (const subscriber of subscribers) {
    if (
      worst === undefined ||
      subscriber.queuedBytes() > worst.queuedBytes() ||
      (subscriber.queuedBytes() === worst.queuedBytes() &&
        subscriber.queuedDeliveries() > worst.queuedDeliveries())
    ) {
      worst = subscriber;
    }
  }
  return worst;
};
harden(slowestOf);

/**
 * @typedef {{ kind: 'batch', rev: number, events: readonly any[] } | { kind: 'held', item: any }} Held
 */

/**
 * Rev order for published batches (see the module comment).
 * @param {object} options
 * @param {{ reorderWindowBatches: number, reorderBacklogDeliveries: number, reorderWaitMs: number }} options.limits
 * @param {Schedule} options.schedule
 * @param {(rev: number, events: readonly any[]) => void} options.deliverBatch
 *   delivers one batch; `latestRev()` is already `rev`
 * @param {(item: any) => void} [options.deliverHeld] delivers an item held
 *   with `hold`
 */
export const makeRevReorder = ({
  limits: { reorderWindowBatches, reorderBacklogDeliveries, reorderWaitMs },
  schedule,
  deliverBatch,
  deliverHeld = () => {},
}) => {
  /** The last delivered rev (0 = none yet). */
  let latestRev = 0;
  /** The rev the next batch must carry; undefined before the first. */
  /** @type {number | undefined} */
  let expectedRev;
  /**
   * What arrived behind a missing rev, in arrival order: batches newer than
   * `expectedRev` and the items held after the first of them. Empty, or its
   * first entry is a batch.
   * @type {Held[]}
   */
  const backlog = [];
  let heldBatches = 0;
  let heldDeliveries = 0;
  /** @type {(() => void) | undefined} */
  let cancelWait;
  const counts = {
    /** Batches delivered after a newer one had arrived (held, then in order). */
    reordered: 0,
    /** Batches dropped: at or below the delivered rev, or already held. */
    dropped: 0,
    /** Times the missing revs were given up. */
    gaps: 0,
    /** Revs given up in those gaps. */
    missingRevs: 0,
  };

  /**
   * @param {number} rev
   * @param {readonly any[]} events
   */
  const deliverInOrder = (rev, events) => {
    latestRev = rev;
    expectedRev = rev + 1;
    deliverBatch(rev, events);
  };

  /**
   * Deliver from the backlog what may go now: held items at its head, and
   * the batch with the expected rev wherever it is.
   */
  const drain = () => {
    while (backlog.length > 0) {
      const head = backlog[0];
      if (head.kind === 'held') {
        backlog.shift();
        heldDeliveries -= 1;
        deliverHeld(head.item);
      } else {
        const at = backlog.findIndex(
          item => item.kind === 'batch' && item.rev === expectedRev,
        );
        if (at < 0) break;
        const [item] = backlog.splice(at, 1);
        if (item.kind !== 'batch') break; // unreachable; narrows the type
        heldBatches -= 1;
        heldDeliveries -= item.events.length;
        counts.reordered += 1;
        deliverInOrder(item.rev, item.events);
      }
    }
    if (backlog.length === 0 && cancelWait !== undefined) {
      cancelWait();
      cancelWait = undefined;
    }
  };

  /**
   * Give up the missing revs before the oldest held batch: deliver from it
   * on, in rev order.
   */
  const declareGap = () => {
    let oldest = Infinity;
    for (const item of backlog) {
      if (item.kind === 'batch' && item.rev < oldest) oldest = item.rev;
    }
    if (oldest === Infinity) return;
    counts.gaps += 1;
    counts.missingRevs += oldest - /** @type {number} */ (expectedRev);
    expectedRev = oldest;
    drain();
  };

  /** (Re)arm the wait for the missing rev while anything is held. */
  const armWait = () => {
    if (cancelWait !== undefined || backlog.length === 0) return;
    cancelWait = schedule(() => {
      cancelWait = undefined;
      declareGap();
      armWait();
    }, reorderWaitMs);
  };

  /** Give revs up while the held state is over its bounds. */
  const enforceWindow = () => {
    while (
      backlog.length > 0 &&
      (heldBatches > reorderWindowBatches ||
        heldDeliveries > reorderBacklogDeliveries)
    ) {
      declareGap();
    }
  };

  /**
   * One published batch.
   * @param {number} rev
   * @param {readonly any[]} events
   */
  const publish = (rev, events) => {
    if (expectedRev === undefined || rev === expectedRev) {
      deliverInOrder(rev, events);
      drain();
      return;
    }
    if (
      rev < expectedRev ||
      backlog.some(item => item.kind === 'batch' && item.rev === rev)
    ) {
      counts.dropped += 1;
      return;
    }
    backlog.push({ kind: 'batch', rev, events });
    heldBatches += 1;
    heldDeliveries += events.length;
    enforceWindow();
    armWait();
  };

  /**
   * Hold `item` behind the held batches, if any.
   * @param {any} item
   * @returns {boolean} false: nothing is held, deliver it now
   */
  const hold = item => {
    if (backlog.length === 0) return false;
    backlog.push({ kind: 'held', item });
    heldDeliveries += 1;
    enforceWindow();
    return true;
  };

  return harden({
    publish,
    hold,
    latestRev: () => latestRev,
    /** Ordering counters (tests, diagnostics). */
    ordering: () =>
      harden({
        ...counts,
        expectedRev: expectedRev ?? null,
        heldBatches,
        heldDeliveries,
      }),
  });
};
harden(makeRevReorder);
