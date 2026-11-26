// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { limits } from '../config/defaults.js';
import {
  CHILD_FLAG,
  DEFAULT_CRANK_BUDGET,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  ENV_ALLOWLIST,
  SERVE_RECORD,
  allowlistEnvironment,
  checkCrankBudget,
  checkStateLocation,
  crankBudgetFloor,
  isNewState,
  isUnderTmp,
  parseMaxDeliveryAttempts,
  parseServeArgs,
  readServeRecord,
  unexpectedEnvironment,
  writeServeRecord,
} from '../scripts/serve.mjs';
import { harnessRoot, scratch } from './_helpers.js';
import {
  integrationEnabled,
  processesUnder,
  takeIntegrationLock,
} from './template/index.js';

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
    maxDeliveryAttempts: 5,
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
    THIXOTROPE_SLOT_CEILING: '4000000',
    THIXOTROPE_VAT_FRAME_BYTES: '65536',
    THIXOTROPE_CRANK_BUDGET: '50000000',
    THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '5',
  });
  // A host value wins over the harness default (M1b QC, J-0392).
  t.is(
    allowlistEnvironment(
      { ...env, THIXOTROPE_SLOT_CEILING: '1000000' },
      { crankBudget: 50_000_000n },
    ).THIXOTROPE_SLOT_CEILING,
    '1000000',
  );
  for (const name of Object.keys(out))
    t.true(
      ENV_ALLOWLIST.includes(name) || name === 'THIXOTROPE_CRANK_BUDGET',
      name,
    );
  t.deepEqual(unexpectedEnvironment(out), []);
  t.deepEqual(unexpectedEnvironment(env), [
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'NODE_OPTIONS',
    'UNRELATED',
  ]);
  // macOS adds this one to every process started without it.
  t.deepEqual(
    unexpectedEnvironment({ ...out, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' }),
    [],
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
  // The core writes the manifest at STATE/runtime.json (acquireIronhorseRuntime
  // is given the daemon state); a stray heaps/runtime.json is not it.
  await mkdir(path.join(dir, 'heaps'));
  await writeFile(
    path.join(dir, 'heaps', 'runtime.json'),
    JSON.stringify({ limits: { crankBudget: '99000000000' } }),
  );
  await writeFile(
    path.join(dir, 'runtime.json'),
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

test('the collection schedule and the hub store pass through to the supervisor (CC-022..CC-024)', t => {
  const env = {
    THIXOTROPE_GC_POLICY: 'every-crank',
    THIXOTROPE_GC_SLOT_ALLOWANCE: '65536',
    THIXOTROPE_GC_CHUNK_ALLOWANCE: '8388608',
    THIXOTROPE_GC_CRANK_INTERVAL: '16',
    THIXOTROPE_HUB_STORE: 'file',
  };
  const out = allowlistEnvironment(env, { crankBudget: 1n });
  for (const [name, value] of Object.entries(env)) t.is(out[name], value);
  // Unset stays unset: the supervisor applies its own defaults.
  const bare = allowlistEnvironment({}, { crankBudget: 1n });
  for (const name of Object.keys(env)) t.false(name in bare);
});

test('THIXOTROPE_VAT_FRAME_BYTES: the harness ceiling at its crank budget, a host value wins, the core default below it (CC-027)', t => {
  t.true(ENV_ALLOWLIST.includes('THIXOTROPE_VAT_FRAME_BYTES'));
  // Above the largest encoded frame the harness sends into a vat (an import
  // chunk of short turns, 40,040 bytes, J-10125) and below the 94,208-byte
  // halt at 50 M (J-0194); the supervisor accepts 1,024..8,388,608.
  t.is(limits.vatFrameBytes, 65_536);
  t.true(limits.vatFrameBytes > 40_040);
  t.true(limits.vatFrameBytes < 94_208);
  for (const crankBudget of [50_000_000n, 100_000_000n])
    t.is(
      allowlistEnvironment({}, { crankBudget }).THIXOTROPE_VAT_FRAME_BYTES,
      '65536',
    );
  t.is(
    allowlistEnvironment(
      { THIXOTROPE_VAT_FRAME_BYTES: '40960' },
      { crankBudget: 50_000_000n },
    ).THIXOTROPE_VAT_FRAME_BYTES,
    '40960',
  );
  // Below the harness budget the core's own default (32,768) stands.
  t.false(
    'THIXOTROPE_VAT_FRAME_BYTES' in
      allowlistEnvironment({}, { crankBudget: 10_000_000n }),
  );
});

test('THIXOTROPE_MAX_DELIVERY_ATTEMPTS: allowlisted, defaulted from config, validated like thix serve', t => {
  t.true(ENV_ALLOWLIST.includes('THIXOTROPE_MAX_DELIVERY_ATTEMPTS'));
  // The upstream default (PR 1667), as a named harness setting.
  t.is(limits.maxDeliveryAttempts, 5);
  t.is(DEFAULT_MAX_DELIVERY_ATTEMPTS, limits.maxDeliveryAttempts);
  t.is(parseServeArgs(['st'], {}).maxDeliveryAttempts, 5);
  t.is(
    parseServeArgs(['st'], { THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '9' })
      .maxDeliveryAttempts,
    9,
  );
  t.is(
    parseServeArgs(['st', '--max-delivery-attempts=100'], {
      THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '9',
    }).maxDeliveryAttempts,
    100,
  );
  // The caller's value passes through the allowlist; an option wins.
  t.is(
    allowlistEnvironment(
      { THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '2' },
      { crankBudget: 1n },
    ).THIXOTROPE_MAX_DELIVERY_ATTEMPTS,
    '2',
  );
  t.is(
    allowlistEnvironment(
      { THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '2' },
      { crankBudget: 1n, maxDeliveryAttempts: 7 },
    ).THIXOTROPE_MAX_DELIVERY_ATTEMPTS,
    '7',
  );
  for (const good of ['2', '9', '10', '99', '100'])
    t.is(parseMaxDeliveryAttempts('x', good), Number(good), good);
  for (const bad of ['0', '1', '101', '05', '5.0', '', 'five', '-3'])
    t.throws(() => parseMaxDeliveryAttempts('x', bad), undefined, bad);
  for (const bad of ['0', '1', '101', '05', 'five']) {
    t.throws(
      () => parseServeArgs(['st'], { THIXOTROPE_MAX_DELIVERY_ATTEMPTS: bad }),
      { message: /between 2 and 100/ },
      bad,
    );
    t.throws(
      () => parseServeArgs(['st', `--max-delivery-attempts=${bad}`], {}),
      {
        message: /between 2 and 100/,
      },
    );
  }
  // An empty variable is unset, as for THIXOTROPE_CRANK_BUDGET.
  t.is(
    parseServeArgs(['st'], { THIXOTROPE_MAX_DELIVERY_ATTEMPTS: '' })
      .maxDeliveryAttempts,
    5,
  );
});

test('the supervisor child refuses to serve from an environment beyond the allowlist', async t => {
  const dir = await scratch(t, 'sv');
  const state = path.join(dir, 'st');
  const { code, stderr } = await new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [serveScript, CHILD_FLAG, state],
      { env: { PATH: process.env.PATH, LEAKED_SECRET: 'x' } },
      (_error, _stdout, err) =>
        resolve({ code: child.exitCode, stderr: String(err) }),
    );
  });
  t.is(code, 1);
  t.regex(stderr, /allowlisted environment.*LEAKED_SECRET/);
  t.false(stderr.includes('"x"'));
  // Refused before the state directory was made.
  await t.throwsAsync(() => readdir(state), { code: 'ENOENT' });
});

/** @param {number} pid */
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {() => boolean} predicate
 * @param {number} ms
 */
const waitFor = async (predicate, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
};

test('a child watching the parent pipe exits when its parent is SIGKILLed', async t => {
  const dir = await scratch(t, 'sv');
  const log = path.join(dir, 'log');
  await writeFile(log, '');
  const wrapper = spawn(
    process.execPath,
    [
      path.join(harnessRoot, 'test', 'fixtures', 'parent-pipe-wrapper.mjs'),
      log,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const line = await new Promise(resolve =>
    wrapper.stdout.once('data', bytes => resolve(String(bytes).trim())),
  );
  const [pidText, state] = String(line).split(' ');
  const childPid = Number(pidText);
  t.is(state, 'watching');
  t.true(alive(childPid));
  wrapper.kill('SIGKILL');
  t.true(await waitFor(() => !alive(childPid), 5000), 'no stray child remains');
  t.is((await readFile(log, 'utf8')).trim(), `gone ${childPid}`);
});

const integration = integrationEnabled ? test.serial : test.skip;
takeIntegrationLock(test, 'serve.test.js');

/**
 * The environment of a process of ours (`ps eww`), as one string.
 * @param {number} pid
 */
const environmentOf = pid =>
  execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)]).toString();

integration(
  'serve CLI: SIGKILL of the CLI stops the supervisor child, cleanly',
  async t => {
    const dir = await scratch(t, 'sv');
    const state = path.join(dir, 's');
    const cli = spawn(process.execPath, [serveScript, state], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LEAKED_SECRET: 'not-for-adapters' },
    });
    let err = '';
    cli.stderr.on('data', bytes => {
      err += String(bytes);
    });
    const t0 = Date.now();
    const serving = await new Promise((resolve, reject) => {
      let out = '';
      cli.stdout.on('data', bytes => {
        out += String(bytes);
        if (out.includes('"serving"')) resolve(JSON.parse(out.trim()));
      });
      cli.once('exit', () => reject(Error(`CLI exited: ${err}`)));
    });
    const servedMs = Date.now() - t0;
    const childPid = serving.pid;
    t.not(childPid, cli.pid);
    t.false(environmentOf(childPid).includes('LEAKED_SECRET'));
    t.true(
      environmentOf(childPid).includes('THIXOTROPE_MAX_DELIVERY_ATTEMPTS=5'),
    );
    const t1 = Date.now();
    cli.kill('SIGKILL');
    t.true(
      await waitFor(() => !alive(childPid), 70_000),
      'supervisor child exited',
    );
    const stopMs = Date.now() - t1;
    t.true(
      await waitFor(() => processesUnder(state).length === 0, 10_000),
      JSON.stringify(processesUnder(state)),
    );
    t.is((await readServeRecord(state))?.status, 'clean');
    t.log(JSON.stringify({ metric: 'serve.parentGone', servedMs, stopMs }));
  },
);

integration(
  'serveHarness: the supervisor (and so its adapters) gets only the allowlist',
  async t => {
    const { serveHarness } = await import('../scripts/serve.mjs');
    const dir = await scratch(t, 'sv');
    const state = path.join(dir, 's');
    const served = await serveHarness(
      { statePath: state, crankBudget: DEFAULT_CRANK_BUDGET },
      { env: { ...process.env, LEAKED_SECRET: 'not-for-adapters' } },
    );
    try {
      t.not(served.pid, process.pid);
      t.false(environmentOf(served.pid).includes('LEAKED_SECRET'));
    } finally {
      await served.close();
    }
    t.is((await readServeRecord(state))?.status, 'clean');
    t.deepEqual(processesUnder(state), []);
  },
);

test('rootless Podman and systemd credential paths pass; bus, XDG data and config overrides do not', t => {
  const env = {
    XDG_RUNTIME_DIR: '/run/thixotrope',
    CONTAINERS_CONF: '/nix/store/x-containers.conf',
    CREDENTIALS_DIRECTORY: '/run/credentials/thixotrope.service',
    XDG_CONFIG_HOME: '/elsewhere/config',
    XDG_DATA_HOME: '/elsewhere/data',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/999/bus',
    CONTAINERS_STORAGE_CONF: '/elsewhere/storage.conf',
    INVOCATION_ID: '0123',
  };
  const out = allowlistEnvironment(env, { crankBudget: 1n });
  t.is(out.XDG_RUNTIME_DIR, '/run/thixotrope');
  t.is(out.CONTAINERS_CONF, '/nix/store/x-containers.conf');
  t.is(out.CREDENTIALS_DIRECTORY, '/run/credentials/thixotrope.service');
  t.deepEqual(unexpectedEnvironment(env), [
    'CONTAINERS_STORAGE_CONF',
    'DBUS_SESSION_BUS_ADDRESS',
    'INVOCATION_ID',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]);
});

test('a new state under /tmp is refused unless --allow-tmp-state; an existing one is served with a warning', async t => {
  const fresh = `/tmp/thix-serve-test-${randomBytes(6).toString('hex')}`;
  t.true(await isUnderTmp(fresh));
  t.true(await isUnderTmp(`/private${fresh}`));
  t.false(await isUnderTmp('/tmpfoo/state'));
  t.false(await isUnderTmp(harnessRoot));
  t.true(await isNewState(fresh));
  await t.throwsAsync(
    checkStateLocation({ statePath: fresh, crankBudget: 1n }),
    {
      message:
        /Refusing to start a new state under a temporary directory .*--allow-tmp-state/,
    },
  );
  /** @type {string[]} */
  const warnings = [];
  await checkStateLocation(
    { statePath: fresh, crankBudget: 1n, allowTmpState: true },
    line => warnings.push(line),
  );
  t.deepEqual(warnings, []);
  t.true(parseServeArgs([fresh, '--allow-tmp-state'], {}).allowTmpState);
  t.false('allowTmpState' in parseServeArgs([fresh], {}));

  const existing = await mkdtemp('/tmp/thix-serve-test-');
  t.teardown(() => rm(existing, { recursive: true, force: true }));
  t.true(await isNewState(existing), 'an empty directory is new');
  await writeFile(path.join(existing, 'workspace.json'), '{}\n');
  t.false(await isNewState(existing));
  await checkStateLocation({ statePath: existing, crankBudget: 1n }, line =>
    warnings.push(line),
  );
  t.is(warnings.length, 1);
  t.regex(warnings[0], /is under a temporary directory/);

  // A durable path is never questioned.
  await checkStateLocation(
    { statePath: path.join(harnessRoot, 'tmp', 'x'), crankBudget: 1n },
    line => warnings.push(line),
  );
  t.is(warnings.length, 1);
});

test('the CLI refuses a new /tmp state before creating anything', async t => {
  const fresh = `/tmp/thix-serve-test-${randomBytes(6).toString('hex')}`;
  t.teardown(() => rm(fresh, { recursive: true, force: true }));
  const { code, stderr } = await new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [serveScript, fresh],
      (_error, _stdout, err) =>
        resolve({ code: child.exitCode, stderr: String(err) }),
    );
  });
  t.is(code, 1);
  t.regex(
    stderr,
    /serve: Refusing to start a new state under a temporary directory/,
  );
  t.false(existsSync(fresh));
});
