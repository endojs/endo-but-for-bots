// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeGeneratedFileStorage } from '../src/generated-file-storage.js';
import { validateGeneratedFiles } from '../src/generated-files.js';

/** @param {string[]} values */
const configFiles = values =>
  validateGeneratedFiles(
    values.map((contents, i) => ({ innerPath: `/etc/config-${i}`, contents })),
  );

/** @param {any} t */
const rootFixture = async t => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'endo-staging-test-'));
  t.teardown(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, directory: join(parent, 'storage') };
};

test('staging reserves aggregate UTF-8 bytes and releases them only after deletion', async t => {
  const { directory } = await rootFixture(t);
  const text = 'é漢💡\ud800';
  const storage = await makeGeneratedFileStorage({
    directory,
    maxBytes: 12n,
    maxEntries: 5n,
  });
  const first = storage.makeStage(configFiles([text]), []);
  const second = storage.makeStage(configFiles(['a']), []);
  const [mount] = await first.prepare();
  t.deepEqual(
    new Uint8Array(await fs.readFile(mount.hostPath)),
    new TextEncoder().encode(text),
  );
  t.is(mount.mode, 'ro');
  // eslint-disable-next-line no-bitwise
  t.is((await fs.stat(mount.hostPath)).mode & 0o777, 0o444);
  // eslint-disable-next-line no-bitwise
  t.is((await fs.stat(dirname(mount.hostPath))).mode & 0o777, 0o700);
  await t.throwsAsync(second.prepare(), { message: /budget exhausted/ });
  await first.release();
  await second.prepare();
  await second.release();
  await storage.close();
});

test('empty files consume entries while empty configurations allocate none', async t => {
  const { directory } = await rootFixture(t);
  const storage = await makeGeneratedFileStorage({
    directory,
    maxBytes: 0n,
    maxEntries: 3n,
  });
  t.deepEqual(await storage.makeStage([], []).prepare(), []);
  const first = storage.makeStage(configFiles(['']), []);
  const second = storage.makeStage(configFiles(['']), []);
  await first.prepare();
  await t.throwsAsync(second.prepare(), { message: /budget exhausted/ });
  await first.release();
  await second.prepare();
  await second.release();
  await storage.close();
});

test('concurrent first use materializes once and close preserves files still in use', async t => {
  const { directory } = await rootFixture(t);
  let writes = 0;
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 5n, maxEntries: 3n },
    {
      fs: {
        ...fs,
        writeFile: async (...args) => {
          writes += 1;
          return fs.writeFile(...args);
        },
      },
    },
  );
  const stage = storage.makeStage(configFiles(['hello']), []);
  const [a, b] = await Promise.all([stage.prepare(), stage.prepare()]);
  t.deepEqual(a, b);
  t.is(writes, 1);
  await t.throwsAsync(storage.close(), { message: /shutdown pending/ });
  t.is(await fs.readFile(a[0].hostPath, 'utf8'), 'hello');
  await stage.release();
  await storage.close();
  // A stale successful close must not remove a successor's storage root.
  const successor = await makeGeneratedFileStorage({
    directory,
    maxBytes: 0n,
    maxEntries: 1n,
  });
  await storage.close();
  await fs.access(directory);
  await successor.close();
});

test('partial writes and failed deletion retain charges until cleanup retry succeeds', async t => {
  const { directory } = await rootFixture(t);
  let failWrite = true;
  let failRemoval = true;
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 6n, maxEntries: 4n },
    {
      fs: {
        ...fs,
        writeFile: async (...args) => {
          if (String(args[0]).endsWith('/1') && failWrite)
            throw Error('write failed');
          return fs.writeFile(...args);
        },
        rm: async (...args) => {
          if (failRemoval) throw Error('removal failed');
          return fs.rm(...args);
        },
      },
    },
  );
  const stage = storage.makeStage(configFiles(['abc', 'def']), []);
  const other = storage.makeStage(configFiles(['x']), []);
  await t.throwsAsync(stage.prepare(), { message: /staging cleanup pending/ });
  await t.throwsAsync(other.prepare(), { message: /budget exhausted/ });
  failRemoval = false;
  failWrite = false;
  const mounts = await stage.prepare();
  t.is(mounts.length, 2);
  await stage.release();
  await other.prepare();
  await other.release();
  await storage.close();
});

test('failed release retains reservation and remains retryable after store close', async t => {
  const { directory } = await rootFixture(t);
  let busy = true;
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 1n, maxEntries: 3n },
    {
      fs: {
        ...fs,
        rm: async (...args) => {
          if (busy) throw Error('busy');
          return fs.rm(...args);
        },
      },
    },
  );
  const stage = storage.makeStage(configFiles(['x']), []);
  await stage.prepare();
  await t.throwsAsync(stage.release(), { message: /busy/ });
  await t.throwsAsync(storage.close(), { message: /shutdown pending/ });
  busy = false;
  await stage.release();
  await storage.close();
});

test('close during a write drains acquisition and prevents publication', async t => {
  t.timeout(3000);
  const { directory } = await rootFixture(t);
  const entered = makePromiseKit();
  const finish = makePromiseKit();
  t.teardown(() => finish.resolve(undefined));
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 1n, maxEntries: 3n },
    {
      fs: {
        ...fs,
        writeFile: async (...args) => {
          entered.resolve(undefined);
          await finish.promise;
          return fs.writeFile(...args);
        },
      },
    },
  );
  const stage = storage.makeStage(configFiles(['x']), []);
  const rejected = t.throwsAsync(stage.prepare(), { message: /shutting down/ });
  await entered.promise;
  const closing = storage.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  finish.resolve(undefined);
  await rejected;
  await closing;
  t.like(await t.throwsAsync(fs.access(directory)), { code: 'ENOENT' });
});

test('storage refuses existing roots and writable host aliases in both directions', async t => {
  const { parent, directory } = await rootFixture(t);
  const storage = await makeGeneratedFileStorage({
    directory,
    maxBytes: 10n,
    maxEntries: 10n,
  });
  await t.throwsAsync(
    makeGeneratedFileStorage({ directory, maxBytes: 10n, maxEntries: 10n }),
    { code: 'EEXIST' },
  );
  const alias = join(parent, 'alias');
  await fs.symlink(parent, alias);
  await t.throwsAsync(
    storage.makeStage(configFiles(['x']), [alias]).prepare(),
    { message: /overlaps a writable/ },
  );
  const stage = storage.makeStage(configFiles(['x']), []);
  const [mount] = await stage.prepare();
  await t.throwsAsync(
    storage.makeStage(configFiles(['y']), [mount.hostPath]).prepare(),
    { message: /overlaps a writable/ },
  );
  await stage.release();
  await storage.close();
  await fs.mkdir(directory);
  await t.throwsAsync(
    makeGeneratedFileStorage({ directory, maxBytes: 10n, maxEntries: 10n }),
    { code: 'EEXIST' },
  );
});

test('private parent is required before the storage root is created', async t => {
  const { parent, directory } = await rootFixture(t);
  await fs.chmod(parent, 0o755);
  await t.throwsAsync(
    makeGeneratedFileStorage({ directory, maxBytes: 1n, maxEntries: 3n }),
    { message: /parent must be private/ },
  );
  t.like(await t.throwsAsync(fs.access(directory)), { code: 'ENOENT' });
});

test('a changed writable alias is rechecked even after materialization', async t => {
  const { parent, directory } = await rootFixture(t);
  const workspace = join(parent, 'workspace');
  await fs.mkdir(workspace);
  const alias = join(parent, 'workspace-alias');
  await fs.symlink(workspace, alias);
  const storage = await makeGeneratedFileStorage({
    directory,
    maxBytes: 1n,
    maxEntries: 3n,
  });
  const stage = storage.makeStage(configFiles(['x']), [alias]);
  const [mount] = await stage.prepare();
  await fs.unlink(alias);
  await fs.symlink(parent, alias);
  await t.throwsAsync(stage.prepare(), { message: /overlaps a writable/ });
  t.is(await fs.readFile(mount.hostPath, 'utf8'), 'x');
  await stage.release();
  await storage.close();
});

test('concurrent stages share one atomic storage reservation', async t => {
  t.timeout(3000);
  const { directory } = await rootFixture(t);
  const entered = makePromiseKit();
  const finish = makePromiseKit();
  t.teardown(() => finish.resolve(undefined));
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 1n, maxEntries: 3n },
    {
      fs: {
        ...fs,
        writeFile: async (...args) => {
          entered.resolve(undefined);
          await finish.promise;
          return fs.writeFile(...args);
        },
      },
    },
  );
  const stages = [
    storage.makeStage(configFiles(['a']), []),
    storage.makeStage(configFiles(['b']), []),
  ];
  const results = Promise.allSettled(stages.map(stage => stage.prepare()));
  await entered.promise;
  finish.resolve(undefined);
  const outcomes = await results;
  t.is(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const failed = outcomes.find(result => result.status === 'rejected');
  t.regex(failed?.reason.message, /budget exhausted/);
  await Promise.all(stages.map(stage => stage.release()));
  await storage.close();
});

test('release waits for a pending write and prevents publication', async t => {
  t.timeout(3000);
  const { directory } = await rootFixture(t);
  const entered = makePromiseKit();
  const finish = makePromiseKit();
  t.teardown(() => finish.resolve(undefined));
  const storage = await makeGeneratedFileStorage(
    { directory, maxBytes: 1n, maxEntries: 3n },
    {
      fs: {
        ...fs,
        writeFile: async (...args) => {
          entered.resolve(undefined);
          await finish.promise;
          return fs.writeFile(...args);
        },
      },
    },
  );
  const stage = storage.makeStage(configFiles(['x']), []);
  const rejected = t.throwsAsync(stage.prepare(), { message: /releasing/ });
  await entered.promise;
  const releasing = stage.release();
  t.is(stage.release(), releasing);
  finish.resolve(undefined);
  await rejected;
  await releasing;
  t.deepEqual(await fs.readdir(directory), []);
  await storage.close();
});
