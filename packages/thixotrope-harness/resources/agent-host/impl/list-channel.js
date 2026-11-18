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
 * Numbering and order, as the session channel (`channels.js`; the queue and
 * the rev order are `channel-subscriber.js`, shared by both): `seq` counts
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
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces, shapes } from '../../../guest/lib/interfaces.js';
import { messageBytes } from '../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../../config/defaults.js';
import {
  makeRevReorder,
  makeSubscriber,
  slowestOf,
  unrefSchedule,
} from './channel-subscriber.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * @typedef {import('./channel-subscriber.js').CloseReason} CloseReason
 * @typedef {import('./channel-subscriber.js').Schedule} Schedule
 * @typedef {import('./channel-subscriber.js').Subscriber} ListSubscriber
 * @typedef {{ seq: number, rev: number, event: any }} ListDelivery
 */

/**
 * @param {object} [options]
 * @param {Partial<Record<keyof typeof channelLimits, number>>} [options.limits] defaults
 *   `channelLimits` (subscribersPerSession bounds list subscribers too)
 * @param {Schedule} [options.schedule] timers (tests pass their own)
 */
export const makeListChannel = ({
  limits: given = {},
  schedule = unrefSchedule,
} = {}) => {
  const lim = { ...channelLimits, ...given };
  let seq = 0;
  let batches = 0;
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

  const reorder = makeRevReorder({
    limits: lim,
    schedule,
    deliverBatch: (rev, events) => {
      batches += 1;
      for (const event of events) deliver(event, rev);
    },
  });

  const publisher = makeExo('ListPublisher', interfaces.ListPublisher, {
    /** @param {any} batch a ListPublishBatch (the guard checked it) */
    publish({ rev, events }) {
      reorder.publish(/** @type {number} */ (rev), events);
    },
  });

  /**
   * A new subscriber; its first delivery is the list snapshot marker. `rev`
   * is the viewer's rev (it compares; m1b-interfaces.md 3.6).
   * @param {number} [_rev]
   */
  const subscribe = _rev => {
    while (subscribers.size >= lim.subscribersPerSession) {
      slowestOf(subscribers)?.close('subscriberLimit');
    }
    /** @type {ListSubscriber} */
    const subscriber = makeSubscriber({
      exoName: 'ListSubscription',
      guard: interfaces.ListSubscription,
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
      rev: reorder.latestRev(),
      event: { type: 'list-snapshot' },
    });
    mustMatch(first, shapes.ListDelivery);
    subscriber.push(first, 0);
    return subscriber.facet;
  };

  return harden({
    publisher,
    subscribe,
    latestRev: reorder.latestRev,
    /** Subscribers attached (tests, diagnostics). */
    subscriberCount: () => subscribers.size,
    /** Ordering counters (tests, diagnostics). */
    ordering: () => harden({ batches, ...reorder.ordering() }),
    /** Closed subscribers by reason (tests, diagnostics). */
    closes: () => harden(Object.fromEntries(closes)),
  });
};
harden(makeListChannel);

/** @typedef {ReturnType<typeof makeListChannel>} ListChannel */
