// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make } from '../caplet.js';

const GOOD = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';
const OTHER = '59aba752de8ebbbcb485015e9159dcb6d16856e6';

/** @param {import('ava').ExecutionContext} t */
const makeAdmin = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nixos-admin-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const nixosDir = join(dir, 'spool');
  const lockDir = join(dir, 'locks');
  await Promise.all([mkdir(configDir), mkdir(lockDir)]);
  const admin = await make(undefined, undefined, {
    env: {
      ENDO_NIXOS_CONFIG_DIR: configDir,
      ENDO_NIXOS_DIR: nixosDir,
      ENDO_NIXOS_LOCK_DIR: lockDir,
    },
    systemPaths:
      process.platform === 'linux'
        ? { flock: '/usr/bin/flock', shell: '/bin/sh' }
        : {},
  });
  return { admin, configDir };
};

test('a host with no pin reports an empty revision', async t => {
  const { admin } = await makeAdmin(t);
  t.is(await admin.getEndoRev(), '');
});

test('stageRev writes the pin file and reports what it replaced', async t => {
  const { admin, configDir } = await makeAdmin(t);

  const first = await admin.stageRev(GOOD);
  t.deepEqual(first, { path: 'endo.rev', rev: GOOD, previous: '' });
  // The trailing newline matters: `lib.fileContents` strips exactly one, and a
  // file without it is a diff-noisy no-newline-at-end-of-file.
  t.is(await readFile(join(configDir, 'endo.rev'), 'utf8'), `${GOOD}\n`);
  t.is(await admin.getEndoRev(), GOOD);

  const second = await admin.stageRev(OTHER);
  t.deepEqual(second, { path: 'endo.rev', rev: OTHER, previous: GOOD });
});

test('stageRev rejects anything that is not a full commit hash', async t => {
  const { admin, configDir } = await makeAdmin(t);
  await admin.stageRev(GOOD);

  for (const bad of [
    'f83f0430', // abbreviated: ambiguous, and Nix cannot resolve it
    GOOD.toUpperCase(), // the config compares literally
    'llm', // a branch name is not a pin
    `${GOOD}0`, // 41 characters
    `${GOOD.slice(0, 39)}g`, // right length, not hex
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => admin.stageRev(bad), {
      message: /40-character lowercase commit hash/,
    });
  }

  // A rejected write leaves the previous pin intact rather than clearing it.
  t.is(await readFile(join(configDir, 'endo.rev'), 'utf8'), `${GOOD}\n`);
});

test("stageRev('') removes the pin, restoring branch tracking", async t => {
  const { admin, configDir } = await makeAdmin(t);
  await admin.stageRev(GOOD);
  const removed = await admin.stageRev('');
  t.deepEqual(removed, { path: 'endo.rev', rev: '', previous: GOOD });
  t.is(await admin.getEndoRev(), '');
  await t.throwsAsync(() => readFile(join(configDir, 'endo.rev')), {
    code: 'ENOENT',
  });
  // Compensation symmetry: restaging a captured previous of '' restores
  // the exact "no pin" state a first-pin host started from.
  const first = await admin.stageRev(OTHER);
  t.is(first.previous, '');
  await admin.stageRev(first.previous);
  t.is(await admin.getEndoRev(), '');
});

test('surrounding whitespace is tolerated, since a hash is often pasted', async t => {
  const { admin } = await makeAdmin(t);
  await admin.stageRev(`  ${GOOD}\n`);
  t.is(await admin.getEndoRev(), GOOD);
});

test('a pin file written by hand is read back trimmed', async t => {
  const { admin, configDir } = await makeAdmin(t);
  await writeFile(join(configDir, 'endo.rev'), `${GOOD}\n`, 'utf8');
  t.is(await admin.getEndoRev(), GOOD);
});
