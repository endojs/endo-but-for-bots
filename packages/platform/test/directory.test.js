import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeDirectory } from '../src/fs-node/directory.js';
import { makeFile } from '../src/fs-node/file.js';

/**
 * @param {import('ava').ExecutionContext} _t
 * @returns {Promise<string>}
 */
const makeTmpDir = async _t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endo-test-'));
  return dir;
};

/**
 * Scaffold a small directory tree for testing.
 *
 * @param {string} root
 */
const scaffold = async root => {
  await fs.promises.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'a.txt'), 'alpha', 'utf-8');
  await fs.promises.writeFile(path.join(root, 'b.json'), '{"x":1}', 'utf-8');
  await fs.promises.writeFile(
    path.join(root, 'sub', 'c.txt'),
    'charlie',
    'utf-8',
  );
};

test('makeDirectory list', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const entries = await directory.list();

  t.deepEqual(entries, ['a.txt', 'b.json', 'sub']);

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory has', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);

  t.true(await directory.has());
  t.true(await directory.has('a.txt'));
  t.true(await directory.has('sub'));
  t.true(await directory.has('sub', 'c.txt'));
  t.false(await directory.has('nonexistent'));

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory lookup file', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const file = await directory.lookup('a.txt');

  t.is(await file.text(), 'alpha');
  // Mutable — should have writeText
  t.is(typeof file.writeText, 'function');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory lookup subdirectory', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const sub = await directory.lookup('sub');

  const entries = await sub.list();
  t.deepEqual(entries, ['c.txt']);

  const cFile = await sub.lookup('c.txt');
  t.is(await cFile.text(), 'charlie');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory lookup with path array', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const file = await directory.lookup(['sub', 'c.txt']);

  t.is(await file.text(), 'charlie');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory makeDirectory creates nested dir', async t => {
  const dir = await makeTmpDir(t);

  const directory = makeDirectory(dir);
  const nested = await directory.makeDirectory(['new', 'deep']);

  t.truthy(nested);
  const stat = await fs.promises.stat(path.join(dir, 'new', 'deep'));
  t.true(stat.isDirectory());

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory remove', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  await directory.remove(['a.txt']);

  t.false(await directory.has('a.txt'));

  // Remove a directory recursively
  await directory.remove(['sub']);
  t.false(await directory.has('sub'));

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory move', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  await directory.move(['a.txt'], ['renamed.txt']);

  t.false(await directory.has('a.txt'));
  t.true(await directory.has('renamed.txt'));

  const content = await fs.promises.readFile(
    path.join(dir, 'renamed.txt'),
    'utf-8',
  );
  t.is(content, 'alpha');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory copy', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  await directory.copy(['a.txt'], ['a-copy.txt']);

  t.true(await directory.has('a.txt'));
  t.true(await directory.has('a-copy.txt'));

  const content = await fs.promises.readFile(
    path.join(dir, 'a-copy.txt'),
    'utf-8',
  );
  t.is(content, 'alpha');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory readOnly returns ReadableTree', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const ro = directory.readOnly();

  // Read methods work
  const entries = await ro.list();
  t.deepEqual(entries, ['a.txt', 'b.json', 'sub']);

  t.true(await ro.has('a.txt'));

  const file = await ro.lookup('a.txt');
  t.is(await file.text(), 'alpha');

  // Write methods should not exist
  t.is(typeof ro.write, 'undefined');
  t.is(typeof ro.remove, 'undefined');
  t.is(typeof ro.makeDirectory, 'undefined');

  // readOnly is cached
  t.is(directory.readOnly(), ro);

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory write blob from file', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const sourceFile = makeFile(path.join(dir, 'a.txt'));

  // Write the blob to a new location
  await directory.write(['new-file.txt'], sourceFile.readOnly());

  const content = await fs.promises.readFile(
    path.join(dir, 'new-file.txt'),
    'utf-8',
  );
  t.is(content, 'alpha');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory snapshot throws without store', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);

  await t.throwsAsync(() => directory.snapshot(), {
    message: 'No snapshot store provided',
  });

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory ignores .git by default', async t => {
  const dir = await makeTmpDir(t);
  await fs.promises.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, '.git', 'config'),
    'stuff',
    'utf-8',
  );
  await fs.promises.writeFile(path.join(dir, 'real.txt'), 'data', 'utf-8');

  const directory = makeDirectory(dir);
  const entries = await directory.list();

  t.deepEqual(entries, ['real.txt']);

  await fs.promises.rm(dir, { recursive: true });
});
