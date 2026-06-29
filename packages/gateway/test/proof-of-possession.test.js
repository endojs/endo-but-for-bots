// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  NONCE_DOMAIN_SEPARATION_PREFIX,
  NONCE_BYTE_LENGTH,
  DEFAULT_NONCE_TTL_MS,
  hashNonceForSigning,
  constantTimeEqual,
  makeNonceRegistry,
} from '../index.js';
import {
  makeNodeCryptoPowers,
  generateNodeEd25519Keypair,
} from '../src/node-crypto-powers.js';

/**
 * Build a controllable clock backed by a mutable scalar. Tests
 * advance `now` to simulate elapsed time deterministically.
 *
 * @param {number} initial
 */
const makeFakeClock = initial => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
    set: value => {
      now = value;
    },
  });
};

test('NONCE_DOMAIN_SEPARATION_PREFIX is the documented literal', t => {
  // Regression: if this literal ever drifts, every captured
  // signature against the previous prefix becomes unverifiable
  // without an explicit upgrade story. The pin guards the
  // protocol-stability promise.
  t.is(NONCE_DOMAIN_SEPARATION_PREFIX, 'endo-gateway:registrar:nonce');
});

test('NONCE_BYTE_LENGTH is 32', t => {
  t.is(NONCE_BYTE_LENGTH, 32);
});

/**
 * Spread an ArrayBuffer or Uint8Array as a number array for
 * deep-equal comparisons. An immutable `ArrayBuffer` cannot back a
 * `Uint8Array` view directly, so we `slice(0)` first to obtain a
 * mutable copy.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 */
const spread = bytes =>
  bytes instanceof Uint8Array
    ? [...bytes]
    : [...new Uint8Array(bytes.slice(0))];

test('hashNonceForSigning produces a 32-byte digest', t => {
  const crypto = makeNodeCryptoPowers();
  const nonce = new Uint8Array(32).fill(0x11);
  const hash = hashNonceForSigning(nonce, crypto);
  t.is(hash.byteLength, 32);
});

test('hashNonceForSigning is deterministic', t => {
  const crypto = makeNodeCryptoPowers();
  const nonce = new Uint8Array(32).fill(0xaa);
  const hash1 = hashNonceForSigning(nonce, crypto);
  const hash2 = hashNonceForSigning(nonce, crypto);
  t.deepEqual(spread(hash1), spread(hash2));
});

test('hashNonceForSigning produces distinct hashes for distinct nonces', t => {
  const crypto = makeNodeCryptoPowers();
  const nonce1 = new Uint8Array(32).fill(0x11);
  const nonce2 = new Uint8Array(32).fill(0x22);
  const hash1 = hashNonceForSigning(nonce1, crypto);
  const hash2 = hashNonceForSigning(nonce2, crypto);
  t.notDeepEqual(spread(hash1), spread(hash2));
});

test('hashNonceForSigning incorporates the domain-separation prefix', t => {
  // Regression for the security property: a signature over the raw
  // nonce must not verify as a signature over the prefixed hash.
  // If the implementation ever drops the prefix, this assertion
  // fails because the raw-nonce SHA-256 differs from the
  // prefix+nonce SHA-256.
  const crypto = makeNodeCryptoPowers();
  const nonce = new Uint8Array(32).fill(0x33);
  const hashWith = hashNonceForSigning(nonce, crypto);
  // Compute the bare SHA-256 of the nonce (no prefix).
  const bareHash = crypto.sha256(nonce);
  t.notDeepEqual(spread(hashWith), spread(bareHash));
});

test('hashNonceForSigning rejects a wrong-length nonce', t => {
  const crypto = makeNodeCryptoPowers();
  t.throws(() => hashNonceForSigning(new Uint8Array(16), crypto), {
    message: /must be 32 bytes/,
  });
});

test('constantTimeEqual returns true for byte-equal arrays', t => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  t.true(constantTimeEqual(a, b));
});

test('constantTimeEqual returns false for byte-distinct arrays', t => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 4]);
  t.false(constantTimeEqual(a, b));
});

test('constantTimeEqual returns false for length-distinct arrays', t => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3, 4]);
  t.false(constantTimeEqual(a, b));
});

test('constantTimeEqual returns false for non-Uint8Array inputs', t => {
  t.false(
    constantTimeEqual(
      /** @type {any} */ ([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
    ),
  );
});

test('makeNonceRegistry requires crypto', t => {
  const clock = makeFakeClock(0);
  t.throws(
    () => makeNonceRegistry(/** @type {any} */ ({ crypto: undefined, clock })),
    { message: /requires a crypto power/ },
  );
});

test('makeNonceRegistry requires clock', t => {
  const crypto = makeNodeCryptoPowers();
  t.throws(
    () => makeNonceRegistry(/** @type {any} */ ({ crypto, clock: undefined })),
    { message: /requires a clock power/ },
  );
});

test('makeNonceRegistry rejects ttlMs <= 0', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  t.throws(() => makeNonceRegistry({ crypto, clock, ttlMs: 0 }), {
    message: /positive finite number/,
  });
});

test('issue returns a fresh 32-byte nonce', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(1_000_000);
  const reg = makeNonceRegistry({ crypto, clock });
  const issued = reg.issue();
  t.is(issued.nonce.byteLength, NONCE_BYTE_LENGTH);
  t.is(issued.hashedNonce.byteLength, 32);
  t.is(issued.issuedAt, 1_000_000);
  t.is(issued.expiresAt, 1_000_000 + DEFAULT_NONCE_TTL_MS);
});

test('issue mints distinct nonces on each call', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const a = reg.issue();
  const b = reg.issue();
  t.notDeepEqual(spread(a.nonce), spread(b.nonce));
});

test('verifyAndConsume accepts a valid signature once', async t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const kp = await generateNodeEd25519Keypair();
  const issued = reg.issue();
  const signature = kp.sign(issued.hashedNonce);
  t.notThrows(() =>
    reg.verifyAndConsume({
      publicKey: kp.publicKey,
      nonce: issued.nonce,
      signature,
    }),
  );
  t.is(reg.size(), 0);
});

test('verifyAndConsume rejects a second use (single-use nonce)', async t => {
  // Regression for the single-use property: if a nonce ever leaks
  // through and remains valid for a second submission, an
  // attacker who captures the first registration can replay it
  // any number of times.
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const kp = await generateNodeEd25519Keypair();
  const issued = reg.issue();
  const signature = kp.sign(issued.hashedNonce);
  reg.verifyAndConsume({
    publicKey: kp.publicKey,
    nonce: issued.nonce,
    signature,
  });
  t.throws(
    () =>
      reg.verifyAndConsume({
        publicKey: kp.publicKey,
        nonce: issued.nonce,
        signature,
      }),
    { message: /Unknown or already-consumed nonce/ },
  );
});

test('verifyAndConsume rejects an unknown nonce', async t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const kp = await generateNodeEd25519Keypair();
  const forged = new Uint8Array(NONCE_BYTE_LENGTH).fill(0x42);
  const signature = kp.sign(hashNonceForSigning(forged, crypto));
  t.throws(
    () =>
      reg.verifyAndConsume({
        publicKey: kp.publicKey,
        nonce: forged,
        signature,
      }),
    { message: /Unknown or already-consumed nonce/ },
  );
});

test('verifyAndConsume rejects an expired nonce', async t => {
  // Regression: if the TTL guard ever flips to <= vs >=, a stale
  // nonce gets accepted at the boundary.
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock, ttlMs: 1000 });
  const kp = await generateNodeEd25519Keypair();
  const issued = reg.issue();
  clock.advance(2000);
  const signature = kp.sign(issued.hashedNonce);
  t.throws(
    () =>
      reg.verifyAndConsume({
        publicKey: kp.publicKey,
        nonce: issued.nonce,
        signature,
      }),
    { message: /(has expired|Unknown or already-consumed)/ },
  );
});

test('verifyAndConsume rejects a signature under the wrong key', async t => {
  // Regression for the proof-of-possession property: if the
  // verifier ever short-circuits the signature check, an attacker
  // who can connect to the bootstrap socket can register a
  // public key they do not control.
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const alice = await generateNodeEd25519Keypair();
  const eve = await generateNodeEd25519Keypair();
  const issued = reg.issue();
  // Eve signs the challenge but claims Alice's public key.
  const signature = eve.sign(issued.hashedNonce);
  t.throws(
    () =>
      reg.verifyAndConsume({
        publicKey: alice.publicKey,
        nonce: issued.nonce,
        signature,
      }),
    { message: /Proof-of-possession signature does not verify/ },
  );
});

test('verifyAndConsume does not consume the nonce on a bad signature', async t => {
  // The nonce stays available so a legitimate registrant who
  // races with an attacker is not denied service.
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  const alice = await generateNodeEd25519Keypair();
  const eve = await generateNodeEd25519Keypair();
  const issued = reg.issue();
  // Eve forges a signature against Alice's key.
  const forged = eve.sign(issued.hashedNonce);
  t.throws(() =>
    reg.verifyAndConsume({
      publicKey: alice.publicKey,
      nonce: issued.nonce,
      signature: forged,
    }),
  );
  // The nonce should still be valid for the real Alice to consume.
  const realSignature = alice.sign(issued.hashedNonce);
  t.notThrows(() =>
    reg.verifyAndConsume({
      publicKey: alice.publicKey,
      nonce: issued.nonce,
      signature: realSignature,
    }),
  );
});

test('size reports outstanding nonces', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  t.is(reg.size(), 0);
  reg.issue();
  reg.issue();
  t.is(reg.size(), 2);
});

test('sweep prunes expired entries opportunistically on issue', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock, ttlMs: 1000 });
  reg.issue();
  reg.issue();
  t.is(reg.size(), 2);
  clock.advance(2000);
  // The next issue triggers a sweep before adding the new entry.
  reg.issue();
  t.is(reg.size(), 1);
});

test('verifyAndConsume rejects a wrong-length nonce on input', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  t.throws(
    () =>
      reg.verifyAndConsume({
        publicKey: new Uint8Array(32),
        nonce: new Uint8Array(16),
        signature: new Uint8Array(64),
      }),
    { message: /must be 32 bytes/ },
  );
});

test('verifyAndConsume rejects non-byte-shaped publicKey', t => {
  const crypto = makeNodeCryptoPowers();
  const clock = makeFakeClock(0);
  const reg = makeNonceRegistry({ crypto, clock });
  t.throws(
    () =>
      reg.verifyAndConsume(
        /** @type {any} */ ({
          publicKey: 'not-bytes',
          nonce: new Uint8Array(32),
          signature: new Uint8Array(64),
        }),
      ),
    { message: /publicKey must be an immutable ArrayBuffer or Uint8Array/ },
  );
});
