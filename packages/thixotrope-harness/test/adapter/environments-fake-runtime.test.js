// @ts-check
// The environments adapter's fake runtime (resources/environments/impl/
// runtime-fake.js; designs/m6-interfaces.md D-M6-8, 5.3, 5.5 step 1, 11):
// host child processes in their own process groups, recorded under run/.
// Node, real processes, a temporary directory.
import '../unit/_m1a-prelude.js';

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kill } from 'node:process';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { environmentTextOf } from '../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import {
  fakeCommandEnv,
  liveGroupsOf,
  makeFakeRuntime,
} from '../../resources/environments/impl/runtime-fake.js';

const decoder = new TextDecoder();

/** One environment's directories under a fresh temporary state. */
const makeEnv = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thix-fake-runtime-')));
  const env = harden({
    key: 'e1',
    name: 'thix-tag-e1',
    tag: 'tag',
    workspace: join(root, 'workspace'),
    home: join(root, 'home'),
    run: join(root, 'run'),
    settings: harden({ runtime: 'fake', allowedCommands: harden(['sh']) }),
  });
  mkdirSync(env.workspace, { recursive: true });
  mkdirSync(env.home, { recursive: true });
  return { root, env };
};

const options = harden({
  timeoutMs: 60_000,
  killGraceMs: 2000,
  streamBytes: 65_536,
});

/** @param {number} pgid */
const alive = pgid => {
  try {
    kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

test.afterEach.always(t => {
  const { root } = /** @type {any} */ (t.context);
  if (root) rmSync(root, { recursive: true, force: true });
});

test('result shape: streams, a non-zero exit as data, no record left', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  t.is(runtime.kind, 'fake');
  t.deepEqual(await runtime.check(env.settings), { ok: true });
  await runtime.start(env);
  const result = await runtime.exec(
    env,
    ['sh', '-c', 'printf out; printf err >&2; exit 3'],
    options,
  );
  t.deepEqual(Object.keys(result).sort(), [
    'exitCode',
    'ms',
    'signal',
    'stderr',
    'stderrCut',
    'stdout',
    'stdoutCut',
    'timedOut',
  ]);
  t.true(result.stdout instanceof Uint8Array);
  t.is(decoder.decode(result.stdout), 'out');
  t.is(decoder.decode(result.stderr), 'err');
  t.is(result.exitCode, 3);
  t.is(result.signal, null);
  t.false(result.timedOut);
  t.false(result.stdoutCut);
  t.false(result.stderrCut);
  t.true(result.ms >= 0);
  t.deepEqual(readdirSync(env.run), [], 'a finished group leaves no record');
});

test('runs in the workspace with exactly A.3 variables (R3-45)', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  const pwd = await runtime.exec(env, ['pwd'], options);
  t.is(decoder.decode(pwd.stdout).trim(), env.workspace);
  const printed = await runtime.exec(env, ['env'], options);
  const lines = decoder.decode(printed.stdout).trim().split('\n');
  const vars = Object.fromEntries(
    lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  t.deepEqual(
    Object.keys(vars).sort(),
    ['CARGO_HOME', 'CARGO_TARGET_DIR', 'HOME', 'LANG', 'PATH', 'RUSTUP_HOME'],
  );
  t.deepEqual(vars, { ...fakeCommandEnv(env.home) });
  t.is(vars.HOME, env.home);
  t.is(vars.LANG, 'C.UTF-8');
});

test('caps: each stream keeps streamBytes and is drained to the end', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  const small = await runtime.exec(
    env,
    ['sh', '-c', 'head -c 5000 /dev/zero; head -c 300 /dev/zero >&2'],
    { ...options, streamBytes: 1000 },
  );
  t.is(small.stdout.length, 1000);
  t.true(small.stdoutCut);
  t.is(small.stderr.length, 300);
  t.false(small.stderrCut);
  // 10 MiB on each stream at once: the writer only exits when both are
  // drained (a pipe that is not read blocks it), so exit 0 proves the drain.
  const big = await runtime.exec(
    env,
    ['sh', '-c', 'head -c 10485760 /dev/zero & head -c 10485760 /dev/zero >&2; wait'],
    options,
  );
  t.is(big.exitCode, 0);
  t.is(big.stdout.length, 65_536);
  t.is(big.stderr.length, 65_536);
  t.true(big.stdoutCut && big.stderrCut);
  t.false(big.timedOut);
});

test('timeout: SIGTERM to the group', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  const result = await runtime.exec(env, ['sleep', '30'], {
    ...options,
    timeoutMs: 300,
  });
  t.true(result.timedOut);
  t.is(result.signal, 'SIGTERM');
  t.is(result.exitCode, null);
  t.true(result.ms >= 300 && result.ms < 2000, `${result.ms} ms`);
  t.deepEqual(readdirSync(env.run), []);
});

test('kill grace: a script trapping SIGTERM is killed 2 s later', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  /** @type {[number, string | number][]} */
  const signals = [];
  const runtime = makeFakeRuntime({
    kill: (pid, signal) => {
      if (signal !== 0) signals.push([pid, signal]);
      kill(pid, signal);
    },
  });
  await runtime.start(env);
  const result = await runtime.exec(
    env,
    ['sh', '-c', "trap '' TERM; sleep 30"],
    { ...options, timeoutMs: 300 },
  );
  t.true(result.timedOut);
  t.is(result.signal, 'SIGKILL');
  t.true(result.ms >= 2300 && result.ms < 4000, `${result.ms} ms`);
  t.deepEqual(
    signals.slice(0, 2).map(([pid, signal]) => [pid < 0, signal]),
    [
      [true, 'SIGTERM'],
      [true, 'SIGKILL'],
    ],
    'both signals go to the process group',
  );
});

test('a missing program rejects with a text that names no host path', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  const error = await t.throwsAsync(
    runtime.exec(env, ['thix-no-such-program'], options),
  );
  t.is(
    error?.message,
    environmentTextOf.runtimeFailed('thix-no-such-program: ENOENT'),
  );
  t.false(error?.message.includes(root));
  t.deepEqual(readdirSync(env.run), []);
});

test('a background process: the result returns, the group dies at stop', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  // The background sleep holds stdout open; the result must not wait for it.
  const result = await runtime.exec(
    env,
    ['sh', '-c', 'sleep 30 & echo started'],
    options,
  );
  t.is(decoder.decode(result.stdout), 'started\n');
  t.true(result.ms < 2000, `${result.ms} ms`);
  const [pgid] = liveGroupsOf(env.run);
  t.true(alive(pgid), 'the background group outlives the call');
  await runtime.stop(env);
  t.false(alive(pgid));
  t.deepEqual(readdirSync(env.run), []);
});

test('stop kills a running command', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  const runtime = makeFakeRuntime();
  await runtime.start(env);
  const running = runtime.exec(env, ['sleep', '30'], options);
  await new Promise(resolve => setTimeout(resolve, 100));
  const [pgid] = liveGroupsOf(env.run);
  t.true(alive(pgid));
  const before = performance.now();
  await runtime.stop(env);
  t.false(alive(pgid));
  const result = await running;
  t.is(result.signal, 'SIGKILL');
  t.false(result.timedOut);
  t.true(performance.now() - before < 1000);
  t.deepEqual(readdirSync(env.run), []);
});

test('sweep after a simulated SIGKILL kills the leftover groups from run/', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  // Incarnation 1 leaves a running group and a background group behind.
  const first = makeFakeRuntime();
  await first.start(env);
  const running = first.exec(env, ['sleep', '30'], options);
  await first.exec(env, ['sh', '-c', 'sleep 30 &'], options);
  await new Promise(resolve => setTimeout(resolve, 100));
  const leftovers = liveGroupsOf(env.run);
  t.is(leftovers.length, 2);
  // Incarnation 2 knows nothing in memory: only the records.
  const second = makeFakeRuntime();
  const answer = await second.sweep('tag', { runDirs: [env.run] });
  t.deepEqual(answer, { stopped: 2 });
  for (const pgid of leftovers) t.false(alive(pgid));
  t.deepEqual(readdirSync(env.run), []);
  await running;
  t.deepEqual(await second.sweep('tag', { runDirs: [env.run] }), {
    stopped: 0,
  });
  t.deepEqual(await second.sweep('tag'), { stopped: 0 });
});

test('sweep never signals a record older than the boot (a reused number)', async t => {
  const { root, env } = makeEnv();
  /** @type {any} */ (t.context).root = root;
  mkdirSync(env.run, { recursive: true });
  const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pgid = /** @type {number} */ (stranger.pid);
  try {
    const file = join(env.run, String(pgid));
    writeFileSync(file, JSON.stringify({ pgid, startedAt: 1000 }));
    utimesSync(file, 1, 1);
    const runtime = makeFakeRuntime();
    t.deepEqual(await runtime.sweep('tag', { runDirs: [env.run] }), {
      stopped: 0,
    });
    t.true(alive(pgid), 'the process of another boot is left alone');
    t.deepEqual(readdirSync(env.run), [], 'its record is removed');
  } finally {
    kill(-pgid, 'SIGKILL');
  }
});
