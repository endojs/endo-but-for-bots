// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExo } from '@endo/exo';
import { Far } from '@endo/marshal';
import { M } from '@endo/patterns';

import {
  provisionLalWorkspaceTools,
  resolveLalWorkspace,
} from '../workspace-tools.js';

const GitInterface = M.interface('Git', {}, { defaultGuards: 'raw' });

/**
 * @param {string[]} calls
 * @param {boolean} writable
 */
const makeRecordingGit = (calls, writable) => {
  const methods = {
    worktree: async () => Far('Mount', {}),
    log: async () => {
      calls.push('log');
      return harden([{ subject: 'initial' }]);
    },
    status: async () => harden({ entries: [], truncated: false }),
  };
  if (!writable) {
    return makeExo('ReadOnlyGit', GitInterface, methods);
  }
  const writer = makeExo('WriterGit', GitInterface, {
    ...methods,
    add: async () => undefined,
    commit: async () => harden({ oid: 'abc' }),
  });
  return makeExo('RewriterGit', GitInterface, {
    ...methods,
    add: async () => undefined,
    commit: async () => harden({ oid: 'abc' }),
    reword: async () => undefined,
    scope: async level => {
      calls.push(`scope:${level}`);
      return writer;
    },
  });
};

test('Lal registers confined workspace records as Pi tools over a writer Git', async t => {
  /** @type {string[]} */
  const calls = [];
  const tools = await provisionLalWorkspaceTools({
    git: makeRecordingGit(calls, true),
  });
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  for (const name of [
    'mountReadText',
    'mountWriteText',
    'status',
    'log',
    'add',
  ]) {
    t.true(byName.has(name), `${name} registered`);
  }
  for (const name of ['reword', 'rebase', 'push']) {
    t.false(byName.has(name), `${name} withheld`);
  }

  const log = byName.get('log');
  if (log === undefined) {
    throw new Error('log tool was not registered');
  }
  const result = await log.execute('call-log', {}, undefined);
  t.deepEqual(result.details, [{ subject: 'initial' }]);
  t.deepEqual(calls, ['scope:writer', 'log']);
});

test('Lal registers only reader tools over a read-only Git', async t => {
  /** @type {string[]} */
  const calls = [];
  const tools = await provisionLalWorkspaceTools({
    git: makeRecordingGit(calls, false),
  });
  const names = new Set(tools.map(tool => tool.name));

  for (const name of ['mountReadText', 'status', 'log']) {
    t.true(names.has(name), `${name} registered`);
  }
  for (const name of ['mountWriteText', 'add', 'commit', 'createBranch']) {
    t.false(names.has(name), `${name} withheld`);
  }
  t.deepEqual(calls, []);
});

test('Lal resolves workspace names once through its manager store', async t => {
  /** @type {string[]} */
  const calls = [];
  const store = Far('ManagerStore', {
    lookup: async name => {
      calls.push(name);
      return Far(`Capability ${name}`, {});
    },
  });

  const workspace = await resolveLalWorkspace(store, {
    git: ' workspace ',
    remote: ' origin ',
  });

  t.truthy(workspace);
  t.deepEqual(calls, ['workspace', 'origin']);
});

test('Lal rejects a remote that is not paired with a Git workspace', async t => {
  const store = Far('UnusedManagerStore', {
    lookup: async _name => Far('UnusedCapability', {}),
  });

  await t.throwsAsync(resolveLalWorkspace(store, { remote: 'origin' }), {
    message: 'A Git remote requires a Git workspace',
  });
});
