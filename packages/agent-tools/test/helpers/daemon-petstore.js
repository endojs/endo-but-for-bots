// @ts-nocheck
/* global process */

// Real daemon-backed guest petstore harness for the capref tests.
//
// agent-tools resolves a capref-typed tool arg by sending
// `E(powers).lookup(petname)` against the guest's own petstore — exactly what
// every lal tool already does. The capref tests must exercise that live path,
// not a hand-rolled `Map`, so this helper spins up a real Endo daemon, takes a
// host, provisions a guest (the `powers` a tool closes over), and binds a
// formula-backed cap under a friendly petname the way a host does in
// production.
//
// It reuses the daemon's public `start` / `stop` / `purge` / `makeEndoClient`
// building blocks (the same set `@endo/endo-fs-exec`'s daemon test uses) rather
// than reaching into the daemon's private test harness. Daemon tests fork a
// full daemon per test and share filesystem state under `test/tmp`, so every
// caller runs `test.serial` and this helper registers a `t.teardown`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';
import { makeFilePowers } from '@endo/daemon/src/daemon-node-powers.js';
import { lineageOf, makeMount } from '@endo/daemon/src/mount.js';
import { makeReaderRef } from '@endo/daemon/reader-ref.js';
import { makeGit } from '@endo/exo-git';
import { makeNativeGitBackend } from '@endo/git';

const execFileAsync = promisify(execFile);

const dirname = url.fileURLToPath(new URL('.', import.meta.url));

let testCounter = 0;

/**
 * Build a fresh daemon config under `test/tmp/NNNN/`. Socket paths are kept
 * short because `sockaddr_un` bounds the Unix-domain socket path length
 * (~108 bytes on Linux).
 */
const makeConfig = () => {
  testCounter += 1;
  const tag = String(testCounter).padStart(4, '0');
  const base = path.join(dirname, '..', 'tmp', tag);
  return {
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\agent-tools-${tag}.sock`
        : path.join(base, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * Start a daemon, take a host, and provision a guest. The guest exo is the
 * `powers` a tool set closes over: it carries `lookup` (resolve a petname),
 * `storeIdentifier` / `storeValue` (host-side bind), and `evaluate` (mint a
 * formula-backed cap). Registers a teardown that stops the daemon.
 *
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<any>} the guest powers (an `EndoGuest` facet)
 */
export const prepareGuestPowers = async t => {
  const config = makeConfig();
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});

  await purge(config);
  await start(config);
  t.teardown(async () => {
    cancel(new Error('test teardown'));
    await stop(config).catch(() => {});
  });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});

  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();
  const guest = await E(host).provideGuest('agent-tools-test-guest');
  return guest;
};

/**
 * Mint a small formula-backed cap (a counter exo) inside the guest and bind it
 * under `petname`, the way a host binds a granted cap at provisioning. The cap
 * is evaluated in a guest worker so it has a daemon formula and therefore
 * resolves through `E(powers).lookup(petname)` like any granted capability.
 *
 * The counter's `incr()` lets a test prove the resolved value is the *live*
 * cap (it answers an eventual-send and advances shared state), not the petname
 * string.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {any} powers the guest from {@link prepareGuestPowers}
 * @param {string} petname
 * @returns {Promise<any>} the live cap, also reachable via `lookup(petname)`
 */
export const bindCap = async (t, powers, petname) => {
  // `evaluate(worker, source, codeNames, petNames, resultName)` formulates the
  // exo (auto-provisioning the named worker), stores it under `resultName`, and
  // returns the live value. Storing it under `petname` is the host-side bind;
  // the tool later resolves the same name via `lookup`.
  const cap = await E(powers).evaluate(
    'agent-tools-test-worker',
    `
      (() => {
        let value = 0;
        return makeExo(
          'Counter',
          M.interface('Counter', {}, { defaultGuards: 'passable' }),
          {
            incr: () => (value += 1),
            decr: () => (value -= 1),
          },
        );
      })();
    `,
    [],
    [],
    petname,
  );
  return cap;
};

/**
 * Initialize a real git repository at a fresh tmp path with one committed file
 * on `main`, returning the host path. Registers an AVA teardown that removes
 * the directory. Mirrors `packages/daemon/test/git.test.js`'s
 * `provisionGitWorktree` so the north-star loop runs against the same substrate
 * proof.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {string} fileName
 * @param {string} content
 * @returns {Promise<string>} the repo root path
 */
const provisionGitRepo = async (t, fileName, content) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'north-star-git-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  // Pin repo-local config so a user-global commit.gpgsign does not bleed in.
  await execFileAsync('git', ['config', '--local', 'commit.gpgsign', 'false'], {
    cwd: root,
  });
  await execFileAsync('git', ['config', '--local', 'tag.gpgsign', 'false'], {
    cwd: root,
  });
  await fs.promises.writeFile(path.join(root, fileName), content);
  await execFileAsync('git', ['add', fileName], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-m',
      `add ${fileName}`,
    ],
    { cwd: root },
  );
  return root;
};

/**
 * Provision the north-star loop's shared substrate: one physical git worktree,
 * a daemon-backed `EndoMount` over its root, and a `Git` exo wired to a native
 * git backend over the same root. The Git's `worktree()` and the mount share a
 * lineage, so an `EndoMountEntry` minted by `status()` can be staged through
 * `add` exactly as in `packages/daemon/test/git.test.js`.
 *
 * Reuses the in-process `makeGit` / `makeNativeGitBackend` / `makeMount`
 * composition the daemon's git test proves, rather than a daemon-resident Git
 * formula, so the loop test stays focused on the tool boundary while still
 * driving a real native-git substrate over one shared root.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {object} [opts]
 * @param {string} [opts.fileName] initial committed file (default `README.md`)
 * @param {string} [opts.content] initial committed content (default `hello\n`)
 * @returns {Promise<{ repoRoot: string, git: any, mount: any, backend: any }>}
 */
export const prepareGitWorkspace = async (t, opts = {}) => {
  const { fileName = 'README.md', content = 'hello\n' } = opts;
  const repoRoot = await provisionGitRepo(t, fileName, content);
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot, makeReaderRef });
  const git = makeGit({ mount, backend, lineageOf });
  return { repoRoot, git, mount, backend };
};
