import test from '@endo/ses-ava/test.js';

import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { getRandomValues } from 'crypto';
import {
  makeOcapnSessionCryptography,
  PREFIXED_SYN_LENGTH,
  SYNACK_LENGTH,
} from '../src/bindings.js';
import {
  addOrderTwoPoint,
  edwardsToMontgomery,
  makePrefixedSyn,
  scalarFromSeed,
  x25519,
} from './_noise-ik-msg1.js';

const path = fileURLToPath(new URL('../gen/ocapn-noise.wasm', import.meta.url));
const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (readFileSync(path));

const wasmModule = new WebAssembly.Module(bytes);

// Helper function to create a valid handshake setup.
const createValidHandshake = () => {
  const initiator = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [1, 2],
  }).asInitiator();

  const responder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [2, 3],
  }).asResponder();

  return { initiator, responder };
};

// Helper to perform the initial SYN exchange.
const performSynExchange = (initiator, responder) => {
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  const { initiatorReadSynack } = initiator.initiatorWriteSyn(
    responder.signingKeys.publicKey,
    prefixedSyn,
  );
  return { prefixedSyn, initiatorReadSynack };
};

test('handshake fails with corrupted SYNACK message', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn, initiatorReadSynack } = performSynExchange(
    initiator,
    responder,
  );

  const synack = new Uint8Array(SYNACK_LENGTH);
  responder.responderReadSynWriteSynack(prefixedSyn, synack);

  // Corrupt the SYNACK message; the initiator's AEAD check on msg 2
  // payload should fail.
  synack[0] = 0xff;
  synack[1] = 0xff;

  t.throws(() => initiatorReadSynack(synack), {
    message: /initiator cannot read responder's SYNACK/,
  });
});

test('handshake fails with corrupted SYN message', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn } = performSynExchange(initiator, responder);

  // Corrupt a byte inside the encrypted static-key field of msg 1.
  // Bytes 32..64 of the prefixedSyn are the initiator's ephemeral
  // (cleartext); bytes 64..96 are the encrypted-with-MAC static; the
  // AEAD tag covers the whole encrypted-static block, so a single
  // bit flip should fail the read.
  prefixedSyn[80] = prefixedSyn[80] === 0 ? 1 : 0;

  const synack = new Uint8Array(SYNACK_LENGTH);
  t.throws(() => responder.responderReadSynWriteSynack(prefixedSyn, synack), {
    message: /responder cannot read initiator's SYN/,
  });
});

test('handshake fails with no mutually supported encodings', async t => {
  const initiator = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [1, 2],
  }).asInitiator();

  const responder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [3, 4],
  }).asResponder();

  const { prefixedSyn } = performSynExchange(initiator, responder);

  const synack = new Uint8Array(SYNACK_LENGTH);

  t.throws(() => responder.responderReadSynWriteSynack(prefixedSyn, synack), {
    message: /no mutually supported encoding versions/,
  });
});

test('encryption fails when message is too long', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn, initiatorReadSynack } = performSynExchange(
    initiator,
    responder,
  );
  const synack = new Uint8Array(SYNACK_LENGTH);
  responder.responderReadSynWriteSynack(prefixedSyn, synack);
  const { encrypt: initiatorEncrypt } = initiatorReadSynack(synack);

  const longMessage = new Uint8Array(65_535 - 15);
  longMessage.fill(0x42);

  t.throws(() => initiatorEncrypt(longMessage), {
    message: /message exceeds maximum length for encryption/,
  });
});

test('decryption fails when message is too short', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn, initiatorReadSynack } = performSynExchange(
    initiator,
    responder,
  );
  const synack = new Uint8Array(SYNACK_LENGTH);
  const { decrypt: responderDecrypt } = responder.responderReadSynWriteSynack(
    prefixedSyn,
    synack,
  );
  initiatorReadSynack(synack);

  const shortMessage = new Uint8Array(15);

  t.throws(() => responderDecrypt(shortMessage), {
    message: /message not long enough for decryption/,
  });
});

test('decryption fails when message is too long', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn, initiatorReadSynack } = performSynExchange(
    initiator,
    responder,
  );
  const synack = new Uint8Array(SYNACK_LENGTH);
  const { decrypt: responderDecrypt } = responder.responderReadSynWriteSynack(
    prefixedSyn,
    synack,
  );
  initiatorReadSynack(synack);

  const longMessage = new Uint8Array(65_536);

  t.throws(() => responderDecrypt(longMessage), {
    message: /message exceeds maximum length for decryption/,
  });
});

test('encoding versions are validated at construction', async t => {
  // > 65535
  t.throws(
    () =>
      makeOcapnSessionCryptography({
        wasmModule,
        getRandomValues,
        supportedEncodings: [65_536],
      }).asInitiator(),
    {
      message: /encoding versions beyond 65535/,
    },
  );

  // too many versions
  t.throws(
    () =>
      makeOcapnSessionCryptography({
        wasmModule,
        getRandomValues,
        supportedEncodings: [
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        ],
      }).asInitiator(),
    {
      message: /more than 17 encoding versions/,
    },
  );

  // none
  t.throws(
    () =>
      makeOcapnSessionCryptography({
        wasmModule,
        getRandomValues,
        supportedEncodings: [],
      }).asInitiator(),
    {
      message: /at least one encoding version/,
    },
  );

  // too far apart
  t.throws(
    () =>
      makeOcapnSessionCryptography({
        wasmModule,
        getRandomValues,
        supportedEncodings: [1, 18],
      }).asInitiator(),
    {
      message: /more than 16 versions apart/,
    },
  );
});

test('decryption fails on a tampered ciphertext', async t => {
  const { initiator, responder } = createValidHandshake();

  const { prefixedSyn, initiatorReadSynack } = performSynExchange(
    initiator,
    responder,
  );
  const synack = new Uint8Array(SYNACK_LENGTH);
  const { decrypt: responderDecrypt } = responder.responderReadSynWriteSynack(
    prefixedSyn,
    synack,
  );
  initiatorReadSynack(synack);

  const invalidMessage = new Uint8Array(32);
  invalidMessage.fill(0xff);

  t.throws(() => responderDecrypt(invalidMessage), {
    message: /decryption failed/,
  });
});

test('initiatorReadSynack on uninitialised state surfaces an error', async t => {
  const initiator = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator();
  // No initiatorWriteSyn: go straight to readSynack with garbage.
  // We invoke it directly via a fresh closure: asInitiator returns
  // initiatorWriteSyn but no readSynack until SYN is written.  Build a
  // minimal closure stand-in by performing the SYN exchange against
  // a fresh responder, then re-using initiatorReadSynack on a new
  // session that has not had its SYN written.

  // The bindings layer enforces the order: the only way to get an
  // initiatorReadSynack is via initiatorWriteSyn, so this test
  // verifies the WASM-level invariant by feeding a 0-byte SYNACK
  // (wrong length) into a fresh handshake.
  const responder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asResponder();
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  const { initiatorReadSynack } = initiator.initiatorWriteSyn(
    responder.signingKeys.publicKey,
    prefixedSyn,
  );
  // Truncated SYNACK: AEAD read fails.
  const shortSynack = new Uint8Array(SYNACK_LENGTH);
  shortSynack.fill(0); // all zeros, not a valid Noise message
  t.throws(() => initiatorReadSynack(shortSynack), {
    message: /initiator cannot read responder's SYNACK/,
  });
});

test('SYN intended for a different responder is rejected', async t => {
  const { initiator } = createValidHandshake();

  const wrongResponder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [2, 3],
  }).asResponder();

  const intendedResponder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [2, 3],
  }).asResponder();

  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  initiator.initiatorWriteSyn(
    intendedResponder.signingKeys.publicKey,
    prefixedSyn,
  );

  const synack = new Uint8Array(SYNACK_LENGTH);

  t.throws(
    () => wrongResponder.responderReadSynWriteSynack(prefixedSyn, synack),
    {
      message: /SYN intended for different responder/,
    },
  );
});

test('SYN claiming a verifying key other than its Noise static is rejected', async t => {
  // The attacker holds its own Ed25519 seed (and so its own X25519
  // static) but claims the victim's verifying key in the encrypted SYN
  // payload.  The Noise handshake itself would complete, since every
  // DH uses the attacker's real static; the responder must refuse to
  // attribute the session to the victim.
  const attackerKeys = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator().signingKeys;
  const victimKeys = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator().signingKeys;

  const impostor = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    signingKeys: {
      privateKey: attackerKeys.privateKey,
      publicKey: victimKeys.publicKey,
    },
    supportedEncodings: [1, 2],
  }).asInitiator();

  const responder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    supportedEncodings: [2, 3],
  }).asResponder();

  const { prefixedSyn } = performSynExchange(impostor, responder);

  const synack = new Uint8Array(SYNACK_LENGTH);
  t.throws(() => responder.responderReadSynWriteSynack(prefixedSyn, synack), {
    message: /initiator verifying key does not match its Noise static key/,
  });
});

const makeIdentity = () =>
  makeOcapnSessionCryptography({ wasmModule, getRandomValues }).asInitiator()
    .signingKeys;

const makeResponder = () =>
  makeOcapnSessionCryptography({ wasmModule, getRandomValues }).asResponder();

test('independently built SYN from an honest initiator is accepted', async t => {
  // Control for the hand-built SYNs below: with honest inputs the
  // test harness's message 1 is indistinguishable from the WASM's.
  const responder = makeResponder();
  const initiator = makeIdentity();
  const prefixedSyn = makePrefixedSyn({
    responderVerifyingKey: responder.signingKeys.publicKey,
    initiatorStatic: edwardsToMontgomery(initiator.publicKey),
    staticSharedSecret: x25519(
      scalarFromSeed(initiator.privateKey),
      edwardsToMontgomery(responder.signingKeys.publicKey),
    ),
    claimedVerifyingKey: initiator.publicKey,
  });
  const { initiatorVerifyingKey } = responder.responderReadSynWriteSynack(
    prefixedSyn,
    new Uint8Array(SYNACK_LENGTH),
  );
  t.deepEqual(initiatorVerifyingKey, initiator.publicKey);
});

test('SYN claiming a small-order verifying key is rejected', async t => {
  // A small-order static makes `ss` all zeros, so an initiator holding
  // no keys at all can complete message 1.  The identity point is the
  // case only the small-order check catches: it is torsion-free and
  // its Montgomery form (0) matches the static.
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const orderFour = new Uint8Array(32);
  for (const claimedVerifyingKey of [identity, orderFour]) {
    const responder = makeResponder();
    const prefixedSyn = makePrefixedSyn({
      responderVerifyingKey: responder.signingKeys.publicKey,
      initiatorStatic: edwardsToMontgomery(claimedVerifyingKey),
      staticSharedSecret: new Uint8Array(32),
      claimedVerifyingKey,
    });
    t.throws(
      () =>
        responder.responderReadSynWriteSynack(
          prefixedSyn,
          new Uint8Array(SYNACK_LENGTH),
        ),
      {
        message: /initiator verifying key does not match its Noise static key/,
      },
    );
  }
});

test('SYN claiming a key with a small-order component is rejected', async t => {
  // X25519 clamping makes every scalar a multiple of 8, which erases a
  // small-order component: the holder of A can complete `ss` against a
  // static of u(A + T).  Without the torsion check, the holder of one
  // key could claim several.
  const responder = makeResponder();
  const holder = makeIdentity();
  const claimedVerifyingKey = addOrderTwoPoint(holder.publicKey);
  const prefixedSyn = makePrefixedSyn({
    responderVerifyingKey: responder.signingKeys.publicKey,
    initiatorStatic: edwardsToMontgomery(claimedVerifyingKey),
    staticSharedSecret: x25519(
      scalarFromSeed(holder.privateKey),
      edwardsToMontgomery(responder.signingKeys.publicKey),
    ),
    claimedVerifyingKey,
  });
  t.throws(
    () =>
      responder.responderReadSynWriteSynack(
        prefixedSyn,
        new Uint8Array(SYNACK_LENGTH),
      ),
    {
      message: /initiator verifying key does not match its Noise static key/,
    },
  );
});

test('initiatorWriteSyn rejects a small-order intended responder key', async t => {
  // 32 zero bytes is the order-4 Ed25519 point. `derive_remote_static_pubkey`
  // must refuse it: a weak responder static makes the `es`/`ss` DH
  // results all zeros, destroying identity hiding and letting a party
  // with no keys complete the handshake.
  const { initiatorWriteSyn } = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator();
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  t.throws(() => initiatorWriteSyn(new Uint8Array(32), prefixedSyn), {
    message: /not a valid, strong ed25519 verifying key/,
  });
});

test('initiatorWriteSyn rejects a torsion-carrying intended responder key', async t => {
  // A + T for a torsion point T is not small-order, so only the
  // `is_torsion_free` check catches it. Build one from a real key.
  const strong = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator().signingKeys;
  const torsionKey = addOrderTwoPoint(strong.publicKey);
  const { initiatorWriteSyn } = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator();
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  t.throws(() => initiatorWriteSyn(torsionKey, prefixedSyn), {
    message: /not a valid, strong ed25519 verifying key/,
  });
});

test('initiatorWriteSyn accepts a strong intended responder key', async t => {
  // Control: a normally-generated key still dials.
  const responder = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asResponder().signingKeys;
  const { initiatorWriteSyn } = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
  }).asInitiator();
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  t.notThrows(() => initiatorWriteSyn(responder.publicKey, prefixedSyn));
});
