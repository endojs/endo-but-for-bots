// @ts-check
// M2 W2.4: `Composer.edit(entry, text)` (resources/agent-host/impl/
// composer.js; m2-interfaces.md 5.1, 11): blank refused before anything,
// inline under inlineBytes, staged over it for the entry's session (learnt
// from the receipt), the staged file deleted when the entry refuses or its
// vat is lost, kept otherwise. Through the real session queue where the
// entry matters (an in-memory session with fakes, no vat), and a blob store
// in a temporary directory under H/tmp.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import {
  isEditRefusal,
  makeComposer,
} from '../../resources/agent-host/impl/composer.js';
import { harnessRoot } from '../_helpers.js';
import { blobsUntil, filesIn, makeTestBlobs } from './_m1b-blobs.js';
import { makeQueueSession, requestId } from '../unit/_m2-queue-session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const tmpRoot = join(harnessRoot, 'tmp');

const testBlobs = () => {
  mkdirSync(tmpRoot, { recursive: true });
  return makeTestBlobs({ dir: mkdtempSync(join(tmpRoot, 'w24-composer-')) });
};

/** A turn running, so what is submitted next waits. */
const busySession = async () => {
  const s = await makeQueueSession();
  await s.submit('running');
  return s;
};

test('edit refuses blank text before reaching the entry', async t => {
  /** @type {any[]} */
  const edits = [];
  const entry = Far('QueueEntry', {
    edit: (/** @type {any} */ s) => edits.push(s),
  });
  const composer = makeComposer({ now: () => 5 });
  await t.throwsAsync(() => E(composer).edit(entry, '  \n '), {
    message: texts.blankSubmission,
  });
  t.deepEqual(edits, []);
});

test('an inline edit reaches the entry; the session runs the edited text', async t => {
  const s = await busySession();
  const composer = makeComposer({ now: () => 1_700_000_000_000 });
  const receipt = await E(composer).submit(s.session, 'draft', requestId());
  t.is(receipt.state, 'queued');
  await E(composer).edit(receipt.entry, 'final');
  t.deepEqual(s.pending(), ['final']);
  await s.finish();
  t.deepEqual(s.sent(), ['running', 'final']);
});

test('a staged edit is staged for the entry session, and is what runs', async t => {
  const blobs = testBlobs();
  t.teardown(blobs.cleanup);
  const s = await busySession();
  const composer = makeComposer({
    now: () => 1_700_000_000_000,
    blobs: blobs.store,
  });
  const receipt = await E(composer).submit(s.session, 'draft', requestId());
  const long = 'L'.repeat(limits.inlineBytes + 10);
  await E(composer).edit(receipt.entry, long);
  t.is(filesIn(blobs.blobDir).length, 1);
  const [row] = s.session.listPending().entries;
  t.is(row.preview, long.slice(0, limits.messagePreviewUnits));
  // Owned by the session: its quota counts it.
  t.is(blobs.store.usage(s.session).session, long.length);
  await s.finish();
  const sent = s.sent();
  t.is(sent.length, 2);
  t.is(sent[1].bytes, long.length);
  t.is(await blobs.store.read(sent[1].blob), long);
});

test('a staged edit the entry refuses leaves no file (entry gone, oversize guard)', async t => {
  const blobs = testBlobs();
  t.teardown(blobs.cleanup);
  const s = await busySession();
  const composer = makeComposer({
    now: () => 1_700_000_000_000,
    blobs: blobs.store,
  });
  const receipt = await E(composer).submit(s.session, 'draft', requestId());
  t.true(receipt.entry.cancel());
  await t.throwsAsync(
    () => E(composer).edit(receipt.entry, 'x'.repeat(limits.inlineBytes + 1)),
    { message: texts.entryGone },
  );
  // The Composer deletes the file without waiting (as `submit` does).
  await blobsUntil(() => filesIn(blobs.blobDir).length === 0);
  t.deepEqual(filesIn(blobs.blobDir), [], 'the refused edit left no file');
  await t.throwsAsync(() => E(composer).edit(receipt.entry, 'short'), {
    message: texts.entryGone,
  });
});

test('a staged edit whose session vat is lost leaves no file; another failure keeps it', async t => {
  const blobs = testBlobs();
  t.teardown(blobs.cleanup);
  const composer = makeComposer({ now: () => 5, blobs: blobs.store });
  const lost = Far('QueueEntry', {
    edit: () => {
      throw Error(`ocapn hub: ${RETIRED_TEXT}`);
    },
  });
  const text = 'y'.repeat(limits.inlineBytes + 1);
  await t.throwsAsync(() => E(composer).edit(lost, text));
  await blobsUntil(() => filesIn(blobs.blobDir).length === 0);
  t.deepEqual(filesIn(blobs.blobDir), []);
  const odd = Far('QueueEntry', {
    edit: () => {
      throw Error('something else');
    },
  });
  await t.throwsAsync(() => E(composer).edit(odd, text), {
    message: 'something else',
  });
  t.is(filesIn(blobs.blobDir).length, 1, 'it may have been kept: it stays');
});

test('a staged edit without a blob store is refused with stagingFailed and never sent', async t => {
  /** @type {any[]} */
  const edits = [];
  const entry = Far('QueueEntry', {
    edit: (/** @type {any} */ s) => edits.push(s),
  });
  const composer = makeComposer();
  await t.throwsAsync(
    () => E(composer).edit(entry, 'z'.repeat(limits.inlineBytes + 1)),
    { message: textOf.stagingFailed('no blob store') },
  );
  t.deepEqual(edits, []);
});

test('isEditRefusal: the entry refusals and a lost vat, not other failures', t => {
  t.true(isEditRefusal(Error(texts.entryGone)));
  t.true(isEditRefusal(Error(texts.blankSubmission)));
  t.true(isEditRefusal(Error(textOf.inlineTooLarge(9000, 8192))));
  t.true(isEditRefusal(Error('In "edit" method of (QueueEntry): bad')));
  t.true(isEditRefusal(Error(`ocapn hub: ${RETIRED_TEXT}`)));
  t.false(isEditRefusal(Error('something else')));
  t.false(isEditRefusal(undefined));
});

test('the Composer is on the M2 guard: edit refuses a non-remotable entry and an oversize text', async t => {
  const composer = makeComposer();
  await t.throwsAsync(() =>
    E(composer).edit(/** @type {any} */ ('q1'), 'text'),
  );
  await t.throwsAsync(() =>
    E(composer).edit(
      Far('QueueEntry', {}),
      'a'.repeat(limits.messageUnits + 1),
    ),
  );
});
