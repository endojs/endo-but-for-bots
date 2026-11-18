// @ts-check
// W5.7 `Composer.submit(session, text, requestId, { attachments })`
// (resources/agent-host/impl/composer.js; m5-interfaces.md 2.6, H-7): with
// attachments it calls `enqueueMessageOnce`, without them `enqueueOnce`;
// a text over `packageTextUnits` is refused before staging; a staged text
// the session refuses for its attachments leaves no file. Fake sessions
// and a blob store under H/tmp; no vat.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { texts } from '../../guest/lib/interfaces.js';
import { textOf as textOfM5 } from '../../guest/lib/interfaces-m5.js';
import { limitsM5 } from '../../guest/lib/limits-m5.js';
/* eslint-enable import/no-relative-packages */
import {
  isRefusal,
  makeComposer,
} from '../../resources/agent-host/impl/composer.js';
import { harnessRoot } from '../_helpers.js';
import { blobsUntil, filesIn, makeTestBlobs } from '../adapter/_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const AT = 1_700_000_000_000;
const ID = `${AT}-00000000-0000-4000-8000-000000000001`;

/**
 * A session that logs which method was called.
 * @param {(method: string, args: any[]) => any} [answer]
 */
const fakeSession = (
  answer = () => harden({ requestId: ID, duplicate: false, state: 'queued' }),
) => {
  /** @type {any[]} */
  const calls = [];
  const session = Far('Session', {
    enqueueOnce: (/** @type {any[]} */ ...args) => {
      calls.push(['enqueueOnce', args]);
      return answer('enqueueOnce', args);
    },
    enqueueMessageOnce: (/** @type {any[]} */ ...args) => {
      calls.push(['enqueueMessageOnce', args]);
      return answer('enqueueMessageOnce', args);
    },
  });
  return { session, calls };
};

const testBlobs = () => {
  const tmpRoot = join(harnessRoot, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  return makeTestBlobs({ dir: mkdtempSync(join(tmpRoot, 'w57-composer-')) });
};

test('attachments go through enqueueMessageOnce, none through enqueueOnce', async t => {
  const { session, calls } = fakeSession();
  const composer = makeComposer({ now: () => AT });
  const notes = Far('Notes', {});
  await E(composer).submit(session, 'plain', ID);
  await E(composer).submit(session, 'empty list', ID, harden({}));
  await E(composer).submit(
    session,
    'empty list',
    ID,
    harden({ attachments: [] }),
  );
  await E(composer).submit(
    session,
    'look @notes',
    ID,
    harden({ attachments: [{ label: 'notes', value: notes }] }),
  );
  t.deepEqual(
    calls.map(([m]) => m),
    ['enqueueOnce', 'enqueueOnce', 'enqueueOnce', 'enqueueMessageOnce'],
  );
  const [, args] = calls[3];
  t.deepEqual(args.slice(0, 3), [harden({ text: 'look @notes' }), ID, AT]);
  t.is(args[3][0].value, notes);
});

test('the guard refuses 33 attachments; a long text is refused before staging', async t => {
  const blobs = testBlobs();
  t.teardown(blobs.cleanup);
  const { session, calls } = fakeSession();
  const composer = makeComposer({ now: () => AT, blobs: blobs.store });
  const notes = Far('Notes', {});
  const many = harden(
    Array.from({ length: 33 }, (_, i) => ({ label: `a${i}`, value: notes })),
  );
  await t.throwsAsync(() =>
    E(composer).submit(session, 'x', ID, harden({ attachments: many })),
  );
  const long = 'x'.repeat(limitsM5.packageTextUnits + 1);
  await t.throwsAsync(
    () =>
      E(composer).submit(
        session,
        long,
        ID,
        harden({ attachments: [{ label: 'notes', value: notes }] }),
      ),
    { message: textOfM5.packageTooLong(long.length) },
  );
  await t.throwsAsync(() => E(composer).submit(session, '  ', ID), {
    message: texts.blankSubmission,
  });
  t.deepEqual(calls, []);
  t.deepEqual(filesIn(blobs.blobDir), [], 'nothing was staged');
});

test('a staged text refused for its attachments leaves no file', async t => {
  const blobs = testBlobs();
  t.teardown(blobs.cleanup);
  const { session, calls } = fakeSession(() => {
    throw Error(textOfM5.duplicateAttachment('a'));
  });
  const composer = makeComposer({ now: () => AT, blobs: blobs.store });
  const notes = Far('Notes', {});
  const text = 'L'.repeat(limits.inlineBytes + 10);
  await t.throwsAsync(
    () =>
      E(composer).submit(
        session,
        text,
        ID,
        harden({
          attachments: [
            { label: 'a', value: notes },
            { label: 'a', value: notes },
          ],
        }),
      ),
    { message: textOfM5.duplicateAttachment('a') },
  );
  t.is(calls.length, 1);
  t.is(calls[0][0], 'enqueueMessageOnce');
  t.is(calls[0][1][0].bytes, text.length, 'sent staged');
  await blobsUntil(() => filesIn(blobs.blobDir).length === 0);
  t.deepEqual(filesIn(blobs.blobDir), []);
});

test('isRefusal knows the attachment refusals', t => {
  for (const message of [
    textOfM5.tooManyAttachments(40),
    textOfM5.duplicateAttachment('x'),
    textOfM5.reservedLabel('user'),
    textOfM5.packageTooLong(70_000),
    'In "enqueueMessageOnce" method of (Session): arg 3: ...',
  ]) {
    t.true(isRefusal(Error(message)), message);
  }
  t.false(isRefusal(Error('something else')));
});
