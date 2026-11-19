// @ts-check
// The environments adapter's runner (resources/environments/impl/runner.js;
// designs/m6-interfaces.md D-M6-3, D-M6-8, 4.2, 4.4, 4.7, 5.2): lazy start,
// idle stop on adapter timers, stop, release, sweep after a simulated
// SIGKILL, the allowlist and the timeout, a failed stop retried. Node, the
// real fake runtime (real processes), recorded around; a temporary state.
import '../unit/_m1a-prelude.js';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kill } from 'node:process';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentShapes,
  environmentTextOf,
  environmentTexts,
} from '../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import { makeRunner } from '../../resources/environments/impl/runner.js';
import {
  liveGroupsOf,
  makeFakeRuntime,
} from '../../resources/environments/impl/runtime-fake.js';

/** @import { Runtime } from '../../resources/environments/impl/runtime-fake.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { matches } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The state layout as contract 5.1 draws it (`layout.js` is another unit's;
 * the runner uses `tag`, `dirsOf` and `ensureWorkspace` only).
 * @param {string} root
 */
const makeTestLayout = root => {
  const sessions = join(root, 'environments', 'sessions');
  /** @type {string[]} */
  const ensured = [];
  return {
    ensured,
    layout: harden({
      tag: () => 'statetag',
      /** @param {string} key */
      dirsOf: key =>
        harden({
          workspace: join(sessions, key, 'workspace'),
          home: join(sessions, key, 'home'),
          run: join(sessions, key, 'run'),
        }),
      /** @param {string} key */
      ensureWorkspace: async key => {
        ensured.push(key);
        mkdirSync(join(sessions, key, 'workspace'), { recursive: true });
      },
    }),
  };
};

/** Adapter timers whose `after` the test fires by hand. */
const makeManualTimers = () => {
  /** @type {{ ms: number, fn: () => void, cancelled: boolean }[]} */
  const pending = [];
  return {
    pending,
    live: () => pending.filter(entry => !entry.cancelled),
    timers: harden({
      /**
       * @param {number} ms
       * @param {() => void} fn
       */
      after: (ms, fn) => {
        const entry = { ms, fn, cancelled: false };
        pending.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    }),
  };
};

/**
 * The real fake runtime with every call recorded (and `stop` failing on
 * demand).
 * @param {Runtime} runtime
 */
const recorded = runtime => {
  /** @type {[string, string, any?][]} */
  const calls = [];
  const control = { failStops: 0 };
  /** @type {Runtime} */
  const wrapped = harden({
    kind: runtime.kind,
    check: runtime.check,
    start: async env => {
      calls.push(['start', env.key]);
      return runtime.start(env);
    },
    exec: async (env, argv, options) => {
      calls.push(['exec', env.key, options]);
      return runtime.exec(env, argv, options);
    },
    stop: async env => {
      calls.push(['stop', env.key]);
      if (control.failStops > 0) {
        control.failStops -= 1;
        throw Object.assign(Error(`cannot stop ${env.run}`), { code: 'EBUSY' });
      }
      return runtime.stop(env);
    },
    remove: async env => {
      calls.push(['remove', env.key]);
      return runtime.remove(env);
    },
    sweep: async (tag, scope) => {
      calls.push(['sweep', tag, scope]);
      return runtime.sweep(tag, scope);
    },
  });
  return { calls, control, runtime: wrapped };
};

const settings = harden({
  runtime: 'fake',
  allowedCommands: harden(['sh', 'sleep', 'true']),
  idleStopMs: 5000,
});

/** @param {any} t */
const setUp = t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thix-runner-')));
  t.context.root = root;
  const { layout, ensured } = makeTestLayout(root);
  const clock = makeManualTimers();
  const rec = recorded(makeFakeRuntime());
  const runner = makeRunner({
    runtime: rec.runtime,
    settings,
    layout,
    timers: clock.timers,
  });
  return { root, layout, ensured, clock, rec, runner };
};

/** @param {any[]} calls */
const kinds = calls => calls.map(([kind, key]) => `${kind} ${key}`);

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

test('lazy start: nothing before the first command, one start for two', async t => {
  const { layout, ensured, rec, runner } = setUp(t);
  t.is(runner.runningCount(), 0);
  t.deepEqual(rec.calls, []);
  t.false(existsSync(layout.dirsOf('e1').home));
  const [a, b] = await Promise.all([
    runner.exec('e1', ['true']),
    runner.exec('e1', ['sh', '-c', 'exit 4']),
  ]);
  t.is(a.exitCode, 0);
  t.is(b.exitCode, 4);
  t.deepEqual(kinds(rec.calls), ['start e1', 'exec e1', 'exec e1']);
  t.deepEqual(ensured, ['e1']);
  t.true(existsSync(layout.dirsOf('e1').home));
  t.is(runner.runningCount(), 1);
  await runner.exec('e1', ['true']);
  t.deepEqual(ensured, ['e1'], 'a started environment is not ensured again');
  await runner.stop('e1');
});

test('the runtime gets the timeout, the 2 s grace and the 64 KiB stream cap', async t => {
  const { rec, runner } = setUp(t);
  await runner.exec('e1', ['true']);
  await runner.exec('e1', ['true'], { timeoutMs: 1234 });
  const options = rec.calls.filter(([kind]) => kind === 'exec').map(c => c[2]);
  t.deepEqual(options, [
    {
      timeoutMs: environmentLimits.defaultCommandTimeoutMs,
      killGraceMs: 2000,
      streamBytes: 65_536,
    },
    { timeoutMs: 1234, killGraceMs: 2000, streamBytes: 65_536 },
  ]);
  await runner.stop('e1');
});

test('idle stop: idleStopMs after the last command, cancelled by a new one', async t => {
  const { clock, rec, runner } = setUp(t);
  await runner.exec('e1', ['true']);
  t.deepEqual(
    clock.live().map(entry => entry.ms),
    [5000],
  );
  await runner.exec('e1', ['true']);
  t.is(clock.pending.length, 2);
  t.true(clock.pending[0].cancelled, 'the earlier idle timer is cancelled');
  // No idle timer while a command runs.
  const running = runner.exec('e1', ['sleep', '0.3']);
  await new Promise(resolve => setTimeout(resolve, 50));
  t.deepEqual(clock.live(), []);
  await running;
  const [idle] = clock.live();
  idle.fn();
  await new Promise(resolve => setTimeout(resolve, 50));
  t.is(runner.runningCount(), 0);
  t.deepEqual(
    kinds(rec.calls).filter(c => c.startsWith('stop')),
    ['stop e1'],
  );
  await runner.exec('e1', ['true']);
  t.deepEqual(
    kinds(rec.calls).filter(c => c.startsWith('start')),
    ['start e1', 'start e1'],
    'the next command starts it again',
  );
  await runner.stop('e1');
});

test('stop kills a running command and its background processes', async t => {
  const { layout, clock, runner } = setUp(t);
  await runner.exec('e1', ['sh', '-c', 'sleep 30 &']);
  const running = runner.exec('e1', ['sleep', '30']);
  await new Promise(resolve => setTimeout(resolve, 100));
  const groups = liveGroupsOf(layout.dirsOf('e1').run);
  t.is(groups.length, 2);
  await runner.stop('e1');
  for (const pgid of groups) t.false(alive(pgid));
  const result = await running;
  t.is(result.signal, 'SIGKILL');
  t.is(runner.runningCount(), 0);
  t.deepEqual(clock.live(), [], 'a stopped environment has no idle timer');
  await runner.stop('e1');
  await runner.stop('e9');
});

test('release stops and removes; a key never started is removed only', async t => {
  const { rec, runner } = setUp(t);
  await runner.exec('e1', ['true']);
  await runner.release('e1');
  await runner.release('e2');
  t.deepEqual(kinds(rec.calls), [
    'start e1',
    'exec e1',
    'stop e1',
    'remove e1',
    'remove e2',
  ]);
  t.is(runner.runningCount(), 0);
});

test('the allowlist and the timeout are checked before anything runs', async t => {
  const { rec, runner } = setUp(t);
  for (const argv of [
    ['rm', '-rf', '.'],
    ['/bin/sh'],
    ['../sh'],
    ['sh;rm'],
    [''],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(runner.exec('e1', argv), {
      message: environmentTextOf.notAllowed(argv[0]),
    });
  }
  await t.throwsAsync(runner.exec('e1', []), {
    message: environmentTextOf.notAllowed('undefined'),
  });
  for (const timeoutMs of [-1, 0, 1.5, 2 ** 31, '10']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      runner.exec('e1', ['true'], {
        timeoutMs: /** @type {any} */ (timeoutMs),
      }),
      { message: environmentTexts.timeoutInvalid },
    );
  }
  t.deepEqual(rec.calls, [], 'nothing started, nothing ran');
});

test('a timeout through the runner: SIGTERM, then the command is gone', async t => {
  const { layout, runner } = setUp(t);
  const result = await runner.exec('e1', ['sleep', '30'], { timeoutMs: 200 });
  t.true(result.timedOut);
  t.is(result.signal, 'SIGTERM');
  t.deepEqual(liveGroupsOf(layout.dirsOf('e1').run), []);
  await runner.stop('e1');
});

test('a failed stop is owed and retried before the environment runs again', async t => {
  const { root, rec, runner } = setUp(t);
  await runner.exec('e1', ['true']);
  rec.control.failStops = 1;
  const error = await t.throwsAsync(runner.stop('e1'));
  t.is(error?.message, environmentTextOf.runtimeFailed('EBUSY'));
  t.false(error?.message.includes(root), 'no host path in the text');
  t.is(runner.runningCount(), 0);
  await runner.exec('e1', ['true']);
  t.deepEqual(kinds(rec.calls), [
    'start e1',
    'exec e1',
    'stop e1',
    'stop e1',
    'start e1',
    'exec e1',
  ]);
  await runner.stop('e1');
  // A retry of the owed stop by the caller works too.
  await runner.exec('e1', ['true']);
  rec.control.failStops = 1;
  await t.throwsAsync(runner.stop('e1'), { message: /EBUSY/ });
  await runner.stop('e1');
  t.is(kinds(rec.calls).filter(c => c === 'stop e1').length, 5);
});

test('a start failure is a runtime failure without the path, and not kept', async t => {
  const { root, layout, rec } = setUp(t);
  const runner = makeRunner({
    runtime: rec.runtime,
    settings,
    layout: harden({
      ...layout,
      ensureWorkspace: async () => {
        throw Object.assign(Error(`EACCES: ${root}/environments`), {
          code: 'EACCES',
        });
      },
    }),
    timers: makeManualTimers().timers,
  });
  const error = await t.throwsAsync(runner.exec('e1', ['true']));
  t.is(error?.message, environmentTextOf.runtimeFailed('EACCES'));
  t.is(runner.runningCount(), 0);
  t.deepEqual(rec.calls, []);
});

test('sweep after a simulated SIGKILL stops what the last incarnation left', async t => {
  const { root, layout, rec, runner } = setUp(t);
  await runner.exec('e1', ['sh', '-c', 'sleep 30 &']);
  await runner.exec('e2', ['sh', '-c', 'sleep 30 &']);
  mkdirSync(join(root, 'environments', 'sessions', 'not-a-key'));
  const leftovers = [
    ...liveGroupsOf(layout.dirsOf('e1').run),
    ...liveGroupsOf(layout.dirsOf('e2').run),
  ];
  t.is(leftovers.length, 2);
  // The next incarnation: a new runner and runtime over the same state.
  const next = recorded(makeFakeRuntime());
  const clock = makeManualTimers();
  const after = makeRunner({
    runtime: next.runtime,
    settings,
    layout,
    timers: clock.timers,
  });
  t.deepEqual(await after.sweep(), { stopped: 2 });
  for (const pgid of leftovers) t.false(alive(pgid));
  const [[, tag, scope]] = next.calls;
  t.is(tag, 'statetag');
  t.deepEqual([...scope.runDirs].sort(), [
    layout.dirsOf('e1').run,
    layout.dirsOf('e2').run,
  ]);
  t.deepEqual(kinds(next.calls), ['sweep statetag'], 'nothing started');
  t.is(after.runningCount(), 0);
  // The old incarnation's runner is not used again; its timers die with it.
  t.true(rec.calls.length > 0);
});

test('sweep of a state with no sessions directory stops nothing', async t => {
  const { runner } = setUp(t);
  t.deepEqual(await runner.sweep(), { stopped: 0 });
});

test('inspect answers ShellInfo with no host path (A.3)', async t => {
  const { root, runner } = setUp(t);
  const info = runner.inspect();
  t.true(matches(info, environmentShapes.ShellInfo));
  t.deepEqual(info, {
    allowedCommands: ['sh', 'sleep', 'true'],
    timeoutMs: environmentLimits.defaultCommandTimeoutMs,
    maxOutputBytes: 65_536,
  });
  t.false(JSON.stringify(info).includes(root));
});
