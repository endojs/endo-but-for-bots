// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { sha256 } from '@endo/sha256';
import { encodeBase64 } from '@endo/base64';

/** @import { ExecutionContext } from 'ava' */

import {
  gitClone,
  internalHelpers,
  makeNativeGitBackend,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

test('gitClone rejects unsafe clone boundaries before transport', async t => {
  const nonEmptyDestination = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-clone-nonempty-'),
  );
  t.teardown(() =>
    fs.promises.rm(nonEmptyDestination, { recursive: true, force: true }),
  );
  await fs.promises.writeFile(path.join(nonEmptyDestination, 'occupied'), '');

  await t.throwsAsync(
    gitClone({
      url: 'http://github.com/example/repo.git',
      destPath: '/tmp/unused-clone',
    }),
    { message: /HTTP remotes are not supported/ },
  );
  await t.throwsAsync(
    gitClone({
      url: 'https://token@github.com/example/repo.git',
      destPath: '/tmp/unused-clone',
    }),
    { message: /must not include embedded credentials/ },
  );
  await t.throwsAsync(
    gitClone({
      url: 'file:///tmp/repo.git',
      destPath: '/tmp/unused-clone',
      allowLocalFileTransport: true,
      credential: { kind: 'bearer', material: { token: 'test-token' } },
    }),
    { message: /credentials require https remotes/ },
  );
  await t.throwsAsync(
    gitClone({
      url: 'file:///tmp/repo.git',
      destPath: '/tmp/unused-clone',
    }),
    { message: /file transport requires allowLocalFileTransport/ },
  );
  await t.throwsAsync(
    gitClone({
      url: 'file:///tmp/repo.git',
      destPath: nonEmptyDestination,
      allowLocalFileTransport: true,
    }),
    { message: /destination mount must be empty/ },
  );
});

test('NativeGitBackend.tree documents every method GitTree advertises', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  await fs.promises.writeFile(path.join(repoRoot, 'README.md'), 'hello\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init'],
    { cwd: repoRoot },
  );

  const tree = await backend.tree('HEAD');
  /** @type {string[]} */
  const advertised =
    // eslint-disable-next-line no-underscore-dangle
    await E(/** @type {any} */ (tree)).__getMethodNames__();
  const methods = advertised.filter(name => !name.startsWith('__'));
  /** @type {string[]} */
  const [overview, unknown, ...docs] = await Promise.all([
    E(tree).help(),
    E(tree).help('unknownMethod'),
    ...methods.map(method => E(tree).help(method)),
  ]);
  t.true(overview.startsWith('GitTree - '));
  methods.forEach((method, index) => {
    const doc = docs[index];
    t.not(doc, '', `GitTree.${method} must have documentation`);
    t.true(
      doc.startsWith(`${method}(`),
      `GitTree.${method} documentation must open with its signature`,
    );
  });
  // The fallback wording is spelled out rather than imported so the test
  // pins what a caller actually sees.
  t.is(unknown, 'No documentation available for method "unknownMethod".');
});

test('NativeGitBackend.tree exposes GitBlob help through eventual send', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  await fs.promises.writeFile(path.join(repoRoot, 'README.md'), 'hello\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init'],
    { cwd: repoRoot },
  );

  const tree = await backend.tree('HEAD');
  const blob = await tree.lookup('README.md');
  const blobRef = E(/** @type {any} */ (blob));
  /** @type {string[]} */
  const advertised =
    // eslint-disable-next-line no-underscore-dangle
    await E(/** @type {any} */ (blob)).__getMethodNames__();
  const methods = advertised.filter(name => !name.startsWith('__'));
  /** @type {string[]} */
  const [overview, unknown, ...docs] = await Promise.all([
    blobRef.help(),
    blobRef.help('unknownMethod'),
    ...methods.map(method => blobRef.help(method)),
  ]);
  t.true(overview.startsWith('GitBlob - '));
  methods.forEach((method, index) => {
    const doc = docs[index];
    t.not(doc, '', `GitBlob.${method} must have documentation`);
    t.true(
      doc.startsWith(`${method}(`),
      `GitBlob.${method} documentation must open with its signature`,
    );
  });
  t.is(unknown, 'No documentation available for method "unknownMethod".');
});

/**
 * Commit a single file and return its GitBlob for the committed content.
 *
 * @param {ExecutionContext} t
 * @param {string} name
 * @param {string} content
 */
const commitBlob = async (t, name, content) => {
  const { backend, repoRoot } = await provisionRepo(t);
  await fs.promises.writeFile(path.join(repoRoot, name), content);
  await execFileAsync('git', ['add', name], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init'],
    { cwd: repoRoot },
  );
  const tree = await backend.tree('HEAD');
  return tree.lookup(name);
};

test('GitBlob.byteRange attenuates to a derived blob over a byte interval', async t => {
  const blob = /** @type {any} */ (
    await commitBlob(t, 'data.txt', 'hello world\n')
  );
  const b64 = s => encodeBase64(sha256(encodeUtf8(s)));

  const hello = await E(blob).byteRange(0n, 5n);
  t.is(await E(hello).text(), 'hello');
  t.is(await E(hello).size(), 5n);
  t.is(await E(hello).sha256(), b64('hello'));

  // A range of a range intersects and never regains authority.
  t.is(await E(await E(hello).byteRange(1n, 3n)).text(), 'el');
  t.is(await E(await E(hello).byteRange(3n, 100n)).text(), 'lo');

  // EOF clamp and start === end.
  t.is(await E(await E(blob).byteRange(6n, 100n)).text(), 'world\n');
  t.is(await E(await E(blob).byteRange(3n, 3n)).text(), '');

  // byteRange composes within the selected authority.
  t.is(await E(await E(hello).byteRange(1n, 3n)).text(), 'el');

  // EINVAL on an inverted or negative byte range.
  await t.throwsAsync(() => E(blob).byteRange(5n, 2n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).byteRange(-1n, 2n), {
    message: /EINVAL|safe/,
  });
});

test('GitBlob.textRange attenuates to a line interval (LF, terminal-LF, CRLF)', async t => {
  const lf = /** @type {any} */ (await commitBlob(t, 'lf.txt', 'a\nb\nc\n'));
  t.is(await E(await E(lf).textRange(0, 2)).text(), 'a\nb');
  t.is(await E(await E(lf).textRange(0, 100)).text(), 'a\nb\nc\n');
  t.is(await E(await E(lf).textRange(1, 1)).text(), '');

  const term = /** @type {any} */ (await commitBlob(t, 'term.txt', 'a\nb\n'));
  t.is(await E(await E(term).textRange(2, 3)).text(), '');

  const crlf = /** @type {any} */ (
    await commitBlob(t, 'crlf.txt', 'x\r\ny\r\n')
  );
  t.is(await E(await E(crlf).textRange(0, 1)).text(), 'x\r');

  // Composition: byte range then text range, and text range then byte range.
  const doc = /** @type {any} */ (
    await commitBlob(t, 'doc.txt', 'one\ntwo\nthree\n')
  );
  const firstEight = await E(doc).byteRange(0n, 8n); // 'one\ntwo\n'
  t.is(await E(await E(firstEight).textRange(0, 1)).text(), 'one');
  const twoLines = await E(doc).textRange(0, 2); // 'one\ntwo'
  t.is(await E(await E(twoLines).byteRange(0n, 3n)).text(), 'one');
});

/**
 * A repository root the backend accepts, so `remotePush` reaches its argv
 * construction. Every assertion below rejects before any transport runs.
 *
 * @param {ExecutionContext} t
 */
const provisionRepoRoot = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-backend-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const backend = makeNativeGitBackend({ repoRoot: root });
  await backend.assertRepositoryRoot();
  return backend;
};

const provisionRepo = async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-status-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  return { backend: makeNativeGitBackend({ repoRoot }), repoRoot };
};

test('NativeGitBackend.status reads large output and preserves status columns', async t => {
  t.timeout(60_000);
  const { backend, repoRoot } = await provisionRepo(t);

  await fs.promises.writeFile(path.join(repoRoot, 'deleted.txt'), 'tracked');
  await execFileAsync('git', ['add', 'deleted.txt'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'tracked'],
    { cwd: repoRoot },
  );
  await fs.promises.rm(path.join(repoRoot, 'deleted.txt'));

  const untrackedDir = path.join(repoRoot, 'untracked');
  await fs.promises.mkdir(untrackedDir);
  const fileCount = 30_000;
  const fileSuffix = 'x'.repeat(48);
  for (let start = 0; start < fileCount; start += 500) {
    const writes = [];
    for (let i = start; i < Math.min(start + 500, fileCount); i += 1) {
      writes.push(
        fs.promises.writeFile(
          path.join(untrackedDir, `file-${i}-${fileSuffix}.txt`),
          '',
        ),
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(writes);
  }

  const entries = await backend.status();
  t.is(entries.length, fileCount + 1);
  // The porcelain record for this path begins with a leading space (` D`),
  // so this asserts the streaming read did not trim its status columns.
  t.like(
    entries.find(entry => entry.path === 'deleted.txt'),
    {
      path: 'deleted.txt',
      index: 'clean',
      worktree: 'deleted',
    },
  );
});

test('NativeGitBackend.status filters untracked files according to options', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  await fs.promises.mkdir(path.join(repoRoot, 'tree', 'deeper'), {
    recursive: true,
  });
  await fs.promises.writeFile(path.join(repoRoot, 'tree', 'deeper', 'a'), '');
  await fs.promises.writeFile(path.join(repoRoot, 'one'), '');

  const pathsFor = async options =>
    (await backend.status(options)).map(entry => entry.path).sort();
  t.deepEqual(await pathsFor(), ['one', 'tree/deeper/a']);
  t.deepEqual(await pathsFor({ untracked: 'normal' }), ['one', 'tree/']);
  t.deepEqual(await pathsFor({ untracked: 'no' }), []);
  await t.throwsAsync(
    backend.status(/** @type {any} */ ({ untracked: 'invalid' })),
    { message: /status\.untracked/ },
  );
});

test('remoteFetch keeps above-ceiling transport output within TOOL_OUTPUT_LIMIT', async t => {
  t.timeout(120_000);
  const { TOOL_OUTPUT_LIMIT } = internalHelpers;

  const sourceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-remote-source-'),
  );
  t.teardown(() =>
    fs.promises.rm(sourceRoot, { recursive: true, force: true }),
  );
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: sourceRoot });
  await fs.promises.writeFile(path.join(sourceRoot, 'seed.txt'), 'seed\n');
  await execFileAsync('git', ['add', 'seed.txt'], { cwd: sourceRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed'],
    { cwd: sourceRoot },
  );
  const { stdout: revParseOut } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: sourceRoot },
  );
  const oid = revParseOut.trim();
  // Enough long-named branches that fetch's per-ref summary (one
  // ` * [new branch] <name> -> origin/<name>` line each, naming the branch
  // twice) comfortably exceeds TOOL_OUTPUT_LIMIT on its own.
  const branchCount = 400;
  const branchPad = 'x'.repeat(120);
  execFileSync('git', ['update-ref', '--stdin'], {
    cwd: sourceRoot,
    input: Array.from(
      { length: branchCount },
      (_, i) => `create refs/heads/branch-${i}-${branchPad} ${oid}\n`,
    ).join(''),
  });

  const { backend } = await provisionRepo(t);
  const result = await backend.remoteFetch({
    url: pathToFileURL(sourceRoot).href,
    refspecs: ['+refs/heads/*:refs/remotes/origin/*'],
  });
  // The long-named branches plus the seed `main` branch.
  t.is(result.updatedRefs.length, branchCount + 1);
  // The bounded text, marker included, fits under TOOL_OUTPUT_LIMIT — the
  // same 50,000-character ceiling `@endo/exo-git` enforces structurally on
  // `GitRemote` results — so the exo layer passes it through untouched
  // instead of re-truncating and replacing the total below with the length
  // of an intermediate already-truncated string.
  t.true(result.text.length <= TOOL_OUTPUT_LIMIT);
  const marker = /\.\.\. \(truncated, (\d+) chars total\)$/.exec(result.text);
  t.truthy(marker);
  // The reported total sizes the original transport output.
  t.true(
    Number(/** @type {RegExpExecArray} */ (marker)[1]) > TOOL_OUTPUT_LIMIT,
  );
});

const LEASE_URL = 'https://github.com/example/repo.git';
const LEASE_OID = '0123456789abcdef0123456789abcdef01234567';

const provisionCommittedRepo = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-worktree-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main', root]);
  await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'root',
  ]);
  return fs.promises.realpath(root);
};

test('worktreeList parses locked, detached, prunable, and bare records', async t => {
  const root = await provisionCommittedRepo(t);
  const parent = path.dirname(root);
  const detached = path.join(parent, 'native-git-worktree-detached');
  const locked = path.join(parent, 'native-git-worktree-locked');
  const prunable = path.join(parent, 'native-git-worktree-prunable');
  t.teardown(() =>
    Promise.all(
      [detached, locked, prunable].map(worktree =>
        fs.promises.rm(worktree, { recursive: true, force: true }),
      ),
    ),
  );
  await execFileAsync('git', [
    '-C',
    root,
    'worktree',
    'add',
    '-q',
    '--detach',
    detached,
    'HEAD',
  ]);
  await execFileAsync('git', [
    '-C',
    root,
    'worktree',
    'add',
    '-q',
    '-b',
    'locked-branch',
    locked,
    'HEAD',
  ]);
  await execFileAsync('git', [
    '-C',
    root,
    'worktree',
    'lock',
    '--reason',
    'test lock',
    locked,
  ]);
  await execFileAsync('git', [
    '-C',
    root,
    'worktree',
    'add',
    '-q',
    '-b',
    'prunable-branch',
    prunable,
    'HEAD',
  ]);
  await fs.promises.rm(prunable, { recursive: true, force: true });

  const backend = makeNativeGitBackend({ repoRoot: root });
  const records = await backend.worktreeList();
  t.deepEqual(
    records.map(({ path: recordPath }) => recordPath),
    ['.'],
  );
  t.like(records[0], {
    branch: 'refs/heads/main',
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
  });
  const parsed = internalHelpers.parseWorktreeList(
    [
      `worktree ${root}`,
      `HEAD ${'0'.repeat(40)}`,
      'branch refs/heads/main',
      '',
      'worktree /outside/detached',
      `HEAD ${'1'.repeat(40)}`,
      'detached',
      '',
      'worktree /outside/locked',
      `HEAD ${'2'.repeat(40)}`,
      'branch refs/heads/locked-branch',
      'locked test lock',
      '',
      'worktree /outside/prunable',
      `HEAD ${'3'.repeat(40)}`,
      'branch refs/heads/prunable-branch',
      'prunable missing',
      '',
      'worktree /outside/bare',
      'bare',
      '',
    ].join('\0'),
  );
  t.like(parsed[1], { detached: true, locked: false, prunable: false });
  t.like(parsed[2], { locked: true, prunable: false });
  t.like(parsed[3], { locked: false, prunable: true });
  t.like(parsed[4], { bare: true, detached: false });

  const bare = await fs.promises.realpath(
    await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'native-git-worktree-bare-'),
    ),
  );
  t.teardown(() => fs.promises.rm(bare, { recursive: true, force: true }));
  await execFileAsync('git', ['clone', '-q', '--bare', root, bare]);
  const bareCheckout = path.join(parent, 'native-git-worktree-bare-checkout');
  t.teardown(() =>
    fs.promises.rm(bareCheckout, { recursive: true, force: true }),
  );
  await execFileAsync('git', [
    '--git-dir',
    bare,
    'worktree',
    'add',
    '-q',
    '--detach',
    bareCheckout,
    'main',
  ]);
  const bareBackend = makeNativeGitBackend({ repoRoot: bare });
  const bareRecords = await bareBackend.worktreeList();
  t.deepEqual(
    bareRecords.map(({ path: recordPath }) => recordPath),
    ['.'],
  );
  t.like(bareRecords[0], {
    bare: true,
    detached: false,
    locked: false,
    prunable: false,
  });
});

test('worktreeAdd creates a derived checkout and rejects escaped destinations', async t => {
  const root = await provisionCommittedRepo(t);
  const backend = makeNativeGitBackend({ repoRoot: root });
  await fs.promises.mkdir(path.join(root, 'checkouts'));
  const derived = await backend.worktreeAdd(['checkouts', 'feature'], {
    ref: 'HEAD',
    newBranch: 'feature',
  });
  t.deepEqual(await derived.currentBranch(), {
    name: 'feature',
    kind: 'branch',
  });
  t.deepEqual(await derived.status(), []);
  const listed = await backend.worktreeList();
  t.true(listed.some(({ path: recordPath }) => recordPath === '.'));
  t.true(
    listed.some(({ path: recordPath }) => recordPath === 'checkouts/feature'),
  );
  t.false(listed.some(({ path: recordPath }) => path.isAbsolute(recordPath)));

  const outside = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-worktree-outside-'),
  );
  t.teardown(() => fs.promises.rm(outside, { recursive: true, force: true }));
  await fs.promises.symlink(outside, path.join(root, 'escape'));
  await t.throwsAsync(
    backend.worktreeAdd(['escape', 'feature'], { ref: 'HEAD' }),
    { message: /outside the repository mount/ },
  );
  await t.throwsAsync(backend.worktreeAdd(['..', 'outside'], { ref: 'HEAD' }), {
    message: /single non-admin mount-relative segment/,
  });
  await t.throwsAsync(backend.worktreeAdd([], { ref: 'HEAD' }), {
    message: /must not be empty/,
  });
  for (const segment of ['.git', '.GIT', 'git~1']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(backend.worktreeAdd([segment], { ref: 'HEAD' }), {
      message: /single non-admin mount-relative segment/,
    });
  }
});

test('worktreeAdd refuses a linked checkout whose administrative directory is outside its mount', async t => {
  const root = await provisionCommittedRepo(t);
  const linked = path.join(path.dirname(root), 'native-git-worktree-linked');
  t.teardown(() => fs.promises.rm(linked, { recursive: true, force: true }));
  await execFileAsync('git', [
    '-C',
    root,
    'worktree',
    'add',
    '-q',
    '--detach',
    linked,
    'HEAD',
  ]);
  const backend = makeNativeGitBackend({ repoRoot: linked });
  await backend.assertRepositoryRoot();
  await t.throwsAsync(backend.worktreeAdd(['new-checkout'], { ref: 'HEAD' }), {
    message: /outside the repository mount/,
  });
});

test('remotePush rejects a malformed force-with-lease before transport', async t => {
  const backend = await provisionRepoRoot(t);
  const push = forceWithLease =>
    backend.remotePush({
      url: LEASE_URL,
      refspecs: ['refs/heads/topic:refs/heads/topic'],
      forceWithLease,
    });

  // The exo never emits a malformed record, but `@endo/git` is importable
  // without the policy layer above it, so these branches are the boundary a
  // direct caller meets. Each is unreachable from the exo and therefore has no
  // other test standing behind it.
  await Promise.all(
    ['a string', 42, true, [], [LEASE_OID]].map(notARecord =>
      t.throwsAsync(push(notARecord), {
        message: /forceWithLease must be a record/,
      }),
    ),
  );
  await t.throwsAsync(push(null), {
    message: /forceWithLease must be a record/,
  });

  await t.throwsAsync(push({ expectedOid: LEASE_OID }), {
    message: /forceWithLease\.ref/,
  });
  await t.throwsAsync(
    push({ ref: '--upload-pack=evil', expectedOid: LEASE_OID }),
    { message: /forceWithLease\.ref/ },
  );
  await t.throwsAsync(push({ ref: 'refs/heads/topic' }), {
    message: /forceWithLease\.expectedOid/,
  });

  // The OID length boundary, either side, plus a non-hex digit.
  await Promise.all(
    [
      LEASE_OID.slice(0, 39),
      `${LEASE_OID}0`,
      LEASE_OID.replace(/.$/u, 'g'),
    ].map(badOid =>
      t.throwsAsync(push({ ref: 'refs/heads/topic', expectedOid: badOid }), {
        message: /40-character hexadecimal object ID/,
      }),
    ),
  );

  // Git reads a null-OID lease as "expect this ref NOT to exist" — create-only,
  // the inverse of the option's meaning. The schema, the exo, and this backend
  // must accept exactly the same domain, so this layer rejects it too.
  await t.throwsAsync(
    push({ ref: 'refs/heads/topic', expectedOid: '0'.repeat(40) }),
    { message: /must not be the null object ID/ },
  );

  // `--force-with-lease=<ref>:<oid>` is split at the LAST colon, so a ref
  // carrying its own colon does not round-trip and the lease binds to a ref
  // nobody named. `requireRevision` permits a colon, and the policy layer that
  // rejects one is not in a direct caller's path.
  await t.throwsAsync(push({ ref: 'refs/heads/a:b', expectedOid: LEASE_OID }), {
    message: /must not contain a colon/,
  });
});

test('remotePush refuses a force refspec alongside a force-with-lease', async t => {
  const backend = await provisionRepoRoot(t);

  // A `+` refspec carries its own force, and git lets that force turn a
  // stale-lease rejection into a forced update — so the pair does not error,
  // it silently VOIDS the lease. That is the one lease precondition whose
  // breach is an authority escalation rather than a diagnostic, which is why
  // it is re-asserted here rather than only at the policy layer.
  await t.throwsAsync(
    backend.remotePush({
      url: LEASE_URL,
      refspecs: ['+refs/heads/alt:refs/heads/topic'],
      forceWithLease: { ref: 'refs/heads/topic', expectedOid: LEASE_OID },
    }),
    { message: /must not accompany a force refspec/ },
  );

  // The same refspec without a lease is untouched by the new guard.
  await t.notThrowsAsync(
    backend
      .remotePush({
        url: LEASE_URL,
        refspecs: ['+refs/heads/alt:refs/heads/topic'],
      })
      .then(
        () => undefined,
        error => {
          // Transport is expected to fail (there is no such remote); the guard
          // must not be what rejected it.
          t.notRegex(String(error.message), /force refspec/u);
        },
      ),
  );
});

test('NativeGitBackend.diff reports structured files under hostile diff config', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  /** @param {string[]} commandArguments */
  const git = commandArguments =>
    execFileAsync('git', commandArguments, { cwd: repoRoot });
  const commit = message =>
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-qm',
      message,
    ]);
  // Repository-local settings that would reshape the porcelain rendering if
  // the structured invocations did not pin their output format.
  await fs.promises.appendFile(
    path.join(repoRoot, '.git', 'config'),
    [
      '[diff]',
      '\tnoprefix = true',
      '\trenames = false',
      '\tsubmodule = log',
      '\tsuppressBlankEmpty = true',
      '[color]',
      '\tdiff = always',
      '',
    ].join('\n'),
  );
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  await fs.promises.writeFile(
    path.join(repoRoot, 'moved.txt'),
    `${lines.join('\n')}\n`,
  );
  await fs.promises.writeFile(path.join(repoRoot, 'blank.txt'), 'a\n\nb\n');
  await fs.promises.writeFile(path.join(repoRoot, 'data.bin'), '\0\x01');
  await fs.promises.writeFile(path.join(repoRoot, 'link'), 'was a file\n');
  await git(['add', '.']);
  await commit('baseline');

  await git(['mv', 'moved.txt', 'renamed.txt']);
  await fs.promises.chmod(path.join(repoRoot, 'renamed.txt'), 0o755);
  await fs.promises.writeFile(path.join(repoRoot, 'blank.txt'), 'a\n\nc\n');
  await fs.promises.writeFile(path.join(repoRoot, 'data.bin'), '\0\x02\x03');
  await fs.promises.rm(path.join(repoRoot, 'link'));
  await fs.promises.symlink('renamed.txt', path.join(repoRoot, 'link'));
  await git(['add', '-A']);
  // A gitlink without a checked-out submodule repository.
  await git([
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${'1'.repeat(40)},sub`,
  ]);

  const diff = await backend.diff({ cached: true });
  t.deepEqual(
    diff.files.map(({ status, oldPath, newPath, oldMode, newMode }) => ({
      status,
      oldPath,
      newPath,
      oldMode,
      newMode,
    })),
    [
      {
        status: 'modified',
        oldPath: 'blank.txt',
        newPath: 'blank.txt',
        oldMode: 0o10_0644,
        newMode: 0o10_0644,
      },
      {
        status: 'modified',
        oldPath: 'data.bin',
        newPath: 'data.bin',
        oldMode: 0o10_0644,
        newMode: 0o10_0644,
      },
      {
        status: 'modified',
        oldPath: 'link',
        newPath: 'link',
        oldMode: 0o10_0644,
        newMode: 0o12_0000,
      },
      {
        status: 'renamed',
        oldPath: 'moved.txt',
        newPath: 'renamed.txt',
        oldMode: 0o10_0644,
        newMode: 0o10_0755,
      },
      {
        status: 'added',
        oldPath: undefined,
        newPath: 'sub',
        oldMode: undefined,
        newMode: 0o16_0000,
      },
    ],
  );
  const [blank, data, link, renamed, submodule] = diff.files;
  t.deepEqual(blank.hunks[0].lines, [
    { kind: 'context', text: 'a' },
    { kind: 'context', text: '' },
    { kind: 'remove', text: 'b' },
    { kind: 'add', text: 'c' },
  ]);
  t.deepEqual(data.binary, {});
  t.deepEqual(data.hunks, []);
  t.deepEqual(
    link.hunks.map(hunk => hunk.lines),
    [
      [{ kind: 'remove', text: 'was a file' }],
      [{ kind: 'add', text: 'renamed.txt' }],
    ],
  );
  t.deepEqual(renamed.hunks, []);
  t.deepEqual(submodule.hunks[0].lines, [
    { kind: 'add', text: `Subproject commit ${'1'.repeat(40)}` },
  ]);
});

test('NativeGitBackend.diff reports an unmerged path without hunks', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  /** @param {string[]} commandArguments */
  const git = commandArguments =>
    execFileAsync('git', commandArguments, { cwd: repoRoot });
  const commit = message =>
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-qam',
      message,
    ]);
  await fs.promises.writeFile(path.join(repoRoot, 'f.txt'), 'base\n');
  await fs.promises.writeFile(path.join(repoRoot, 'g.txt'), 'g\n');
  await git(['add', '.']);
  await commit('base');
  await git(['switch', '-qc', 'side']);
  await fs.promises.writeFile(path.join(repoRoot, 'f.txt'), 'side\n');
  await commit('side');
  await git(['switch', '-q', 'main']);
  await fs.promises.writeFile(path.join(repoRoot, 'f.txt'), 'main\n');
  await commit('main');
  await t.throwsAsync(
    git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'merge', 'side']),
  );
  await fs.promises.writeFile(path.join(repoRoot, 'g.txt'), 'g2\n');

  const diff = await backend.diff();
  t.deepEqual(diff.files, [
    { status: 'unmerged', oldPath: 'f.txt', newPath: 'f.txt', hunks: [] },
    {
      status: 'modified',
      oldPath: 'g.txt',
      newPath: 'g.txt',
      oldMode: 0o10_0644,
      newMode: 0o10_0644,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: 'remove', text: 'g' },
            { kind: 'add', text: 'g2' },
          ],
        },
      ],
    },
  ]);
  t.regex(await backend.diffText(), /diff --cc f\.txt/);
});

test('NativeGitBackend.merge reports delete conflicts and marker style', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  const conflictPath = 'delete\tconflict.txt';
  /** @param {string[]} commandArguments */
  const git = commandArguments =>
    execFileAsync('git', commandArguments, { cwd: repoRoot });
  const commit = message =>
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-qam',
      message,
    ]);
  await fs.promises.writeFile(path.join(repoRoot, conflictPath), 'base\n');
  await git(['add', conflictPath]);
  await commit('base');
  await git(['switch', '-qc', 'side']);
  await fs.promises.rm(path.join(repoRoot, conflictPath));
  await commit('delete on side');
  await git(['switch', '-q', 'main']);
  await fs.promises.writeFile(path.join(repoRoot, conflictPath), 'main\n');
  await commit('modify on main');
  await git(['config', 'merge.conflictStyle', 'zdiff3']);

  const result = await backend.merge('side');
  t.is(result.status, 'conflicts');
  if (result.status !== 'conflicts') {
    throw t.fail('expected a structured delete/modify conflict');
  }
  t.deepEqual(result.conflicts, [
    {
      path: conflictPath,
      base: { oid: result.conflicts[0].base?.oid },
      ours: { oid: result.conflicts[0].ours?.oid },
      markerStyle: 'zdiff3',
    },
  ]);
  t.truthy(result.conflicts[0].base?.oid);
  t.truthy(result.conflicts[0].ours?.oid);
  t.false('theirs' in result.conflicts[0]);
});

test('NativeGitBackend.diff narrows by revision range and path', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  /** @param {string[]} commandArguments */
  const git = commandArguments =>
    execFileAsync('git', commandArguments, { cwd: repoRoot });
  const commit = message =>
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-qam',
      message,
    ]);
  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a\n');
  await fs.promises.writeFile(path.join(repoRoot, 'b.txt'), 'b\n');
  await git(['add', '.']);
  await commit('first');
  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a2\n');
  await fs.promises.writeFile(path.join(repoRoot, 'b.txt'), 'b2\n');
  await commit('second');

  const options = { base: 'HEAD~1', head: 'HEAD', paths: ['a.txt'] };
  const diff = await backend.diff(options);
  t.deepEqual(
    diff.files.map(({ status, newPath }) => ({ status, newPath })),
    [{ status: 'modified', newPath: 'a.txt' }],
  );
  t.deepEqual(diff.files[0].hunks[0].lines, [
    { kind: 'remove', text: 'a' },
    { kind: 'add', text: 'a2' },
  ]);
  const text = await backend.diffText(options);
  t.regex(text, /diff --git a\/a\.txt b\/a\.txt/);
  t.notRegex(text, /b\.txt/);
  await t.throwsAsync(() => backend.diff({ paths: [''] }));
  await t.throwsAsync(() => backend.diff({ base: '-x' }));
});

test('NativeGitBackend.show reports a commit, its parents, and its first-parent diff', async t => {
  const { backend, repoRoot } = await provisionRepo(t);
  /** @param {string[]} commandArguments */
  const git = commandArguments =>
    execFileAsync('git', commandArguments, { cwd: repoRoot });
  const identity = ['-c', 'user.email=t@t', '-c', 'user.name=T'];
  /** @param {string} message */
  const commit = message => git([...identity, 'commit', '-qam', message]);
  /** @param {string} ref */
  const oidOf = async ref => (await git(['rev-parse', ref])).stdout.trim();
  // Repository-local settings that would reshape the porcelain rendering if
  // the structured invocations did not pin their output format.
  await fs.promises.appendFile(
    path.join(repoRoot, '.git', 'config'),
    ['[diff]', '\tnoprefix = true', '[color]', '\tdiff = always', ''].join(
      '\n',
    ),
  );

  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a\n');
  await git(['add', '.']);
  await commit('root');
  const root = await backend.show('HEAD');
  t.like(root.commit, {
    oid: await oidOf('HEAD'),
    summary: 'root',
    author: 'T',
  });
  t.is(typeof root.commit.committedAt, 'number');
  t.deepEqual(root.parents, [], 'a root commit has no parents');
  t.deepEqual(root.diff.files, [
    {
      status: 'added',
      newPath: 'a.txt',
      newMode: 0o10_0644,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [{ kind: 'add', text: 'a' }],
        },
      ],
    },
  ]);

  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a2\n');
  await commit('second');
  const second = await backend.show('HEAD');
  t.is(second.commit.summary, 'second');
  t.deepEqual(second.parents, [root.commit.oid]);
  t.deepEqual(
    second.diff.files.map(({ status, newPath, hunks }) => ({
      status,
      newPath,
      lines: hunks.flatMap(hunk => hunk.lines),
    })),
    [
      {
        status: 'modified',
        newPath: 'a.txt',
        lines: [
          { kind: 'remove', text: 'a' },
          { kind: 'add', text: 'a2' },
        ],
      },
    ],
  );

  // A merge reports both parents and its diff against the first parent:
  // only what the merged side brought in.  `--no-track` keeps an ambient
  // `branch.autoSetupMerge` from writing branch config, which would change
  // the repository identity the backend pinned.
  await git(['switch', '-q', '--no-track', '-c', 'side']);
  await fs.promises.writeFile(path.join(repoRoot, 'side.txt'), 'side\n');
  await git(['add', '.']);
  await commit('side');
  await git(['switch', '-q', 'main']);
  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a3\n');
  await commit('main');
  const mainOid = await oidOf('HEAD');
  const sideOid = await oidOf('side');
  await git([...identity, 'merge', '-q', '--no-edit', 'side']);
  const merge = await backend.show('HEAD');
  t.deepEqual(merge.parents, [mainOid, sideOid]);
  t.deepEqual(
    merge.diff.files.map(({ status, newPath }) => ({ status, newPath })),
    [{ status: 'added', newPath: 'side.txt' }],
  );

  // An annotated tag shows the commit it points at.
  await git([...identity, 'tag', '-am', 'release', 'v1', second.commit.oid]);
  t.deepEqual(await backend.show('v1'), second);

  // A blob is not a commit; showText still renders it.
  await t.throwsAsync(() => backend.show('HEAD:a.txt'));
  t.is(await backend.showText('HEAD:a.txt'), 'a3');
  t.regex(await backend.showText('HEAD~1'), /commit [0-9a-f]{40}/);
  await t.throwsAsync(() => backend.show('-x'), {
    message: /must not start with "-"/,
  });
  await t.throwsAsync(() => backend.showText('-x'), {
    message: /must not start with "-"/,
  });
});

test('NativeGitBackend.show reports a root commit in a SHA-256 repository', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-show-sha256-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await execFileAsync(
    'git',
    ['init', '-q', '-b', 'main', '--object-format=sha256'],
    { cwd: repoRoot },
  );
  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a\n');
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'root'],
    { cwd: repoRoot },
  );
  const backend = makeNativeGitBackend({ repoRoot });
  const shown = await backend.show('HEAD');
  t.regex(shown.commit.oid, /^[0-9a-f]{64}$/);
  t.deepEqual(shown.parents, []);
  t.deepEqual(
    shown.diff.files.map(({ status, newPath }) => ({ status, newPath })),
    [{ status: 'added', newPath: 'a.txt' }],
  );
});
