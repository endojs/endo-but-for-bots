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
 * edit (it kept nothing). The text the edit replaced is the session's to
 * drop; a staged one's file stays until the session is deleted or M13's
 * sweep (J-0452).
 *
 * M5 (W5.7; m5-interfaces.md 2.6, H-7): the guard is `interfaces.Composer`
 * and `submit` takes an optional fourth argument `{ attachments }`. With a
 * non-empty list the text is first checked against `packageTextUnits`, then
 * the attachments as the session checks them (`checkAttachments`), all
 * before anything is staged; then sent with
 * `E(session).enqueueMessageOnce(submission, requestId, at, attachments)`;
 * otherwise `enqueueOnce` as before.
 *
 * M11 (m11-interfaces.md 9.1): `spoken: true` and `dictated: true` in the
 * same options mark a message sent from spoken mode (its reply is read
 * aloud) and one whose text came from dictation; their true facts are
 * passed on as the enqueue methods' last argument, and only then (a typed
 * send's calls are unchanged). A session created under an earlier program
 * keeps that program's guard (a deploy replaces the program for later
 * creations only, `guest/factory/root.js`), which refuses the extra
 * argument; so before the first marked send to a session the Composer reads
 * its interface guard (`__getInterfaceGuard__`, the method every exo
 * answers; never a call made to fail) and sends the marker only when the
 * method's guard has an optional argument. Otherwise the message goes
 * unmarked and the receipt says so (`unmarked: true`) for the page to show.
 * `edit` takes no marker: the entry keeps its own.
 *
 * A staged file's fate after a failed call (HR-SYN-10). Whatever the
 * Composer can check is checked before staging: blank text, the package
 * length, the attachments; its own guard has the session's argument shapes
 * (request id, `at`, attachments), and a staged submission is never inline,
 * so the session's guard and inline-size refusals cannot meet a staged
 * call. What is left is the session's state: the refusals of
 * `SUBMIT_REFUSALS` and `EDIT_REFUSALS`, each the session's own text from
 * its text table, compared whole (no prefixes, no guard-message format).
 * Their file is deleted. Every other failure keeps the file, and so does a
 * retired break, for submit and edit alike: a break never means "not done"
 * (M0 S9; m2-interfaces 4.4 A3), so the session may have stored the handle
 * before the break, and deleting a file a record holds loses the user's
 * text, while keeping one nobody holds costs disk until the session is
 * deleted or M13's sweep (M1b leak 4.7).
 *
 * Node module (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { texts, textOf, interfaces } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { utf8Bytes } from '../../../guest/lib/bounded.js';
import { isRetiredBreak } from '../../../guest/lib/retired.js';
import { checkAttachments } from '../../../guest/session/packages.js';
import { markerOf } from '../../../guest/lib/pending-queue.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The texts `Session.enqueueOnce` (and `enqueueMessageOnce`, after its
 * attachment checks) refuses a staged submission with before it stores
 * anything, from its state (guest/lib/pending-queue.js `enqueue`: every
 * `refuse` precedes the first write). Blank text never reaches it (checked
 * here first).
 */
const SUBMIT_REFUSALS = new Set([
  texts.invalidRequestId,
  texts.requestIdExpired,
  texts.requestIdReused,
  texts.receiptLimit,
  textOf.queueFull(limits.maxWaiting),
  // A session emergency-stopped or stopping (`hooks.admit`, refused before
  // any write; m6-interfaces.md 4.5, seam C-1).
  texts.sessionStopped,
]);
/** What `QueueEntry.edit` refuses a staged edit with: the entry is gone. */
const EDIT_REFUSALS = new Set([texts.entryGone]);

/**
 * The one rule for a staged file after a failed call (HR-SYN-10, module
 * comment): deleted only for a refusal in `refusals` (the session kept
 * nothing); kept for a retired break and for anything else.
 * @param {unknown} error
 * @param {ReadonlySet<string>} refusals
 */
export const keptNothing = (error, refusals) => {
  if (isRetiredBreak(error)) return false;
  let message;
  try {
    message = /** @type {any} */ (error)?.message;
  } catch {
    return false;
  }
  return typeof message === 'string' && refusals.has(message);
};
harden(keptNothing);

/**
 * Whether the session refused a staged submission before storing it.
 * @param {unknown} error
 */
export const isRefusal = error => keptNothing(error, SUBMIT_REFUSALS);
harden(isRefusal);

/**
 * Whether the entry refused a staged edit before storing it.
 * @param {unknown} error
 */
export const isEditRefusal = error => keptNothing(error, EDIT_REFUSALS);
harden(isEditRefusal);

/**
 * Whether the method guard `name` of `guard` (an exo's interface guard, as
 * `__getInterfaceGuard__` answers it) takes an optional argument: the
 * spoken marker's slot (M11), absent from every earlier program's
 * `enqueueOnce` and `enqueueMessageOnce`.
 * @param {any} guard
 * @param {string} name
 */
export const takesMarker = (guard, name) => {
  try {
    const optional =
      guard?.payload?.methodGuards?.[name]?.payload?.optionalArgGuards;
    return Array.isArray(optional) && optional.length > 0;
  } catch {
    return false;
  }
};
harden(takesMarker);

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
   * Session -> its interface guard (M11), read once: a session's program,
   * and so its guard, is fixed for its life. A failed read is not kept.
   * @type {WeakMap<object, Promise<any>>}
   */
  const guardOf = new WeakMap();
  /**
   * Whether `session`'s method `name` accepts the spoken marker.
   * @param {any} session
   * @param {string} name
   */
  const acceptsMarker = async (session, name) => {
    let guard = guardOf.get(session);
    if (guard === undefined) {
      // The introspection method every exo answers (`@endo/exo`); it is
      // not on the typed `E` surface.
      // eslint-disable-next-line no-underscore-dangle
      guard = /** @type {Promise<any>} */ (E(session).__getInterfaceGuard__());
      guardOf.set(session, guard);
    }
    try {
      return takesMarker(await guard, name);
    } catch {
      guardOf.delete(session);
      return false;
    }
  };

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

  return makeExo('Composer', interfaces.Composer, {
    /**
     * @param {any} session
     * @param {string} text
     * @param {string} requestId
     * @param {{ attachments?: any[], spoken?: boolean, dictated?: boolean }} [options] M5, M11
     */
    async submit(session, text, requestId, options = undefined) {
      if (text.trim() === '') throw Error(texts.blankSubmission);
      const attachments = options?.attachments ?? [];
      const facts = markerOf(options);
      const method =
        attachments.length > 0 ? 'enqueueMessageOnce' : 'enqueueOnce';
      const marked = Object.keys(facts).length > 0;
      const unmarked = marked && !(await acceptsMarker(session, method));
      const marker = marked && !unmarked ? [facts] : [];
      if (attachments.length > 0) {
        if (text.length > limits.packageTextUnits) {
          throw Error(textOf.packageTooLong(text.length));
        }
        // The session's own checks, with its texts, before anything is
        // staged (HR-SYN-10).
        checkAttachments(harden({ text }), attachments);
      }
      /** @param {any} submission */
      const enqueue = submission =>
        attachments.length > 0
          ? E(session).enqueueMessageOnce(
              submission,
              requestId,
              now(),
              attachments,
              ...marker,
            )
          : E(session).enqueueOnce(submission, requestId, now(), ...marker);
      /** @param {any} receipt */
      const answer = receipt =>
        remember(
          session,
          unmarked ? harden({ ...receipt, unmarked: true }) : receipt,
        );
      if (utf8Bytes(text) <= limits.inlineBytes) {
        return answer(await enqueue(harden({ text })));
      }
      const staged = await stage(text, session);
      /** @type {any} */
      let receipt;
      try {
        receipt = await enqueue(staged);
      } catch (error) {
        // A refusal the session makes from its state before it stores
        // anything leaves this file without a holder: delete it (J-9361).
        // Anything else (a break, an unknown failure) may come after the
        // session kept the handle, so the file stays (module comment).
        if (isRefusal(error)) void blobs?.discard(staged.blob);
        throw error;
      }
      // A retry of a submission the session already has (a duplicate
      // receipt) keeps the first one's blob: this one's file has no holder
      // (M1b QC, J-0393).
      if (receipt?.duplicate === true) void blobs?.discard(staged.blob);
      return answer(receipt);
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
