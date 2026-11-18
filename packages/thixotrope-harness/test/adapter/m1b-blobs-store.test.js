// @ts-check
// M1b W1b.1: the blob store, Content, BlobWriter, the manager's blob sink
// and the Composer's staging (resources/agent-host/impl/{blobs,content,
// composer}.js, resources/agent-host/durable.js; designs/m1b-interfaces.md
// sections 3.1, 3.2, 4 and 6.3). Node, real files in a temporary directory.
import '../unit/_m1a-prelude.js';

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { m1bShapes, texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';
import {
  STOCK_LOW,
  findBlobDir,
  makeBlobStore,
} from '../../resources/agent-host/impl/blobs.js';
import { makeContent } from '../../resources/agent-host/impl/content.js';
import { makeComposer } from '../../resources/agent-host/impl/composer.js';
import {
  makeTimerFacet,
  makeTimers,
} from '../../resources/agent-host/impl/timers.js';
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import { makeFakeBlobSink, makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches, passStyleOf } = /** @type {GuestGlobals} */ (
  globalThis
);

const requestId = '1763251200000-123e4567-e89b-12d3-a456-426614174000';

test('findBlobDir: <state>/agent-host/blobs from the adapter bundle path', t => {
  t.is(
    findBlobDir(['node', 'entry.js', 'id', '/s/state/bundles/abc.cjs']),
    '/s/state/agent-host/blobs',
  );
  t.throws(() => findBlobDir(['node', 'entry.js']), { message: /argv\[3\]/ });
});

test('stage: the file is written, fsynced, renamed and the directory fsynced before the handle is bound and answered', async t => {
  /** @type {string[]} */
  const steps = [];
  const blobs = makeTestBlobs({
    trace: (step, key) => steps.push(`${step}:${key}`),
  });
  t.teardown(blobs.cleanup);
  const text = 'é'.repeat(5000); // 10,000 bytes
  const staged = await blobs.store.stage(text);
  t.true(matches(staged, m1bShapes.StagedText));
  t.is(staged.bytes, 10_000);
  t.is(staged.preview, 'é'.repeat(limits.messagePreviewUnits));
  t.deepEqual(steps, [
    'write:b1',
    'fsync:b1',
    'rename:b1',
    'fsync-dir:b1',
    'bind:b1',
  ]);
  t.is(readFileSync(join(blobs.blobDir, 'b1'), 'utf8'), text);
  t.false(existsSync(join(blobs.blobDir, 'b1.part')));
  t.is(await blobs.store.read(staged.blob), text);
  // The stock was refilled once (32 handles); one is used.
  t.like(blobs.store.stats(), { refills: 1, staged: 1, stock: 31 });
});

test('Composer: a submission over inlineBytes reaches the session only as a StagedText whose bytes are on disk', async t => {
  /** @type {string[]} */
  const steps = [];
  const blobs = makeTestBlobs({ trace: step => steps.push(step) });
  t.teardown(blobs.cleanup);
  /** @type {any[]} */
  const seen = [];
  const session = Far('Session', {
    /** @param {any} submission */
    enqueueOnce: submission => {
      // At the moment the handle reaches the "vat", the file is complete
      // and every durable step has happened.
      seen.push({
        submission,
        steps: [...steps],
        onDisk: readFileSync(join(blobs.blobDir, 'b1'), 'utf8'),
      });
      return harden({
        requestId,
        duplicate: false,
        state: 'queued',
        entry: Far('QueueEntry', {}),
      });
    },
  });
  const composer = makeComposer({ now: () => 7, blobs: blobs.store });
  const text = `${'a'.repeat(limits.inlineBytes)}b`;
  await E(composer).submit(session, text, requestId);
  t.is(seen.length, 1);
  t.deepEqual(seen[0].steps, ['write', 'fsync', 'rename', 'fsync-dir', 'bind']);
  t.is(seen[0].onDisk, text);
  t.true(matches(seen[0].submission, m1bShapes.StagedText));
  t.is(seen[0].submission.bytes, limits.inlineBytes + 1);
  // Inline at exactly inlineBytes; blank refused before staging, whatever
  // its length.
  await E(composer).submit(session, 'a'.repeat(limits.inlineBytes), requestId);
  t.is(typeof seen[1].submission.text, 'string');
  await t.throwsAsync(
    () => E(composer).submit(session, ' '.repeat(20_000), requestId),
    { message: texts.blankSubmission },
  );
  t.is(blobs.store.stats().staged, 1);
});

test('a staging that fails before its directory fsync never hands its handle out', async t => {
  let fail = true;
  const blobs = makeTestBlobs({
    trace: step => {
      if (fail && step === 'fsync-dir') throw Error('disk gone');
    },
  });
  t.teardown(blobs.cleanup);
  /** @type {any[]} */
  const calls = [];
  const session = Far('Session', {
    /** @param {any[]} args */
    enqueueOnce: (...args) => {
      calls.push(args);
      return harden({ requestId, duplicate: false, state: 'queued' });
    },
  });
  const composer = makeComposer({ blobs: blobs.store });
  await t.throwsAsync(
    () => E(composer).submit(session, 'x'.repeat(9000), requestId),
    { message: textOf.stagingFailed('disk gone') },
  );
  t.is(calls.length, 0, 'nothing reached the session');
  t.is(blobs.store.stats().staged, 0);
  fail = false;
  await E(composer).submit(session, 'y'.repeat(9000), requestId);
  t.is(calls.length, 1);
  t.is(await blobs.store.read(calls[0][0].blob), 'y'.repeat(9000));
});

test('restart: a new incarnation resolves handles through the manager in batches of 64 and reads the files', async t => {
  const fake = makeFakeBlobSink();
  const first = makeTestBlobs({ sink: fake.sink });
  t.teardown(first.cleanup);
  /** @type {any[]} */
  const staged = [];
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    staged.push(await first.store.stage(`text ${i} ${'z'.repeat(i)}`));
  }
  // A new incarnation: empty presence map, the same directory and manager.
  const second = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  t.false(second.knows(staged[0].blob));
  const before = fake.counts.resolves;
  await second.resolveMany(staged.map(s => s.blob));
  t.is(fake.counts.resolves - before, 2, '100 handles: 2 manager cranks');
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.is(await second.read(staged[i].blob), `text ${i} ${'z'.repeat(i)}`);
  }
  t.is(fake.counts.resolves - before, 2, 'reads after the batch cost nothing');
  // A miss resolves one by one; an unknown handle is refused.
  const third = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  t.is(await third.read(staged[5].blob), `text 5 ${'z'.repeat(5)}`);
  await t.throwsAsync(() => third.read(Far('Blob', {})), {
    message: texts.blobUnknown,
  });
  // A handle the manager knows whose file is gone is unknown too.
  const fourth = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  writeFileSync(join(first.blobDir, 'b7'), '');
  t.is(await fourth.read(staged[6].blob), '');
});

test('readPage and Content: pages of whole code points, joined they are the text', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const text = `a${'€😀'.repeat(3000)}z`; // 1 + 7 x 3000 + 1 bytes
  const staged = await blobs.store.stage(text);
  t.is(staged.bytes, 21_002);
  const content = makeContent({ store: blobs.store });
  /** @type {string[]} */
  const pages = [];
  let offset = 0;
  let done = false;
  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(content).read(
      staged.blob,
      harden({ offset, maxBytes: 1000 }),
    );
    t.true(matches(page, m1bShapes.ContentPage));
    t.true(Buffer.byteLength(page.text) <= 1000);
    pages.push(page.text);
    offset = page.next;
    done = page.done;
  }
  t.is(pages.join(''), text);
  t.is(offset, staged.bytes);
  await t.throwsAsync(
    () => E(content).read(staged.blob, harden({ offset: 2, maxBytes: 10 })),
    { message: /character boundary/ },
  );
  await t.throwsAsync(() =>
    E(content).read(
      staged.blob,
      harden({ offset: 0, maxBytes: limits.blobPageBytes + 1 }),
    ),
  );
  await t.throwsAsync(
    () => E(content).read(Far('Blob', {}), harden({ offset: 0, maxBytes: 10 })),
    { message: texts.blobUnknown },
  );
  const whole = await E(content).read(
    staged.blob,
    harden({ offset: 0, maxBytes: limits.blobPageBytes }),
  );
  t.false(whole.done);
  t.true(Buffer.byteLength(whole.text) > limits.blobPageBytes - 4);
});

test('BlobWriter: pieces in order, close answers the StagedText; closed and aborted writers refuse', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const writer = await E(blobs.store.writers).open();
  const pieces = ['x'.repeat(limits.blobPieceBytes), 'é'.repeat(100), '😀'];
  for (const piece of pieces) {
    // eslint-disable-next-line no-await-in-loop
    await E(writer).append(piece);
  }
  const staged = await E(writer).close();
  t.true(matches(staged, m1bShapes.StagedText));
  t.is(staged.bytes, limits.blobPieceBytes + 200 + 4);
  t.is(staged.preview, 'x'.repeat(limits.toolPreviewUnits));
  t.is(await blobs.store.read(staged.blob), pieces.join(''));
  await t.throwsAsync(() => E(writer).append('more'), {
    message: texts.writerClosed,
  });
  await t.throwsAsync(() => E(writer).close(), { message: texts.writerClosed });
  await t.throwsAsync(() =>
    E(writer).append('x'.repeat(limits.blobPieceBytes + 1)),
  );

  const aborted = await E(blobs.store.writers).open();
  await E(aborted).append('partial');
  await E(aborted).abort();
  await t.throwsAsync(() => E(aborted).close(), {
    message: texts.writerClosed,
  });
  // abort is fire-and-forget (its guard returns nothing): the part file is
  // unlinked after the writer's queued writes and its close, so under load
  // that can take longer than any fixed pause. Wait for it, bounded.
  const parts = () =>
    readdirSync(blobs.blobDir).filter(name => name.endsWith('.part'));
  for (let waited = 0; parts().length > 0 && waited < 5000; waited += 10) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  t.deepEqual(parts(), []);
  // An empty writer closes as an empty blob.
  const empty = await E(blobs.store.writers).open();
  const nothing = await E(empty).close();
  t.is(nothing.bytes, 0);
  t.is(await blobs.store.read(nothing.blob), '');
});

test('BlobWriter: an idle writer is aborted after blobWriterIdleMs', async t => {
  /** @type {Array<{ ms: number, fn: () => void }>} */
  const armed = [];
  const timers = harden({
    delay: async () => {},
    /**
     * @param {number} ms
     * @param {() => void} fn
     */
    after: (ms, fn) => {
      const entry = { ms, fn, cancelled: false };
      armed.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const fake = makeFakeBlobSink();
  const blobs = makeTestBlobs({ sink: fake.sink });
  t.teardown(blobs.cleanup);
  const store = makeBlobStore({ dir: blobs.blobDir, sink: fake.sink, timers });
  const writer = await E(store.writers).open();
  await E(writer).append('a');
  const live = armed.filter(entry => !(/** @type {any} */ (entry).cancelled));
  t.is(live.length, 1);
  t.is(live[0].ms, limits.blobWriterIdleMs);
  live[0].fn();
  await t.throwsAsync(() => E(writer).append('b'), {
    message: texts.writerClosed,
  });
  t.is(store.stats().writersAborted, 1);
});

test('stock: refilled below STOCK_LOW with one refill in flight; sweep removes unfinished writes', async t => {
  const fake = makeFakeBlobSink();
  const blobs = makeTestBlobs({ sink: fake.sink });
  t.teardown(blobs.cleanup);
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => blobs.store.stage(`${i}`.repeat(10))),
  );
  t.true(
    fake.counts.mints >= 2 && fake.counts.mints <= 3,
    `${fake.counts.mints}`,
  );
  t.true(blobs.store.stats().stock >= STOCK_LOW - 1);
  // The sweep is the next incarnation's (HR-SYN-9: one per incarnation, and
  // this one swept before its first staging).
  writeFileSync(join(blobs.blobDir, 'b999.part'), 'half');
  const next = makeBlobStore({ dir: blobs.blobDir, sink: fake.sink });
  await next.sweep();
  t.false(existsSync(join(blobs.blobDir, 'b999.part')));
  t.true(existsSync(join(blobs.blobDir, 'b1')));
});

test('manager: mintBlobs and resolveBlobs on the real sink; admin.content() and TurnPorts through the attach', async t => {
  /** @type {any} */
  let spec;
  /** @type {any} */
  let impl;
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const makeManager = (/** @type {any} */ _options) =>
    harden({
      register: async (/** @type {any} */ key, /** @type {any} */ given) => {
        spec = given;
        if (impl === undefined) {
          impl = makeAgentHostImpl({ blobDir: blobs.blobDir });
          await impl.bind(key, given);
        }
        return harden({ handle: {}, status: { key, status: 'bound' } });
      },
      keys: () => harden(['agent-host']),
      lifecycle: Far('ManagerLifecycle', {
        started: async () => {},
        exited: async () => {},
      }),
    });
  const { facet: admin } = makeManagerVat({ makeManager });
  const content = await E(admin).content();
  t.truthy(content);
  const { sink } = spec;
  const stock = await E(sink).mintBlobs();
  t.true(matches(stock, m1bShapes.BlobStock));
  t.is(stock.length, limits.blobStockBatch);
  t.true(stock.every((/** @type {any} */ e) => /^b[0-9]+$/.test(e.key)));
  const keys = await E(sink).resolveBlobs(
    harden([stock[3].blob, Far('Blob', {}), stock[0].blob]),
  );
  t.deepEqual(keys, [stock[3].key, null, stock[0].key]);
  const more = await E(sink).mintBlobs();
  t.not(more[0].key, stock[0].key, 'keys never repeat');

  // The adapter stages through the same manager and Content reads it.
  const staged = await impl.blobs.stage('q'.repeat(9000));
  const page = await E(content).read(
    staged.blob,
    harden({ offset: 0, maxBytes: 100 }),
  );
  t.is(page.text, 'q'.repeat(100));
  // The list feed (W1b.5's channel, wired here): the factory's publisher
  // reaches Live.subscribeList subscribers of the same incarnation.
  const listPublisher = await E(admin).listPublisher();
  t.is(listPublisher, impl.listChannel.publisher);
  const live = await E(admin).live();
  const list = await E(live).subscribeList(0);
  const [snapshot] = (await E(list).next()).deliveries;
  t.deepEqual(snapshot.event, { type: 'list-snapshot' });

  // TurnPorts carry content, writers and timer.
  const backend = await E(admin).makeBackend(
    harden({ kind: 'scripted', label: 'S', script: { turns: [] } }),
  );
  const host = await E(admin).forSession();
  const session = Far('Session', {});
  await E(admin).bindSession(host, session);
  const ports = await E(backend).open(host);
  // Per session since J-9364: the ports' Content and writers are this
  // session's, not the incarnation-wide ones.
  t.not(ports.content, content);
  t.is(passStyleOf(ports.content), 'remotable');
  t.not(ports.writers, impl.blobs.writers);
  t.is(passStyleOf(ports.writers), 'remotable');
  await E(ports.timer).sleep(1);
  await t.throwsAsync(() => E(ports.timer).sleep(limits.maxDelayMs + 1));
});

test('Timer facet: sleep settles after the delay', async t => {
  const timer = makeTimerFacet(makeTimers());
  const t0 = Date.now();
  await E(timer).sleep(30);
  t.true(Date.now() - t0 >= 25);
});
