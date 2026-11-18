// @ts-check
/**
 * The gateway-local `Composer` (M1a W1a.3, M1b W1b.1; architecture D-10,
 * D-12, section 4.1; designs/m1a-interfaces.md section 3.2,
 * designs/m1b-interfaces.md sections 3.2 and 6.3). Tests reach it through
 * `AgentHostAdmin.composer()`; in M3 the gateway hands it to browsers.
 *
 * `submit(session, text, requestId)`: blank text (`text.trim() === ''`) is
 * refused with `texts.blankSubmission` before anything else, whatever its
 * length (the session refuses it too, J-9150). Text over `limits.inlineBytes`
 * UTF-8 bytes is staged as a blob (written and fsynced before its handle
 * leaves this process) and sent as a `StagedText`; a staging failure rejects
 * with `textOf.stagingFailed` and sends nothing. The guard refuses text over
 * `messageUnits`. It stamps `at` with the adapter's clock (vats have none)
 * and returns the session's receipt from `E(session).enqueueOnce(submission,
 * requestId, at)`. The request id is the client's idempotency key (F.2 e);
 * its window and reuse checks are the session's (R4-55, R4-98).
 *
 * `edit(entry, text)` (M2 W2.4; m2-interfaces.md 5.1, A.4 `editPending`):
 * the same blank refusal and staging, then `E(entry).edit(submission)`. A
 * staged edit is staged for the entry's session when this Composer saw the
 * entry in a receipt (a `WeakMap` from entry to session; after a restart
 * the text is staged without an owner and the session that presents it
 * takes it, M1b 17.3). The staged file is deleted when the entry refuses the
 * edit or its session vat is lost (m2-interfaces.md 11): the vat kept
 * nothing. The text the edit replaced is the session's to drop; a staged
 * one's file stays until the session is deleted or M13's sweep (J-0452).
 *
 * M5 (W5.7; m5-interfaces.md 2.6, H-7): the guard is `m5Interfaces.Composer`
 * and `submit` takes an optional fourth argument `{ attachments }`. With a
 * non-empty list the text is first checked against `packageTextUnits`
 * (before anything is staged), then sent with
 * `E(session).enqueueMessageOnce(submission, requestId, at, attachments)`;
 * otherwise `enqueueOnce` as before. The session's attachment refusals are
 * refusals before storing (a staged file is deleted).
 *
 * Node module (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { texts, textOf } from '../../../guest/lib/interfaces.js';
import {
  m5Interfaces,
  textOf as textOfM5,
} from '../../../guest/lib/interfaces-m5.js';
import { limitsM5 } from '../../../guest/lib/limits-m5.js';
import { limits } from '../../../guest/lib/limits.js';
import { utf8Bytes } from '../../../guest/lib/bounded.js';
import { isRetiredBreak } from '../../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The texts `Session.enqueueOnce` refuses with before it stores anything
 * (guest/session/queue.js `enqueueOnce`: every `refuse` precedes the first
 * write of the submission).
 */
const QUEUE_REFUSALS = new Set([
  texts.blankSubmission,
  texts.invalidRequestId,
  texts.requestIdExpired,
  texts.requestIdReused,
  texts.receiptLimit,
  textOf.queueFull(limits.maxWaiting),
]);
/** Text that starts a refusal the session makes before storing anything. */
const REFUSAL_PREFIXES = [
  'In "enqueueOnce" method of (Session)',
  'Inline text of ',
  // M5: `enqueueMessageOnce`'s guard and its attachment checks
  // (guest/session/packages.js `checkAttachments`).
  'In "enqueueMessageOnce" method of (Session)',
  textOfM5.tooManyAttachments(0).split('(')[0],
  textOfM5.packageTooLong(0).split('(')[0],
  textOfM5.reservedLabel(''),
  textOfM5.duplicateAttachment('').split('"')[0],
];

/** Text that starts a refusal of `QueueEntry.edit` (its guard or size). */
const EDIT_PREFIXES = ['In "edit" method of (QueueEntry)', 'Inline text of '];
const EDIT_REFUSALS = new Set([texts.entryGone, texts.blankSubmission]);

/**
 * Whether the entry kept nothing of a refused edit: one of its refusals, or
 * a retired break (its session vat is lost).
 * @param {unknown} error
 */
export const isEditRefusal = error => {
  if (isRetiredBreak(error)) return true;
  let message;
  try {
    message = /** @type {any} */ (error)?.message;
  } catch {
    return false;
  }
  if (typeof message !== 'string') return false;
  return (
    EDIT_REFUSALS.has(message) ||
    EDIT_PREFIXES.some(prefix => message.startsWith(prefix))
  );
};
harden(isEditRefusal);

/**
 * Whether `error` is the session's refusal of a submission it did not
 * store: a queue refusal text, or its interface guard's rejection (the
 * method never ran).
 * @param {unknown} error
 */
export const isRefusal = error => {
  if (isRetiredBreak(error)) return false;
  let message;
  try {
    message = /** @type {any} */ (error)?.message;
  } catch {
    return false;
  }
  if (typeof message !== 'string') return false;
  return (
    QUEUE_REFUSALS.has(message) ||
    REFUSAL_PREFIXES.some(prefix => message.startsWith(prefix))
  );
};
harden(isRefusal);

/**
 * @param {object} [options]
 * @param {() => number} [options.now] ms since the epoch (tests inject a clock)
 * @param {import('./blobs.js').BlobStore} [options.blobs] stages text over
 *   inlineBytes (without one, such text is refused with stagingFailed)
 */
export const makeComposer = ({ now = () => Date.now(), blobs } = {}) => {
  /**
   * QueueEntry -> the Session whose receipt named it (staging owner for an
   * edit). Weak: an entry nobody holds is forgotten.
   * @type {WeakMap<object, any>}
   */
  const sessionOfEntry = new WeakMap();

  /**
   * Stage `text` for `owner`, or reject with `textOf.stagingFailed`.
   * @param {string} text
   * @param {any} owner
   */
  const stage = async (text, owner) => {
    try {
      if (blobs === undefined) throw Error('no blob store');
      return await blobs.stage(text, {
        previewUnits: limits.messagePreviewUnits,
        owner,
      });
    } catch (error) {
      throw Error(
        textOf.stagingFailed(
          /** @type {Error} */ (error)?.message ?? String(error),
        ),
      );
    }
  };

  /**
   * @param {any} session
   * @param {any} receipt
   */
  const remember = (session, receipt) => {
    const entry = receipt?.entry;
    if (entry !== undefined && entry !== null && typeof entry === 'object') {
      sessionOfEntry.set(entry, session);
    }
    return receipt;
  };

  return makeExo('Composer', m5Interfaces.Composer, {
    /**
     * @param {any} session
     * @param {string} text
     * @param {string} requestId
     * @param {{ attachments?: any[] }} [options] M5
     */
    async submit(session, text, requestId, options = undefined) {
      if (text.trim() === '') throw Error(texts.blankSubmission);
      const attachments = options?.attachments ?? [];
      if (attachments.length > 0 && text.length > limitsM5.packageTextUnits) {
        throw Error(textOfM5.packageTooLong(text.length));
      }
      /** @param {any} submission */
      const enqueue = submission =>
        attachments.length > 0
          ? E(session).enqueueMessageOnce(
              submission,
              requestId,
              now(),
              attachments,
            )
          : E(session).enqueueOnce(submission, requestId, now());
      if (utf8Bytes(text) <= limits.inlineBytes) {
        return remember(session, await enqueue(harden({ text })));
      }
      const staged = await stage(text, session);
      /** @type {any} */
      let receipt;
      try {
        receipt = await enqueue(staged);
      } catch (error) {
        // A refusal the session makes before it stores anything (its queue
        // checks, its guard) leaves this file without a holder: delete it
        // (J-9361). Anything else (a break, an unknown failure) may come
        // after the session kept the handle, so the file stays.
        if (isRefusal(error)) void blobs?.discard(staged.blob);
        throw error;
      }
      // A retry of a submission the session already has (a duplicate
      // receipt) keeps the first one's blob: this one's file has no holder
      // (M1b QC, J-0393).
      if (receipt?.duplicate === true) void blobs?.discard(staged.blob);
      return remember(session, receipt);
    },
    /**
     * @param {any} entry
     * @param {string} text
     */
    async edit(entry, text) {
      if (text.trim() === '') throw Error(texts.blankSubmission);
      if (utf8Bytes(text) <= limits.inlineBytes) {
        await E(entry).edit(harden({ text }));
        return;
      }
      const staged = await stage(text, sessionOfEntry.get(entry));
      try {
        await E(entry).edit(staged);
      } catch (error) {
        if (isEditRefusal(error)) void blobs?.discard(staged.blob);
        throw error;
      }
    },
  });
};
harden(makeComposer);
