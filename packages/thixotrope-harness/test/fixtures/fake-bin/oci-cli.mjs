#!/usr/bin/env node
// A fake container CLI for the OCI runtime's tests: `node oci-cli.mjs
// <podman|docker> <args...>`. It records every argv, refuses flags the
// named binary does not have, and plays a small container engine whose
// state lives in a directory (`THIX_FAKE_OCI_DIR`), so `run`, `exec`,
// `inspect`, `rm`, `ps` and the image checks answer as the real CLI does in
// the cases the runtime tells apart (absent image, name in use, missing or
// stopped container, engine unreachable).
//
// `exec` runs argv as a host process in the workspace mount, with the
// container's `--env` variables, a fresh process group for a wrapped
// command, and `/tmp/...` arguments mapped into the fake's own
// per-container directory. It is not a sandbox: tests only.
//
// The state directory:
//   calls.jsonl        one JSON argv per call (appended)
//   images.json        the image references present locally
//   down               when present: the engine is unreachable
//   script.json        [{ when: [argv prefix], exitCode, stdout?, stderr? }]
//   containers/<name>.json, procs/<name>/<pid>, tmp/<name>/
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const [kind, ...args] = process.argv.slice(2);
const dir = process.env.THIX_FAKE_OCI_DIR;
if ((kind !== 'podman' && kind !== 'docker') || dir === undefined) {
  process.stderr.write('usage: THIX_FAKE_OCI_DIR=<dir> oci-cli.mjs <podman|docker> ...\n');
  process.exit(2);
}
const podman = kind === 'podman';
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);

/**
 * @param {string} text
 * @param {number} code
 * @returns {never}
 */
const fail = (text, code) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

if (existsSync(join(dir, 'down'))) {
  if (podman) fail('Error: unable to connect to Podman socket: connection refused', 125);
  fail(
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    1,
  );
}

for (const entry of readJson(join(dir, 'script.json'), [])) {
  if (entry.when.every((word, i) => args[i] === word)) {
    if (entry.stdout) process.stdout.write(entry.stdout);
    if (entry.stderr) process.stderr.write(entry.stderr);
    process.exit(entry.exitCode);
  }
}

const containerFile = name => join(dir, 'containers', `${name}.json`);
const containerOf = name => readJson(containerFile(name), undefined);
const procsOf = name => join(dir, 'procs', name);

// Flags each binary's subcommand takes: the ones with a value, the others.
const runFlags = {
  valued: new Set([
    '--pull',
    '--name',
    '--label',
    '--user',
    '--cap-drop',
    '--tmpfs',
    '--security-opt',
    '--network',
    '--pids-limit',
    '--memory',
    '--cpus',
    '--log-driver',
    '--volume',
    '--workdir',
    '--env',
    ...(podman ? ['--userns'] : []),
  ]),
  bare: new Set(['--detach', '--read-only']),
};
const rmFlags = {
  valued: new Set(podman ? ['--time'] : []),
  bare: new Set(['--force', ...(podman ? ['--ignore'] : [])]),
};

/**
 * @param {string[]} words
 * @param {{ valued: Set<string>, bare: Set<string> }} flags
 * @returns {{ options: [string, string][], rest: string[] }}
 */
const parse = (words, flags) => {
  /** @type {[string, string][]} */
  const options = [];
  let at = 0;
  while (at < words.length && words[at].startsWith('-')) {
    const flag = words[at];
    const equals = flag.indexOf('=');
    if (equals > 0 && flags.valued.has(flag.slice(0, equals))) {
      options.push([flag.slice(0, equals), flag.slice(equals + 1)]);
      at += 1;
    } else if (flags.valued.has(flag)) {
      options.push([flag, words[at + 1]]);
      at += 2;
    } else if (flags.bare.has(flag)) {
      options.push([flag, '']);
      at += 1;
    } else {
      fail(`Error: unknown flag: ${flag}`, 125);
    }
  }
  return { options, rest: words.slice(at) };
};

const images = () => readJson(join(dir, 'images.json'), []);

const missingContainer = name =>
  podman
    ? fail(`Error: no container with name or ID "${name}" found: no such container`, 125)
    : fail(`Error response from daemon: No such container: ${name}`, 1);

/**
 * Kill every exec process group of a container.
 * @param {string} name
 */
const killProcs = name => {
  let pids = [];
  try {
    pids = readdirSync(procsOf(name));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(-Number(pid), 'SIGKILL');
    } catch {
      // gone
    }
    rmSync(join(procsOf(name), pid), { force: true });
  }
};

const [command, ...rest] = args;
const sub = `${command} ${rest[0] ?? ''}`;

if (sub === 'image exists' && podman) {
  process.exit(images().includes(rest[1]) ? 0 : 1);
} else if (sub === 'image inspect' && !podman) {
  const ref = rest.at(-1);
  if (!images().includes(ref)) fail(`Error: No such image: ${ref}`, 1);
  process.stdout.write('sha256:0123\n');
  process.exit(0);
} else if (command === 'run') {
  const { options, rest: tail } = parse(rest, runFlags);
  const [image] = tail;
  const value = flag => options.find(([f]) => f === flag)?.[1];
  const name = value('--name') ?? fail('Error: a name is required', 125);
  if (!images().includes(image)) {
    if (podman) fail(`Error: ${image}: image not known`, 125);
    fail(`docker: Error response from daemon: No such image: ${image}.`, 125);
  }
  if (containerOf(name) !== undefined) {
    fail(
      podman
        ? `Error: creating container storage: the container name "${name}" is already in use by 0123. You have to remove that container to be able to reuse that name: that name is already in use`
        : `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "0123".`,
      125,
    );
  }
  const all = flag => options.filter(([f]) => f === flag).map(([, v]) => v);
  const mounts = Object.fromEntries(
    all('--volume').map(spec => {
      const [source, target] = spec.split(':');
      return [target, source];
    }),
  );
  const labels = Object.fromEntries(
    all('--label').map(label => label.split('=')),
  );
  const env = Object.fromEntries(
    all('--env').map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );
  mkdirSync(join(dir, 'containers'), { recursive: true });
  mkdirSync(join(dir, 'tmp', name), { recursive: true });
  writeFileSync(
    containerFile(name),
    JSON.stringify({ name, image, labels, mounts, env, running: true }),
  );
  process.stdout.write('0123\n');
  process.exit(0);
} else if (command === 'inspect') {
  const container = containerOf(rest.at(-1));
  if (container === undefined) fail('Error: No such object', podman ? 125 : 1);
  process.stdout.write(`${container.running}\n`);
  process.exit(0);
} else if (command === 'exec') {
  const [name, ...argv] = rest;
  const container = containerOf(name);
  if (container === undefined) missingContainer(name);
  if (!container.running) {
    if (podman) {
      fail('Error: can only create exec sessions on running containers: container state improper', 125);
    }
    fail(`Error response from daemon: container ${name} is not running`, 1);
  }
  const detached =
    argv[0] === 'sh' &&
    argv[1] === '-c' &&
    argv[2] === 'setsid "$@" & wait "$!"';
  const words = (detached ? argv.slice(4) : argv).map(word =>
    word.startsWith('/tmp/') ? join(dir, 'tmp', name, word.slice(5)) : word,
  );
  const child = spawn(words[0], words.slice(1), {
    cwd: container.mounts['/workspace'],
    env: container.env,
    detached,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  mkdirSync(procsOf(name), { recursive: true });
  const record = join(procsOf(name), String(child.pid));
  writeFileSync(record, '');
  child.on('error', () => process.exit(127));
  child.on('exit', (code, signal) => {
    try {
      unlinkSync(record);
    } catch {
      // removed by rm
    }
    const signals = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 };
    process.exit(code ?? 128 + (signals[signal] ?? 1));
  });
} else if (command === 'rm') {
  const { options, rest: names } = parse(rest, rmFlags);
  const ignore = options.some(([f]) => f === '--ignore');
  let missing = false;
  for (const name of names) {
    if (containerOf(name) === undefined) {
      if (!ignore) {
        process.stderr.write(
          podman
            ? `Error: no container with name or ID "${name}" found: no such container\n`
            : `Error response from daemon: No such container: ${name}\n`,
        );
        missing = true;
      }
    } else {
      killProcs(name);
      rmSync(containerFile(name), { force: true });
      rmSync(join(dir, 'tmp', name), { recursive: true, force: true });
      process.stdout.write(`${name}\n`);
    }
  }
  process.exit(missing ? 1 : 0);
} else if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const [, label, value] = /^label=([^=]+)=(.*)$/.exec(filter) ?? [];
  let names = [];
  try {
    names = readdirSync(join(dir, 'containers')).map(file => file.replace(/\.json$/, ''));
  } catch {
    // none yet
  }
  for (const name of names) {
    if (containerOf(name)?.labels?.[label] === value) process.stdout.write(`${name}\n`);
  }
  process.exit(0);
} else {
  fail(`Error: unknown command "${command}" for "${kind}"`, 125);
}
