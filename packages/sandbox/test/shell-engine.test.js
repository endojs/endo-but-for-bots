// @ts-check

// The `'sandbox'` Shell engine against a real bwrap slice: the daemon's
// slice construction (`makeSandboxShellEngine`), the sandbox spawner, and the
// `@endo/exo-shell` Shell, over a real daemon mount.  Skipped, with the reason
// recorded, where bwrap cannot create a namespace.

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { fc } from '@fast-check/ava';
import { makeShell } from '@endo/exo-shell';
import { engineCases } from '@endo/exo-shell/engine-cases.js';
import { makeHostSpawner } from '@endo/host-spawner';
import { makeFilePowers } from '@endo/daemon/src/manager-node-powers.js';
import { getMountBacking, makeMount } from '@endo/daemon/src/mount.js';
import { makeSandboxShellEngine } from '@endo/daemon/src/shell-engine.js';

import * as nodeFs from 'node:fs';
import * as nodeNet from 'node:net';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { makeBwrapDriver } from '../src/drivers/bwrap.js';
import { makeSandboxFactory } from '../src/factory.js';

const filePowers = makeFilePowers({ fs: nodeFs, path: nodePath });

/**
 * @param {ExecutionContext} t
 * @param {string} prefix
 */
const makeTemporaryDirectory = (t, prefix) => {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), `${prefix}-`),
  );
  t.teardown(() => nodeFs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * Sandbox powers that resolve daemon mounts to their host directories, the
 * way the daemon's `provideHostPath` does.
 *
 * @param {ExecutionContext} t
 */
const makeMountPowers = t =>
  harden({
    /** @param {string} name */
    provideScratchMount: async name =>
      makeMount({
        rootPath: makeTemporaryDirectory(t, `shell-engine-${name}`),
        readOnly: false,
        filePowers,
      }),
    /** @param {any} capability */
    provideHostPath: async capability => {
      const backing = getMountBacking(capability);
      if (backing === undefined) throw Error('not a daemon mount');
      return backing.physicalRoot;
    },
  });

const basePolicy = harden({
  allowedCommands: ['cat', 'mkdir', 'bash', 'echo', 'seq', 'ls', 'sleep'],
  timeoutMs: 20_000,
  maxOutputBytes: 65_536,
});

/**
 * bwrap's diagnostics when the kernel or its policy refuses the namespaces a
 * slice needs.
 */
const namespaceDenial =
  /^bwrap: .*(namespace|uid map|gid map|Operation not permitted|Permission denied)/m;

/**
 * Build a sandboxed Shell over a fresh mount, or record a skip and return
 * `undefined` when this host cannot run a bwrap slice.
 *
 * @param {ExecutionContext} t
 * @param {Partial<{ timeoutMs: number, maxOutputBytes: number }>} [policy]
 */
const makeSandboxedShell = async (t, policy = {}) => {
  const root = makeTemporaryDirectory(t, 'shell-engine-work');
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const factory = makeSandboxFactory({
    drivers: harden([makeBwrapDriver({ env: {} })]),
    scratchProvider: makeMountPowers(t),
  });
  const backends = await E(factory).listBackends();
  if (!backends.some(backend => backend.available)) {
    t.pass(`SKIP: no sandbox backend: ${backends[0]?.reason}`);
    return undefined;
  }
  const { cwd, spawner } = await makeSandboxShellEngine({
    factory: /** @type {any} */ (factory),
    mount,
    context: { onCancel: hook => t.teardown(hook), assertActive: () => {} },
  });
  const shell = makeShell({
    cwd,
    policy: harden({ ...basePolicy, ...policy, engine: 'sandbox' }),
    spawner,
  });
  // A host can ship bwrap yet refuse unprivileged user namespaces; the first
  // spawn is where that shows, as bwrap's own diagnostic on stderr.  Only that
  // denial skips: any other smoke failure is a regression in the engine and
  // fails the test.
  const smoke = await shell.exec('echo', ['ready']);
  if (smoke.exitCode !== 0 && namespaceDenial.test(smoke.stderr)) {
    t.pass(`SKIP: bwrap cannot create a namespace here: ${smoke.stderr}`);
    return undefined;
  }
  // A small cap truncates the smoke output, so only its prefix is checked.
  t.true(
    smoke.exitCode === 0 &&
      smoke.stdout.length > 0 &&
      'ready\n'.startsWith(smoke.stdout),
    `sandbox smoke command failed: ${smoke.stderr}`,
  );
  return { shell, mount, root };
};

/**
 * @param {string} cwd
 * @param {Partial<{ timeoutMs: number, maxOutputBytes: number }>} [policy]
 */
const makeHostShell = (cwd, policy = {}) => {
  const searchPath = process.env.PATH || '/usr/bin:/bin';
  return makeShell({
    cwd,
    policy: harden({ ...basePolicy, ...policy, engine: 'host' }),
    spawner: makeHostSpawner({
      searchPath,
      defaultEnv: { PATH: searchPath, LC_ALL: 'C' },
      killProcessGroup: true,
    }),
  });
};

test.serial(
  'a host path outside the mount is unreadable in the sandbox but readable on the host',
  async t => {
    const outside = makeTemporaryDirectory(t, 'shell-engine-outside');
    const secretPath = nodePath.join(outside, 'secret.txt');
    nodeFs.writeFileSync(secretPath, 'daemon-state-secret');

    const hostResult = await makeHostShell(outside).exec('cat', [secretPath]);
    t.is(hostResult.exitCode, 0, 'the host engine reads it');
    t.is(hostResult.stdout, 'daemon-state-secret');

    const sandboxed = await makeSandboxedShell(t);
    if (sandboxed === undefined) return;
    const result = await sandboxed.shell.exec('cat', [secretPath]);
    t.not(result.exitCode, 0, 'the sandbox engine cannot read it');
    t.false(result.stdout.includes('daemon-state-secret'));
  },
);

test.serial('a write under /work is visible through the mount', async t => {
  const sandboxed = await makeSandboxedShell(t);
  if (sandboxed === undefined) return;
  const result = await sandboxed.shell.exec('mkdir', ['made-in-slice']);
  t.is(result.exitCode, 0, result.stderr);
  t.true(await E(sandboxed.mount).has('made-in-slice'));
});

test.serial('the sandbox has no network', async t => {
  // A listener this test owns, on the host's loopback: reachable from the
  // host engine, so a failed connect from the slice proves isolation rather
  // than an unreachable destination.
  const server = nodeNet.createServer(socket => socket.end());
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.teardown(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const probe = ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`];

  const outside = makeTemporaryDirectory(t, 'shell-engine-network');
  const hostShell = makeHostShell(outside);
  const hasBash = await hostShell.exec('bash', ['-c', 'true']).then(
    result => result.exitCode === 0,
    () => false,
  );
  if (!hasBash) {
    t.pass('SKIP: the probe needs bash, which this host lacks');
    return;
  }
  const hostResult = await hostShell.exec('bash', probe);
  t.is(
    hostResult.exitCode,
    0,
    `the host engine connects: ${hostResult.stderr}`,
  );

  const sandboxed = await makeSandboxedShell(t);
  if (sandboxed === undefined) return;
  const result = await sandboxed.shell.exec('bash', probe);
  t.not(result.exitCode, 0, 'a TCP connect fails without a network');
});

test.serial('inspect reports the sandbox engine', async t => {
  const sandboxed = await makeSandboxedShell(t);
  if (sandboxed === undefined) return;
  t.is((await sandboxed.shell.inspect()).engine, 'sandbox');
});

for (const engineCase of engineCases) {
  test.serial(`sandbox engine conformance: ${engineCase.name}`, async t => {
    const sandboxed = await makeSandboxedShell(t, engineCase.policy);
    if (sandboxed === undefined) return;
    const outcome = sandboxed.shell.exec(
      engineCase.command,
      engineCase.commandArguments,
    );
    if (engineCase.rejects !== undefined) {
      await t.throwsAsync(outcome, { message: engineCase.rejects });
      return;
    }
    const result = await outcome;
    t.deepEqual(engineCase.observe?.(result), engineCase.expected);
  });
}

test.serial(
  'sandbox engine conformance: any cap truncates exactly as the host engine does',
  async t => {
    t.timeout(120_000);
    const sandboxed = await makeSandboxedShell(t);
    if (sandboxed === undefined) return;
    const outside = makeTemporaryDirectory(t, 'shell-engine-cap');
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8192 }),
        fc.integer({ min: 1, max: 4000 }),
        async (maxOutputBytes, count) => {
          const policy = { maxOutputBytes };
          const sandboxShell = await makeSandboxedShell(t, policy);
          if (sandboxShell === undefined) return false;
          const hostShell = makeHostShell(outside, policy);
          const argv = harden(['1', String(count)]);
          const [sandboxResult, hostResult] = await Promise.all([
            sandboxShell.shell.exec('seq', argv),
            hostShell.exec('seq', argv),
          ]);
          // stderr is left out: bwrap may add its own diagnostics there.
          /** @param {import('@endo/exo-shell').ShellResult} result */
          const project = ({ stdout, exitCode, signal, truncated }) =>
            JSON.stringify({ stdout, exitCode, signal, truncated });
          return (
            sandboxResult.stdout.length <= maxOutputBytes &&
            project(sandboxResult) === project(hostResult)
          );
        },
      ),
      { numRuns: 25 },
    );
    t.pass();
  },
);
