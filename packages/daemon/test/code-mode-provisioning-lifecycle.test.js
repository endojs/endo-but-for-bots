// @ts-check

/** @import { EndoMount } from '@endo/daemon' */
/** @import { GitRemote, ReadOnlyEndoGit, ReadWriteEndoGit } from '@endo/exo-git' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

/* eslint-disable import/no-relative-packages */
import {
  normalizeEndoProvisionSpec,
  provisionEndoCodeMode,
  reconstructEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
import { realizeEndoProvisionOnHost } from '../../agentry/src/code-mode-provision-host.js';
/* eslint-enable import/no-relative-packages */

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';

const execFileAsync = promisify(execFile);

test.serial(
  'code-mode provisioning reconnects and survives restart',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const bareRemote = join(fixture.root, 'remote.git');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    await execFileAsync('git', ['add', 'README.md'], {
      cwd: fixture.workspace,
    });
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
    await execFileAsync('git', ['init', '--bare', '-q', bareRemote]);

    const host = await fixture.connectHost('provision-host');
    const localRemote = fixture.trackSession(
      await provisionEndoCodeMode({
        harness: 'test',
        sessionId: 'local-remote',
        cwd: fixture.workspace,
        sockPath: fixture.sockPath,
        spec: {
          fs: 'readWrite',
          git: 'readWrite',
          gitRemotes: {
            origin: {
              url: new URL(`file://${bareRemote}`).href,
              allowedDirections: ['fetch', 'push'],
              fetchRefspecs: [
                'refs/heads/zeta:refs/remotes/origin/zeta',
                'refs/heads/main:refs/remotes/origin/main',
              ],
              defaultPullRef: 'refs/heads/main',
              allowedBranches: ['main'],
              allowLocalFileTransport: true,
            },
          },
        },
      }),
    );
    t.true(Object.isFrozen(localRemote));
    t.true(Object.isFrozen(localRemote.globals));
    t.true(Object.isFrozen(localRemote.persistence));

    const workspaceMount = /** @type {EndoMount} */ (
      await E(localRemote.powers).lookup('workspace')
    );
    t.is(await E(workspaceMount).readText('README.md'), 'initial\n');
    const localGit = /** @type {ReadWriteEndoGit} */ (
      await E(localRemote.powers).lookup('git')
    );
    await E(localGit).status();
    const origin = /** @type {GitRemote} */ (
      await E(localRemote.powers).lookup('origin')
    );
    const originPolicy = await E(origin).inspect();
    t.deepEqual(
      [...originPolicy.fetchRefspecs],
      [
        'refs/heads/zeta:refs/remotes/origin/zeta',
        'refs/heads/main:refs/remotes/origin/main',
      ],
    );
    t.is(originPolicy.defaultPullRef, 'refs/heads/main');

    const readOnlySession = fixture.trackSession(
      await provisionEndoCodeMode({
        harness: 'test',
        sessionId: 'read-only-git',
        cwd: fixture.workspace,
        sockPath: fixture.sockPath,
        spec: { git: 'readOnly' },
      }),
    );
    const readOnlyGit = /** @type {ReadOnlyEndoGit} */ (
      await E(readOnlySession.powers).lookup('git')
    );
    t.true(Array.isArray((await E(readOnlyGit).status()).entries));
    // eslint-disable-next-line no-underscore-dangle
    const readOnlyMethods = await E(
      /** @type {any} */ (readOnlyGit),
    ).__getMethodNames__();
    t.false(readOnlyMethods.includes('commit'));

    const controllerPath = localRemote.persistence.guestHandlePath.slice(0, -1);
    const controllerWorkspaceId = await E(host).identify(
      ...controllerPath,
      'git-workspace',
    );
    const guestGitId = await E(localRemote.powers).identify('git');
    t.is(await E(host).identify(...controllerPath, 'git'), guestGitId);
    t.truthy(controllerWorkspaceId);

    const answer = await E(localRemote.powers).evaluate(
      undefined,
      '40 + 2',
      [],
      [],
      ['answer'],
    );
    t.is(answer, 42);
    t.is(await E(localRemote.powers).lookup('answer'), 42);
    t.is(await E(host).identify('answer'), undefined);

    await localRemote.cleanup();
    const reconnected = fixture.trackSession(
      await reconstructEndoCodeMode({
        persistence: localRemote.persistence,
        sockPath: fixture.sockPath,
      }),
    );
    t.is(await E(reconnected.powers).identify('git'), guestGitId);
    t.is(await E(reconnected.powers).lookup('answer'), 42);

    await fixture.restartDaemon();
    const restartedHost = await fixture.connectHost('provision-host-restart');
    const recovered = fixture.trackSession(
      await reconstructEndoCodeMode({
        persistence: localRemote.persistence,
        sockPath: fixture.sockPath,
      }),
    );
    t.is(await E(recovered.powers).identify('git'), guestGitId);
    t.is(
      await E(restartedHost).identify(...controllerPath, 'git-workspace'),
      controllerWorkspaceId,
    );
    t.is(await E(recovered.powers).lookup('answer'), 42);
    const recoveredOrigin = /** @type {GitRemote} */ (
      await E(recovered.powers).lookup('origin')
    );
    t.is(
      (await E(recoveredOrigin).inspect()).defaultPullRef,
      'refs/heads/main',
    );
  },
);

test.serial(
  'code-mode provisioning realizes a named nested Git grant at its canonical path',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const nestedPath = join(fixture.workspace, 'nested-repo');
    const nestedLink = join(fixture.workspace, 'nested-link');
    const outsidePath = join(fixture.root, 'outside-repo');
    await mkdir(nestedPath);
    await mkdir(outsidePath);
    await writeFile(join(nestedPath, 'inside.txt'), 'inside\n');
    await writeFile(join(outsidePath, 'outside.txt'), 'outside\n');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: nestedPath,
    });
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: outsidePath,
    });
    await symlink(nestedPath, nestedLink, 'dir');

    const persistence = await normalizeEndoProvisionSpec(
      {
        fs: 'readWrite',
        gits: {
          nested: { path: ['nested-link'], mode: 'readOnly' },
        },
      },
      {
        harness: 'test',
        sessionId: 'canonical-nested-host-realize',
        cwd: fixture.workspace,
      },
    );
    t.is(persistence.policy.gits?.nested.path, await realpath(nestedPath));

    await rm(nestedLink, { force: true });
    await symlink(outsidePath, nestedLink, 'dir');

    const host = await fixture.connectHost('nested-git-host');
    const guest = await realizeEndoProvisionOnHost(host, persistence);
    const nestedGit = /** @type {ReadOnlyEndoGit} */ (
      await E(guest).lookup('nested')
    );
    const rows = await E(nestedGit).status();
    t.deepEqual(
      rows.map(({ path }) => path),
      ['inside.txt'],
    );

    const controllerPath = persistence.guestHandlePath.slice(0, -1);
    t.true(await E(host).has(...controllerPath, 'gits', 'nested', 'git'));

    await fixture.restartDaemon();
    const recovered = fixture.trackSession(
      await reconstructEndoCodeMode({
        persistence,
        sockPath: fixture.sockPath,
      }),
    );
    const recoveredGit = /** @type {ReadOnlyEndoGit} */ (
      await E(recovered.powers).lookup('nested')
    );
    const recoveredRows = await E(recoveredGit).status();
    t.deepEqual(
      recoveredRows.map(({ path }) => path),
      ['inside.txt'],
    );
  },
);
