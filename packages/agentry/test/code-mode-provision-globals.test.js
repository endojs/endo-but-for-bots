// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeGitRemoteGlobal } from '@endo/agent-tools/code-mode-globals/git-remote.js';

import { makeEndoProvisionGlobals } from '../src/code-mode-provision-globals.js';

/** @param {Record<string, unknown>} policy */
const makePersistence = policy =>
  harden(
    /** @type {any} */ ({
      version: 1,
      guestHandlePath: ['pi-code', 'session-test', 'guest-handle'],
      workspacePath: '/workspace',
      policy: {
        workspace: { deniedSegments: [] },
        ...policy,
      },
    }),
  );

test('globals match filesystem and Git authority modes', t => {
  const cases = [
    [makePersistence({}), []],
    [
      makePersistence({ fs: 'readOnly' }),
      [makeWorkspaceGlobal({ name: 'workspace' })],
    ],
    [
      makePersistence({ fs: 'readWrite' }),
      [makeWorkspaceGlobal({ name: 'workspace' })],
    ],
    [
      makePersistence({ git: 'readOnly' }),
      [makeGitGlobal({ name: 'git', readOnly: true })],
    ],
    [makePersistence({ git: 'readWrite' }), [makeGitGlobal({ name: 'git' })]],
    [
      makePersistence({ git: 'historyRewrite' }),
      [makeGitGlobal({ name: 'git', historyRewrite: true })],
    ],
    [
      makePersistence({ fs: 'readWrite', git: 'historyRewrite' }),
      [
        makeWorkspaceGlobal({ name: 'workspace' }),
        makeGitGlobal({ name: 'git', historyRewrite: true }),
      ],
    ],
  ];

  for (const [persistence, expected] of cases) {
    t.deepEqual(
      makeEndoProvisionGlobals(/** @type {any} */ (persistence)),
      expected,
    );
  }
});

test('remote globals are sorted and hardened', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence({
      git: 'readWrite',
      gitRemotes: {
        zebra: {},
        alpha: {},
      },
    }),
  );

  t.deepEqual(globals, [
    makeGitGlobal({ name: 'git' }),
    makeGitRemoteGlobal({ name: 'alpha' }),
    makeGitRemoteGlobal({ name: 'zebra' }),
  ]);
  t.true(Object.isFrozen(globals));
  t.true(globals.every(Object.isFrozen));
});
