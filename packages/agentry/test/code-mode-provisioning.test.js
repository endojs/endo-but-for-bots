// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeDaemonMountGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeGitRemoteGlobal } from '@endo/agent-tools/code-mode-globals/git-remote.js';

import {
  makeEndoProvisionGlobals,
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from '../src/code-mode-provisioning.js';

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  await null;
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-unit-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const child = join(root, 'child');
  await mkdir(child);
  return { root, child };
};

test('normalization preserves omission and resolves a stable canonical cwd', async t => {
  const { root, child } = await makeWorkspace(t);
  const first = await normalizeEndoProvisionSpec(undefined, {
    sessionId: 'stable-session',
    cwd: child,
  });
  const second = await normalizeEndoProvisionSpec(
    {},
    {
      sessionId: 'stable-session',
      cwd: child,
    },
  );
  const relative = await normalizeEndoProvisionSpec(
    { workspace: { path: 'child' } },
    { sessionId: 'relative-session', cwd: root },
  );

  t.deepEqual(first, second);
  t.is(first.version, 1);
  t.is(first.workspacePath, await realpath(child));
  t.deepEqual(first.guestPetName.slice(0, 2), [
    'pi-code',
    'session-e18c78136e8ee72d10e2af231794072c72fa11fcf2367f56e50eb0d97d37b870',
  ]);
  t.deepEqual(Object.keys(first.policy).sort(), ['workspace']);
  t.deepEqual(makeEndoProvisionGlobals(first), []);
  t.is(relative.workspacePath, await realpath(child));
  t.notDeepEqual(relative.guestPetName, first.guestPetName);
  t.false(JSON.stringify(first).includes('endo.sock'));
});

test('filesystem and Git modes select independent matching declarations', async t => {
  const { root } = await makeWorkspace(t);
  const cases = await Promise.all([
    normalizeEndoProvisionSpec(
      { fs: 'readOnly' },
      { sessionId: 'fs-ro', cwd: root },
    ),
    normalizeEndoProvisionSpec(
      { fs: 'readWrite' },
      { sessionId: 'fs-rw', cwd: root },
    ),
    normalizeEndoProvisionSpec(
      { git: 'readOnly' },
      { sessionId: 'git-ro', cwd: root },
    ),
    normalizeEndoProvisionSpec(
      { git: 'readWrite' },
      { sessionId: 'git-rw', cwd: root },
    ),
    normalizeEndoProvisionSpec(
      { fs: 'readWrite', git: 'historyRewrite' },
      { sessionId: 'independent', cwd: root },
    ),
  ]);

  const [fsReadOnly, fsReadWrite, gitReadOnly, gitReadWrite, independent] =
    cases.map(makeEndoProvisionGlobals);
  t.deepEqual(fsReadOnly, [
    makeDaemonMountGlobal({ name: 'workspace', readOnly: true }),
  ]);
  t.deepEqual(fsReadWrite, [
    makeDaemonMountGlobal({ name: 'workspace', readOnly: false }),
  ]);
  t.deepEqual(gitReadOnly, [makeGitGlobal({ name: 'git', readOnly: true })]);
  t.deepEqual(gitReadWrite, [makeGitGlobal({ name: 'git' })]);
  t.deepEqual(independent, [
    makeDaemonMountGlobal({ name: 'workspace', readOnly: false }),
    makeGitGlobal({ name: 'git', historyRewrite: true }),
  ]);
});

test('remote policy normalizes without retaining credential material', async t => {
  const { root } = await makeWorkspace(t);
  const localRemoteUrl = pathToFileURL(root).href;
  const persistence = await normalizeEndoProvisionSpec(
    {
      git: 'readWrite',
      gitRemotes: {
        upstreamRemote: {
          url: localRemoteUrl,
          allowedDirections: ['push'],
          allowedBranches: ['main'],
          allowLocalFileTransport: true,
        },
        origin: {
          url: 'https://github.com/endojs/endo.git',
          allowedDirections: ['fetch'],
          fetchRefspecs: ['refs/heads/*:refs/remotes/origin/*'],
          credential: ['credentials', 'github'],
        },
      },
    },
    { sessionId: 'remotes', cwd: root },
  );

  t.deepEqual(Object.keys(persistence.policy.gitRemotes ?? {}), [
    'origin',
    'upstreamRemote',
  ]);
  t.deepEqual(persistence.policy.gitRemotes?.upstreamRemote.pushRefspecs, [
    'refs/heads/main:refs/heads/main',
  ]);
  t.deepEqual(persistence.policy.gitRemotes?.origin.credential, [
    'credentials',
    'github',
  ]);
  t.deepEqual(makeEndoProvisionGlobals(persistence).slice(-2), [
    makeGitRemoteGlobal({ name: 'origin' }),
    makeGitRemoteGlobal({ name: 'upstreamRemote' }),
  ]);
  t.false(JSON.stringify(persistence).includes('token'));
});

test('normalization rejects malformed, secret, and widening policy', async t => {
  const { root } = await makeWorkspace(t);
  const normalize = spec =>
    normalizeEndoProvisionSpec(/** @type {any} */ (spec), {
      sessionId: 'invalid',
      cwd: root,
    });
  const invalid = [
    [{ extra: true }, /unknown field.*extra/],
    [{ workspace: { extra: true } }, /unknown field.*extra/],
    [{ fs: 'sometimes' }, /fs must be readOnly or readWrite/],
    [{ git: 'force' }, /git must be readOnly, readWrite, or historyRewrite/],
    [
      { fs: 'readOnly', git: 'readWrite' },
      /writable Git requires a writable filesystem grant/,
    ],
    [
      { fs: 'readOnly', git: 'historyRewrite' },
      /writable Git requires a writable filesystem grant/,
    ],
    [
      { git: 'readOnly', gitRemotes: { origin: { url: 'file:///tmp/x' } } },
      /remotes require writable Git/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          git: {
            url: 'file:///tmp/x',
            allowLocalFileTransport: true,
          },
        },
      },
      /non-reserved JavaScript binding/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: 'https://user:password@example.test/repo.git',
            credential: 'credential',
          },
        },
      },
      /must not embed credentials/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: 'https://example.test/repo.git',
            token: 'not-allowed',
          },
        },
      },
      /looks like credential material/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: 'https://example.test/repo.git',
            credential: 'credential',
            allowedBranches: ['main'],
            pushRefspecs: ['refs/heads/main:refs/heads/main'],
          },
        },
      },
      /choose allowedBranches or pushRefspecs/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: 'https://example.test/repo.git',
            credential: 'credential',
            allowedDirections: ['push'],
            pushRefspecs: ['+refs/heads/main:refs/heads/main'],
          },
        },
      },
      /force push requires allowForcePush/,
    ],
    [
      {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: 'https://example.test/repo.git',
            credential: 'credential',
            allowedDirections: ['push'],
            allowedBranches: ['release/*'],
          },
        },
      },
      /not a valid branch selector/,
    ],
  ];

  await Promise.all(
    invalid.map(async ([spec, message]) => {
      await t.throwsAsync(() => normalize(spec), {
        message: /** @type {RegExp} */ (message),
      });
    }),
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { workspace: { path: 'missing' }, fs: 'readOnly' },
        { sessionId: 'missing', cwd: root },
      ),
    { message: /does not exist or cannot be resolved/ },
  );
});

test('persistence validation rejects non-normal form and unknown fields', async t => {
  const { root } = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { fs: 'readOnly', workspace: { deniedSegments: ['private', '.git'] } },
    { sessionId: 'persist', cwd: root },
  );
  t.deepEqual(await validateEndoProvisionPersistence(persistence), persistence);

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
