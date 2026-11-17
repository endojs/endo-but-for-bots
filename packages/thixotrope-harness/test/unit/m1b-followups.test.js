// @ts-check
// M1b follow-ups in guest code (JOURNAL J-9360..J-9379;
// designs/m1b-interfaces.md 17): exact duplicates by digest, the list
// publisher after an adapter-only restart, the manager's attach notice.
// In-memory fakes under the Node prelude.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { sameSubmission } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);


/**
 * @param {string} preview
 * @param {number} bytes
 * @param {string} [digest]
 */
const staged = (preview, bytes, digest) =>
  harden(
    digest === undefined
      ? { blob: Far('Blob', {}), preview, bytes }
      : { blob: Far('Blob', {}), preview, bytes, digest },
  );

test('J-9363: staged duplicates compare by digest: same length and preview but another text is not the same', t => {
  const d1 = 'a'.repeat(64);
  const d2 = 'b'.repeat(64);
  t.true(sameSubmission(staged('p', 9000, d1), staged('p', 9000, d1)));
  t.false(
    sameSubmission(staged('p', 9000, d1), staged('p', 9000, d2)),
    'same bytes and preview, different text',
  );
  t.true(
    sameSubmission(staged('p', 9000, d1), staged('q', 9000, d1)),
    'the digest decides, not the preview',
  );
  t.false(sameSubmission(staged('p', 9000, d1), staged('p', 9001, d1)));
  t.false(
    sameSubmission(staged('p', 9000, d1), staged('p', 9000)),
    'a digest on one side only',
  );
  // Staged before digests: bytes and preview, as before.
  t.true(sameSubmission(staged('p', 9000), staged('p', 9000)));
});
