// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_CRANK_BUDGET,
  ENV_ALLOWLIST,
  SERVE_RECORD,
  allowlistEnvironment,
  checkCrankBudget,
  crankBudgetFloor,
  parseServeArgs,
  readServeRecord,
  writeServeRecord,
} from '../scripts/serve.mjs';
import { harnessRoot, scratch } from './_helpers.js';

const serveScript = path.join(harnessRoot, 'scripts', 'serve.mjs');

test('arguments: state path, budget flag forms, idle sleep, snapshot cadence', t => {
  const parsed = parseServeArgs(
    [
      'st',
      '--crank-budget',
      '20000000',
      '--idle-sleep-ms=2000',
      '--snapshot-every',
      '64',
    ],
    {},
  );
  t.deepEqual(parsed, {
    statePath: path.resolve('st'),
    crankBudget: 20_000_000n,
    idleSleepMs: 2000,
    snapshotEveryDeliveries: 64,
  });
  t.is(parseServeArgs(['st', '--crank-budget=7'], {}).crankBudget, 7n);
  // u64 budgets survive as bigint.
  t.is(
    parseServeArgs(['st', '--crank-budget', '18446744073709551615'], {})
      .crankBudget,
    0xffff_ffff_ffff_ffffn,
  );
});

test('the budget falls back to THIXOTROPE_CRANK_BUDGET, then the default', t => {
  t.is(
    parseServeArgs(['st'], { THIXOTROPE_CRANK_BUDGET: '30000000' }).crankBudget,
    30_000_000n,
  );
  t.is(parseServeArgs(['st'], {}).crankBudget, DEFAULT_CRANK_BUDGET);
  t.is(
    parseServeArgs(['st'], { THIXOTROPE_CRANK_BUDGET: '' }).crankBudget,
    DEFAULT_CRANK_BUDGET,
  );
  // The flag wins over the environment.
  t.is(
    parseServeArgs(['st', '--crank-budget', '5'], {
      THIXOTROPE_CRANK_BUDGET: '9',
    }).crankBudget,
    5n,
  );
});

test('bad arguments are refused', t => {
  t.throws(() => parseServeArgs([], {}), { message: /Usage/ });
  t.throws(() => parseServeArgs(['a', 'b'], {}), {
    message: /Unexpected argument b/,
  });
  t.throws(() => parseServeArgs(['a', '--crank-budget'], {}), {
    message: /needs a value/,
  });
  for (const bad of ['0', '-1', '1e7', '10M', '', '18446744073709551616']) {
    t.throws(
      () => parseServeArgs(['a', `--crank-budget=${bad}`], {}),
      undefined,
      bad,
    );
  }
  t.throws(() => parseServeArgs(['a'], { THIXOTROPE_CRANK_BUDGET: 'lots' }), {
    message: /THIXOTROPE_CRANK_BUDGET must be a positive decimal integer/,
  });
  t.throws(() => parseServeArgs(['a', '--idle-sleep-ms', '0'], {}), {
    message: /positive/,
  });
  t.throws(() => parseServeArgs(['a', '--bogus'], {}), {
    message: /Unknown option/,
  });
});

test('the supervisor environment is the allowlist plus the budget', t => {
  const env = {
    HOME: '/home/u',
    PATH: '/bin',
    THIXOTROPE_TRACE: '1',
    THIXOTROPE_CRANK_BUDGET: '999',
    ANTHROPIC_API_KEY: 'not-for-adapters',
    AWS_SECRET_ACCESS_KEY: 'nor-this',
    NODE_OPTIONS: '--require /tmp/evil.js',
    UNRELATED: 'x',
  };
  const out = allowlistEnvironment(env, { crankBudget: 50_000_000n });
  t.deepEqual(out, {
    HOME: '/home/u',
    PATH: '/bin',
    THIXOTROPE_TRACE: '1',
    THIXOTROPE_CRANK_BUDGET: '50000000',
  });
  for (const name of Object.keys(out))
    t.true(
      ENV_ALLOWLIST.includes(name) || name === 'THIXOTROPE_CRANK_BUDGET',
      name,
    );
});

test('fresh state has no floor', async t => {
  const dir = await scratch(t, 'sv');
  t.deepEqual(await crankBudgetFloor(dir), {
    floor: 0n,
    reason: 'fresh state',
  });
  t.is(await checkCrankBudget(dir, 1n), 1n);
  t.is(await checkCrankBudget(path.join(dir, 'missing'), 1n), 1n);
});

test('after a clean shutdown the budget may go down', async t => {
  const dir = await scratch(t, 'sv');
  await writeServeRecord(dir, {
    version: 1,
    status: 'clean',
    crankBudget: '100000000',
    floor: '100000000',
  });
  t.is(await checkCrankBudget(dir, 10_000_000n), 10_000_000n);
});

test('after an unclean shutdown the budget may not go down, only stay or rise', async t => {
  const dir = await scratch(t, 'sv');
  await writeServeRecord(dir, {
    version: 1,
    status: 'running',
    crankBudget: '50000000',
    floor: '100000000',
    pid: 1,
  });
  // The floor is the highest budget since the last clean shutdown, not the last one.
  await t.throwsAsync(() => checkCrankBudget(dir, 50_000_000n), {
    message:
      /Refusing to lower THIXOTROPE_CRANK_BUDGET to 50000000 below 100000000: the last run .* did not shut down cleanly/,
  });
  await t.throwsAsync(() => checkCrankBudget(dir, 10_000_000n), {
    message: /Refusing/,
  });
  t.is(await checkCrankBudget(dir, 100_000_000n), 100_000_000n);
  t.is(await checkCrankBudget(dir, 200_000_000n), 200_000_000n);
});

test('state run without the wrapper takes runtime.json as the floor', async t => {
  const dir = await scratch(t, 'sv');
  await mkdir(path.join(dir, 'heaps'));
  await writeFile(
    path.join(dir, 'heaps', 'runtime.json'),
    JSON.stringify({ limits: { crankBudget: '10000000' } }),
  );
  await t.throwsAsync(() => checkCrankBudget(dir, 5_000_000n), {
    message: /without harness-serve.json/,
  });
  t.is(await checkCrankBudget(dir, 10_000_000n), 10_000_000n);
});

test('an unreadable record is refused rather than guessed', async t => {
  const dir = await scratch(t, 'sv');
  await writeFile(
    path.join(dir, SERVE_RECORD),
    JSON.stringify({ version: 1, status: 'maybe' }),
  );
  await t.throwsAsync(() => readServeRecord(dir), {
    message: /refusing to guess/,
  });
  await t.throwsAsync(() => checkCrankBudget(dir, 1n), {
    message: /refusing to guess/,
  });
});

test('the record is written atomically and private', async t => {
  const dir = await scratch(t, 'sv');
  const record = /** @type {const} */ ({
    version: 1,
    status: 'running',
    crankBudget: '1',
    floor: '1',
  });
  await writeServeRecord(dir, record);
  t.deepEqual(await readServeRecord(dir), record);
  t.deepEqual(await readdir(dir), [SERVE_RECORD]);
});

test('the CLI refuses to lower the budget after an unclean shutdown, before starting anything', async t => {
  const dir = await scratch(t, 'sv');
  await writeServeRecord(dir, {
    version: 1,
    status: 'running',
    crankBudget: '100000000',
    floor: '100000000',
    pid: 1,
  });
  const { code, stderr } = await new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [serveScript, dir, '--crank-budget', '10000000'],
      (_error, _stdout, err) =>
        resolve({ code: child.exitCode, stderr: String(err) }),
    );
  });
  t.is(code, 1);
  t.regex(
    stderr,
    /serve: Refusing to lower THIXOTROPE_CRANK_BUDGET to 10000000 below 100000000/,
  );
  // Nothing was started: the directory holds only the record.
  t.deepEqual(await readdir(dir), [SERVE_RECORD]);
});

test('in-process serving refuses the same way before any supervisor starts', async t => {
  const { serveHarness } = await import('../scripts/serve.mjs');
  const dir = await scratch(t, 'sv');
  await writeServeRecord(dir, {
    version: 1,
    status: 'running',
    crankBudget: '100000000',
    floor: '100000000',
  });
  await t.throwsAsync(
    () => serveHarness({ statePath: dir, crankBudget: 10_000_000n }),
    { message: /Refusing to lower/ },
  );
  t.deepEqual(await readdir(dir), [SERVE_RECORD]);
});
