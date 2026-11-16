// @ts-check
/**
 * The gateway-local `Composer` (M1a W1a.3; architecture D-12, section 4.1;
 * designs/m1a-interfaces.md section 3.2). Tests reach it through
 * `AgentHostAdmin.composer()`; in M3 the gateway hands it to browsers.
 *
 * `submit(session, text, requestId)` measures `text` in UTF-8 bytes; over
 * `limits.inlineBytes` it refuses with `textOf.submissionTooLarge` and sends
 * nothing (M1a has no staging; M1b stages the text as a Blob instead).
 * Otherwise it stamps `at` with the adapter's clock (vats have none) and
 * returns the session's receipt from `E(session).enqueueOnce({ text },
 * requestId, at)`. The request id is the client's idempotency key (F.2 e);
 * its window and reuse checks are the session's (R4-55, R4-98).
 *
 * Node module (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces, textOf } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { utf8Bytes } from '../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} [options]
 * @param {() => number} [options.now] ms since the epoch (tests inject a clock)
 */
export const makeComposer = ({ now = () => Date.now() } = {}) =>
  makeExo('Composer', interfaces.Composer, {
    /**
     * @param {any} session
     * @param {string} text
     * @param {string} requestId
     */
    async submit(session, text, requestId) {
      const bytes = utf8Bytes(text);
      if (bytes > limits.inlineBytes) {
        throw Error(textOf.submissionTooLarge(bytes, limits.inlineBytes));
      }
      return E(session).enqueueOnce(harden({ text }), requestId, now());
    },
  });
harden(makeComposer);
