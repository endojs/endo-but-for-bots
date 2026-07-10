// @ts-nocheck
/* global process */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'ava';
import url from 'url';
import { $ } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();

// Isolated daemon context with a unique socket so this file does not collide
// with other CLI test files that AVA runs concurrently in worker threads
// sharing the same process.pid. Mirrors formula-collection.test.js.
const testRoot = path.join(dirname, 'tmp', 'endo-mount-path-cli');
const endoEnv = {
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  XDG_RUNTIME_DIR: path.join(testRoot, 'run'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  ENDO_SOCK: path.join(os.tmpdir(), `endo-mount-path-cli-${process.pid}.sock`),
  ENDO_ADDR: '127.0.0.1:0',
};

for (const [key, value] of Object.entries(endoEnv)) {
  process.env[key] = value;
}

// Materialize a small directory tree on disk to mount and traverse.
const makeSourceTree = async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'endo-mount-src-'));
  await fs.writeFile(path.join(source, 'README.md'), '# hello mount\n');
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"demo"}\n');
  await fs.mkdir(path.join(source, 'src'));
  await fs.writeFile(
    path.join(source, 'src', 'index.js'),
    'export const x = 1;\n',
  );
  await fs.writeFile(
    path.join(source, 'src', 'utils.js'),
    'export const y = 2;\n',
  );
  return source;
};

test.serial('endo ls/cat/write traverse a mount confined tree', async t => {
  const execa = $({ cwd: dirname });
  const source = await makeSourceTree();
  await execa`endo purge -f`;
  await execa`endo start`;
  try {
    await execa`endo mount ${source} --name proj`;

    // `endo ls <mount>` lists the confined root, sorted.
    const lsRoot = await execa`endo ls proj`;
    t.deepEqual(
      lsRoot.stdout.split('\n').filter(Boolean).sort(),
      ['README.md', 'package.json', 'src'],
      'ls of the mount root lists its top-level entries',
    );

    // `endo ls <mount> <path...>` lists a subdirectory within the mount.
    const lsSrc = await execa`endo ls proj src`;
    t.deepEqual(
      lsSrc.stdout.split('\n').filter(Boolean).sort(),
      ['index.js', 'utils.js'],
      'ls of an in-mount subdirectory lists its entries',
    );

    // `--json` emits the in-mount entry array as JSON (a distinct code path).
    const lsSrcJson = await execa`endo ls proj src --json`;
    t.deepEqual(
      JSON.parse(lsSrcJson.stdout),
      ['index.js', 'utils.js'],
      'ls --json of an in-mount subdirectory emits the entry array as JSON',
    );

    // A `/`-joined single argument is split into segments.
    const lsSrcJoined = await execa`endo cat proj src/index.js`;
    t.is(
      lsSrcJoined.stdout,
      'export const x = 1;',
      'cat resolves a slash-joined in-mount path',
    );

    // `endo cat <mount> <path...>` reads a file within the mount.
    const catReadme = await execa`endo cat proj README.md`;
    t.is(catReadme.stdout, '# hello mount', 'cat reads an in-mount file');

    // `endo write <mount> <path...>` writes stdin to a new file, creating
    // parents, and is observable both on disk and back through `endo cat`.
    await execa({ input: 'take notes\n' })`endo write proj docs/notes.txt`;
    const onDisk = await fs.readFile(
      path.join(source, 'docs', 'notes.txt'),
      'utf-8',
    );
    t.is(onDisk, 'take notes\n', 'write lands the file on the backing disk');
    const catNotes = await execa`endo cat proj docs/notes.txt`;
    t.is(catNotes.stdout, 'take notes', 'the written file reads back via cat');

    // Non-UTF-8 stdin is refused rather than silently corrupted (binary
    // `--blob` mount writes are deferred), and leaves no file on disk.
    const binaryError = await t.throwsAsync(
      execa({
        input: new Uint8Array([0xff, 0xfe, 0x00]),
      })`endo write proj bin.dat`,
    );
    t.regex(
      binaryError.stderr,
      /utf-8/i,
      'write of non-UTF-8 input is refused',
    );
    await t.throwsAsync(
      fs.stat(path.join(source, 'bin.dat')),
      undefined,
      'the refused binary write left no file on disk',
    );
  } finally {
    await execa`endo purge -f`;
    await fs.rm(source, { recursive: true, force: true });
  }
});

test.serial('endo write refuses a read-only mount', async t => {
  const execa = $({ cwd: dirname });
  const source = await makeSourceTree();
  await execa`endo purge -f`;
  await execa`endo start`;
  try {
    await execa`endo mount ${source} --name ro --read-only`;
    const error = await t.throwsAsync(
      execa({ input: 'nope' })`endo write ro blocked.txt`,
    );
    t.regex(error.stderr, /read-only/i, 'write to a read-only mount fails');
    // The write did not reach disk.
    await t.throwsAsync(
      fs.stat(path.join(source, 'blocked.txt')),
      undefined,
      'the blocked write left no file on disk',
    );
  } finally {
    await execa`endo purge -f`;
    await fs.rm(source, { recursive: true, force: true });
  }
});
