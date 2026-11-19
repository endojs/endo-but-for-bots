// @ts-check
// The workspace's host-side git (`resources/environments/impl/git.js`;
// contract `designs/m6-interfaces.md` D-M6-7, 3.4, 4.3; acceptance 5, 16):
// a ported subset of `@endo/exo-git`'s kit conformance (branches, status,
// diff, log paging, stage, commit, merge in both modes, stash) against a
// real repository and the installed git [real-git], every answer checked
// against its closed `environmentShapes` record and the answer bound.
import test from '@endo/ses-ava/test.js';

import { makeWorkspaceFixture } from './_environments-git.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentShapes,
  environmentTexts,
  gitAbsentMethodNames,
  gitOps,
  gitReaderMethodNames,
} from '../../guest/lib/guards/environments.js';
import { shapes as sessionShapes } from '../../guest/lib/guards/session.js';
import { fitsFrame } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import {
  gitWriteOps,
  initialCommitMessage,
} from '../../resources/environments/impl/git.js';

const { mustMatch } = /** @type {any} */ (globalThis);

const S = environmentShapes;
/** The answer shape of each operation (what the manager checks). */
const answerShapes = harden({
  status: () => S.GitStatus,
  diff: () => S.GitDiff,
  log: () => S.GitLog,
  branches: () => S.GitBranches,
  currentBranch: () => S.GitRef,
  trackingStatus: () => S.GitTracking,
  stashList: () => S.GitStashes,
  read: () => sessionShapes.SourceReadResult,
});

/**
 * Run an op and check its answer's shape and size.
 * @param {any} t
 * @param {any} fixture
 * @param {string} op
 * @param {any[]} [args]
 */
const checked = async (t, fixture, op, args = []) => {
  const answer = await fixture.run(op, args);
  const shape = gitWriteOps.includes(op)
    ? S.GitWriteResult
    : answerShapes[/** @type {keyof typeof answerShapes} */ (op)]();
  t.notThrows(() => mustMatch(answer, shape, op), op);
  t.true(fitsFrame(answer, environmentLimits.answerBytes), op);
  return answer;
};

test('the operation lists: writes are the ops the reader lacks; no rewrite or remote op exists', t => {
  const reads = gitOps.filter(op => !gitWriteOps.includes(op));
  t.deepEqual(
    reads,
    gitReaderMethodNames.filter(name => gitOps.includes(name)),
  );
  for (const name of gitAbsentMethodNames) t.false(gitOps.includes(name));
});

test('a new workspace: main, one empty commit, clean, no upstream', async t => {
  const fixture = await makeWorkspaceFixture(t);
  t.is(await checked(t, fixture, 'currentBranch'), 'main');
  const log = await checked(t, fixture, 'log');
  t.is(log.commits.length, 1);
  t.is(log.commits[0].subject, initialCommitMessage);
  t.false(log.truncated);
  t.is(log.next, undefined);
  t.deepEqual(await checked(t, fixture, 'status'), {
    branch: 'main',
    entries: [],
    truncated: false,
  });
  const { branches } = await checked(t, fixture, 'branches');
  t.deepEqual(
    branches.map(({ name, current }) => ({ name, current })),
    [{ name: 'main', current: true }],
  );
  t.deepEqual(await checked(t, fixture, 'trackingStatus'), {
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
  });
  t.deepEqual(await checked(t, fixture, 'stashList'), {
    stashes: [],
    truncated: false,
  });
});

test('stage and commit: porcelain letters, write results, the container sees the commit', async t => {
  const fixture = await makeWorkspaceFixture(t);
  await fixture.write('src/a.txt', 'one\n');
  await fixture.write('b.txt', 'two\n');
  let status = await checked(t, fixture, 'status');
  t.deepEqual(status.entries, [
    { path: 'b.txt', index: '?', worktree: '?' },
    { path: 'src/', index: '?', worktree: '?' },
  ]);
  status = await checked(t, fixture, 'status', [{ untracked: 'all' }]);
  t.deepEqual(
    status.entries.map(entry => entry.path),
    ['b.txt', 'src/a.txt'],
  );
  status = await checked(t, fixture, 'status', [
    { untracked: 'all', paths: ['src'] },
  ]);
  t.deepEqual(
    status.entries.map(entry => entry.path),
    ['src/a.txt'],
  );
  const added = await checked(t, fixture, 'add', [['src/a.txt', 'b.txt']]);
  t.is(added.branch, 'main');
  status = await checked(t, fixture, 'status');
  t.deepEqual(
    status.entries.map(({ index, worktree }) => index + worktree),
    ['A.', 'A.'],
  );
  const committed = await checked(t, fixture, 'commit', ['Add two files']);
  t.regex(committed.head, /^[0-9a-f]{40,64}$/);
  t.is((await fixture.container(['rev-parse', 'HEAD'])).trim(), committed.head);
  t.regex(await fixture.container(['log', '--format=%s']), /^Add two files\n/);
  // R3-246: one repository; a container commit is in log().
  await fixture.write('c.txt', 'three\n');
  await fixture.container(['add', 'c.txt']);
  await fixture.container(['commit', '-q', '-m', 'From the container']);
  const log = await checked(t, fixture, 'log');
  t.deepEqual(
    log.commits.map(commit => commit.subject),
    ['From the container', 'Add two files', initialCommitMessage],
  );
  t.is(log.commits[0].author, 'Container');
  // Unstage and restore.
  await fixture.write('c.txt', 'changed\n');
  await fixture.container(['add', 'c.txt']);
  await checked(t, fixture, 'restore', [['c.txt'], { staged: true }]);
  status = await checked(t, fixture, 'status');
  t.deepEqual(status.entries, [{ path: 'c.txt', index: '.', worktree: 'M' }]);
  await checked(t, fixture, 'restore', [['c.txt']]);
  status = await checked(t, fixture, 'status');
  t.deepEqual(status.entries, []);
});

test('diff: unstaged, staged, stat, between revisions, paths', async t => {
  const fixture = await makeWorkspaceFixture(t);
  await fixture.write('a.txt', 'one\n');
  await fixture.run('add', [['a.txt']]);
  const staged = await checked(t, fixture, 'diff', [{ staged: true }]);
  t.regex(staged.text, /\+one/);
  t.false(staged.truncated);
  t.is((await checked(t, fixture, 'diff')).text, '');
  await fixture.run('commit', ['One']);
  await fixture.write('a.txt', 'one\ntwo\n');
  t.regex((await checked(t, fixture, 'diff')).text, /\+two/);
  t.regex(
    (await checked(t, fixture, 'diff', [{ stat: true }])).text,
    /a\.txt \| 1 \+/,
  );
  t.is((await checked(t, fixture, 'diff', [{ paths: ['b.txt'] }])).text, '');
  const between = await checked(t, fixture, 'diff', [
    { from: 'HEAD~1', to: 'HEAD' },
  ]);
  t.regex(between.text, /new file mode/);
  // A large diff is cut to the text bound and says so.
  await fixture.write('big.txt', `${'x'.repeat(100)}\n`.repeat(2000));
  await fixture.run('add', [['big.txt']]);
  const big = await checked(t, fixture, 'diff', [{ staged: true }]);
  t.true(big.truncated);
  t.is(big.text.length, environmentLimits.gitTextUnits);
});

test('log pages of at most 50, continued by next; since and until', async t => {
  const fixture = await makeWorkspaceFixture(t);
  for (let n = 1; n <= 59; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fixture.container([
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      `Commit ${n}`,
    ]);
  }
  const first = await checked(t, fixture, 'log');
  t.is(first.commits.length, 50);
  t.is(first.commits[0].subject, 'Commit 59');
  t.is(typeof first.next, 'string');
  const second = await checked(t, fixture, 'log', [{ after: first.next }]);
  t.deepEqual(
    second.commits.map(commit => commit.subject),
    [
      ...Array.from({ length: 9 }, (_, i) => `Commit ${9 - i}`),
      initialCommitMessage,
    ],
  );
  t.is(second.next, undefined);
  const small = await checked(t, fixture, 'log', [{ limit: 3 }]);
  t.is(small.commits.length, 3);
  t.is(small.next, first.commits[3].oid);
  const time = first.commits[0].time;
  t.true(Number(time) > 1_600_000_000);
  t.is(
    (await checked(t, fixture, 'log', [{ until: time - 86_400 }])).commits
      .length,
    0,
  );
  t.is(
    (await checked(t, fixture, 'log', [{ since: time - 86_400, limit: 5 }]))
      .commits.length,
    5,
  );
});

test('branches: create, switch, rename, delete; merge fast-forward and merge commit; conflicts', async t => {
  const fixture = await makeWorkspaceFixture(t);
  let result = await checked(t, fixture, 'createBranch', [
    'feature',
    { switchAfterCreate: true },
  ]);
  t.is(result.branch, 'feature');
  await fixture.write('f.txt', 'feature\n');
  await fixture.run('add', [['f.txt']]);
  const featureHead = (await fixture.run('commit', ['Feature'])).head;
  await checked(t, fixture, 'switchBranch', ['main']);
  t.is(await fixture.run('currentBranch'), 'main');
  // ff-only moves main to the feature commit.
  result = await checked(t, fixture, 'merge', ['feature', { mode: 'ff-only' }]);
  t.is(result.head, featureHead);
  // A divergent history: ff-only refuses, merge-commit makes a merge.
  await fixture.run('createBranch', ['side', { switchAfterCreate: true }]);
  await fixture.write('s.txt', 'side\n');
  await fixture.run('add', [['s.txt']]);
  await fixture.run('commit', ['Side']);
  await fixture.run('switchBranch', ['main']);
  await fixture.write('m.txt', 'main\n');
  await fixture.run('add', [['m.txt']]);
  await fixture.run('commit', ['Main']);
  await t.throwsAsync(fixture.run('merge', ['side', { mode: 'ff-only' }]));
  result = await checked(t, fixture, 'merge', [
    'side',
    { mode: 'merge-commit', message: 'Merge side into main' },
  ]);
  t.is(
    (await fixture.run('log', [{ limit: 1 }])).commits[0].subject,
    'Merge side into main',
  );
  t.is(
    (await fixture.container(['rev-list', '--parents', '-n', '1', 'HEAD']))
      .trim()
      .split(' ').length,
    3,
  );
  // A merge commit without a message takes git's default.
  await fixture.run('createBranch', ['other', { startPoint: 'HEAD~1' }]);
  await fixture.run('switchBranch', ['other']);
  await fixture.write('o.txt', 'other\n');
  await fixture.run('add', [['o.txt']]);
  await fixture.run('commit', ['Other']);
  await fixture.run('switchBranch', ['main']);
  await checked(t, fixture, 'merge', ['other', { mode: 'merge-commit' }]);
  t.regex(
    (await fixture.run('log', [{ limit: 1 }])).commits[0].subject,
    /^Merge branch 'other'/,
  );
  // Rename and delete.
  result = await checked(t, fixture, 'renameBranch', ['other', 'renamed']);
  const names = (await fixture.run('branches')).branches.map(
    (/** @type {any} */ branch) => branch.name,
  );
  t.true(names.includes('renamed'));
  t.false(names.includes('other'));
  await checked(t, fixture, 'deleteBranch', ['renamed']);
  await checked(t, fixture, 'deleteBranch', ['side', { force: true }]);
  // A conflicting merge answers its conflicts instead of rejecting.
  await fixture.run('createBranch', ['clash', { switchAfterCreate: true }]);
  await fixture.write('m.txt', 'clash\n');
  await fixture.run('add', [['m.txt']]);
  await fixture.run('commit', ['Clash']);
  await fixture.run('switchBranch', ['main']);
  await fixture.write('m.txt', 'main again\n');
  await fixture.run('add', [['m.txt']]);
  await fixture.run('commit', ['Main again']);
  result = await checked(t, fixture, 'merge', [
    'clash',
    { mode: 'merge-commit', message: 'Merge clash' },
  ]);
  t.deepEqual(result.conflicts, ['m.txt']);
  const status = await fixture.run('status');
  t.deepEqual(status.entries, [{ path: 'm.txt', index: 'U', worktree: 'U' }]);
});

test('stash: push with a message, list, pop', async t => {
  const fixture = await makeWorkspaceFixture(t);
  await fixture.write('a.txt', 'one\n');
  await fixture.run('add', [['a.txt']]);
  await fixture.run('commit', ['One']);
  await fixture.write('a.txt', 'two\n');
  await checked(t, fixture, 'stashPush', ['Work in progress']);
  t.deepEqual((await fixture.run('status')).entries, []);
  const { stashes } = await checked(t, fixture, 'stashList');
  t.is(stashes.length, 1);
  t.is(stashes[0].index, 0);
  t.regex(stashes[0].message, /Work in progress$/);
  await checked(t, fixture, 'stashPop');
  t.deepEqual((await fixture.run('status')).entries, [
    { path: 'a.txt', index: '.', worktree: 'M' },
  ]);
  t.deepEqual((await fixture.run('stashList')).stashes, []);
});

test('read: SourceReader over the worktree (lines, search, bounds); missing rejects', async t => {
  const fixture = await makeWorkspaceFixture(t);
  await fixture.write(
    'src/agent.js',
    ['const a = 1;', 'checkpoint();', 'return a;', 'checkpoint(2);'].join('\n'),
  );
  let result = await checked(t, fixture, 'read', [
    { path: ['src', 'agent.js'], startLine: 2, lineCount: 2 },
  ]);
  t.deepEqual(result, {
    ok: true,
    lines: [
      { line: 2, text: 'checkpoint();' },
      { line: 3, text: 'return a;' },
    ],
    scanTruncated: false,
    outputTruncated: true,
  });
  result = await checked(t, fixture, 'read', [
    { path: ['src', 'agent.js'], search: 'checkpoint' },
  ]);
  t.deepEqual(
    result.lines.map((/** @type {any} */ line) => line.line),
    [2, 4],
  );
  t.false(result.outputTruncated);
  // Multi-byte lines are cut to the answer bound, not the frame ceiling.
  await fixture.write('wide.txt', `${'\u{1F600}'.repeat(3000)}\n`.repeat(3));
  result = await checked(t, fixture, 'read', [{ path: ['wide.txt'] }]);
  t.true(result.outputTruncated);
  await t.throwsAsync(fixture.run('read', [{ path: ['nope.txt'] }]), {
    message: /No such file/,
  });
  t.deepEqual(await fixture.run('read', [{ path: ['.git', 'config'] }]), {
    ok: false,
    error: environmentTexts.gitPathRefused,
  });
  t.deepEqual(await fixture.run('read', [{ path: ['src'] }]), {
    ok: false,
    error: environmentTexts.gitPathRefused,
  });
});

test('a reader cannot write; arguments are checked against the shapes', async t => {
  const fixture = await makeWorkspaceFixture(t);
  for (const op of gitWriteOps) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run(op, [], { readOnly: true }), {
      message: environmentTexts.gitReadOnly,
    });
  }
  t.is(await fixture.run('currentBranch', [], { readOnly: true }), 'main');
  await t.throwsAsync(fixture.run('status', [{ untracked: 'some' }]));
  await t.throwsAsync(fixture.run('log', [{ surprise: 1 }]));
  await t.throwsAsync(fixture.run('push', []), { message: /unknown git op/ });
});

test('one operation at a time per workspace; failures carry no host path', async t => {
  let active = 0;
  let most = 0;
  const ensureWorkspace = async () => {
    active += 1;
    most = Math.max(most, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  };
  const fixture = await makeWorkspaceFixture(t, { ensureWorkspace });
  await Promise.all([
    fixture.run('status'),
    fixture.run('log'),
    fixture.run('branches'),
    fixture.run('switchBranch', ['missing']).catch(() => undefined),
  ]);
  t.is(most, 1);
  const error = await t.throwsAsync(fixture.run('switchBranch', ['missing']));
  t.false(error.message.includes(fixture.root));
  t.true(error.message.length <= 4096);
  await t.throwsAsync(fixture.run('add', [['missing.txt']]), {
    message: /pathspec/,
  });
});

test('a stale index.lock is removed at the sweep; a write then works', async t => {
  const fixture = await makeWorkspaceFixture(t);
  await fixture.write('.git/index.lock', '');
  await fixture.write('a.txt', 'one\n');
  await t.throwsAsync(fixture.run('add', [['a.txt']]), {
    message: /index\.lock/,
  });
  t.true(await fixture.git.removeStaleLock(fixture.key));
  t.false(await fixture.git.removeStaleLock(fixture.key));
  await fixture.run('add', [['a.txt']]);
  t.is((await fixture.run('status')).entries[0].index, 'A');
});

test('the container rewriting .git/config re-derives the backend', async t => {
  let made = 0;
  const { makeNativeGitBackend } =
    await import('@endo/git/src/native-git-backend.js');
  const fixture = await makeWorkspaceFixture(t, {
    makeBackend: (/** @type {any} */ options) => {
      made += 1;
      return makeNativeGitBackend(options);
    },
  });
  await fixture.write('a.txt', 'one\n');
  await fixture.run('add', [['a.txt']]);
  t.is(made, 1);
  await fixture.container(['config', 'user.name', 'Someone']);
  await fixture.run('commit', ['One']);
  t.is(made, 2);
  await fixture.run('status');
  t.is(made, 2);
  fixture.git.forget(fixture.key);
  await fixture.run('status');
  t.is(made, 3);
});
