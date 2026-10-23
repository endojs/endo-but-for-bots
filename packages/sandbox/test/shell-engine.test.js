// @ts-check

// The `'sandbox'` Shell engine against a real bwrap slice: the daemon's
// slice construction (`makeSandboxShellEngine`), the sandbox spawner, and the
// `@endo/exo-shell` Shell, over a real daemon mount.  Skipped, with the reason
// recorded, where bwrap cannot create a namespace.

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeShell } from '@endo/exo-shell';
import { engineCases } from '@endo/exo-shell/test/engine-cases.js';
import { makeHostSpawner } from '@endo/host-spawner';
import { makeFilePowers } from '@endo/daemon/src/manager-node-powers.js';
import { getMountBacking, makeMount } from '@endo/daemon/src/mount.js';
import { makeSandboxShellEngine } from '@endo/daemon/src/shell-engine.js';

import * as nodeFs from 'node:fs';
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
    /** @param {any} cap */
    provideHostPath: async cap => {
      const backing = getMountBacking(cap);
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
    onCancel: hook => t.teardown(hook),
  });
  const shell = makeShell({
    cwd,
    policy: harden({ ...basePolicy, ...policy, engine: 'sandbox' }),
    spawner,
  });
  // A host can ship bwrap yet refuse unprivileged user namespaces; the first
  // spawn is where that shows.
  const smoke = await shell.exec('echo', ['ready']).catch(error => error);
  if (smoke instanceof Error || smoke.exitCode !== 0) {
    t.pass(
      `SKIP: bwrap slice unavailable: ${smoke.message ?? smoke.stderr ?? ''}`,
    );
    return undefined;
  }
  return { shell, mount, root };
};

/**
 * @param {string} cwd
 */
const makeHostShell = cwd => {
  const searchPath = process.env.PATH || '/usr/bin:/bin';
  return makeShell({
    cwd,
    policy: harden({ ...basePolicy, engine: 'host' }),
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
  const sandboxed = await makeSandboxedShell(t);
  if (sandboxed === undefined) return;
  const result = await sandboxed.shell.exec('bash', [
    '-c',
    'exec 3<>/dev/tcp/1.1.1.1/53',
  ]);
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
    if (engineCase.expectedError !== undefined) {
      await t.throwsAsync(
        sandboxed.shell.exec(engineCase.command, engineCase.commandArguments),
        { message: engineCase.expectedError },
      );
    } else {
      const result = await sandboxed.shell.exec(
        engineCase.command,
        engineCase.commandArguments,
      );
      t.deepEqual(engineCase.observe?.(result), engineCase.expected);
    }
  });
}
