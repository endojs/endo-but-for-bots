// @ts-check
// The environments adapter's state layout (resources/environments/impl/
// layout.js; m6-interfaces.md 5.1, 7 K5 and K7): the tag, the directories
// of a key, a workspace made once behind its marker (branch main, one empty
// commit), a creation without the marker wiped and made again, release
// through the trash, the trash and stale index locks swept at bind. Real
// git ([real-git]), no supervisor.
import '../unit/_m1a-prelude.js';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

import {
  READY_MARKER,
  environmentsDirIn,
  makeLayout,
} from '../../resources/environments/impl/layout.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** @param {import('ava').ExecutionContext} t */
const freshState = t => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const stateDir = mkdtempSync(join(harnessRoot, 'tmp', 'envl-'));
  t.teardown(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
};

/**
 * The permission bits of a path, as an octal string.
 * @param {string} path
 */
const modeOf = path => (statSync(path).mode % 0o1000).toString(8);

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('the tag is the realpath digest and is written once', t => {
  const stateDir = freshState(t);
  const layout = makeLayout({ stateDir });
  const tag = layout.tag();
  t.is(
    tag,
    createHash('sha256')
      .update(realpathSync(stateDir))
      .digest('hex')
      .slice(0, 16),
  );
  t.is(layout.tag(), tag);
  const root = environmentsDirIn(stateDir);
  t.is(readFileSync(join(root, 'tag'), 'utf8'), `${tag}\n`);
  t.is(modeOf(root), '700');
  // Another state directory is another tag (a cloned template's own
  // containers).
  t.not(makeLayout({ stateDir: freshState(t) }).tag(), tag);
});

test('only manager keys name directories', t => {
  const layout = makeLayout({ stateDir: freshState(t) });
  const dirs = layout.dirsOf('e12');
  t.true(dirs.workspace.endsWith(join('sessions', 'e12', 'workspace')));
  t.true(dirs.home.endsWith(join('sessions', 'e12', 'home')));
  t.true(dirs.run.endsWith(join('sessions', 'e12', 'run')));
  for (const bad of [
    '',
    'e',
    '../e1',
    'e1/..',
    'x1',
    'e1 ',
    'e12345678901234567',
    7,
  ])
    t.throws(() => layout.dirsOf(/** @type {any} */ (bad)), {
      message: 'environments: not an environment key',
    });
});

test('a workspace is made once: main, one empty commit, the marker', async t => {
  const layout = makeLayout({ stateDir: freshState(t) });
  const dirs = layout.dirsOf('e1');
  t.false(existsSync(dirs.workspace), 'nothing on disk before first use');
  // Two first uses at once make one repository.
  await Promise.all([
    layout.ensureWorkspace('e1'),
    layout.ensureWorkspace('e1'),
  ]);
  t.is(git(dirs.workspace, ['branch', '--show-current']), 'main');
  t.is(git(dirs.workspace, ['rev-list', '--count', 'HEAD']), '1');
  t.is(
    git(dirs.workspace, ['log', '-1', '--format=%s']),
    'Initialize workspace',
  );
  t.is(git(dirs.workspace, ['status', '--porcelain']), '');
  t.true(existsSync(join(dirs.workspace, '.git', READY_MARKER)));
  t.true(existsSync(dirs.home));
  t.true(existsSync(dirs.run));
  for (const dir of [dirs.workspace, dirs.home, dirs.run])
    t.is(modeOf(dir), '700', dir);

  // What the session makes survives a later use.
  writeFileSync(join(dirs.workspace, 'notes.txt'), 'kept\n');
  writeFileSync(join(dirs.home, '.profile'), 'kept\n');
  await layout.ensureWorkspace('e1');
  t.is(readFileSync(join(dirs.workspace, 'notes.txt'), 'utf8'), 'kept\n');
  t.is(readFileSync(join(dirs.home, '.profile'), 'utf8'), 'kept\n');
  t.is(git(dirs.workspace, ['rev-list', '--count', 'HEAD']), '1');
});

test('a creation a kill interrupted (no marker) is wiped and made again', async t => {
  const layout = makeLayout({ stateDir: freshState(t) });
  const dirs = layout.dirsOf('e3');
  mkdirSync(join(dirs.workspace, '.git'), { recursive: true });
  writeFileSync(join(dirs.workspace, 'half-made'), 'x');
  await layout.ensureWorkspace('e3');
  t.false(existsSync(join(dirs.workspace, 'half-made')));
  t.is(git(dirs.workspace, ['rev-list', '--count', 'HEAD']), '1');
});

test('release goes through the trash and is idempotent; the sweep empties the trash', async t => {
  const stateDir = freshState(t);
  const layout = makeLayout({ stateDir, incarnation: 'test' });
  await layout.ensureWorkspace('e1');
  await layout.ensureWorkspace('e2');
  await layout.release('e1');
  const root = environmentsDirIn(stateDir);
  t.deepEqual(readdirSync(join(root, 'sessions')), ['e2']);
  t.deepEqual(readdirSync(join(root, 'trash')), []);
  await layout.release('e1');
  await layout.release('e9');

  // K7: a kill between the rename and the delete leaves a trash entry,
  // which the next bind's sweep deletes.
  mkdirSync(join(root, 'trash', 'e2-old-1', 'workspace'), { recursive: true });
  t.is(await layout.sweepTrash(), 1);
  t.deepEqual(readdirSync(join(root, 'trash')), []);
  t.is(await makeLayout({ stateDir }).sweepTrash(), 0);
});

test('the environments on disk are listed by key', async t => {
  const layout = makeLayout({ stateDir: freshState(t) });
  t.deepEqual(await layout.keys(), []);
  await layout.ensureWorkspace('e1');
  await layout.ensureWorkspace('e2');
  // Only key names count: anything else in sessions/ names no environment.
  mkdirSync(join(layout.dirsOf('e1').workspace, '..', '..', 'notes'));
  t.deepEqual((await layout.keys()).sort(), ['e1', 'e2']);
});
