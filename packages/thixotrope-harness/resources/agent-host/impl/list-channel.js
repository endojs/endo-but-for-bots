// @ts-check
/**
 * The session list channel in the agent-host adapter (M1b W1b.5;
 * architecture D-8, 3.1; `designs/m1b-interfaces.md` sections 3.5, 3.6,
 * 6.7 and 10.2).
 *
 * One channel per adapter incarnation. The factory vat holds its
 * **publisher** (`ListPublisher`, fetched with `AgentHostAdmin
 * .listPublisher()` at every start) and publishes one batch per factory
 * crank that changed rows, `{ rev, events }` (sendOnly). Viewers attach
 * through the gateway-local `Live.subscribeList(rev?)` (W1b.1 wires it to
 * `subscribe` here) and each gets a **subscriber** facet
 * (`ListSubscription`) with its own bounded queue; the factory never holds a
 * viewer (feasibility B-4).
 *
 * Numbering and order, as the session channel (`channels.js`): `seq` counts
 * this incarnation's deliveries from 1; a subscription's first delivery is
 * `{ seq, rev, event: { type: 'list-snapshot' } }` with the `seq` of the
 * last delivery it accounts for and `rev` = the latest rev delivered (0 =
 * none since the adapter started), so a viewer re-reads `listSessions` and
 * then applies the deliveries that follow. Batches are delivered in rev
 * order: the first sets the expected rev; a newer one is held until the
 * missing rev arrives, `reorderWaitMs` passes, or the held batches exceed
 * `reorderWindowBatches` / `reorderBacklogDeliveries` (a gap: the missing
 * revs are given up and counted); an older or duplicate one is dropped.
 * Viewers see the rev jump and re-read the list.
 *
 * Bounds (`config/defaults.js` `channelLimits`, rule 12.6): a subscriber
 * with more than `subscriberQueueDeliveries` undelivered deliveries or
 * `subscriberQueueBytes` bytes is closed; a subscribe beyond
 * `subscribersPerSession` closes the one with the most queued bytes. A
 * closed subscriber is removed at once (it costs no further work) and its
 * `next()` answers `{ deliveries: [], closed: true, reason }` (reason: a
 * `shapes.CloseReason`, as `LiveBatch.reason`).
 *
 * Node module (adapter); reads the guest prelude from `globalThis`, which
 * the loader installs before importing `impl/index.js`.
 */
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces, shapes } from '../../../guest/lib/interfaces.js';
import { limits as guestLimits } from '../../../guest/lib/limits.js';
import { messageBytes } from '../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../../config/defaults.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * @typedef {'client' | 'queueDeliveries' | 'queueBytes' | 'subscriberLimit'} CloseReason
 * @typedef {{ seq: number, rev: number, event: any }} ListDelivery
 * @typedef {(fn: () => void, ms: number) => () => void} Schedule
 * @typedef {object} ListSubscriber
 * @property {(delivery: ListDelivery, size: number) => void} push
 * @property {(reason: CloseReason) => void} close
 * @property {any} facet the `ListSubscription` exo
 * @property {() => number} queuedBytes
 * @property {() => number} queuedDeliveries
 */

/** @type {Schedule} */
const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * One list subscriber.
 * @param {object} options
 * @param {number} options.queueLimit
 * @param {number} options.queueBytes
 * @param {(reason: CloseReason) => void} options.onClose
 * @returns {ListSubscriber}
 */
const makeListSubscriber = ({ queueLimit, queueBytes, onClose }) => {
  /** @type {ListDelivery[]} */
  const queue = [];
  /** @type {number[]} */
  const sizes = [];
  let bytes = 0;
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  const waiters = [];
  /** @type {CloseReason | undefined} */
  let closedFor;
  let flushScheduled = false;

  const take = () => {
    const deliveries = queue.splice(0, guestLimits.liveBatchDeliveries);
    for (const size of sizes.splice(0, deliveries.length)) bytes -= size;
    return harden({ deliveries });
  };
  const closedBatch = () =>
    harden({ deliveries: [], closed: true, reason: closedFor });

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
    const batch = closedBatch();
    for (const waiter of waiters.splice(0)) waiter.resolve(batch);
  };

  /**
   * @param {ListDelivery} delivery
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

  const facet = makeExo('ListSubscription', interfaces.ListSubscription, {
    async next() {
      if (closedFor !== undefined) return closedBatch();
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
    queuedBytes: () => bytes,
    queuedDeliveries: () => queue.length,
  });
};

/**
 * @param {object} [options]
 * @param {Partial<Record<keyof typeof channelLimits, number>>} [options.limits] defaults
 *   `channelLimits` (subscribersPerSession bounds list subscribers too)
 * @param {Schedule} [options.schedule] timers (tests pass their own)
 */
export const makeListChannel = ({
  limits: given = {},
  schedule = defaultSchedule,
} = {}) => {
  const lim = { ...channelLimits, ...given };
  let seq = 0;
  let latestRev = 0;
  /** @type {number | undefined} */
  let expectedRev;
  /** @type {{ rev: number, events: readonly any[] }[]} held batches, arrival order */
  const backlog = [];
  let heldDeliveries = 0;
  /** @type {(() => void) | undefined} */
  let cancelWait;
  const counts = {
    batches: 0,
    reordered: 0,
    dropped: 0,
    gaps: 0,
    missingRevs: 0,
  };
  /** @type {Map<CloseReason, number>} */
  const closes = new Map();
  /** @type {Set<ListSubscriber>} */
  const subscribers = new Set();

  /**
   * @param {any} event
   * @param {number} rev
   */
  const deliver = (event, rev) => {
    seq += 1;
    const delivery = harden({ seq, rev, event });
    const size = messageBytes(delivery);
    for (const subscriber of subscribers) subscriber.push(delivery, size);
  };

  /**
   * @param {number} rev
   * @param {readonly any[]} events
   */
  const deliverBatch = (rev, events) => {
    counts.batches += 1;
    latestRev = rev;
    expectedRev = rev + 1;
    for (const event of events) deliver(event, rev);
  };

  const drain = () => {
    for (;;) {
      const at = backlog.findIndex(item => item.rev === expectedRev);
      if (at < 0) break;
      const [item] = backlog.splice(at, 1);
      heldDeliveries -= item.events.length;
      counts.reordered += 1;
      deliverBatch(item.rev, item.events);
    }
    if (backlog.length === 0 && cancelWait !== undefined) {
      cancelWait();
      cancelWait = undefined;
    }
  };

  const declareGap = () => {
    let oldest = Infinity;
    for (const item of backlog) if (item.rev < oldest) oldest = item.rev;
    if (oldest === Infinity) return;
    counts.gaps += 1;
    counts.missingRevs += oldest - /** @type {number} */ (expectedRev);
    expectedRev = oldest;
    drain();
  };

  const armWait = () => {
    if (cancelWait !== undefined || backlog.length === 0) return;
    cancelWait = schedule(() => {
      cancelWait = undefined;
      declareGap();
      armWait();
    }, lim.reorderWaitMs);
  };

  const enforceWindow = () => {
    while (
      backlog.length > 0 &&
      (backlog.length > lim.reorderWindowBatches ||
        heldDeliveries > lim.reorderBacklogDeliveries)
    ) {
      declareGap();
    }
  };

  const publisher = makeExo('ListPublisher', interfaces.ListPublisher, {
    /** @param {any} batch a ListPublishBatch (the guard checked it) */
    publish({ rev, events }) {
      const batchRev = /** @type {number} */ (rev);
      if (expectedRev === undefined || batchRev === expectedRev) {
        deliverBatch(batchRev, events);
        drain();
        return;
      }
      if (
        batchRev < expectedRev ||
        backlog.some(item => item.rev === batchRev)
      ) {
        counts.dropped += 1;
        return;
      }
      backlog.push({ rev: batchRev, events });
      heldDeliveries += events.length;
      enforceWindow();
      armWait();
    },
  });

  const slowest = () => {
    /** @type {ListSubscriber | undefined} */
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

  /**
   * A new subscriber; its first delivery is the list snapshot marker. `rev`
   * is the viewer's rev (it compares; m1b-interfaces.md 3.6).
   * @param {number} [_rev]
   */
  const subscribe = _rev => {
    while (subscribers.size >= lim.subscribersPerSession) {
      slowest()?.close('subscriberLimit');
    }
    /** @type {ListSubscriber} */
    const subscriber = makeListSubscriber({
      queueLimit: lim.subscriberQueueDeliveries,
      queueBytes: lim.subscriberQueueBytes,
      onClose: reason => {
        subscribers.delete(subscriber);
        closes.set(reason, (closes.get(reason) ?? 0) + 1);
      },
    });
    subscribers.add(subscriber);
    const first = harden({
      seq,
      rev: latestRev,
      event: { type: 'list-snapshot' },
    });
    mustMatch(first, shapes.ListDelivery);
    subscriber.push(first, 0);
    return subscriber.facet;
  };

  return harden({
    publisher,
    subscribe,
    latestRev: () => latestRev,
    /** Subscribers attached (tests, diagnostics). */
    subscriberCount: () => subscribers.size,
    /** Ordering counters (tests, diagnostics). */
    ordering: () =>
      harden({
        ...counts,
        expectedRev: expectedRev ?? null,
        heldBatches: backlog.length,
        heldDeliveries,
      }),
    /** Closed subscribers by reason (tests, diagnostics). */
    closes: () => harden(Object.fromEntries(closes)),
  });
};
harden(makeListChannel);

/** @typedef {ReturnType<typeof makeListChannel>} ListChannel */
