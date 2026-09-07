// @ts-check
import '@endo/init';

import test from 'ava';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath, kill, platform } from 'node:process';

import { makeFileVolumeRegistry } from '../src/durable-volumes.js';

const linuxTest = platform === 'linux' ? test.serial : test.serial.skip;

linuxTest(
  'file registry persists updates and serializes independent instances',
  async t => {
    t.timeout(10_000);
    const directory = await mkdtemp(join(tmpdir(), 'floot-registry-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const a = await makeFileVolumeRegistry({ directory });
    const b = await makeFileVolumeRegistry({ directory });
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        (i % 2 ? a : b).transaction(async (state, save) => {
          state.count = (state.count ?? 0) + 1;
          await save();
        }),
      ),
    );
    t.is(
      JSON.parse(await readFile(`${directory}/volumes.json`, 'utf8')).count,
      4,
    );
  },
);

linuxTest(
  'dead lock holder fences other callbacks until old effects settle',
  async t => {
    t.timeout(10_000);
    const directory = await mkdtemp(join(tmpdir(), 'floot-registry-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const registry = await makeFileVolumeRegistry({ directory });
    /** @type {() => void} */
    let release = () => undefined;
    const barrier = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    /** @type {() => void} */
    let signal = () => undefined;
    const started = new Promise(resolve => {
      signal = () => resolve(undefined);
    });
    const first = registry.transaction(async (state, save) => {
      signal();
      await barrier;
      state.late = true;
      await save();
    });
    first.catch(() => undefined);
    await started;
    const marker = JSON.parse(
      await readFile(`${directory}/transaction.json`, 'utf8'),
    );
    kill(marker.writerPid, 'SIGKILL');
    let entered = false;
    await t.throwsAsync(
      () =>
        registry.transaction(async () => {
          entered = true;
        }),
      { message: /Abandoned volume transaction/ },
    );
    t.false(entered);
    release();
    await t.throwsAsync(() => first, { message: /registry|pipe|stream/i });
    await registry.transaction(async (state, save) => {
      t.is(state.late, undefined);
      state.recovered = true;
      await save();
    });
  },
);

linuxTest(
  'new process recovery requires dead owner and completed descendant reaping',
  async t => {
    t.timeout(10_000);
    const directory = await mkdtemp(join(tmpdir(), 'floot-registry-owner-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const source = `import ${JSON.stringify(new URL('../../init/index.js', import.meta.url).href)}; import {makeFileVolumeRegistry} from ${JSON.stringify(new URL('../src/durable-volumes.js', import.meta.url).href)}; const registry=await makeFileVolumeRegistry({directory:${JSON.stringify(directory)}}); await registry.transaction(async()=>{process.stdout.write('ready\\n');await new Promise(()=>{});});`;
    const owner = spawn(execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise(resolve => owner.once('close', resolve));
    t.teardown(async () => {
      owner.kill('SIGKILL');
      await exited;
    });
    await new Promise((resolve, reject) => {
      owner.once('error', reject);
      owner.stdout.once('data', resolve);
    });
    let reaped = false;
    let refuse = true;
    const registry = await makeFileVolumeRegistry({
      directory,
      ownerReaper: harden({
        reap: async () => {
          if (refuse) throw Error('descendants not reaped');
          reaped = true;
        },
      }),
    });
    await t.throwsAsync(() => registry.recoverAbandonedTransaction(), {
      message: /live volume registry owner/,
    });
    t.false(reaped);
    owner.kill('SIGKILL');
    await exited;
    await t.throwsAsync(() => registry.recoverAbandonedTransaction(), {
      message: /descendants not reaped/,
    });
    await t.throwsAsync(() => registry.transaction(async () => undefined), {
      message: /Abandoned volume transaction/,
    });
    refuse = false;
    await registry.recoverAbandonedTransaction();
    t.true(reaped);
    await registry.transaction(async (state, save) => {
      state.recovered = true;
      await save();
    });
  },
);
