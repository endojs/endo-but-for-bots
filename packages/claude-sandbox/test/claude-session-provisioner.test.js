// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';

import { makeClaudeSessionProvisioner } from '../src/claude-session-provisioner.js';

const keyFor = names => names.join('/');

test('provisions and removes one isolated client per Floot session', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(keyFor(path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const filesystemCalls = [];
  const provisionCalls = [];
  const removedDirectories = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name, directory) {
        filesystemCalls.push({ name, directory });
        names.set(name, harden({}));
      },
      async provisionSession(_host, spec, options) {
        provisionCalls.push({ spec, options });
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        for (const name of options.removeNames) {
          names.delete(keyFor(Array.isArray(name) ? name : [name]));
        }
        return harden({
          client: names.get(keyFor(options.resultName)),
          sessionId: 'sandbox-session',
          hostMountPoint: '/mount',
          rootfsLabel: 'test',
        });
      },
      async removeDirectory(directory, options) {
        removedDirectories.push({ directory, options });
      },
    },
  );

  const [first, second] = await Promise.all([
    E(provisioner).provision('session-a'),
    E(provisioner).provision('session-a'),
  ]);
  t.is(first, 'claude-client-session-a');
  t.is(second, first);
  t.deepEqual(filesystemCalls, [
    {
      name: 'claude-workspace-session-a',
      directory: '/workspaces/session-a',
    },
  ]);
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].options.resultName, [
    'floot',
    'controller-profile',
    'claude-client-session-a',
  ]);
  t.true(names.has('floot/controller-profile/claude-client-session-a'));

  await E(provisioner).remove('session-a');
  t.false(names.has('floot/controller-profile/claude-client-session-a'));
  t.deepEqual(removedDirectories, [
    {
      directory: '/workspaces/session-a',
      options: { recursive: true, force: true },
    },
  ]);
});

test('forwards the MCP tool-bridge mount options to the session provisioner', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(keyFor(path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const provisionCalls = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name) {
        names.set(name, harden({}));
      },
      async provisionSession(_host, spec, options) {
        provisionCalls.push({ spec, options });
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        return harden({ client: spec.name });
      },
    },
  );

  const mcp = {
    socketDir: '/tmp/floot-mcp/session-b',
    innerDir: '/endo-mcp',
    configPath: '/endo-mcp/mcp.json',
  };
  await E(provisioner).provision('session-b', harden({ mcp }));
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].spec.mcp, mcp);
});

test('a workspaceDir override roots the filesystem at a shared worktree', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(keyFor(path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const filesystemCalls = [];
  const removedDirectories = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name, directory) {
        filesystemCalls.push({ name, directory });
        names.set(name, harden({}));
      },
      async provisionSession(_host, spec, options) {
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        return harden({ client: spec.name });
      },
      async removeDirectory(directory, options) {
        removedDirectories.push({ directory, options });
      },
    },
  );

  await E(provisioner).provision(
    'session-c',
    harden({ workspaceDir: '/git/worktrees/session-c' }),
  );
  // The workspace filesystem is rooted at the shared worktree, not the private
  // per-session scratch directory.
  t.deepEqual(filesystemCalls, [
    {
      name: 'claude-workspace-session-c',
      directory: '/git/worktrees/session-c',
    },
  ]);

  // remove() only deletes the private default path, never the shared worktree.
  await E(provisioner).remove('session-c');
  t.deepEqual(removedDirectories, [
    {
      directory: '/workspaces/session-c',
      options: { recursive: true, force: true },
    },
  ]);
});

test('rejects session ids that could escape its namespace', async t => {
  const hostAgent = harden({});
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem() {
        return undefined;
      },
      async provisionSession() {
        throw Error('must not provision');
      },
    },
  );

  await t.throwsAsync(() => E(provisioner).provision('../escape'), {
    message: /Invalid Floot session id/,
  });
});
