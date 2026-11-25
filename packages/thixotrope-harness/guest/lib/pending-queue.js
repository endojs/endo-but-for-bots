// @ts-check
/**
 * A session's waiting messages and its submission receipts (M2 W2.4;
 * `designs/m2-interfaces.md` 5; spec A.4 "Queue", R4-53, R4-55, R4-98).
 * Adapted from Fae `session/pending-queue.js` at `1315bef86`: the FIFO, the
 * edit and cancel of a waiting message, the bound of 100 waiting, the
 * request-id format and window and the receipt table are kept; the pet-name
 * record (`E(host).storeValue`, `lookup`, `remove`), the load and persist
 * chain, the `dispatching` and `interrupted` entry states, the injected
 * clock and the SHA-256 of the text are dropped:
 *
 * - The heap is the record (orthogonal persistence): entries live in a Set
 *   and receipts in a Map keyed by the request id (a client idempotency key,
 *   F.2 e; data in a Map, never a record key, rule 12.10).
 * - The claim removes the entry in the crank that appends `TurnStarted`
 *   (architecture 4.3), so no entry is ever found half-claimed: there is no
 *   `dispatching` state to find after a restart and no `interrupted` entry.
 * - Time is the Composer's stamp `at`, passed in (vats have no clock).
 * - A receipt keeps a fingerprint of what was submitted, not the text's
 *   SHA-256: an inline text itself (shared with the entry and the
 *   `TurnStarted` record, so it costs no copy while either is kept), or a
 *   staged text's `{ bytes, digest }` (the adapter's SHA-256, J-9363;
 *   `{ bytes, preview }` for a text staged before digests) without its Blob
 *   handle (5.3: no receipt keeps a sealed turn's input alive).
 *
 * Entries are internal records `{ item, preview, previewBytes, waiting }`;
 * `item` is the hardened `{ entry, key, submission, at, requestId,
 * attachments? }` the session claims (turn.js), replaced whole by an edit.
 *
 * M5 (W5.7; m5-interfaces.md 2.6): an entry may carry `attachments`
 * (`[{ label, value }]`, checked by `packages.js`). The receipt's
 * fingerprint covers the labels too (`StoredReceipt.labels`, not the
 * objects): a retry under the same request id must carry the same labels
 * in the same order. M11 (m11-interfaces.md 9.1): an entry sent from
 * spoken mode carries `spoken: true` (its reply is read aloud) and, when
 * its text came from dictation, `dictated: true`; both are absent on a
 * typed entry. The marker is not part of the fingerprint (a retry under the
 * same request id answers the original, marker and all), and an edit keeps
 * it with the rest of the item.
 * An edit keeps the attachments; a cancel and the claim
 * drop them from the entry (after the claim the turn's package holds them,
 * until the turn settles). Worst case of the labels kept by receipts:
 * 4,096 x 32 labels of 80 units, about 31 MB, with the strings shared with
 * the entry and `TurnStarted` while those are kept. `makeEntry(internal)`
 * (from queue.js) makes the QueueEntry exo of each. Hold decisions are
 * submissions.js's; this module decides nothing about when to start a turn.
 *
 * Worst-case heap (5.3; `test/unit/m2-queue-heap.test.js`, JOURNAL J-0453):
 * - entries: at most `maxWaiting` (100), each an exo, two records, the
 *   submission (an inline text of at most `inlineBytes`, 8,192 bytes, or a
 *   StagedText) and a preview of at most `messagePreviewUnits` (1,024
 *   units, <= 3,072 bytes): <= 1.1 MB of strings and about 600 objects;
 * - receipts: at most `maxReceipts` (4,096), each one record, its request
 *   id (<= 64 units), a number, a fingerprint, and a waiting entry or a
 *   turn id. A staged receipt is about 1 KB (Node: 4.07 MB for 4,096,
 *   the test's weak references included). The worst case is a receipt of
 *   a maximum-size inline text whose turn the session no longer keeps, for
 *   every id of the 24 h window: 4,096 x 8,192 bytes = 32 MiB of strings
 *   (Node: 35.2 MB with 100 waiting maximum-size entries, 1.02 x the
 *   strings). It needs 4,096 maximum-size inline submissions in 24 h.
 * The table never holds a Blob, a Turn, or a QueueEntry that is not
 * waiting (the test collects and counts them).
 *
 * Vat module: prelude globals only, no clock, no data-dependent record keys.
 */
import { texts, textOf } from './guards/session.js';
import { limits } from './limits.js';
import { previewText, utf8Bytes } from './bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { harden } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Throws an Error whose message is exactly `message` (a fixed text).
 * @param {string} message
 * @returns {never}
 */
const refuse = message => {
  throw Error(message);
};

/** A.4 request id: 13-digit millisecond timestamp, '-', a UUID. */
export const REQUEST_ID = /^\d{13}-[0-9a-f-]{36}$/;

/**
 * M11 (m11-interfaces.md 9.1): the two facts of a message sent from spoken
 * mode, as an entry, an export entry and a `TurnStarted` record carry them:
 * `spoken: true` (its reply is read aloud) and `dictated: true` (its text
 * came from dictation and may hold transcription errors). Only `true` is
 * ever stored; a typed message carries neither.
 * @typedef {{ spoken?: true, dictated?: true }} VoiceMarker
 */

/**
 * The stored form of a marker (`EnqueueOptions`, `ExportEntry`, a record or
 * a queue item): only its true facts, so a typed message adds no field.
 * @param {{ spoken?: unknown, dictated?: unknown } | undefined} options
 * @returns {VoiceMarker}
 */
export const markerOf = options =>
  harden({
    ...(options?.spoken === true ? { spoken: true } : {}),
    ...(options?.dictated === true ? { dictated: true } : {}),
  });
harden(markerOf);

/**
 * @typedef {any} Submission `{ text }`, or a StagedText
 * @typedef {string | { bytes: number, digest?: string, preview?: string }} Fingerprint
 * @typedef {object} QueueItem
 * @property {any} entry the QueueEntry exo
 * @property {string} key `q<n>`, for page re-finding (F.2 d)
 * @property {Submission} submission
 * @property {number} at when it was submitted (the Composer's stamp)
 * @property {string} requestId
 * @property {readonly { label: string, value: any }[]} [attachments] M5
 * @property {true} [spoken] M11: sent from spoken mode (read aloud)
 * @property {true} [dictated] M11: its text came from dictation
 * @typedef {object} Internal
 * @property {QueueItem} item
 * @property {string} preview the text cut to messagePreviewUnits
 * @property {number} previewBytes its exact UTF-8 bytes
 * @property {boolean} waiting false once claimed or cancelled
 * @property {any} [row] its pending row, made by the first view after its
 *   last change (queue.js)
 * @typedef {object} StoredReceipt
 * @property {string} requestId
 * @property {Fingerprint} fingerprint
 * @property {number} issued the request id's timestamp
 * @property {any} entry the QueueEntry while waiting; the shared stand-in
 *   once cancelled; undefined once claimed
 * @property {any} [turnId] set by the claim
 * @property {readonly string[]} [labels] M5: the attachments' labels
 */

/**
 * @param {any} value
 * @returns {boolean}
 */
const isStaged = value =>
  typeof value === 'object' &&
  value !== null &&
  'blob' in value &&
  'bytes' in value;

/**
 * What a receipt keeps of a submission (module comment).
 * @param {Submission} submission
 * @returns {Fingerprint}
 */
export const fingerprintOf = submission => {
  if (!isStaged(submission)) return submission.text;
  return typeof submission.digest === 'string'
    ? harden({ bytes: submission.bytes, digest: submission.digest })
    : harden({ bytes: submission.bytes, preview: submission.preview });
};
harden(fingerprintOf);

/**
 * Same submission (contract 3.3, M1b 17.2, `staging.js` `sameSubmission`):
 * equal inline strings; staged, equal digests and bytes; a staged text
 * without a digest compares by bytes and preview; with a digest on one side
 * only, they differ.
 * @param {Fingerprint} fingerprint
 * @param {Submission} submission
 */
export const sameFingerprint = (fingerprint, submission) => {
  if (typeof fingerprint === 'string') {
    return !isStaged(submission) && submission.text === fingerprint;
  }
  if (!isStaged(submission) || submission.bytes !== fingerprint.bytes) {
    return false;
  }
  if (
    typeof fingerprint.digest === 'string' ||
    typeof submission.digest === 'string'
  ) {
    return fingerprint.digest === submission.digest;
  }
  return fingerprint.preview === submission.preview;
};
harden(sameFingerprint);

/**
 * The checks a submission's text passes before anything else (A.4, J-9150,
 * J-9369): an inline text is not blank and fits `inlineBytes`; a staged one
 * was checked by the Composer.
 * @param {Submission} submission
 */
export const checkSubmission = submission => {
  if (isStaged(submission)) return;
  submission.text.trim() !== '' || refuse(texts.blankSubmission);
  const bytes = utf8Bytes(submission.text);
  bytes <= limits.inlineBytes ||
    refuse(textOf.inlineTooLarge(bytes, limits.inlineBytes));
};
harden(checkSubmission);

/**
 * @param {Submission} submission
 * @returns {{ preview: string, previewBytes: number }}
 */
const previewOf = submission => {
  const preview = previewText(
    isStaged(submission) ? submission.preview : submission.text,
    limits.messagePreviewUnits,
  );
  return { preview, previewBytes: utf8Bytes(preview) };
};

/**
 * @param {object} options
 * @param {(internal: Internal) => any} options.makeEntry the QueueEntry exo
 *   of an entry (called once per entry, and once for the stand-in of
 *   cancelled entries, with `waiting` false)
 * @param {() => void} [options.onChange] runs after every change of the
 *   entries
 */
export const makePendingQueue = ({ makeEntry, onChange = () => {} }) => {
  /**
   * Waiting entries, oldest first (a Set keeps insertion order). Not an
   * array: in an Ironhorse vat an element pushed onto an array came out
   * non-writable, so `splice` at the claim threw (W1a.7, J-0271).
   * @type {Set<Internal>}
   */
  const waiting = new Set();
  /** @type {Map<string, StoredReceipt>} */
  const receipts = new Map();
  /**
   * The latest issue time of a receipt evicted to bound the table (R4-98
   * "4096 receipts kept"; PM ruling 6, J-9492): an id issued at or before
   * it is refused as expired, so a retry whose receipt is gone is never
   * taken as new.
   */
  let evictedIssued = 0;
  let nextKey = 1;
  /** @type {any} */
  let goneEntry;

  const changed = () => {
    try {
      onChange();
    } catch {
      // The change has happened and must not be reported as refused.
    }
  };

  /**
   * Drop receipts whose request id was issued outside the retry window.
   * Insertion order is close to issue order, so the common case looks only
   * at the oldest receipts and stops at the first live one (a vat pays a
   * fraction of a millisecond per receipt visited, J-0251); a receipt
   * inserted later may carry an older id (client clocks differ), so a full
   * table is scanned whole before refusing. An expired id is refused before
   * its receipt is looked up, so expired receipts left behind a live one
   * cost memory only, within the bound.
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

  /**
   * The entry leaves the queue and lets go of its attachments (M5).
   * @param {Internal} internal
   */
  const leave = internal => {
    waiting.delete(internal);
    internal.waiting = false;
    if (internal.item.attachments !== undefined) {
      const { attachments: _dropped, ...rest } = internal.item;
      internal.item = harden(rest);
    }
  };

  /**
   * M5: equal attachment labels, in order (none and `[]` are equal).
   * @param {readonly string[] | undefined} kept
   * @param {readonly { label: string }[] | undefined} attachments
   */
  const sameLabels = (kept = [], attachments = []) =>
    kept.length === attachments.length &&
    kept.every((label, i) => attachments[i].label === label);

  /**
   * The request id is checked, a duplicate answered, then the bound on the
   * waiting entries (100). Every refusal precedes the first write (the
   * Composer deletes a staged file the session refused, `composer.js`
   * `isRefusal`). The receipt table keeps at most 4,096: past it the
   * oldest inserted receipts are evicted, never a submission refused.
   * @param {Submission} submission
   * @param {string} requestId
   * @param {number} at
   * @param {readonly { label: string, value: any }[]} [attachments] M5
   * @param {VoiceMarker} [marker] M11 (`markerOf`)
   * @returns {{ stored: StoredReceipt, added: boolean, internal?: Internal }}
   */
  const enqueue = (
    submission,
    requestId,
    at,
    attachments = undefined,
    marker = undefined,
  ) => {
    checkSubmission(submission);
    REQUEST_ID.test(requestId) || refuse(texts.invalidRequestId);
    const issued = Number(requestId.slice(0, 13));
    (issued > at - limits.retryWindowMs && issued <= at + limits.clockSkewMs) ||
      refuse(texts.requestIdExpired);
    const known = receipts.get(requestId);
    if (known !== undefined) {
      (sameFingerprint(known.fingerprint, submission) &&
        sameLabels(known.labels, attachments)) ||
        refuse(texts.requestIdReused);
      return { stored: known, added: false };
    }
    prune(at);
    issued > evictedIssued || refuse(texts.requestIdExpired);
    waiting.size < limits.maxWaiting ||
      refuse(textOf.queueFull(limits.maxWaiting));
    while (receipts.size >= limits.maxReceipts) {
      const oldest = /** @type {StoredReceipt} */ (
        receipts.values().next().value
      );
      receipts.delete(oldest.requestId);
      if (oldest.issued > evictedIssued) evictedIssued = oldest.issued;
    }

    const key = `q${nextKey}`;
    nextKey += 1;
    /** @type {Internal} */
    const internal = {
      item: /** @type {any} */ (undefined),
      ...previewOf(submission),
      waiting: true,
      row: undefined,
    };
    const entry = makeEntry(internal);
    const attached = attachments !== undefined && attachments.length > 0;
    internal.item = harden({
      entry,
      key,
      submission,
      at,
      requestId,
      ...(attached ? { attachments } : {}),
      ...markerOf(marker),
    });
    waiting.add(internal);
    /** @type {StoredReceipt} */
    const stored = {
      requestId,
      fingerprint: fingerprintOf(submission),
      issued,
      entry,
    };
    if (attached) stored.labels = harden(attachments.map(a => a.label));
    receipts.set(requestId, stored);
    changed();
    return { stored, added: true, internal };
  };

  /**
   * A.4 `editPending`: the text of a waiting entry is replaced; its key,
   * place, time and request id are kept. The receipt keeps the fingerprint
   * of what was submitted under the request id (Fae: a retry of the
   * original submission is still a duplicate).
   * @param {Internal} internal
   * @param {Submission} submission
   */
  const edit = (internal, submission) => {
    internal.waiting || refuse(texts.entryGone);
    checkSubmission(submission);
    const { preview, previewBytes } = previewOf(submission);
    internal.item = harden({ ...internal.item, submission });
    internal.preview = preview;
    internal.previewBytes = previewBytes;
    internal.row = undefined;
    changed();
  };

  /**
   * A.4 `cancelPending`: false when the entry no longer waits. Its receipt
   * then names one shared stand-in, so the cancelled exo is kept only by
   * whoever holds it.
   * @param {Internal} internal
   * @returns {boolean}
   */
  const cancel = internal => {
    if (!internal.waiting) return false;
    leave(internal);
    const stored = receipts.get(internal.item.requestId);
    if (stored !== undefined && stored.entry === internal.item.entry) {
      goneEntry ??= makeEntry({
        item: /** @type {any} */ (undefined),
        preview: '',
        previewBytes: 0,
        waiting: false,
        row: undefined,
      });
      stored.entry = goneEntry;
    }
    changed();
    return true;
  };

  /**
   * Send-now moves an entry to the head (the others keep their order).
   * The Set is refilled rather than reordered in place (J-0271).
   * @param {Internal} internal
   */
  const toHead = internal => {
    internal.waiting || refuse(texts.entryGone);
    if (waiting.values().next().value === internal) return;
    const rest = [...waiting];
    waiting.clear();
    waiting.add(internal);
    for (const other of rest) {
      if (other !== internal) waiting.add(other);
    }
    changed();
  };

  /**
   * The claim (crank A): the entry leaves, its receipt becomes `started`
   * with the turn id and lets go of the entry.
   * @param {Internal} internal
   * @param {any} turnId
   */
  const take = (internal, turnId) => {
    internal.waiting || refuse('claim: the entry is not waiting');
    leave(internal);
    const stored = receipts.get(internal.item.requestId);
    if (stored !== undefined && stored.entry === internal.item.entry) {
      stored.turnId = turnId;
      stored.entry = undefined;
    }
    changed();
  };

  return harden({
    enqueue,
    edit,
    cancel,
    toHead,
    take,
    /** @param {string} requestId */
    receipt: requestId => receipts.get(requestId),
    /** @returns {Internal | undefined} */
    first: () => waiting.values().next().value,
    size: () => waiting.size,
    receiptCount: () => receipts.size,
    /** @returns {Iterable<Internal>} */
    entries: () => waiting.values(),
  });
};
harden(makePendingQueue);
