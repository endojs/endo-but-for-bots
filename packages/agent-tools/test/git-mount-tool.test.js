// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { makeGitMountTools } from '../src/json-tools/git-mount.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitMountToolCapability } from '../src/types.js' */

/**
 * @param {{ statusRows?: unknown[], statusCalls?: unknown[][], truncated?: boolean }} [opts]
 * @returns {ERef<GitMountToolCapability>}
 */
const makeStubGit = ({
  statusRows = [],
  statusCalls = [],
  truncated = false,
} = {}) => {
  return /** @type {ERef<GitMountToolCapability>} */ (
    /** @type {unknown} */ (
      Far('StubGit', {
        status: async options => {
          statusCalls.push([options]);
          return harden({ entries: harden(statusRows), truncated });
        },
      })
    )
  );
};

test('makeGitMountTools builds the status record', t => {
  const tools = makeGitMountTools(makeStubGit());
  t.deepEqual(
    tools.map(tool => tool.name),
    ['status'],
  );
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

test('status on a clean tree returns an empty result', async t => {
  const tools = makeGitMountTools(makeStubGit());
  const rows = await byNameOf(tools)('status').invoke({});
  t.deepEqual(rows, { entries: [], truncated: false });
});
