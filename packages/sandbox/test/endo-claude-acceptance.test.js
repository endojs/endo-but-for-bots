// @ts-check
// spell-out-exempt: startGuestBroker's public option is named parentDir.

// The Phase 7 acceptance loop against a real daemon and bwrap slice. The MCP
// client is scripted so the test is deterministic; no model or credential is
// involved.

import test from '@endo/ses-ava/prepare-endo.js';

import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { startGuestBroker } from '@endo/agent-mcp-stdio';
import { provisionEndoClaudeGuest } from '@endo/claude';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

/** @import { ExecutionContext } from 'ava' */
/** @import { EndoGuest } from '@endo/daemon' */
/** @import { SandboxFactory } from '../src/types.js' */

/** @typedef {{ listBackends(): Promise<Array<{ name: string, available: boolean, reason?: string }>>, make(options: object): Promise<unknown> }} ShellSandboxFactory */

const execFile = promisify(childProcess.execFile);
const sandboxAgentHref = new URL('../src/agent.js', import.meta.url).href;

/**
 * @param {ExecutionContext} t
 */
const provisionDaemon = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-claude-loop-'),
  );
  const config = {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath: path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    gcEnabled: true,
  };
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  await purge(config);
  await start(config);
  const { getBootstrap, closed } = await makeEndoClient(
    'endo-claude-phase-seven-test',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  t.teardown(async () => {
    await stop(config).catch(() => {});
    cancel(Error('test teardown'));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, host: E(getBootstrap()).host(), closed };
};

/**
 * @param {ExecutionContext} t
 * @param {string} parent
 */
const provisionRepository = async (t, parent) => {
  const seed = path.join(parent, 'seed');
  const remote = path.join(parent, 'remote.git');
  const workspace = path.join(parent, 'workspace');
  await fs.promises.mkdir(seed);
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: seed });
  await fs.promises.writeFile(path.join(seed, 'README.md'), 'seed\n');
  await fs.promises.writeFile(
    path.join(seed, 'Makefile'),
    'check:\n\tgrep -q "accepted by endo-claude" README.md\n',
  );
  await execFile('git', ['add', 'README.md', 'Makefile'], { cwd: seed });
  await execFile(
    'git',
    [
      '-c',
      'user.name=Seed Author',
      '-c',
      'user.email=seed@example.test',
      'commit',
      '-q',
      '-m',
      'chore: seed acceptance repository',
    ],
    { cwd: seed },
  );
  await execFile('git', ['clone', '--bare', seed, remote]);
  await execFile('git', ['clone', remote, workspace]);
  t.teardown(() => fs.promises.rm(workspace, { recursive: true, force: true }));
  return { remote, workspace };
};

/**
 * @param {string} socketPath
 */
const connectMcp = async socketPath => {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  await once(socket, 'connect');

  let nextIdentifier = 1;
  let buffered = '';
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  socket.on('data', chunk => {
    buffered += String(chunk);
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter !== undefined) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
      newline = buffered.indexOf('\n');
    }
  });
  const failPending = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on('error', failPending);
  socket.on('close', () => failPending(Error('MCP socket closed')));

  return harden({
    /**
     * @param {string} method
     * @param {unknown} [params]
     */
    rpc: (method, params = undefined) => {
      const id = nextIdentifier;
      nextIdentifier += 1;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
      return response;
    },
    close: () => socket.destroy(),
  });
};

const evaluateSource = `
(async () => {
  await E(git).createBranch('agent/phase-seven', { switchAfterCreate: true });
  const expected = 'accepted by endo-claude\\n';
  await E(workspace).writeText(['README.md'], expected);

  const build = await E(shell).exec('make', ['check']);
  if (build.exitCode !== 0) {
    throw Error('build failed: ' + build.stderr);
  }

  const status = await E(git).status({ untracked: 'all' });
  const entry = await E(workspace).entry(['README.md']);
  await E(git).add([entry]);
  const commit = await E(git).commit(
    'feat: complete the endo-claude acceptance loop',
  );
  const push = await E(remote).push({
    source: 'refs/heads/agent/phase-seven',
    destination: 'refs/heads/agent/phase-seven',
  });
  const update = push.updatedRefs[0];
  const pushedOid = update.local.oid;

  const historicalFilesystem = await E(git).filesystemAt(pushedOid);
  const historicalRoot = await E(historicalFilesystem).root();
  const historicalFile = await E(historicalRoot).lookup('README.md');
  const historicalBlob = await E(historicalFile).snapshot();
  const historicalText = await E(historicalBlob).text();

  return harden({
    buildExitCode: build.exitCode,
    dirtyPaths: status.entries.map(({ path: dirtyPath }) => dirtyPath),
    commitOid: commit.oid,
    pushedOid,
    pushedRef: update.remote,
    historicalText,
  });
})()
`;

test.serial(
  'a sandboxed endo-claude guest completes the worked loop through MCP evaluate',
  async t => {
    t.timeout(180_000);
    const { root, host, closed } = await provisionDaemon(t);
    const { remote, workspace } = await provisionRepository(t, root);

    const sandboxFactory = /** @type {SandboxFactory} */ (
      await E(host).makeUnconfined(undefined, sandboxAgentHref, {
        powersName: '@agent',
        resultName: 'phase-seven-sandbox-factory',
      })
    );
    const backends = await E(sandboxFactory).listBackends();
    const bubblewrap = backends.find(({ name }) => name === 'bwrap');
    if (bubblewrap?.available !== true) {
      t.pass(`SKIP: bwrap unavailable: ${bubblewrap?.reason ?? 'not found'}`);
      return;
    }

    const workspaceMount = await E(host).provideMount(
      workspace,
      'phase-seven-workspace',
    );
    const git = await E(host).provideGit(workspaceMount, 'phase-seven-git', {
      identity: {
        authorName: 'Endo Claude',
        authorEmail: 'endo-claude@example.test',
      },
    });
    await E(host).provideGitRemote(git, 'phase-seven-remote', {
      name: 'origin',
      url: pathToFileURL(remote).href,
      allowedDirections: ['push'],
      fetchRefspecs: [],
      pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
      allowLocalFileTransport: true,
    });

    await E(host).provideShell(workspaceMount, 'phase-seven-host-shell', {
      allowedCommands: ['echo', 'make'],
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
      searchPath: process.env.PATH ?? '/usr/bin:/bin',
      engine: 'host',
    });
    await t.throwsAsync(
      provisionEndoClaudeGuest(host, {
        handleName: 'rejected-claude-handle',
        agentName: 'rejected-claude-guest',
        grants: {
          workspace: 'phase-seven-workspace',
          git: 'phase-seven-git',
          remote: 'phase-seven-remote',
          shell: 'phase-seven-host-shell',
        },
      }),
      { message: /not sandbox-backed.*refusing/ },
      'the session provisioner refuses the host engine',
    );
    t.false(
      await E(host).has('rejected-claude-handle'),
      'refusal happens before the guest is created',
    );

    const sandboxShell = await E(host).provideShell(
      workspaceMount,
      'phase-seven-sandbox-shell',
      {
        allowedCommands: ['echo', 'make'],
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
        engine: 'sandbox',
        sandbox: /** @type {ShellSandboxFactory} */ (
          /** @type {unknown} */ (sandboxFactory)
        ),
      },
    );
    const smoke = await E(sandboxShell)
      .exec('echo', ['ready'])
      .catch(error => error);
    if (smoke instanceof Error || smoke.exitCode !== 0) {
      t.pass(
        `SKIP: bwrap cannot create a slice: ${smoke.message ?? smoke.stderr ?? ''}`,
      );
      return;
    }
    t.is((await E(sandboxShell).inspect()).engine, 'sandbox');

    const guest = /** @type {EndoGuest} */ (
      await provisionEndoClaudeGuest(host, {
        handleName: 'phase-seven-claude-handle',
        agentName: 'phase-seven-claude-guest',
        grants: {
          workspace: 'phase-seven-workspace',
          git: 'phase-seven-git',
          remote: 'phase-seven-remote',
          shell: 'phase-seven-sandbox-shell',
        },
      })
    );
    const workedLoopGrantNames = (await E(guest).list()).filter(
      name => !name.startsWith('@'),
    );
    t.deepEqual(
      workedLoopGrantNames,
      ['git', 'remote', 'shell', 'workspace'],
      'the guest holds exactly the four non-special worked-loop grants',
    );

    const formulaId = await E(host).identify('phase-seven-claude-guest');
    t.is(typeof formulaId, 'string');
    const broker = await startGuestBroker({
      connection: harden({ host, closed, close: () => {} }),
      formulaId: /** @type {string} */ (formulaId),
      version: '0.0.0',
      parentDir: root,
    });
    const mcp = await connectMcp(broker.socketPath);
    try {
      const initialized = await mcp.rpc('initialize', {
        protocolVersion: '2025-06-18',
      });
      t.is(initialized.result.serverInfo.name, 'endo');
      const catalog = await mcp.rpc('tools/list');
      t.true(
        catalog.result.tools.some(({ name }) => name === 'evaluate'),
        'the MCP catalog exposes evaluate',
      );

      const response = await mcp.rpc('tools/call', {
        name: 'evaluate',
        arguments: {
          source: evaluateSource,
          codeNames: ['workspace', 'git', 'remote', 'shell'],
          petNamePaths: [['workspace'], ['git'], ['remote'], ['shell']],
        },
      });
      t.falsy(response.error, JSON.stringify(response.error));
      t.falsy(response.result.isError, response.result.content[0].text);
      const result = JSON.parse(response.result.content[0].text);
      t.is(result.buildExitCode, 0);
      t.deepEqual(result.dirtyPaths, ['README.md']);
      t.regex(result.commitOid, /^[0-9a-f]{40}$/u);
      t.is(result.pushedOid, result.commitOid);
      t.is(result.pushedRef, 'refs/heads/agent/phase-seven');
      t.is(result.historicalText, 'accepted by endo-claude\n');

      const { stdout } = await execFile('git', [
        '--git-dir',
        remote,
        'show',
        'refs/heads/agent/phase-seven:README.md',
      ]);
      t.is(stdout, 'accepted by endo-claude\n');
    } finally {
      mcp.close();
      await broker.close();
    }
  },
);
