// @ts-check
// The OCI runtimes (podman, docker) of the environments adapter and the
// image pin (contract m6-interfaces.md D-M6-8, 5.3, 5.4, P-55; spec R3-45,
// R3-47, R7-9, R8-41, R8-42): the argv of start, exec, stop, remove and
// sweep for both binaries, the pin form and presence gate, the timeout
// kill by process group, and that no runtime CLI text (which may name host
// paths) reaches a caller. Everywhere against the fake CLI
// (test/fixtures/fake-bin/oci-cli.mjs); the `[real-runtime]` cases run
// against the real binary when THIX_HARNESS_REAL_RUNTIME is podman or
// docker and THIX_HARNESS_REAL_IMAGE names a digest pin present locally.
import '../unit/_m1a-prelude.js';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  env as processEnv,
  execPath,
  getgid,
  getuid,
  kill as processKill,
} from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentTextOf,
  environmentTexts,
} from '../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import {
  checkImagePin,
  isDigestPin,
} from '../../resources/environments/impl/images.js';
import {
  makeCliExec,
  makeOciRuntime,
} from '../../resources/environments/impl/runtime-oci.js';

import { makeEnvironmentsImpl } from '../../resources/environments/impl/index.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const fakeCli = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-bin/oci-cli.mjs',
);

// A digest pin built at run time (no real image is named).
const hex = (/** @type {string} */ digit) => digit.repeat(64);
const pin = `harness/dev-shell@sha256:${hex('a')}`;
const absentPin = `harness/dev-shell@sha256:${hex('0')}`;
const tag = '0123456789abcdef';

const decode = (/** @type {Uint8Array} */ bytes) =>
  new TextDecoder().decode(bytes);

/** A.3's environment as the container sees it. */
const a3Env = [
  'HOME=/home/node',
  'CARGO_HOME=/home/node/.cargo',
  'RUSTUP_HOME=/home/node/.rustup',
  'CARGO_TARGET_DIR=/home/node/target',
  'PATH=/home/node/.cargo/bin:/usr/local/bin:/usr/bin:/bin',
  'LANG=C.UTF-8',
];

/**
 * Variables the wrapper's own `sh` sets for the command (not the host's,
 * not a credential).
 */
const shellSet = /^(?:PWD|OLDPWD|SHLVL|_)=/;
/** @param {Uint8Array} stdout */
const envLines = stdout =>
  decode(stdout)
    .trim()
    .split('\n')
    .filter(line => !shellSet.test(line))
    .sort();

const execOptions = harden({
  timeoutMs: environmentLimits.defaultCommandTimeoutMs,
  killGraceMs: environmentLimits.killGraceMs,
  streamBytes: environmentLimits.streamBytes,
});

/**
 * A fake engine directory, a runtime driving it, and per-key environments.
 * @param {import('ava').ExecutionContext} t
 * @param {'podman' | 'docker'} binary
 * @param {{ images?: string[], settings?: object }} [options]
 */
const setUp = (t, binary, { images = [pin], settings = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'env-oci-'));
  t.teardown(() => {
    // Leave no host process of the fake behind.
    const procs = join(root, 'engine', 'procs');
    if (existsSync(procs)) {
      for (const name of readdirNames(procs)) {
        for (const pid of readdirNames(join(procs, name))) {
          try {
            processKill(-Number(pid), 'SIGKILL');
          } catch {
            // gone
          }
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const engine = join(root, 'engine');
  mkdirSync(engine);
  writeFileSync(join(engine, 'images.json'), JSON.stringify(images));
  const exec = makeCliExec({
    file: execPath,
    prefix: [fakeCli, binary],
    env: {
      THIX_FAKE_OCI_DIR: engine,
      PATH: processEnv.PATH ?? '/usr/bin:/bin',
    },
  });
  const runtime = makeOciRuntime({ binary, exec });
  /**
   * @param {string} key
   * @param {string} [envTag] the state's tag
   */
  const envOf = (key, envTag = tag) => {
    const dir = join(root, 'state', 'sessions', key);
    const workspace = join(dir, 'workspace');
    const home = join(dir, 'home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    return harden({
      key,
      name: `thix-${envTag}-${key}`,
      tag: envTag,
      workspace,
      home,
      run: join(dir, 'run'),
      settings: harden({
        runtime: binary,
        allowedCommands: [],
        image: pin,
        ...settings,
      }),
    });
  };
  /** @returns {string[][]} */
  const calls = () => {
    const file = join(engine, 'calls.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  };
  const clearCalls = () => rmSync(join(engine, 'calls.jsonl'), { force: true });
  return { root, engine, runtime, envOf, calls, clearCalls };
};

/** @param {string} dir */
const readdirNames = dir => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The `run` argv the runtime must build (contract 5.3).
 * @param {'podman' | 'docker'} binary
 * @param {{ name: string, workspace: string, home: string }} env
 * @param {{ pids?: number, memoryBytes?: number, cpus?: number }} [limits]
 */
const expectedRun = (binary, env, limits = {}) => [
  'run',
  '--detach',
  '--pull=never',
  '--name',
  env.name,
  '--label',
  `thix.state=${tag}`,
  '--user',
  '1000:1000',
  ...(binary === 'podman' ? ['--userns', 'keep-id:uid=1000,gid=1000'] : []),
  '--cap-drop',
  'ALL',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--security-opt',
  'no-new-privileges',
  '--network',
  'none',
  '--pids-limit',
  String(limits.pids ?? 1024),
  '--memory',
  String(limits.memoryBytes ?? 4 * 1024 * 1024 * 1024),
  '--cpus',
  String(limits.cpus ?? 2),
  '--log-driver',
  'none',
  '--volume',
  `${env.workspace}:/workspace:rw`,
  '--volume',
  `${env.home}:/home/node:rw`,
  '--workdir',
  '/workspace',
  ...a3Env.flatMap(pair => ['--env', pair]),
  pin,
  'sleep',
  'infinity',
];

test('isDigestPin takes <repository>@sha256:<64 hex> only', t => {
  const accepted = [
    pin,
    `dev@sha256:${hex('f')}`,
    `localhost:5000/team/dev-shell@sha256:${hex('1')}`,
    `localhost/a_b/c.d/e--f@sha256:${hex('2')}`,
  ];
  const refused = [
    'harness/dev-shell',
    'harness/dev-shell:latest',
    `harness/dev-shell:latest@sha256:${hex('a')}`,
    `harness/dev-shell@sha256:${'a'.repeat(63)}`,
    `harness/dev-shell@sha256:${'A'.repeat(64)}`,
    `harness/dev-shell@sha512:${hex('a')}`,
    `@sha256:${hex('a')}`,
    `-harness@sha256:${hex('a')}`,
    `--pull=always@sha256:${hex('a')}`,
    `harness/dev shell@sha256:${hex('a')}`,
    `harness/dev-shell@sha256:${hex('a')}\n`,
    `HARNESS/dev@sha256:${hex('a')}`,
    `harness/Dev@sha256:${hex('a')}`,
    `${'a/'.repeat(260)}x@sha256:${hex('a')}`,
    '',
    undefined,
    42,
  ];
  for (const value of accepted) t.true(isDigestPin(value), String(value));
  for (const value of refused) t.false(isDigestPin(value), String(value));
});

for (const binary of /** @type {const} */ (['podman', 'docker'])) {
  test(`${binary}: the pin gate refuses a non-digest pin before any CLI call`, async t => {
    const { runtime, calls } = setUp(t, binary);
    for (const image of ['harness/dev-shell:latest', undefined]) {
      // eslint-disable-next-line no-await-in-loop -- in order
      t.deepEqual(await checkImagePin({ runtime, image }), {
        ok: false,
        reason: environmentTexts.imageRefused,
      });
      // eslint-disable-next-line no-await-in-loop -- in order
      t.deepEqual(await runtime.check({ image }), {
        ok: false,
        reason: environmentTexts.imageRefused,
      });
    }
    t.deepEqual(calls(), []);
  });

  test(`${binary}: the pin gate checks presence without pulling`, async t => {
    const { runtime, calls, engine } = setUp(t, binary);
    t.deepEqual(await checkImagePin({ runtime, image: pin }), { ok: true });
    t.deepEqual(await checkImagePin({ runtime, image: absentPin }), {
      ok: false,
      reason: environmentTexts.imageRefused,
    });
    const presence =
      binary === 'podman'
        ? ['image', 'exists']
        : ['image', 'inspect', '--format', '{{.Id}}'];
    t.deepEqual(calls(), [
      [...presence, pin],
      [...presence, absentPin],
    ]);
    t.false(
      calls().some(argv => argv.includes('pull')),
      'never pulls',
    );

    // An engine it cannot reach is a runtime failure, not an absent image.
    writeFileSync(join(engine, 'down'), '');
    const down = await runtime.check({ image: pin });
    t.deepEqual(down, {
      ok: false,
      reason: environmentTextOf.runtimeFailed(
        `the ${binary} engine is not reachable`,
      ),
    });
  });

  test(`${binary}: a missing binary is reported without its path`, async t => {
    const missing = join(tmpdir(), 'no-such-dir-for-oci', binary);
    const runtime = makeOciRuntime({
      binary,
      exec: makeCliExec({ file: missing, env: {} }),
    });
    const answer = await runtime.check({ image: pin });
    t.deepEqual(answer, {
      ok: false,
      reason: environmentTextOf.runtimeFailed(`${binary} is not installed`),
    });
  });

  test(`${binary}: start runs the confined container (argv golden)`, async t => {
    const { runtime, envOf, calls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    t.deepEqual(calls(), [expectedRun(binary, env)]);

    const seeded = { ...envOf('e3'), project: true };
    await runtime.start(seeded);
    t.true(
      calls()[1].includes(
        '/tmp/thix:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=1536m',
      ),
    );

    // Configured limits replace the defaults (W-12).
    const limited = setUp(t, binary, {
      settings: { pids: 64, memoryBytes: 268_435_456, cpus: 1 },
    });
    const env2 = limited.envOf('e2');
    await limited.runtime.start(env2);
    t.deepEqual(limited.calls(), [
      expectedRun(binary, env2, {
        pids: 64,
        memoryBytes: 268_435_456,
        cpus: 1,
      }),
    ]);
  });

  test(`${binary}: start refuses a non-digest pin and an absent image`, async t => {
    const { runtime, envOf, calls, clearCalls } = setUp(t, binary, {
      images: [],
    });
    const notDigest = {
      ...envOf('e1'),
      settings: { runtime: binary, allowedCommands: [], image: 'dev:latest' },
    };
    await t.throwsAsync(runtime.start(notDigest), {
      message: environmentTexts.imageRefused,
    });
    t.deepEqual(calls(), [], 'nothing reaches the CLI');
    clearCalls();
    await t.throwsAsync(runtime.start(envOf('e2')), {
      message: environmentTexts.imageRefused,
    });
    t.is(calls().length, 1);
  });

  test(`${binary}: start is idempotent and a stopped environment starts fresh`, async t => {
    const { runtime, envOf, calls, clearCalls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    clearCalls();
    // Already running: the name is in use, the container is kept.
    await runtime.start(env);
    t.deepEqual(
      calls().map(argv => argv[0]),
      ['run', 'inspect'],
    );
    await runtime.stop(env);
    clearCalls();
    await runtime.start(env);
    t.deepEqual(
      calls().map(argv => argv[0]),
      ['run'],
    );
  });

  test(`${binary}: exec runs argv uninterpreted with A.3's environment only`, async t => {
    const { runtime, envOf, calls, clearCalls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    clearCalls();
    const argv = [
      'sh',
      '-c',
      'printf "%s|" "$@"; exit 3',
      'sh',
      'a b',
      '$HOME',
      ';rm',
    ];
    const result = await runtime.exec(env, argv, execOptions);
    t.is(decode(result.stdout), 'a b|$HOME|;rm|');
    t.is(result.exitCode, 3, 'a non-zero exit is data');
    t.is(result.signal, null);
    t.false(result.timedOut);
    t.false(result.stdoutCut);
    t.true(result.ms >= 0);
    const [execArgv] = calls();
    t.deepEqual(execArgv.slice(0, 9), [
      'exec',
      env.name,
      'sh',
      '-c',
      'setsid "$@" & wait "$!"',
      'sh',
      'sh',
      '-c',
      'echo $$ > "$0"; "$@"; s=$?; rm -f "$0"; exit $s',
    ]);
    t.regex(execArgv[9], /^\/tmp\/thix-c[0-9]+\.pid$/);
    t.deepEqual(execArgv.slice(10), ['env', '-i', ...a3Env, ...argv]);

    const envResult = await runtime.exec(env, ['env'], execOptions);
    t.deepEqual(
      envLines(envResult.stdout),
      [...a3Env].sort(),
      'no host variable, no credential (R3-45)',
    );
  });

  test(`${binary}: each stream is kept to streamBytes and drained`, async t => {
    const { runtime, envOf } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    const result = await runtime.exec(
      env,
      ['sh', '-c', 'head -c 300000 /dev/zero; head -c 10 /dev/zero >&2'],
      { ...execOptions, streamBytes: 65_536 },
    );
    t.is(result.stdout.length, 65_536);
    t.true(result.stdoutCut);
    t.is(result.stderr.length, 10);
    t.false(result.stderrCut);
    t.is(result.exitCode, 0);
  });

  test(`${binary}: a timeout kills the command's process group only`, async t => {
    const { runtime, envOf, calls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    const bgFile = join(env.workspace, 'bg.pid');
    const other = runtime.exec(
      env,
      ['sh', '-c', 'sleep 1; echo done'],
      execOptions,
    );
    const started = Date.now();
    const result = await runtime.exec(
      env,
      ['sh', '-c', `sleep 30 & echo $! > ${JSON.stringify(bgFile)}; wait`],
      { ...execOptions, timeoutMs: 300 },
    );
    const took = Date.now() - started;
    t.true(result.timedOut);
    t.is(result.exitCode, null);
    t.is(result.signal, 'SIGTERM');
    t.true(took < 1500, `ended ${took} ms after the start`);
    const bg = Number(readFileSync(bgFile, 'utf8'));
    await delay(100);
    t.throws(() => processKill(bg, 0), undefined, 'the background child died');
    const otherResult = await other;
    t.is(decode(otherResult.stdout), 'done\n', 'the other command ran on');
    t.is(otherResult.exitCode, 0);
    const signals = calls().filter(
      argv => argv[0] === 'exec' && argv[5]?.startsWith('/tmp/thix-c'),
    );
    t.is(signals.length, 1);
    t.is(signals[0].at(-1), 'TERM');
  });

  test(`${binary}: a command trapping SIGTERM is killed after the grace`, async t => {
    const { runtime, envOf, calls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    const started = Date.now();
    const result = await runtime.exec(
      env,
      ['sh', '-c', 'trap "" TERM; sleep 30 & wait; sleep 30'],
      { ...execOptions, timeoutMs: 200, killGraceMs: 500 },
    );
    const took = Date.now() - started;
    t.true(result.timedOut);
    t.is(result.signal, 'SIGKILL');
    t.true(took >= 650 && took < 2500, `ended ${took} ms after the start`);
    t.deepEqual(
      calls()
        .filter(
          argv => argv[0] === 'exec' && argv[5]?.startsWith('/tmp/thix-c'),
        )
        .map(argv => argv.at(-1)),
      ['TERM', 'KILL'],
    );
  });

  test(`${binary}: exec into a gone or stopped container is a runtime failure`, async t => {
    const { runtime, envOf, engine } = setUp(t, binary);
    const gone = envOf('e1');
    await t.throwsAsync(runtime.exec(gone, ['true'], execOptions), {
      message: environmentTextOf.runtimeFailed('the container is not running'),
    });
    const stopped = envOf('e2');
    await runtime.start(stopped);
    const message = 'Error response from daemon: container is not running';
    const ownFailure = await runtime.exec(
      stopped,
      ['sh', '-c', 'echo "$1" >&2; exit 1', 'sh', message],
      execOptions,
    );
    t.is(ownFailure.exitCode, 1);
    t.is(decode(ownFailure.stderr).trim(), message);
    const file = join(engine, 'containers', `${stopped.name}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, running: false }));
    await t.throwsAsync(runtime.exec(stopped, ['true'], execOptions), {
      message: environmentTextOf.runtimeFailed('the container is not running'),
    });
  });

  test(`${binary}: stop kills running commands, keeps the directories, and is idempotent`, async t => {
    const { runtime, envOf, calls, clearCalls } = setUp(t, binary);
    const env = envOf('e1');
    await runtime.start(env);
    writeFileSync(join(env.home, 'kept'), 'x');
    const running = runtime.exec(env, ['sleep', '30'], execOptions);
    await delay(300);
    clearCalls();
    const started = Date.now();
    await runtime.stop(env);
    const result = await running;
    t.true(Date.now() - started < 2000);
    t.not(result.exitCode, 0);
    t.deepEqual(calls(), [
      binary === 'podman'
        ? ['rm', '--force', '--time', '0', '--ignore', env.name]
        : ['rm', '--force', env.name],
    ]);
    t.true(existsSync(join(env.home, 'kept')), 'home stays (R4-7)');
    await runtime.stop(env);
    await runtime.remove(env);
    await t.throwsAsync(runtime.exec(env, ['true'], execOptions));
  });

  test(`${binary}: sweep removes every container of this state only`, async t => {
    const { runtime, envOf, calls, clearCalls } = setUp(t, binary);
    const mine = ['e1', 'e2', 'e3'].map(key => envOf(key));
    const otherState = envOf('e9', 'fedcba9876543210');
    for (const env of [...mine, otherState]) {
      // eslint-disable-next-line no-await-in-loop -- in order
      await runtime.start(env);
    }
    const running = runtime.exec(mine[0], ['sleep', '30'], execOptions);
    await delay(300);
    clearCalls();
    t.deepEqual(await runtime.sweep(tag), { stopped: 3 });
    await running;
    const [listing, removal] = calls();
    t.deepEqual(listing, [
      'ps',
      '--all',
      '--filter',
      `label=thix.state=${tag}`,
      '--format',
      '{{.Names}}',
    ]);
    t.deepEqual(removal.slice(-3).sort(), mine.map(env => env.name).sort());
    t.deepEqual(await runtime.sweep(tag), { stopped: 0 });
    // The other state's container is untouched.
    const kept = await runtime.exec(otherState, ['true'], execOptions);
    t.is(kept.exitCode, 0);
    await t.throwsAsync(runtime.sweep('bad tag'));
  });

  test(`${binary}: CLI messages never reach a caller (no host path)`, async t => {
    const { runtime, envOf, engine } = setUp(t, binary);
    const env = envOf('e1');
    writeFileSync(
      join(engine, 'script.json'),
      JSON.stringify([
        {
          when: ['run'],
          exitCode: 125,
          stderr: `Error: statfs ${env.workspace}: permission denied\n`,
        },
      ]),
    );
    const error = await t.throwsAsync(runtime.start(env));
    t.is(
      error?.message,
      environmentTextOf.runtimeFailed(`${binary} run failed (exit 125)`),
    );
    t.false(error?.message.includes(env.workspace));

    // A state path the `-v` syntax would misread is refused, not escaped.
    const colon = { ...envOf('e2'), workspace: '/state:x/workspace' };
    await t.throwsAsync(runtime.start(colon), {
      message: environmentTextOf.runtimeFailed(
        'the state directory cannot be mounted',
      ),
    });
    await t.throwsAsync(runtime.start({ ...envOf('e3'), name: '-x' }), {
      message: environmentTextOf.runtimeFailed('invalid container name'),
    });

    writeFileSync(join(engine, 'script.json'), '[]');
    writeFileSync(join(engine, 'down'), '');
    await t.throwsAsync(runtime.start(envOf('e4')), {
      message: environmentTextOf.runtimeFailed(
        `the ${binary} engine is not reachable`,
      ),
    });
  });
}

test('a bound Docker adapter reports a later outage to status and both shell paths, then recovers', async t => {
  const { runtime, root, engine } = setUp(t, 'docker');
  const impl = makeEnvironmentsImpl({
    incarnation: 'i1',
    stateDir: root,
    runtimes: { docker: () => runtime },
  });
  /** @type {any} */
  let ops;
  const sink = Far('Sink', {
    attach: (/** @type {any} */ facet) => {
      ops = facet;
      return harden({ withdrawn: [], stops: [], releases: [] });
    },
  });
  await impl.bind('environments', {
    sink,
    settings: { runtime: 'docker', image: pin, allowedCommands: ['true'] },
  });
  t.is((await E(ops).status()).state, 'ready');
  const run = () => E(ops).runCommand('e1', 'true', harden([]), harden({}));
  t.is((await run()).exitCode, 0);
  const port = await E(ops).port('e2');
  const command = harden({
    opId: 'op1',
    args: '{"command":"true","args":[]}',
    writers: Far('Writers', {}),
  });
  const offline = environmentTextOf.runtimeFailed(
    'the docker engine is not reachable',
  );
  writeFileSync(join(engine, 'down'), '');
  t.deepEqual(await E(port).runCommand(command), {
    status: 'failed',
    text: offline,
  });
  await t.throwsAsync(run(), { message: offline });
  t.like(await E(ops).status(), { state: 'refused', error: offline });
  rmSync(join(engine, 'down'));
  t.is((await run()).exitCode, 0);
  t.is((await E(port).runCommand(command)).status, 'ok');
  t.is((await E(ops).status()).state, 'ready');
  await impl.unbind({}, 'environments');
});

test('checkImagePin leaves the fake runtime its own check', async t => {
  const seen = [];
  const runtime = harden({
    kind: /** @type {const} */ ('fake'),
    check: async (/** @type {any} */ settings) => {
      seen.push(settings.image);
      return harden({ ok: /** @type {const} */ (true) });
    },
  });
  t.deepEqual(await checkImagePin({ runtime, image: undefined }), { ok: true });
  t.deepEqual(seen, [undefined]);
});

for (const binary of /** @type {const} */ (['podman', 'docker'])) {
  test(`${binary}: a run refused for undelegated cgroup controllers says so, with no CLI text`, async t => {
    const { runtime, envOf, engine } = setUp(t, binary);
    for (const stderr of [
      'Error: OCI runtime error: crun: the requested cgroup controller `pids` is not available\n',
      'Error: OCI runtime error: crun: opening file `memory.max` for writing: No such file or directory\n',
    ]) {
      writeFileSync(
        join(engine, 'script.json'),
        JSON.stringify([{ when: ['run'], exitCode: 126, stderr }]),
      );
      // eslint-disable-next-line no-await-in-loop -- in order
      await t.throwsAsync(runtime.start(envOf('e1')), {
        message: environmentTextOf.runtimeFailed(
          `the ${binary} engine cannot apply the memory, CPU or process limits (cgroup controllers not delegated)`,
        ),
      });
    }
  });
}

/**
 * A CLI whose `run` answers after `runMs` and every other call at once,
 * recording which calls were killed.
 * @param {number} runMs
 */
const slowRunExec = runMs => {
  /** @type {string[]} */
  const killed = [];
  /** @type {import('../../resources/environments/impl/runtime-oci.js').CliExec} */
  const exec = args => {
    /** @type {(value: any) => void} */
    let settle = () => {};
    const done = new Promise(resolve => {
      settle = resolve;
    });
    const ok = harden({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      stdoutCut: false,
      stderrCut: false,
      exitCode: 0,
      signal: null,
    });
    const timer = setTimeout(() => settle(ok), args[0] === 'run' ? runMs : 0);
    return harden({
      done: /** @type {Promise<any>} */ (done),
      kill: () => {
        clearTimeout(timer);
        killed.push(args[0]);
        settle({ ...ok, exitCode: null, signal: 'SIGKILL' });
      },
    });
  };
  return { exec, killed };
};

test('podman: the first run of an image gets the start bound, not the control bound (keep-id layer copy)', async t => {
  const { envOf } = setUp(t, 'podman');
  const slow = slowRunExec(150);
  const podman = makeOciRuntime({
    binary: 'podman',
    exec: slow.exec,
    controlTimeoutMs: 50,
    startTimeoutMs: 1000,
  });
  await podman.start(envOf('e1'));
  t.deepEqual(slow.killed, []);
  // Without its own bound, podman's start still outlasts the control bound.
  const defaults = slowRunExec(150);
  await makeOciRuntime({
    binary: 'podman',
    exec: defaults.exec,
    controlTimeoutMs: 50,
  }).start(envOf('e2'));
  t.deepEqual(defaults.killed, []);
  // Docker's run keeps the control bound.
  const docker = slowRunExec(150);
  await t.throwsAsync(
    makeOciRuntime({
      binary: 'docker',
      exec: docker.exec,
      controlTimeoutMs: 50,
    }).start(envOf('e3')),
    {
      message: environmentTextOf.runtimeFailed(
        'docker run failed (signal SIGKILL)',
      ),
    },
  );
  t.deepEqual(docker.killed, ['run']);
});

test('makeOciRuntime takes podman or docker only', t => {
  t.throws(() => makeOciRuntime({ binary: /** @type {any} */ ('runc') }), {
    message: /podman or docker/,
  });
});

// ---------------------------------------------------------------- [real-runtime]

const realBinary = processEnv.THIX_HARNESS_REAL_RUNTIME;
const realImage = processEnv.THIX_HARNESS_REAL_IMAGE;
const real =
  (realBinary === 'podman' || realBinary === 'docker') && isDigestPin(realImage)
    ? /** @type {'podman' | 'docker'} */ (realBinary)
    : undefined;
const realTest = real === undefined ? test.skip : test.serial;

/** @param {import('ava').ExecutionContext} t */
const realSetUp = t => {
  if (real === undefined) throw Error('unreachable');
  const root = mkdtempSync(join(tmpdir(), 'env-oci-real-'));
  const realTag = `t${Date.now().toString(16)}`;
  const runtime = makeOciRuntime({ binary: real });
  /** @param {string} key */
  const envOf = key => {
    const dir = join(root, key);
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    return harden({
      key,
      name: `thix-${realTag}-${key}`,
      tag: realTag,
      workspace: join(dir, 'workspace'),
      home: join(dir, 'home'),
      run: join(dir, 'run'),
      settings: harden({
        runtime: real,
        allowedCommands: [],
        image: realImage,
      }),
    });
  };
  t.teardown(async () => {
    await runtime.sweep(realTag);
    rmSync(root, { recursive: true, force: true });
  });
  return { runtime, envOf, realTag };
};

realTest(
  '[real-runtime] exec waits for delayed output and exit status',
  async t => {
    const { runtime, envOf } = realSetUp(t);
    const env = envOf('e1');
    await runtime.start(env);
    const result = await runtime.exec(
      env,
      [
        'sh',
        '-c',
        'printf first; sleep 1; printf last; printf error >&2; exit 37',
      ],
      execOptions,
    );
    t.is(result.exitCode, 37);
    t.is(decode(result.stdout), 'firstlast');
    t.is(decode(result.stderr), 'error');
  },
);

realTest('[real-runtime] an absent digest is refused', async t => {
  const { runtime } = realSetUp(t);
  t.deepEqual(await checkImagePin({ runtime, image: realImage }), { ok: true });
  const repository = String(realImage).slice(0, String(realImage).indexOf('@'));
  t.deepEqual(
    await checkImagePin({ runtime, image: `${repository}@sha256:${hex('0')}` }),
    { ok: false, reason: environmentTexts.imageRefused },
  );
});

realTest('[real-runtime] the container is confined (R3-45, R7-9)', async t => {
  const { runtime, envOf } = realSetUp(t);
  const env = envOf('e1');
  await runtime.start(env);
  const run = async (/** @type {string} */ script) =>
    runtime.exec(env, ['sh', '-c', script], execOptions);
  t.is(decode((await run('id -u; id -g')).stdout), '1000\n1000\n');
  t.regex(
    decode((await run('grep CapEff /proc/self/status')).stdout),
    /CapEff:\s+0+\s*$/,
  );
  t.not((await run('touch /etc/x')).exitCode, 0, 'read-only root');
  t.not((await run('touch /x')).exitCode, 0, 'read-only root');
  t.is((await run('touch /workspace/w /home/node/h /tmp/t')).exitCode, 0);
  // Linux may retain unconfigured tunnel devices in an isolated netns.
  // Check UP interfaces, assigned addresses and routes in the namespace.
  const read = async (/** @type {string} */ script) => {
    const { exitCode, stdout } = await run(script);
    t.is(exitCode, 0, script);
    return decode(stdout).trim();
  };
  t.is(
    await read(
      'for d in /sys/class/net/*; do [ -f "$d/flags" ] || continue; ' +
        'read -r flags < "$d/flags" || exit 1; ' +
        'if [ $((flags & 1)) -ne 0 ]; then basename "$d"; fi; done',
    ),
    'lo',
  );
  // Each host LOCAL entry in the kernel IPv4 trie follows its address.
  const ipv4 = await read(
    `awk '/host LOCAL/ {print addr} {addr=$NF}' /proc/net/fib_trie`,
  );
  t.true(
    ipv4.split('\n').every(address => /^127\./.test(address)),
    ipv4,
  );
  t.is(await read(`awk 'NR > 1 && $1 != "lo"' /proc/net/route`), '');
  // An IPv4-only Linux kernel can omit both IPv6 files.
  t.is(
    await read(
      `if [ -e /proc/net/if_inet6 ]; then awk '$1 != "00000000000000000000000000000001" || $6 != "lo"' /proc/net/if_inet6; fi`,
    ),
    '',
  );
  t.is(
    await read(
      `if [ -e /proc/net/ipv6_route ]; then awk '$NF != "lo"' /proc/net/ipv6_route; fi`,
    ),
    '',
  );
  t.deepEqual(envLines((await run('env')).stdout), [...a3Env].sort());
  t.true(existsSync(join(env.workspace, 'w')), 'the workspace is the mount');
});

realTest(
  '[real-runtime] only a project has private executable scratch',
  async t => {
    const { runtime, envOf } = realSetUp(t);
    const env = envOf('e1');
    await runtime.start(env);
    const outside = await runtime.exec(
      env,
      ['test', '!', '-e', '/tmp/thix'],
      execOptions,
    );
    t.is(outside.exitCode, 0);
    await runtime.stop(env);
    const project = { ...env, project: true };
    await runtime.start(project);
    const checked = await runtime.exec(
      project,
      [
        'sh',
        '-ec',
        'stat -c "%u:%g:%a" /tmp/thix; stat -f -c %T /tmp/thix; ' +
          "printf '#!/bin/sh\\nexit 0\\n' > /tmp/thix/probe; chmod 700 /tmp/thix/probe; /tmp/thix/probe; " +
          'cp /tmp/thix/probe /tmp/probe; ! /tmp/probe',
      ],
      execOptions,
    );
    t.is(checked.exitCode, 0);
    t.is(decode(checked.stdout), '1000:1000:700\ntmpfs\n');
  },
);

realTest('[real-runtime] timeout, stop and sweep', async t => {
  const { runtime, envOf, realTag } = realSetUp(t);
  const env = envOf('e1');
  await runtime.start(env);
  const timed = await runtime.exec(
    env,
    ['sh', '-c', 'trap "" TERM; sleep 30 & wait; sleep 30'],
    { ...execOptions, timeoutMs: 500, killGraceMs: 1000 },
  );
  t.true(timed.timedOut);
  t.is(timed.signal, 'SIGKILL');
  const running = runtime.exec(env, ['sleep', '600'], execOptions);
  await delay(500);
  await runtime.stop(env);
  t.not((await running).exitCode, 0);
  await runtime.start(env);
  await runtime.start(envOf('e2'));
  t.deepEqual(await runtime.sweep(realTag), { stopped: 2 });
});

(real === 'podman' ? test.serial : test.skip)(
  '[real-runtime: podman] keep-id: what a command writes belongs to this user on the host',
  async t => {
    const { runtime, envOf } = realSetUp(t);
    const env = envOf('e1');
    await runtime.start(env);
    const written = await runtime.exec(
      env,
      ['sh', '-c', 'touch /workspace/owned /home/node/owned && id -u'],
      execOptions,
    );
    t.is(written.exitCode, 0);
    t.is(decode(written.stdout), '1000\n');
    for (const file of [
      join(env.workspace, 'owned'),
      join(env.home, 'owned'),
    ]) {
      t.is(statSync(file).uid, getuid?.(), file);
      t.is(statSync(file).gid, getgid?.(), file);
    }
  },
);
