// @ts-check
/**
 * Queue perf (M2 W2.4; milestones.md M2 perf row `queue.enqueue`: a
 * Composer submission while a turn runs, round trip, <= 150 ms).
 *
 * This script measures the queue with in-memory fakes: the real Composer
 * (resources/agent-host/impl/composer.js) and the real session
 * (guest/session/session.js, queue.js, pending-queue.js, submissions.js)
 * in Node with the guest prelude, a fake adapter whose turn never finishes,
 * no vat and no Ironhorse workload, so it takes no run lock. It bounds the
 * queue's own cost; the vat's is larger (a vat pays about 0.27 ms per
 * receipt visited and a crank floor of about 75 ms, J-0251, J-0402). The
 * end-to-end row through the daemon is W2.9's (m2-interfaces.md 2.5).
 *
 *   node perf/queue.perf.mjs
 *
 * Rows (JSON lines through perf/_harness.mjs; PERF_OUT appends them):
 * - `queue.enqueue.memory`: `Composer.submit` round trip while a turn runs,
 *   with `receipts` kept (0 or 3,800, so the samples stay under 4,096) and `waiting` entries before it (0 or
 *   98); budget 150 ms (the milestone's, applied to this lower bound).
 * - `queue.edit.memory`: `Composer.edit` of a waiting entry (inline).
 * - `queue.sendNow.memory`: `QueueEntry.sendNow` of the last of 99 waiting
 *   entries while a turn runs (moves it to the head).
 * - `queue.view.memory`: `Session.listPending()` of 100 entries.
 *
 * Each row samples back to back for a fixed window, QUEUE_WINDOW_MS
 * (default 10 s; six rows, about a minute), after QUEUE_WARMUP (20)
 * unrecorded operations, and reports median, p99, operations per second and
 * the samples the window held (`window`, `windowMs`, `samples`). A row
 * whose operations add receipts stops early at the receipt bound (a session
 * keeps at most `maxReceipts` Composer receipts in 24 h) and says so
 * (`stoppedAt`).
 */
import '../scripts/_init.mjs';

import { performance } from 'node:perf_hooks';
import { windowMs as windowLength } from './_window.mjs';

// After lockdown (a static import would evaluate before _init's await).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();

const { stats } = await import('./_harness.mjs');
const { makeComposer } =
  await import('../resources/agent-host/impl/composer.js');
/* eslint-disable import/no-relative-packages */
const { makeSession } = await import('../guest/session/session.js');
const { limits } = await import('../guest/lib/limits.js');
/* eslint-enable import/no-relative-packages */

const { E, Far } = /** @type {any} */ (globalThis);

const WINDOW_MS = windowLength('QUEUE_WINDOW_MS', 10_000);
const WARMUP = Number(process.env.QUEUE_WARMUP ?? 20);

/**
 * Run `op` WARMUP times unrecorded, then back to back for WINDOW_MS or
 * until `cap` samples; `op` returns the operation's own latency.
 * @param {() => Promise<number>} op
 * @param {number} [cap]
 */
const overWindow = async (op, cap = Infinity) => {
  for (let i = 0; i < WARMUP; i += 1) await op();
  /** @type {number[]} */
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < WINDOW_MS && samples.length < cap)
    samples.push(await op());
  const windowMs = performance.now() - t0;
  return {
    samples,
    fields: {
      window: WINDOW_MS,
      windowMs: Math.round(windowMs),
      samples: samples.length,
      perSecond: Math.round((samples.length * 1000) / windowMs),
      ...(samples.length >= cap
        ? { stoppedAt: `${cap} samples (receipt bound)` }
        : {}),
    },
  };
};
const AT = 1_800_000_000_000;
const extra = {
  mode: 'memory',
  note: 'Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)',
};

let serial = 0;
/** @param {number} at */
const rid = at => {
  serial += 1;
  return `${at}-33333333-3333-4333-8333-${`${serial}`.padStart(12, '0')}`;
};

/** A session whose first turn never finishes (the fake adapter holds it). */
const busySession = async () => {
  const ports = harden({
    endpoint: Far('Endpoint', {
      holdTurn: () => new Promise(() => {}),
      releaseTurn: () => {},
      startRound: () => {},
      cancelRound: () => {},
      armDeadline: () => {},
      disarm: () => {},
    }),
    publisher: Far('LivePublisher', { publish: () => {} }),
    tools: harden([]),
    since: AT - 60_000,
  });
  const { session } = makeSession({
    config: harden({
      key: 's1',
      title: 'queue perf',
      backendTitle: 'fake',
      modelId: 'scripted',
      preset: harden({ label: 'chat-only' }),
      createdAt: AT,
      userInitiated: true,
    }),
    services: {
      backend: Far('Backend', { open: () => ports }),
      host: Far('SessionHostFacet', { liveChannel: () => ports.publisher }),
    },
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  await new Promise(resolve => setImmediate(resolve));
  session.enqueueOnce(harden({ text: 'running' }), rid(AT), AT);
  return session;
};

let clock = AT;
const composer = makeComposer({ now: () => clock });

// ---- Composer.submit while a turn runs
for (const [receipts, waiting] of [
  [0, 0],
  [3800, 0],
  [0, limits.maxWaiting - 2],
]) {
  const session = await busySession();
  clock = AT;
  // Receipts of cancelled entries (a turn runs, so nothing is claimed).
  for (let i = 0; i < receipts; i += 1) {
    session.enqueueOnce(harden({ text: `r${i}` }), rid(AT), AT);
    session.listPending().entries[0].entry.cancel();
  }
  for (let i = 0; i < waiting; i += 1) {
    session.enqueueOnce(harden({ text: `w${i}` }), rid(AT), AT);
  }
  // Every submission keeps a receipt: stop below the bound.
  const cap = limits.maxReceipts - receipts - waiting - WARMUP - 2;
  const { samples, fields } = await overWindow(async () => {
    clock += 1;
    const t0 = performance.now();
    const receipt = await E(composer).submit(session, 'hello', rid(clock));
    const t1 = performance.now();
    // Keep the waiting count where it was: the entry leaves again.
    receipt.entry.cancel();
    return t1 - t0;
  }, cap);
  await stats('queue.enqueue.memory', samples, {
    budget: { median: 150 },
    extra: { ...extra, ...fields, receipts, waiting },
  });
}

// ---- Composer.edit of a waiting entry
{
  const session = await busySession();
  const receipt = await E(composer).submit(session, 'draft', rid(clock));
  let i = 0;
  const { samples, fields } = await overWindow(async () => {
    i += 1;
    const t0 = performance.now();
    await E(composer).edit(receipt.entry, `edit ${i}`);
    return performance.now() - t0;
  });
  await stats('queue.edit.memory', samples, { extra: { ...extra, ...fields } });
}

// ---- QueueEntry.sendNow of the last of 99 waiting entries
{
  const session = await busySession();
  for (let i = 0; i < limits.maxWaiting - 1; i += 1) {
    session.enqueueOnce(harden({ text: `w${i}` }), rid(AT), AT);
  }
  const { samples, fields } = await overWindow(async () => {
    // Since R6-44 (M2-FIX, J-9491) send-now cancels the running turn and the
    // entry is claimed when it settles, so each operation takes one entry
    // out of the queue: top it up to 99 waiting again, untimed.
    await new Promise(resolve => setImmediate(resolve));
    for (
      let n = session.listPending().entries.length;
      n < limits.maxWaiting - 1;
      n += 1
    ) {
      session.enqueueOnce(harden({ text: `t${n}` }), rid(AT), AT);
    }
    const { entries } = session.listPending();
    const last = entries[entries.length - 1].entry;
    const t0 = performance.now();
    await E(last).sendNow();
    return performance.now() - t0;
  });
  await stats('queue.sendNow.memory', samples, {
    extra: { ...extra, ...fields, waiting: limits.maxWaiting - 1 },
  });
}

// ---- listPending of 100 entries
{
  const session = await busySession();
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    session.enqueueOnce(
      harden({ text: `${i}`.padEnd(limits.messagePreviewUnits, 'v') }),
      rid(AT),
      AT,
    );
  }
  const { samples, fields } = await overWindow(async () => {
    const t0 = performance.now();
    session.listPending();
    return performance.now() - t0;
  });
  await stats('queue.view.memory', samples, {
    extra: { ...extra, ...fields, waiting: limits.maxWaiting },
  });
}
