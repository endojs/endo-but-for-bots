// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeSessionStateStorage } from '../src/session-state-storage.js';

/** @param {import('ava').ExecutionContext} t */
const makeRoot = async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'session-state-'));
  t.teardown(() => rm(base, { recursive: true, force: true }));
  return path.join(base, 'state');
};

const exists = async p =>
  lstat(p).then(
    () => true,
    () => false,
  );

test('preparation creates a private session directory owned through a marker beside it', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  t.is(directory, `${root}/session-a`);
  // eslint-disable-next-line no-bitwise
  t.is((await stat(directory)).mode & 0o777, 0o700);
  t.is(await readFile(`${root}/.owners/session-a`, 'utf8'), 'session-a\n');
  // Reopening is idempotent and returns the same placement.
  t.deepEqual(await storage.prepareSessionDirectory('session-a'), {
    directory,
  });
  await t.throwsAsync(storage.prepareSessionDirectory('../escape'), {
    message: /Invalid session id/,
  });
});

test('a directory owned by another session is refused, not reused or removed', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  await storage.prepareSessionDirectory('session-a');
  await writeFile(`${root}/.owners/session-a`, 'someone-else\n');
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    message: /not owned by this session/,
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: /not owned by this session/,
  });
  t.true(await exists(`${root}/session-a`));
});

test('removal deletes only the owned directory and its marker, and tolerates absence', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  await writeFile(path.join(directory, 'db.sqlite'), 'x');
  await storage.prepareSessionDirectory('session-b');
  await storage.removeSessionDirectory('session-a');
  t.false(await exists(directory));
  t.false(await exists(`${root}/.owners/session-a`));
  t.true(await exists(`${root}/session-b`));
  await storage.removeSessionDirectory('session-a');
  await storage.removeSessionDirectory('never-prepared');
  t.pass('absent directories are already removed');
});

test('symbolic links at the root, the owners directory, or a session path are refused', async t => {
  const base = await makeRoot(t);
  const target = path.join(path.dirname(base), 'elsewhere');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await symlink(target, base);
  const linkedRoot = makeSessionStateStorage({ stateRoot: base });
  await t.throwsAsync(linkedRoot.prepareSessionDirectory('session-a'), {
    message: /State root must not be a symlink/,
  });
  t.is(await readlink(base), target, 'the link is untouched');
  const root = path.join(path.dirname(base), 'real-state');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await symlink(target, path.join(root, '.owners'));
  const linkedOwners = makeSessionStateStorage({ stateRoot: root });
  await t.throwsAsync(linkedOwners.prepareSessionDirectory('session-a'), {
    message: /Ownership directory must not be a symlink/,
  });
  // A session path that became a symlink is neither reused nor removed.
  const other = path.join(path.dirname(base), 'other-state');
  const storage = makeSessionStateStorage({ stateRoot: other });
  await storage.prepareSessionDirectory('session-a');
  await rm(path.join(other, 'session-a'), { recursive: true });
  await symlink(target, path.join(other, 'session-a'));
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    message: /symbolic link|Cannot create session state directory/,
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: /symbolic link/,
  });
  t.is(await readlink(path.join(other, 'session-a')), target, 'untouched');
});
