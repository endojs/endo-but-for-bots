// @ts-check
// M4 W4.4: kill points K-5 and K-6 (designs/m4-interfaces.md 10; D-M4-8).
// The renewal runs in a child process (_m4-renewal-kill-child.mjs) that is
// SIGKILLed after the write-ahead intent and before the POST (K-5), or
// after the token endpoint processed the refresh and before the write-back
// (K-6, the fake OAuth server holds its answer). A new incarnation over the
// same files then finds the member `CONSUMED`, and the token endpoint saw
// at most one refresh for that token. No supervisor; one child per test.
import '../unit/_m1a-prelude.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execPath } from 'node:process';
import url from 'node:url';

import test from '@endo/ses-ava/test.js';

import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { parseCredential } from '../../resources/agent-host/impl/subscriptions/credentials.js';
import { makeMemberCredential } from '../../resources/agent-host/impl/subscriptions/renewal.js';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import { grepState } from '../integration/_m2-secrets.js';
import {
  makeStoreDirs,
  openStore,
  seedCredential,
  storedCredential,
} from './_m4-renewal.js';

const CHILD = url.fileURLToPath(
  new URL('_m4-renewal-kill-child.mjs', import.meta.url),
);

/**
 * Run the child until it prints `line`, then SIGKILL it.
 * @param {string} jobFile
 * @param {string} line
 * @param {() => Promise<void>} [beforeKill]
 */
const runUntil = async (jobFile, line, beforeKill) => {
  const child = spawn(execPath, [CHILD, jobFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', chunk => {
    err += chunk;
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes(`${line}\n`)) resolve(undefined);
    });
    child.on('exit', code =>
      reject(Error(`child exited ${code} before ${line}: ${out} ${err}`)),
    );
  });
  if (beforeKill) await beforeKill();
  child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit');
  return { out, err };
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {'k5' | 'k6'} mode
 */
const killAt = async (t, mode) => {
  const dirs = makeStoreDirs(`w44-${mode}`);
  const server = await startFakeOAuthServer();
  t.teardown(async () => {
    await server.close();
    dirs.done();
  });
  const issued = server.issue();
  const seeding = openStore(dirs.files);
  await seedCredential(
    seeding,
    storedCredential({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAtMs: Date.now() + 1000,
    }),
  );
  seeding.close();
  const jobFile = join(dirs.root, 'job.json');
  await writeFile(
    jobFile,
    JSON.stringify({
      files: dirs.files,
      key: 'k1',
      provider: 'claude',
      tokenUrl: server.tokenUrl,
      mode,
    }),
  );
  let child;
  if (mode === 'k5') {
    child = await runUntil(jobFile, 'posting');
  } else {
    const held = server.hold();
    child = await runUntil(jobFile, 'started', () => held.arrived);
    held.release();
  }
  t.false(child.out.includes('renewed'));
  t.false(child.err.includes(issued.refreshToken), 'no token on stderr');

  // The next incarnation.
  const store = openStore(dirs.files);
  t.teardown(() => store.close());
  const { value } = await store.read('k1');
  t.truthy(parseCredential(value, 'claude').pendingRefresh, 'the intent');
  const member = makeMemberCredential({
    access: makeCredentialAccess({ store, key: 'k1' }),
    provider: 'claude',
    tokenUrl: server.tokenUrl,
    now: () => Date.now(),
  });
  const error = await t.throwsAsync(member.current());
  t.is(/** @type {any} */ (error).code, 'CONSUMED');
  return { server, issued, dirs };
};

test('K-5: killed after the intent, before the POST', async t => {
  const { server, issued, dirs } = await killAt(t, 'k5');
  t.is(server.presented(issued.serial), 0, 'the token never left');
  t.is(server.requests().length, 0);
  t.is((await grepState(dirs.stateDir, issued.refreshToken)).length, 0);
});

test('K-6: killed after the token endpoint answered, before the write-back', async t => {
  const { server, issued } = await killAt(t, 'k6');
  t.is(server.presented(issued.serial), 1, 'at most one refresh');
  t.is(server.requests().filter(r => r.replay).length, 0);
});
