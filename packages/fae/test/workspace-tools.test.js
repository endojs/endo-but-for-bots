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

  // Every tool presents the shape the inbox loop dispatches through.
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

test('a granted GitRemote adds the push tier', async t => {
  const { git: granted } = await makeWorkspaceGit(t);
  const remote = makeExo('GitRemote', M.interface('GitRemote', {}), {});
  const tools = await provisionFaeWorkspaceTools({
    git: granted,
    remote: /** @type {any} */ (remote),
  });
  for (const name of ['fetch', 'pull', 'push']) {
    t.true(tools.has(name), `${name} offered`);
  }
});
