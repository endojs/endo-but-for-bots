// @ts-check

import test from '@endo/ses-ava/test.js';

import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import { bytesFromText } from '@endo/bytes/from-string.js';
import harden from '@endo/harden';
import { makeCryptography, makeSessionId } from '../src/cryptography.js';
import { syrupCodec } from '../src/syrup/index.js';
import {
  makeHandoffGiveDescriptor,
  makeHandoffGiveSigEnvelope,
  makeHandoffReceiveDescriptor,
  makeHandoffReceiveSigEnvelope,
} from '../src/codecs/descriptors.js';

const {
  makeOcapnKeyPair,
  makeOcapnKeyPairFromPrivateKey,
  signLocation,
  signHandoffGive,
  signHandoffReceive,
  assertHandoffGiveSignatureValid,
  assertHandoffReceiveSignatureValid,
} = makeCryptography(syrupCodec);

/** @param {ArrayBufferLike | Uint8Array} bytes */
const toHex = bytes =>
  Array.from(
    bytes instanceof Uint8Array ? bytes : bytesFromImmutable(bytes),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');

const makeSessionKeys = () => {
  const key1 = makeOcapnKeyPair();
  const key2 = makeOcapnKeyPair();
  const sessionId = makeSessionId(key1.publicKey.id, key2.publicKey.id);
  return {
    key1,
    key2,
    sessionId,
  };
};

test('makeWithdrawGiftDescriptor', t => {
  const gifterExporterSession = makeSessionKeys(); // g2e
  const gifterReceiverSession = makeSessionKeys(); // g2r
  const exporterReceiverSession = makeSessionKeys(); // e2r
  // Gifter (g2e) registers the gift
  // Gifter (g2e) specifies the Receiver (g2r)
  // Receiver (g2r) specifies the Receiver (e2r)
  // Receiver (e2r) redeems the gift

  // The SignedGive is created in the gifter-exporter session.
  // It also uses the receiver's public key from the gifter-receiver session.
  const { key1: gifterKey, sessionId: gifterExporterSessionId } =
    gifterExporterSession;
  const { key2: receiverKey } = gifterReceiverSession;
  const handoffGiveDescriptor = makeHandoffGiveDescriptor(
    receiverKey.publicKey.descriptor,
    {
      type: 'ocapn-peer',
      designator: '127.0.0.1',
      transport: 'tcp',
      hints: false,
    },
    gifterExporterSessionId,
    gifterKey.publicKey.id,
    bytesToImmutable(bytesFromText('gift-id')),
  );
  const handoffGiveSignature = signHandoffGive(
    handoffGiveDescriptor,
    gifterKey,
  );
  const signedHandoffGive = makeHandoffGiveSigEnvelope(
    handoffGiveDescriptor,
    handoffGiveSignature,
  );

  t.notThrows(() =>
    assertHandoffGiveSignatureValid(
      signedHandoffGive.object,
      signedHandoffGive.signature,
      gifterKey.publicKey,
    ),
  );

  // The SignedReceive is created in the exporter-receiver session,
  // but signed by the receiver's key from the gifter-receiver session.
  // The receiver includes their public key from the exporter-receiver session,
  // to establish the chain of trust.
  {
    const {
      key2: receiverKeyForExporter,
      sessionId: exporterReceiverSessionId,
    } = exporterReceiverSession;
    const receiverPeerIdForExporter = receiverKeyForExporter.publicKey.id;
    const { key2: receiverKeyForGifter } = gifterReceiverSession;
    const handoffCount = 0n;
    const handoffReceive = makeHandoffReceiveDescriptor(
      signedHandoffGive,
      handoffCount,
      exporterReceiverSessionId,
      receiverPeerIdForExporter,
    );
    const handoffReceiveSignature = signHandoffReceive(
      handoffReceive,
      receiverKeyForGifter,
    );
    const signedHandoffReceive = makeHandoffReceiveSigEnvelope(
      handoffReceive,
      handoffReceiveSignature,
    );

    t.notThrows(() =>
      assertHandoffReceiveSignatureValid(
        signedHandoffReceive.object,
        signedHandoffReceive.signature,
        receiverKeyForGifter.publicKey,
      ),
    );
  }
});

test('makeOcapnKeyPair', t => {
  const key = makeOcapnKeyPair();
  t.is(key.publicKey.bytes.byteLength, 32);
  t.is(key.publicKey.id.byteLength, 32);
});

test('protocol domain constants match their wire goldens', t => {
  const peerIdOne = Uint8Array.from({ length: 32 }, (_, index) => index);
  const peerIdTwo = Uint8Array.from({ length: 32 }, (_, index) => 0xff - index);
  t.is(
    toHex(makeSessionId(peerIdOne.buffer, peerIdTwo.buffer)),
    '6e862c41ed70e923d1da2ac2544f64651812b57cd3f699d461b98b5011647477',
  );

  const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const keyPair = makeOcapnKeyPairFromPrivateKey(privateKey);
  /** @type {import('../src/codecs/components.js').OcapnLocation} */
  const location = harden({
    type: 'ocapn-peer',
    transport: 'tcp-test-only',
    designator: 'golden',
    hints: false,
  });
  const signature = signLocation(
    location,
    keyPair,
    Uint8Array.of(0xde, 0xad, 0xbe, 0xef).buffer,
  );
  t.is(
    toHex(signature.r),
    '610011d441793f1a210aa607cee4c70624a9878200cad05fb333340f53d65eb6',
  );
  t.is(
    toHex(signature.s),
    'dad39d603bf910537bb3d59d9df9b392c912c3d31ebf15317accef8838497000',
  );
});
