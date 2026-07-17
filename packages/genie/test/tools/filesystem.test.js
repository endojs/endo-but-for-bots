// @ts-check

import '@endo/harden';

import test from 'ava';
import { makeFileTools } from '../../src/tools/filesystem.js';
import { makeMemoryVFS } from '../../src/tools/vfs-memory.js';

/**
 * Helper: create file tools backed by an in-memory VFS.
 * Pre-creates the root directory so that non-recursive mkdir works.
 *
 * @param {string} [root]
 * @returns {Promise<ReturnType<typeof makeFileTools>>}
 */
const setup = async (root = '/workspace') => {
  const vfs = makeMemoryVFS();
  await vfs.mkdir(root, { recursive: true });
  return makeFileTools({ root, vfs });
};

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

test('writeFile creates a new file', async t => {
  const tools = await setup();
  const result = await tools.writeFile.execute({
    path: 'hello.txt',
    content: 'Hello, world!',
  });
  t.true(result.success);
  t.is(result.path, 'hello.txt');
  t.is(result.bytesWritten, 13);
});

test('writeFile overwrites an existing file', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'f.txt', content: 'first' });
  const result = await tools.writeFile.execute({
    path: 'f.txt',
    content: 'second',
  });
  t.true(result.success);
  t.is(result.bytesWritten, 6);

  const read = await tools.readFile.execute({ path: 'f.txt' });
  t.is(read.content, 'second');
});

test('writeFile creates intermediate directories', async t => {
  const tools = await setup();
  const result = await tools.writeFile.execute({
    path: 'a/b/c.txt',
    content: 'deep',
  });
  t.true(result.success);

  const read = await tools.readFile.execute({ path: 'a/b/c.txt' });
  t.is(read.content, 'deep');
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

test('readFile reads file content', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'data.txt', content: 'abc123' });

  const result = await tools.readFile.execute({ path: 'data.txt' });
  t.true(result.success);
  t.is(result.content, 'abc123');
  t.is(result.bytesRead, 6);
});

test('readFile throws for missing file', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.readFile.execute({ path: 'nope.txt' }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('File not found'));
});

test('readFile supports offset and limit', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'range.txt',
    content: '0123456789',
  });

  const result = await tools.readFile.execute({
    path: 'range.txt',
    offset: 2,
    limit: 4,
  });
  t.is(result.content, '2345');
  t.is(result.bytesRead, 4);
});

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

test('editFile replaces a unique match and returns a diff', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'edit.txt',
    content: 'foo bar baz',
  });

  const result = await tools.editFile.execute({
    path: 'edit.txt',
    oldText: 'bar',
    newText: 'qux',
  });
  t.true(result.success);
  t.is(result.applied, 1);
  t.true(result.diff.includes('-foo bar baz'));
  t.true(result.diff.includes('+foo qux baz'));

  const read = await tools.readFile.execute({ path: 'edit.txt' });
  t.is(read.content, 'foo qux baz');
});

test('editFile applies a batch of non-overlapping edits', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'edit-batch.txt',
    content: 'aaa bbb ccc',
  });

  const result = await tools.editFile.execute({
    path: 'edit-batch.txt',
    edits: [
      { oldText: 'aaa', newText: 'xxx' },
      { oldText: 'ccc', newText: 'zzz' },
    ],
  });
  t.is(result.applied, 2);

  const read = await tools.readFile.execute({ path: 'edit-batch.txt' });
  t.is(read.content, 'xxx bbb zzz');
});

test('editFile rejects a non-unique match', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'edit-dup.txt',
    content: 'foo bar foo baz',
  });

  const err = await t.throwsAsync(() =>
    tools.editFile.execute({
      path: 'edit-dup.txt',
      oldText: 'foo',
      newText: 'qux',
    }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('matches 2 locations'));

  // The file is untouched on rejection.
  const read = await tools.readFile.execute({ path: 'edit-dup.txt' });
  t.is(read.content, 'foo bar foo baz');
});

test('editFile throws when oldText not found', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'no-match.txt',
    content: 'nothing here',
  });

  const err = await t.throwsAsync(() =>
    tools.editFile.execute({
      path: 'no-match.txt',
      oldText: 'missing',
      newText: 'x',
    }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('not found'));
});

test('editFile preserves CRLF line endings', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 'crlf.txt',
    content: 'one\r\ntwo\r\nthree\r\n',
  });

  const result = await tools.editFile.execute({
    path: 'crlf.txt',
    oldText: 'two',
    newText: 'TWO',
  });
  t.is(result.applied, 1);

  const read = await tools.readFile.execute({ path: 'crlf.txt' });
  t.is(read.content, 'one\r\nTWO\r\nthree\r\n');
});

test('editFile throws for a missing file', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.editFile.execute({
      path: 'absent.txt',
      oldText: 'a',
      newText: 'b',
    }),
  );
  t.true(/** @type {Error} */ (err).message.includes('File not found'));
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

test('stat returns file metadata', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'info.txt', content: 'data' });

  const result = await tools.stat.execute({ path: 'info.txt' });
  t.true(result.success);
  t.is(result.type, 'file');
  t.is(result.size, 4);
  t.truthy(result.modified);
});

test('stat returns directory metadata', async t => {
  const tools = await setup();
  await tools.makeDirectory.execute({ path: 'mydir' });

  const result = await tools.stat.execute({ path: 'mydir' });
  t.true(result.success);
  t.is(result.type, 'directory');
});

test('stat throws for missing path', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() => tools.stat.execute({ path: 'ghost' }));
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('Path not found'));
});

// ---------------------------------------------------------------------------
// removeFile
// ---------------------------------------------------------------------------

test('removeFile deletes a file', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'rm-me.txt', content: 'bye' });

  const result = await tools.removeFile.execute({ path: 'rm-me.txt' });
  t.true(result.success);

  const err = await t.throwsAsync(() =>
    tools.readFile.execute({ path: 'rm-me.txt' }),
  );
  t.truthy(err);
});

test('removeFile throws for missing file', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.removeFile.execute({ path: 'no-such.txt' }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('File not found'));
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

test('listDirectory lists directory entries', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'a.txt', content: 'a' });
  await tools.writeFile.execute({ path: 'b.txt', content: 'bb' });
  await tools.makeDirectory.execute({ path: 'sub' });

  const result = await tools.listDirectory.execute({ path: '.' });
  t.true(result.success);
  t.is(result.entries.length, 3);

  const names = result.entries.map(e => e.name).sort();
  t.deepEqual(names, ['a.txt', 'b.txt', 'sub']);
});

test('listDirectory supports glob filtering', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'app.js', content: 'js' });
  await tools.writeFile.execute({ path: 'style.css', content: 'css' });
  await tools.writeFile.execute({ path: 'util.js', content: 'js2' });

  const result = await tools.listDirectory.execute({
    path: '.',
    glob: '*.js',
  });
  t.is(result.entries.length, 2);
  const names = result.entries.map(e => e.name).sort();
  t.deepEqual(names, ['app.js', 'util.js']);
});

test('listDirectory throws for missing directory', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.listDirectory.execute({ path: 'nope' }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('Directory not found'));
});

// ---------------------------------------------------------------------------
// makeDirectory
// ---------------------------------------------------------------------------

test('makeDirectory creates a directory', async t => {
  const tools = await setup();
  const result = await tools.makeDirectory.execute({ path: 'newdir' });
  t.true(result.success);
  t.true(result.created);

  const st = await tools.stat.execute({ path: 'newdir' });
  t.is(st.type, 'directory');
});

test('makeDirectory recursive creates nested dirs', async t => {
  const tools = await setup();
  const result = await tools.makeDirectory.execute({
    path: 'x/y/z',
    recursive: true,
  });
  t.true(result.success);
  t.true(result.created);

  const st = await tools.stat.execute({ path: 'x/y/z' });
  t.is(st.type, 'directory');
});

// ---------------------------------------------------------------------------
// removeDirectory
// ---------------------------------------------------------------------------

test('removeDirectory removes an empty directory', async t => {
  const tools = await setup();
  await tools.makeDirectory.execute({ path: 'emptydir' });
  const result = await tools.removeDirectory.execute({ path: 'emptydir' });
  t.true(result.success);

  const err = await t.throwsAsync(() =>
    tools.stat.execute({ path: 'emptydir' }),
  );
  t.truthy(err);
});

test('removeDirectory throws for non-empty dir without recursive', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'dir/file.txt', content: 'x' });

  const err = await t.throwsAsync(() =>
    tools.removeDirectory.execute({ path: 'dir' }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('not empty'));
});

test('removeDirectory recursive removes non-empty dir', async t => {
  const tools = await setup();
  await tools.writeFile.execute({ path: 'dir/file.txt', content: 'x' });

  const result = await tools.removeDirectory.execute({
    path: 'dir',
    recursive: true,
  });
  t.true(result.success);
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/**
 * Helper: seed a small tree for the search tools.
 *
 * @param {Awaited<ReturnType<typeof setup>>} tools
 */
const seedTree = async tools => {
  await tools.writeFile.execute({ path: 'a.js', content: 'const a = 1;\n' });
  await tools.writeFile.execute({ path: 'b.txt', content: 'plain text\n' });
  await tools.writeFile.execute({
    path: 'src/deep/c.js',
    content: 'const c = 3; // TODO(later)\n',
  });
  await tools.writeFile.execute({
    path: 'src/d.js',
    content: 'const d = 4;\n',
  });
};

test('glob matches within a segment with *', async t => {
  const tools = await setup();
  await seedTree(tools);

  const result = await tools.glob.execute({ pattern: '*.js' });
  t.true(result.success);
  t.deepEqual(result.matches, ['a.js']);
  t.false(result.truncated);
});

test('glob matches across segments with **', async t => {
  const tools = await setup();
  await seedTree(tools);

  const result = await tools.glob.execute({ pattern: '**/*.js' });
  t.deepEqual(result.matches, ['a.js', 'src/d.js', 'src/deep/c.js']);
});

test('glob walks from a subdirectory', async t => {
  const tools = await setup();
  await seedTree(tools);

  const result = await tools.glob.execute({ pattern: '**/*.js', path: 'src' });
  t.is(result.path, 'src');
  t.deepEqual(result.matches, ['d.js', 'deep/c.js']);
});

test('glob rejects paths escaping the root', async t => {
  const tools = await setup();
  await t.throwsAsync(() =>
    tools.glob.execute({ pattern: '*', path: '../outside' }),
  );
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

test('grep finds matching lines with file, line, and text', async t => {
  const tools = await setup();
  await seedTree(tools);

  const result = await tools.grep.execute({ pattern: 'TODO' });
  t.true(result.success);
  t.deepEqual(result.matches, [
    { file: 'src/deep/c.js', line: 1, text: 'const c = 3; // TODO(later)' },
  ]);
  t.false(result.truncated);
});

test('grep restricts the searched files with a glob', async t => {
  const tools = await setup();
  await seedTree(tools);

  const all = await tools.grep.execute({ pattern: 'const' });
  t.is(all.matches.length, 3);

  const only = await tools.grep.execute({
    pattern: 'const',
    glob: 'src/*.js',
  });
  t.deepEqual(
    only.matches.map(m => m.file),
    ['src/d.js'],
  );
});

test('grep searches from a subdirectory with relative paths', async t => {
  const tools = await setup();
  await seedTree(tools);

  const result = await tools.grep.execute({ pattern: 'const', path: 'src' });
  t.deepEqual(
    result.matches.map(m => m.file),
    ['d.js', 'deep/c.js'],
  );
});

test('grep uses ECMAScript regular expressions', async t => {
  const tools = await setup();
  await tools.writeFile.execute({
    path: 're.txt',
    content: 'alpha\nbeta-42\ngamma\n',
  });

  const result = await tools.grep.execute({ pattern: '\\w+-\\d+' });
  t.deepEqual(
    result.matches.map(m => m.line),
    [2],
  );
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('path traversal is rejected', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.readFile.execute({ path: '../../../etc/passwd' }),
  );
  t.truthy(err);
  t.true(
    /** @type {Error} */ (err).message.includes('must resolve under root'),
  );
});

test('null bytes in path are rejected', async t => {
  const tools = await setup();
  const err = await t.throwsAsync(() =>
    tools.readFile.execute({ path: 'foo\0bar' }),
  );
  t.truthy(err);
  t.true(/** @type {Error} */ (err).message.includes('null bytes'));
});
