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
  await fs.promises.writeFile(
    path.join(tmpDir, 'readme.md'),
    '# Readme',
    'utf-8',
  );
  await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, 'sub', 'nested.txt'),
    'Nested',
    'utf-8',
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'sub', 'data.json'),
    '{}',
    'utf-8',
  );
  await fs.promises.mkdir(path.join(tmpDir, 'sub', 'deep'), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(tmpDir, 'sub', 'deep', 'file.txt'),
    'deep',
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

test('stat returns file and directory info', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const fileStat = await mount.stat('hello.txt');
  t.is(fileStat.type, 'file');
  t.true(fileStat.size > 0);

  const dirStat = await mount.stat('sub');
  t.is(dirStat.type, 'directory');
  t.is(dirStat.size, 0);
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

test('deny patterns block access to sensitive directories', async t => {
  const { tmpDir, filePowers } = await setup(t);

  // Create a .ssh directory in the mount root.
  await fs.promises.mkdir(path.join(tmpDir, '.ssh'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, '.ssh', 'id_rsa'),
    'PRIVATE KEY',
    'utf-8',
  );
  // Create .env file.
  await fs.promises.writeFile(
    path.join(tmpDir, '.env'),
    'SECRET=value',
    'utf-8',
  );

  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // Direct access to denied segments throws.
  await t.throwsAsync(() => mount.readText(['.ssh', 'id_rsa']), {
    message: /restricted/,
  });
  await t.throwsAsync(() => mount.readText('.env'), {
    message: /restricted/,
  });
  await t.throwsAsync(() => mount.has('.ssh'), {
    message: /restricted/,
  });
  await t.throwsAsync(() => mount.lookup('.aws'), {
    message: /restricted/,
  });

  // list() filters out denied segments.
  const entries = await mount.list();
  t.false(entries.includes('.ssh'));
  t.false(entries.includes('.env'));
  t.true(entries.includes('hello.txt'));
  t.true(entries.includes('sub'));
});

test('deny patterns are case-insensitive', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // Mixed case should also be denied.
  await t.throwsAsync(() => mount.readText(['.SSH', 'id_rsa']), {
    message: /restricted/,
  });
  await t.throwsAsync(() => mount.readText('.Env'), {
    message: /restricted/,
  });
});

test('deny patterns do not block normal dotfiles', async t => {
  const { tmpDir, filePowers } = await setup(t);

  // Create a normal dotfile that's not in the deny list.
  await fs.promises.writeFile(
    path.join(tmpDir, '.gitignore'),
    'node_modules/',
    'utf-8',
  );

  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // .gitignore is allowed.
  const text = await mount.readText('.gitignore');
  t.is(text, 'node_modules/');
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

// --- Glob tests ---

test('glob matches wildcard in single directory', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const txtFiles = await mount.glob('*.txt');
  t.true(txtFiles.includes('hello.txt'));
  t.false(txtFiles.includes('readme.md'));
});

test('glob matches files in subdirectory', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const subFiles = await mount.glob('sub/*.txt');
  t.deepEqual(subFiles, ['sub/nested.txt']);
});

test('glob ** matches recursively', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const allTxt = await mount.glob('**/*.txt');
  t.true(allTxt.includes('hello.txt'));
  t.true(allTxt.includes('sub/nested.txt'));
  t.true(allTxt.includes('sub/deep/file.txt'));
});

test('glob excludes denied segments', async t => {
  const { tmpDir, filePowers } = await setup(t);

  // Create a .ssh directory with files.
  await fs.promises.mkdir(path.join(tmpDir, '.ssh'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, '.ssh', 'id_rsa'),
    'PRIVATE',
    'utf-8',
  );

  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const all = await mount.glob('**/*');
  t.false(all.some(p => p.includes('.ssh')));
});

test('glob returns empty array for no matches', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const results = await mount.glob('*.xyz');
  t.deepEqual(results, []);
});

test('glob on revoked mount throws', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount, control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  control.revoke();
  await t.throwsAsync(() => mount.glob('*'), {
    message: /revoked/,
  });
});

// --- Grep tests ---

test('grep finds matching lines in files', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const results = await mount.grep('Hello');
  t.is(results.length, 1);
  t.is(results[0].file, 'hello.txt');
  t.is(results[0].line, 1);
  t.true(results[0].text.includes('Hello'));
});

test('grep searches recursively by default', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // "Nested" is in sub/nested.txt, "deep" is in sub/deep/file.txt
  const results = await mount.grep('Nested');
  t.is(results.length, 1);
  t.is(results[0].file, 'sub/nested.txt');
});

test('grep filters by glob pattern', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  // Search only .json files
  const results = await mount.grep('\\{', { glob: '**/*.json' });
  t.is(results.length, 1);
  t.is(results[0].file, 'sub/data.json');
});

test('grep returns empty for no matches', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const results = await mount.grep('nonexistent_string_xyz');
  t.deepEqual(results, []);
});

test('grep respects maxResults', async t => {
  const { tmpDir, filePowers } = await setup(t);

  // Create a file with many lines.
  const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`);
  await fs.promises.writeFile(
    path.join(tmpDir, 'many.txt'),
    lines.join('\n'),
    'utf-8',
  );

  const { mount } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  const results = await mount.grep('match', { maxResults: 5 });
  t.is(results.length, 5);
});

test('grep on revoked mount throws', async t => {
  const { tmpDir, filePowers } = await setup(t);
  const { mount, control } = makeMount({
    rootPath: tmpDir,
    readOnly: false,
    filePowers,
  });

  control.revoke();
  await t.throwsAsync(() => mount.grep('test'), {
    message: /revoked/,
  });
});
