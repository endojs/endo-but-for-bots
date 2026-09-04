// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  makeCryptoPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeEncryptedFileSecretBackend } from '../src/secret-backend.js';

test('local backend encrypts, atomically replaces, and revokes bytes', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-'));
  t.teardown(() => rm(temporary, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  const cryptoPowers = makeCryptoPowers(crypto);
  const key = new Uint8Array(crypto.randomBytes(32));
  const backend = makeEncryptedFileSecretBackend({
    storagePath: temporary,
    filePowers,
    cryptoPowers,
    key,
  });
  const canary = new TextEncoder().encode('CANARY-backend-plaintext');
  const backendRef = await backend.create('op-create', 'secret-id', canary);
  const envelope = await readFile(path.join(temporary, backendRef));
  t.false(envelope.includes(canary));
  t.deepEqual(await backend.read(backendRef), canary);

  envelope[envelope.length - 1] = envelope[envelope.length - 1] === 0 ? 1 : 0;
  await writeFile(path.join(temporary, backendRef), envelope);
  await t.throwsAsync(() => backend.read(backendRef), { instanceOf: Error });

  const replacement = new TextEncoder().encode('replacement');
  await backend.replace('op-replace', backendRef, replacement);
  t.deepEqual(await backend.read(backendRef), replacement);
  t.deepEqual(
    (await fs.promises.readdir(temporary)).filter(name =>
      name.endsWith('.tmp'),
    ),
    [],
  );

  await backend.revoke('op-revoke', backendRef);
  await t.throwsAsync(() => backend.read(backendRef));
});

test('the envelope minimum and an empty secret are both handled', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-min-'));
  t.teardown(() => rm(temporary, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  const cryptoPowers = makeCryptoPowers(crypto);
  const key = new Uint8Array(crypto.randomBytes(32));
  const backend = makeEncryptedFileSecretBackend({
    storagePath: temporary,
    filePowers,
    cryptoPowers,
    key,
  });

  // A zero-length secret still seals to a full envelope: 12-byte nonce plus
  // 16-byte tag, the 28-byte floor `openSecret` enforces.
  const empty = new Uint8Array(0);
  const backendRef = await backend.create('op-create', 'empty-id', empty);
  const envelope = await readFile(path.join(temporary, backendRef));
  t.is(envelope.length, 28);
  t.deepEqual(await backend.read(backendRef), empty);

  // One byte short of the floor is refused before any decryption is attempted.
  await writeFile(path.join(temporary, backendRef), envelope.subarray(0, 27));
  await t.throwsAsync(() => backend.read(backendRef), {
    message: /Invalid secret envelope/,
  });
});

test('revoking twice succeeds, as delete depends on', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-rev-'));
  t.teardown(() => rm(temporary, { recursive: true, force: true }));
  const backend = makeEncryptedFileSecretBackend({
    storagePath: temporary,
    filePowers: makeFilePowers({ fs, path }),
    cryptoPowers: makeCryptoPowers(crypto),
    key: new Uint8Array(crypto.randomBytes(32)),
  });
  const backendRef = await backend.create(
    'op-create',
    'twice-id',
    new TextEncoder().encode('value'),
  );

  await backend.revoke('op-revoke-1', backendRef);
  // `SecretAdmin.delete` retries revocation, so a second call must not throw.
  await t.notThrowsAsync(() => backend.revoke('op-revoke-2', backendRef));
  await t.notThrowsAsync(() => backend.revoke('op-revoke-3', 'never-existed'));
});
