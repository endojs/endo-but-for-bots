// @ts-check
/**
 * Node benchmark of the context cache (M1b W1b.2; m1b-interfaces.md 6.5,
 * 9): `context.rebuild` at the adapter level for 200-turn and 1,000-turn
 * sessions. The session's records are made by the real record log and
 * `ContextSource` (guest code under the Node prelude) and its staged fields
 * by a real blob store (fsynced files) over a fake manager sink; the
 * restart is a fresh blob store over the same directory (empty presence
 * map: every handle is resolved through the sink, 64 per call) and a fresh
 * cache. No vat, no Ironhorse workload: no run lock. W1b.6 measures the
 * same end to end, where each page is a session crank and each resolve
 * batch a manager crank; this row reports those counts and an estimate.
 *
 *   node test/adapter/m1b-context-cache.bench.mjs
 *   CONTEXT_TURNS=200,1000 CONTEXT_SAMPLES=5 node ...
 *
 * Session shape (contract 6.5: 4-8 records per turn): every turn has its
 * input (about 400 units), a reply and a staged native context (as the
 * scripted backend with `nativeContext` and the real providers of M2); a
 * third of the turns make 1-2 echo calls (+3-4 records); 5 % of the other
 * texts are staged too (as text over inlineBytes would be; the files here
 * are small, so file reads are cheaper than with 9-20 KB texts). Rows:
 * - `context.rebuild` (budget 5 s for 1,000 turns before the request is
 *   sent): `prepare()` of the next turn's round 0 on a fresh incarnation:
 *   page pulls, batched resolves, file reads, projection. `vatEstimateMs`
 *   adds `pages x PAGE_CRANK_MS` and `resolveCalls x MANAGER_CRANK_MS` (the
 *   cranks a daemon pays and this bench does not).
 * - `context.append`: `prepare()` of one round in step (the steady-state
 *   cost per round: apply the append and project the whole session again).
 * - `context.project`: `projectRecords` alone on the same records.
 */
import '../../scripts/_init.mjs';

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, harnessRoot } = await import('../../perf/_harness.mjs');
const { makeBlobStore } =
  await import('../../resources/agent-host/impl/blobs.js');
const { makeContextCache } =
  await import('../../resources/agent-host/impl/context-cache.js');
const { projectRecords } =
  await import('../../resources/agent-host/impl/projection.js');
const { makeFakeBlobSink } = await import('./_m1b-blobs.js');
const { makeSessionSim } = await import('./_m1b-context.js');
/* eslint-disable import/no-relative-packages */
const { messageBytes } = await import('../../guest/lib/bounded.js');
const { blobsOf } = await import('../../guest/session/staging.js');
/* eslint-enable import/no-relative-packages */

const { E } = /** @type {any} */ (globalThis);

/** A session crank answering a page of up to 98 KB (contract 6.5: 70-90 ms). */
const PAGE_CRANK_MS = Number(process.env.PAGE_CRANK_MS ?? 90);
/** A manager crank answering `resolveBlobs` of 64 (one small crank). */
const MANAGER_CRANK_MS = Number(process.env.MANAGER_CRANK_MS ?? 75);
const TURNS = (process.env.CONTEXT_TURNS ?? '200,1000').split(',').map(Number);
const SAMPLES = Number(process.env.CONTEXT_SAMPLES ?? 5);

const root = mkdtempSync(path.join(harnessRoot, 'tmp', 'w1b2-bench-'));
try {
  for (const turns of TURNS) {
    const dir = path.join(root, `n${turns}`, 'agent-host', 'blobs');
    const fake = makeFakeBlobSink();
    const store = makeBlobStore({ dir, sink: fake.sink });
    const sim = makeSessionSim({
      seed: turns,
      store,
      stagedChance: 0.05,
      textUnits: 400,
      toolChance: 0.33,
      maxCalls: 2,
      nativeChance: 1,
      cancelChance: 0.01,
      interruptedChance: 0.01,
      unknownChance: 0,
    });
    const t0 = performance.now();
    for (let k = 0; k < turns; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sim.turn(async () => {}, { fallbackChance: 0 });
    }
    const buildMs = performance.now() - t0;
    // The next turn's round 0, as the session sends it after the restart.
    sim.records.append({
      kind: 'turn-started',
      turnId: `t${turns + 1}`,
      input: 'next',
      at: 1,
    });
    const req = sim.request(`t${turns + 1}`, 0);
    const records = sim.records.count();
    /** @type {number[]} */
    const rebuild = [];
    /** @type {any} */
    let last;
    for (let i = 0; i < SAMPLES; i += 1) {
      const fresh = makeBlobStore({ dir, sink: fake.sink });
      const cache = makeContextCache({ store: fresh });
      const resolvesBefore = fake.counts.resolves;
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const projection = await cache.prepare(sim.session, req);
      rebuild.push(performance.now() - t);
      last = {
        cache,
        projection,
        resolveCalls: fake.counts.resolves - resolvesBefore,
      };
    }
    const cacheStats = last.cache.stats();
    // Page sizes as the vat would send them.
    let pageBytesMax = 0;
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await E(sim.source).page(
        ...(cursor === undefined ? [] : [cursor]),
      );
      pageBytesMax = Math.max(pageBytesMax, messageBytes(page));
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const median = [...rebuild].sort((a, b) => a - b)[
      Math.floor(rebuild.length / 2)
    ];
    const vatEstimateMs = Math.round(
      median +
        cacheStats.pages * PAGE_CRANK_MS +
        last.resolveCalls * MANAGER_CRANK_MS,
    );
    // eslint-disable-next-line no-await-in-loop
    await stats('context.rebuild', rebuild, {
      budget: turns === 1000 ? { median: 5000 } : undefined,
      extra: {
        level: 'adapter',
        turns,
        records,
        transcriptRecords: last.projection.transcript.length,
        pages: cacheStats.pages,
        pageBytesMax,
        blobs: cacheStats.blobsRead,
        resolveCalls: last.resolveCalls,
        textUnits: cacheStats.textUnits,
        vatEstimateMs,
        estimate: {
          pageCrankMs: PAGE_CRANK_MS,
          managerCrankMs: MANAGER_CRANK_MS,
        },
        buildMs: Math.round(buildMs),
      },
    });

    // Steady state: one more round in step on the warm cache.
    const { cache } = last;
    /** @type {number[]} */
    const append = [];
    for (let i = 0; i < SAMPLES * 4; i += 1) {
      const turnId = `a${turns}x${i}`;
      sim.records.append({
        kind: 'turn-started',
        turnId,
        input: 'more',
        at: 1,
      });
      const next = sim.request(turnId, 0);
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await cache.prepare(sim.session, next);
      append.push(performance.now() - t);
      sim.records.append({
        kind: 'turn-settled',
        turnId,
        status: 'interrupted',
        at: 1,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await stats('context.append', append, {
      extra: { level: 'adapter', turns, appends: cache.stats().appends },
    });

    /** @type {number[]} */
    const project = [];
    const all = sim.records.since(0);
    const blobList = [...new Set(all.flatMap(blobsOf))];
    const texts = new Map(
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        blobList.map(
          async blob =>
            /** @type {[any, string]} */ ([blob, await store.read(blob)]),
        ),
      ),
    );
    for (let i = 0; i < SAMPLES * 4; i += 1) {
      const t = performance.now();
      projectRecords(all, { texts });
      project.push(performance.now() - t);
    }
    // eslint-disable-next-line no-await-in-loop
    await stats('context.project', project, {
      extra: { level: 'adapter', turns, records: all.length },
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
