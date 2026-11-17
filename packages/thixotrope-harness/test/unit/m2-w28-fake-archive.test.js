// @ts-check
// M2 W2.8: the in-memory fake archive W2.5's unit tests use
// (test/unit/_m2-fake-archive.js) agrees with the real store: the same
// session sealed through both answers the same SegmentEntry (digest
// included), and the controls reject, break and hold as documented.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { isRetiredBreak } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import { makeFakeVat } from '../adapter/_m2-archive-vat.js';
import {
  makeFakeSink,
  makeIncarnation,
  makeStateDir,
} from '../adapter/_m2-archive.js';
import { makeFakeArchive } from './_m2-fake-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

test('the fake archive answers what the real store answers, digest included', async t => {
  const dirs = await makeStateDir('w28u');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const inc = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 17,
    store: inc.blobs,
    keepTurns: 5,
    segmentTurns: 2,
  });
  const key = keyOf(vat.session);
  const port = inc.archive.portFor({ session: vat.session, key });
  // The fake names blobs by the same keys the blob store wrote them under.
  const fake = makeFakeArchive({
    keyOf: blob => /** @type {string} */ (inc.blobs.keyOf(blob)),
  });
  let compared = 0;
  for (let n = 0; n < 40; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ req) => {
      await inc.cache.prepare(vat.session, req, { key });
    });
    const req = vat.startSeal();
    if (req !== undefined) {
      /* eslint-disable no-await-in-loop */
      const fromFake = await E(fake.port).seal(req);
      const fromStore = await E(port).seal(req);
      /* eslint-enable no-await-in-loop */
      t.deepEqual(fromFake, fromStore);
      t.true(vat.sealed(fromStore));
      fake.acknowledge(vat.state());
      compared += 1;
    }
  }
  t.true(compared >= 5);
  t.deepEqual(fake.segments(), vat.entries);
  t.log({ compared, pages: fake.counts().pages });
});

test('the fake archive: reject, break, hold and acknowledge', async t => {
  const vat = makeFakeVat({ seed: 2, keepTurns: 3, segmentTurns: 2 });
  const fake = makeFakeArchive();
  const grow = async () => {
    while (vat.startSeal() === undefined) {
      // eslint-disable-next-line no-await-in-loop
      await vat.turn(async () => {});
    }
    vat.notSealed();
  };
  await grow();
  fake.rejectNext('disk full');
  await t.throwsAsync(() => vat.maybeSeal(fake.port), {
    message: textOf.archiveFailed('disk full'),
  });
  fake.breakNext();
  const error = await t.throwsAsync(() => vat.maybeSeal(fake.port));
  t.true(isRetiredBreak(error));
  const held = fake.holdNext();
  const sealing = vat.maybeSeal(fake.port);
  t.is(vat.startSeal(), undefined, 'one seal at a time');
  held.answer();
  t.truthy(await sealing);
  t.is(fake.segments().length, 1);
  fake.acknowledge(vat.state());
  // A wrong fingerprint is refused as the real store refuses it.
  await grow();
  const req = /** @type {any} */ (vat.startSeal());
  vat.notSealed();
  await t.throwsAsync(
    () => E(fake.port).seal(harden({ ...req, lastTurnId: 't1' })),
    {
      message: textOf.archiveFailed(
        'the range does not end with its last turn',
      ),
    },
  );
  t.throws(() => fake.acknowledge({ segments: 3, digest: 'x' }), {
    message: textOf.archiveFailed('segment 2 is missing'),
  });
});
