// @ts-check
/**
 * A session's queue (M1a W1a.5, M2 W2.4; `designs/m1a-interfaces.md` 8,
 * `designs/m2-interfaces.md` 5; spec A.4 "Queue", R4-53..R4-56).
 *
 * The QueueEntry exos and the views over two parts:
 * - `guest/lib/pending-queue.js`: the waiting entries (at most
 *   `limits.maxWaiting`) and the receipts (at most `limits.maxReceipts` in
 *   the 24 h window of the Composer's stamps), request ids, duplicates by
 *   request id and by fingerprint (an inline text, or a staged text's
 *   digest), edit, cancel, move to the head, the claim;
 * - `submissions.js`: the hold, the release rule (R4-56), send-now.
 *
 * The heap is the durable record (orthogonal persistence), so unlike Fae
 * there is no `dispatching` or `interrupted` entry state: the claim removes
 * the entry in the crank that appends `TurnStarted` (architecture 4.3).
 *
 * What the queue decides and what it leaves to the session:
 * - `enqueueOnce` answers duplicates, applies the bounds, appends the entry
 *   and, for a new entry, releases every hold except `interrupted`. It never
 *   starts a turn: the session claims (`SessionCore.claimNext()`) after it.
 * - `first()` is the entry the session may claim, `undefined` while a hold
 *   is set. `claim(item, turnId)` removes it and turns its receipt
 *   `started` with the turn id, in the caller's crank. A started receipt
 *   keeps the turn id only (5.3): `turnOf(turnId)` gives the Turn while the
 *   session keeps the turn, else the receipt carries `turnId` alone.
 * - `QueueEntry.edit` replaces the text (the Composer stages it),
 *   `cancel` drops the entry, `sendNow` moves it to the head, releases the
 *   hold and asks the session to `claim()` (it starts at once when idle,
 *   next when a turn runs).
 * - `onChange()` runs after every change of the entries or the hold (the
 *   session publishes `pending` and reports `queuedCount`); one that throws
 *   is ignored: the change has happened.
 *
 * Vat module: prelude globals only, no clock (`at` comes from the caller),
 * no data-dependent record keys.
 */
import { m2Interfaces, texts } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { previewText, utf8Bytes } from '../lib/bounded.js';
import { makePendingQueue } from '../lib/pending-queue.js';
import { makeSubmissions } from './submissions.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { QueueItem, Internal, StoredReceipt } from '../lib/pending-queue.js' */
const { Fail, defineExoClass, harden } = /** @type {GuestGlobals} */ (
  globalThis
);

/**
 * Bytes of a pending row besides its preview: the record keys `entry`,
 * `key`, `preview`, `state`, `at` (22), the state `queued` (6), and slack
 * for the entry key, which is added separately.
 */
const ROW_OVERHEAD_BYTES = 40;
/** Bytes of a PendingView besides its rows and hold message: keys and slack. */
const VIEW_OVERHEAD_BYTES = 64;

/**
 * @typedef {any} Submission `{ text }`, or (M1b) a StagedText
 * @typedef {'restart' | 'stopped' | 'refused' | 'interrupted' | 'unavailable'} HoldReason
 * @typedef {{ reason: HoldReason, message: string }} Hold
 * @typedef {object} Receipt
 * @property {string} requestId
 * @property {boolean} duplicate
 * @property {'queued' | 'started'} state
 * @property {any} [entry]
 * @property {any} [turn]
 * @property {string} [turnId]
 * @typedef {object} PendingRow
 * @property {any} entry
 * @property {string} key
 * @property {string} preview
 * @property {'queued'} state
 * @property {number} at
 * @typedef {{ entries: PendingRow[], hold?: Hold }} PendingView
 * @typedef {object} Queue
 * @property {(submission: Submission, requestId: string, at: number) => { receipt: Receipt, added: boolean }} enqueueOnce
 * @property {(requestId: string) => Receipt | undefined} receiptFor
 * @property {() => PendingView} view
 * @property {() => QueueItem | undefined} first
 * @property {(item: QueueItem, turnId: any) => void} claim the receipt
 *   keeps `turnId` and hands out `turnOf(turnId)`
 * @property {(reason: HoldReason, message: string) => void} hold
 * @property {() => void} release
 * @property {() => HoldReason | undefined} holdReason
 * @property {() => number} size
 * @property {() => Hold | undefined} currentHold the hold, if any (W2.7 export)
 * @property {() => QueueItem[]} items the waiting entries' items, oldest
 *   first (W2.7: delete's blob pages and export)
 */
/**
 * `startTurn`'s refusal (R4-10; A.4 direct start): throws the fixed text
 * while a turn is current. The queue's entries and hold do not matter.
 * @param {unknown} current the session's current turn, if any
 */
export const assertNoActiveTurn = current => {
  if (current !== undefined && current !== null) {
    throw Error(texts.activeTurn);
  }
};
harden(assertNoActiveTurn);

/**
 * @param {object} [options]
 * @param {() => void} [options.onChange] runs after every change of the
 *   entries or the hold
 * @param {(turnId: any) => any} [options.turnOf] the Turn of a claimed
 *   turn id, or undefined when the session no longer keeps the turn (an
 *   archived one); the identity by default (tests)
 * @param {() => unknown} [options.claim] the session's claim of the next
 *   entry (`SessionCore.claimNext`), which `sendNow` asks for; does nothing
 *   by default
 * @returns {Queue}
 */
export const makeQueue = ({
  onChange = () => {},
  turnOf = turnId => turnId,
  claim: claimNext = () => undefined,
} = {}) => {
  /**
   * The QueueEntry class, defined once per queue on first use. `makeExo`
   * would define a class per entry, which a vat pays for on every enqueue
   * (J-0251).
   * @type {((internal: Internal) => any) | undefined}
   */
  let makeEntryInstance;
  /** @param {Internal} internal */
  const makeEntry = internal => {
    if (makeEntryInstance === undefined) {
      makeEntryInstance = defineExoClass(
        'QueueEntry',
        m2Interfaces.QueueEntry,
        /** @param {Internal} state */
        state => ({ internal: state }),
        {
          describe() {
            const { internal: self } = this.state;
            if (!self.waiting) throw Error(texts.entryGone);
            const { item } = self;
            return harden({
              key: item.key,
              preview: self.preview,
              state: 'queued',
              at: item.at,
            });
          },
          cancel() {
            return submissions.cancel(this.state.internal);
          },
          /** @param {Submission} submission */
          edit(submission) {
            pending.edit(this.state.internal, submission);
          },
          sendNow() {
            submissions.sendNow(this.state.internal);
            claimNext();
          },
        },
      );
    }
    return makeEntryInstance(internal);
  };

  const pending = makePendingQueue({ makeEntry, onChange });
  const submissions = makeSubmissions({ pending, onChange });

  /**
   * @param {StoredReceipt} stored
   * @param {boolean} duplicate
   * @returns {Receipt}
   */
  const receiptOf = (stored, duplicate) => {
    const { requestId } = stored;
    if (stored.turnId === undefined) {
      return harden({
        requestId,
        duplicate,
        state: 'queued',
        entry: stored.entry,
      });
    }
    /** @type {Receipt} */
    const receipt = { requestId, duplicate, state: 'started' };
    const turn = turnOf(stored.turnId);
    if (turn !== undefined) receipt.turn = turn;
    if (typeof stored.turnId === 'string') receipt.turnId = stored.turnId;
    return harden(receipt);
  };

  /** @type {Queue['enqueueOnce']} */
  const enqueueOnce = (submission, requestId, at) => {
    const { stored, added } = submissions.enqueue(submission, requestId, at);
    return harden({ receipt: receiptOf(stored, !added), added });
  };

  /** @type {Queue['receiptFor']} */
  const receiptFor = requestId => {
    const stored = pending.receipt(requestId);
    return stored === undefined ? undefined : receiptOf(stored, false);
  };

  /**
   * The pending rows, each preview cut so the whole view fits one frame
   * (`designs/m1a-interfaces.md` section 8). The bytes of each full preview
   * are measured once, at enqueue or edit; the cut is needed only when many
   * entries carry long multi-byte previews.
   * @type {Queue['view']}
   */
  const view = () => {
    const hold = submissions.current();
    const holdBytes =
      hold === undefined ? 0 : utf8Bytes(hold.reason) + utf8Bytes(hold.message);
    const count = pending.size();
    let bytes = VIEW_OVERHEAD_BYTES + holdBytes;
    let keyBytes = 0;
    for (const internal of pending.entries()) {
      keyBytes += internal.item.key.length;
      bytes += ROW_OVERHEAD_BYTES + internal.previewBytes;
    }
    bytes += keyBytes;
    /** @type {number | undefined} */
    let units;
    if (bytes > limits.frameBytes) {
      const available =
        limits.frameBytes -
        VIEW_OVERHEAD_BYTES -
        holdBytes -
        keyBytes -
        ROW_OVERHEAD_BYTES * count;
      units = Math.max(0, Math.floor(available / (3 * count)));
    }
    /**
     * @param {Internal} internal
     * @param {string} preview
     */
    const rowOf = (internal, preview) =>
      harden({
        entry: internal.item.entry,
        key: internal.item.key,
        preview,
        state: /** @type {'queued'} */ ('queued'),
        at: internal.item.at,
      });
    // An uncut row is made once per entry and text, and reused by every
    // later view (each enqueue publishes the view: J-0454).
    const entries = [...pending.entries()].map(internal => {
      if (units !== undefined) {
        return rowOf(internal, previewText(internal.preview, units));
      }
      internal.row ??= rowOf(internal, internal.preview);
      return internal.row;
    });
    return hold === undefined ? harden({ entries }) : harden({ entries, hold });
  };

  /** @type {Queue['first']} */
  const first = () => submissions.first()?.item;

  /** @type {Queue['claim']} */
  const claim = (item, turnId) => {
    const internal = pending.first();
    // Only the head is ever claimed (first() answers the head or nothing).
    (internal !== undefined && internal.item === item) ||
      Fail`claim: the entry is not waiting`;
    submissions.take(/** @type {Internal} */ (internal), turnId);
  };

  return harden({
    enqueueOnce,
    receiptFor,
    view,
    first,
    claim,
    hold: submissions.hold,
    release: submissions.release,
    holdReason: () => submissions.current()?.reason,
    size: pending.size,
    currentHold: () => submissions.current(),
    items: () => [...pending.entries()].map(internal => internal.item),
  });
};
harden(makeQueue);
