import test from '@endo/ses-ava/prepare-endo.js';

import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import {
  deriveKeyFromPassphrase,
  getRandomValues,
  makeAesGcmCipher,
  makeNodeOAuthCryptoPowers,
  sha256,
} from '../providers/oauth/node-crypto.js';

const key32 = deriveKeyFromPassphrase(
  'correct horse battery staple',
  bytesFromText('salt-value'),
);

test('makeNodeOAuthCryptoPowers exposes sha256 and getRandomValues', t => {
  const powers = makeNodeOAuthCryptoPowers();
  t.is(typeof powers.sha256, 'function');
  t.is(typeof powers.getRandomValues, 'function');
  t.is(powers.sha256, sha256);
});

test('AES-256-GCM cipher round-trips a message', t => {
  const cipher = makeAesGcmCipher(key32);
  const plaintext = bytesFromText('the quick brown fox');
  const sealed = cipher.encrypt(plaintext);
  t.deepEqual(cipher.decrypt(sealed), plaintext);
});

test('AES-256-GCM uses a fresh IV per encryption (distinct ciphertexts)', t => {
  const cipher = makeAesGcmCipher(key32);
  const plaintext = bytesFromText('same message');
  const a = cipher.encrypt(plaintext);
  const b = cipher.encrypt(plaintext);
  t.notDeepEqual(a, b);
  // Both still decrypt back to the same plaintext.
  t.deepEqual(cipher.decrypt(a), plaintext);
  t.deepEqual(cipher.decrypt(b), plaintext);
});

test('AES-256-GCM rejects a tampered ciphertext (auth tag)', t => {
  const cipher = makeAesGcmCipher(key32);
  const sealed = cipher.encrypt(bytesFromText('authentic'));
  const tampered = new Uint8Array(sealed);
  const last = tampered.length - 1;
  tampered[last] = (tampered[last] + 1) % 256;
  t.throws(() => cipher.decrypt(tampered));
});

test('AES-256-GCM rejects decryption under the wrong key', t => {
  const cipher = makeAesGcmCipher(key32);
  const sealed = cipher.encrypt(bytesFromText('secret'));
  const otherKey = deriveKeyFromPassphrase(
    'a different passphrase',
    bytesFromText('salt-value'),
  );
  const otherCipher = makeAesGcmCipher(otherKey);
  t.throws(() => otherCipher.decrypt(sealed));
});

test('makeAesGcmCipher requires a 32-byte key', t => {
  t.throws(() => makeAesGcmCipher(new Uint8Array(16)), {
    message: /32-byte key/u,
  });
});

test('deriveKeyFromPassphrase is deterministic and 32 bytes', t => {
  const salt = bytesFromText('salt-value');
  const a = deriveKeyFromPassphrase('pw', salt);
  const b = deriveKeyFromPassphrase('pw', salt);
  t.is(a.length, 32);
  t.deepEqual(a, b);
});

test('deriveKeyFromPassphrase diverges on passphrase or salt', t => {
  const salt = bytesFromText('salt-value');
  const base = deriveKeyFromPassphrase('pw', salt);
  t.notDeepEqual(base, deriveKeyFromPassphrase('pw2', salt));
  t.notDeepEqual(base, deriveKeyFromPassphrase('pw', bytesFromText('other')));
});

test('getRandomValues fills the buffer it is given', t => {
  const buf = new Uint8Array(16);
  const returned = getRandomValues(buf);
  t.is(returned, buf);
  // Overwhelmingly unlikely to remain all-zero after a real fill.
  t.true(buf.some(byte => byte !== 0));
});

test('sha256 of a known input has the expected digest', t => {
  // SHA-256("abc") well-known vector.
  const digest = sha256(bytesFromText('abc'));
  const hex = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  t.is(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // bytesToText is exercised indirectly to keep the import load-bearing.
  t.is(typeof bytesToText, 'function');
});
