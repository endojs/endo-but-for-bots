// @ts-check
// Hostile repositories and arguments for the workspace's host-side git
// (`resources/environments/impl/git.js`; contract
// `designs/m6-interfaces.md` D-M6-7, D-M6-14, section 11): what the
// container can write into the shared `.git` never makes the host run a
// program or reach outside the worktree, names and paths are refused
// before git sees them, and huge repositories answer within the bound.
// [real-git]
import test from '@endo/ses-ava/test.js';
import { chmod, mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeWorkspaceFixture } from './_environments-git.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentShapes,
  environmentTexts,
} from '../../guest/lib/guards/environments.js';
import { fitsFrame } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

const { mustMatch } = /** @type {any} */ (globalThis);
const T = environmentTexts;

/**
 * A script that, if the host ever ran it, would leave a file behind.
 * @param {any} fixture
 * @param {string} name
 */
const sideEffectScript = async (fixture, name) => {
  const side = join(fixture.root, `side-${name}`);
  const script = join(fixture.root, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\ntouch '${side}'\ncat\n`);
  await chmod(script, 0o755);
  return { side, script };
};

test('a filter driver in .git/config: reads and writes refused, the filter never runs', async t => {
  const fixture = await makeWorkspaceFixture(t);
  const { side, script } = await sideEffectScript(fixture, 'filter');
  await fixture.write('a.txt', 'one\n');
  await fixture.run('add', [['a.txt']]);
  await fixture.run('commit', ['One']);
  await fixture.write('.gitattributes', '* filter=x\n');
  await fixture.container(['config', 'filter.x.clean', script]);
  await fixture.container(['config', 'filter.x.smudge', script]);
  await fixture.write('a.txt', 'two\n');
  for (const [op, args] of /** @type {[string, any[]][]} */ ([
    ['status', []],
    ['diff', []],
    ['log', []],
    ['add', [['a.txt']]],
    ['commit', ['Two']],
    ['stashPush', []],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run(op, args), {
      message: T.gitConfigRefused,
    });
  }
  t.false(existsSync(side));
  // Removing the driver makes the workspace usable again.
  await fixture.container(['config', '--remove-section', 'filter.x']);
  await fixture.run('add', [['a.txt']]);
  t.false(existsSync(side));
});

test('an include and a merge driver are refused like a filter', async t => {
  const fixture = await makeWorkspaceFixture(t);
  const included = join(fixture.root, 'included.config');
  await writeFile(included, '[core]\n\tpager = touch nowhere\n');
  await fixture.container(['config', 'include.path', included]);
  await t.throwsAsync(fixture.run('status'), { message: T.gitConfigRefused });
  await fixture.container(['config', '--unset', 'include.path']);
  await fixture.container(['config', 'merge.evil.driver', 'touch nowhere']);
  await t.throwsAsync(fixture.run('branches'), { message: T.gitConfigRefused });
});

test('hooks and fsmonitor written by the container never run on the host', async t => {
  const fixture = await makeWorkspaceFixture(t);
  const hook = await sideEffectScript(fixture, 'hook');
  const monitor = await sideEffectScript(fixture, 'monitor');
  for (const name of [
    'pre-commit',
    'commit-msg',
    'post-commit',
    'post-checkout',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await fixture.write(
      `.git/hooks/${name}`,
      `#!/bin/sh\ntouch '${hook.side}'\n`,
    );
    // eslint-disable-next-line no-await-in-loop
    await chmod(join(fixture.workspace, '.git', 'hooks', name), 0o755);
  }
  await fixture.container(['config', 'core.fsmonitor', monitor.script]);
  await fixture.write('a.txt', 'one\n');
  await fixture.run('status');
  await fixture.run('add', [['a.txt']]);
  await fixture.run('commit', ['One']);
  await fixture.run('createBranch', ['b', { switchAfterCreate: true }]);
  await fixture.run('switchBranch', ['main']);
  t.false(existsSync(hook.side));
  t.false(existsSync(monitor.side));
});

test('a .git that points elsewhere, borrows objects, or moves the worktree is refused', async t => {
  const fixture = await makeWorkspaceFixture(t);
  const other = await makeWorkspaceFixture(t);
  const dotGit = join(fixture.workspace, '.git');
  // core.worktree: git would work on another directory.
  await fixture.container(['config', 'core.worktree', other.workspace]);
  await t.throwsAsync(fixture.run('status'), { message: T.gitConfigRefused });
  await fixture.container([
    '--git-dir',
    dotGit,
    'config',
    '--unset',
    'core.worktree',
  ]);
  t.is(await fixture.run('currentBranch'), 'main');
  // Alternates: objects read from another repository.
  await fixture.write(
    '.git/objects/info/alternates',
    `${join(other.workspace, '.git', 'objects')}\n`,
  );
  await t.throwsAsync(fixture.run('log'), { message: T.gitConfigRefused });
  // A gitdir file in place of the directory.
  const moved = join(fixture.root, 'moved-git');
  const { rename } = await import('node:fs/promises');
  await rename(dotGit, moved);
  await writeFile(dotGit, `gitdir: ${join(other.workspace, '.git')}\n`);
  await t.throwsAsync(fixture.run('status'), { message: T.gitConfigRefused });
  // A symlink in place of the directory.
  const { rm } = await import('node:fs/promises');
  await rm(dotGit);
  await symlink(join(other.workspace, '.git'), dotGit);
  const error = await t.throwsAsync(fixture.run('status'), {
    message: T.gitConfigRefused,
  });
  t.false(error.message.includes(fixture.root));
});

test('names: option-shaped, malformed and oversized refs are refused before git', async t => {
  const fixture = await makeWorkspaceFixture(t);
  for (const name of [
    '--upload-pack=x',
    '-b',
    'a..b',
    'a b',
    'a~1',
    'x.lock',
    '.hidden',
    'a/',
    'HEAD',
    'a@{1}',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run('createBranch', [name]), {
      message: T.gitRefRefused,
    });
  }
  // Over the guard's bound: the shape refuses it.
  await t.throwsAsync(fixture.run('createBranch', ['a'.repeat(300)]), {
    message: /must not be bigger than 255|stringLengthLimit|length/,
  });
  for (const revision of ['--output=x', 'a..b', 'HEAD:path', 'main@{u}']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run('diff', [{ from: revision }]), {
      message: T.gitRefRefused,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run('merge', [revision]), {
      message: T.gitRefRefused,
    });
  }
  // Accepted revisions.
  await fixture.run('createBranch', ['feature/one', { startPoint: 'HEAD' }]);
  const { head } = await fixture.run('switchBranch', ['feature/one']);
  t.deepEqual(
    (await fixture.run('diff', [{ from: 'HEAD~0', to: head }])).text,
    '',
  );
});

test('paths: outside, absolute, .git and symlinks are refused; a symlink is staged as a link', async t => {
  const fixture = await makeWorkspaceFixture(t);
  for (const path of [
    '../../etc',
    '/etc/passwd',
    '.git/config',
    '.GIT/config',
    'a/../../b',
    'a/./b',
    'a//b',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run('add', [[path]]), {
      message: T.gitPathRefused,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(fixture.run('status', [{ paths: [path] }]), {
      message: T.gitPathRefused,
    });
  }
  const outside = join(fixture.root, 'secret.txt');
  await writeFile(outside, 'outside\n');
  await symlink(outside, join(fixture.workspace, 'link'));
  await mkdir(join(fixture.root, 'outside-dir'));
  await writeFile(join(fixture.root, 'outside-dir', 'f.txt'), 'outside\n');
  await symlink(
    join(fixture.root, 'outside-dir'),
    join(fixture.workspace, 'dir'),
  );
  await fixture.run('add', [['link']]);
  const staged = (await fixture.run('diff', [{ staged: true }])).text;
  t.regex(staged, /new file mode 120000/);
  t.false(staged.includes('outside\n+'));
  t.deepEqual(await fixture.run('read', [{ path: ['link'] }]), {
    ok: false,
    error: T.gitPathRefused,
  });
  t.deepEqual(await fixture.run('read', [{ path: ['dir', 'f.txt'] }]), {
    ok: false,
    error: T.gitPathRefused,
  });
  await t.throwsAsync(fixture.run('add', [['dir/f.txt']]), {
    message: /beyond a symbolic link/,
  });
});

test('a huge untracked tree answers the entry limit within the answer bound', async t => {
  const fixture = await makeWorkspaceFixture(t);
  // 3,000 files of 120-character names: over the 1,000-entry page and,
  // with long names, over the 16,384-byte answer on its own.
  const names = Array.from(
    { length: 3000 },
    (_, n) => `${String(n).padStart(6, '0')}-${'n'.repeat(113)}`,
  );
  await Promise.all(
    names.map(name => writeFile(join(fixture.workspace, name), '')),
  );
  const status = await fixture.run('status');
  t.true(status.truncated);
  const entries = Number(status.entries.length);
  t.true(entries > 0);
  t.true(entries < environmentLimits.gitStatusEntries);
  t.true(fitsFrame(status, environmentLimits.answerBytes));
  mustMatch(status, environmentShapes.GitStatus, 'status');
  const small = await fixture.run('status', [{ limit: 10 }]);
  t.is(small.entries.length, 10);
  t.true(small.truncated);
});

test('a 1 MiB commit subject and a 1 GB file stay within their bounds', async t => {
  const fixture = await makeWorkspaceFixture(t);
  const subject = 'S'.repeat(1024 * 1024);
  await writeFile(join(fixture.root, 'message'), subject);
  await fixture.container([
    'commit',
    '-q',
    '--allow-empty',
    '-F',
    join(fixture.root, 'message'),
  ]);
  for (let n = 0; n < 3; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fixture.container([
      'commit',
      '-q',
      '--allow-empty',
      '-F',
      join(fixture.root, 'message'),
    ]);
  }
  const log = await fixture.run('log');
  t.is(log.commits.length, 5);
  t.true(
    Number(log.commits[0].subject.length) <= environmentLimits.gitSubjectUnits,
  );
  t.true(fitsFrame(log, environmentLimits.answerBytes));
  mustMatch(log, environmentShapes.GitLog, 'log');
  await fixture
    .run('stashPush', [subject.slice(0, 16_000)])
    .catch(() => undefined);
  // A sparse 1 GB file: read scans its first 1 MiB only.
  const big = await open(join(fixture.workspace, 'big.bin'), 'w');
  await big.truncate(1024 * 1024 * 1024);
  await big.close();
  const started = Date.now();
  const result = await fixture.run('read', [{ path: ['big.bin'] }]);
  t.true(result.ok);
  t.true(result.scanTruncated);
  t.true(Date.now() - started < 5000);
});
