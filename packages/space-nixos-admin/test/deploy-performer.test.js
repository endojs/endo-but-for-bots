// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make, sanitizeId } from '../caplet.js';

const REV = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {import('ava').ExecutionContext} t */
const makeHarness = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nixos-deploy-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const spoolDir = join(dir, 'spool');
  await mkdir(configDir);
  const env = {
    ENDO_NIXOS_CONFIG_DIR: configDir,
    ENDO_NIXOS_DIR: spoolDir,
    ENDO_NIXOS_POLL_MS: '10',
  };
  // A second `make` over the same directories stands in for the caplet's
  // next incarnation after a daemon restart.
  const reincarnate = () => make(undefined, undefined, { env });
  const admin = await reincarnate();

  const requestPath = join(spoolDir, 'apply-request.json');
  const statusPath = join(spoolDir, 'apply-status.json');
  const outcomesDir = join(spoolDir, 'outcomes');

  const readRequest = async () => {
    const text = await readFile(requestPath, 'utf8');
    return JSON.parse(text);
  };
  const requestBytes = async () =>
    readFile(requestPath, 'utf8').catch(() => undefined);

  /**
   * The applier's fake: wait for a request this run has not yet processed,
   * echo its id in status, and record the terminal outcome per the id-echo
   * spool contract.
   *
   * @param {{ phase?: string }} [outcome]
   */
  const seen = new Set();
  const processNext = async ({ phase = 'ok' } = {}) => {
    await null;
    for (let i = 0; i < 500; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const request = await readRequest().catch(() => undefined);
      if (request !== undefined && !seen.has(request.id)) {
        seen.add(request.id);
        const record = {
          id: request.id,
          action: request.action,
          message: request.message,
          phase,
        };
        // eslint-disable-next-line no-await-in-loop
        await writeFile(statusPath, JSON.stringify(record), 'utf8');
        // eslint-disable-next-line no-await-in-loop
        await mkdir(outcomesDir, { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await writeFile(
          join(outcomesDir, `${sanitizeId(request.id)}.json`),
          JSON.stringify(record),
          'utf8',
        );
        return record;
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    throw Error('fake applier saw no fresh request');
  };

  return {
    admin,
    reincarnate,
    processNext,
    readRequest,
    requestBytes,
    configDir,
    spoolDir,
    statusPath,
  };
};

test('build waits for and returns the terminal outcome', async t => {
  const { admin, processNext } = await makeHarness(t);
  const settled = admin.build('validate the pin', 'r-1:0-0');
  await processNext();
  const outcome = await settled;
  t.like(outcome, { ok: true, phase: 'ok', id: 'r-1:0-0', action: 'build' });
});

test('a failed apply reports ok: false with the log tail', async t => {
  const { admin, processNext, spoolDir } = await makeHarness(t);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(join(spoolDir, 'apply.log'), 'boom: unfree package', 'utf8');
  const settled = admin.apply('bad change', 'r-1:3-0');
  await processNext({ phase: 'error' });
  const outcome = await settled;
  t.like(outcome, { ok: false, phase: 'error' });
  t.regex(outcome.log, /unfree package/);
});

test('re-invoking a settled key returns the record without re-submitting', async t => {
  // The restart-loop killer: after an apply restarts the daemon, the
  // workflow engine re-dispatches the same invoke with the same key. The
  // revived caplet must answer from the recorded outcome — a second spool
  // submission would rebuild and re-switch, restarting the daemon again,
  // forever.
  const { admin, reincarnate, processNext, requestBytes } =
    await makeHarness(t);
  const settled = admin.apply('deploy the release', 'r-9:5-0');
  await processNext();
  t.true((await settled).ok);

  const bytesBefore = await requestBytes();
  const revived = await reincarnate();
  const again = await revived.apply('deploy the release', 'r-9:5-0');
  t.like(again, { ok: true, phase: 'ok', id: 'r-9:5-0' });
  t.is(await requestBytes(), bytesBefore, 'no second spool submission');
});

test('a duplicate in-flight dispatch attaches to the pending request', async t => {
  const { admin, reincarnate, processNext, requestBytes } =
    await makeHarness(t);
  const first = admin.apply('deploy', 'r-2:4-0');
  // Wait for the submission to land, then re-dispatch from a "revived"
  // incarnation while the applier has not answered yet.
  for (let i = 0; i < 500; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await requestBytes()) !== undefined) break;
    // eslint-disable-next-line no-await-in-loop
    await delay(5);
  }
  const bytesBefore = await requestBytes();
  const revived = await reincarnate();
  const second = revived.apply('deploy', 'r-2:4-0');
  await delay(50);
  t.is(await requestBytes(), bytesBefore, 'the pending request is untouched');
  await processNext();
  const [a, b] = await Promise.all([first, second]);
  t.true(a.ok);
  t.true(b.ok);
});

test('an id-less status refuses submission instead of guessing', async t => {
  const { admin, statusPath, requestBytes, spoolDir } = await makeHarness(t);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify({ phase: 'ok' }), 'utf8');
  await t.throwsAsync(() => admin.build('note', 'r-3:0-0'), {
    message: /does not echo request ids/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('a request superseded without an outcome fails loud, never retries', async t => {
  const { admin, requestBytes, statusPath, spoolDir } = await makeHarness(t);
  const settled = admin.apply('deploy', 'r-4:2-0');
  for (let i = 0; i < 500; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await requestBytes()) !== undefined) break;
    // eslint-disable-next-line no-await-in-loop
    await delay(5);
  }
  // Another actor steals the single request slot and the applier answers
  // them, leaving our id with no outcome ever.
  await writeFile(
    join(spoolDir, 'apply-request.json'),
    JSON.stringify({ action: 'build', id: 'intruder', nonce: 'x' }),
    'utf8',
  );
  await writeFile(
    statusPath,
    JSON.stringify({ id: 'intruder', phase: 'ok' }),
    'utf8',
  );
  await t.throwsAsync(() => settled, {
    message: /superseded without an outcome/,
  });
});

test('operations serialize: one spool submission at a time, in order', async t => {
  const { admin, processNext, readRequest } = await makeHarness(t);
  const first = admin.build('first', 'r-5:0-0');
  const second = admin.build('second', 'r-5:1-0');
  const a = await processNext();
  t.is(a.id, 'r-5:0-0');
  t.true((await first).ok);
  const b = await processNext();
  t.is(b.id, 'r-5:1-0');
  t.true((await second).ok);
  t.is((await readRequest()).id, 'r-5:1-0');
});

test('stageFiles captures previous contents and revertFiles restores them', async t => {
  const { admin, configDir } = await makeHarness(t);
  await writeFile(join(configDir, 'existing.nix'), 'before\n', 'utf8');

  const staged = await admin.stageFiles(
    harden([
      { path: 'existing.nix', text: 'after\n' },
      { path: 'modules/new.nix', text: 'created\n' },
    ]),
    'r-6:0-0',
  );
  t.deepEqual(staged.paths, ['existing.nix', 'modules/new.nix']);
  t.deepEqual(staged.previous, [
    { path: 'existing.nix', text: 'before\n' },
    { path: 'modules/new.nix', text: null },
  ]);
  t.is(await readFile(join(configDir, 'existing.nix'), 'utf8'), 'after\n');
  t.is(
    await readFile(join(configDir, 'modules/new.nix'), 'utf8'),
    'created\n',
  );

  await admin.revertFiles(staged.previous, 'r-6:1-0');
  t.is(await readFile(join(configDir, 'existing.nix'), 'utf8'), 'before\n');
  await t.throwsAsync(() => readFile(join(configDir, 'modules/new.nix')), {
    code: 'ENOENT',
  });
});

test('verify reads the pin back and reports a rollback as not-ok', async t => {
  const { admin } = await makeHarness(t);
  await admin.stageRev(REV);
  t.like(await admin.verify(REV), { ok: true, runningRev: REV });
  const other = REV.replace(/^f/, '0');
  t.like(await admin.verify(other), { ok: false, runningRev: REV });
});

test('sanitizeId makes engine keys filesystem-safe and stable', t => {
  t.is(sanitizeId('r-12:8-1'), 'r-12_8-1');
  t.is(sanitizeId('r-12:8-1'), sanitizeId('r-12:8-1'));
  t.throws(() => sanitizeId(''), { message: /non-empty request id/ });
});
