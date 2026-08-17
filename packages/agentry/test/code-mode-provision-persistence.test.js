// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  equalEndoProvisionPersistence,
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from '../src/code-mode-provision-policy.js';

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  await null;
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-persistence-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('persistence validation accepts only normalized records', async t => {
  const root = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readOnly',
      piTools: 'preserve',
      workspace: { deniedSegments: ['private', '.git'] },
    },
    { harness: 'test', sessionId: 'persist', cwd: root },
  );

  t.deepEqual(await validateEndoProvisionPersistence(persistence), persistence);
  t.is(persistence.policy.piTools, 'preserve');
  t.true(Object.isFrozen(persistence));
  t.true(Object.isFrozen(persistence.guestHandlePath));
  t.true(Object.isFrozen(persistence.policy));
  t.true(Object.isFrozen(persistence.policy.mounts));
  t.true(Object.isFrozen(persistence.policy.mounts.workspace));
  t.true(Object.isFrozen(persistence.policy.mounts.workspace.deniedSegments));

  await t.throwsAsync(
    () =>
      validateEndoProvisionPersistence({
        ...persistence,
        endpoint: '/tmp/endo.sock',
      }),
    { message: /unknown field.*endpoint/ },
  );
  await t.throwsAsync(
    () =>
      validateEndoProvisionPersistence({
        ...persistence,
        policy: {
          ...persistence.policy,
          mounts: {
            workspace: {
              ...persistence.policy.mounts.workspace,
              deniedSegments: ['PRIVATE', 'private'],
            },
          },
        },
      }),
    { message: /not in normalized form/ },
  );
});

test('Git grants reconstruct from persistence without the original spec', async t => {
  const root = await makeWorkspace(t);
  await mkdir(join(root, 'nested-repo'));
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      gits: { ebfb: { path: ['nested-repo'], mode: 'readWrite' } },
    },
    { harness: 'test', sessionId: 'git-restart', cwd: root },
  );

  const persistedRecord = JSON.parse(JSON.stringify(persistence));
  const reconstructed = await validateEndoProvisionPersistence(persistedRecord);
  t.deepEqual(reconstructed, persistence);
  t.deepEqual(reconstructed.policy.gits?.ebfb, {
    mount: 'workspace',
    path: ['nested-repo'],
    root: await realpath(join(root, 'nested-repo')),
    mode: 'readWrite',
  });
});

test('persistence reconstruction retains own __proto__ mount and Git grants', async t => {
  const root = await makeWorkspace(t);
  const nested = join(root, 'nested-repo');
  await mkdir(nested);
  const mounts = JSON.parse(`{
    "__proto__": {
      "path": ${JSON.stringify(nested)},
      "mode": "readOnly"
    }
  }`);
  const mounted = await normalizeEndoProvisionSpec(
    {
      mounts,
      gits: { nested: { mount: '__proto__', path: [], mode: 'readOnly' } },
    },
    { harness: 'test', sessionId: 'persist-proto-mount', cwd: root },
  );
  const mountedReconstructed = await validateEndoProvisionPersistence(
    JSON.parse(JSON.stringify(mounted)),
  );
  t.true(Object.hasOwn(mountedReconstructed.policy.mounts, '__proto__'));

  const gits = JSON.parse(`{
    "__proto__": { "path": [], "mode": "readOnly" }
  }`);
  const granted = await normalizeEndoProvisionSpec(
    { fs: 'readOnly', gits },
    { harness: 'test', sessionId: 'persist-proto-git', cwd: root },
  );
  const grantedReconstructed = await validateEndoProvisionPersistence(
    JSON.parse(JSON.stringify(granted)),
  );
  t.true(Object.hasOwn(grantedReconstructed.policy.gits ?? {}, '__proto__'));
});

test('missing Git directories reject the whole persisted authority', async t => {
  const root = await makeWorkspace(t);
  const nestedPath = join(root, 'nested-repo');
  await mkdir(nestedPath);
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      gits: { ebfb: { path: ['nested-repo'], mode: 'readOnly' } },
    },
    { harness: 'test', sessionId: 'missing-git-repo', cwd: root },
  );
  await rm(nestedPath, { recursive: true, force: true });

  await t.throwsAsync(() => validateEndoProvisionPersistence(persistence), {
    message: /does not exist or cannot be resolved/,
  });
});

test('persistence equality ignores record key order but preserves array order', async t => {
  const root = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { fs: 'readOnly', workspace: { deniedSegments: ['.git', 'private'] } },
    { harness: 'test', sessionId: 'equality', cwd: root },
  );
  const reordered = {
    policy: {
      mounts: persistence.policy.mounts,
    },
    workspacePath: persistence.workspacePath,
    guestHandlePath: persistence.guestHandlePath,
    version: persistence.version,
  };
  const reversedArray = {
    ...reordered,
    policy: {
      ...reordered.policy,
      mounts: {
        workspace: {
          ...persistence.policy.mounts.workspace,
          deniedSegments: [
            ...persistence.policy.mounts.workspace.deniedSegments,
          ].reverse(),
        },
      },
    },
  };

  t.true(equalEndoProvisionPersistence(persistence, reordered));
  t.deepEqual(await validateEndoProvisionPersistence(reordered), persistence);
  t.false(equalEndoProvisionPersistence(persistence, reversedArray));
  t.false(
    equalEndoProvisionPersistence(persistence, {
      ...reordered,
      workspacePath: `${persistence.workspacePath}-changed`,
    }),
  );
});

test('persistence validation rejects foreign or malformed roots and harnesses', async t => {
  const root = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'invalid-persistence-path',
    cwd: root,
  });
  const invalidPaths = [
    ['foreign', 'test', ...persistence.guestHandlePath.slice(2)],
    ['code-mode', 'Pi', ...persistence.guestHandlePath.slice(2)],
    ['code-mode', 'test_code', ...persistence.guestHandlePath.slice(2)],
    ['code-mode', 'test', 'session-invalid', 'guest-handle'],
  ];

  for (const guestHandlePath of invalidPaths) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        validateEndoProvisionPersistence({
          ...persistence,
          guestHandlePath,
        }),
      { message: /invalid guest handle path/ },
    );
  }
});
