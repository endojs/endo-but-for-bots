// @ts-check
/* global process, setTimeout */
/* eslint-disable no-await-in-loop */

/**
 * Live-daemon end-to-end integration test for daemon-agent-tools Phase 4
 * form-based capability provisioning (the un-draft blocker the PR body's
 * "Not verified" section flagged).
 *
 * Boots a real Endo daemon, launches the *actual* Lal manager caplet
 * (`../agent.js`) as an unconfined guest, and drives its provisioning form the
 * way the human operator would — submitting `projectPath` + `capabilities`
 * through `E(host).submit(...)`. It then asserts, against the running daemon,
 * that the manager:
 *
 *   1. minted one writable project mount and derived the git + shell caps under
 *      the scoped host-namespace pet names, and granted `fs` / `git` / `shell`
 *      into the new guest under the canonical *discovery* pet names; and
 *   2. the guest's startup discovery (`discoverCapabilityTools`, exactly what
 *      `spawnWorkerLoop` runs at line 109 of agent.js) registers the backing
 *      filesystem / shell / git tools — and those tools actually operate against
 *      the live mount (write-then-read round-trips through the daemon).
 *
 * No LLM is required: the worker loop the manager spawns after provisioning
 * blocks on its (empty) inbox and never dials the model endpoint, so the
 * form-grant path is exercised hermetically.
 *
 * This is a heavier test than lal's unit suites (it forks a daemon), but it is
 * self-contained, so it runs in the default `yarn test` glob. Run alone with:
 *
 *   cd packages/lal && npx ava test/form-provisioning-daemon.test.js --timeout=120s
 */

import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { execFileSync } from 'child_process';

import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { start, stop, purge, makeEndoClient } from '@endo/daemon';

import { discoverCapabilityTools } from '@endo/agent-tools/discover.js';

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();
const { raw } = String;

// Daemon lifecycle helpers (adapted from fae/test/channel-mention.test.js)

let configPathId = 0;

// A unix domain socket path must fit sockaddr_un (~104–108 bytes). This
// worktree lives under a long scratch path, so the state directory alongside
// the socket would overflow that limit; keep the socket itself in a short
// `os.tmpdir()` path while the (unbounded) state/cache dirs stay under `tmp/`.
const shortSockPath = () => {
  const id = `${process.pid.toString(36)}-${configPathId}`;
  return process.platform === 'win32'
    ? raw`\\?\pipe\endo-${id}-test.sock`
    : path.join(os.tmpdir(), `endo-lal-${id}.sock`);
};

/** @param {string[]} root */
const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath: shortSockPath(),
  pets: new Map(),
  values: new Map(),
});

/**
 * @param {string} testTitle
 * @param {number} configNumber
 */
const getConfigDir = (testTitle, configNumber) => {
  const base = testTitle
    .replace(/\s/giu, '-')
    .replace(/[^\w-]/giu, '')
    .slice(0, 40);
  const id = `${String(configPathId).padStart(4, '0')}-${String(configNumber).padStart(2, '0')}`;
  configPathId += 1;
  return `${base}#${id}`;
};

/** @param {import('ava').ExecutionContext<any>} t */
const prepareHost = async t => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = makeConfig('tmp', getConfigDir(t.title, t.context.length));

  process.env.ENDO_ADDR = '127.0.0.1:0';
  await purge(config);
  await start(config);

  const { getBootstrap, closed } = await makeEndoClient(
    'test-client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();

  const ctx = { cancel, cancelled, config, host };
  t.context.push(ctx);
  return ctx;
};

// Test lifecycle

test.beforeEach((/** @type {import('ava').ExecutionContext<any[]>} */ t) => {
  t.context = [];
});

test.afterEach.always(
  async (/** @type {import('ava').ExecutionContext<any[]>} */ t) => {
    delete process.env.ENDO_ADDR;
    await Promise.allSettled(
      t.context.flatMap(
        (
          /** @type {{ cancel: Function, cancelled: Promise<void>, config: any }} */ ctx,
        ) => {
          ctx.cancel(Error('teardown'));
          return [ctx.cancelled, stop(ctx.config)];
        },
      ),
    );
  },
);

// Helpers

/**
 * Poll an async predicate until it returns truthy or the deadline elapses.
 *
 * @param {() => Promise<boolean>} predicate
 * @param {string} description
 * @param {number} ms
 * @param {(m: string) => void} logFn
 */
const waitUntil = async (
  predicate,
  description,
  ms = 45_000,
  logFn = () => {},
) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const ok = await predicate();
      if (ok) return;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (last) logFn(`last error while waiting: ${last}`);
  throw new Error(`Timed out waiting for ${description} (${ms}ms)`);
};

/**
 * Read all host inbox messages once (a settled snapshot), for diagnostics and
 * to find the manager's outbound form.
 *
 * @param {any} host
 * @returns {Promise<any[]>}
 */
const listHostMessages = async host => {
  const messages = await E(host).listMessages();
  return /** @type {any[]} */ (messages);
};

// Test

test.serial(
  'form provisioning grants fs/git/shell and guest discovery registers the tools',
  async t => {
    t.timeout(90_000);
    const { host } = await prepareHost(t);

    // A real project directory the manager will mint a writable mount over.
    // It must be a git worktree: `provideGit` validates the mount root has a
    // `.git` entry, so a plain directory is rejected for the `git` capability.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-proj-'));
    t.teardown(() => fs.rmSync(projectDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(projectDir, 'README.md'),
      '# Sample project\n',
      'utf-8',
    );
    const git = (...gitArgs) =>
      execFileSync('git', gitArgs, {
        cwd: projectDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    git('init', '-b', 'main');
    git('add', 'README.md');
    git('commit', '-m', 'initial commit');

    // 1. Launch the real Lal manager caplet as an unconfined guest, with the
    //    host's own agent introduced under the `host-agent` name the manager
    //    looks up for provideGuest / provideMount / provideGit / provideShell.
    const managerAgentName = 'profile-for-lal-manager';
    await E(host).provideGuest('lal-manager-handle', {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName: managerAgentName,
    });

    const lalSpecifier = new URL('../agent.js', import.meta.url).href;
    await E(host).makeUnconfined('@main', lalSpecifier, {
      powersName: managerAgentName,
      resultName: 'lal-manager',
    });
    t.log('Lal manager caplet launched');

    // 2. The manager sends its "Add an agent" form to @host on startup. Wait
    //    for it to arrive in the host inbox and capture its message number.
    /** @type {any} */
    let formMsg;
    await waitUntil(
      async () => {
        const messages = await listHostMessages(host);
        formMsg = messages.find(
          m => m.type === 'form' && m.description === 'Add an agent',
        );
        return formMsg !== undefined;
      },
      'the provisioning form to arrive',
      30_000,
      t.log,
    );
    t.truthy(formMsg, 'manager sent the "Add an agent" form');
    t.log(`Form received (message #${formMsg.number})`);

    // 3. Submit the form the way the operator would — configuring a project
    //    directory and all three coding capabilities.
    const agentName = 'coder';
    await E(host).submit(
      formMsg.number,
      harden({
        name: agentName,
        host: 'http://localhost:11434/v1',
        model: 'qwen3',
        authToken: 'ollama',
        projectPath: projectDir,
        capabilities: 'fs,shell,git',
      }),
    );
    t.log('Form submitted with capabilities: fs,shell,git');

    // 4. Wait for the manager to finish provisioning. The scoped mount / git /
    //    shell caps and the guest itself land in the host-agent namespace (the
    //    same namespace `host` reads), and the shell cap is minted last.
    const mountName = `${agentName}-project-mount`;
    const gitName = `${agentName}-git`;
    const shellName = `${agentName}-shell`;
    await waitUntil(
      async () => {
        const [hasAgent, hasMount, hasGit, hasShell] = await Promise.all([
          E(host).has(agentName),
          E(host).has(mountName),
          E(host).has(gitName),
          E(host).has(shellName),
        ]);
        return hasAgent && hasMount && hasGit && hasShell;
      },
      'the manager to mint the mount and grant the capabilities',
      45_000,
      t.log,
    );

    // Surface the manager's reply for the record.
    const messagesAfter = await listHostMessages(host);
    const reply = messagesAfter.find(
      m => m.type === 'package' || m.type === 'note',
    );
    if (reply) t.log('Manager reply:', (reply.strings || []).join(''));

    // 5. Assert the manager minted a single writable project mount plus the
    //    derived git and shell caps under their scoped host-namespace names.
    t.true(await E(host).has(mountName), 'writable project mount was minted');
    t.true(await E(host).has(gitName), 'git capability derived from the mount');
    t.true(
      await E(host).has(shellName),
      'shell capability derived from the mount',
    );

    // 6. Assert the guest exists and holds the three capabilities under the
    //    canonical *discovery* pet names (`fs`, `git`, `shell`) — plus primer.
    //    Looking up the guest's *pet name* returns its messaging handle; the
    //    manager created the guest with `agentName: profile-for-<name>`, which
    //    names the guest's full agent powers (its own namespace) in the host —
    //    that is the reference `spawnWorkerLoop` runs discovery against.
    /** @type {any} */
    const guest = await E(host).lookup(`profile-for-${agentName}`);
    t.truthy(guest, 'guest profile was created');
    t.true(await E(guest).has('fs'), 'guest has `fs` under the canonical name');
    t.true(
      await E(guest).has('git'),
      'guest has `git` under the canonical name',
    );
    t.true(
      await E(guest).has('shell'),
      'guest has `shell` under the canonical name',
    );
    t.true(await E(guest).has('primer'), 'guest was provisioned the primer');

    // 7. The startup-discovery assertion: run exactly what `spawnWorkerLoop`
    //    runs at startup against the *live* guest namespace, and confirm it
    //    registers the backing filesystem / shell / git tools.
    const records = await discoverCapabilityTools(guest);
    const toolNames = new Set(records.map(r => r.name));
    t.log('Discovered tools:', [...toolNames].sort().join(', '));

    const expectedFsTools = [
      'mountReadText',
      'mountList',
      'mountStat',
      'mountWriteText',
    ];
    const expectedShellTools = ['exec', 'inspect'];
    const expectedGitTools = [
      'log',
      'diff',
      'show',
      'commit',
      'branches',
      'createBranch',
      'switchBranch',
      'currentBranch',
      'status',
      'add',
    ];
    for (const name of [
      ...expectedFsTools,
      ...expectedShellTools,
      ...expectedGitTools,
    ]) {
      t.true(
        toolNames.has(name),
        `startup discovery registered the "${name}" tool`,
      );
    }

    // 8. Prove the mount is genuinely writable and the discovered fs tools
    //    operate against the live daemon mount. First read the pre-existing,
    //    git-tracked README through `mountReadText`, then overwrite it through
    //    `mountWriteText`, read the new contents back, and confirm they
    //    materialized on disk — a full write/read round-trip against the live
    //    mount the manager minted. (Overwriting an already-tracked entry avoids
    //    the daemon mount-watcher's harmless new-entry verification log.)
    const writeTool = records.find(r => r.name === 'mountWriteText');
    const readTool = records.find(r => r.name === 'mountReadText');
    t.truthy(writeTool, 'mountWriteText tool present');
    t.truthy(readTool, 'mountReadText tool present');

    const before = await readTool.invoke(harden({ path: 'README.md' }));
    t.is(
      before,
      '# Sample project\n',
      'existing project file reads through fs',
    );

    const marker = '# Sample project\n\nphase4 live-daemon integration ok\n';
    await writeTool.invoke(harden({ path: 'README.md', content: marker }));
    const readBack = await readTool.invoke(harden({ path: 'README.md' }));
    t.is(readBack, marker, 'mountReadText round-trips the written content');
    t.is(
      fs.readFileSync(path.join(projectDir, 'README.md'), 'utf-8'),
      marker,
      'the write landed on disk in the project directory (mount is writable)',
    );
  },
);
