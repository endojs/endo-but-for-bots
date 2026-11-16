// @ts-check
// M1a W1a.3: the Composer (resources/agent-host/impl/composer.js;
// designs/m1a-interfaces.md section 3.2). Node adapter test with a fake
// Session; no vat.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { makeComposer } from '../../resources/agent-host/impl/composer.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const makeFakeSession = () => {
  /** @type {any[][]} */
  const calls = [];
  const entry = Far('QueueEntry', {});
  const session = Far('Session', {
    /**
     * @param {any} submission
     * @param {string} requestId
     * @param {number} at
     */
    enqueueOnce(submission, requestId, at) {
      calls.push([submission, requestId, at]);
      return harden({ requestId, duplicate: false, state: 'queued', entry });
    },
  });
  return { session, calls, entry };
};

const requestId = '1763251200000-123e4567-e89b-12d3-a456-426614174000';

test('submit stamps at and returns the session receipt', async t => {
  const { session, calls, entry } = makeFakeSession();
  const composer = makeComposer({ now: () => 1_763_251_200_123 });
  const receipt = await E(composer).submit(session, 'hi', requestId);
  t.deepEqual(receipt, { requestId, duplicate: false, state: 'queued', entry });
  t.deepEqual(calls, [[{ text: 'hi' }, requestId, 1_763_251_200_123]]);
  t.true(Object.isFrozen(calls[0][0]));
});

test('submit measures UTF-8 bytes and refuses over inlineBytes without sending', async t => {
  const { session, calls } = makeFakeSession();
  const composer = makeComposer({ now: () => 5 });
  await E(composer).submit(session, 'a'.repeat(limits.inlineBytes), requestId);
  t.is(calls.length, 1);
  await t.throwsAsync(
    () =>
      E(composer).submit(
        session,
        'a'.repeat(limits.inlineBytes + 1),
        requestId,
      ),
    {
      message: textOf.submissionTooLarge(
        limits.inlineBytes + 1,
        limits.inlineBytes,
      ),
    },
  );
  // 2,731 euro signs are 8,193 bytes in only 2,731 units
  await t.throwsAsync(
    () => E(composer).submit(session, '€'.repeat(2731), requestId),
    {
      message: textOf.submissionTooLarge(8193, limits.inlineBytes),
    },
  );
  // a surrogate pair is 4 bytes: 2,048 of them fit exactly
  await E(composer).submit(session, '😀'.repeat(2048), requestId);
  t.is(calls.length, 2);
});

test('submit is guarded: a non-remotable session or an oversize request id is refused', async t => {
  const { calls } = makeFakeSession();
  const composer = makeComposer();
  await t.throwsAsync(() =>
    E(composer).submit(/** @type {any} */ ('s1'), 'hi', requestId),
  );
  const { session } = makeFakeSession();
  await t.throwsAsync(() =>
    E(composer).submit(session, 'hi', 'x'.repeat(limits.requestIdUnits + 1)),
  );
  t.is(calls.length, 0);
});

test('a refusal from the session reaches the caller', async t => {
  const session = Far('Session', {
    enqueueOnce() {
      throw Error('Invalid submission request ID');
    },
  });
  const composer = makeComposer();
  await t.throwsAsync(() => E(composer).submit(session, 'hi', 'bad'), {
    message: 'Invalid submission request ID',
  });
});
