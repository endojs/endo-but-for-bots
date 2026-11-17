// @ts-check
/**
 * Live publishing from the session vat (M1a W1a.4; architecture 4.2, D-8;
 * `designs/m1a-interfaces.md` section 5).
 *
 * The session publishes the events of a crank as one batch,
 * `publish({ rev, events })`, split only when `publishBatchEvents` (64)
 * events or `frameBytes` would be exceeded. `rev` is the session's durable
 * revision: 1 when the session is made, one more for every batch (each
 * `publish` call), so a viewer that saw `watch().rev === n` expects the next
 * batch at `n + 1`.
 *
 * - Inside a turn the publisher comes with the turn's ports (same adapter
 *   incarnation as the Endpoint) and publishes with `E.sendOnly`: a stale
 *   publisher is revealed by the broken lease, not here.
 * - Outside a turn the publish is answered. A retired break means the
 *   adapter restarted (not a turn-path signal): `onStale(publisher)` tells
 *   the session (whose held ports carry that publisher, J-9151), then a fresh
 *   publisher comes from `E(host).liveChannel()` and the batch goes once
 *   more. Any other failure,
 *   including a retired break from `liveChannel()` (the manager vat is lost),
 *   drops the batch: viewers re-watch. Outside publishes are serialized so
 *   their revs leave in order: one in flight, the rest pending behind it.
 *   The pending ones are bounded (M1b W1b.0, J-9172): at most one batch's
 *   worth (`outsidePendingEvents` events and `frameBytes`); a newer batch
 *   drops the oldest pending one (its rev is never sent: viewers see the
 *   gap and re-watch). A `liveChannel()` or publish that never settles
 *   therefore holds one batch in flight and at most that bound pending.
 *
 * An event alone over the frame has its one large text field cut to fit
 * (the record log keeps the full text; the live view is a view).
 */
import { limits } from '../lib/limits.js';
import {
  cutText,
  fitsFrame,
  messageBytes,
  splitBatches,
  utf8Bytes,
} from '../lib/bounded.js';
import { isRetiredBreak } from '../lib/retired.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** Bytes kept free in every message for the batch wrapper (`rev`, `events`). */
const WRAPPER_BYTES = 64;
/** The largest event a batch may carry. */
const EVENT_BYTES = limits.frameBytes - WRAPPER_BYTES;
/** The text fields an event may carry that can approach the frame. */
const LARGE_FIELDS = harden(['input', 'args', 'result', 'text']);

/**
 * A copy of `event` with one of LARGE_FIELDS replaced, each key named in
 * the source (guest rule no-data-keys, J-9366).
 * @param {any} event
 * @param {string} field
 * @param {string} value
 */
const withField = (event, field, value) => {
  switch (field) {
    case 'input':
      return { ...event, input: value };
    case 'args':
      return { ...event, args: value };
    case 'result':
      return { ...event, result: value };
    default:
      return { ...event, text: value };
  }
};

/**
 * The event, or a copy with its large text field cut so the event fits
 * `budget` bytes.
 * @param {any} event
 * @param {number} [budget]
 */
export const fitEvent = (event, budget = EVENT_BYTES) => {
  if (fitsFrame(event, budget)) return event;
  for (const field of LARGE_FIELDS) {
    const value = event[field];
    if (typeof value === 'string' && value.length > 0) {
      const other = messageBytes(event) - utf8Bytes(value);
      const cut = cutText(value, Math.max(0, budget - other));
      return harden(withField(event, field, cut));
    }
  }
  return event;
};
harden(fitEvent);

/**
 * @param {object} options
 * @param {any} options.host the session's SessionHostFacet
 * @param {(publisher: any) => void} [options.onStale] called with a
 *   publisher whose answered publish broke with the retired text
 */
export const makeLivePublishing = ({ host, onStale = () => {} }) => {
  let rev = 1;
  /**
   * The publisher outside publishes use until it breaks.
   * @type {any}
   */
  let outsidePublisher;
  /**
   * Outside batches waiting behind the one in flight, oldest first, each
   * with the kit its `outside()` caller waits on.
   * @type {Set<{ batch: any, events: number, bytes: number, kit: { resolve: (v?: any) => void, promise: Promise<any> } }>}
   */
  const pending = new Set();
  let pendingEvents = 0;
  let pendingBytes = 0;
  /** @type {Promise<void> | undefined} the batch in flight, until it settles */
  let inFlight;
  let dropped = 0;

  /**
   * Number the events as batches: each gets the next rev.
   * @param {readonly any[]} events
   */
  const toBatches = events => {
    const fitted = events.map(event => fitEvent(event));
    return splitBatches(fitted, { maxBytes: EVENT_BYTES }).map(group => {
      rev += 1;
      return harden({ rev, events: harden(group) });
    });
  };

  /**
   * Publish one batch outside a turn, answered, refreshing the publisher
   * once on a retired break.
   * @param {any} batch
   */
  const publishOutside = async batch => {
    await null;
    if (outsidePublisher === undefined) {
      outsidePublisher = await E(host).liveChannel();
    }
    const publisher = outsidePublisher;
    try {
      await E(publisher).publish(batch);
    } catch (error) {
      if (!isRetiredBreak(error)) throw error;
      if (outsidePublisher === publisher) outsidePublisher = undefined;
      try {
        onStale(publisher);
      } catch {
        // The batch still goes out on a fresh publisher.
      }
      const fresh = await E(host).liveChannel();
      outsidePublisher = fresh;
      await E(fresh).publish(batch);
    }
  };

  /** The oldest pending batch, or undefined (a Set iterates in insertion order). */
  const oldestPending = () => pending.values().next().value;

  /** Start the oldest pending batch when none is in flight. */
  const pump = () => {
    if (inFlight !== undefined) return;
    const item = oldestPending();
    if (item === undefined) return;
    pending.delete(item);
    pendingEvents -= item.events;
    pendingBytes -= item.bytes;
    const settled = publishOutside(item.batch).then(
      () => {},
      () => {},
    );
    inFlight = settled;
    void settled.then(() => {
      inFlight = undefined;
      item.kit.resolve(undefined);
      pump();
    });
  };

  /**
   * Queue one batch; drop the oldest pending ones (never this one) while
   * the pending batches exceed one batch's worth.
   * @param {any} batch
   */
  const enqueueOutside = batch => {
    const item = harden({
      batch,
      events: batch.events.length,
      bytes: messageBytes(batch),
      kit: makePromiseKit(),
    });
    pending.add(item);
    pendingEvents += item.events;
    pendingBytes += item.bytes;
    while (
      pendingEvents > limits.outsidePendingEvents ||
      pendingBytes > limits.frameBytes
    ) {
      const oldest = oldestPending();
      if (oldest === undefined || oldest === item) break;
      pending.delete(oldest);
      pendingEvents -= oldest.events;
      pendingBytes -= oldest.bytes;
      dropped += 1;
      oldest.kit.resolve(undefined);
    }
    pump();
    return item.kit.promise;
  };

  return harden({
    /**
     * Publish a crank's events with the turn's publisher (sendOnly). Returns
     * the number of publish messages sent.
     * @param {{ publisher: any }} ports
     * @param {readonly any[]} events
     */
    inTurn: (ports, events) => {
      if (events.length === 0) return 0;
      outsidePublisher = ports.publisher;
      const batches = toBatches(events);
      for (const batch of batches) {
        E.sendOnly(ports.publisher).publish(batch);
      }
      return batches.length;
    },
    /**
     * Publish events outside a turn (answered). Resolves when each of its
     * batches was published or dropped (failed, or displaced while pending);
     * never rejects. With no events, resolves when everything queued now has
     * settled.
     * @param {readonly any[]} events
     * @returns {Promise<void>}
     */
    outside: events => {
      if (events.length === 0) {
        const waits = [...pending].map(item => item.kit.promise);
        if (inFlight !== undefined) waits.push(inFlight);
        return Promise.all(waits).then(() => {});
      }
      const waits = toBatches(events).map(enqueueOutside);
      return Promise.all(waits).then(() => {});
    },
    /**
     * Outside publishing state (tests, diagnostics): batches pending behind
     * the one in flight, their events and bytes, and how many were dropped.
     */
    outsideState: () =>
      harden({
        inFlight: inFlight !== undefined,
        pending: pending.size,
        pendingEvents,
        pendingBytes,
        dropped,
      }),
    /** The current rev (the last batch's, or 1 before any). */
    rev: () => rev,
    /**
     * Stop using this publisher for outside publishes (its ports were
     * dropped by recovery: it is a tombstone).
     * @param {any} publisher
     */
    forget: publisher => {
      if (outsidePublisher === publisher) outsidePublisher = undefined;
    },
  });
};
harden(makeLivePublishing);

/** @typedef {ReturnType<typeof makeLivePublishing>} LivePublishing */
