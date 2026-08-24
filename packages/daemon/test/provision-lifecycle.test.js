// @ts-check

/** @import { EndoMount } from '@endo/daemon' */
/** @import { GitRemote, ReadOnlyEndoGit, ReadWriteEndoGit } from '@endo/exo-git' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

import { makeProvisioningFixture } from './_provision-fixture.js';

const execFileAsync = promisify(execFile);

test.serial('provideGuest retains a neutral named authority graph', async t => {
  t.timeout(120_000);
  const fixture = await makeProvisioningFixture(t);
  const docs = join(fixture.workspace, 'docs');
  const remote = join(fixture.root, 'remote.git');
  await mkdir(docs);
  await writeFile(join(docs, 'guide.md'), 'guide\n');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: docs });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], {
    cwd: fixture.workspace,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: fixture.workspace });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Provision Test',
      '-c',
      'user.email=provision@example.test',
      'commit',
      '-q',
      '-m',
      'initial',
    ],
    { cwd: fixture.workspace },
  );
  await execFileAsync('git', ['init', '--bare', '-q', remote]);

  const host = await fixture.connectHost('named-authority-host');
  const calendar = await E(host).provideGuest('calendar-handle', {
    agentName: 'calendar',
  });
  await E(calendar).storeValue('original', 'value');

  const authority = harden({
    mount: {
      workspace: {
        path: fixture.workspace,
        deniedSegments: ['.env'],
      },
      docs: { path: docs, readOnly: true },
    },
    git: {
      repo: { mount: 'workspace', path: [] },
      docsHistory: { mount: 'docs', path: [], readOnly: true },
    },
    gitRemote: {
      originCap: {
        git: 'repo',
        name: 'origin',
        url: new URL(`file://${remote}`).href,
        allowedDirections: ['fetch', 'push'],
        fetchRefspecs: ['refs/heads/main:refs/remotes/origin/main'],
        pushRefspecs: ['refs/heads/main:refs/heads/main'],
        allowedBranches: ['main'],
        allowLocalFileTransport: true,
      },
    },
  });
  const guest = await E(host).provideGuest('coding-session', {
    authority,
    introducedNames: { calendar: 'calendar' },
  });

  const workspace = /** @type {EndoMount} */ (
    await E(guest).lookup('workspace')
  );
  const docsMount = /** @type {EndoMount} */ (await E(guest).lookup('docs'));
  t.is(await E(workspace).readText('README.md'), 'initial\n');
  t.is(await E(docsMount).readText('guide.md'), 'guide\n');
  const repo = /** @type {ReadWriteEndoGit} */ (await E(guest).lookup('repo'));
  t.true(Array.isArray((await E(repo).status()).entries));
  const docsHistory = /** @type {ReadOnlyEndoGit} */ (
    await E(guest).lookup('docsHistory')
  );
  // eslint-disable-next-line no-underscore-dangle
  const readOnlyMethods = await E(
    /** @type {any} */ (docsHistory),
  ).__getMethodNames__();
  t.false(readOnlyMethods.includes('commit'));
  const origin = /** @type {GitRemote} */ (await E(guest).lookup('originCap'));
  const originPolicy = await E(origin).inspect();
  t.is(originPolicy.name, 'origin');
  t.deepEqual(originPolicy.allowedBranches, ['main']);
  t.is(await E(await E(guest).lookup('calendar')).lookup('value'), 'original');

  const guestId = await E(host).identify('coding-session');
  const repoId = await E(guest).identify('repo');
  const repeated = await E(host).provideGuest('coding-session', {
    authority,
    introducedNames: { calendar: 'calendar' },
  });
  t.is(await E(host).identify('coding-session'), guestId);
  t.is(await E(repeated).identify('repo'), repoId);

  await t.throwsAsync(
    E(host).provideGuest('coding-session', {
      authority: {
        ...authority,
        mount: {
          ...authority.mount,
          docs: { path: docs, readOnly: false },
        },
      },
    }),
    { message: /cannot widen or change retained authority/ },
  );
  await t.throwsAsync(
    E(host).provideGuest('coding-session', {
      authority,
      introducedNames: {},
    }),
    { message: /cannot widen or change retained authority/ },
  );

  await fixture.restartDaemon();
  const restartedHost = await fixture.connectHost('named-authority-restart');
  const recovered = await E(restartedHost).provideGuest('coding-session', {
    authority,
    introducedNames: { calendar: 'calendar' },
  });
  t.is(await E(restartedHost).identify('coding-session'), guestId);
  t.is(await E(recovered).identify('repo'), repoId);
});

test.serial(
  'guest authority fails closed at dependency and path boundaries',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const outside = join(fixture.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(fixture.workspace, 'escape'), 'dir');
    const host = await fixture.connectHost('authority-boundaries-host');

    const empty = await E(host).provideGuest('empty-authority', {
      authority: {},
    });
    t.false(await E(empty).has('workspace'));

    await t.throwsAsync(
      E(host).provideGuest('implicit-dependency', {
        authority: {
          git: { repo: { mount: 'workspace', path: [] } },
        },
      }),
      { message: /unavailable mount binding/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('write-bypass', {
        authority: {
          mount: { docs: { path: fixture.workspace, readOnly: true } },
          git: { repo: { mount: 'docs', path: [] } },
        },
      }),
      { message: /requires a writable selected mount/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('symlink-escape', {
        authority: {
          mount: { workspace: { path: fixture.workspace } },
          git: {
            repo: { mount: 'workspace', path: ['escape'], readOnly: true },
          },
        },
      }),
      { message: /escapes selected mount/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('remote-dependency', {
        authority: {
          gitRemote: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'file:///tmp/remote.git',
            },
          },
        },
      }),
      { message: /unavailable Git binding/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('secret-query', {
        authority: {
          mount: { workspace: { path: fixture.workspace } },
          git: {
            repo: { mount: 'workspace', path: [] },
          },
          gitRemote: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'https://example.test/repo?access_token=secret',
            },
          },
        },
      }),
      { message: /must not carry credential query fields/ },
    );
  },
);

test.serial(
  'retained authority pins host-owned credential identity',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    const host = await fixture.connectHost('authority-credential-host');
    await E(host).makeDirectory(['credentials']);
    await E(host).provideBearerCredential(['credentials', 'origin'], {
      audience: 'https://example.test',
      token: 'first-test-token',
    });
    const authority = harden({
      mount: { workspace: { path: fixture.workspace } },
      git: { repo: { mount: 'workspace', path: [] } },
      gitRemote: {
        origin: {
          git: 'repo',
          name: 'origin',
          url: 'https://example.test/repository.git',
          credential: ['credentials', 'origin'],
        },
      },
    });
    await E(host).provideGuest('credential-session', { authority });

    await E(host).provideBearerCredential(['credentials', 'origin'], {
      audience: 'https://example.test',
      token: 'replacement-test-token',
    });
    await t.throwsAsync(
      E(host).provideGuest('credential-session', { authority }),
      { message: /cannot widen or change retained authority/ },
    );
  },
);
