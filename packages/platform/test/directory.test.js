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
const makeTemporaryDirectory = async _t => {
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
  const dir = await makeTemporaryDirectory(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const entries = await directory.list();

  t.deepEqual(entries, ['a.txt', 'b.json', 'sub']);

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory has', async t => {
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const file = await directory.lookup('a.txt');

  t.is(await file.text(), 'alpha');
  // Mutable — should have writeText
  t.is(typeof file.writeText, 'function');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory lookup subdirectory', async t => {
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const file = await directory.lookup(['sub', 'c.txt']);

  t.is(await file.text(), 'charlie');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory makeDirectory creates nested dir', async t => {
  const dir = await makeTemporaryDirectory(t);

  const directory = makeDirectory(dir);
  const nested = await directory.makeDirectory(['new', 'deep']);

  t.truthy(nested);
  const stat = await fs.promises.stat(path.join(dir, 'new', 'deep'));
  t.true(stat.isDirectory());

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory remove', async t => {
  const dir = await makeTemporaryDirectory(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);
  await directory.remove(['a.txt']);

  t.false(await directory.has('a.txt'));

  // Removing a non-empty directory with remove fails loud.
  await t.throwsAsync(() => directory.remove(['sub']));
  t.true(await directory.has('sub'));

  // removeTree opts in to subtree deletion.
  await directory.removeTree(['sub']);
  t.false(await directory.has('sub'));

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory move', async t => {
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
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
  const dir = await makeTemporaryDirectory(t);
  await scaffold(dir);

  const directory = makeDirectory(dir);

  await t.throwsAsync(() => directory.snapshot(), {
    message: 'No snapshot store provided',
  });

  await fs.promises.rm(dir, { recursive: true });
});

test('makeDirectory ignores .git by default', async t => {
  const dir = await makeTemporaryDirectory(t);
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

test('makeDirectory makeDirectoryHere creates a child directory by name', async t => {
  const dir = await makeTemporaryDirectory(t);
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const directory = makeDirectory(dir);
  // The single-name "in directory" form: operates on the receiver's
  // identity rather than via path-segment arithmetic.  See design
  // Decision 7.
  const child = await directory.makeDirectoryHere('child');

  t.truthy(child);
  const stat = await fs.promises.stat(path.join(dir, 'child'));
  t.true(stat.isDirectory());

  // The returned child is itself a Directory; verify by writing a
  // grand-child through it, again using makeDirectoryHere.
  const grandChild = await child.makeDirectoryHere('grand');
  t.truthy(grandChild);
  const grandStat = await fs.promises.stat(path.join(dir, 'child', 'grand'));
  t.true(grandStat.isDirectory());
});

// Pre-existing bug exposed by writing this test: directory.write's
// tree-detection branch calls
//   const writer = makeTreeWriter(target);
//   await checkoutTree(value, writer);
// and `checkoutTree` then calls `writer.writeBlob(childPath, readable)`
// where `readable = makeRefReader(readerRef)` is a raw AsyncGenerator
// produced by `mapReader`.  TreeWriterInterface.writeBlob declares its
// second arg as `M.remotable()`, but the raw AsyncGenerator is a
// hardened plain object with `constructor` (and other inherited
// non-method properties) that fail the remotable shape check with:
//   "cannot serialize Remotables with non-methods like \"constructor\"
//   in \"[AsyncGenerator]\""
//
// The fix is structural and lives outside this PR's scope: either
//   (a) loosen TreeWriterInterface.writeBlob's second-arg guard to
//       M.any() with an explicit AsyncIterable shape comment, or
//   (b) wrap `readable` in an Exo before passing it to writeBlob in
//       checkoutTree (and in directory.write's blob branch).
//
// Filed as a known gap in the cleaner pass on PR #122; leaving the
// tree-write branch in directory.js (the `methods.includes('list')`
// path) genuinely uncovered until the fix lands as a follow-up so a
// future reader sees the gap rather than a misleading green test.
test.skip('directory.write accepts a tree (TreeWriterInterface guard rejects raw AsyncGenerator)', () => {});

test('makeDirectory snapshot delegates to the store', async t => {
  const dir = await makeTemporaryDirectory(t);
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));
  await scaffold(dir);

  const fakeTree = harden({ list: async () => ['fake-tree'] });
  /** @type {{ [k: string]: any }} */
  const calls = { storedReadables: 0, loadTreeCalledWith: undefined };
  const fakeStore = harden({
    store: async readable => {
      calls.storedReadables += 1;
      // Drain the readable; chunk values are intentionally ignored.
      // eslint-disable-next-line no-unused-vars
      for await (const chunk of readable) {
        /* drain */
      }
      return `sha-${calls.storedReadables}`;
    },
    loadBlob: () => harden({ text: async () => 'fake-blob' }),
    loadTree: sha => {
      calls.loadTreeCalledWith = sha;
      return fakeTree;
    },
    has: async () => true,
    fetch: () => {
      throw new Error('fetch not implemented in fake');
    },
  });

  const directory = makeDirectory(dir, {
    store: /** @type {any} */ (fakeStore),
  });
  const tree = await directory.snapshot();

  t.is(tree, fakeTree, 'snapshot returns the loaded tree');
  t.is(
    typeof calls.loadTreeCalledWith,
    'string',
    'loadTree was called with a sha',
  );
});

test('makeDirectory readOnly tree lookup descends and reads files', async t => {
  const dir = await makeTemporaryDirectory(t);
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));
  await scaffold(dir);

  const directory = makeDirectory(dir);
  const ro = directory.readOnly();

  // Lookup a sub-directory through readOnly returns a ReadableTree
  // for the sub-directory; further lookup descends.
  const sub = await ro.lookup('sub');
  t.is(typeof sub.list, 'function', 'sub is itself a ReadableTree');
  t.deepEqual(await sub.list(), ['c.txt']);

  // Multi-segment lookup via array on the readOnly facet.
  const cBlob = await ro.lookup(['sub', 'c.txt']);
  t.is(await cBlob.text(), 'charlie');

  // Listing inside a readOnly subdirectory.
  t.true(await ro.has('sub', 'c.txt'));
  t.false(await ro.has('sub', 'missing'));
});
