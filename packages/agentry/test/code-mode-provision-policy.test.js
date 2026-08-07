// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  await null;
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-policy-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const child = join(root, 'child');
  await mkdir(child);
  return { root, child };
};

test('normalization preserves omission and resolves a canonical cwd', async t => {
  const { root, child } = await makeWorkspace(t);
  const first = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'stable-session',
    cwd: child,
  });
  const second = await normalizeEndoProvisionSpec(
    {},
    {
      harness: 'test',
      sessionId: 'stable-session',
      cwd: child,
    },
  );
  const relative = await normalizeEndoProvisionSpec(
    { workspace: { path: 'child' } },
    { harness: 'test', sessionId: 'relative-session', cwd: root },
  );

  t.deepEqual(first, second);
  t.is(first.version, 1);
  t.is(first.workspacePath, await realpath(child));
  t.deepEqual(first.guestHandlePath.slice(0, 2), ['code-mode', 'test']);
  t.deepEqual(first.guestHandlePath.slice(2), [
    'session-e18c78136e8ee72d10e2af231794072c72fa11fcf2367f56e50eb0d97d37b870',
    'guest-handle',
  ]);
  t.deepEqual(Object.keys(first.policy), ['workspace']);
  t.is(relative.workspacePath, await realpath(child));
  t.notDeepEqual(relative.guestHandlePath, first.guestHandlePath);
});

test('normalization retains explicit Pi tool preservation in policy data', async t => {
  const { root } = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    { piTools: 'preserve' },
    { harness: 'test', sessionId: 'preserve-pi-tools', cwd: root },
  );

  t.deepEqual(persistence.policy, {
    piTools: 'preserve',
    workspace: { deniedSegments: persistence.policy.workspace.deniedSegments },
  });
});

test('normalization rejects malformed harness keys', async t => {
  const { root } = await makeWorkspace(t);
  const invalidHarnesses = ['Pi', 'pi_code', '-pi', `a${'b'.repeat(32)}`];

  for (const harness of invalidHarnesses) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        normalizeEndoProvisionSpec(undefined, {
          harness,
          sessionId: 'invalid-harness',
          cwd: root,
        }),
      { message: /harness must match/ },
    );
  }
});

test('Git remote policy uses the authoritative exo-git normal form', async t => {
  const { root } = await makeWorkspace(t);
  const localRemoteUrl = pathToFileURL(root).href;
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
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
          allowedDirections: ['fetch', 'fetch'],
          fetchRefspecs: [
            'refs/heads/zeta:refs/remotes/origin/zeta',
            'refs/heads/alpha:refs/remotes/origin/alpha',
          ],
          defaultPullRef: 'refs/heads/alpha',
          credential: ['credentials', 'github'],
        },
      },
    },
    { harness: 'test', sessionId: 'remotes', cwd: root },
  );

  t.deepEqual(Object.keys(persistence.policy.gitRemotes ?? {}), [
    'origin',
    'upstreamRemote',
  ]);
  t.deepEqual(persistence.policy.gitRemotes?.origin, {
    url: 'https://github.com/endojs/endo.git',
    allowedDirections: ['fetch'],
    fetchRefspecs: [
      'refs/heads/zeta:refs/remotes/origin/zeta',
      'refs/heads/alpha:refs/remotes/origin/alpha',
    ],
    pushRefspecs: [],
    defaultPullRef: 'refs/heads/alpha',
    allowForcePush: false,
    allowTags: false,
    allowDelete: false,
    allowLocalFileTransport: false,
    credential: ['credentials', 'github'],
  });
  t.deepEqual(persistence.policy.gitRemotes?.upstreamRemote.pushRefspecs, [
    'refs/heads/main:refs/heads/main',
  ]);
  t.true(Object.isFrozen(persistence));
  t.true(Object.isFrozen(persistence.policy));
  t.true(Object.isFrozen(persistence.policy.gitRemotes));
  t.true(Object.isFrozen(persistence.policy.gitRemotes?.origin));
  t.true(Object.isFrozen(persistence.policy.gitRemotes?.origin.fetchRefspecs));
});

test('Git remote dictionaries retain an own __proto__ binding', async t => {
  const { root } = await makeWorkspace(t);
  const gitRemotes = JSON.parse(`{
    "__proto__": {
      "url": ${JSON.stringify(pathToFileURL(root).href)},
      "allowLocalFileTransport": true
    }
  }`);
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      git: 'readWrite',
      gitRemotes,
    },
    { harness: 'test', sessionId: 'proto-remote', cwd: root },
  );

  t.deepEqual(Object.keys(persistence.policy.gitRemotes ?? {}), ['__proto__']);
  t.true(Object.hasOwn(persistence.policy.gitRemotes ?? {}, '__proto__'));
});

test('EndoProvisionSpec rejects malformed roots and incompatible modes', async t => {
  const { root } = await makeWorkspace(t);
  const normalize = spec =>
    normalizeEndoProvisionSpec(/** @type {any} */ (spec), {
      harness: 'test',
      sessionId: 'invalid-root',
      cwd: root,
    });
  const invalid = [
    [{ extra: true }, /unknown field.*extra/],
    [{ workspace: { extra: true } }, /unknown field.*extra/],
    [{ fs: 'sometimes' }, /fs must be readOnly or readWrite/],
    [{ git: 'force' }, /git must be readOnly, readWrite, or historyRewrite/],
    [{ piTools: 'replace' }, /piTools must be preserve/],
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
  ];

  for (const [spec, message] of invalid) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => normalize(spec), {
      message: /** @type {RegExp} */ (message),
    });
  }
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { workspace: { path: 'missing' }, fs: 'readOnly' },
        { harness: 'test', sessionId: 'missing', cwd: root },
      ),
    { message: /does not exist or cannot be resolved/ },
  );
});

test('Git remote policy rejects invalid bindings and credential material', async t => {
  const { root } = await makeWorkspace(t);
  const normalizeRemote = gitRemotes =>
    normalizeEndoProvisionSpec(
      /** @type {any} */ ({ fs: 'readWrite', git: 'readWrite', gitRemotes }),
      { harness: 'test', sessionId: 'invalid-remote', cwd: root },
    );
  const invalid = [
    [{ git: { url: 'file:///tmp/x' } }, /non-reserved JavaScript binding/],
    [{ class: { url: 'file:///tmp/x' } }, /non-reserved JavaScript binding/],
    [
      {
        origin: {
          url: 'https://user:password@example.test/repo.git',
          credential: 'credential',
        },
      },
      /must not include embedded credentials/,
    ],
    [
      {
        origin: {
          url: 'https://example.test/repo.git?access_token=nope',
          credential: 'credential',
        },
      },
      /must not carry credential query fields/,
    ],
    [
      {
        origin: {
          url: 'https://example.test/repo.git',
          token: 'not-allowed',
        },
      },
      /looks like credential material/,
    ],
  ];

  for (const [gitRemotes, message] of invalid) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => normalizeRemote(gitRemotes), {
      message: /** @type {RegExp} */ (message),
    });
  }
});

test('Git remote policy rejects invalid branch and pull selections', async t => {
  const { root } = await makeWorkspace(t);
  const normalizeOrigin = origin =>
    normalizeEndoProvisionSpec(
      /** @type {any} */ ({
        fs: 'readWrite',
        git: 'readWrite',
        gitRemotes: { origin },
      }),
      { harness: 'test', sessionId: 'invalid-git-policy', cwd: root },
    );
  const base = {
    url: 'https://example.test/repo.git',
    credential: 'credential',
  };
  const invalid = [
    [
      {
        ...base,
        allowedBranches: ['main'],
        pushRefspecs: ['refs/heads/other:refs/heads/other'],
      },
      /choose allowedBranches or pushRefspecs/,
    ],
    [
      {
        ...base,
        allowedDirections: ['push'],
        pushRefspecs: ['+refs/heads/main:refs/heads/main'],
      },
      /force-push refspec requires allowForcePush/,
    ],
    [
      {
        ...base,
        allowedDirections: ['push'],
        allowedBranches: ['release/*'],
      },
      /wildcard branches must be rooted under refs\/heads/,
    ],
    [
      {
        ...base,
        fetchRefspecs: ['refs/heads/main:refs/remotes/origin/main'],
        defaultPullRef: 'refs/heads/missing',
      },
      /does not select a configured concrete fetch refspec/,
    ],
  ];

  for (const [origin, message] of invalid) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => normalizeOrigin(origin), {
      message: /** @type {RegExp} */ (message),
    });
  }
});
