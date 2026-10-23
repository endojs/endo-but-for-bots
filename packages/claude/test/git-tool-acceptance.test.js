// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { makeGuestMcpServer } from '@endo/agent-mcp-stdio';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// Test-only reuse of the real daemon harness keeps this acceptance leg on the
// same provisioning path as production without exporting test infrastructure.
// eslint-disable-next-line import/no-relative-packages
import { makeProvisioningFixture } from '../../daemon/test/_code-mode-provisioning-fixture.js';
// eslint-disable-next-line import/no-relative-packages
import { quiesceGitMaintenance } from '../../daemon/test/_git-fixture.js';
import { provisionClaudeSession } from '../index.js';

const execFileAsync = promisify(execFile);
const passableInterface = name =>
  M.interface(name, {}, { defaultGuards: 'passable' });

test.serial(
  'Claude MCP evaluate completes the provisioned Git acceptance loop',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    await quiesceGitMaintenance(fixture.workspace);
    await execFileAsync('git', ['add', 'README.md'], {
      cwd: fixture.workspace,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Seed',
        '-c',
        'user.email=seed@example.test',
        'commit',
        '-q',
        '-m',
        'initial',
      ],
      { cwd: fixture.workspace },
    );
    const bare = path.join(fixture.root, 'origin.git');
    await execFileAsync('git', ['init', '-q', '--bare', bare]);
    await quiesceGitMaintenance(bare);

    const host = await fixture.connectHost('claude-acceptance-host');
    const workspace = await E(host).provideMount(
      fixture.workspace,
      'claude-acceptance-workspace',
    );
    const git = await E(host).provideGit(workspace, 'claude-acceptance-git', {
      identity: {
        authorName: 'Claude Agent',
        authorEmail: 'claude@example.test',
      },
    });
    const remote = await E(host).provideGitRemote(
      git,
      'claude-acceptance-origin',
      {
        name: 'origin',
        url: pathToFileURL(bare).href,
        allowedDirections: ['push'],
        pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
        allowLocalFileTransport: true,
      },
    );

    await E(host).makeUnconfined(
      '@node',
      new URL('./fixtures/acceptance-sandbox-factory-agent.js', import.meta.url)
        .href,
      {
        powersName: '@none',
        resultName: 'claude-acceptance-sandbox-factory',
        env: { ACCEPTANCE_WORKSPACE: fixture.workspace },
      },
    );
    const factory = await E(host).lookup('claude-acceptance-sandbox-factory');
    const shell = await E(host).provideShell(
      workspace,
      'claude-acceptance-shell',
      {
        allowedCommands: ['node'],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        engine: 'sandbox',
        sandbox: factory,
      },
    );
    const guest = await E(host).provideGuest('claude-acceptance-guest', {
      agentName: 'claude-acceptance-agent',
    });
    const grant = await provisionClaudeSession(guest, {
      workspace,
      git,
      remote,
      shell,
    });

    const edited = 'initial\nedited through Claude MCP evaluate\n';
    const source = `(async () => {
    let stage = 'create branch';
    try {
      const edited = ${JSON.stringify(edited)};
      await E(git).createBranch('agent/loop', { switchAfterCreate: true });
      stage = 'edit';
      await E(workspace).writeText(['README.md'], edited);
      stage = 'build';
      const build = await E(shell).exec('node', [
        '-e',
        'process.stdout.write(require("fs").readFileSync("README.md", "utf8"))',
      ]);
      stage = 'status';
      const dirty = await E(git).status();
      stage = 'stage';
      const readmeEntry = await E(workspace).entry(['README.md']);
      await E(git).add([readmeEntry]);
      stage = 'diff';
      const stagedDiff = await E(git).diff({ cached: true });
      stage = 'commit';
      const commit = await E(git).commit('feat: Claude acceptance edit');
      stage = 'push';
      const pushed = await E(origin).push({
        source: 'refs/heads/agent/loop',
        destination: 'refs/heads/agent/loop',
        setUpstream: true,
      });
      const pushedOid = pushed.updatedRefs[0].local.oid;
      stage = 'filesystemAt';
      const historicalFs = await E(git).filesystemAt(pushedOid);
      const root = await E(historicalFs).root();
      const historicalReadme = await E(root).lookup('README.md');
      const historicalQid = await E(historicalReadme).getQid();
      const historicalStat = await E(historicalReadme).getStat();
      return harden({
        buildStdout: build.stdout,
        dirtyPaths: dirty.entries.map(entry => entry.path),
        stagedDiff,
        commitOid: commit.oid,
        pushedOid,
        historicalType: historicalQid.type,
        historicalSize: String(historicalStat.size),
      });
    } catch (error) {
      return harden({ failure: harden({ stage, message: String(error) }) });
    }
  })()`;
    const server = makeGuestMcpServer({ guest, version: 'acceptance-test' });
    const response = /** @type {any} */ (
      await server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'evaluate',
          arguments: {
            source,
            codeNames: grant.codeNames,
            petNamePaths: grant.petNamePaths,
          },
        },
      })
    );
    t.falsy(response.error);
    if (response.result.isError) {
      throw Error(JSON.stringify(response.result));
    }
    const result = JSON.parse(response.result.content[0].text);
    t.falsy(result.failure, JSON.stringify(result.failure));
    t.is(result.buildStdout, edited, 'sandbox build reads the guest edit');
    t.deepEqual(result.dirtyPaths, ['README.md']);
    t.true(result.stagedDiff.includes('edited through Claude MCP evaluate'));
    t.regex(result.commitOid, /^[0-9a-f]{40}$/u);
    t.is(result.pushedOid, result.commitOid);
    t.is(result.historicalType, 'file');
    t.is(
      result.historicalSize,
      String(new TextEncoder().encode(edited).length),
    );

    const { stdout: pushedOid } = await execFileAsync(
      'git',
      ['--git-dir', bare, 'rev-parse', 'refs/heads/agent/loop'],
      { encoding: 'utf8' },
    );
    t.is(pushedOid.trim(), result.pushedOid);
    const { stdout: historical } = await execFileAsync(
      'git',
      ['--git-dir', bare, 'show', `${result.pushedOid}:README.md`],
      { encoding: 'utf8' },
    );
    t.is(historical, edited, 'the pushed ref carries the edit');
    t.is((await E(shell).inspect()).engine, 'sandbox');
  },
);

test('Claude session provisioner refuses a host-engine Shell before binding', async t => {
  /** @type {unknown[][]} */
  const stores = [];
  const guest = makeExo('RefusedClaudeGuest', passableInterface('Guest'), {
    storeValue: async (...args) => stores.push(args),
  });
  const shell = makeExo('HostEngineShell', passableInterface('Shell'), {
    inspect: async () => harden({ engine: 'host' }),
  });
  await t.throwsAsync(
    provisionClaudeSession(guest, {
      workspace: guest,
      git: guest,
      remote: guest,
      shell,
    }),
    { message: /requires a sandbox-engine Shell.*host/ },
  );
  t.deepEqual(stores, [], 'refusal installs no partial grant');
});
