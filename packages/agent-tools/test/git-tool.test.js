// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { makeGitTool } from '../src/git-tool.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitStatusEntry } from '@endo/exo-git' */
/** @import { GitToolCapability } from '../src/types.js' */

const SLICE = [
  'log',
  'diff',
  'status',
  'add',
  'show',
  'commit',
  'branches',
  'createBranch',
  'switchBranch',
  'currentBranch',
];

/**
 * Stub Git capability that records the method name and positional args.
 *
 * @param {unknown[][]} calls An array each call appends its `[name, ...args]` to.
 * @param {GitStatusEntry[]} [statusRows]
 * @returns {ERef<GitToolCapability>}
 */
const makeStubGit = (calls, statusRows = []) => {
  /** @type {GitToolCapability} */
  const stubGit = {
    log: async (...a) => {
      calls.push(['log', ...a]);
      return [];
    },
    diff: async (...a) => {
      calls.push(['diff', ...a]);
      return '';
    },
    status: async (...a) => {
      calls.push(['status', ...a]);
      return harden(statusRows);
    },
    add: async (...a) => {
      calls.push(['add', ...a]);
    },
    show: async (...a) => {
      calls.push(['show', ...a]);
      return '';
    },
    commit: async (...a) => {
      calls.push(['commit', ...a]);
      return { oid: 'x', summary: a[0] };
    },
    branches: async (...a) => {
      calls.push(['branches', ...a]);
      return [];
    },
    createBranch: async (...a) => {
      calls.push(['createBranch', ...a]);
      return { name: a[0], kind: 'branch' };
    },
    switchBranch: async (...a) => {
      calls.push(['switchBranch', ...a]);
    },
    currentBranch: async (...a) => {
      calls.push(['currentBranch', ...a]);
      return undefined;
    },
  };
  return Far('StubGit', stubGit);
};

test('makeGitTool builds one record per non-remotable-slice method', t => {
  const tools = makeGitTool(makeStubGit([]));
  t.is(tools.length, SLICE.length);
  const names = tools.map(tool => tool.name).sort();
  t.deepEqual(names, [...SLICE].sort());
  for (const tool of tools) {
    t.is(typeof tool.description, 'string');
    t.truthy(tool.parameters);
    t.is(tool.inputSchema, tool.parameters);
    t.is(typeof tool.invoke, 'function');
  }
});

test('makeGitTool omits cap-heavy methods', t => {
  const tools = makeGitTool(makeStubGit([]));
  const names = new Set(tools.map(tool => tool.name));
  t.false(names.has('restore'));
  t.false(names.has('filesystemAt'));
  t.false(names.has('merge'));
  t.false(names.has('rebase'));
});

test('invoke marshals named args to positional and calls the capability', async t => {
  const calls = [];
  const tools = makeGitTool(makeStubGit(calls));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  await byName('commit').invoke({ message: 'a message' });
  await byName('createBranch').invoke({ name: 'feature' });
  await byName('createBranch').invoke({ name: 'feature', options: harden({}) });
  await byName('log').invoke({});

  t.deepEqual(calls, [
    ['commit', 'a message'],
    ['createBranch', 'feature'],
    ['createBranch', 'feature', {}],
    ['log'],
  ]);
});

test('invoke rejects an arg that violates the runtime guard', async t => {
  const tools = makeGitTool(makeStubGit([]));
  const commit = tools.find(tool => tool.name === 'commit');
  if (!commit) throw new Error('no commit tool');
  await null;
  await t.throwsAsync(() => commit.invoke({ message: 123 }));
});

test('the schemas advertise real, declarative property names', t => {
  const tools = makeGitTool(makeStubGit([]));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };
  const propsOf = name =>
    Object.keys(
      /** @type {{ properties?: object }} */ (byName(name).parameters)
        .properties || {},
    );

  // No method advertises the generic `argN` convention any more.
  for (const tool of tools) {
    const props = Object.keys(
      /** @type {{ properties?: object }} */ (tool.parameters).properties || {},
    );
    for (const prop of props) {
      t.false(
        /^arg\d+$/.test(prop),
        `${tool.name} should not advertise a generic argN property; got ${prop}`,
      );
    }
  }

  t.deepEqual(propsOf('commit'), ['message']);
  t.deepEqual(propsOf('show'), ['ref']);
  t.deepEqual(propsOf('createBranch'), ['name', 'options']);
  t.deepEqual(propsOf('switchBranch'), ['branch']);
  t.deepEqual(propsOf('status'), []);
  t.deepEqual(propsOf('add'), ['paths']);
  t.deepEqual(propsOf('log'), ['options']);
  t.deepEqual(propsOf('diff'), ['options']);
});

test('invoke resolves named args by their real property names', async t => {
  const calls = [];
  const tools = makeGitTool(makeStubGit(calls));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  await byName('show').invoke({ ref: 'HEAD' });
  await byName('switchBranch').invoke({ branch: 'feature' });
  await byName('log').invoke({ options: harden({ maxCount: 3 }) });

  t.deepEqual(calls, [
    ['show', 'HEAD'],
    ['switchBranch', 'feature'],
    ['log', { maxCount: 3 }],
  ]);
});

test('status returns only JSON-safe row fields', async t => {
  const entry = Far('Entry', {});
  const node = Far('Node', {});
  const tools = makeGitTool(
    makeStubGit(
      [],
      [
        harden({
          entry,
          node,
          path: 'src/a.js',
          index: 'modified',
          worktree: 'clean',
        }),
        harden({
          entry,
          path: 'src/b.js',
          index: 'renamed',
          worktree: 'modified',
          renamedFrom: 'src/old-b.js',
        }),
      ],
    ),
  );
  const status = tools.find(tool => tool.name === 'status');
  if (!status) throw new Error('no status tool');

  const rows = /** @type {Array<Record<string, unknown>>} */ (
    await status.invoke({})
  );
  t.deepEqual(rows, [
    { path: 'src/a.js', index: 'modified', worktree: 'clean' },
    {
      path: 'src/b.js',
      index: 'renamed',
      worktree: 'modified',
      renamedFrom: 'src/old-b.js',
    },
  ]);
  t.false(Object.hasOwn(/** @type {object} */ (rows[0]), 'entry'));
  t.false(Object.hasOwn(/** @type {object} */ (rows[0]), 'node'));
});

test('add resolves repo-relative paths through status rows before staging', async t => {
  const calls = [];
  const entryA = Far('EntryA', {});
  const entryB = Far('EntryB', {});
  const tools = makeGitTool(
    makeStubGit(calls, [
      harden({
        entry: entryA,
        path: 'a.txt',
        index: 'modified',
        worktree: 'modified',
      }),
      harden({
        entry: entryB,
        path: 'sub/b.txt',
        index: 'clean',
        worktree: 'untracked',
      }),
    ]),
  );
  const add = tools.find(tool => tool.name === 'add');
  if (!add) throw new Error('no add tool');

  await add.invoke({ paths: ['sub/b.txt', 'a.txt'] });

  t.is(calls.length, 2);
  t.deepEqual(calls[0], ['status']);
  t.is(calls[1][0], 'add');
  t.deepEqual(calls[1][1], [entryB, entryA]);
});

test('add rejects paths not present in status before staging', async t => {
  const calls = [];
  const tools = makeGitTool(
    makeStubGit(calls, [
      harden({
        entry: Far('Entry', {}),
        path: 'a.txt',
        index: 'modified',
        worktree: 'modified',
      }),
    ]),
  );
  const add = tools.find(tool => tool.name === 'add');
  if (!add) throw new Error('no add tool');

  const err = await t.throwsAsync(() => add.invoke({ paths: ['missing.txt'] }));
  t.true(
    err !== undefined && err.message.includes('missing.txt'),
    `error should name the unresolved path; got: ${err?.message}`,
  );
  t.deepEqual(calls, [['status']]);
});

test('invoke rejects a wrong property name and a missing required one', async t => {
  const tools = makeGitTool(makeStubGit([]));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  // The legacy `arg0` key is no longer accepted; `commit` wants `message`.
  const wrongName = await t.throwsAsync(() =>
    byName('commit').invoke({ arg0: 'a message' }),
  );
  t.true(
    wrongName !== undefined && wrongName.message.includes('arg0'),
    `error should name the offending key; got: ${wrongName?.message}`,
  );

  // Omitting the required `message` is rejected before the capability is hit.
  const missing = await t.throwsAsync(() => byName('commit').invoke({}));
  t.true(
    missing !== undefined && missing.message.includes('message'),
    `error should name the missing required key; got: ${missing?.message}`,
  );
});
