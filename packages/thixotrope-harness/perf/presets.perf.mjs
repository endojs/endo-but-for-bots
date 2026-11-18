// @ts-check
/**
 * Presets and inventory perf (M5 W5.1; designs/m5-interfaces.md 8.2), through
 * the daemon from the m1a state template (the real factory program):
 *
 * - `presets.save`: `Preset.save` round trip from a control client, a user
 *   preset with 32 endowments and a few hundred units of text, over a fixed
 *   window (PRESETS_WINDOW_MS, default 60 s); budget median <= 150 ms (one
 *   factory crank, as `queue.enqueue`).
 * - `inventory.page`: `Inventory.list(cursor)` of a 50-row page out of 1,000
 *   entries (built by 20 `addAll` of 50, about a minute of setup at most),
 *   the cursor cycling over every page, over the same window; budget median
 *   <= 200 ms (the session list page's 50 rows).
 *
 * Diagnostic rows over shorter windows (PRESETS_PROBE_MS, default 10 s), to
 * attribute a miss: `factory.floor` (`Inventory.rev()`, a factory crank
 * that does nothing), `presets.save.small` (a save with no endowments),
 * `inventory.page1` (a page of one row).
 *
 * Each row carries the durable-vat deliveries per operation from
 * `status().timings` (every vat's; the factory's crank is the one asked
 * for). A row whose window held few samples says so in `samples`; it never
 * runs longer.
 *
 *   node scripts/run-lock.mjs --exclusive --label presets -- node perf/presets.perf.mjs
 */
import { performance } from 'node:perf_hooks';

import { runPerf, single, stats } from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { sliceScript } = await import('../test/fixtures/scripts/m1a-slice.js');
const { makeSlice, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');

const WINDOW_MS = Number(process.env.PRESETS_WINDOW_MS ?? 60_000);
const PROBE_MS = Number(process.env.PRESETS_PROBE_MS ?? 10_000);
const INVENTORY_ENTRIES = 1000;
const PAGE = 50;
const WARMUP = 5;

/**
 * Run `op` back to back for `ms` after `WARMUP` unmeasured runs.
 * @param {number} ms
 * @param {(i: number) => Promise<void>} op
 */
const window = async (ms, op) => {
  for (let i = 0; i < WARMUP; i += 1) await op(-1 - i);
  /** @type {number[]} */
  const samples = [];
  const end = performance.now() + ms;
  for (let i = 0; performance.now() < end; i += 1) {
    const t0 = performance.now();
    await op(i);
    samples.push(performance.now() - t0);
  }
  return samples;
};

await runPerf('presets', async ({ provision }) => {
  const template = await sliceTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const { backend } = await slice.makeBackend(harden(sliceScript));
  const operator = await E(slice.harness).getOperator();
  const catalog = await E(operator).getPresets();
  const inventory = await E(operator).getInventory();

  /**
   * A diagnostic row over PROBE_MS.
   * @param {string} metric
   * @param {(i: number) => Promise<void>} op
   * @param {Record<string, unknown>} [extra]
   */
  const probe = async (metric, op, extra = {}) => {
    const b = await run.counters();
    const samples = await window(PROBE_MS, op);
    const a = await run.counters();
    await stats(metric, samples, {
      before: b,
      after: a,
      extra: { windowMs: PROBE_MS, samples: samples.length, ...extra },
    });
  };

  await probe('factory.floor', async () => {
    await E(inventory).rev();
  });

  // ---- presets.save
  const endowments = harden(
    Array.from({ length: 32 }, (_, i) =>
      harden({ label: `object-${i}`, value: backend }),
    ),
  );
  /** @param {number} i */
  const record = i =>
    harden({
      label: 'Perf preset',
      template: 'general',
      description: 'A preset the perf check saves again and again.',
      instructions: `Revision ${i}. ${'Answer briefly. '.repeat(20)}`,
      backend,
      modelId: 'scripted',
      endowments,
    });
  let { revision } = await E(catalog).configuration();
  const created = await E(catalog).create(record(0), revision);
  revision = created.revision;
  let before = await run.counters();
  const saves = await window(WINDOW_MS, async i => {
    revision = await E(created.preset).save(record(i), revision);
  });
  let after = await run.counters();
  await stats('presets.save', saves, {
    budget: { median: 150 },
    before,
    after,
    extra: {
      windowMs: WINDOW_MS,
      samples: saves.length,
      endowments: endowments.length,
      by: 'W5.1',
    },
  });

  const small = await E(catalog).create(
    harden({ label: 'Small', template: 'general' }),
    revision,
  );
  revision = small.revision;
  await probe('presets.save.small', async i => {
    revision = await E(small.preset).save(
      harden({ label: 'Small', template: 'general', instructions: `${i}` }),
      revision,
    );
  });

  await E(inventory).add('only', backend);
  await probe('inventory.page1', async () => {
    await E(inventory).list();
  });
  const [only] = (await E(inventory).list()).rows;
  await E(only.entry).remove();

  // ---- inventory.page: 1,000 entries by 20 addAll of 50
  const t0 = performance.now();
  for (let b = 0; b < INVENTORY_ENTRIES / PAGE; b += 1) {
    await E(inventory).addAll(
      harden(
        Array.from({ length: PAGE }, (_, i) =>
          harden({ label: `entry-${b * PAGE + i}`, value: backend }),
        ),
      ),
    );
  }
  await single('inventory.fill', performance.now() - t0, {
    extra: { entries: INVENTORY_ENTRIES, batches: INVENTORY_ENTRIES / PAGE },
  });
  const pages = INVENTORY_ENTRIES / PAGE;
  let rows = 0;
  before = await run.counters();
  const reads = await window(WINDOW_MS, async i => {
    const at = ((i % pages) + pages) % pages;
    const page = await E(inventory).list(
      at === 0 ? undefined : `i${at * PAGE}`,
    );
    rows = page.rows.length;
    if (rows !== PAGE) throw Error(`page of ${rows} rows`);
  });
  after = await run.counters();
  await stats('inventory.page', reads, {
    budget: { median: 200 },
    before,
    after,
    extra: {
      windowMs: WINDOW_MS,
      samples: reads.length,
      entries: INVENTORY_ENTRIES,
      rows,
      by: 'W5.1',
    },
  });
});
