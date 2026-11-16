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
 *   adapter restarted (not a turn-path signal): fetch a fresh publisher with
 *   `E(host).liveChannel()` and publish once more. Any other failure,
 *   including a retired break from `liveChannel()` (the manager vat is lost),
 *   drops the batch: viewers re-watch. Outside publishes are serialized so
 *   their revs leave in order.
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
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** Bytes kept free in every message for the batch wrapper (`rev`, `events`). */
const WRAPPER_BYTES = 64;
/** The largest event a batch may carry. */
const EVENT_BYTES = limits.frameBytes - WRAPPER_BYTES;
/** The text fields an event may carry that can approach the frame. */
const LARGE_FIELDS = harden(['input', 'args', 'result', 'text']);

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
      return harden({ ...event, [field]: cut });
    }
  }
  return event;
};
harden(fitEvent);

/**
 * @param {object} options
 * @param {any} options.host the session's SessionHostFacet
 */
export const makeLivePublishing = ({ host }) => {
  let rev = 1;
  /**
   * The publisher outside publishes use until it breaks.
   * @type {any}
   */
  let outsidePublisher;
  /** @type {Promise<void>} */
  let outsideTail = Promise.resolve();

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
      const fresh = await E(host).liveChannel();
      outsidePublisher = fresh;
      await E(fresh).publish(batch);
    }
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
     * Publish events outside a turn (answered). Resolves when every batch was
     * published or dropped; never rejects.
     * @param {readonly any[]} events
     * @returns {Promise<void>}
     */
    outside: events => {
      if (events.length === 0) return outsideTail;
      const batches = toBatches(events);
      for (const batch of batches) {
        outsideTail = outsideTail.then(
          () => publishOutside(batch).catch(() => {}),
          () => {},
        );
      }
      return outsideTail;
    },
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
