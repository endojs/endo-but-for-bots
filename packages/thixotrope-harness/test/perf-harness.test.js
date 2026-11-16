// @ts-check
import test from '@endo/ses-ava/test.js';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BUDGET_SLACK,
  checkBudget,
  deliveries,
  delta,
  failureCount,
  hubJsonBytes,
  idleSleepMs,
  stats,
  summarize,
} from '../perf/_harness.mjs';
import { scratch } from './_helpers.js';

test('summaries are nearest-rank quantiles', t => {
  const samples = Array.from({ length: 200 }, (_, i) => 200 - i);
  t.deepEqual(summarize(samples), {
    n: 200,
    median: 101,
    p95: 191,
    p99: 199,
    min: 1,
    max: 200,
  });
  t.throws(() => summarize([]), { message: /at least one/ });
});

test('budgets fail above 1.25 x for latencies and above the budget for deliveries', t => {
  t.is(BUDGET_SLACK, 1.25);
  t.deepEqual(checkBudget({ median: 125 }, { median: 100 }), {
    pass: true,
    exceeded: [],
  });
  t.deepEqual(checkBudget({ median: 125.1 }, { median: 100 }), {
    pass: false,
    exceeded: ['median: 125.1 > 1.25 x 100'],
  });
  t.false(checkBudget({ median: 1, p95: 300 }, { median: 100, p95: 200 }).pass);
  t.true(checkBudget({ value: 30_000 }, { value: 30_000 }).pass);
  t.deepEqual(
    checkBudget(
      { median: 1, deliveries: { count: 4, perOp: 4 } },
      { deliveriesPerOp: 3 },
    ),
    { pass: false, exceeded: ['deliveriesPerOp: 4 > 3'] },
  );
  t.true(
    checkBudget({ deliveries: { count: 3, perOp: 3 } }, { deliveriesPerOp: 3 })
      .pass,
  );
  t.deepEqual(checkBudget({}, { median: 1 }), {
    pass: false,
    exceeded: ['median: not measured'],
  });
  t.deepEqual(checkBudget({ median: 1 }, undefined), {
    pass: null,
    exceeded: [],
  });
});

test('delivery counts come from engine timing deltas', t => {
  const before = {
    delivery: { count: 10, milliseconds: 100 },
    wake: { count: 1, milliseconds: 5 },
  };
  const after = {
    delivery: { count: 310, milliseconds: 20_100 },
    wake: { count: 1, milliseconds: 5 },
  };
  t.deepEqual(deliveries(before, after, 100), { count: 300, perOp: 3 });
  t.deepEqual(delta(before, after), {
    delivery: { count: 300, ms: 20_000 },
    wake: { count: 0, ms: 0 },
  });
});

test('hub.json size is read from the store, null before there is one', async t => {
  const dir = await scratch(t, 'ph');
  t.is(await hubJsonBytes(dir), null);
  await mkdir(path.join(dir, 'heaps'));
  await writeFile(path.join(dir, 'heaps', 'hub.json'), '{"a":1}\n');
  t.is(await hubJsonBytes(dir), 8);
});

test('a stats row carries the method fields and its verdict, as one JSON line', async t => {
  const dir = await scratch(t, 'ph');
  const out = path.join(dir, 'rows.jsonl');
  const saved = process.env.PERF_OUT;
  process.env.PERF_OUT = out;
  try {
    const before = { delivery: { count: 0, milliseconds: 0 } };
    const after = { delivery: { count: 200, milliseconds: 1 } };
    const failuresBefore = failureCount();
    const row = await stats('unit.op', [1, 2, 3, 4], {
      budget: { median: 1, deliveriesPerOp: 1 },
      before,
      after,
      ops: 4,
      root: dir,
    });
    t.is(failureCount(), failuresBefore + 1);
    const [line] = (await readFile(out, 'utf8')).trim().split('\n');
    t.deepEqual(JSON.parse(line), row);
    for (const field of [
      'metric',
      'unit',
      'n',
      'median',
      'p95',
      'p99',
      'max',
      'deliveries',
      'hubJsonBytes',
      'budget',
      'pass',
      'commit',
      'workerSha256',
      'crankBudget',
      'loadAvg',
    ])
      t.true(field in row, field);
    t.false(row.pass);
    t.deepEqual(row.deliveries, { count: 200, perOp: 50 });
    t.regex(String(row.crankBudget), /^[1-9][0-9]*$/);
    t.is(/** @type {number[]} */ (row.loadAvg).length, 3);
  } finally {
    if (saved === undefined) delete process.env.PERF_OUT;
    else process.env.PERF_OUT = saved;
  }
});

test('idle sleep defaults long so nothing checkpoints mid-measurement', t => {
  t.true(process.env.IDLE_MS !== undefined || idleSleepMs === 3_600_000);
});
