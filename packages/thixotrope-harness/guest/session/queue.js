// @ts-check
/**
 * A session's waiting messages (M1a W1a.5; `designs/m1a-interfaces.md`
 * section 8; spec A.4 "Queue", R4-53, R4-55, R4-56).
 *
 * A FIFO of waiting entries (at most `limits.maxWaiting`), one hold, and the
 * submission receipts (at most `limits.maxReceipts`) keyed by request id in a
 * `Map` (rule 12.10: request ids are data, never record keys). Each waiting
 * entry is a `QueueEntry` exo; receipts and pending rows carry it.
 *
 * The heap is the durable record (orthogonal persistence), so unlike Fae's
 * pending-queue.js there is no `dispatching` or `interrupted` entry state:
 * the claim removes the entry in the crank that appends `TurnStarted`
 * (architecture 4.3), and a restart can never find an entry half-claimed.
 *
 * What the queue decides and what it leaves to the session:
 * - `enqueueOnce` validates the request id, answers duplicates, prunes and
 *   bounds receipts, refuses a full queue, appends the entry and, for a new
 *   entry, releases every hold except `interrupted` (A.4: "a new message
 *   releases every hold except interrupted"). It never starts a turn: the
 *   session claims (`SessionCore.claimNext()`) after it.
 * - `first()` is the entry the session may claim, `undefined` while a hold
 *   is set. `claim(item, turn)` removes it and turns its receipt `started`
 *   with `turn`, in the caller's crank. `turn` is what the session wants
 *   kept: its plain record of the turn, which `turnOf` turns into the Turn
 *   object whenever a receipt is handed out (J-9152: a receipt keeps a record,
 *   not an exo).
 * - The receipt table (J-9152, contract section 8): at most `maxReceipts`
 *   receipts; a receipt is dropped once its request id was issued more than
 *   `retryWindowMs` before the `at` of an `enqueueOnce` (oldest first, at
 *   every `enqueueOnce`; the whole table only when it is full). A full table
 *   of live ids refuses with `texts.receiptLimit` (A.4: 4,096 kept). A
 *   receipt holds plain data and the session's record of its turn; no
 *   receipt keeps a QueueEntry that is no longer waiting (a cancelled
 *   entry's receipt names one shared stand-in whose `describe()` throws
 *   `texts.entryGone`).
 * - `onChange()` runs after every change of the entries or the hold (the
 *   session publishes `pending` and reports `queuedCount`). An `onChange`
 *   that throws is ignored: the change has happened and must not be
 *   reported to the caller as refused.
 *
 * Vat module: prelude globals only, no clock (`at` comes from the caller),
 * no data-dependent record keys.
 */
import { interfaces, texts, textOf } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { previewText, utf8Bytes } from '../lib/bounded.js';
import {
  isStaged,
  previewOf,
  sameSubmission,
  submissionField,
} from './staging.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { defineExoClass, harden } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Throws an Error whose message is exactly `message` (a fixed text).
 * @param {string} message
 * @returns {never}
 */
const refuse = message => {
  throw Error(message);
};

/** A.4 request id: 13-digit millisecond timestamp, '-', a UUID. */
const REQUEST_ID = /^\d{13}-[0-9a-f-]{36}$/;

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
 * @typedef {object} QueueItem
 * @property {any} entry the QueueEntry exo
 * @property {string} key `q<n>`, for page re-finding (F.2 d)
 * @property {Submission} submission
 * @property {number} at when it was submitted (the Composer's stamp)
 * @property {string} requestId
 * @typedef {object} Receipt
 * @property {string} requestId
 * @property {boolean} duplicate
 * @property {'queued' | 'started'} state
 * @property {any} [entry]
 * @property {any} [turn]
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
 * @property {(item: QueueItem, turn: any) => void} claim `turn` is kept in
 *   the receipt and handed out as `turnOf(turn)`
 * @property {(reason: HoldReason, message: string) => void} hold
 * @property {() => void} release
 * @property {() => HoldReason | undefined} holdReason
 * @property {() => number} size
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
 * @param {(turn: any) => any} [options.turnOf] the Turn object of what
 *   `claim` was given (the session passes its turn record and mints the
 *   Turn); the identity by default
 * @returns {Queue}
 */
export const makeQueue = ({
  onChange = () => {},
  turnOf = turn => turn,
} = {}) => {
  /**
   * Waiting entries, oldest first (a Set keeps insertion order). At most
   * maxWaiting; claim and cancel remove from it. Not an array: in an
   * Ironhorse vat an element pushed onto this array came out non-writable,
   * so `splice` at the claim threw "not writable" and the claimed entry
   * stayed waiting (W1a.7, J-0271). A Set never rewrites an element.
   * @type {Set<Internal>}
   */
  const waiting = new Set();
  /**
   * Receipts by request id, in insertion order. Pruned by age on each
   * enqueueOnce; at most maxReceipts.
   * @type {Map<string, StoredReceipt>}
   */
  const receipts = new Map();
  /** @type {Hold | undefined} */
  let currentHold;
  let nextKey = 1;

  /**
   * @typedef {object} Internal
   * @property {QueueItem} item
   * @property {string} preview the text cut to messagePreviewUnits
   * @property {number} previewBytes its exact UTF-8 bytes
   * @property {boolean} waiting false once claimed or cancelled
   * @typedef {object} StoredReceipt
   * @property {string} requestId
   * @property {Submission} submission as submitted (inline or staged;
   *   shared with the entry, so it costs no copy)
   * @property {number} issued the request id's timestamp
   * @property {any} entry the QueueEntry while waiting; cleared by the
   *   claim, the shared stand-in once cancelled
   * @property {any} [turn] set by the claim: what `claim` was given
   */

  /** @type {WeakMap<object, Internal>} */
  const byEntry = new WeakMap();

  const changed = () => {
    try {
      onChange();
    } catch {
      // The change has happened; see the module comment.
    }
  };

  /**
   * @param {StoredReceipt} stored
   * @param {boolean} duplicate
   * @returns {Receipt}
   */
  const receiptOf = (stored, duplicate) =>
    stored.turn === undefined
      ? harden({
          requestId: stored.requestId,
          duplicate,
          state: 'queued',
          entry: stored.entry,
        })
      : harden({
          requestId: stored.requestId,
          duplicate,
          state: 'started',
          turn: turnOf(stored.turn),
        });

  /** @param {Internal} internal */
  const removeWaiting = internal => {
    waiting.delete(internal);
    internal.waiting = false;
  };

  /**
   * After the last waiting entry left, a hold has nothing left to hold
   * (Fae session-submissions.js cancel).
   */
  const clearHoldIfEmpty = () => {
    if (waiting.size === 0 && currentHold !== undefined) {
      currentHold = undefined;
    }
  };

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
        interfaces.QueueEntry,
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
            const { internal: self } = this.state;
            if (!self.waiting) return false;
            removeWaiting(self);
            forgetCancelled(self);
            clearHoldIfEmpty();
            changed();
            return true;
          },
        },
      );
    }
    return makeEntryInstance(internal);
  };

  /**
   * The stand-in a cancelled entry's receipt names, made on first use: the
   * cancelled QueueEntry itself is then kept only by whoever holds it.
   * @type {any}
   */
  let goneEntry;
  /**
   * After a cancel: the receipt of this entry names the stand-in.
   * @param {Internal} internal
   */
  const forgetCancelled = internal => {
    const stored = receipts.get(internal.item.requestId);
    if (stored === undefined || stored.entry !== internal.item.entry) return;
    goneEntry ??= makeEntry({
      item: /** @type {any} */ (undefined),
      preview: '',
      previewBytes: 0,
      waiting: false,
    });
    stored.entry = goneEntry;
  };

  /**
   * Drop receipts whose request id was issued outside the retry window.
   * The common case looks only at the oldest receipts (insertion order) and
   * stops at the first live one: a vat pays about 0.27 ms per receipt
   * visited (J-0251), so a full scan on every enqueue would cost about 1 s
   * at maxReceipts. A receipt inserted later may have an older id (client
   * clocks differ), so when the table is full the whole table is scanned
   * before refusing with the receipt-limit text. Expired receipts left
   * behind a live one cost memory only: an expired id is refused before
   * its receipt is looked up.
   * @param {number} at
   */
  const prune = at => {
    const oldest = at - limits.retryWindowMs;
    for (const stored of receipts.values()) {
      if (stored.issued > oldest) break;
      receipts.delete(stored.requestId);
    }
    if (receipts.size < limits.maxReceipts) return;
    for (const stored of receipts.values()) {
      if (stored.issued <= oldest) receipts.delete(stored.requestId);
    }
  };

  /** @type {Queue['enqueueOnce']} */
  const enqueueOnce = (submission, requestId, at) => {
    // A.4 / Fae: a blank message is refused before anything else (J-9150);
    // a staged one never is (the Composer refused it).
    isStaged(submission) ||
      submission.text.trim() !== '' ||
      refuse(texts.blankSubmission);
    // The frame rule rests on the session, not on its caller (J-9369).
    if (!isStaged(submission)) {
      const bytes = utf8Bytes(submission.text);
      bytes <= limits.inlineBytes ||
        refuse(textOf.inlineTooLarge(bytes, limits.inlineBytes));
    }
    REQUEST_ID.test(requestId) || refuse(texts.invalidRequestId);
    const issued = Number(requestId.slice(0, 13));
    (issued > at - limits.retryWindowMs && issued <= at + limits.clockSkewMs) ||
      refuse(texts.requestIdExpired);
    const known = receipts.get(requestId);
    if (known !== undefined) {
      sameSubmission(known.submission, submission) ||
        refuse(texts.requestIdReused);
      return harden({ receipt: receiptOf(known, true), added: false });
    }
    prune(at);
    receipts.size < limits.maxReceipts || refuse(texts.receiptLimit);
    waiting.size < limits.maxWaiting ||
      refuse(textOf.queueFull(limits.maxWaiting));

    const key = `q${nextKey}`;
    nextKey += 1;
    const preview = previewOf(
      submissionField(submission),
      limits.messagePreviewUnits,
    );
    /** @type {Internal} */
    const internal = {
      item: /** @type {any} */ (undefined),
      preview,
      previewBytes: utf8Bytes(preview),
      waiting: true,
    };
    const entry = makeEntry(internal);
    internal.item = harden({
      entry,
      key,
      submission,
      at,
      requestId,
    });
    byEntry.set(entry, internal);
    waiting.add(internal);
    /** @type {StoredReceipt} */
    const stored = { requestId, submission, issued, entry };
    receipts.set(requestId, stored);
    // A new message releases every hold except interrupted (A.4, R4-56).
    if (currentHold !== undefined && currentHold.reason !== 'interrupted') {
      currentHold = undefined;
    }
    changed();
    return harden({ receipt: receiptOf(stored, false), added: true });
  };

  /** @type {Queue['receiptFor']} */
  const receiptFor = requestId => {
    const stored = receipts.get(requestId);
    return stored === undefined ? undefined : receiptOf(stored, false);
  };

  /**
   * The pending rows, each preview cut so the whole view fits one frame
   * (`designs/m1a-interfaces.md` section 8). The bytes of each full preview
   * are measured once, at enqueue; the cut is needed only when many entries
   * carry long multi-byte previews.
   * @type {Queue['view']}
   */
  const view = () => {
    const holdBytes =
      currentHold === undefined
        ? 0
        : utf8Bytes(currentHold.reason) + utf8Bytes(currentHold.message);
    let bytes = VIEW_OVERHEAD_BYTES + holdBytes;
    for (const internal of waiting) {
      bytes +=
        ROW_OVERHEAD_BYTES + internal.item.key.length + internal.previewBytes;
    }
    /** @type {number | undefined} */
    let units;
    if (bytes > limits.frameBytes) {
      let keyBytes = 0;
      for (const internal of waiting) keyBytes += internal.item.key.length;
      const available =
        limits.frameBytes -
        VIEW_OVERHEAD_BYTES -
        holdBytes -
        keyBytes -
        ROW_OVERHEAD_BYTES * waiting.size;
      units = Math.max(0, Math.floor(available / (3 * waiting.size)));
    }
    const entries = [...waiting].map(internal =>
      harden({
        entry: internal.item.entry,
        key: internal.item.key,
        preview:
          units === undefined
            ? internal.preview
            : previewText(internal.preview, units),
        state: /** @type {'queued'} */ ('queued'),
        at: internal.item.at,
      }),
    );
    return currentHold === undefined
      ? harden({ entries })
      : harden({ entries, hold: currentHold });
  };

  /** @type {Queue['first']} */
  const first = () =>
    currentHold === undefined && waiting.size > 0
      ? waiting.values().next().value?.item
      : undefined;

  /** @type {Queue['claim']} */
  const claim = (item, turn) => {
    const internal = byEntry.get(item.entry);
    (internal !== undefined && internal.item === item && internal.waiting) ||
      refuse('claim: the entry is not waiting');
    removeWaiting(/** @type {Internal} */ (internal));
    const stored = receipts.get(item.requestId);
    if (stored !== undefined && stored.entry === item.entry) {
      stored.turn = turn;
      // A started receipt names its Turn only; dropping the entry lets the
      // claimed QueueEntry exo and its records be collected. Every object a
      // vat keeps costs each later delivery (a full GC per crank, C-7;
      // J-0251).
      stored.entry = undefined;
    }
    clearHoldIfEmpty();
    changed();
  };

  /** @type {Queue['hold']} */
  const hold = (reason, message) => {
    // An interrupted hold needs a decision about its message; no other
    // reason replaces it (Fae holdForStop).
    if (currentHold?.reason === 'interrupted' && reason !== 'interrupted') {
      return;
    }
    if (currentHold?.reason === reason && currentHold.message === message) {
      return;
    }
    currentHold = harden({ reason, message });
    changed();
  };

  /** @type {Queue['release']} */
  const release = () => {
    if (currentHold === undefined || currentHold.reason === 'interrupted') {
      return;
    }
    currentHold = undefined;
    changed();
  };

  return harden({
    enqueueOnce,
    receiptFor,
    view,
    first,
    claim,
    hold,
    release,
    holdReason: () => currentHold?.reason,
    size: () => waiting.size,
  });
};
harden(makeQueue);
