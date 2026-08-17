// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from '../src/code-mode-provision-policy.js';

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
  t.is(first.version, 2);
  t.is(first.workspacePath, await realpath(child));
  t.deepEqual(first.guestHandlePath.slice(0, 2), ['code-mode', 'test']);
  t.deepEqual(first.guestHandlePath.slice(2), [
    'session-e18c78136e8ee72d10e2af231794072c72fa11fcf2367f56e50eb0d97d37b870',
    'guest-handle',
  ]);
  t.deepEqual(Object.keys(first.policy), ['mounts']);
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
    mounts: {},
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

test('mount and Git dictionaries retain own __proto__ bindings', async t => {
  const { root, child } = await makeWorkspace(t);
  const mounts = JSON.parse(`{
    "__proto__": {
      "path": ${JSON.stringify(root)},
      "mode": "readOnly"
    }
  }`);
  const mountPersistence = await normalizeEndoProvisionSpec(
    { mounts },
    { harness: 'test', sessionId: 'proto-mount', cwd: root },
  );
  t.deepEqual(Object.keys(mountPersistence.policy.mounts), ['__proto__']);
  t.true(Object.hasOwn(mountPersistence.policy.mounts, '__proto__'));

  const gits = JSON.parse(`{
    "__proto__": {
      "path": ["${child.slice(root.length + 1)}"],
      "mode": "readOnly"
    }
  }`);
  const gitPersistence = await normalizeEndoProvisionSpec(
    { fs: 'readOnly', gits },
    { harness: 'test', sessionId: 'proto-git', cwd: root },
  );
  t.deepEqual(Object.keys(gitPersistence.policy.gits ?? {}), ['__proto__']);
  t.true(Object.hasOwn(gitPersistence.policy.gits ?? {}, '__proto__'));
});

test('Git grants normalize mount-relative paths and modes', async t => {
  const { root, child } = await makeWorkspace(t);
  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      gits: {
        zeta: { path: ['child'], mode: 'historyRewrite' },
        ebfb: { path: [], mode: 'readOnly' },
      },
    },
    { harness: 'test', sessionId: 'named-gits', cwd: root },
  );

  t.deepEqual(persistence.policy.mounts?.workspace, {
    root: await realpath(root),
    mode: 'readWrite',
    deniedSegments: persistence.policy.mounts?.workspace.deniedSegments,
    guestBinding: true,
  });
  t.deepEqual(persistence.policy.gits, {
    ebfb: {
      mount: 'workspace',
      path: [],
      root: await realpath(root),
      mode: 'readOnly',
    },
    zeta: {
      mount: 'workspace',
      path: ['child'],
      root: await realpath(child),
      mode: 'historyRewrite',
    },
  });
  t.true(Object.isFrozen(persistence.policy.gits));
  t.true(Object.isFrozen(persistence.policy.gits?.ebfb));
});

test('read-only Git can omit the filesystem grant', async t => {
  const { root } = await makeWorkspace(t);
  const readOnly = await normalizeEndoProvisionSpec(
    { git: 'readOnly' },
    { harness: 'test', sessionId: 'read-only-git-without-fs', cwd: root },
  );

  t.deepEqual(readOnly.policy.mounts?.workspace, {
    root: await realpath(root),
    mode: 'readOnly',
    deniedSegments: readOnly.policy.mounts?.workspace.deniedSegments,
    guestBinding: false,
  });
  t.deepEqual(readOnly.policy.gits?.git, {
    mount: 'workspace',
    path: [],
    root: await realpath(root),
    mode: 'readOnly',
  });

  const writable = await normalizeEndoProvisionSpec(
    { fs: 'readWrite', git: 'readWrite' },
    { harness: 'test', sessionId: 'writable-git-with-fs', cwd: root },
  );
  t.is(writable.policy.mounts?.workspace.mode, 'readWrite');
  t.is(writable.policy.mounts?.workspace.guestBinding, true);
  t.is(writable.policy.gits?.git.mode, 'readWrite');
});

test('Git grants pin canonical roots across validation', async t => {
  const { root, child } = await makeWorkspace(t);
  const link = join(root, 'child-link');
  await symlink(child, link, 'dir');

  const persistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      gits: { linked: { path: ['child-link'], mode: 'readOnly' } },
    },
    { harness: 'test', sessionId: 'canonical-git', cwd: root },
  );

  t.is(persistence.policy.gits?.linked.root, await realpath(child));
  t.deepEqual(persistence.policy.gits?.linked.path, ['child-link']);
  t.deepEqual(
    await validateEndoProvisionPersistence(
      JSON.parse(JSON.stringify(persistence)),
    ),
    persistence,
  );
});

test('Git grants reject binding collisions, escapes, denial, and capping', async t => {
  const { root } = await makeWorkspace(t);
  const normalizeGits = (gits, extra = {}) =>
    normalizeEndoProvisionSpec(
      /** @type {any} */ ({ fs: 'readWrite', gits, ...extra }),
      { harness: 'test', sessionId: 'invalid-git', cwd: root },
    );

  for (const name of [
    'E',
    'git',
    'gits',
    'workspace',
    'class',
    'persistence',
    'remotes',
    'guest-agent',
    'guest-handle',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        normalizeGits({
          [name]: { path: ['child'], mode: 'readOnly' },
        }),
      { message: /non-reserved JavaScript binding/ },
    );
  }

  for (const path of [['..'], ['child', '..'], ['/tmp'], ['child\\repo']]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => normalizeGits({ escape: { path, mode: 'readOnly' } }),
      { message: /one relative path segment inside the selected mount/ },
    );
  }

  await t.throwsAsync(
    () => normalizeGits({ hidden: { path: ['.ssh'], mode: 'readOnly' } }),
    { message: /denied segment of mount/ },
  );
  await t.throwsAsync(
    () =>
      normalizeGits(
        { privateRepo: { path: ['private'], mode: 'readOnly' } },
        { workspace: { deniedSegments: ['PRIVATE'] } },
      ),
    { message: /denied segment of mount/ },
  );

  for (const mode of /** @type {const} */ (['readWrite', 'historyRewrite'])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        normalizeEndoProvisionSpec(
          {
            fs: 'readOnly',
            gits: { nested: { path: ['child'], mode } },
          },
          { harness: 'test', sessionId: 'capped-git', cwd: root },
        ),
      { message: /writable Git requires a writable filesystem grant/ },
    );
  }

  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          fs: 'readWrite',
          git: 'readWrite',
          gits: { origin: { path: ['child'], mode: 'readOnly' } },
          gitRemotes: {
            origin: {
              url: 'file:///tmp/repository.git',
              allowLocalFileTransport: true,
            },
          },
        },
        { harness: 'test', sessionId: 'colliding-git-name', cwd: root },
      ),
    { message: /declared for a mount, Git grant, or remote more than once/ },
  );

  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          mounts: { source: { path: root, mode: 'readOnly' } },
          gits: { source: { mount: 'source', path: [], mode: 'readOnly' } },
        },
        { harness: 'test', sessionId: 'mount-git-collision', cwd: root },
      ),
    { message: /declared for both a mount and a Git grant/ },
  );

  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          mounts: { workspace: { path: root, mode: 'readOnly' } },
        },
        { harness: 'test', sessionId: 'reserved-mount', cwd: root },
      ),
    { message: /non-reserved JavaScript binding/ },
  );

  const outside = await mkdtemp(join(tmpdir(), 'endo-provision-outside-'));
  t.teardown(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape-link'), 'dir');
  await t.throwsAsync(
    () =>
      normalizeGits({ escape: { path: ['escape-link'], mode: 'readOnly' } }),
    { message: /must stay inside selected mount/ },
  );
});

test('host infrastructure names are reserved for mounts and remotes', async t => {
  const { root } = await makeWorkspace(t);
  const localRemoteUrl = pathToFileURL(root).href;

  // A mount named after a controller-path infrastructure sibling is rejected,
  // so it can never shadow the persistence record or guest handle.
  for (const name of [
    'persistence',
    'remotes',
    'guest-agent',
    'guest-handle',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        normalizeEndoProvisionSpec(
          { mounts: { [name]: { path: root, mode: 'readOnly' } } },
          { harness: 'test', sessionId: `reserved-mount-${name}`, cwd: root },
        ),
      { message: /non-reserved JavaScript binding/ },
    );
  }

  // A Git remote named `persistence` fails closed at normalization rather than
  // resolving to the stored persistence record at realization time.
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          fs: 'readWrite',
          git: 'readWrite',
          gitRemotes: {
            persistence: {
              url: localRemoteUrl,
              allowLocalFileTransport: true,
            },
          },
        },
        { harness: 'test', sessionId: 'reserved-remote', cwd: root },
      ),
    { message: /non-reserved JavaScript binding/ },
  );
});
test('named mounts coexist and cap each selected Git grant independently', async t => {
  const { root } = await makeWorkspace(t);
  const readOnlyRoot = await mkdtemp(join(tmpdir(), 'endo-provision-ro-'));
  const writableRoot = await mkdtemp(join(tmpdir(), 'endo-provision-rw-'));
  t.teardown(() => rm(readOnlyRoot, { recursive: true, force: true }));
  t.teardown(() => rm(writableRoot, { recursive: true, force: true }));

  const readOnly = await normalizeEndoProvisionSpec(
    {
      mounts: {
        source: { path: readOnlyRoot, mode: 'readOnly' },
        destination: { path: writableRoot, mode: 'readWrite' },
      },
      gits: {
        inspect: { mount: 'source', path: [], mode: 'readOnly' },
      },
    },
    { harness: 'test', sessionId: 'named-mounts', cwd: root },
  );
  t.deepEqual(Object.keys(readOnly.policy.mounts), ['destination', 'source']);
  t.deepEqual(readOnly.policy.gits?.inspect, {
    mount: 'source',
    path: [],
    root: await realpath(readOnlyRoot),
    mode: 'readOnly',
  });

  const writable = await normalizeEndoProvisionSpec(
    {
      mounts: {
        source: { path: readOnlyRoot, mode: 'readOnly' },
        destination: { path: writableRoot, mode: 'readWrite' },
      },
      gits: {
        rewrite: { mount: 'destination', path: [], mode: 'historyRewrite' },
        write: { mount: 'destination', path: [], mode: 'readWrite' },
      },
    },
    { harness: 'test', sessionId: 'named-mounts-writable', cwd: root },
  );
  t.is(writable.policy.gits?.rewrite.mount, 'destination');
  t.is(writable.policy.gits?.write.mount, 'destination');

  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          fs: 'readWrite',
          mounts: {
            source: { path: readOnlyRoot, mode: 'readOnly' },
            destination: { path: writableRoot, mode: 'readWrite' },
          },
          gits: {
            wrong: { mount: 'source', path: [], mode: 'readWrite' },
          },
        },
        { harness: 'test', sessionId: 'named-mount-cap', cwd: root },
      ),
    { message: /cannot be.*on read-only mount/ },
  );
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
      { git: 'readWrite' },
      /writable Git requires a writable filesystem grant.*omitted fs/,
    ],
    [
      { git: 'historyRewrite' },
      /writable Git requires a writable filesystem grant.*omitted fs/,
    ],
    [
      { gits: { nested: { path: [], mode: 'readWrite' } } },
      /writable Git requires a writable filesystem grant.*omitted fs/,
    ],
    [
      { git: 'readOnly', gitRemotes: { origin: { url: 'file:///tmp/x' } } },
      /remotes require writable root Git/,
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
