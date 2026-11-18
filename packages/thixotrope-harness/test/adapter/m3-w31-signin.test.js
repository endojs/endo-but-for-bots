// @ts-check
// M3 W3.1: the gateway sign-in secret (designs/m3-interfaces.md 4.3, 7 K2,
// 8): `signin.enc` round trip and stability across store incarnations, the
// file encrypted at rest with the secrets wrapping key, digest comparison,
// rotation, and a SIGKILL inside the rotation (a real child process killing
// itself between the temporary write and the rename, and after the rename)
// leaving exactly one valid secret.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  makeSignInStore,
  signInFile,
  signInTexts,
} from '../../resources/agent-host/impl/gateway/signin.js';
import { SECRETS_KEY_VARIABLE } from '../../resources/agent-host/impl/secrets/store.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FRAGMENT = /^#gateway=127\.0\.0\.1:8920&agent=([0-9a-f]{64})$/;

/** A state directory and a key file outside it, under H/tmp. */
const makeDirs = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', 'w31s-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const keyFile = join(root, 'keys', 'secrets.key');
  return {
    root,
    stateDir,
    keyFile,
    env: { [SECRETS_KEY_VARIABLE]: keyFile },
  };
};

/** @param {ReturnType<typeof makeSignInStore>} store */
const secretOf = async store => {
  const match = FRAGMENT.exec(await store.fragment('127.0.0.1:8920'));
  if (!match) throw Error('fragment shape');
  return match[1];
};

test('ensure mints once; the secret is stable across incarnations', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const first = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  t.false(first.matches('0'.repeat(64)), 'nothing matches before ensure');
  await first.ensure();
  const file = signInFile(dirs.stateDir);
  t.is(
    file,
    join(resolve(dirs.stateDir), 'agent-host', 'gateway', 'signin.enc'),
  );
  t.true(existsSync(file));
  const secret = await secretOf(first);
  t.true(first.matches(secret));

  const second = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await second.ensure();
  t.is(await secretOf(second), secret, 'P-02: stable across restarts');
  t.true(second.matches(secret));
});

test('matches compares digests exactly', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const store = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await store.ensure();
  const secret = await secretOf(store);
  t.true(store.matches(secret));
  t.false(store.matches(secret.toUpperCase()));
  t.false(store.matches(`${secret}0`));
  t.false(store.matches(secret.slice(0, 63)));
  t.false(store.matches(` ${secret}`));
  t.false(store.matches(''));
  t.false(store.matches('x'.repeat(256)));
  t.false(store.matches(undefined));
  t.false(store.matches(42));
  t.false(store.matches({ toString: () => secret }));
});

test('the file is encrypted at rest, mode 0600, under the wrapping key', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const store = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await store.ensure();
  const secret = await secretOf(store);
  const bytes = readFileSync(signInFile(dirs.stateDir));
  t.false(bytes.toString('latin1').includes(secret));
  t.false(bytes.includes(Buffer.from(secret, 'hex')));
  // eslint-disable-next-line no-bitwise
  t.is(statSync(signInFile(dirs.stateDir)).mode & 0o077, 0);

  // Another wrapping key cannot read it; the error carries no bytes.
  const other = makeSignInStore({
    stateDir: dirs.stateDir,
    env: { [SECRETS_KEY_VARIABLE]: join(dirs.root, 'other', 'k.key') },
  });
  const error = await t.throwsAsync(() => other.ensure(), {
    message: signInTexts.unreadable,
  });
  t.false(String(error?.stack).includes(secret));
  t.false(other.matches(secret));
});

test('a wrapping key inside the state directory is refused', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const store = makeSignInStore({
    stateDir: dirs.stateDir,
    env: { [SECRETS_KEY_VARIABLE]: join(dirs.stateDir, 'k.key') },
  });
  await t.throwsAsync(() => store.ensure(), { message: /outside the state/ });
  t.false(existsSync(signInFile(dirs.stateDir)));
});

test('rotate replaces the secret; concurrent rotations serialize', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const store = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await store.ensure();
  const old = await secretOf(store);
  await store.rotate();
  const next = await secretOf(store);
  t.not(next, old);
  t.true(store.matches(next));
  t.false(store.matches(old));

  await Promise.all([store.rotate(), store.rotate(), store.rotate()]);
  const last = await secretOf(store);
  t.true(store.matches(last));
  const fresh = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await fresh.ensure();
  t.true(fresh.matches(last), 'the file holds the secret in memory');
  t.false(existsSync(`${signInFile(dirs.stateDir)}.tmp`));
});

const CHILD = `
import '@endo/init';
const [prelude, signin, stateDir, keyFile, killAt] = process.argv.slice(1);
const { installGuestPrelude } = await import(prelude);
installGuestPrelude();
const { makeSignInStore } = await import(signin);
const die = () => process.kill(process.pid, 'SIGKILL');
const store = makeSignInStore({
  stateDir,
  env: { THIX_HARNESS_SECRETS_KEY: keyFile },
  hooks: {
    afterTemp: killAt === 'afterTemp' ? die : undefined,
    afterRename: killAt === 'afterRename' ? die : undefined,
  },
});
await store.ensure();
await store.rotate();
process.stdout.write('rotated\\n');
`;

/**
 * Rotate in a child process that SIGKILLs itself at `killAt`.
 * @param {ReturnType<typeof makeDirs>} dirs
 * @param {string} killAt
 */
const rotateInChild = async (dirs, killAt) => {
  const child = spawn(
    execPath,
    [
      '--input-type=module',
      '-e',
      CHILD,
      pathToFileURL(join(harnessRoot, 'scripts', 'guest-prelude.js')).href,
      pathToFileURL(
        join(harnessRoot, 'resources/agent-host/impl/gateway/signin.js'),
      ).href,
      dirs.stateDir,
      dirs.keyFile,
      killAt,
    ],
    { cwd: harnessRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', d => {
    out += d;
  });
  child.stderr.on('data', d => {
    err += d;
  });
  const [code, signal] = await once(child, 'exit');
  return { code, signal, out, err };
};

test('K2: a SIGKILL inside rotateSignIn leaves exactly one valid secret', async t => {
  const dirs = makeDirs();
  t.teardown(() => rmSync(dirs.root, { recursive: true, force: true }));
  const store = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await store.ensure();
  const old = await secretOf(store);

  // Killed between the temporary write and the rename: the old secret.
  const a = await rotateInChild(dirs, 'afterTemp');
  t.is(a.signal, 'SIGKILL', a.err);
  t.true(
    existsSync(`${signInFile(dirs.stateDir)}.tmp`),
    'the crash left a temp file',
  );
  const afterTemp = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await afterTemp.ensure();
  t.false(existsSync(`${signInFile(dirs.stateDir)}.tmp`), 'ensure removes it');
  t.is(await secretOf(afterTemp), old);
  t.true(afterTemp.matches(old));

  // Killed after the rename, before the directory fsync: the new secret.
  const b = await rotateInChild(dirs, 'afterRename');
  t.is(b.signal, 'SIGKILL', b.err);
  const afterRename = makeSignInStore({
    stateDir: dirs.stateDir,
    env: dirs.env,
  });
  await afterRename.ensure();
  const next = await secretOf(afterRename);
  t.not(next, old);
  t.true(afterRename.matches(next));
  t.false(afterRename.matches(old));

  // Not killed: completes.
  const c = await rotateInChild(dirs, 'none');
  t.is(c.code, 0, c.err);
  t.is(c.out, 'rotated\n');
  const done = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await done.ensure();
  const last = await secretOf(done);
  t.not(last, next);
  t.true(done.matches(last));
  t.false(done.matches(next));
});
