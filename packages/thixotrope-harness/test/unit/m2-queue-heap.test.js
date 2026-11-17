// @ts-check
// M2 W2.4: the queue's worst-case heap (m2-interfaces.md 5.3; the bound is
// stated in guest/lib/pending-queue.js). In Node, with V8's collector:
// - the receipt table holds at most maxReceipts receipts and the queue at
//   most maxWaiting entries, whatever is sent;
// - no receipt keeps a Blob (a staged submission's handle), a Turn, or a
//   QueueEntry that no longer waits, so a sealed turn's input is not kept
//   alive by its receipt;
// - the worst case (every receipt of the 24 h window of a maximum-size
//   inline text, and 100 waiting maximum-size texts) is within the stated
//   bound of strings, and the staged case is far below it.
// Node heap bytes stand in for the vat's (an Ironhorse string is about as
// large; slots are counted by objects). JSON rows are logged with t.log.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import v8 from 'node:v8';
import vm from 'node:vm';

// Before any guest module: they read the counting defineExoClass.
import { liveExos } from './_m1a-count-exos.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeQueue } from '../../guest/session/queue.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

v8.setFlagsFromString('--expose_gc');
/** @type {() => void} */
const gc = vm.runInNewContext('gc');
const tick = () => new Promise(resolve => setImmediate(resolve));
const heapUsed = async () => {
  await tick();
  gc();
  await tick();
  gc();
  return process.memoryUsage().heapUsed;
};

const NOW = 1_800_000_000_000;
/**
 * @param {number} issued
 * @param {number} n
 */
const rid = (issued, n) =>
  `${issued}-22222222-2222-4222-8222-${`${n}`.padStart(12, '0')}`;

/**
 * A distinct ASCII text of exactly `bytes` bytes.
 * @param {number} n
 * @param {number} bytes
 */
const textOf = (n, bytes) => `${n}:`.padEnd(bytes, 'x');

/**
 * Stated bound of one staged receipt in Node (pending-queue.js), bytes,
 * the test's own weak references included.
 */
const STAGED_RECEIPT_BYTES = 1280;
/** Stated worst case of strings (pending-queue.js), bytes. */
const STATED_STRINGS =
  limits.maxReceipts * limits.inlineBytes +
  limits.maxWaiting * (limits.inlineBytes + 3 * limits.messagePreviewUnits);

/**
 * Enqueue and claim `count` staged submissions, each with a fresh Blob.
 * @param {any} queue
 * @param {WeakRef<object>[]} blobs
 * @param {number} count
 */
const fillStaged = (queue, blobs, count) => {
  for (let i = 0; i < count; i += 1) {
    const blob = Far('Blob', {});
    blobs.push(new WeakRef(blob));
    queue.enqueueOnce(
      harden({
        blob,
        preview: textOf(i, limits.messagePreviewUnits),
        bytes: 100_000,
        digest: `${i}`.padStart(64, '0'),
      }),
      rid(NOW + i, i),
      NOW + i,
    );
    const item = queue.first();
    if (item === undefined) throw Error('no head');
    queue.claim(item, `t${i + 1}`);
  }
};

/**
 * The worst case: one receipt per id in the window, each of a maximum
 * inline text; all but the last 100 started (the receipt alone keeps the
 * text), the last 100 waiting.
 * @param {any} queue
 */
const fillInline = queue => {
  const turns = limits.maxReceipts - limits.maxWaiting;
  for (let i = 0; i < turns; i += 1) {
    queue.enqueueOnce(
      harden({ text: textOf(i, limits.inlineBytes) }),
      rid(NOW + i, i),
      NOW + i,
    );
    const item = queue.first();
    if (item === undefined) throw Error('no head');
    queue.claim(item, `t${i + 1}`);
  }
  for (let i = turns; i < limits.maxReceipts; i += 1) {
    queue.enqueueOnce(
      harden({ text: textOf(i, limits.inlineBytes) }),
      rid(NOW + i, i),
      NOW + i,
    );
  }
};

test.serial(
  'staged submissions: a started receipt keeps neither the Blob nor the entry',
  async t => {
    const queue = makeQueue();
    /** @type {WeakRef<object>[]} */
    const blobs = [];
    const before = await heapUsed();
    const count = limits.maxReceipts;
    // In a plain function: a suspended async test keeps its dead registers
    // (the last iteration's values) alive in V8, which would name one Blob.
    fillStaged(queue, blobs, count);
    const after = await heapUsed();
    const live = blobs.filter(ref => ref.deref() !== undefined).length;
    const counts = await liveExos();
    t.log(
      JSON.stringify({
        metric: 'queue.heap.staged',
        unit: 'bytes',
        receipts: count,
        heapGrowth: after - before,
        perReceipt: Math.round((after - before) / count),
        liveBlobs: live,
        liveQueueEntries: counts.live.QueueEntry ?? 0,
      }),
    );
    t.is(live, 0, 'no receipt keeps a Blob');
    t.is(counts.live.QueueEntry ?? 0, 0, 'no claimed entry is kept');
    t.true(
      after - before < STAGED_RECEIPT_BYTES * count,
      `the staged receipt table is under ${STAGED_RECEIPT_BYTES} bytes a receipt`,
    );
    // A receipt still answers the started turn by id.
    t.is(queue.receiptFor(rid(NOW, 0))?.turnId, 't1');
  },
);

test.serial(
  'cancelled entries: the receipt names one stand-in; the cancelled exos are not kept',
  async t => {
    // Exos of earlier tests that a loaded machine has not collected yet
    // are not this test's: count from here.
    const baseline = (await liveExos()).live.QueueEntry ?? 0;
    const queue = makeQueue();
    // In a plain function, as fillStaged.
    ((/** @type {any} */ q) => {
      for (let i = 0; i < 200; i += 1) {
        const { receipt } = q.enqueueOnce(
          harden({ text: `m${i}` }),
          rid(NOW + i, i),
          NOW + i,
        );
        receipt.entry.cancel();
      }
    })(queue);
    const counts = await liveExos();
    t.is(queue.size(), 0);
    t.true((counts.live.QueueEntry ?? 0) - baseline <= 1, 'only the stand-in');
    t.throws(() => queue.receiptFor(rid(NOW, 0))?.entry.describe());
  },
);

test.serial(
  'worst case: 4,096 receipts of maximum inline texts plus 100 waiting stay within the stated bound',
  async t => {
    const before = await heapUsed();
    const queue = makeQueue();
    fillInline(queue);
    t.is(queue.size(), limits.maxWaiting);
    // Both bounds hold: a 4,097th receipt and a 101st entry are refused.
    t.throws(() =>
      queue.enqueueOnce(
        harden({ text: 'x' }),
        rid(NOW + limits.maxReceipts, limits.maxReceipts),
        NOW + limits.maxReceipts,
      ),
    );
    const after = await heapUsed();
    const grown = after - before;
    const counts = await liveExos();
    t.log(
      JSON.stringify({
        metric: 'queue.heap.worstInline',
        unit: 'bytes',
        receipts: limits.maxReceipts,
        waiting: queue.size(),
        heapGrowth: grown,
        statedStrings: STATED_STRINGS,
        liveQueueEntries: counts.live.QueueEntry ?? 0,
        note: 'Node heap, V8 one-byte strings',
      }),
    );
    t.true(
      grown <= STATED_STRINGS * 1.25,
      `heap growth ${grown} within 1.25 x the stated ${STATED_STRINGS}`,
    );
    t.true(
      (counts.live.QueueEntry ?? 0) <= limits.maxWaiting,
      'only the waiting entries are live',
    );
    // Kept to here so the collector cannot take it before the measurement.
    t.is(queue.view().entries.length, limits.maxWaiting);
  },
);
