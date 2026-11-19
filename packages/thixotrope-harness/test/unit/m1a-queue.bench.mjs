// @ts-check
/**
 * Node microbenchmark of the session queue and recovery (M1a W1a.5). No vat
 * and no Ironhorse workload, so it needs no run lock. Rows are JSON lines
 * through `perf/_harness.mjs` (`PERF_OUT` appends them to a file) with
 * commit, crank budget (recorded, not applicable) and load average. Vat
 * costs are higher (W1a.1 measured about 0.25 ms per record shape check in
 * a vat against microseconds here); these rows bound the algorithmic cost.
 *
 *   node test/unit/m1a-queue.bench.mjs
 *
 * Metrics:
 * - `queue.enqueue.receipts4095`: one `enqueueOnce` (and the claim that
 *   follows) while 4,095 receipts are kept: the age prune scans them all.
 * - `queue.enqueue.empty`: the same with no receipts.
 * - `queue.view.100ascii` / `queue.view.100euro`: `view()` of 100 waiting
 *   entries of 8,192 units, ASCII (no cut) and three-byte (previews cut to
 *   fit one frame); `bytes` is the view's exact size.
 * - `recovery.open20`: `recover` (recovery.js) of a dispatched turn with 20
 *   open intents and 2 queued messages, over a minimal core.
 * - `session.queueRecovery.bundle`: source bytes of queue.js and recovery.js
 *   and the bytes of each bundled alone (with its guest/lib imports), next
 *   to bounded.js bundled alone (which carries interfaces.js and limits.js).
 *
 * BENCH_ROUNDS (default 200) sets the samples.
 */
import '../../scripts/_init.mjs';

import path from 'node:path';
import url from 'node:url';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// After lockdown (a static import would evaluate before _init's await).
const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, single } = await import('../../perf/_harness.mjs');
const { bundleGuest } = await import('../../scripts/bundle-guest.mjs');
/* eslint-disable import/no-relative-packages */
const { makeQueue } = await import('../../guest/session/queue.js');
const { makeRecovery } = await import('../../guest/session/recovery.js');
const { limits } = await import('../../guest/lib/limits.js');
const { messageBytes } = await import('../../guest/lib/bounded.js');
const { textOf } = await import('../../guest/lib/interfaces.js');
/* eslint-enable import/no-relative-packages */

const { Far } = /** @type {any} */ (globalThis);

const rounds = Number(process.env.BENCH_ROUNDS ?? 200);
const NOW = 1_763_000_000_000;
/**
 * @param {number} issued
 * @param {number} n
 */
const rid = (issued, n) =>
  `${issued}-0123abcd-4567-89ab-cdef-${String(n).padStart(12, '0')}`;
const turn = Far('Turn', {});
const extra = { note: 'Node, no vat; algorithmic cost only' };

// ---- enqueueOnce with a full receipt table (prune scans every receipt)
for (const kept of [0, limits.maxReceipts - 1]) {
  const queue = makeQueue();
  let n = 0;
  for (; n < kept; n += 1) {
    // Issued just inside the window, one ms apart: round i expires one.
    queue.enqueueOnce(
      harden({ text: 'r' }),
      rid(NOW - limits.retryWindowMs + 1 + n, n),
      NOW,
    );
    const item = queue.first();
    if (item) queue.claim(item, turn);
  }
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < rounds + 20; i += 1) {
    // Expire one old receipt per round so the table stays at `kept`.
    const at = NOW + i + 1;
    const t0 = performance.now();
    queue.enqueueOnce(harden({ text: 'hello' }), rid(at, 1_000_000 + i), at);
    const item = queue.first();
    if (item) queue.claim(item, turn);
    const t1 = performance.now();
    if (i >= 20) samples.push(t1 - t0);
  }
  // eslint-disable-next-line no-await-in-loop
  await stats(
    kept ? 'queue.enqueue.receipts4095' : 'queue.enqueue.empty',
    samples,
    { extra: { ...extra, receipts: kept } },
  );
}

// ---- view() of 100 long entries
for (const [name, unit] of /** @type {const} */ ([
  ['queue.view.100ascii', 'x'],
  ['queue.view.100euro', '€'],
])) {
  const queue = makeQueue();
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    queue.enqueueOnce(
      harden({ text: unit.repeat(limits.submissionUnits) }),
      rid(NOW, i),
      NOW,
    );
  }
  /** @type {number[]} */
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < rounds + 20; i += 1) {
    const t0 = performance.now();
    const view = queue.view();
    const t1 = performance.now();
    if (i >= 20) samples.push(t1 - t0);
    bytes = messageBytes(view);
  }
  if (bytes > limits.frameBytes) throw Error(`${name}: ${bytes} bytes`);
  // eslint-disable-next-line no-await-in-loop
  await stats(name, samples, {
    extra: { ...extra, entries: limits.maxWaiting, bytes },
  });
}

// ---- recovery of a dispatched turn with 20 open intents
{
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < rounds + 20; i += 1) {
    /** @type {any[]} */
    const log = [];
    const queue = makeQueue();
    queue.enqueueOnce(harden({ text: 'a' }), rid(NOW, 1), NOW);
    queue.enqueueOnce(harden({ text: 'b' }), rid(NOW, 2), NOW);
    const intents = Array.from({ length: 20 }, (_, k) => ({
      opId: textOf.opId('t1', 0, k),
      callId: `c${k}`,
      name: 'echo',
      args: '{}',
    }));
    /** @type {any} */
    let current = {
      turnId: 't1',
      generation: 1,
      round: 0,
      dispatched: true,
      ports: {},
      openIntents: () => intents,
      dropPorts: () => {
        current.ports = undefined;
      },
    };
    const records = {
      append: (/** @type {any} */ r) => log.push(r),
      ofTurn: () => log,
    };
    const recovery = makeRecovery({
      records,
      queue,
      current: () => current,
      settle: (/** @type {any} */ _active, /** @type {any} */ outcome) => {
        log.push({ kind: 'turn-settled', ...outcome });
        current = undefined;
      },
      hooks: { onRecover: () => {} },
      hookTurn: (/** @type {any} */ turn) =>
        /** @type {any} */ (Object.freeze({ active: turn })),
    });
    const active = current;
    const t0 = performance.now();
    recovery.recover(active);
    const t1 = performance.now();
    if (log.length !== 21) throw Error('expected 21 records');
    if (i >= 20) samples.push(t1 - t0);
  }
  await stats('recovery.open20', samples, {
    extra: { ...extra, openIntents: 20, queued: 2 },
  });
}

// ---- bundle sizes (each module bundled alone, with its guest/lib imports)
{
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const guestRoot = path.resolve(here, '../../guest');
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const [label, file] of /** @type {const} */ ([
    ['queue', 'session/queue.js'],
    ['recovery', 'session/recovery.js'],
    ['bounded', 'lib/bounded.js'],
  ])) {
    const entry = path.join(guestRoot, file);
    // eslint-disable-next-line no-await-in-loop
    const bundle = await bundleGuest(entry, { guestRoot });
    // eslint-disable-next-line no-await-in-loop
    const source = (await stat(entry)).size;
    sizes[`${label}Bundle`] = bundle.bytes;
    sizes[`${label}Source`] = source;
  }
  await single('session.queueRecovery.bundle', 0, {
    extra: {
      ...sizes,
      note: 'value unused; sizes in bytes; queue.js bundles bounded.js, interfaces.js and limits.js with it',
    },
  });
}
