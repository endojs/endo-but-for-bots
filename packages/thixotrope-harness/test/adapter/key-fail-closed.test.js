// @ts-check
// The secrets wrapping key fails closed (Tokyo plan 4.2): a missing key is
// created only on a state's first run or by an explicit init; with any file
// sealed under a key present, a missing or unreadable key is a refusal that
// names the path and changes nothing. A key under `$CREDENTIALS_DIRECTORY`
// (systemd `LoadCredential=`) is only ever read.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { getuid } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeSignInStore,
  signInFile,
} from '../../resources/agent-host/impl/gateway/signin.js';
import {
  SECRETS_KEY_VARIABLE,
  findSecretsFiles,
  makeSecretStore,
} from '../../resources/agent-host/impl/secrets/store.js';
import {
  initWrappingKey,
  isCredentialPath,
  loadWrappingKey,
  makeWrappingKey,
  sealedStateFiles,
} from '../../resources/agent-host/impl/secrets/wrapping-key.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** A state directory and a key file beside it, under H/tmp. */
const makeDirs = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', 'keyfc-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const keyFile = join(root, 'keys', 'secrets.key');
  const env = { [SECRETS_KEY_VARIABLE]: keyFile };
  return {
    root,
    stateDir,
    keyFile,
    env,
    files: findSecretsFiles({ stateDir, env }),
    done: () => {
      // A test may leave a directory without write permission.
      try {
        chmodSync(join(root, 'creds'), 0o700);
      } catch {
        // absent
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** @param {ReturnType<typeof makeDirs>['files']} files */
const storeOf = files =>
  makeSecretStore({
    file: files.file,
    auditFile: files.auditFile,
    wrappingKey: makeWrappingKey({
      keyFile: files.keyFile,
      stateDir: files.stateDir,
      readOnly: files.keyReadOnly,
    }),
  });

test('a first run creates the key; the sealed files are the store, its audit and the sign-in file', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const key = await loadWrappingKey({
    keyFile: dirs.keyFile,
    stateDir: dirs.stateDir,
  });
  t.is(key.length, 32);
  t.deepEqual(readFileSync(dirs.keyFile), key);
  t.deepEqual(
    sealedStateFiles(dirs.stateDir).map(file => file.slice(dirs.root.length)),
    [
      '/state/agent-host/secrets.enc',
      '/state/agent-host/secrets-audit.log',
      '/state/agent-host/gateway/signin.enc',
    ],
  );
});

test('key file deleted while a store exists: refuses, names the path, store untouched, no key minted', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const first = storeOf(dirs.files);
  await first.create('k1', 'L', 'd');
  await first.replace('k1', 'not a real value');
  first.close();
  const sealed = readFileSync(dirs.files.file);
  const audit = readFileSync(dirs.files.auditFile);
  rmSync(dirs.keyFile);

  const second = storeOf(dirs.files);
  t.teardown(() => second.close());
  const error = await t.throwsAsync(second.ready(), {
    message:
      /secrets key file .* is missing, but .* already holds files sealed with a key \(agent-host\/secrets\.enc, agent-host\/secrets-audit\.log\); refusing to create a new key/,
  });
  t.true(error?.message.includes(dirs.keyFile), 'the refusal names the path');
  t.false(existsSync(dirs.keyFile), 'no new key');
  t.deepEqual(readdirSync(join(dirs.root, 'keys')), []);
  t.deepEqual(readFileSync(dirs.files.file), sealed, 'secrets.enc untouched');
  t.deepEqual(readFileSync(dirs.files.auditFile), audit, 'audit untouched');
  // Asking again is refused again (a failed load is not kept).
  await t.throwsAsync(second.ready(), { message: /refusing to create/ });
  t.false(existsSync(dirs.keyFile));
});

test('key file deleted while only signin.enc exists: a gateway bind refuses, signin.enc untouched', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const first = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await first.ensure();
  const file = signInFile(dirs.stateDir);
  const sealed = readFileSync(file);
  rmSync(dirs.keyFile);
  // The next bind makes a new store, which reads the key path again.
  const next = makeSignInStore({ stateDir: dirs.stateDir, env: dirs.env });
  await t.throwsAsync(next.ensure(), {
    message:
      /is missing, but .* \(agent-host\/gateway\/signin\.enc\); refusing/,
  });
  await t.throwsAsync(next.rotate(), { message: /refusing/ });
  t.false(existsSync(dirs.keyFile));
  t.deepEqual(readFileSync(file), sealed);
});

test('a missing key with no state directory to check is refused', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  await t.throwsAsync(makeWrappingKey({ keyFile: dirs.keyFile }).get(), {
    message: /is missing and no state directory shows this is a first run/,
  });
  t.false(existsSync(dirs.keyFile));
});

test('an unreadable key file is refused by path and never replaced', async t => {
  if (getuid?.() === 0) {
    t.pass('root reads any file');
    return;
  }
  const dirs = makeDirs();
  t.teardown(dirs.done);
  mkdirSync(join(dirs.root, 'keys'));
  writeFileSync(dirs.keyFile, Buffer.alloc(32, 3), { mode: 0o600 });
  chmodSync(dirs.keyFile, 0o000);
  const error = await t.throwsAsync(storeOf(dirs.files).ready(), {
    message: /cannot be read \(EACCES\); refusing to continue without it/,
  });
  t.true(error?.message.includes(dirs.keyFile));
  chmodSync(dirs.keyFile, 0o600);
  t.deepEqual(readFileSync(dirs.keyFile), Buffer.alloc(32, 3));
});

test('a key under CREDENTIALS_DIRECTORY is read-only: read when present, refused (never created) when missing', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const creds = join(dirs.root, 'creds');
  mkdirSync(creds);
  const keyFile = join(creds, 'wrapping-key');
  const env = { [SECRETS_KEY_VARIABLE]: keyFile, CREDENTIALS_DIRECTORY: creds };
  const files = findSecretsFiles({ stateDir: dirs.stateDir, env });
  t.true(files.keyReadOnly);
  t.false(isCredentialPath(dirs.keyFile, env));
  t.false(isCredentialPath(creds, env));
  t.false(isCredentialPath(keyFile, {}));

  // Missing (a fresh state): refused, nothing created.
  chmodSync(creds, 0o500);
  await t.throwsAsync(storeOf(files).ready(), {
    message:
      /is missing from the read-only credentials directory; check the unit's LoadCredential=/,
  });
  chmodSync(creds, 0o700);
  t.deepEqual(readdirSync(creds), []);
  t.false(existsSync(files.file));

  // Present as systemd leaves it (0400, read-only directory): it is read,
  // and a store and the sign-in file seal with it.
  writeFileSync(keyFile, Buffer.alloc(32, 5), { mode: 0o400 });
  chmodSync(creds, 0o500);
  const store = storeOf(files);
  t.teardown(() => store.close());
  await store.create('k1', 'L', 'd');
  const signIn = makeSignInStore({ stateDir: dirs.stateDir, env });
  await signIn.ensure();
  t.deepEqual(readdirSync(creds), ['wrapping-key']);
  t.deepEqual(readFileSync(keyFile), Buffer.alloc(32, 5));
  await t.throwsAsync(initWrappingKey({ ...files, readOnly: true }), {
    message: /read-only location/,
  });
});

test('a credential as systemd leaves it with an ACL (0440, root) is read; one readable by others is refused', async t => {
  // systemd >= 256 puts credentials on tmpfs, root-owned with an ACL for the
  // service user, so `stat` shows the ACL mask in the group bits
  // (`-r--r-----+`; seen on Tokyo's forgejo.service).
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const creds = join(dirs.root, 'creds');
  mkdirSync(creds);
  const keyFile = join(creds, 'wrapping-key');
  writeFileSync(keyFile, Buffer.alloc(32, 6), { mode: 0o440 });
  chmodSync(keyFile, 0o440);
  const env = { [SECRETS_KEY_VARIABLE]: keyFile, CREDENTIALS_DIRECTORY: creds };
  const files = findSecretsFiles({ stateDir: dirs.stateDir, env });
  t.true(files.keyReadOnly);
  const key = await loadWrappingKey({
    keyFile,
    stateDir: dirs.stateDir,
    readOnly: true,
  });
  t.deepEqual(key, Buffer.alloc(32, 6));
  chmodSync(keyFile, 0o444);
  await t.throwsAsync(
    loadWrappingKey({ keyFile, stateDir: dirs.stateDir, readOnly: true }),
    { message: /credential must not be readable by others/ },
  );
  // Outside a credentials directory the group bits still count.
  chmodSync(keyFile, 0o440);
  await t.throwsAsync(loadWrappingKey({ keyFile, stateDir: dirs.stateDir }), {
    message: /must not be readable by group or others/,
  });
});

test('initWrappingKey creates only a new key for a state with no sealed files', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  await initWrappingKey({ keyFile: dirs.keyFile, stateDir: dirs.stateDir });
  const key = readFileSync(dirs.keyFile);
  t.is(key.length, 32);
  await t.throwsAsync(
    initWrappingKey({ keyFile: dirs.keyFile, stateDir: dirs.stateDir }),
    { message: /already exists; refusing to replace it/ },
  );
  t.deepEqual(readFileSync(dirs.keyFile), key, 'never overwritten');

  const store = storeOf(dirs.files);
  await store.create('k1', 'L', 'd');
  store.close();
  const elsewhere = join(dirs.root, 'keys', 'other.key');
  await t.throwsAsync(
    initWrappingKey({ keyFile: elsewhere, stateDir: dirs.stateDir }),
    { message: /already holds files sealed with another key/ },
  );
  t.false(existsSync(elsewhere));
});
