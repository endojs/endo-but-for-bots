// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  chmod,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { make, sanitizeId } from '../caplet.js';

const REV = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';

const fingerprintFor = (
  action,
  message,
  configFingerprint,
  protocolFingerprint,
) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        action,
        message,
        configFingerprint,
        protocolFingerprint,
      }),
      'utf8',
    )
    .digest('hex');

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ shell?: string }} [options] - `shell` stands in for the lock
 *   holder's `/bin/sh`, so a test can model a holder that dies mid-transaction.
 */
const makeHarness = async (t, { shell = '/bin/sh' } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'nixos-deploy-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const spoolDir = join(dir, 'spool');
  const currentSystem = join(dir, 'current-system');
  const lockDir = join(dir, 'locks');
  const systemStorePath = '/nix/store/aaaaaaaa-test-system';
  await Promise.all([
    mkdir(configDir),
    mkdir(spoolDir),
    mkdir(lockDir),
    symlink(systemStorePath, currentSystem),
  ]);
  const canonicalConfigDir = await realpath(configDir);
  const canonicalLockDir = await realpath(lockDir);
  const protocolPath = join(spoolDir, 'protocol.json');
  const protocol = {
    version: 2,
    idEcho: true,
    outcomes: true,
    system: systemStorePath,
    host: hostname(),
    configDir: canonicalConfigDir,
    lockDir: canonicalLockDir,
  };
  const protocolFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: protocol.version,
        idEcho: protocol.idEcho,
        outcomes: protocol.outcomes,
        host: protocol.host,
        configDir: protocol.configDir,
        lockDir: protocol.lockDir,
      }),
      'utf8',
    )
    .digest('hex');
  await writeFile(protocolPath, JSON.stringify(protocol));
  const env = {
    ENDO_NIXOS_CONFIG_DIR: configDir,
    ENDO_NIXOS_DIR: spoolDir,
    ENDO_NIXOS_LOCK_DIR: lockDir,
    ENDO_NIXOS_POLL_MS: '10',
    // Bound abandoned watchers so a failing test cannot hold the worker
    // open for the production 24h cap.
    ENDO_NIXOS_WATCH_LIMIT_MS: '5000',
  };
  // A second `make` over the same directories stands in for the caplet's
  // next incarnation after a daemon restart.
  const reincarnate = () =>
    make(undefined, undefined, {
      env,
      systemPaths: {
        currentSystem,
        ...(process.platform === 'linux'
          ? { flock: '/usr/bin/flock', shell }
          : {}),
      },
    });
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
   * The applier's fake, per the id-echo spool contract. It FAILS THE TEST
   * on any physical re-submission of an id it already processed (a fresh
   * nonce under a seen id), so every test that runs it is inherently
   * sensitive to the resubmission regressions that would loop a machine.
   */
  /** @type {Map<string, string>} */
  const seen = new Map();
  const nextRequest = async () => {
    await null;
    for (let i = 0; i < 500; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const request = await readRequest().catch(() => undefined);
      if (request !== undefined && seen.has(request.id)) {
        if (seen.get(request.id) !== request.nonce) {
          throw Error(
            `fake applier saw a RE-SUBMISSION of ${request.id} — a real ` +
              'applier would rebuild and re-switch the machine',
          );
        }
      } else if (request !== undefined) {
        seen.set(request.id, request.nonce);
        return request;
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    throw Error('fake applier saw no fresh request');
  };
  const recordOutcome = async (request, { phase = 'ok' } = {}) => {
    const record = {
      id: request.id,
      action: request.action,
      fingerprint: request.fingerprint,
      configFingerprint: request.configFingerprint,
      protocolFingerprint: request.protocolFingerprint,
      phase,
      message: phase === 'ok' ? 'completed' : 'simulated failure',
    };
    await writeFile(statusPath, JSON.stringify(record), 'utf8');
    await mkdir(outcomesDir, { recursive: true });
    await writeFile(
      join(outcomesDir, `${sanitizeId(request.id)}.json`),
      JSON.stringify(record),
      'utf8',
    );
    return record;
  };
  const processNext = async ({ phase = 'ok' } = {}) => {
    const request = await nextRequest();
    return recordOutcome(request, { phase });
  };
  // A CONSUMING applier: picks the request up, deletes the slot, echoes the
  // id in status — and does not settle. Models the health-check window of
  // an applier that consumes request files.
  const pickUpAndConsume = async () => {
    const request = await nextRequest();
    await rm(join(spoolDir, 'apply-request.json'), { force: true });
    await writeFile(
      statusPath,
      JSON.stringify({
        id: request.id,
        action: request.action,
        fingerprint: request.fingerprint,
        configFingerprint: request.configFingerprint,
        protocolFingerprint: request.protocolFingerprint,
        phase: 'switching',
      }),
      'utf8',
    );
    return request;
  };

  return {
    admin,
    reincarnate,
    processNext,
    nextRequest,
    pickUpAndConsume,
    recordOutcome,
    readRequest,
    requestBytes,
    configDir,
    spoolDir,
    statusPath,
    outcomesDir,
    protocolPath,
    protocolFingerprint,
    protocol,
    currentSystem,
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

test('a settled switch survives its NixOS system transition', async t => {
  const {
    admin,
    reincarnate,
    processNext,
    requestBytes,
    protocolPath,
    protocol,
    currentSystem,
  } = await makeHarness(t);
  const settled = admin.apply('activate new system', 'r-9:5-1');
  await processNext();
  t.true((await settled).ok);
  const requestBefore = await requestBytes();

  const nextSystem = '/nix/store/bbbbbbbb-next-test-system';
  await rm(currentSystem);
  await symlink(nextSystem, currentSystem);
  await writeFile(
    protocolPath,
    JSON.stringify({ ...protocol, system: nextSystem }),
  );

  const revived = await reincarnate();
  t.true((await revived.apply('activate new system', 'r-9:5-1')).ok);
  t.is(await requestBytes(), requestBefore, 'recovery did not resubmit');
});

test('a settled key cannot be reused for different arguments', async t => {
  const { admin, reincarnate, processNext, requestBytes } =
    await makeHarness(t);
  const settled = admin.build('validate', 'r-9:6-0');
  await processNext();
  t.true((await settled).ok);
  const bytesBefore = await requestBytes();

  const revived = await reincarnate();
  await t.throwsAsync(() => revived.apply('deploy', 'r-9:6-0'), {
    message: /already bound/,
  });
  t.is(await requestBytes(), bytesBefore, 'no new operation was submitted');
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

test('a stale id-less status does not wedge an applier that does echo ids', async t => {
  // The regression this guards: one hand-written apply leaves an id-less
  // status behind, and every settlement verb on the host then refuses
  // forever, blaming an applier that is in fact fine.
  const { admin, statusPath, spoolDir, processNext } = await makeHarness(t);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify({ phase: 'ok' }), 'utf8');

  const settled = admin.build('note', 'r-9:0-0');
  await processNext();
  t.true((await settled).ok);
});

test('a missing current protocol marker refuses submission', async t => {
  const { admin, statusPath, requestBytes, spoolDir, protocolPath } =
    await makeHarness(t);
  await mkdir(spoolDir, { recursive: true });
  await rm(protocolPath);
  await writeFile(statusPath, JSON.stringify({ phase: 'ok' }), 'utf8');
  await t.throwsAsync(() => admin.build('note', 'r-3:0-0'), {
    message: /does not advertise protocol/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('historical outcomes do not prove the current applier protocol', async t => {
  const { admin, statusPath, requestBytes, outcomesDir, protocolPath } =
    await makeHarness(t);
  await rm(protocolPath);
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, 'historical.json'),
    JSON.stringify({ id: 'historical', phase: 'ok' }),
  );
  await writeFile(statusPath, JSON.stringify({ phase: 'ok' }), 'utf8');

  await t.throwsAsync(() => admin.apply('must not escape', 'r-3:1-0'), {
    message: /does not advertise protocol/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('protocol marker must bind the configured host and checkout', async t => {
  const { admin, requestBytes, protocolPath } = await makeHarness(t);
  await writeFile(
    protocolPath,
    JSON.stringify({
      version: 2,
      idEcho: true,
      outcomes: true,
      system: '/nix/store/aaaaaaaa-test-system',
      host: 'another-host',
      configDir: '/another/checkout',
      lockDir: '/another/lock-directory',
    }),
  );

  await t.throwsAsync(() => admin.build('must not escape', 'r-3:2-0'), {
    message: /host.*checkout/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('protocol marker must bind the shared lock directory', async t => {
  const { admin, requestBytes, protocolPath } = await makeHarness(t);
  const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
  await writeFile(
    protocolPath,
    JSON.stringify({ ...protocol, lockDir: '/another/lock-directory' }),
  );

  await t.throwsAsync(() => admin.build('must not escape', 'r-3:3-0'), {
    message: /lock directory/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('a malformed request occupies the slot and is never overwritten', async t => {
  const { admin, requestBytes, spoolDir } = await makeHarness(t);
  await writeFile(join(spoolDir, 'apply-request.json'), '{}');
  const before = await requestBytes();

  await t.throwsAsync(() => admin.build('must not escape', 'r-3:4-0'), {
    message: /Malformed or foreign apply request/,
  });
  t.is(await requestBytes(), before);
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

test('separate caplet instances cannot race the shared request slot', async t => {
  const { admin, reincarnate, processNext } = await makeHarness(t);
  const other = await reincarnate();
  const first = admin.build('first instance', 'r-5:2-0');
  const second = other.build('second instance', 'r-5:3-0');

  const a = await processNext();
  const b = await processNext();
  t.deepEqual([a.id, b.id].sort(), ['r-5:2-0', 'r-5:3-0']);
  t.true((await first).ok);
  t.true((await second).ok);
});

test.serial(
  'a stopped lock owner is never evicted; a crash releases it',
  async t => {
    if (process.platform !== 'linux') {
      t.pass();
      return;
    }
    const { admin, processNext, requestBytes, spoolDir } = await makeHarness(t);
    const child = spawn(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--no-fork',
        join(spoolDir, 'submit.lock'),
        '/bin/sh',
        '-c',
        'printf "ready\\n"; IFS= read -r _',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    t.teardown(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    });
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`lock fixture exited before ready (${code})`);
      }),
    ]);
    child.kill('SIGSTOP');

    const settled = admin.build('wait for lock', 'r-5:4-0');
    await delay(100);
    t.is(await requestBytes(), undefined, 'a stopped live owner kept the lock');

    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await processNext();
    t.true((await settled).ok);
  },
);

test.serial(
  'a lock holder that dies mid-transaction fails loud, never silently',
  async t => {
    if (process.platform !== 'linux') {
      t.pass();
      return;
    }
    // The holder is reaped after the caplet has begun working under its lock
    // — the OOM killer during a long fingerprint walk, or an operator's kill.
    // The kernel drops the lock the instant that process dies, so the
    // transaction is no longer exclusive and its result must not be
    // acknowledged. This fixture also closes its stdin, so the caplet's
    // release write lands on a broken pipe: without an `error` listener on
    // `child.stdin` that EPIPE is an unhandled stream error, which is an
    // uncaught exception that takes the daemon down instead of surfacing here.
    const dir = await mkdtemp(join(tmpdir(), 'nixos-lockdeath-'));
    t.teardown(() => rm(dir, { recursive: true, force: true }));
    const shell = join(dir, 'dying-holder.sh');
    await writeFile(
      shell,
      '#!/bin/sh\nprintf "locked\\n"\nexec 0<&-\nsleep 0.05\nexit 9\n',
      'utf8',
    );
    await chmod(shell, 0o755);
    const { admin } = await makeHarness(t, { shell });

    await t.throwsAsync(() => admin.getEndoRev(), {
      message: /was not exclusive/,
    });
  },
);

test('an unprovisioned lock directory does not sink the whole capability', async t => {
  // ENDO_NIXOS_LOCK_DIR lives on a tmpfs a reboot clears and the privileged
  // service reprovisions; the daemon may legitimately start first.
  // Canonicalizing it eagerly used to reject `make` outright, leaving even the
  // read-only diagnostics unreachable until something re-instantiated the
  // caplet.
  const dir = await mkdtemp(join(tmpdir(), 'nixos-lockdir-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const spoolDir = join(dir, 'spool');
  await Promise.all([mkdir(configDir), mkdir(spoolDir)]);

  const admin = await make(undefined, undefined, {
    env: {
      ENDO_NIXOS_CONFIG_DIR: configDir,
      ENDO_NIXOS_DIR: spoolDir,
      ENDO_NIXOS_LOCK_DIR: join(dir, 'not-yet-provisioned'),
      ENDO_NIXOS_POLL_MS: '10',
      ENDO_NIXOS_WATCH_LIMIT_MS: '5000',
    },
    systemPaths:
      process.platform === 'linux'
        ? { flock: '/usr/bin/flock', shell: '/bin/sh' }
        : {},
  });
  const config = await admin.getConfig();
  t.true(config.configured);
  // Exactly what `realpath` will report once the service creates it, so an
  // incarnation on either side of that computes the same lock path.
  t.is(
    config.canonicalLockDir,
    join(await realpath(dir), 'not-yet-provisioned'),
  );
  t.deepEqual(await admin.listFiles(), [], 'a locked verb still works');
});

test('config fingerprint matches the published known-answer vector', async t => {
  const { admin, configDir, readRequest, processNext } = await makeHarness(t);
  await writeFile(join(configDir, 'a.nix'), 'abc\n');
  await mkdir(join(configDir, 'empty'));
  await chmod(join(configDir, 'a.nix'), 0o644);
  await chmod(join(configDir, 'empty'), 0o755);

  const settled = admin.build('known-answer', 'r-5:5-0');
  let request;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      request = await readRequest();
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
  }
  t.is(
    request.configFingerprint,
    'fcedad18db84adbaf8935ae34ce543e024d36160a79125aaac195e25c5336dd2',
  );
  await processNext();
  t.true((await settled).ok);
});

test('an outcome from another protocol binding cannot settle a key', async t => {
  const { admin, readRequest, outcomesDir } = await makeHarness(t);
  const settled = admin.build('bound outcome', 'r-5:6-0');
  let request;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      request = await readRequest();
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
  }
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId(request.id)}.json`),
    JSON.stringify({
      ...request,
      protocolFingerprint: '0'.repeat(64),
      phase: 'ok',
    }),
  );
  await t.throwsAsync(() => settled, { message: /another host configuration/ });
});

test('an outcome must carry the action configuration fingerprint', async t => {
  const { admin, readRequest, outcomesDir } = await makeHarness(t);
  const settled = admin.build('complete schema', 'r-5:7-0');
  let request;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      request = await readRequest();
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
  }
  const incomplete = {
    id: request.id,
    action: request.action,
    fingerprint: request.fingerprint,
    protocolFingerprint: request.protocolFingerprint,
    nonce: request.nonce,
  };
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId(request.id)}.json`),
    JSON.stringify({ ...incomplete, phase: 'ok' }),
  );
  await t.throwsAsync(() => settled, { message: /configFingerprint/ });
});

test('an outcome must echo the submitted configuration fingerprint', async t => {
  const { admin, readRequest, outcomesDir } = await makeHarness(t);
  const settled = admin.build('exact config', 'r-5:8-0');
  let request;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      request = await readRequest();
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
  }
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId(request.id)}.json`),
    JSON.stringify({
      ...request,
      configFingerprint: '0'.repeat(64),
      phase: 'ok',
    }),
  );
  await t.throwsAsync(() => settled, { message: /already bound/ });
});

// `rollback` is the only action that submits `configFingerprint: null`, so
// these three are the only exercise of the null branches in
// operationFingerprint, assertApplyRequest, assertOutcomeRecord, and
// isConfigFingerprint. It is also the root-equivalent recovery verb: a
// re-dispatch that re-submitted would reactivate a generation a second time,
// restarting the daemon that is trying to observe the first one.

test('a rollback settles on a null fingerprint and re-dispatch never re-submits', async t => {
  const { admin, reincarnate, processNext, readRequest, requestBytes } =
    await makeHarness(t);
  const settled = admin.rollback('r-11:0-0');
  const record = await processNext();
  t.is(record.configFingerprint, null, 'a rollback binds no config content');
  t.like(await settled, {
    ok: true,
    phase: 'ok',
    id: 'r-11:0-0',
    action: 'rollback',
  });
  t.is((await readRequest()).configFingerprint, null);

  const bytesBefore = await requestBytes();
  const revived = await reincarnate();
  const again = await revived.rollback('r-11:0-0');
  t.like(again, { ok: true, phase: 'ok', id: 'r-11:0-0', action: 'rollback' });
  t.is(await requestBytes(), bytesBefore, 'no second spool submission');
});

test('a settled rollback left in the slot is validated, not clobbered', async t => {
  // The next operation must accept the null-fingerprint rollback occupying
  // the slot as well-formed and settled, rather than reading it as the
  // malformed request that would freeze the spool.
  const { admin, processNext, readRequest } = await makeHarness(t);
  const rolledBack = admin.rollback('r-11:1-0');
  await processNext();
  t.true((await rolledBack).ok);

  const built = admin.build('after the rollback', 'r-11:1-1');
  const next = await processNext();
  t.is(next.id, 'r-11:1-1');
  t.true((await built).ok);
  t.regex((await readRequest()).configFingerprint, /^[0-9a-f]{64}$/);
});

test('a rollback outcome may not claim a configuration fingerprint', async t => {
  const { admin, nextRequest, outcomesDir } = await makeHarness(t);
  const settled = admin.rollback('r-11:2-0');
  const request = await nextRequest();
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId(request.id)}.json`),
    JSON.stringify({
      ...request,
      configFingerprint: '0'.repeat(64),
      phase: 'ok',
    }),
  );
  await t.throwsAsync(() => settled, { message: /configFingerprint/ });
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
    { path: 'existing.nix', text: 'before\n', createdDirectories: [] },
    {
      path: 'modules/new.nix',
      text: null,
      createdDirectories: ['modules'],
    },
  ]);
  t.is(await readFile(join(configDir, 'existing.nix'), 'utf8'), 'after\n');
  t.is(await readFile(join(configDir, 'modules/new.nix'), 'utf8'), 'created\n');

  await admin.revertFiles(staged.previous, 'r-6:1-0');
  t.is(await readFile(join(configDir, 'existing.nix'), 'utf8'), 'before\n');
  await t.throwsAsync(() => readFile(join(configDir, 'modules/new.nix')), {
    code: 'ENOENT',
  });
  await t.throwsAsync(() => readFile(join(configDir, 'modules')), {
    code: 'ENOENT',
  });
});

test('writeFile reports UTF-8 bytes rather than UTF-16 code units', async t => {
  const { admin } = await makeHarness(t);
  t.deepEqual(await admin.writeFile('unicode.nix', 'é'), {
    path: 'unicode.nix',
    bytes: 2,
  });
});

test('listFiles propagates a missing requested subtree', async t => {
  const { admin } = await makeHarness(t);
  await t.throwsAsync(() => admin.listFiles('missing'), { code: 'ENOENT' });
});

test('a failed stage restores files and newly created directories', async t => {
  const { admin, configDir } = await makeHarness(t);
  await t.throwsAsync(
    () =>
      admin.stageFiles(
        harden([
          { path: 'new/child.nix', text: 'created before failure\n' },
          { path: 'new', text: 'cannot replace a directory\n' },
        ]),
        'r-6:2-0',
      ),
    { message: /written prefix was restored/ },
  );
  await t.throwsAsync(() => readFile(join(configDir, 'new')), {
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

test('a consuming applier: re-dispatch attaches via the status echo, never re-submits', async t => {
  // The health-check window: the applier consumed apply-request.json and
  // echoes our id in status while the switch (and our own restart) is in
  // flight. A re-dispatch arriving in this window must watch, not write —
  // writing would queue a SECOND switch behind the one being health-checked.
  const { admin, reincarnate, pickUpAndConsume, recordOutcome, requestBytes } =
    await makeHarness(t);
  const first = admin.apply('deploy', 'r-7:1-0');
  const request = await pickUpAndConsume();
  t.is(request.id, 'r-7:1-0');
  t.is(await requestBytes(), undefined, 'the slot was consumed');

  const revived = await reincarnate();
  const second = revived.apply('deploy', 'r-7:1-0');
  await delay(100);
  t.is(await requestBytes(), undefined, 'no re-submission into the slot');

  await recordOutcome(request);
  const [a, b] = await Promise.all([first, second]);
  t.true(a.ok);
  t.true(b.ok);
});

test('a foreign pending request is slot-busy, not clobbered', async t => {
  // A previous incarnation submitted an operation the applier has not
  // picked up yet. A new incarnation's different operation must wait for
  // its outcome instead of overwriting the slot — the overwrite would
  // destroy a possibly-approved apply and later misreport it as
  // superseded.
  const { admin, processNext, readRequest, spoolDir, protocolFingerprint } =
    await makeHarness(t);
  const configFingerprint = '0'.repeat(64);
  const message = 'earlier';
  await mkdir(spoolDir, { recursive: true });
  await writeFile(
    join(spoolDir, 'apply-request.json'),
    JSON.stringify({
      action: 'switch',
      message,
      id: 'earlier-op',
      fingerprint: fingerprintFor(
        'switch',
        message,
        configFingerprint,
        protocolFingerprint,
      ),
      configFingerprint,
      protocolFingerprint,
      nonce: 'x1',
    }),
    'utf8',
  );
  const settled = admin.build('mine', 'r-8:0-0');
  await delay(80);
  t.is((await readRequest()).id, 'earlier-op', 'the busy slot is untouched');
  const earlier = await processNext();
  t.is(earlier.id, 'earlier-op');
  const mine = await processNext();
  t.is(mine.id, 'r-8:0-0');
  t.true((await settled).ok);
});

test('a foreign operation in flight is slot-busy even once its request is gone', async t => {
  // The companion of "a foreign pending request is slot-busy". PROTOCOL.md
  // lets the service consume apply-request.json once its status echoes the
  // id, so between that consumption and the terminal record the ONLY evidence
  // that the machine is mid-switch is the status file. Reading the empty slot
  // as a free one publishes a second operation on top of a switch that is
  // still being health-checked — and if that switch fails and auto-rolls
  // back, the queued one activates over the rollback.
  //
  // The in-process queue does not cover this: the switch under way is exactly
  // what restarts the daemon, so the next operation arrives from a revived
  // caplet whose queue is empty and whose only evidence is on disk.
  const {
    admin,
    reincarnate,
    pickUpAndConsume,
    recordOutcome,
    requestBytes,
    processNext,
  } = await makeHarness(t);
  const first = admin.apply('the operation in flight', 'r-13:0-0');
  const inFlight = await pickUpAndConsume();
  t.is(await requestBytes(), undefined, 'the applier consumed the slot');

  const revived = await reincarnate();
  const second = revived.build('mine', 'r-13:0-1');
  // Sample rather than take one late reading: a single check can pass merely
  // by arriving before the submission it was meant to catch.
  let published;
  for (
    let attempt = 0;
    attempt < 100 && published === undefined;
    attempt += 1
  ) {
    // eslint-disable-next-line no-await-in-loop
    published = await requestBytes();
    // eslint-disable-next-line no-await-in-loop
    await delay(10);
  }
  t.is(published, undefined, 'nothing was published while the switch was live');

  await recordOutcome(inFlight);
  t.true((await first).ok);
  const mine = await processNext();
  t.is(mine.id, 'r-13:0-1', 'ours goes in once the slot is really free');
  t.true((await second).ok);
});

test('a request from another host configuration says so', async t => {
  // Reconfiguring the flake host, checkout, or lock namespace leaves a
  // well-formed request bound to the previous marker. That is a reconfigured
  // host, not a corrupt spool, and the operator's next move differs.
  const { admin, requestBytes, spoolDir } = await makeHarness(t);
  const stale = '0'.repeat(64);
  const message = 'from the previous binding';
  await writeFile(
    join(spoolDir, 'apply-request.json'),
    JSON.stringify({
      action: 'switch',
      message,
      id: 'before-the-move',
      fingerprint: fingerprintFor('switch', message, stale, stale),
      configFingerprint: stale,
      protocolFingerprint: stale,
      nonce: 'n1',
    }),
    'utf8',
  );
  const before = await requestBytes();

  await t.throwsAsync(() => admin.build('mine', 'r-13:1-0'), {
    message: /another host configuration/,
  });
  t.is(await requestBytes(), before, 'the foreign request is left in place');
});

test('an unreadable file at a submit decision refuses, never submits', async t => {
  // "Cannot read" must not be conflated with "does not exist": converting
  // an I/O error into absence at a submit decision was the one reviewed
  // path to a re-submission loop. A directory squatting on the outcome
  // path gives a persistent non-ENOENT read error.
  const { admin, requestBytes, outcomesDir } = await makeHarness(t);
  await mkdir(join(outcomesDir, `${sanitizeId('r-9:0-0')}.json`), {
    recursive: true,
  });
  await t.throwsAsync(() => admin.build('note', 'r-9:0-0'), {
    message: /Refusing to decide/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('an outcome record for a colliding sanitized name fails loud', async t => {
  // sanitizeId is not injective; the record's embedded raw id is the
  // authority. Settling from another operation's record could skip a
  // needed apply while reporting the old one's success.
  const { admin, requestBytes, outcomesDir } = await makeHarness(t);
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId('r-10:0-0')}.json`),
    JSON.stringify({ id: 'r-10_0-0', phase: 'ok' }),
    'utf8',
  );
  await t.throwsAsync(() => admin.apply('m', 'r-10:0-0'), {
    message: /collision/,
  });
  t.is(await requestBytes(), undefined, 'nothing was submitted');
});

test('a colliding foreign outcome never frees its pending slot', async t => {
  const { admin, requestBytes, spoolDir, outcomesDir, protocolFingerprint } =
    await makeHarness(t);
  const configFingerprint = '0'.repeat(64);
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(spoolDir, 'apply-request.json'),
    JSON.stringify({
      action: 'build',
      message: '',
      id: 'a:b',
      fingerprint: fingerprintFor(
        'build',
        '',
        configFingerprint,
        protocolFingerprint,
      ),
      configFingerprint,
      protocolFingerprint,
      nonce: 'old',
    }),
  );
  await writeFile(
    join(outcomesDir, `${sanitizeId('a:b')}.json`),
    JSON.stringify({ id: 'a_b', phase: 'ok' }),
  );
  const bytesBefore = await requestBytes();

  await t.throwsAsync(() => admin.build('mine', 'r-10:1-0'), {
    message: /collision/,
  });
  t.is(await requestBytes(), bytesBefore, 'the foreign request remains');
});

test('config symlinks cannot escape the checkout', async t => {
  const { admin, configDir } = await makeHarness(t);
  const outsideDir = join(configDir, '..', 'outside');
  await mkdir(outsideDir);
  await symlink(outsideDir, join(configDir, 'escape'));

  await t.throwsAsync(() => admin.writeFile('escape/pwned', 'bad'), {
    message: /Refusing to follow config symlink/,
  });
  await t.throwsAsync(() => readFile(join(outsideDir, 'pwned')), {
    code: 'ENOENT',
  });

  const outsideRev = join(outsideDir, 'endo.rev');
  await writeFile(outsideRev, `${REV}\n`);
  await symlink(outsideRev, join(configDir, 'endo.rev'));
  await t.throwsAsync(() => admin.stageRev(REV.replace(/^f/, '0')), {
    message: /Refusing to follow config symlink/,
  });
  t.is(await readFile(outsideRev, 'utf8'), `${REV}\n`);
});

test('an id-less status appearing mid-watch errs after the grace, without rewriting', async t => {
  const { admin, requestBytes, statusPath, spoolDir } = await makeHarness(t);
  const settled = admin.apply('deploy', 'r-11:0-0');
  for (let i = 0; i < 500; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await requestBytes()) !== undefined) break;
    // eslint-disable-next-line no-await-in-loop
    await delay(5);
  }
  const bytesBefore = await requestBytes();
  await mkdir(spoolDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify({ phase: 'ok' }), 'utf8');
  await t.throwsAsync(() => settled, {
    message: /does not echo request ids/,
  });
  t.is(await requestBytes(), bytesBefore, 'the request was never rewritten');
});

test('malformed status during a watch fails decisively without rewriting', async t => {
  const { admin, requestBytes, statusPath } = await makeHarness(t);
  const settled = admin.build('diagnose malformed status', 'r-11:1-0');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await requestBytes()) !== undefined) break;
    // eslint-disable-next-line no-await-in-loop
    await delay(5);
  }
  const bytesBefore = await requestBytes();
  await writeFile(statusPath, '{not json', 'utf8');
  await t.throwsAsync(() => settled, { message: /Refusing to decide/ });
  t.is(await requestBytes(), bytesBefore, 'the request was never rewritten');
});

test('a nonterminal outcome is rejected as malformed', async t => {
  const { admin, readRequest, outcomesDir } = await makeHarness(t);
  const settled = admin.build('validate phase', 'r-11:2-0');
  let request;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      request = await readRequest();
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
  }
  await mkdir(outcomesDir, { recursive: true });
  await writeFile(
    join(outcomesDir, `${sanitizeId(request.id)}.json`),
    JSON.stringify({
      id: request.id,
      action: request.action,
      fingerprint: request.fingerprint,
      protocolFingerprint: request.protocolFingerprint,
      phase: 'switching',
    }),
  );
  await t.throwsAsync(() => settled, { message: /Malformed outcome/ });
});

test('stageFiles refuses when a previous capture is unreadable', async t => {
  // An existing-but-unreadable file must refuse the whole stage: capturing
  // it as text:null would make a later revert DELETE it.
  const { admin, configDir } = await makeHarness(t);
  await mkdir(join(configDir, 'adir.nix'));
  await t.throwsAsync(
    () =>
      admin.stageFiles(
        harden([
          { path: 'adir.nix', text: 'x' },
          { path: 'other.nix', text: 'y' },
        ]),
        'r-12:0-0',
      ),
    { message: /refusing to stage/ },
  );
  await t.throwsAsync(() => readFile(join(configDir, 'other.nix')), {
    code: 'ENOENT',
  });
});
