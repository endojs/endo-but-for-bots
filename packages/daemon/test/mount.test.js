// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from '@endo/ses-ava/prepare-endo.js';

import { makeMount } from '../src/mount.js';

/**
 * Create a temp directory and return filePowers for mount.
 *
 * @param {import('ava').ExecutionContext} t
 */
const setup = async t => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-mount-test-'),
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'hello.txt'),
    'Hello, world!',
    'utf-8',
  );
  await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, 'sub', 'nested.txt'),
    'Nested',
    'utf-8',
  );

  t.teardown(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /** @type {import('../src/types.js').FilePowers} */
  const filePowers = {
    readDirectory: dir => fs.promises.readdir(dir),
    readFileText: p => fs.promises.readFile(p, 'utf-8'),
    writeFileText: (p, c) => fs.promises.writeFile(p, c, 'utf-8'),
    makePath: p => fs.promises.mkdir(p, { recursive: true }),
    removePath: p => fs.promises.rm(p, { recursive: true, force: true }),
    renamePath: (a, b) => fs.promises.rename(a, b),
    joinPath: (...parts) => path.join(...parts),
    realPath: p => fs.promises.realpath(p),
    exists: async p => {
      try {
        await fs.promises.access(p);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory: async p => {
      try {
        const stat = await fs.promises.stat(p);
        return stat.isDirectory();
      } catch {
        return false;
      }
    },
    makeFileReader: _p => {
      throw new Error('not implemented');
    },
    makeFileWriter: _p => {
      throw new Error('not implemented');
    },
  };

  return { tmpDir, filePowers };
};

test('makeMount returns mount and control', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount, control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });
  t.truthy(mount);
  t.truthy(control);
  t.is(typeof control.revoke, 'function');
  t.is(typeof control.help, 'function');
});

test('mount reads files before revocation', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const text = await mount.readText('hello.txt');
  t.is(text, 'Hello, world!');
});

test('control.revoke() prevents all mount operations', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount, control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // Works before revocation.
  t.true(await mount.has('hello.txt'));

  // Revoke.
  control.revoke();

  // All operations throw after revocation.
  await t.throwsAsync(() => mount.has('hello.txt'), {
    message: /revoked/,
  });
  await t.throwsAsync(() => mount.list(), {
    message: /revoked/,
  });
  await t.throwsAsync(() => mount.readText('hello.txt'), {
    message: /revoked/,
  });
  await t.throwsAsync(() => mount.writeText('new.txt', 'data'), {
    message: /revoked/,
  });
  t.throws(() => mount.readOnly(), {
    message: /revoked/,
  });
});

test('revocation propagates to subDir mounts', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount, control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // Create a subDir before revoking.
  const sub = await mount.subDir('sub');
  t.is(await sub.readText('nested.txt'), 'Nested');

  // Revoke the parent.
  control.revoke();

  // SubDir is also revoked (shares revokedRef).
  await t.throwsAsync(() => sub.readText('nested.txt'), {
    message: /revoked/,
  });
});

test('control.help() returns documentation', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const helpText = control.help();
  t.true(helpText.includes('MountControl'));
  t.true(helpText.includes('revoke'));
});
