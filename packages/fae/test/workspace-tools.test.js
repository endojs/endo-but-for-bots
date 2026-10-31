// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { provisionFaeWorkspaceTools } from '../src/workspace-tools.js';
import { git, makeWorkspaceGit } from './workspace-git-fixture.js';

test('a writable Git yields file and writer git tools that edit and commit its worktree', async t => {
  const { git: granted, root } = await makeWorkspaceGit(t);
  const tools = await provisionFaeWorkspaceTools({ git: granted });

  for (const name of [
    'mountReadText',
    'mountWriteText',
    'status',
    'add',
    'commit',
    'log',
  ]) {
    t.true(tools.has(name), `${name} offered`);
  }
  for (const name of ['push', 'fetch', 'reword', 'rebase']) {
    t.false(tools.has(name), `${name} withheld`);
  }

  for (const [name, tool] of tools) {
    t.is(tool.schema().function.name, name);
    t.is(typeof tool.help(), 'string');
  }

  const call = (/** @type {string} */ name, /** @type {any} */ toolArguments) =>
    /** @type {any} */ (tools.get(name)).execute(toolArguments);

  t.is(
    await call('mountReadText', { path: 'README.md' }),
    'hello\n',
    'the file tools read the granted worktree',
  );
  await call('mountWriteText', { path: 'notes.md', content: 'from fae\n' });
  await call('add', { paths: ['notes.md'] });
  await call('commit', { message: 'add notes' });

  t.is(
    await fs.promises.readFile(path.join(root, 'notes.md'), 'utf8'),
    'from fae\n',
  );
  t.is(
    (await git(root, ['log', '-1', '--format=%s|%an|%ae'])).trim(),
    'add notes|Fae Agent|fae@example.test',
    'the commit carries the identity the Git formula fixed, not one the agent chose',
  );
});

test('a read-only Git yields only reader tools', async t => {
  const { git: granted } = await makeWorkspaceGit(t);
  const tools = await provisionFaeWorkspaceTools({
    git: await E(granted).readOnly(),
  });

  for (const name of ['mountReadText', 'status', 'log', 'diff']) {
    t.true(tools.has(name), `${name} offered`);
  }
  for (const name of ['mountWriteText', 'add', 'commit', 'createBranch']) {
    t.false(tools.has(name), `${name} withheld from a read-only grant`);
  }
});

const GitRemoteStubI = M.interface('GitRemote', {}, { defaultGuards: 'raw' });
const RecordingGitI = M.interface('Git', {}, { defaultGuards: 'raw' });

/**
 * A `GitRemote` stand-in that records which of its methods the tools reach.
 *
 * @param {string[]} calls
 */
const makeRecordingRemote = calls =>
  makeExo('GitRemote', GitRemoteStubI, {
    fetch: async () => {
      calls.push('fetch');
      return harden({ success: true });
    },
    pull: async () => {
      calls.push('pull');
      return harden({ success: true });
    },
    push: async () => {
      calls.push('push');
      return harden({ success: true });
    },
    inspect: async () => harden({ name: 'origin' }),
    credentialHealth: async () => harden({ required: false }),
    help: () => 'recording remote',
  });

test('a granted GitRemote adds the push tier, and its tools reach that remote', async t => {
  const { git: granted } = await makeWorkspaceGit(t);
  /** @type {string[]} */
  const calls = [];
  const tools = await provisionFaeWorkspaceTools({
    git: granted,
    remote: makeRecordingRemote(calls),
  });
  for (const name of ['fetch', 'pull', 'push']) {
    t.true(tools.has(name), `${name} offered`);
  }
  const call = (/** @type {string} */ name) =>
    /** @type {any} */ (tools.get(name)).execute({});
  t.deepEqual(await call('push'), { success: true });
  await call('fetch');
  t.deepEqual(calls, ['push', 'fetch']);
});

test('a read-only Git cannot be paired with a GitRemote', async t => {
  const { git: granted } = await makeWorkspaceGit(t);
  /** @type {string[]} */
  const calls = [];
  await t.throwsAsync(
    provisionFaeWorkspaceTools({
      git: await E(granted).readOnly(),
      remote: makeRecordingRemote(calls),
    }),
    { message: /read-only workspace Git cannot be granted with a GitRemote/ },
  );
  t.deepEqual(calls, []);
});

test('the tools of a writable Git hold its writer scope, not the rewriter', async t => {
  const { git: granted } = await makeWorkspaceGit(t);
  /** @type {string[]} */
  const scopes = [];
  // Forward to the real Git, but record the scope the provisioner asks for
  // and expose every method the full Git carries, including `reword`.
  const unreached = () => {
    throw Error('only scope is reached');
  };
  const recordingGit = makeExo('Git', RecordingGitI, {
    add: unreached,
    commit: unreached,
    reword: unreached,
    scope: (/** @type {'writer'} */ level) => {
      scopes.push(level);
      return E(granted).scope(level);
    },
  });
  const tools = await provisionFaeWorkspaceTools({
    git: /** @type {any} */ (recordingGit),
  });
  t.deepEqual(scopes, ['writer']);
  for (const name of ['reword', 'rebase', 'cherryPick']) {
    t.false(tools.has(name), `${name} withheld`);
  }
  t.true(tools.has('commit'));
});
