// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { acquireRuntimeOwnership } from '../src/runtime-ownership.js';

/** @param {import('ava').ExecutionContext} t */
const fixture = async t => {
  const directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'endo-owner-durability-')),
  );
  t.teardown(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { directory, ownerId: 'owner' };
  const marker = join(directory, 'owner.owner');
  /** @type {string[]} */
  const synced = [];
  /** @type {(target: string) => Promise<void>} */
  let beforeSync = async () => {};
  const filesystem = {
    ...fs,
    /** @param {Parameters<typeof fs.open>} args */
    open: async (...args) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync') {
            return async () => {
              await beforeSync(String(args[0]));
              await target.sync();
              synced.push(String(args[0]));
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return {
    config,
    marker,
    synced,
    filesystem,
    /** @param {typeof beforeSync} hook */
    onSync: hook => {
      beforeSync = hook;
    },
  };
};

test('ownership publication waits for directory flush and includes ancestry', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  const entered = makePromiseKit();
  const gate = makePromiseKit();
  t.teardown(() => gate.resolve(undefined));
  f.onSync(async target => {
    if (target !== f.config.directory) return;
    const marker = await fs.readlink(f.marker).catch(() => undefined);
    if (marker === undefined) return;
    entered.resolve(undefined);
    await gate.promise;
  });
  let acquired = false;
  const acquiring = acquireRuntimeOwnership(f.config, { fs: f.filesystem });
  void acquiring.then(() => {
    acquired = true;
  });
  await entered.promise;
  t.false(acquired);
  const ancestors = [];
  let current = f.config.directory;
  for (;;) {
    ancestors.push(current);
    const next = dirname(current);
    if (current === next) break;
    current = next;
  }
  t.deepEqual(f.synced, ancestors);
  gate.resolve(undefined);
  const owner = await acquiring;
  t.deepEqual(f.synced, [...ancestors, f.config.directory]);
  await owner.release();
});

test('failed ownership publication flush retains exclusion and returns no owner', async t => {
  const f = await fixture(t);
  f.onSync(async target => {
    if (target !== f.config.directory) return;
    const marker = await fs.readlink(f.marker).catch(() => undefined);
    if (marker !== undefined) throw Error('publication flush failed');
  });
  await t.throwsAsync(acquireRuntimeOwnership(f.config, { fs: f.filesystem }), {
    message: /publication flush failed/,
  });
  const token = await fs.readlink(f.marker);
  await t.throwsAsync(acquireRuntimeOwnership(f.config), { message: /EEXIST/ });
  t.is(await fs.readlink(f.marker), token);
});

test('failed release flush retries without removing a successor marker', async t => {
  const f = await fixture(t);
  const owner = await acquireRuntimeOwnership(f.config, { fs: f.filesystem });
  f.onSync(async () => {
    throw Error('release flush failed');
  });
  await t.throwsAsync(owner.release(), { message: /release flush failed/ });
  await t.throwsAsync(fs.readlink(f.marker), { message: /ENOENT/ });
  const successor = await acquireRuntimeOwnership(f.config);
  const token = await fs.readlink(f.marker);
  const previousFlushes = f.synced.length;
  f.onSync(async () => {});
  await owner.release();
  t.is(f.synced.length, previousFlushes + 1);
  t.is(await fs.readlink(f.marker), token);
  await successor.release();
});

test('ancestry flush failure does not publish ownership', async t => {
  const f = await fixture(t);
  f.onSync(async target => {
    if (target === dirname(f.config.directory))
      throw Error('ancestry flush failed');
  });
  await t.throwsAsync(acquireRuntimeOwnership(f.config, { fs: f.filesystem }), {
    message: /ancestry flush failed/,
  });
  await t.throwsAsync(fs.readlink(f.marker), { message: /ENOENT/ });
});
