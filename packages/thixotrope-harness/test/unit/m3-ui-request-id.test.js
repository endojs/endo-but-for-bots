// @ts-check
// The page's submission request id matches the session's rule (M2 A.4,
// `guest/lib/pending-queue.js` `REQUEST_ID`); W3.8 found the contract's
// 32-hex form refused by a real session (J-9604).
import './_m1a-prelude.js';

import { webcrypto } from 'node:crypto';

import test from '@endo/ses-ava/prepare-endo.js';

/* eslint-disable import/no-relative-packages */
import { REQUEST_ID } from '../../guest/lib/pending-queue.js';
/* eslint-enable import/no-relative-packages */
import { newRequestId } from '../../ui/src/controller/drafts.js';

test('newRequestId answers the A.4 form the session accepts', t => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const id = newRequestId(webcrypto);
    t.regex(id, REQUEST_ID);
    t.regex(
      id.slice(14),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    seen.add(id);
  }
  t.is(seen.size, 100);
  t.is(
    newRequestId(webcrypto, 1_700_000_000_000).slice(0, 14),
    '1700000000000-',
  );
});
