// @ts-check
/**
 * When a waiting message may start (M2 W2.4; `designs/m2-interfaces.md` 5;
 * spec A.4 "Queue", R4-54, R4-56). Adapted from Fae
 * `session/session-submissions.js` at `1315bef86`: the hold, its release
 * rule, the "nothing left to hold" rule and send-now, over the pending queue
 * (`guest/lib/pending-queue.js`). What Fae needs and this does not:
 *
 * - No serial promise chain, `ready`/`initialise` or `close`: every
 *   operation is synchronous in one crank, and the heap is the record.
 * - No `dispatch` with `onBegun`/`release`: the claim removes the entry in
 *   the crank that appends `TurnStarted`, so a turn that "never began" holds
 *   no entry to give back (architecture 4.3). The session claims
 *   (`SessionCore.claimNext()`); `first()` says what it may claim.
 * - No load-time `restart` hold: a restart is learned from the turn's lease
 *   (recovery.js holds `restart`); a queue that cannot be read
 *   (`unavailable`) cannot happen to a heap.
 * - Send-now moves the entry to the head (5.1) rather than answering
 *   `cancelCurrent`: the running turn is never cut short by a queued
 *   message; the entry waits at the head and starts next.
 *
 * The rules (R4-56): a new message (not a duplicate) or send-now releases
 * every hold except the ones that need a decision about their message
 * (`holds.js` `releaseRule`); a hold never replaces `interrupted`; once no
 * entry waits, no hold is left (Fae `cancel`).
 *
 * Vat module: prelude globals only, no clock.
 */
import { releaseRule } from './holds.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { makePendingQueue, Internal } from '../lib/pending-queue.js' */
const { harden } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {{ reason: any, message: string }} Hold
 * @typedef {ReturnType<typeof makePendingQueue>} PendingQueue
 */

/**
 * @param {object} options
 * @param {PendingQueue} options.pending
 * @param {() => void} [options.onChange] runs after every change of the hold
 */
export const makeSubmissions = ({ pending, onChange = () => {} }) => {
  /** @type {Hold | undefined} */
  let current;

  /** @param {Hold | undefined} next */
  const setHold = next => {
    if (current?.reason === next?.reason && current?.message === next?.message)
      return;
    current = next;
    try {
      onChange();
    } catch {
      // The change has happened; see pending-queue.js.
    }
  };

  /** R4-56: what a new message or send-now does to the hold. */
  const userSent = () => {
    if (current !== undefined && releaseRule(current.reason))
      setHold(undefined);
  };

  /** Nothing waits: nothing is left to hold. */
  const ifEmpty = () => {
    if (pending.size() === 0) setHold(undefined);
  };

  return harden({
    /**
     * Accept a message; a new one releases the hold, a duplicate nothing.
     * @param {any} submission
     * @param {string} requestId
     * @param {number} at
     * @param {readonly { label: string, value: any }[]} [attachments] M5
     */
    enqueue: (submission, requestId, at, attachments = undefined) => {
      const result = pending.enqueue(submission, requestId, at, attachments);
      if (result.added) userSent();
      return result;
    },
    /**
     * Send-now: to the head, and the hold released (5.1). The caller
     * claims when the session is idle.
     * @param {Internal} internal
     */
    sendNow: internal => {
      pending.toHead(internal);
      userSent();
    },
    /** @param {Internal} internal */
    cancel: internal => {
      const removed = pending.cancel(internal);
      ifEmpty();
      return removed;
    },
    /**
     * @param {Internal} internal
     * @param {any} turnId
     */
    take: (internal, turnId) => {
      pending.take(internal, turnId);
      ifEmpty();
    },
    /**
     * @param {any} reason
     * @param {string} message
     */
    hold: (reason, message) => {
      // An interrupted hold needs a decision about its message; no other
      // reason replaces it (Fae holdForStop).
      if (current?.reason === 'interrupted' && reason !== 'interrupted') return;
      setHold(harden({ reason, message }));
    },
    /** Lifts every hold but one that needs a decision. */
    release: () => {
      if (current !== undefined && current.reason !== 'interrupted')
        setHold(undefined);
    },
    /** The entry the session may claim: none while held. */
    first: () => (current === undefined ? pending.first() : undefined),
    /** @returns {Hold | undefined} */
    current: () => current,
  });
};
harden(makeSubmissions);
