// @ts-check

/** @import { EndoMount } from '@endo/daemon' */
/** @import { GitRemote, ReadOnlyEndoGit, ReadWriteEndoGit } from '@endo/exo-git' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

/* eslint-disable import/no-relative-packages */
import {
  provisionEndoCodeMode,
  reconstructEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
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
