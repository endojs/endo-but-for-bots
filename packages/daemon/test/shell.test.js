// @ts-check
// prefer-endo-primitives-exempt: @endo/bytes has no UTF-8 codec; TextEncoder builds fixture bytes.
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { makeExo } from '@endo/exo';
import { makeShell } from '@endo/exo-shell';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { M } from '@endo/patterns';
import { makeHostSpawner } from '@endo/host-spawner';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { normalizeShellPolicy } from '../src/host.js';
import { getMountBacking, makeMount } from '../src/mount.js';
import {
  makeSandboxShellEngine,
  SANDBOX_SHELL_WORKDIR,
} from '../src/shell-engine.js';

/**
 * Provision a real on-disk mount, mirroring `git.test.js`.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ readOnly?: boolean }} [opts]
 */
const provisionMount = async (t, { readOnly = false } = {}) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shell-test-'));
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  return { root, mount: makeMount({ rootPath: root, readOnly, filePowers }) };
};

/**
 * Assemble a Shell exactly as the daemon `shell` formula maker does: resolve
 * cwd from the mount backing and drive execution through the host spawner with
 * a sanitized base env.  This exercises the maker's composition without booting
 * a full daemon (which needs a native sqlite build unavailable in some CI
 * sandboxes).
 *
 * The read-only refusal is deliberately *not* re-implemented here: the mount's
 * `readOnly` flag is handed straight to `makeShell`, so the read-only test
 * below pins the production guard inside `@endo/exo-shell` (reverting it reddens
 * the test) rather than a copy local to this file.  The daemon's own
 * provideShell / reincarnation-time read-only checks live behind a full daemon
 * boot and are out of this composition test's reach; the exo-layer guard is the
 * one this file can pin.  `killProcessGroup` mirrors the production maker so the
 * timeout escalation reaps a SIGTERM-trapping child and its descendants.
 *
 * @param {object} mount
 * @param {import('@endo/exo-shell').ShellPolicy} policy
 * @param {{ killGraceMs?: number }} [opts]
 */
const makeShellLikeFormulaMaker = (mount, policy, opts = {}) => {
  const backing = getMountBacking(mount);
  if (!backing) throw new Error('not a daemon-minted mount');
  if (backing.kind !== 'physical') throw new Error('not a physical mount');
  const searchPath = policy.searchPath || '';
  const baseEnv = harden({ PATH: searchPath, LC_ALL: 'C' });
  const spawner = makeHostSpawner({
    searchPath,
    defaultEnv: baseEnv,
    killProcessGroup: true,
  });
  return makeShell({
    cwd: backing.currentDir,
    policy: harden({
      allowedCommands: harden([...policy.allowedCommands]),
      timeoutMs: policy.timeoutMs,
      maxOutputBytes: policy.maxOutputBytes,
      env: harden({ ...(policy.env || {}) }),
      engine: policy.engine ?? 'host',
    }),
    spawner,
    readOnly: backing.readOnly,
    ...(opts.killGraceMs !== undefined
      ? { killGraceMs: opts.killGraceMs }
      : {}),
  });
};

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} output
 */
const writeExecutable = async (dir, name, output) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, `#!/bin/sh\nprintf %s '${output}'\n`);
  await fs.promises.chmod(file, 0o755);
};

const basePolicy = normalizeShellPolicy({
  allowedCommands: ['printenv', 'pwd', 'printf'],
  timeoutMs: 10_000,
  maxOutputBytes: 65_536,
  env: { CI: 'true' },
});

test('provideShell composition: exec runs an allowlisted command in the mount cwd', async t => {
  const { root, mount } = await provisionMount(t);
  const shell = makeShellLikeFormulaMaker(mount, basePolicy);

  const pwd = await shell.exec('pwd', []);
  t.is(pwd.exitCode, 0);
  t.is(pwd.stdout.trim(), fs.realpathSync(root));

  const printf = await shell.exec('printf', ['%s', 'hello']);
  t.is(printf.stdout, 'hello');
  t.is(printf.exitCode, 0);
});

test('provideShell composition: a command off the allowlist is refused', async t => {
  const { mount } = await provisionMount(t);
  const shell = makeShellLikeFormulaMaker(mount, basePolicy);
  await t.throwsAsync(() => shell.exec('rm', ['-rf', '.']), {
    message: /not in the allowlist/,
  });
});

test('provideShell composition: the child sees only the policy env, never host env', async t => {
  const { mount } = await provisionMount(t);
  process.env.SHELL_TEST_HOST_SECRET = 'leaked';
  t.teardown(() => {
    delete process.env.SHELL_TEST_HOST_SECRET;
  });
  const shell = makeShellLikeFormulaMaker(
    mount,
    harden({ ...basePolicy, env: { PASSED: 'ok' } }),
  );

  const passed = await shell.exec('printenv', ['PASSED']);
  t.is(passed.stdout.trim(), 'ok');

  const secret = await shell.exec('printenv', ['SHELL_TEST_HOST_SECRET']);
  t.is(secret.stdout.trim(), '');
  t.not(secret.exitCode, 0);
});

test('provideShell composition: a read-only mount is refused (writable-only)', async t => {
  const { mount } = await provisionMount(t, { readOnly: true });
  t.throws(() => makeShellLikeFormulaMaker(mount, basePolicy), {
    message: /read-only mount/,
  });
});

test('provideShell composition: inspect reveals policy bounds but no host path', async t => {
  const { root, mount } = await provisionMount(t);
  const shell = makeShellLikeFormulaMaker(mount, basePolicy);
  const revealed = await shell.inspect();
  t.deepEqual(revealed, {
    allowedCommands: ['printenv', 'pwd', 'printf'],
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
    engine: 'host',
  });
  t.false(
    JSON.stringify(revealed).includes(root),
    'the mount path did not leak',
  );
});

test('provideShell composition: omitted searchPath is baked before reincarnation', async t => {
  const { root, mount } = await provisionMount(t);
  const firstBin = path.join(root, 'first-bin');
  const secondBin = path.join(root, 'second-bin');
  const command = 'shell-path-probe';
  await writeExecutable(firstBin, command, 'first');
  await writeExecutable(secondBin, command, 'second');

  const originalPath = process.env.PATH;
  process.env.PATH = firstBin;
  t.teardown(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });
  const persistedPolicy = normalizeShellPolicy({
    allowedCommands: [command],
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
    env: { CI: 'true' },
  });

  process.env.PATH = secondBin;
  const shell = makeShellLikeFormulaMaker(mount, persistedPolicy);

  const result = await shell.exec(command, []);
  t.is(result.exitCode, 0);
  t.is(result.stdout, 'first');
});

test('provideShell composition: a real child that traps SIGTERM is force-killed at the timeout', async t => {
  // The panel's repro end-to-end against a real host child: a process that
  // installs a SIGTERM handler and never exits.  Without the SIGTERM→SIGKILL
  // escalation (and the process-group kill on the daemon spawner) proc.wait()
  // never settles and exec hangs forever; the timeout must force it down.
  const { mount } = await provisionMount(t);
  const shell = makeShellLikeFormulaMaker(
    mount,
    harden({ ...basePolicy, allowedCommands: ['node'], timeoutMs: 500 }),
    { killGraceMs: 500 },
  );
  const start = Date.now();
  await t.throwsAsync(
    shell.exec('node', [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1e9);',
    ]),
    { message: /timed out/ },
  );
  const elapsedMs = Date.now() - start;
  t.true(
    elapsedMs < 8000,
    `exec settled at the timeout rather than hanging (took ${elapsedMs}ms)`,
  );
});

test('normalizeShellPolicy: engine defaults to host and accepts sandbox', t => {
  const base = {
    allowedCommands: ['echo'],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    searchPath: '/usr/bin',
  };
  t.is(normalizeShellPolicy(base).engine, 'host');
  t.is(normalizeShellPolicy({ ...base, engine: 'sandbox' }).engine, 'sandbox');
  t.throws(() => normalizeShellPolicy({ ...base, engine: 'container' }), {
    message: /policy.engine must be 'host' or 'sandbox'/,
  });
});

/**
 * A stand-in `SandboxFactory` recording what the shell engine asks of it.
 * Its slice records each spawn and answers `ok` on stdout.
 *
 * @param {{ available: boolean }} options
 */
const makeStubSandboxFactory = ({ available }) => {
  /** @type {any[]} */
  const makeCalls = [];
  /** @type {any[]} */
  const spawnCalls = [];
  let disposed = false;
  const passable = name => M.interface(name, {}, { defaultGuards: 'passable' });
  const slice = makeExo('StubSlice', passable('StubSlice'), {
    spawn: async (argv, opts) => {
      spawnCalls.push({ argv, opts });
      const text = new TextEncoder().encode('ok');
      return makeExo('StubProcess', passable('StubProcess'), {
        pid: () => 1,
        stdout: () =>
          bytesReaderFromIterator(
            (async function* produce() {
              yield text;
            })(),
          ),
        stderr: () =>
          bytesReaderFromIterator(
            (async function* produce() {
              yield* [];
            })(),
          ),
        wait: async () => harden({ code: 0, signal: null }),
        kill: async () => {},
      });
    },
    dispose: async () => {
      disposed = true;
    },
  });
  const factory = makeExo('StubSandboxFactory', passable('StubFactory'), {
    listBackends: async () =>
      harden([
        available
          ? { name: 'bwrap', available: true }
          : { name: 'bwrap', available: false, reason: 'bwrap not found' },
      ]),
    make: async options => {
      makeCalls.push(options);
      return slice;
    },
  });
  return { factory, makeCalls, spawnCalls, isDisposed: () => disposed };
};

test('sandbox engine: the slice has no network and binds only the mount at /work', async t => {
  const { mount } = await provisionMount(t);
  const { factory, makeCalls, spawnCalls, isDisposed } = makeStubSandboxFactory(
    { available: true },
  );
  /** @type {(() => Promise<void>)[]} */
  const cancelHooks = [];
  const { cwd, spawner } = await makeSandboxShellEngine({
    factory,
    mount,
    onCancel: hook => cancelHooks.push(hook),
  });
  t.is(cwd, SANDBOX_SHELL_WORKDIR);
  t.is(makeCalls.length, 1);
  const [options] = makeCalls;
  t.is(options.network, 'none');
  t.is(options.seccomp, 'default');
  t.deepEqual(options.rootfs, { kind: 'host-bind' });
  t.is(options.mounts.length, 1);
  t.is(options.mounts[0].cap, mount, 'the shell mount itself is bound');
  t.is(options.mounts[0].innerPath, '/work');
  t.is(options.mounts[0].mode, 'rw');
  t.is(options.cwd, '/work');
  t.false('PATH' in options.env, 'no host search path enters the slice');

  const shell = makeShell({
    cwd,
    policy: harden({
      allowedCommands: ['echo'],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      env: { CI: 'true' },
      engine: 'sandbox',
    }),
    spawner,
  });
  t.is((await shell.inspect()).engine, 'sandbox');
  const result = await shell.exec('echo', ['hi']);
  t.is(result.exitCode, 0);
  t.deepEqual(spawnCalls[0].argv, ['echo', 'hi']);
  t.is(spawnCalls[0].opts.cwd, '/work');
  t.deepEqual(spawnCalls[0].opts.env, { CI: 'true' });

  t.is(cancelHooks.length, 1);
  await cancelHooks[0]();
  t.true(isDisposed(), 'cancelling the incarnation disposes the slice');
});

test('sandbox engine: an unavailable backend fails closed, never falling back to the host', async t => {
  const { mount } = await provisionMount(t);
  const { factory, makeCalls } = makeStubSandboxFactory({ available: false });
  await t.throwsAsync(
    () => makeSandboxShellEngine({ factory, mount, onCancel: () => {} }),
    { message: /no usable sandbox backend.*bwrap not found/ },
  );
  t.is(makeCalls.length, 0, 'no slice was minted');
});
