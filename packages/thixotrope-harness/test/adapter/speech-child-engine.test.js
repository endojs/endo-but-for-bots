// @ts-check
// Speech engine child processes (`AH/speech/child-engine.js`;
// designs/m11-interfaces.md 3.3, 6.2, D-M11-10, D-M11-15): the
// environment allowlist, the ready line and its deadline, the bounded line
// reader (a 10 MiB line kills the engine), SIGTERM then SIGKILL to the
// whole process group, exit at end of input also when the adapter is
// SIGKILLed, restart pacing, and respawn on next use. Engines are
// `test/fixtures/fake-stt.mjs` and small inline Node programs.
import test from '@endo/ses-ava/test.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import {
  engineEnvironmentOf,
  makeChildEngine,
  makeLineReader,
  makeRestartPacing,
  spawnEngineProcess,
} from '../../resources/agent-host/impl/speech/child-engine.js';
import { engineEnvironment } from '../../resources/agent-host/impl/speech/engine-protocol.js';

const FAKE_STT = fileURLToPath(
  new URL('../fixtures/fake-stt.mjs', import.meta.url),
);
const CHILD_ENGINE = fileURLToPath(
  new URL(
    '../../resources/agent-host/impl/speech/child-engine.js',
    import.meta.url,
  ),
);
const node = process.execPath;

/**
 * @param {string} mode
 * @param {string[]} [extra]
 */
const fakeCommand = (mode, extra = []) =>
  harden([node, FAKE_STT, '--mode', mode, ...extra]);

/** @param {number} pid */
const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {() => boolean} condition
 * @param {number} ms
 */
const waitFor = async (condition, ms) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};

const tempDir = () => mkdtempSync(join(tmpdir(), 'thix-speech-'));

test('an engine gets only the allowlisted environment', async t => {
  const env = engineEnvironmentOf({
    PATH: process.env.PATH,
    HOME: '/home/engine',
    THIX_TEST_ONLY: 'must not pass',
    LANG: undefined,
  });
  t.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  const proc = spawnEngineProcess(
    {
      command: [
        node,
        '-e',
        'console.log(JSON.stringify({ env: process.env }))',
      ],
      output: 'lines',
      environment: {
        PATH: process.env.PATH,
        HOME: '/home/engine',
        THIX_TEST_ONLY: 'must not pass',
      },
    },
    { onLine: record => lines.push(record) },
  );
  t.true(await proc.ready);
  const exit = await proc.exited;
  t.is(exit.code, 0);
  const seen = /** @type {Record<string, string>} */ (lines[0]?.env);
  t.is(seen.HOME, '/home/engine');
  t.false('THIX_TEST_ONLY' in seen);
  // The platform may add its own variables (macOS adds __CF_*); nothing of ours passes.
  for (const name of Object.keys(seen)) {
    t.true(engineEnvironment.includes(name) || name.startsWith('__CF'), name);
  }
});

test('ready at the ready line; the engine exits at end of input', async t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const proc = spawnEngineProcess({
    command: fakeCommand('normal'),
    output: 'lines',
    readyEvent: 'ready',
    log: event => events.push(event),
    logAs: { direction: 'speech-in', kind: 'process' },
  });
  t.true(await proc.ready);
  t.true(proc.isReady());
  proc.endInput();
  const exit = await proc.exited;
  t.like(exit, { code: 0, reason: 'exit', wasReady: true });
  t.deepEqual(
    events.map(e => e.event),
    ['speech-engine-start', 'speech-engine-ready', 'speech-engine-exit'],
  );
  t.true(
    events.every(e => e.direction === 'speech-in' && e.kind === 'process'),
  );
});

test('an engine not ready within the load deadline is killed', async t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const proc = spawnEngineProcess({
    command: fakeCommand('slow-ready=5000'),
    output: 'lines',
    readyEvent: 'ready',
    loadMs: 200,
    log: event => events.push(event),
  });
  t.false(await proc.ready);
  const exit = await proc.exited;
  t.like(exit, { reason: 'load-timeout', wasReady: false });
  t.true(events.some(e => e.event === 'speech-engine-timeout'));
});

test('a 10 MiB engine line kills the engine', async t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  const proc = spawnEngineProcess(
    {
      command: fakeCommand('flood-line'),
      output: 'lines',
      readyEvent: 'ready',
      log: event => events.push(event),
    },
    { onLine: record => lines.push(record) },
  );
  t.true(await proc.ready);
  proc.writeLine({ type: 'stream_start', stream: 'u1' });
  proc.writeLine({ type: 'stream_audio', stream: 'u1', pcm: 'AAAA' });
  const exit = await proc.exited;
  t.like(exit, { reason: 'line-too-long', wasReady: true });
  t.deepEqual(lines, []);
  t.true(
    events.some(
      e => e.event === 'speech-engine-failed' && e.reason === 'line-too-long',
    ),
  );
});

test('terminate reaches the whole group and escalates to SIGKILL', async t => {
  // The engine ignores SIGTERM and end of input and runs a grandchild, as
  // `uv run` runs Python.
  const program = [
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(JSON.stringify({ event: 'ready', grandchild: g.pid }));",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const proc = spawnEngineProcess(
    {
      command: [node, '-e', program],
      output: 'lines',
      readyEvent: 'ready',
      killGraceMs: 300,
    },
    {},
  );
  // The ready line is consumed; read the grandchild from `ps` instead.
  t.true(await proc.ready);
  const pid = /** @type {number} */ (proc.pid);
  const ps = spawn('pgrep', ['-P', String(pid)]);
  let out = '';
  ps.stdout.on('data', chunk => {
    out += chunk;
  });
  await once(ps, 'close');
  const grandchild = Number(out.trim().split('\n')[0]);
  t.true(Number.isInteger(grandchild) && grandchild > 0);
  const started = Date.now();
  const exit = await proc.terminate();
  t.is(exit.reason, 'terminated');
  t.is(exit.signal, 'SIGKILL');
  t.true(Date.now() - started >= 250);
  t.true(await waitFor(() => !isAlive(grandchild), 3000));
});

test('a command that cannot start fails without a process', async t => {
  const proc = spawnEngineProcess({
    command: [join(tempDir(), 'no-such-engine')],
    output: 'lines',
    readyEvent: 'ready',
  });
  t.is(proc.pid, undefined);
  t.false(await proc.ready);
  t.like(await proc.exited, { reason: 'spawn-failed', wasReady: false });
});

test('the engine exits when the adapter that spawned it is SIGKILLed (D-M11-15)', async t => {
  const dir = tempDir();
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pids');
  const parent = [
    "import '@endo/init/debug.js';",
    `const { spawnEngineProcess } = await import(${JSON.stringify(CHILD_ENGINE)});`,
    `const proc = spawnEngineProcess({ command: ${JSON.stringify(fakeCommand('normal', ['--pid-file', pidFile]))}, output: 'lines', readyEvent: 'ready' });`,
    "await proc.ready; console.log('ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const adapter = spawn(node, ['--input-type=module', '-e', parent], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  adapter.stdout.on('data', chunk => {
    out += chunk;
  });
  t.true(await waitFor(() => out.includes('ready'), 10_000));
  const enginePid = Number(readFileSync(pidFile, 'utf8').trim());
  t.true(isAlive(enginePid));
  adapter.kill('SIGKILL');
  await once(adapter, 'exit');
  t.true(await waitFor(() => !isAlive(enginePid), 5000));
});

test('the line reader splits across chunks and stops at the bound', t => {
  /** @type {string[]} */
  const lines = [];
  let overflows = 0;
  const reader = makeLineReader({
    maxBytes: 8,
    onLine: line => lines.push(line),
    onOverflow: () => {
      overflows += 1;
    },
  });
  reader.push(Buffer.from('ab'));
  reader.push(Buffer.from('c\nde\nf'));
  reader.push(Buffer.from('g\n'));
  t.deepEqual(lines, ['abc', 'de', 'fg']);
  reader.push(Buffer.from('12345'));
  reader.push(Buffer.from('6789'));
  reader.push(Buffer.from('\nlater\n'));
  t.is(overflows, 1);
  t.deepEqual(lines, ['abc', 'de', 'fg']);
});

test('restart pacing holds after three failures in the window', t => {
  let now = 1000;
  const pacing = makeRestartPacing({
    restart: { failuresInWindow: 3, windowMs: 60_000, backoffMs: 30_000 },
    now: () => now,
  });
  pacing.failed();
  pacing.failed();
  t.false(pacing.holds());
  pacing.failed();
  t.true(pacing.holds());
  now += 29_999;
  t.true(pacing.holds());
  now += 1;
  t.false(pacing.holds());
  pacing.failed();
  t.true(pacing.holds(), 'still three failures inside the window');
  pacing.succeeded();
  t.false(pacing.holds());
  now += 120_000;
  pacing.failed();
  t.false(pacing.holds(), 'old failures left the window');
});

test('a resident engine respawns on next use and is paced after failed starts', async t => {
  const dir = tempDir();
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pids');
  const pidsSeen = () =>
    readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
  const engine = makeChildEngine({
    command: fakeCommand('normal', ['--pid-file', pidFile]),
    output: 'lines',
    readyEvent: 'ready',
  });
  t.is(engine.state(), 'idle');
  const first = engine.start();
  t.is(engine.state(), 'starting');
  t.true(await first?.ready);
  t.is(engine.state(), 'ready');
  t.is(engine.start(), first, 'one process while it runs');
  process.kill(/** @type {number} */ (first?.pid), 'SIGKILL');
  await first?.exited;
  t.is(engine.state(), 'idle');
  const second = engine.start();
  t.true(await second?.ready);
  t.not(second?.pid, first?.pid);
  t.deepEqual(pidsSeen(), [first?.pid, second?.pid]);
  await engine.stop();
  t.false(second?.alive());
  t.is(engine.start(), undefined, 'nothing starts after stop');

  const crashing = makeChildEngine({
    command: fakeCommand('crash-at-start'),
    output: 'lines',
    readyEvent: 'ready',
    restart: { failuresInWindow: 3, windowMs: 60_000, backoffMs: 400 },
  });
  for (let i = 0; i < 3; i += 1) {
    const proc = crashing.start();
    t.truthy(proc);
    // eslint-disable-next-line no-await-in-loop
    t.false(await proc?.ready);
  }
  t.is(crashing.state(), 'failed');
  t.is(crashing.start(), undefined);
  t.true(await waitFor(() => crashing.state() === 'idle', 2000));
  const again = crashing.start();
  t.truthy(again);
  t.false(await again?.ready);
  await crashing.stop();
});
