// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import { makeGitMountTools } from '../src/json-tools/git-mount.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitMountToolCapability } from '../src/types.js' */

/**
 * A stub mount whose `entry(pathArg)` mints an inert Far entry that remembers
 * the segments it was resolved from, mirroring the daemon mount's
 * `entry().segments()` contract that `Git.add` consumes.
 */
const makeStubMount = () =>
  Far('StubMount', {
    entry: pathArg => {
      const segments = Array.isArray(pathArg)
        ? [...pathArg]
        : String(pathArg).split('/');
      return Far('StubMountEntry', {
        segments: () => harden([...segments]),
      });
    },
  });

/**
 * Stub Git capability that bridges through a stub mount.
 * The mutating methods record the repo-relative path each supplied entry
 * resolves to, so a test can assert the path→entry marshalling reached the cap
 * intact.
 *
 * @param {{ statusRows?: unknown[], statusCalls?: unknown[][], truncated?: boolean, addCalls?: unknown[][], checkoutConflictCalls?: unknown[][] }} [opts]
 * @returns {ERef<GitMountToolCapability>}
 */
const makeStubGit = ({
  statusRows = [],
  statusCalls = [],
  truncated = false,
  addCalls = [],
  checkoutConflictCalls = [],
} = {}) => {
  const mount = makeStubMount();
  return /** @type {ERef<GitMountToolCapability>} */ (
    /** @type {unknown} */ (
      Far('StubGit', {
        worktree: async () => mount,
        status: async options => {
          statusCalls.push([options]);
          return harden({ entries: harden(statusRows), truncated });
        },
        add: async entries => {
          await null;
          const paths = await Promise.all(
            entries.map(async entry => {
              await null;
              const segments = await E(entry).segments();
              return segments.join('/');
            }),
          );
          addCalls.push(paths);
        },
        checkoutConflict: async (entries, side) => {
          await null;
          const paths = await Promise.all(
            entries.map(async entry => {
              await null;
              const segments = await E(entry).segments();
              return segments.join('/');
            }),
          );
          checkoutConflictCalls.push([paths, side]);
        },
      })
    )
  );
};

test('makeGitMountTools builds status, add, and checkoutConflict records', t => {
  const tools = makeGitMountTools(makeStubGit());
  const names = tools.map(tool => tool.name).sort();
  t.deepEqual(names, ['add', 'checkoutConflict', 'status']);
  for (const tool of tools) {
    t.is(typeof tool.description, 'string');
    t.truthy(tool.parameters);
    t.is(tool.inputSchema, tool.parameters);
    t.is(typeof tool.invoke, 'function');
  }
});

const byNameOf = tools => name => {
  const found = tools.find(tool => tool.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

test('status returns copy-data rows and defaults untracked mode to normal', async t => {
  const statusRows = harden([
    {
      path: 'src/a.js',
      index: 'modified',
      worktree: 'clean',
    },
    {
      path: 'src/b.js',
      index: 'renamed',
      worktree: 'clean',
      renamedFrom: 'src/old.js',
    },
    {
      path: 'gone.js',
      index: 'deleted',
      worktree: 'deleted',
    },
  ]);
  const statusCalls = [];
  const tools = makeGitMountTools(makeStubGit({ statusRows, statusCalls }));
  const result = await byNameOf(tools)('status').invoke({});
  t.deepEqual(result, { entries: statusRows, truncated: false });
  t.deepEqual(statusCalls, [[{ untracked: 'normal' }]]);
  for (const row of /** @type {object[]} */ (result.entries)) {
    t.false('entry' in row);
    t.false('node' in row);
  }
});

test('status forwards maxCount and untracked options and preserves truncation', async t => {
  const statusCalls = [];
  const tools = makeGitMountTools(
    makeStubGit({
      statusRows: [{ path: 'a', index: 'clean', worktree: 'untracked' }],
      statusCalls,
      truncated: true,
    }),
  );
  const result = await byNameOf(tools)('status').invoke({
    options: { maxCount: 1, untracked: 'all' },
  });
  t.deepEqual(result, {
    entries: [{ path: 'a', index: 'clean', worktree: 'untracked' }],
    truncated: true,
  });
  t.deepEqual(statusCalls, [[{ untracked: 'all', maxCount: 1 }]]);
});

test('status rejects a stray argument key', async t => {
  const tools = makeGitMountTools(makeStubGit());
  await t.throwsAsync(() => byNameOf(tools)('status').invoke({ path: 'x' }));
});

test('add resolves path strings to mount entries and calls the cap', async t => {
  const addCalls = [];
  const tools = makeGitMountTools(makeStubGit({ addCalls }));
  const result = await byNameOf(tools)('add').invoke({
    paths: ['src/a.js', 'src/dir/b.js'],
  });
  t.deepEqual(addCalls, [['src/a.js', 'src/dir/b.js']]);
  t.is(result, 'Staged 2 paths.');
});

test('checkoutConflict resolves path strings and side to the cap', async t => {
  const checkoutConflictCalls = [];
  const tools = makeGitMountTools(makeStubGit({ checkoutConflictCalls }));
  const result = await byNameOf(tools)('checkoutConflict').invoke({
    paths: ['src/a.js', 'src/dir/b.js'],
    side: 'theirs',
  });
  t.deepEqual(checkoutConflictCalls, [
    [['src/a.js', 'src/dir/b.js'], 'theirs'],
  ]);
  t.is(result, 'Selected theirs for 2 conflicted paths.');
});

test('checkoutConflict descriptions use index stages and explain rebase roles', t => {
  const checkoutConflict = byNameOf(makeGitMountTools(makeStubGit()))(
    'checkoutConflict',
  );
  const side = /** @type {{ description: string, type: string }} */ (
    /** @type {{ properties: { side: object } }} */ (
      checkoutConflict.parameters
    ).properties.side
  );

  t.is(side.type, 'string');
  for (const phrase of ['stage 2', 'stage 3', 'index', 'rebase', 'inverted']) {
    t.true(checkoutConflict.description.includes(phrase));
    t.true(side.description.includes(phrase));
  }
  t.false(checkoutConflict.description.includes('current branch side'));
  t.false(side.description.includes('incoming side'));
});

test('checkoutConflict rejects bad side/path shapes', async t => {
  const checkoutConflictCalls = [];
  const tools = makeGitMountTools(makeStubGit({ checkoutConflictCalls }));
  const byName = byNameOf(tools);
  await t.throwsAsync(
    () =>
      byName('checkoutConflict').invoke({
        paths: ['a.js'],
        side: 'base',
      }),
    { message: /side/ },
  );
  await t.throwsAsync(
    () =>
      byName('checkoutConflict').invoke({
        paths: [],
        side: 'ours',
      }),
    { message: /non-empty/ },
  );
  await t.throwsAsync(
    () =>
      byName('checkoutConflict').invoke({
        paths: ['.'],
        side: 'ours',
      }),
    { message: /worktree root/ },
  );
  t.deepEqual(checkoutConflictCalls, []);
});

test('add normalizes redundant path separators before resolving', async t => {
  const addCalls = [];
  const tools = makeGitMountTools(makeStubGit({ addCalls }));
  await byNameOf(tools)('add').invoke({ paths: ['a//b/', './c'] });
  t.deepEqual(addCalls, [['a/b', 'c']]);
});

test('add reports the singular staged path', async t => {
  const addCalls = [];
  const tools = makeGitMountTools(makeStubGit({ addCalls }));
  const result = await byNameOf(tools)('add').invoke({ paths: ['only.js'] });
  t.is(result, 'Staged 1 path.');
});

test('add rejects an empty path list and an empty-string path', async t => {
  const tools = makeGitMountTools(makeStubGit());
  const byName = byNameOf(tools);
  await t.throwsAsync(() => byName('add').invoke({ paths: [] }), {
    message: /non-empty/,
  });
  await t.throwsAsync(() => byName('add').invoke({ paths: ['a', ''] }), {
    message: /non-empty strings/,
  });
});

test('add rejects a non-string path element and a missing/extra key', async t => {
  const tools = makeGitMountTools(makeStubGit());
  const byName = byNameOf(tools);
  await null;
  // The runtime guard (M.arrayOf(M.string())) rejects a non-string element.
  await t.throwsAsync(() => byName('add').invoke({ paths: ['a', 42] }));
  // Missing the required `paths` key is rejected before the cap is touched.
  const missing = await t.throwsAsync(() => byName('add').invoke({}));
  t.true(missing !== undefined && missing.message.includes('paths'));
  // An out-of-band key is rejected fail-closed.
  const extra = await t.throwsAsync(() =>
    byName('add').invoke({ paths: ['a'], bogus: 'x' }),
  );
  t.true(extra !== undefined && extra.message.includes('bogus'));
});

test('add rejects a path that resolves to the worktree root', async t => {
  const addCalls = [];
  const tools = makeGitMountTools(makeStubGit({ addCalls }));
  const byName = byNameOf(tools);
  // '.', '/', '//', and './' all collapse to zero segments under
  // `pathToSegments`; each would otherwise resolve to the worktree-root entry
  // and reach the cap as an empty pathspec, so the tool rejects them before
  // touching the mount.
  await t.throwsAsync(() => byName('add').invoke({ paths: ['.'] }), {
    message: /worktree root/,
  });
  await t.throwsAsync(() => byName('add').invoke({ paths: ['/'] }), {
    message: /worktree root/,
  });
  await t.throwsAsync(() => byName('add').invoke({ paths: ['//'] }), {
    message: /worktree root/,
  });
  await t.throwsAsync(() => byName('add').invoke({ paths: ['./'] }), {
    message: /worktree root/,
  });
  // A root-collapsing path mixed with a real one is still rejected, and
  // nothing partial reaches the cap.
  await t.throwsAsync(() => byName('add').invoke({ paths: ['real.js', '.'] }), {
    message: /worktree root/,
  });
  t.deepEqual(
    addCalls,
    [],
    'no staging reaches the cap when a path is rejected',
  );
});

test('add forwards a ".." segment to the capability, unfiltered', async t => {
  const addCalls = [];
  const tools = makeGitMountTools(makeStubGit({ addCalls }));
  // The tool does not reject `..` with a brittle string check; it passes the
  // resolved segments to the mount, which contains the traversal (clamped at
  // the worktree root). This pins that containment is the capability's job,
  // not the tool's.
  await byNameOf(tools)('add').invoke({ paths: ['../x', 'a/../b'] });
  t.deepEqual(addCalls, [['../x', 'a/../b']]);
});

test('status on a clean tree returns an empty result', async t => {
  const tools = makeGitMountTools(makeStubGit());
  const rows = await byNameOf(tools)('status').invoke({});
  t.deepEqual(rows, { entries: [], truncated: false });
});
