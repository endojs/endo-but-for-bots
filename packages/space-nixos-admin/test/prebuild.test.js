// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make } from '../caplet.js';

const REV_A = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';
const REV_B = '59aba752de8ebbbcb485015e9159dcb6d16856e6';

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {import('ava').ExecutionContext} t */
const makeHarness = async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nixos-prebuild-'));
  t.teardown(() => rm(stateDir, { recursive: true, force: true }));
  const configDir = join(stateDir, 'config');
  const nixosDir = join(stateDir, 'nixos');
  const deployDir = join(stateDir, 'deploy');
  const releasesDir = join(stateDir, 'releases');
  const lockDir = join(stateDir, 'locks');
  await Promise.all([
    mkdir(configDir),
    mkdir(nixosDir),
    mkdir(deployDir),
    mkdir(releasesDir),
    mkdir(lockDir),
  ]);
  const env = {
    ENDO_NIXOS_CONFIG_DIR: configDir,
    ENDO_NIXOS_DIR: nixosDir,
    ENDO_NIXOS_STATE_DIR: stateDir,
    ENDO_NIXOS_LOCK_DIR: lockDir,
    ENDO_NIXOS_POLL_MS: '10',
    ENDO_NIXOS_WATCH_LIMIT_MS: '5000',
  };
  const reincarnate = () =>
    make(undefined, undefined, {
      env,
      systemPaths:
        process.platform === 'linux'
          ? { flock: '/usr/bin/flock', shell: '/bin/sh' }
          : {},
    });
  const requestPath = join(deployDir, 'request.json');
  const statusPath = join(deployDir, 'status.json');
  const requestBytes = () =>
    readFile(requestPath, 'utf8').catch(() => undefined);
  const nextRequest = async previous => {
    await null;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await requestBytes();
      if (bytes !== undefined && bytes !== previous) {
        return { bytes, request: JSON.parse(bytes) };
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    throw new Error('saw no new deploy request');
  };
  const finish = async rev => {
    const releaseDir = join(releasesDir, rev);
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, '.deploy-complete'), 'ok\n');
  };
  return {
    reincarnate,
    nextRequest,
    finish,
    requestBytes,
    statusPath,
    releasesDir,
  };
};

test('prebuild rejects an empty idempotency key before publication', async t => {
  const { reincarnate, requestBytes } = await makeHarness(t);
  const admin = await reincarnate();
  await t.throwsAsync(() => admin.prebuildRev(REV_A, ''), {
    message: /non-empty idempotency key/,
  });
  t.is(await requestBytes(), undefined);
});

test('an unreadable release marker is a protocol failure', async t => {
  const { reincarnate, requestBytes, releasesDir } = await makeHarness(t);
  await mkdir(join(releasesDir, REV_A, '.deploy-complete'), {
    recursive: true,
  });
  const admin = await reincarnate();
  await t.throwsAsync(() => admin.prebuildRev(REV_A, 'attempt'), {
    code: 'EISDIR',
  });
  t.is(await requestBytes(), undefined);
});

test('a malformed prebuild request is preserved and fails closed', async t => {
  const { reincarnate, requestBytes } = await makeHarness(t);
  const malformed = JSON.stringify({
    action: 'prebuild',
    rev: '../../outside',
    nonce: 'foreign',
  });
  const admin = await reincarnate();
  // The deploy request path is fixed by the harness state layout.
  const stateDir = await admin.getConfig().then(config => config.stateDir);
  await writeFile(join(stateDir, 'deploy', 'request.json'), malformed);

  await t.throwsAsync(() => admin.prebuildRev(REV_A, 'mine'), {
    message: /Malformed prebuild request/,
  });
  t.is(await requestBytes(), malformed);
});

test('a malformed prebuild status is preserved and fails closed', async t => {
  const { reincarnate, requestBytes, statusPath } = await makeHarness(t);
  const malformed = JSON.stringify({
    rev: REV_A,
    nonce: 'foreign',
    phase: 'mysterious',
  });
  await writeFile(statusPath, malformed);
  const admin = await reincarnate();

  await t.throwsAsync(() => admin.prebuildRev(REV_A, 'mine'), {
    message: /Malformed prebuild status/,
  });
  t.is(await readFile(statusPath, 'utf8'), malformed);
  t.is(await requestBytes(), undefined);
});

test('prebuild publication is atomic and attaches by revision', async t => {
  const { reincarnate, nextRequest, finish, requestBytes } =
    await makeHarness(t);
  const firstAdmin = await reincarnate();
  const secondAdmin = await reincarnate();
  const first = firstAdmin.prebuildRev(REV_A, 'first');
  const second = secondAdmin.prebuildRev(REV_A, 'second');

  const { bytes, request } = await nextRequest(undefined);
  t.is(request.rev, REV_A);
  t.is(request.action, 'prebuild');
  await delay(50);
  t.is(await requestBytes(), bytes, 'the attached call did not overwrite');
  await finish(REV_A);

  t.true((await first).ok);
  t.true((await second).ok);
});

test('concurrent prebuilds do not overwrite the shared deploy slot', async t => {
  const { reincarnate, nextRequest, finish, requestBytes } =
    await makeHarness(t);
  const firstAdmin = await reincarnate();
  const secondAdmin = await reincarnate();
  const first = firstAdmin.prebuildRev(REV_A, 'first');
  const second = secondAdmin.prebuildRev(REV_B, 'second');

  const initial = await nextRequest(undefined);
  await delay(50);
  t.is(
    await requestBytes(),
    initial.bytes,
    'the other revision remained queued',
  );
  await finish(initial.request.rev);
  const following = await nextRequest(initial.bytes);
  t.not(following.request.rev, initial.request.rev);
  await finish(following.request.rev);

  t.true((await first).ok);
  t.true((await second).ok);
});

test('a failed prebuild can be retried with a new nonce', async t => {
  const { reincarnate, nextRequest, finish, statusPath } = await makeHarness(t);
  const firstAdmin = await reincarnate();
  const first = firstAdmin.prebuildRev(REV_A, 'attempt-1');
  const initial = await nextRequest(undefined);
  await writeFile(
    statusPath,
    JSON.stringify({
      rev: REV_A,
      nonce: initial.request.nonce,
      phase: 'error',
      message: 'transient failure',
    }),
  );
  t.false((await first).ok);

  const secondAdmin = await reincarnate();
  const retry = secondAdmin.prebuildRev(REV_A, 'attempt-2');
  const following = await nextRequest(initial.bytes);
  t.is(following.request.nonce, 'attempt-2');
  await finish(REV_A);
  t.true((await retry).ok);
});
