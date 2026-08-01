// @ts-check

/** @import { EndoMount } from '@endo/daemon' */
/** @import { GitRemote, WritableEndoGit } from '@endo/exo-git' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';

// This cross-package integration test deliberately exercises the public
// Agentry thunk from the daemon's lifecycle suite.
/* eslint-disable import/no-relative-packages */
import {
  EndoCredentialUnavailableError,
  provisionEndoCodeMode,
  reconstructEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
/* eslint-enable import/no-relative-packages */
import { makeEndoClient, purge, restart, start, stop } from '../index.js';

const execFileAsync = promisify(execFile);

/** @param {string} root */
const makeConfig = root => ({
  statePath: join(root, 'state'),
  ephemeralStatePath: join(root, 'run'),
  cachePath: join(root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? String.raw`\\?\pipe\endo-provision-${basename(root)}.sock`
      : join(root, 'endo.sock'),
  address: '127.0.0.1:0',
  gcEnabled: false,
  pets: new Map(),
  values: new Map(),
});

/**
 * @param {string} sockPath
 * @param {string} name
 */
const connectHost = async (sockPath, name) => {
  await null;
  const { cancelled, cancel } = makeCancelKit();
  const client = await makeEndoClient(name, sockPath, cancelled);
  client.closed.catch(() => {});
  const bootstrap = await client.getBootstrap();
  const host = await E(bootstrap).host();
  const cleanup = async () => {
    cancel(Error(`${name} closed`));
    await client.closed.catch(() => {});
  };
  return { host, cleanup };
};

test.serial(
  'code-mode provisioning retains scoped guest authority across reconnect and restart',
  async t => {
    t.timeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'endo-provision-daemon-'));
    const workspace = join(root, 'repo');
    const bareRemote = join(root, 'remote.git');
    const config = makeConfig(root);
    /** @type {Array<() => Promise<void>>} */
    const clientCleanups = [];
    t.teardown(async () => {
      await stop(config);
      await Promise.allSettled(clientCleanups.map(cleanup => cleanup()));
      await rm(root, { recursive: true, force: true });
    });

    await mkdir(workspace);
    await writeFile(join(workspace, 'README.md'), 'initial\n');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: workspace,
    });
    await execFileAsync('git', ['add', 'README.md'], { cwd: workspace });
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
      { cwd: workspace },
    );
    await execFileAsync('git', ['init', '--bare', '-q', bareRemote]);
    await purge(config);
    await start(config);

    let hostConnection = await connectHost(config.sockPath, 'provision-host');
    clientCleanups.push(hostConnection.cleanup);
    let { host } = hostConnection;
    await E(host).makeDirectory(['credentials']);
    await E(host).provideBearerCredential(['credentials', 'github'], {
      audience: 'https://github.com',
      token: 'ephemeral-test-token',
    });
    await E(host).provideBearerCredential(['credentials', 'wrong'], {
      audience: 'https://gitlab.com',
      token: 'ephemeral-test-token',
    });

    const noGrant = await provisionEndoCodeMode({
      sessionId: 'no-grant',
      cwd: workspace,
      sockPath: config.sockPath,
    });
    clientCleanups.push(noGrant.cleanup);
    t.false(await E(noGrant.powers).has('workspace'));
    t.false(await E(noGrant.powers).has('git'));

    const fsReadOnly = await provisionEndoCodeMode({
      sessionId: 'fs-read-only',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: { fs: 'readOnly' },
    });
    clientCleanups.push(fsReadOnly.cleanup);
    const readOnlyWorkspace = /** @type {EndoMount} */ (
      await E(fsReadOnly.powers).lookup('workspace')
    );
    t.is(await E(readOnlyWorkspace).readText('README.md'), 'initial\n');
    await t.throwsAsync(
      E(readOnlyWorkspace).writeText('blocked.txt', 'blocked\n'),
      { message: /read-only/ },
    );

    const fsReadWrite = await provisionEndoCodeMode({
      sessionId: 'fs-read-write',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: { fs: 'readWrite' },
    });
    clientCleanups.push(fsReadWrite.cleanup);
    const writableWorkspace = /** @type {EndoMount} */ (
      await E(fsReadWrite.powers).lookup('workspace')
    );
    await E(writableWorkspace).writeText('created.txt', 'created\n');
    t.is(await E(writableWorkspace).readText('created.txt'), 'created\n');

    const gitReadOnly = await provisionEndoCodeMode({
      sessionId: 'git-read-only',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: { git: 'readOnly' },
    });
    clientCleanups.push(gitReadOnly.cleanup);
    const readOnlyGit = /** @type {WritableEndoGit} */ (
      await E(gitReadOnly.powers).lookup('git')
    );
    await E(readOnlyGit).status();
    await t.throwsAsync(E(readOnlyGit).commit('blocked'), {
      message: /read-only Git capability/,
    });

    const independent = await provisionEndoCodeMode({
      sessionId: 'independent-scopes',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: { fs: 'readOnly', git: 'readWrite' },
    });
    clientCleanups.push(independent.cleanup);
    const independentWorkspace = /** @type {EndoMount} */ (
      await E(independent.powers).lookup('workspace')
    );
    const writableGit = /** @type {WritableEndoGit} */ (
      await E(independent.powers).lookup('git')
    );
    await t.throwsAsync(
      E(independentWorkspace).writeText('still-blocked.txt', 'blocked\n'),
      { message: /read-only/ },
    );
    await E(writableGit).createBranch('ordinary-mode');
    await t.throwsAsync(
      E(writableGit).commit('blocked amend', { amend: true }),
      {
        message: /without history-rewrite authority/,
      },
    );

    const gitHistory = await provisionEndoCodeMode({
      sessionId: 'git-history-rewrite',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: { git: 'historyRewrite' },
    });
    clientCleanups.push(gitHistory.cleanup);
    const historyGit = /** @type {WritableEndoGit} */ (
      await E(gitHistory.powers).lookup('git')
    );
    const historyWorktree = /** @type {EndoMount} */ (
      await E(historyGit).worktree()
    );
    await E(historyWorktree).writeText('history.txt', 'rewrite\n');
    const historyEntry = await E(historyWorktree).entry(['history.txt']);
    await E(historyGit).add([historyEntry]);
    await E(historyGit).commit('rewritten initial', { amend: true });

    const localRemote = await provisionEndoCodeMode({
      sessionId: 'local-remote',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: {
        git: 'readWrite',
        gitRemotes: {
          origin: {
            url: new URL(`file://${bareRemote}`).href,
            allowedDirections: ['push'],
            allowedBranches: ['main'],
            allowLocalFileTransport: true,
          },
        },
      },
    });
    clientCleanups.push(localRemote.cleanup);
    const origin = /** @type {GitRemote} */ (
      await E(localRemote.powers).lookup('origin')
    );
    const remoteInspection = await E(origin).inspect();
    t.deepEqual(remoteInspection.allowedDirections, ['push']);

    const credentialSession = await provisionEndoCodeMode({
      sessionId: 'credential-remote',
      cwd: workspace,
      sockPath: config.sockPath,
      spec: {
        git: 'readWrite',
        gitRemotes: {
          upstream: {
            url: 'https://github.com/endojs/endo.git',
            credential: ['credentials', 'github'],
          },
        },
      },
    });
    clientCleanups.push(credentialSession.cleanup);
    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          sessionId: 'missing-credential',
          cwd: workspace,
          sockPath: config.sockPath,
          spec: {
            git: 'readWrite',
            gitRemotes: {
              upstream: {
                url: 'https://github.com/endojs/endo.git',
                credential: ['credentials', 'missing'],
              },
            },
          },
        }),
      {
        instanceOf: EndoCredentialUnavailableError,
        message: /reprovision the credential on the host and retry/,
      },
    );
    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          sessionId: 'wrong-audience',
          cwd: workspace,
          sockPath: config.sockPath,
          spec: {
            git: 'readWrite',
            gitRemotes: {
              upstream: {
                url: 'https://github.com/endojs/endo.git',
                credential: ['credentials', 'wrong'],
              },
            },
          },
        }),
      { message: /does not match.*audience/ },
    );

    const controllerPath = localRemote.persistence.guestPetName.slice(0, -1);
    const controllerWorkspaceId = await E(host).identify(
      ...controllerPath,
      'git-workspace',
    );
    const guestGitId = await E(localRemote.powers).identify('git');
    t.is(
      guestGitId,
      await E(host).identify(...controllerPath, 'git'),
      'guest and controller retain the same Git formula',
    );
    t.truthy(controllerWorkspaceId, 'controller mount alias remains retained');

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

    await t.throwsAsync(
      () =>
        reconstructEndoCodeMode({
          sockPath: config.sockPath,
          persistence: {
            ...fsReadOnly.persistence,
            policy: { ...fsReadOnly.persistence.policy, fs: 'readWrite' },
          },
        }),
      { message: /cannot widen or change/ },
    );

    await localRemote.cleanup();
    const reconnected = await reconstructEndoCodeMode({
      persistence: localRemote.persistence,
      sockPath: config.sockPath,
    });
    clientCleanups.push(reconnected.cleanup);
    t.is(await E(reconnected.powers).identify('git'), guestGitId);
    t.is(await E(reconnected.powers).lookup('answer'), 42);
    t.is(
      await E(host).identify(...controllerPath, 'git'),
      guestGitId,
      'disconnect and reconnect preserve the controller alias',
    );

    await Promise.allSettled(clientCleanups.map(cleanup => cleanup()));
    clientCleanups.length = 0;
    await restart(config);
    hostConnection = await connectHost(
      config.sockPath,
      'provision-host-restart',
    );
    clientCleanups.push(hostConnection.cleanup);
    ({ host } = hostConnection);

    const recovered = await reconstructEndoCodeMode({
      persistence: localRemote.persistence,
      sockPath: config.sockPath,
    });
    clientCleanups.push(recovered.cleanup);
    t.is(await E(recovered.powers).identify('git'), guestGitId);
    t.is(
      await E(host).identify(...controllerPath, 'git-workspace'),
      controllerWorkspaceId,
    );
    t.is(await E(recovered.powers).lookup('answer'), 42);
    t.truthy(await E(recovered.powers).lookup('origin'));

    await t.throwsAsync(
      () =>
        reconstructEndoCodeMode({
          persistence: credentialSession.persistence,
          sockPath: config.sockPath,
        }),
      {
        instanceOf: EndoCredentialUnavailableError,
        message: /reprovision the credential on the host and retry/,
      },
    );
  },
);
