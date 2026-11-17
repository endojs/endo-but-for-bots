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
 * Node module (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces, texts, textOf } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { utf8Bytes } from '../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} [options]
 * @param {() => number} [options.now] ms since the epoch (tests inject a clock)
 * @param {import('./blobs.js').BlobStore} [options.blobs] stages text over
 *   inlineBytes (without one, such text is refused with stagingFailed)
 */
export const makeComposer = ({ now = () => Date.now(), blobs } = {}) =>
  makeExo('Composer', interfaces.Composer, {
    /**
     * @param {any} session
     * @param {string} text
     * @param {string} requestId
     */
    async submit(session, text, requestId) {
      if (text.trim() === '') throw Error(texts.blankSubmission);
      if (utf8Bytes(text) <= limits.inlineBytes) {
        return E(session).enqueueOnce(harden({ text }), requestId, now());
      }
      /** @type {any} */
      let staged;
      try {
        if (blobs === undefined) throw Error('no blob store');
        staged = await blobs.stage(text, {
          previewUnits: limits.messagePreviewUnits,
        });
      } catch (error) {
        throw Error(
          textOf.stagingFailed(
            /** @type {Error} */ (error)?.message ?? String(error),
          ),
        );
      }
      const receipt = await E(session).enqueueOnce(staged, requestId, now());
      // A retry of a submission the session already has (a duplicate
      // receipt) keeps the first one's blob: this one's file has no holder
      // (M1b QC, J-0393). A refusal may come after the session changed
      // state, so a failed enqueue keeps its file (bounded leak, 4.7).
      if (receipt?.duplicate === true) void blobs?.discard(staged.blob);
      return receipt;
    },
  });
harden(makeComposer);
