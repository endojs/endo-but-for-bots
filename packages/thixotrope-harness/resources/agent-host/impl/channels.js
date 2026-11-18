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
 *   with its own bounded queue (see "Bounds");
 * - the **fold** of the current (or last) turn, with Fae's `reply-fold.js`
 *   (W1a.1 copy), from which every subscription's first delivery, the
 *   snapshot, is made.
 *
 * Numbering. `seq` counts every delivery of this channel incarnation from 1
 * (vat events and deltas alike, in the order they are delivered). A
 * subscription's snapshot carries the `seq` of the last delivery it accounts
 * for (0 when the channel has had none), so the deliveries that follow it are
 * numbered `snapshot.seq + 1`, `+ 2`, ... with no gap. `rev` is the batch's
 * rev for vat events and the channel's latest delivered vat rev for deltas
 * and snapshots (0 = no vat batch since the adapter started).
 *
 * Ordering (QC advisory 4; JOURNAL J-9170). The session vat numbers its
 * batches: `rev` is its durable revision, one more for every `publish` call
 * (guest/session/live.js). The channel delivers vat batches in rev order
 * and never out of it:
 *
 * - the first batch a channel incarnation sees sets the expected rev (an
 *   adapter restart starts a fresh channel; earlier revs went to the old
 *   incarnation);
 * - a batch with the expected rev is delivered at once, then anything held
 *   behind it;
 * - a batch with a newer rev is held (a late older one is on its way: an
 *   outside-a-turn publish that first fetched a publisher can arrive after
 *   the next turn's in-turn batches); deltas that arrive while a batch is
 *   held are held behind it, so a turn's deltas never overtake its
 *   `turn-start`;
 * - a batch at or below the last delivered rev, or one already held, is a
 *   duplicate or arrived after its gap was declared: dropped and counted;
 * - a gap: when the missing rev has not arrived within `reorderWaitMs`, or
 *   the held batches or deliveries exceed `reorderWindowBatches` /
 *   `reorderBacklogDeliveries`, the channel gives the missing revs up,
 *   counts the gap and delivers what it holds in rev order. Subscribers see
 *   the rev jump; the client rule (section 5) is to re-watch.
 *
 * Bounds (`config/defaults.js` `channelLimits`; rule 12.6). A subscriber is
 * dropped (closed, with a reason the channel records) when it has more than
 * `subscriberQueueDeliveries` undelivered deliveries or more than
 * `subscriberQueueBytes` UTF-8 bytes of them (the snapshot is not counted:
 * the fold bounds it); a subscribe beyond `subscribersPerSession` drops the
 * subscriber with the most queued bytes first. `LiveBatch` has no field for
 * the reason (a contract change), so a dropped client sees `closed: true`.
 *
 * Validation. Every delivery is checked once where it is made: vat events by
 * the `LivePublisher` guard, deltas by `publishDelta`'s `mustMatch`, the
 * snapshot by `mustMatch(shapes.SnapshotEvent)` at `subscribe()`. The
 * subscriber facet's `next()` return guard therefore checks only the batch
 * envelope (`LIVE_SUBSCRIPTION_GUARD`), not each delivery again: the
 * contract's `S.LiveBatch` guard cost 14 ms per 256-delivery batch (J-0230,
 * J-0231). What a client receives still matches `S.LiveBatch`.
 *
 * Fold. `turn-start` begins a fresh fold for its turn; `phase`, `delta`,
 * `final`, `tool_call`, `tool_result`, `usage`, `end` and `abort` of that turn
 * are applied without their `turnId` (and `round`) keys; `end`/`abort` also
 * finish the fold and mark it settled. `pending` events and events of
 * another turn are delivered but not folded. The fold is kept within
 * `limits.foldTextUnits` (streaming text: a prefix is kept) and
 * `limits.foldMessages` (the oldest messages are dropped): a turn that
 * exceeds them has a snapshot that no longer equals a replay.
 *
 * Live probe (perf only; `perf/turn.perf.mjs`): a registry made with a
 * `probe` gives every channel one more subscriber in this process, as a
 * gateway would hold, that reads with `E(subscription).next()` and appends
 * the time from each delta's publish to its arrival there
 * (`performance.now()`, ms) to the probe's file, one line per delta, written
 * when the turn settles. The registry has none unless one is passed: tests
 * pass one, and a perf run that serves its own daemon names a directory in
 * `THIX_HARNESS_LIVE_PROBE_DIR` in that daemon's environment
 * (`liveProbeFromEnv`, read by `impl/index.js`). Nothing on disk switches it
 * on (HR-SYN-13: it was a file under the source tree, which reached every
 * daemon run from it).
 *
 * Node module (adapter); reads the guest prelude (`makeExo`, `M`,
 * `mustMatch`, `makePromiseKit`, `E`) from `globalThis`, which the loader
 * installs before importing `impl/index.js` (m1a-interfaces.md section 1.8).
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pid } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import {
  interfaces,
  m1bShapes,
  shapes,
} from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { messageBytes } from '../../../guest/lib/bounded.js';
import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../../guest/lib/reply-fold.js';
import { isStaged } from '../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../../config/defaults.js';
import { channelTaps } from './channel-taps.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ChannelTap } from './channel-taps.js' */
/** @import { FoldableStatus } from '../../../guest/lib/reply-fold.js' */

const { E, M, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * Undelivered deliveries one subscriber may have queued before it is dropped
 * (m1a-interfaces.md section 3.2, `LiveSubscription`).
 */
export const SUBSCRIBER_QUEUE_LIMIT = channelLimits.subscriberQueueDeliveries;

/**
 * Why a subscriber was closed (recorded by the channel; see `closes()`).
 */
export const closeReasons = harden({
  client: 'closed by its client',
  queueDeliveries: 'too many undelivered deliveries',
  queueBytes: 'too many undelivered bytes',
  subscriberLimit: 'dropped for a new subscriber (subscribersPerSession)',
});

/**
 * The subscriber facet's interface: the contract's `LiveSubscription`
 * methods, with `next()` returning a guard on the batch envelope only (each
 * delivery was checked once where it was made; see "Validation" above).
 */
export const LIVE_SUBSCRIPTION_GUARD = M.interface('LiveSubscription', {
  next: M.callWhen().returns(
    M.splitRecord(
      {
        deliveries: M.arrayOf(M.any(), {
          arrayLengthLimit: limits.liveBatchDeliveries,
        }),
      },
      // `reason` (M1b W1b.1, J-9172): the closeReasons key.
      { closed: M.boolean(), reason: m1bShapes.CloseReason },
    ),
  ),
  close: M.call().returns(M.undefined()),
});

/**
 * What a closed subscription answers to every `next()`.
 * @param {keyof typeof closeReasons} reason
 */
const closedBatch = reason => harden({ deliveries: [], closed: true, reason });

/**
 * @typedef {{ seq: number, rev: number, event: any }} Delivery
 * @typedef {{
 *   turnId: string,
 *   fold: ReturnType<typeof makeReplyFold>,
 *   status: FoldableStatus,
 *   settled: boolean,
 * }} TurnFold
 * @typedef {(fn: () => void, ms: number) => () => void} Schedule runs `fn`
 *   once after `ms`; returns a cancel function
 * @typedef {{ kind: 'batch', rev: number, events: readonly any[] } | { kind: 'delta', event: any }} Held
 */

/** @type {Schedule} */
const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

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

/** Event fields that may be a StagedText (m1b-interfaces.md 5.1). */
const STAGED_FIELDS = harden(['input', 'args', 'result', 'text']);

/**
 * The event as the fold reads it: without `turnId` (and `round` for deltas),
 * so the folded usage matches `shapes.UsageTotals`.
 * @param {any} event
 */
const foldable = event => {
  if (event.type === 'delta') return { type: 'delta', text: event.text };
  const { turnId: _turnId, ...rest } = event;
  // M1b (W1b.1): a staged field folds as its preview; the event itself is
  // delivered with the StagedText (clients read the text through Content).
  for (const field of STAGED_FIELDS) {
    if (isStaged(rest[field])) rest[field] = rest[field].preview;
  }
  return rest;
};

/**
 * One subscriber: its queue, its pending `next()` callers and its facet.
 * @param {object} options
 * @param {number} options.queueLimit deliveries
 * @param {number} options.queueBytes UTF-8 bytes of queued deliveries
 * @param {(reason: string) => void} options.onClose removes it from its
 *   channel and records the reason
 */
const makeSubscriber = ({ queueLimit, queueBytes, onClose }) => {
  /** @type {Delivery[]} */
  const queue = [];
  /** @type {number[]} bytes of each queued delivery, in step with `queue` */
  const sizes = [];
  let bytes = 0;
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  const waiters = [];
  let closed = false;
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

  /** @type {keyof typeof closeReasons} */
  let closedFor = 'client';
  /** @param {keyof typeof closeReasons} reason a closeReasons key */
  const close = reason => {
    if (closed) return;
    closed = true;
    closedFor = reason;
    queue.length = 0;
    sizes.length = 0;
    bytes = 0;
    onClose(closeReasons[reason]);
    for (const waiter of waiters.splice(0)) {
      waiter.resolve(closedBatch(reason));
    }
  };

  /**
   * Queue one delivery. A waiting `next()` is answered on a microtask, so the
   * events of one publish (or of one synchronous burst) arrive in one batch.
   * @param {Delivery} delivery
   * @param {number} size its UTF-8 bytes (0 for the snapshot)
   */
  const push = (delivery, size) => {
    if (closed) return;
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

  const facet = makeExo('LiveSubscription', LIVE_SUBSCRIPTION_GUARD, {
    async next() {
      if (closed) return closedBatch(closedFor);
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
    isClosed: () => closed,
    queuedBytes: () => bytes,
    queuedDeliveries: () => queue.length,
  });
};

/**
 * @typedef {object} ChannelOptions
 * @property {readonly ChannelTap[]} taps
 * @property {number} queueLimit
 * @property {number} queueBytes
 * @property {number} maxSubscribers
 * @property {number} reorderWindowBatches
 * @property {number} reorderBacklogDeliveries
 * @property {number} reorderWaitMs
 * @property {Schedule} schedule
 */

/**
 * @param {any} session the Session presence this channel belongs to
 * @param {ChannelOptions} options
 */
const makeChannel = (
  session,
  {
    taps,
    queueLimit,
    queueBytes,
    maxSubscribers,
    reorderWindowBatches,
    reorderBacklogDeliveries,
    reorderWaitMs,
    schedule,
  },
) => {
  let seq = 0;
  /** The last delivered vat rev (0 = none yet). */
  let latestRev = 0;
  /** The rev the next vat batch must carry; undefined before the first. */
  /** @type {number | undefined} */
  let expectedRev;
  /**
   * What arrived behind a missing rev, in arrival order: vat batches newer
   * than `expectedRev` and the deltas that came after the first of them.
   * Empty, or its first entry is a batch.
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
    /** Times the channel gave missing revs up. */
    gaps: 0,
    /** Revs given up in those gaps. */
    missingRevs: 0,
  };
  /** @type {Map<string, number>} closed subscribers by reason */
  const closes = new Map();
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

  /** @type {((delivery: Delivery) => void) | undefined} */
  let onDeliver;

  /**
   * Number, fold, fan out and tap one event.
   * @param {any} event hardened
   * @param {number} rev
   */
  const deliver = (event, rev) => {
    seq += 1;
    const delivery = harden({ seq, rev, event });
    const size = messageBytes(delivery);
    foldEvent(event);
    if (onDeliver !== undefined) onDeliver(delivery);
    for (const subscriber of subscribers) subscriber.push(delivery, size);
    for (const tap of taps) {
      try {
        tap(session, delivery);
      } catch {
        // A tap must not break the channel (channel-taps.js).
      }
    }
  };

  /**
   * @param {number} rev
   * @param {readonly any[]} events
   */
  const deliverBatch = (rev, events) => {
    latestRev = rev;
    expectedRev = rev + 1;
    for (const event of events) deliver(event, rev);
  };

  /**
   * Deliver from the backlog what may go now: deltas at its head, and the
   * batch with the expected rev wherever it is.
   */
  const drain = () => {
    while (backlog.length > 0) {
      const head = backlog[0];
      if (head.kind === 'delta') {
        backlog.shift();
        heldDeliveries -= 1;
        deliver(head.event, latestRev);
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
        deliverBatch(item.rev, item.events);
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
      const batchRev = /** @type {number} */ (rev);
      if (expectedRev === undefined || batchRev === expectedRev) {
        deliverBatch(batchRev, events);
        drain();
        return;
      }
      if (
        batchRev < expectedRev ||
        backlog.some(item => item.kind === 'batch' && item.rev === batchRev)
      ) {
        counts.dropped += 1;
        return;
      }
      backlog.push({ kind: 'batch', rev: batchRev, events });
      heldBatches += 1;
      heldDeliveries += events.length;
      enforceWindow();
      armWait();
    },
  });

  /** @param {any} event a DeltaEvent */
  const publishDelta = event => {
    mustMatch(event, shapes.DeltaEvent);
    const { turnId, round, text } = event;
    const delta = harden({ type: 'delta', turnId, round, text });
    if (backlog.length === 0) {
      deliver(delta, latestRev);
      return;
    }
    backlog.push({ kind: 'delta', event: delta });
    heldDeliveries += 1;
    enforceWindow();
  };

  /** The attached subscriber with the most queued bytes (then deliveries). */
  const slowest = () => {
    /** @type {ReturnType<typeof makeSubscriber> | undefined} */
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
   * A new subscriber; its first delivery is the snapshot. `rev` is the
   * client's watched rev (the client compares it; section 5).
   * @param {number} [_rev]
   */
  const subscribe = _rev => {
    const first = snapshot();
    mustMatch(first, shapes.SnapshotEvent);
    while (subscribers.size >= maxSubscribers) {
      slowest()?.close('subscriberLimit');
    }
    /** @type {ReturnType<typeof makeSubscriber>} */
    const subscriber = makeSubscriber({
      queueLimit,
      queueBytes,
      onClose: reason => {
        subscribers.delete(subscriber);
        closes.set(reason, (closes.get(reason) ?? 0) + 1);
      },
    });
    subscribers.add(subscriber);
    subscriber.push(harden({ seq, rev: latestRev, event: first }), 0);
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
    /** Ordering counters (tests, diagnostics). */
    ordering: () =>
      harden({
        ...counts,
        expectedRev: expectedRev ?? null,
        heldBatches,
        heldDeliveries,
      }),
    /** Closed subscribers by reason (tests, diagnostics). */
    closes: () => harden(Object.fromEntries(closes)),
    /**
     * Observe every delivery as it is numbered, before the fan-out (the live
     * probe; one observer).
     * @param {(delivery: Delivery) => void} observer
     */
    setDeliveryObserver: observer => {
      onDeliver = observer;
    },
  });
};

/**
 * @typedef {ReturnType<typeof makeChannel>} Channel
 */

/**
 * The live probe (see the module comment): one in-process subscriber per
 * channel that records each delta's publish-to-arrival time.
 * @param {object} options
 * @param {string} options.file the JSON-lines file to append to
 * @param {() => number} [options.now] ms, monotonic
 */
export const makeLiveProbe = ({ file, now = () => performance.now() }) => {
  let channelCount = 0;
  /** @param {Channel} channel */
  const attach = channel => {
    channelCount += 1;
    const channelNumber = channelCount;
    /** @type {Map<number, number>} seq -> publish time of a delta */
    const published = new Map();
    /** @type {string[]} */
    let lines = [];
    channel.setDeliveryObserver(delivery => {
      if (delivery.event.type === 'delta') published.set(delivery.seq, now());
    });
    const subscription = channel.subscribe();
    const write = () => {
      if (lines.length === 0) return;
      const text = lines.join('');
      lines = [];
      try {
        appendFileSync(file, text);
      } catch {
        // The probe must not break the adapter.
      }
    };
    const loop = async () => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(subscription).next();
        const arrivedAt = now();
        if (batch.closed) break;
        for (const { seq, event } of batch.deliveries) {
          const at = published.get(seq);
          if (at !== undefined) {
            published.delete(seq);
            lines.push(
              `${JSON.stringify({ kind: 'live-probe', pid, channel: channelNumber, turnId: event.turnId, round: event.round, seq, ms: +(arrivedAt - at).toFixed(3), batch: batch.deliveries.length })}\n`,
            );
          } else if (event.type === 'end' || event.type === 'abort') {
            write();
          }
        }
        if (lines.length >= limits.liveBatchDeliveries) write();
      }
      write();
    };
    void loop().catch(() => {});
  };
  return harden({ attach });
};
harden(makeLiveProbe);

/** The variable a perf run sets in the environment of the daemon it serves. */
export const LIVE_PROBE_VARIABLE = 'THIX_HARNESS_LIVE_PROBE_DIR';

/**
 * The live probe a perf run asked for through its daemon's environment:
 * lines go to `<dir>/<pid>.jsonl`; `null` when the variable is unset or not
 * an absolute path.
 * @param {Record<string, string | undefined>} env
 */
export const liveProbeFromEnv = env => {
  const dir = env[LIVE_PROBE_VARIABLE];
  return typeof dir === 'string' && path.isAbsolute(dir)
    ? makeLiveProbe({ file: path.join(dir, `${pid}.jsonl`) })
    : null;
};
harden(liveProbeFromEnv);

/**
 * The adapter's session channels: one per Session presence.
 * @param {object} [options]
 * @param {readonly ChannelTap[]} [options.taps] the hook table (default `channelTaps`)
 * @param {number} [options.subscriberQueueLimit] deliveries (default `SUBSCRIBER_QUEUE_LIMIT`)
 * @param {number} [options.subscriberQueueBytes]
 * @param {number} [options.subscribersPerSession]
 * @param {number} [options.reorderWindowBatches]
 * @param {number} [options.reorderBacklogDeliveries]
 * @param {number} [options.reorderWaitMs]
 * @param {Schedule} [options.schedule] timers (tests pass their own)
 * @param {ReturnType<typeof makeLiveProbe> | null} [options.probe] the live
 *   probe (perf, tests); default none
 */
export const makeChannelRegistry = ({
  taps = channelTaps,
  subscriberQueueLimit = SUBSCRIBER_QUEUE_LIMIT,
  subscriberQueueBytes = channelLimits.subscriberQueueBytes,
  subscribersPerSession = channelLimits.subscribersPerSession,
  reorderWindowBatches = channelLimits.reorderWindowBatches,
  reorderBacklogDeliveries = channelLimits.reorderBacklogDeliveries,
  reorderWaitMs = channelLimits.reorderWaitMs,
  schedule = defaultSchedule,
  probe = null,
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
        queueBytes: subscriberQueueBytes,
        maxSubscribers: subscribersPerSession,
        reorderWindowBatches,
        reorderBacklogDeliveries,
        reorderWaitMs,
        schedule,
      });
      channels.set(session, channel);
      if (probe) probe.attach(channel);
    }
    return channel;
  };
  return harden({ channelFor });
};
harden(makeChannelRegistry);
