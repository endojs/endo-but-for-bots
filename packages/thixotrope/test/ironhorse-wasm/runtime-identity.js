// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIronhorseLimits } from '../../src/ironhorse/ironhorse-limits.js';
import { acquireIronhorseRuntime } from '../../src/ironhorse/ironhorse-runtime.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { ProcessPowers } from '../../src/platform/processes.js' */

const nodePowers = makeNodePowers();

const repoPath = fileURLToPath(new URL('../../../../', import.meta.url));
const launcherBinary =
  process.env.THIXOTROPE_IRONHORSE_WASM_WORKER ??
  join(repoPath, 'target/release/thixotrope-ironhorse-wasm-worker');
// The wasm lane points THIXOTROPE_IRONHORSE_WORKER at the launcher, so the
// native worker has a variable of its own here.
const nativeBinary =
  process.env.THIXOTROPE_IRONHORSE_NATIVE_WORKER ??
  join(repoPath, 'target/release/thixotrope-ironhorse-worker');
// Fail at module load, never turn missing CI artifacts into skipped tests.
await Promise.all([launcherBinary, nativeBinary].map(path => access(path)));

// The names the launcher expects beside itself. The lock helper only checks
// that they are regular files, so stand-ins serve; Node never runs here.
const partNames = harden([
  'thixotrope-ironhorse-wasm-shell.mjs',
  'host-abi.mjs',
  'thixotrope_ironhorse_wasm.wasm',
]);
/** @param {string} name */
const standIn = name => `stand-in for ${name}\n`;

/**
 * A scratch directory holding a staged launcher with its parts and a boot
 * file, removed when the test ends along with anything still acquired.
 * @param {ExecutionContext} t
 */
const makeScratch = async t => {
  const path = await mkdtemp(join(tmpdir(), 'thixotrope-wasm-identity-'));
  /** @type {Set<() => Promise<void>>} */
  const held = new Set();
  t.teardown(async () => {
    try {
      await Promise.all([...held].map(release => release()));
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
  const launcherDirectory = join(path, 'launcher');
  await mkdir(launcherDirectory);
  const launcher = join(launcherDirectory, 'thixotrope-ironhorse-wasm-worker');
  await copyFile(launcherBinary, launcher);
  await Promise.all(
    partNames.map(name =>
      writeFile(join(launcherDirectory, name), standIn(name)),
    ),
  );
  const boot = join(path, 'boot.js');
  await writeFile(boot, 'globalThis.booted = true;');

  /**
   * Acquire `statePath` through `workerBinary`, recording the helper's pid.
   * @param {string} statePath
   * @param {string} workerBinary
   */
  const acquire = async (statePath, workerBinary) => {
    /** @type {number[]} */
    const pids = [];
    /** @type {ProcessPowers} */
    const processes = harden({
      spawn: (...args) => {
        const child = nodePowers.processes.spawn(...args);
        pids.push(child.pid);
        return child;
      },
    });
    const attempt = acquireIronhorseRuntime(
      { ...nodePowers, processes },
      {
        statePath,
        workerBinary,
        bootPaths: [boot],
        limits: makeIronhorseLimits({}),
        onLost: () => t.fail('Ironhorse ownership lost unexpectedly'),
      },
    );
    const assertNoHelper = () => {
      t.is(pids.length, 1);
      for (const pid of pids) {
        t.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
    };
    /** @type {Awaited<typeof attempt> | undefined} */
    let runtime;
    try {
      runtime = await attempt;
    } catch (error) {
      assertNoHelper();
      throw error;
    }
    const { release } = runtime;
    held.add(release);
    return harden({
      runtime,
      release: async () => {
        held.delete(release);
        await release();
        assertNoHelper();
      },
    });
  };
  return harden({ path, launcher, acquire });
};

/** @param {string} statePath */
const readManifest = async statePath =>
  JSON.parse(await readFile(join(statePath, 'runtime.json'), 'utf8'));

test.serial(
  'the wasm launcher pins its parts and finds them beside its private copy',
  async t => {
    t.timeout(60_000);
    const { path, launcher, acquire } = await makeScratch(t);
    const statePath = join(path, 'wasm-state');

    const first = await acquire(statePath, launcher);
    const { profile } = first.runtime;
    const directory = join(statePath, 'runtime', profile);
    t.is(first.runtime.workerBinary, join(directory, '0'));
    t.deepEqual(
      (await readdir(directory)).sort(),
      ['0', '1', ...partNames].sort(),
    );
    for (const name of partNames) {
      // eslint-disable-next-line no-await-in-loop
      t.is(await readFile(join(directory, name), 'utf8'), standIn(name));
    }
    t.deepEqual(
      await readFile(join(directory, '0')),
      await readFile(launcherBinary),
    );
    await t.notThrowsAsync(access(join(directory, '0'), constants.X_OK));
    const manifest = await readManifest(statePath);
    t.is(manifest.heapFormat, 'do-v1');
    t.deepEqual(
      manifest.parts.map(([name]) => name),
      [...partNames].sort(),
    );

    // The private copy, run as a lock helper, names the parts beside it,
    // and they hash to the same identity.
    const viaCopy = await acquire(
      join(path, 'copy-state'),
      join(directory, '0'),
    );
    t.is(viaCopy.runtime.profile, profile);
    await viaCopy.release();

    await first.release();
    const second = await acquire(statePath, launcher);
    t.is(second.runtime.profile, profile);
    await second.release();
    t.deepEqual(await readManifest(statePath), manifest);

    await t.throwsAsync(() => acquire(statePath, nativeBinary), {
      message:
        /^Incompatible Ironhorse runtime: the state directory holds "do-v1" heaps and this worker uses "native" heaps; use the original worker or migrate to a fresh state directory$/,
    });
    t.deepEqual(await readdir(join(statePath, 'runtime')), [profile]);
    t.deepEqual(await readManifest(statePath), manifest);
  },
);

test.serial('native state is refused to the wasm launcher', async t => {
  t.timeout(60_000);
  const { path, launcher, acquire } = await makeScratch(t);
  const statePath = join(path, 'native-state');

  const native = await acquire(statePath, nativeBinary);
  const { profile } = native.runtime;
  await native.release();
  const manifest = await readManifest(statePath);
  t.false('heapFormat' in manifest);
  t.false('parts' in manifest);

  await t.throwsAsync(() => acquire(statePath, launcher), {
    message:
      /^Incompatible Ironhorse runtime: the state directory holds "native" heaps and this worker uses "do-v1" heaps; use the original worker or migrate to a fresh state directory$/,
  });
  t.deepEqual(await readdir(join(statePath, 'runtime')), [profile]);
  t.deepEqual(await readManifest(statePath), manifest);

  // The native worker still reopens its own state.
  const again = await acquire(statePath, nativeBinary);
  t.is(again.runtime.profile, profile);
  await again.release();
});
