// @ts-check
/**
 * The OCI runtimes of the environments adapter, `podman` and `docker`
 * (contract `designs/m6-interfaces.md` D-M6-8, 5.3, 5.4): one module, the
 * binary and a few flags differ. Each session's environment is one
 * container, `thix-<tag>-<key>`, labelled `thix.state=<tag>` so a later
 * incarnation of the same state finds and removes every container it owns.
 *
 * The container (R3-45, R7-9, W-12): uid and gid 1000, every capability
 * dropped, a read-only root with a tmpfs `/tmp`, no new privileges, no
 * network, process, memory and CPU limits, no log driver, `/workspace` and
 * `/home/node` the session's directories, and exactly A.3's environment
 * variables. The image is a digest pin and is never pulled (`--pull never`;
 * R8-41). Podman maps the container's uid 1000 to the daemon's user
 * (`--userns keep-id:uid=1000,gid=1000`), so the files a command writes
 * belong to the daemon's user on the host (`[real-runtime: podman]`).
 *
 * A waiting shell launches `setsid sh -c <wrapper> <pidfile> <argv...>`:
 * the wrapper records its pid (the new group's id) in the container's
 * `/tmp`, runs argv without any shell interpolation of it, and removes the
 * record when argv ends. A timeout sends SIGTERM to that group inside the
 * container, SIGKILL after `killGraceMs`; other commands keep running.
 *
 * What crosses back: bytes of the command's own streams, and fixed texts.
 * The runtime CLI's own messages may name host paths (mount sources), so
 * they are classified here and never passed on (D-M6-14).
 *
 * State: a counter for pid-record names. Node only (adapter).
 */
import { Buffer } from 'node:buffer';
import { spawn as spawnChild } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { env as processEnv } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentLimits,
  environmentTextOf,
  environmentTexts,
} from '../../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import { isDigestPin } from './images.js';
import { fakeCommandEnv } from './runtime-fake.js';

/** @import { Runtime, RuntimeEnv, RawResult } from './runtime-fake.js' */

/**
 * @typedef {object} CliResult one finished runtime CLI process
 * @property {Uint8Array} stdout the first `streamBytes` bytes
 * @property {Uint8Array} stderr the first `streamBytes` bytes
 * @property {boolean} stdoutCut
 * @property {boolean} stderrCut
 * @property {number | null} exitCode
 * @property {string | null} signal the local CLI process's signal
 */

/**
 * @typedef {(args: string[], options: { streamBytes: number }) =>
 *   { done: Promise<CliResult>, kill: () => void }} CliExec starts one
 *   runtime CLI process; `done` rejects with an error whose `code` is the
 *   spawn failure (`ENOENT`) when the binary cannot be run
 */

/** The container's home and the image-side `PATH` (A.3). */
const containerHome = '/home/node';
const containerHostPath = '/usr/local/bin:/usr/bin:/bin';

/** A.3's variables as the container sees them (R3-45: nothing else). */
const commandEnvironment = harden(
  Object.entries(fakeCommandEnv(containerHome, containerHostPath)).map(
    ([name, value]) => `${name}=${value}`,
  ),
);

/**
 * Host variables the runtime CLI itself may need to reach its engine
 * (rootless podman's runtime directory, a docker context). They configure
 * the CLI process only; commands receive the entries of `commandEnvironment`.
 */
const cliEnvNames = harden([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CONTAINER_HOST',
  'CONTAINERS_CONF',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
]);

/** Output kept from a control call (`run`, `ps`, `image exists`, ...). */
const controlBytes = 65_536;
/** The longest a control call may take before its CLI process is killed. */
const defaultControlTimeoutMs = 120_000;
/** Names one `rm` of a sweep removes at once. */
const sweepBatch = 32;
/** The largest delay a Node timer takes. */
const maxTimerMs = environmentLimits.maxCommandTimeoutMs;

/**
 * Runs argv in a new process group and records the group's id in `$0`
 * (the container's `/tmp`), removing the record when argv ends. argv is
 * passed as positional parameters: no shell ever parses it.
 */
const commandWrapper = 'echo $$ > "$0"; "$@"; s=$?; rm -f "$0"; exit $s';
/** Signals the group recorded in `$0` with `$1` (`TERM` or `KILL`). */
const groupSignaller =
  'read p < "$0" 2>/dev/null && kill -"$1" -"$p" 2>/dev/null; [ "$1" = KILL ] && rm -f "$0"; exit 0';

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The CLI's messages for an engine it cannot reach. */
const unreachablePattern =
  /cannot connect|unable to connect|is the docker daemon running|connection refused/i;
/** The CLI's messages for an image absent locally under `--pull never`. */
const imageMissingPattern =
  /unable to find image|image not known|no such image|failed to resolve image/i;
const nameInUsePattern = /already in use/i;
const noContainerPattern = /no such container|no container with/i;
/** `exec` into a container that is gone or stopped (the CLI's own error). */
const containerGonePattern =
  /^error(?: response from daemon)?:.*(?:no such container|no container with|is not running|container state improper)/im;

/** Host environment for the runtime CLI process. */
const cliEnvironment = () => {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of cliEnvNames) {
    const value = processEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return harden(env);
};

/**
 * Keeps the first `limit` bytes of a stream and drops the rest.
 * @param {number} limit
 */
const keepFirst = limit => {
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  let cut = false;
  return {
    /** @param {Uint8Array} chunk */
    add: chunk => {
      const room = limit - size;
      if (chunk.length > room) cut = true;
      if (room <= 0) return;
      const piece = chunk.subarray(0, room);
      parts.push(piece);
      size += piece.length;
    },
    bytes: () => new Uint8Array(Buffer.concat(parts, size)),
    cut: () => cut,
  };
};

/**
 * The default `CliExec`: spawns `file` (the runtime binary on `PATH`, or a
 * test's fake) with `prefix` before the runtime arguments.
 * @param {object} options
 * @param {string} options.file
 * @param {string[]} [options.prefix]
 * @param {Record<string, string>} [options.env] the CLI's environment
 *   (default: the host variables of `cliEnvNames`)
 * @param {typeof spawnChild} [options.spawn]
 * @returns {CliExec}
 */
export const makeCliExec = ({
  file,
  prefix = [],
  env = cliEnvironment(),
  spawn = spawnChild,
}) =>
  harden((args, { streamBytes }) => {
    const child = spawn(file, [...prefix, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = keepFirst(streamBytes);
    const err = keepFirst(streamBytes);
    child.stdout?.on('data', out.add);
    child.stderr?.on('data', err.add);
    /** @type {Promise<CliResult>} */
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode, signal) =>
        resolve(
          harden({
            stdout: out.bytes(),
            stderr: err.bytes(),
            stdoutCut: out.cut(),
            stderrCut: err.cut(),
            exitCode,
            signal,
          }),
        ),
      );
    });
    return harden({ done, kill: () => child.kill('SIGKILL') });
  });
harden(makeCliExec);

const decoder = new TextDecoder();
/** @param {Uint8Array} bytes */
const textOf = bytes => decoder.decode(bytes);

/**
 * @param {string} path a host directory the container mounts
 * @returns {string}
 */
const mountable = path => {
  // `-v source:target:mode` splits on `:`; the state directory is the
  // operator's, so a path the CLI would misread is refused, never escaped.
  if (!path.startsWith('/') || /[:,\n\0]/.test(path)) {
    throw Error(
      environmentTextOf.runtimeFailed('the state directory cannot be mounted'),
    );
  }
  return path;
};

/** @param {string} name */
const checkedName = name => {
  if (!namePattern.test(name)) {
    throw Error(environmentTextOf.runtimeFailed('invalid container name'));
  }
  return name;
};

/**
 * @param {object} options
 * @param {'podman' | 'docker'} options.binary
 * @param {CliExec} [options.exec] starts one CLI process (default: spawn
 *   `binary` from `PATH`)
 * @param {number} [options.controlTimeoutMs] the bound of one control call
 * @returns {Runtime}
 */
export const makeOciRuntime = ({
  binary,
  exec = makeCliExec({ file: binary }),
  controlTimeoutMs = defaultControlTimeoutMs,
}) => {
  if (binary !== 'podman' && binary !== 'docker') {
    throw TypeError('makeOciRuntime: binary must be podman or docker');
  }
  const podman = binary === 'podman';
  let commands = 0;

  /**
   * The CLI could not be run at all; only the spawn's code is told (its
   * message names the binary's path), and no cause is kept for the same
   * reason.
   * @param {unknown} error
   */
  const spawnFailure = error =>
    Error(
      environmentTextOf.runtimeFailed(
        /** @type {any} */ (error)?.code === 'ENOENT'
          ? `${binary} is not installed`
          : `${binary} could not be started`,
      ),
    );

  /**
   * One control call, bounded in output and time.
   * @param {string[]} args
   * @returns {Promise<CliResult>}
   */
  const control = async args => {
    const call = exec(args, { streamBytes: controlBytes });
    const timer = setTimeout(call.kill, controlTimeoutMs);
    try {
      return await call.done;
    } catch (error) {
      throw spawnFailure(error);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The fixed reason for a failed control call: never the CLI's text.
   * @param {string} what
   * @param {CliResult} result
   */
  const failure = (what, result) => {
    const stderr = textOf(result.stderr);
    if (unreachablePattern.test(stderr)) {
      return Error(
        environmentTextOf.runtimeFailed(
          `the ${binary} engine is not reachable`,
        ),
      );
    }
    const how =
      result.exitCode === null
        ? `signal ${result.signal}`
        : `exit ${result.exitCode}`;
    return Error(
      environmentTextOf.runtimeFailed(`${binary} ${what} failed (${how})`),
    );
  };

  /**
   * Podman waits `--time` seconds for PID 1 (which ignores SIGTERM) and
   * fails on a missing name without `--ignore`; docker's `--force` kills.
   * @param {string[]} names
   */
  const removeNames = async names => {
    const flags = podman ? ['--force', '--time', '0', '--ignore'] : ['--force'];
    const result = await control(['rm', ...flags, ...names]);
    if (
      result.exitCode !== 0 &&
      !noContainerPattern.test(textOf(result.stderr))
    ) {
      throw failure('rm', result);
    }
  };

  /** @param {RuntimeEnv} env */
  const runArgs = env => {
    const settings = env.settings ?? {};
    const L = environmentLimits;
    if (!isDigestPin(settings.image))
      throw Error(environmentTexts.imageRefused);
    if (!tagPattern.test(env.tag)) {
      throw Error(environmentTextOf.runtimeFailed('invalid state tag'));
    }
    return [
      'run',
      '--detach',
      '--pull',
      'never',
      '--name',
      checkedName(env.name),
      '--label',
      `thix.state=${env.tag}`,
      '--user',
      '1000:1000',
      ...(podman ? ['--userns', 'keep-id:uid=1000,gid=1000'] : []),
      '--cap-drop',
      'ALL',
      '--read-only',
      '--tmpfs',
      '/tmp',
      // A nested supervisor needs private Unix sockets and executes a staged
      // worker from its state. Desktop bind mounts cannot chmod a Unix socket.
      ...(env.project
        ? [
            '--tmpfs',
            '/tmp/thix:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=512m',
          ]
        : []),
      '--security-opt',
      'no-new-privileges',
      '--network',
      'none',
      '--pids-limit',
      String(settings.pids ?? L.defaultPids),
      '--memory',
      String(settings.memoryBytes ?? L.defaultMemoryBytes),
      '--cpus',
      String(settings.cpus ?? L.defaultCpus),
      '--log-driver',
      'none',
      '--volume',
      `${mountable(env.workspace)}:/workspace:rw`,
      '--volume',
      `${mountable(env.home)}:${containerHome}:rw`,
      '--workdir',
      '/workspace',
      ...commandEnvironment.flatMap(entry => ['--env', entry]),
      settings.image,
      'sleep',
      'infinity',
    ];
  };

  /** @param {string} name */
  const isRunning = async name => {
    const result = await control([
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]);
    return result.exitCode === 0 && textOf(result.stdout).trim() === 'true';
  };

  /** @type {Runtime['start']} */
  const start = async env => {
    const args = runArgs(env);
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- at most two runs, in order
      const result = await control(args);
      if (result.exitCode === 0) return;
      const stderr = textOf(result.stderr);
      if (imageMissingPattern.test(stderr)) {
        throw Error(environmentTexts.imageRefused);
      }
      if (attempt > 0 || !nameInUsePattern.test(stderr)) {
        throw failure('run', result);
      }
      // A container of this name is left from this state (the name holds
      // the state's tag): a running one is the environment, else replace it.
      // eslint-disable-next-line no-await-in-loop -- in order
      if (await isRunning(env.name)) return;
      // eslint-disable-next-line no-await-in-loop -- in order
      await removeNames([env.name]);
    }
  };

  /**
   * @param {string} name
   * @param {string} pidFile
   * @param {'TERM' | 'KILL'} signal
   */
  const signalGroup = (name, pidFile, signal) => {
    control(['exec', name, 'sh', '-c', groupSignaller, pidFile, signal]).catch(
      () => {
        // The command's own end, `stop` or the next sweep settles it.
      },
    );
  };

  /** @type {Runtime['exec']} */
  const execCommand = async (
    env,
    argv,
    { timeoutMs, killGraceMs, streamBytes },
  ) => {
    const name = checkedName(env.name);
    commands += 1;
    const pidFile = `/tmp/thix-c${commands}.pid`;
    const started = performance.now();
    const call = exec(
      // An OCI exec process may already lead a process group. setsid then
      // forks and returns success immediately. Launch it as a child of the
      // noninteractive shell so it can become session leader without forking.
      [
        'exec',
        name,
        'sh',
        '-c',
        'setsid "$@" & wait "$!"',
        'sh',
        'sh',
        '-c',
        commandWrapper,
        pidFile,
        // Image ENV defaults are inherited by OCI exec. A command receives
        // only the environment granted by the harness, even on a custom image.
        'env',
        '-i',
        ...commandEnvironment,
        ...argv,
      ],
      { streamBytes },
    );
    let timedOut = false;
    /** @type {string | null} */
    let sent = null;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    timers.push(
      setTimeout(
        () => {
          timedOut = true;
          sent = 'SIGTERM';
          signalGroup(name, pidFile, 'TERM');
          timers.push(
            setTimeout(() => {
              sent = 'SIGKILL';
              signalGroup(name, pidFile, 'KILL');
              // The group is gone or out of reach: stop waiting on the CLI.
              timers.push(setTimeout(call.kill, killGraceMs));
            }, killGraceMs),
          );
        },
        Math.min(timeoutMs, maxTimerMs),
      ),
    );
    /** @type {CliResult} */
    let result;
    try {
      result = await call.done;
    } catch (error) {
      throw spawnFailure(error);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
    if (
      !timedOut &&
      result.exitCode !== 0 &&
      result.stdout.length === 0 &&
      result.stderr.length < 1024 &&
      containerGonePattern.test(textOf(result.stderr))
    ) {
      throw Error(
        environmentTextOf.runtimeFailed('the container is not running'),
      );
    }
    /** @type {RawResult} */
    const raw = {
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutCut: result.stdoutCut,
      stderrCut: result.stderrCut,
      // A signal inside the container reaches the CLI as exit 128 + n;
      // only the runtime's own timeout kill is reported as a signal.
      exitCode: timedOut ? null : result.exitCode,
      signal: timedOut ? sent : null,
      timedOut,
      ms: performance.now() - started,
    };
    return harden(raw);
  };

  /** @type {Runtime['stop']} */
  const stop = async env => {
    // Every command dies with the container; workspace and home are mounts
    // and stay (R4-7). The next `start` runs a fresh container.
    await removeNames([checkedName(env.name)]);
  };

  /** @type {Runtime['sweep']} */
  const sweep = async tag => {
    if (!tagPattern.test(tag)) {
      throw Error(environmentTextOf.runtimeFailed('invalid state tag'));
    }
    let stopped = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- one listing at a time
      const listed = await control([
        'ps',
        '--all',
        '--filter',
        `label=thix.state=${tag}`,
        '--format',
        '{{.Names}}',
      ]);
      if (listed.exitCode !== 0) throw failure('ps', listed);
      const lines = textOf(listed.stdout).split('\n');
      // A listing cut by `controlBytes` may end in a partial name.
      if (listed.stdoutCut) lines.pop();
      const names = lines
        .map(line => line.trim())
        .filter(n => namePattern.test(n));
      if (names.length === 0) return harden({ stopped });
      for (let at = 0; at < names.length; at += sweepBatch) {
        // eslint-disable-next-line no-await-in-loop -- one batch at a time
        await removeNames(names.slice(at, at + sweepBatch));
      }
      stopped += names.length;
      if (!listed.stdoutCut) return harden({ stopped });
    }
  };

  /** @type {Runtime['check']} */
  const check = async settings => {
    const image = settings?.image;
    if (!isDigestPin(image)) {
      return harden({ ok: false, reason: environmentTexts.imageRefused });
    }
    const result = await control(
      podman
        ? ['image', 'exists', image]
        : ['image', 'inspect', '--format', '{{.Id}}', image],
    ).catch(error => error);
    if (result instanceof Error) {
      return harden({ ok: false, reason: result.message });
    }
    if (result.exitCode === 0) return harden({ ok: true });
    const stderr = textOf(result.stderr);
    if (
      (podman && result.exitCode === 1) ||
      (!podman &&
        !unreachablePattern.test(stderr) &&
        imageMissingPattern.test(stderr))
    ) {
      return harden({ ok: false, reason: environmentTexts.imageRefused });
    }
    return harden({
      ok: false,
      reason: failure('image check', result).message,
    });
  };

  return harden({
    kind: binary,
    check,
    start,
    exec: execCommand,
    stop,
    remove: stop,
    sweep,
  });
};
harden(makeOciRuntime);
