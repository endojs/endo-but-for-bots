// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
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
    { fs: 'readOnly', workspace: { deniedSegments: ['private', '.git'] } },
    { harness: 'test', sessionId: 'persist', cwd: root },
  );

  t.deepEqual(await validateEndoProvisionPersistence(persistence), persistence);
  t.true(Object.isFrozen(persistence));
  t.true(Object.isFrozen(persistence.guestHandlePath));
  t.true(Object.isFrozen(persistence.policy));
  t.true(Object.isFrozen(persistence.policy.workspace));
  t.true(Object.isFrozen(persistence.policy.workspace.deniedSegments));

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
          workspace: { deniedSegments: ['private', '.git'] },
        },
      }),
    { message: /not in normalized form/ },
  );
});

test('persistence equality ignores record key order but preserves array order', async t => {
  const root = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { fs: 'readOnly', workspace: { deniedSegments: ['.git', 'private'] } },
    { harness: 'test', sessionId: 'equality', cwd: root },
  );
  const reordered = {
    policy: {
      fs: persistence.policy.fs,
      workspace: {
        deniedSegments: persistence.policy.workspace.deniedSegments,
      },
    },
    workspacePath: persistence.workspacePath,
    guestHandlePath: persistence.guestHandlePath,
    version: persistence.version,
  };
  const reversedArray = {
    ...reordered,
    policy: {
      ...reordered.policy,
      workspace: {
        deniedSegments: [
          ...persistence.policy.workspace.deniedSegments,
        ].reverse(),
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
