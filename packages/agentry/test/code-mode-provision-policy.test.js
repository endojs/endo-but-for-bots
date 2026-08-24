// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';

const workspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-policy-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'child'));
  return root;
};

test('normalization translates compatibility bindings into a named graph', async t => {
  const root = await workspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { workspace: { mode: 'readWrite' }, git: 'readWrite' },
    { harness: 'test', sessionId: 'stable', cwd: root },
  );
  t.is(persistence.version, 3);
  t.is(persistence.authority.mount?.workspace.readOnly, false);
  t.is(persistence.authority.git?.git.mount, 'workspace');
  t.is(persistence.authority.git?.git.readOnly, false);
});

test('read-only root Git uses an internal mount without exposing filesystem authority', async t => {
  const root = await workspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { git: 'readOnly' },
    { harness: 'test', sessionId: 'git-only', cwd: root },
  );
  t.deepEqual(persistence.authority, {});
  const { internalGit } = persistence;
  if (internalGit === undefined) throw Error('expected internal Git backing');
  t.is(internalGit.path, await realpath(root));
  t.is(persistence.introducedNames[internalGit.gitName], 'git');
});

test('introducedNames preserves host-key to guest-value direction', async t => {
  const root = await workspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    {
      introducedNames: { 'calendar-service': 'calendar', '@endo': 'endo' },
    },
    { harness: 'test', sessionId: 'introduced', cwd: root },
  );
  t.deepEqual(persistence.introducedNames, {
    'calendar-service': 'calendar',
    '@endo': 'endo',
  });
  t.true(Object.isFrozen(persistence.introducedNames));
});

test('introducedNames rejects paths and invalid guest bindings', async t => {
  const root = await workspace(t);
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { introducedNames: { 'tools/calendar': 'calendar' } },
        { harness: 'test', sessionId: 'bad-host', cwd: root },
      ),
    { message: /host names to guest names/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { introducedNames: { service: 'not-a valid-binding' } },
        { harness: 'test', sessionId: 'bad-guest', cwd: root },
      ),
    { message: /JavaScript binding/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { introducedNames: { first: 'tool', second: 'tool' } },
        { harness: 'test', sessionId: 'duplicate-guest', cwd: root },
      ),
    { message: /distinct guest binding/ },
  );
});

test('normalization rejects reserved bindings and credential-shaped URL queries', async t => {
  const root = await workspace(t);
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { mounts: { class: { path: '.', mode: 'readOnly' } } },
        { harness: 'test', sessionId: 'reserved', cwd: root },
      ),
    { message: /non-reserved JavaScript binding/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          gitRemotes: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'https://example.test/repo?access_token=secret',
            },
          },
        },
        { harness: 'test', sessionId: 'secret-url', cwd: root },
      ),
    { message: /must not carry credential query fields/ },
  );
});

test('normalization preserves own __proto__ bindings and canonicalizes relative roots', async t => {
  const root = await workspace(t);
  const mounts = JSON.parse('{"__proto__":{"path":"child","mode":"readOnly"}}');
  const persistence = await normalizeEndoProvisionSpec(
    {
      workspace: { path: 'child', mode: 'readOnly' },
      mounts,
    },
    { harness: 'test', sessionId: 'own-proto', cwd: root },
  );
  const authorityMount = persistence.authority.mount;
  const specWorkspace = persistence.spec.workspace;
  const specMounts = persistence.spec.mounts;
  if (
    authorityMount === undefined ||
    specWorkspace === undefined ||
    specMounts === undefined
  ) {
    throw Error('expected normalized mounts');
  }
  t.true(Object.hasOwn(authorityMount, '__proto__'));
  t.is(specWorkspace.path, join(root, 'child'));
  t.is(
    /** @type {{ path: string }} */ (Reflect.get(specMounts, '__proto__')).path,
    join(root, 'child'),
  );

  const resumed = await normalizeEndoProvisionSpec(persistence.spec, {
    harness: 'test',
    sessionId: 'own-proto',
    cwd: tmpdir(),
  });
  t.deepEqual(resumed.authority, persistence.authority);
});
