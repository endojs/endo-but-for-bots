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
  symlinkSync,
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

import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import {
  defaultRuntimes,
  makeBindingParts,
} from '../../resources/environments/impl/index.js';
import { makeOps } from '../../resources/environments/impl/ops.js';

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

/** @param {string} stateDir */
const makeSeed = stateDir => {
  const source = join(stateDir, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet', '--initial-branch=seed']);
  writeFileSync(join(source, 'source.txt'), 'tracked\n');
  git(source, ['add', 'source.txt']);
  git(source, [
    '-c',
    'user.name=Seed',
    '-c',
    'user.email=seed@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'Seed fixture',
  ]);
  /** @type {import('../../resources/environments/impl/layout.js').WorkspaceSeed} */
  const seed = harden({
    project: 'thixotrope',
    commit: git(source, ['rev-parse', 'HEAD']),
  });
  const dir = join(environmentsDirIn(stateDir), 'projects', seed.project);
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, `${seed.commit}.bundle`);
  git(source, ['bundle', 'create', bundle, 'refs/heads/seed']);
  return { seed, bundle };
};

test('Git-first and shell-first sessions get independent writable project checkouts', async t => {
  const stateDir = freshState(t);
  const { seed, bundle } = makeSeed(stateDir);
  const layout = makeLayout({ stateDir });
  const settings = harden({ runtime: 'fake', allowedCommands: ['sh'] });
  const parts = makeBindingParts({
    settings,
    layout,
    runtime: defaultRuntimes.fake(),
    tag: layout.tag(),
    timers: makeTimers(),
    trace: () => {},
  });
  const ops = makeOps({
    ...parts,
    layout,
    settings,
    withdrawn: new Set(),
    check: () => ({ ok: true }),
  });
  t.teardown(() => parts.runner.stop('e2'));
  await ops.git('e1', harden({ op: 'status', args: [] }), seed);
  await ops.port('e2', seed);
  t.false(existsSync(layout.dirsOf('e2').workspace));
  await ops.runCommand(
    'e2',
    'sh',
    harden(['-c', 'cat source.txt > shell-copy']),
    harden({}),
    seed,
  );
  const first = layout.dirsOf('e1').workspace;
  const second = layout.dirsOf('e2').workspace;
  t.is(readFileSync(join(second, 'shell-copy'), 'utf8'), 'tracked\n');
  for (const dir of [first, second]) {
    t.is(git(dir, ['rev-parse', 'HEAD']), seed.commit);
    t.is(git(dir, ['branch', '--show-current']), 'main');
    t.is(git(dir, ['remote']), '');
    t.false(existsSync(join(dir, '.git', 'objects', 'info', 'alternates')));
    t.false(existsSync(join(dir, '.git', 'FETCH_HEAD')));
  }
  writeFileSync(join(first, 'source.txt'), 'edited\n');
  t.is(readFileSync(join(second, 'source.txt'), 'utf8'), 'tracked\n');
  rmSync(bundle);
  const restarted = makeLayout({ stateDir });
  restarted.registerSeed('e1', seed);
  await restarted.ensureWorkspace('e1');
  t.is(readFileSync(join(first, 'source.txt'), 'utf8'), 'edited\n');
  const changed = makeLayout({ stateDir });
  changed.registerSeed('e1', { ...seed, commit: 'a'.repeat(40) });
  await t.throwsAsync(changed.ensureWorkspace('e1'), {
    message: 'Workspace seed changed',
  });
  t.is(readFileSync(join(first, 'source.txt'), 'utf8'), 'edited\n');
});

test('seed validation refuses unsafe and missing sources; interrupted checkout retries', async t => {
  const stateDir = freshState(t);
  const { seed, bundle } = makeSeed(stateDir);
  const layout = makeLayout({ stateDir });
  for (const invalid of [
    { ...seed, project: '../thixotrope' },
    { ...seed, commit: '../seed' },
    { ...seed, commit: seed.commit.toUpperCase() },
  ])
    t.throws(() => layout.registerSeed('e1', /** @type {any} */ (invalid)), {
      message: 'Invalid workspace seed',
    });
  const other = { ...seed, commit: 'a'.repeat(40) };
  const otherBundle = join(bundle, '..', `${other.commit}.bundle`);
  layout.registerSeed('e1', other);
  await t.throwsAsync(layout.ensureWorkspace('e1'), {
    message: 'Workspace seed bundle is missing',
  });
  symlinkSync(bundle, otherBundle);
  await t.throwsAsync(layout.ensureWorkspace('e1'));
  rmSync(otherBundle);
  writeFileSync(otherBundle, readFileSync(bundle));
  await t.throwsAsync(layout.ensureWorkspace('e1'), {
    message: 'Workspace seed ref does not match the configured commit',
  });
  t.false(
    existsSync(join(layout.dirsOf('e1').workspace, '..', 'workspace-seed')),
  );
  const ws = layout.dirsOf('e2').workspace;
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'partial'), 'incomplete');
  layout.registerSeed('e2', seed);
  await layout.ensureWorkspace('e2');
  t.false(existsSync(join(ws, 'partial')));
  t.is(git(ws, ['rev-parse', 'HEAD']), seed.commit);
});
