// @ts-check
/**
 * Session channels in the agent-host adapter (M1a W1a.3; architecture D-8,
 * section 4.2; designs/m1a-interfaces.md sections 3.2 and 5).
 *
 * One channel per Session presence (S2 (d): one presence per vat object per
 * adapter incarnation, so a `WeakMap` keyed by it finds the session's
 * channel and forgets it with the session). A channel has:
 *
 * - a **publisher** facet (`LivePublisher`), held by the session vat, which
 *   publishes one batch of vat events per crank;
 * - `publishDelta(event)`, called in-process by provider code for every text
 *   delta (zero vat deliveries per delta);
 * - **subscriber** facets (`LiveSubscription`), one per `subscribe()`, each
 *   with its own bounded queue; a subscriber that falls more than
 *   `subscriberQueueLimit` deliveries behind is dropped (closed) and must
 *   re-watch;
 * - the **fold** of the current (or last) turn, with Fae's `reply-fold.js`
 *   (W1a.1 copy), from which every subscription's first delivery, the
 *   snapshot, is made.
 *
 * Numbering. `seq` counts every delivery of this channel incarnation from 1
 * (vat events and deltas alike, in the order they were published). A
 * subscription's snapshot carries the `seq` of the last delivery it accounts
 * for (0 when the channel has had none), so the deliveries that follow it are
 * numbered `snapshot.seq + 1`, `+ 2`, ... with no gap. `rev` is the batch's
 * rev for vat events and the channel's latest vat rev for deltas and
 * snapshots (0 = no vat batch since the adapter started).
 *
 * Fold. `turn-start` begins a fresh fold for its turn; `phase`, `delta`,
 * `final`, `tool_call`, `tool_result`, `usage`, `end` and `abort` of that turn
 * are applied without their `turnId` (and `round`) keys; `end`/`abort` also
 * finish the fold and mark it settled. `pending` events and events of
 * another turn are delivered but not folded. The fold is kept within
 * `limits.foldTextUnits` (streaming text: a prefix is kept) and
 * `limits.foldMessages` (the oldest messages are dropped): a turn that
 * exceeds them has a snapshot that no longer equals a replay; this bounds the
 * adapter's retained state (rule 12.6).
 *
 * Node module (adapter); reads the guest prelude (`makeExo`, `M`,
 * `mustMatch`, `makePromiseKit`) from `globalThis`, which the loader installs
 * before importing `impl/index.js` (m1a-interfaces.md section 1.8).
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces, shapes } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../../guest/lib/reply-fold.js';
/* eslint-enable import/no-relative-packages */
import { channelTaps } from './channel-taps.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ChannelTap } from './channel-taps.js' */
/** @import { FoldableStatus } from '../../../guest/lib/reply-fold.js' */

const { makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * Undelivered deliveries one subscriber may have queued before it is dropped
 * (m1a-interfaces.md section 3.2, `LiveSubscription`).
 */
export const SUBSCRIBER_QUEUE_LIMIT = 4096;

/** What a closed subscription answers to every `next()`. */
const closedBatch = harden({ deliveries: [], closed: true });

/**
 * @typedef {{ seq: number, rev: number, event: any }} Delivery
 * @typedef {{
 *   turnId: string,
 *   fold: ReturnType<typeof makeReplyFold>,
 *   status: FoldableStatus,
 *   settled: boolean,
 * }} TurnFold
 */

/**
 * Cut `text` to at most `units` UTF-16 units without leaving a lone high
 * surrogate at the end.
 * @param {string} text
 * @param {number} units
 */
const cutUnits = (text, units) => {
  if (text.length <= units) return text;
  const code = text.charCodeAt(units - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? units - 1 : units;
  return text.slice(0, end);
};

/**
 * A passable copy of a fold's status (the live status keeps mutating).
 * @param {FoldableStatus} status
 */
const copyStatus = status =>
  harden({
    phase: status.phase,
    streamingText: status.streamingText,
    messages: status.messages.map(message => ({ ...message })),
    error: status.error,
    usage: status.usage === null ? null : { ...status.usage },
  });

/**
 * The event as the fold reads it: without `turnId` (and `round` for deltas),
 * so the folded usage matches `shapes.UsageTotals`.
 * @param {any} event
 */
const foldable = event => {
  if (event.type === 'delta') return { type: 'delta', text: event.text };
  const { turnId: _turnId, ...rest } = event;
  return rest;
};

/**
 * One subscriber: its queue, its pending `next()` callers and its facet.
 * @param {object} options
 * @param {number} options.queueLimit
 * @param {() => void} options.onClose removes it from its channel
 */
const makeSubscriber = ({ queueLimit, onClose }) => {
  /** @type {Delivery[]} */
  const queue = [];
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  const waiters = [];
  let closed = false;
  let flushScheduled = false;

  const take = () =>
    harden({ deliveries: queue.splice(0, limits.liveBatchDeliveries) });

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

  const close = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    onClose();
    for (const waiter of waiters.splice(0)) waiter.resolve(closedBatch);
  };

  /**
   * Queue one delivery. A waiting `next()` is answered on a microtask, so the
   * events of one publish (or of one synchronous burst) arrive in one batch.
   * @param {Delivery} delivery
   */
  const push = delivery => {
    if (closed) return;
    queue.push(delivery);
    if (queue.length > queueLimit) {
      close();
      return;
    }
    if (waiters.length > 0 && !flushScheduled) {
      flushScheduled = true;
      void Promise.resolve().then(flush);
    }
  };

  const facet = makeExo('LiveSubscription', interfaces.LiveSubscription, {
    async next() {
      if (closed) return closedBatch;
      if (queue.length > 0 && waiters.length === 0) return take();
      const waiter = makePromiseKit();
      waiters.push(waiter);
      return waiter.promise;
    },
    close() {
      close();
    },
  });

  return harden({ push, close, facet, isClosed: () => closed });
};

/**
 * @param {any} session the Session presence this channel belongs to
 * @param {object} options
 * @param {readonly ChannelTap[]} options.taps
 * @param {number} options.queueLimit
 */
const makeChannel = (session, { taps, queueLimit }) => {
  let seq = 0;
  let latestRev = 0;
  /** @type {TurnFold | undefined} */
  let current;
  /** @type {Set<ReturnType<typeof makeSubscriber>>} */
  const subscribers = new Set();

  /** Keep the fold within the adapter's bounds (rule 12.6). */
  const boundFold = () => {
    if (current === undefined) return;
    const { status } = current;
    if (status.streamingText.length > limits.foldTextUnits) {
      status.streamingText = cutUnits(
        status.streamingText,
        limits.foldTextUnits,
      );
    }
    if (status.messages.length > limits.foldMessages) {
      status.messages.splice(0, status.messages.length - limits.foldMessages);
    }
  };

  /** @param {any} event */
  const foldEvent = event => {
    if (event.type === 'turn-start') {
      current = {
        turnId: event.turnId,
        fold: makeReplyFold(),
        status: makeFoldableStatus(),
        settled: false,
      };
      return;
    }
    if (event.type === 'pending') return;
    if (
      current === undefined ||
      current.settled ||
      event.turnId !== current.turnId
    ) {
      return;
    }
    current.fold.apply(current.status, /** @type {any} */ (foldable(event)));
    if (event.type === 'end' || event.type === 'abort') {
      current.fold.finish(current.status);
      current.settled = true;
    }
    boundFold();
  };

  /**
   * Number, fold, fan out and tap one event.
   * @param {any} event hardened
   * @param {number} rev
   */
  const deliver = (event, rev) => {
    seq += 1;
    const delivery = harden({ seq, rev, event });
    foldEvent(event);
    for (const subscriber of subscribers) subscriber.push(delivery);
    for (const tap of taps) {
      try {
        tap(session, delivery);
      } catch {
        // A tap must not break the channel (channel-taps.js).
      }
    }
  };

  const snapshot = () => {
    if (current === undefined) return harden({ type: 'snapshot' });
    return harden({
      type: 'snapshot',
      turn: {
        turnId: current.turnId,
        settled: current.settled,
        status: copyStatus(current.status),
      },
    });
  };

  const publisher = makeExo('LivePublisher', interfaces.LivePublisher, {
    /** @param {any} batch a PublishBatch (the guard checked it) */
    publish({ rev, events }) {
      // An outside publish that first fetched a publisher can arrive after
      // a newer in-turn batch: never move latestRev back (QC advisory 4).
      // The late batch is still delivered, stamped with its own rev.
      const batchRev = /** @type {number} */ (rev);
      if (batchRev > latestRev) latestRev = batchRev;
      for (const event of events) deliver(event, rev);
    },
  });

  /** @param {any} event a DeltaEvent */
  const publishDelta = event => {
    mustMatch(event, shapes.DeltaEvent);
    const { turnId, round, text } = event;
    deliver(harden({ type: 'delta', turnId, round, text }), latestRev);
  };

  /**
   * A new subscriber; its first delivery is the snapshot. `rev` is the
   * client's watched rev (the client compares it; section 5).
   * @param {number} [_rev]
   */
  const subscribe = _rev => {
    /** @type {ReturnType<typeof makeSubscriber>} */
    const subscriber = makeSubscriber({
      queueLimit,
      onClose: () => subscribers.delete(subscriber),
    });
    subscribers.add(subscriber);
    subscriber.push(harden({ seq, rev: latestRev, event: snapshot() }));
    return subscriber.facet;
  };

  return harden({
    publisher,
    publishDelta,
    subscribe,
    snapshot,
    latestRev: () => latestRev,
    /** Subscribers currently attached (tests, diagnostics). */
    subscriberCount: () => subscribers.size,
  });
};

/**
 * @typedef {ReturnType<typeof makeChannel>} Channel
 */

/**
 * The adapter's session channels: one per Session presence.
 * @param {object} [options]
 * @param {readonly ChannelTap[]} [options.taps] the hook table (default `channelTaps`)
 * @param {number} [options.subscriberQueueLimit] default `SUBSCRIBER_QUEUE_LIMIT`
 */
export const makeChannelRegistry = ({
  taps = channelTaps,
  subscriberQueueLimit = SUBSCRIBER_QUEUE_LIMIT,
} = {}) => {
  /** @type {WeakMap<object, Channel>} */
  const channels = new WeakMap();
  /**
   * @param {any} session
   * @returns {Channel}
   */
  const channelFor = session => {
    let channel = channels.get(session);
    if (channel === undefined) {
      channel = makeChannel(session, {
        taps,
        queueLimit: subscriberQueueLimit,
      });
      channels.set(session, channel);
    }
    return channel;
  };
  return harden({ channelFor });
};
harden(makeChannelRegistry);
