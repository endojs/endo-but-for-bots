// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { resolveSharedWorkspaceHostPath } from '../agent.js';
import { makeFlootToolRegistry } from '../src/tool-registry.js';

test('extra tools join the session catalog beside the built-ins', async t => {
  const powers = Far('SessionPowers', {
    has: () => false,
    list: async () => harden([]),
    lookup: async () => {
      throw Error('no stored tools');
    },
  });
  const publish = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'publishWorkspace',
          description: 'publish',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => 'http://host/token/',
    help: () => 'publish',
  });
  const registry = makeFlootToolRegistry(powers, {
    extraTools: new Map([['publishWorkspace', publish]]),
  });
  const snapshot = await registry.snapshot();
  t.true(snapshot.names.includes('publishWorkspace'));
  t.true(snapshot.names.includes('exec'));
  t.is(await snapshot.execute('publishWorkspace', {}), 'http://host/token/');
  const without = await makeFlootToolRegistry(powers).snapshot();
  t.not(
    snapshot.toolSetId,
    without.toolSetId,
    'a different set of endowed tools has a different identity',
  );
});

test('resolveSharedWorkspaceHostPath resolves a git workspace worktree', async t => {
  const worktree = Far('Worktree', {});
  const workspace = Far('EndoGit', {
    worktree: async () => worktree,
    status: async () => harden({ entries: [], truncated: false }),
  });
  const guest = Far('Guest', {
    has: async name => name === 'workspace',
    lookup: async name => {
      if (name !== 'workspace') throw Error('missing');
      return workspace;
    },
  });
  const host = Far('Host', {
    provideHostPath: async mount => {
      t.is(mount, worktree);
      return '/var/lib/endo/scratch/session-a';
    },
  });
  const resolved = await resolveSharedWorkspaceHostPath(host, guest);
  t.is(resolved, '/var/lib/endo/scratch/session-a');

  // The preset names the workspace: a git workspace bound under another pet
  // name resolves by that name.
  const named = Far('Guest', {
    has: async name => name === 'project',
    lookup: async name => {
      if (name !== 'project') throw Error('missing');
      return workspace;
    },
  });
  t.is(
    await resolveSharedWorkspaceHostPath(host, named, 'project'),
    '/var/lib/endo/scratch/session-a',
  );

  // No workspace, or a workspace that is not a git repository: nothing to
  // share, and never an error.
  const bare = Far('Guest', { has: async () => false, lookup: async () => {} });
  t.is(await resolveSharedWorkspaceHostPath(host, bare), undefined);
  const plainMount = Far('Guest', {
    has: async () => true,
    lookup: async () => Far('Mount', { list: async () => harden([]) }),
  });
  t.is(await resolveSharedWorkspaceHostPath(host, plainMount), undefined);
});
