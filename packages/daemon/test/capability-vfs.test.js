// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from '@endo/ses-ava/prepare-endo.js';

import { makeMount } from '../src/mount.js';
import { makeCapabilityVFS } from '../src/capability-vfs.js';

/**
 * @param {import('ava').ExecutionContext} t
 */
const setup = async t => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-capvfs-test-'),
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'hello.txt'),
    'Hello, world!',
    'utf-8',
  );
  await fs.promises.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, 'src', 'main.js'),
    'console.log("main");',
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

  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const vfs = makeCapabilityVFS(mount);
  return { tmpDir, vfs, mount };
};

test('readFile reads text content', async t => {
  const { vfs } = await setup(t);
  const content = await vfs.readFile('hello.txt');
  t.is(content, 'Hello, world!');
});

test('readFile reads from subdirectories', async t => {
  const { vfs } = await setup(t);
  const content = await vfs.readFile('src/main.js');
  t.is(content, 'console.log("main");');
});

test('writeFile creates and overwrites files', async t => {
  const { vfs } = await setup(t);
  await vfs.writeFile('new.txt', 'new content');
  const content = await vfs.readFile('new.txt');
  t.is(content, 'new content');

  await vfs.writeFile('new.txt', 'overwritten');
  const updated = await vfs.readFile('new.txt');
  t.is(updated, 'overwritten');
});

test('stat returns file info', async t => {
  const { vfs } = await setup(t);
  const fileStat = await vfs.stat('hello.txt');
  t.is(fileStat.type, 'file');
  t.true(fileStat.size > 0);

  const dirStat = await vfs.stat('src');
  t.is(dirStat.type, 'directory');
});

test('stat throws for nonexistent path', async t => {
  const { vfs } = await setup(t);
  await t.throwsAsync(() => vfs.stat('nonexistent'), {
    message: /ENOENT/,
  });
});

test('mkdir creates directories', async t => {
  const { vfs } = await setup(t);
  const created = await vfs.mkdir('newdir');
  t.true(created);

  const stat = await vfs.stat('newdir');
  t.is(stat.type, 'directory');
});

test('mkdir recursive returns false for existing', async t => {
  const { vfs } = await setup(t);
  const created = await vfs.mkdir('src', { recursive: true });
  t.false(created);
});

test('rm removes files', async t => {
  const { vfs } = await setup(t);
  await vfs.writeFile('temp.txt', 'temp');
  await vfs.rm('temp.txt');
  await t.throwsAsync(() => vfs.stat('temp.txt'), {
    message: /ENOENT/,
  });
});

test('readdir lists directory entries', async t => {
  const { vfs } = await setup(t);
  const entries = [];
  for await (const entry of vfs.readdir('')) {
    entries.push(entry);
  }
  const names = entries.map(e => e.name).sort();
  t.true(names.includes('hello.txt'));
  t.true(names.includes('src'));

  const srcEntry = entries.find(e => e.name === 'src');
  t.is(srcEntry?.type, 'directory');
});

test('readdir recursive yields nested entries', async t => {
  const { vfs } = await setup(t);
  const entries = [];
  for await (const entry of vfs.readdir('', { recursive: true })) {
    entries.push(entry);
  }
  const names = entries.map(e => e.name);
  t.true(names.includes('src/main.js'));
});

test('createReadStream yields file bytes', async t => {
  const { vfs } = await setup(t);
  const chunks = [];
  for await (const chunk of vfs.createReadStream('hello.txt')) {
    chunks.push(chunk);
  }
  const text = new TextDecoder().decode(chunks[0]);
  t.is(text, 'Hello, world!');
});
