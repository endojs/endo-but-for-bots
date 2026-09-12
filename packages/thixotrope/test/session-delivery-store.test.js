// @ts-check
import test from '@endo/ses-ava/test.js';
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { writeOcapnHandshakeMessage } from '@endo/ocapn/operations';
import { decodeBase64, encodeBase64 } from '@endo/base64';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import { ExecutionContext } from 'ava' */

/**
 * @param {ExecutionContext} t
 * @param {string} [existingPath]
 * @param {(meta: Record<string, any>) => void} [observeSave]
 */
const setup = async (t, existingPath = undefined, observeSave = () => {}) => {
  const path = await (existingPath ??
    mkdtemp(join(tmpdir(), 'thix-delivery-store-')));
  if (existingPath === undefined)
    t.teardown(() => rm(path, { recursive: true, force: true }));
  /** @type {any} */
  let power;
  /** @type {any} */
  let capturedHandlers;
  /** @type {any} */
  let layer;
  const store = makeFsStore(nodePowers, path);
  const daemon = await makeThixotropeDaemon(nodePowers, {
    store: harden({
      ...store,
      provideSessionStore: sessionToken => {
        const sessionStore = store.provideSessionStore(sessionToken);
        return harden({
          ...sessionStore,
          setMeta: meta => {
            observeSave(meta);
            sessionStore.setMeta(meta);
          },
        });
      },
    }),
    engine: makePeerJournalReplayEngine(nodePowers),
    codec: syrupCodec,
    makeNetlayer: ({ resumption, handlers }) => {
      power = resumption;
      capturedHandlers = handlers;
      layer = {
        location: {
          type: 'ocapn-peer',
          transport: 'test',
          designator: 'test',
          hints: false,
        },
        shutdown() {},
        getResumeToken: () => token,
      };
      return layer;
    },
  });
  t.teardown(() => daemon.shutdown());
  return { power, path, handlers: capturedHandlers, layer, daemon };
};

const token = '0123456789abcdef0123456789abcdef';

test.serial(
  'remote acceptance retains payload independently of hub processing',
  async t => {
    const { power, path } = await setup(t);
    power.onHello(token);
    power.recordInbound(token, 1n, new Uint8Array([17]));
    const disk = makeFsStore(nodePowers, path)
      .provideSessionStore(token)
      .getMeta();
    t.is(disk.recvSeq, '1');
    t.is(disk.processedSeq, '0');
    t.deepEqual(power.loadForResume(token).inbox, [
      { n: '1', bytes: new Uint8Array([17]) },
    ]);
    power.recordInbound(token, 1n, new Uint8Array([17]));
    t.is(power.loadForResume(token).inbox.length, 1);
    power.recordProcessed(token, 1n);
    t.deepEqual(power.loadForResume(token).inbox, []);
    t.is(power.loadForResume(token).recvSeq, '1');
    t.throws(() => power.recordInbound(token, 3n, new Uint8Array()), {
      message: /sequence gap/,
    });
  },
);

test.serial(
  'sender acknowledgement preserves identity after releasing payload',
  async t => {
    const { power, path } = await setup(t);
    const location = { transport: 'test', designator: 'peer' };
    power.onHello(token, location);
    power.recordOutbound(token, 1n, new Uint8Array([42]), '9');
    t.throws(() => power.recordAck(token, 2n), { message: /exceeds issued/ });
    t.is(power.loadForResume(token).frames.length, 1);
    power.recordAck(token, 1n);
    const disk = makeFsStore(nodePowers, path)
      .provideSessionStore(token)
      .getMeta();
    t.is(disk.sendSeq, '1');
    t.is(disk.ackSeq, '1');
    t.is(disk.hubDelivery, '9');
    t.deepEqual(disk.frames, []);
    t.true(disk.isOriginator);
    t.deepEqual(disk.location, location);
    power.onEnd(token);
    t.true(power.loadForResume(token).retired);
    t.throws(() => power.onHello(token), { message: /already been used/ });
    t.true(
      makeFsStore(nodePowers, path).provideSessionStore(token).getMeta()
        .retired,
    );
  },
);

test.serial(
  'restart completes a handshake whose response was not yet accepted',
  async t => {
    let handshakeSaves = 0;
    const first = await setup(t, undefined, meta => {
      if (meta.handshakeResponse !== undefined) {
        handshakeSaves += 1;
        t.truthy(meta.identity, 'response and identity publish in one commit');
      }
    });
    first.power.onHello(token);
    const crypto = makeCryptography(syrupCodec);
    const keyPair = crypto.makeOcapnKeyPair();
    const location = {
      type: /** @type {const} */ ('ocapn-peer'),
      transport: 'test',
      designator: 'peer',
      hints: /** @type {const} */ (false),
    };
    const message = writeOcapnHandshakeMessage(
      {
        type: 'op:start-session',
        captpVersion: '1.0',
        sessionPublicKey: keyPair.publicKey.descriptor,
        location,
        locationSignature: crypto.signLocation(
          location,
          keyPair,
          new ArrayBuffer(0),
        ),
      },
      syrupCodec,
    );
    first.power.recordInbound(token, 1n, message);
    const connection = first.handlers.makeConnection(first.layer, false, {
      write() {
        throw Error('injected before response acceptance');
      },
      end() {},
    });
    t.throws(() => first.handlers.handleMessageData(connection, message, 1n), {
      message: /injected before response acceptance/,
    });
    const before = makeFsStore(nodePowers, first.path)
      .provideSessionStore(token)
      .getMeta();
    t.truthy(before.identity);
    t.truthy(before.handshakeResponse);
    t.is(before.sendSeq, '0');
    t.is(handshakeSaves, 1, 'one write establishes response and identity');
    t.falsy(
      before.retired,
      'storage interruption did not retire accepted work',
    );
    await first.daemon.shutdown();
    const second = await setup(t, first.path);
    /** @type {Uint8Array[]} */
    const writes = [];
    const restored = second.handlers.makeConnection(second.layer, false, {
      write(/** @type {Uint8Array} */ bytes) {
        writes.push(bytes);
        second.power.recordOutbound(token, BigInt(writes.length), bytes);
        return true;
      },
      end() {},
    });
    second.power.restoreSession(second.handlers, restored, token);
    t.deepEqual(writes[0], decodeBase64(before.handshakeResponse));
    second.handlers.handleMessageData(restored, message, 1n);
    second.power.recordProcessed(token, 1n);
    const after = makeFsStore(nodePowers, first.path)
      .provideSessionStore(token)
      .getMeta();
    t.deepEqual(after.identity, before.identity);
    t.is(after.processedSeq, '1');
    t.deepEqual(after.inbox, []);
    t.is(
      writes.length,
      1,
      'replayed initial frame did not create another handshake',
    );
  },
);

test.serial(
  'originator restores its pending handshake key and hub alias',
  async t => {
    const first = await setup(t);
    const crypto = makeCryptography(syrupCodec);
    const originator = crypto.makeOcapnKeyPairWithPrivateBytes();
    const peer = crypto.makeOcapnKeyPair();
    const location = {
      type: /** @type {const} */ ('ocapn-peer'),
      transport: 'test',
      designator: 'peer',
      hints: /** @type {const} */ (false),
    };
    first.power.onHello(token, location);
    const sessionStore = makeFsStore(
      nodePowers,
      first.path,
    ).provideSessionStore(token);
    const request = writeOcapnHandshakeMessage(
      {
        type: 'op:start-session',
        captpVersion: '1.0',
        sessionPublicKey: originator.keyPair.publicKey.descriptor,
        location,
        locationSignature: crypto.signLocation(
          location,
          originator.keyPair,
          new ArrayBuffer(0),
        ),
      },
      syrupCodec,
    );
    sessionStore.setMeta({
      ...sessionStore.getMeta(),
      hubSessionKey: 'handoff:restore-test',
      pendingPrivateKeyB64: encodeBase64(originator.privateKeyBytes),
      handshakeRequest: encodeBase64(request),
    });
    await first.daemon.shutdown();
    const second = await setup(t, first.path);
    /** @type {Uint8Array[]} */
    const writes = [];
    const connection = second.handlers.makeConnection(second.layer, true, {
      write(/** @type {Uint8Array} */ bytes) {
        writes.push(bytes);
        second.power.recordOutbound(token, BigInt(writes.length), bytes);
        return true;
      },
      end() {},
    });
    second.power.restoreSession(second.handlers, connection, token);
    t.deepEqual(writes[0], request);
    const response = writeOcapnHandshakeMessage(
      {
        type: 'op:start-session',
        captpVersion: '1.0',
        sessionPublicKey: peer.publicKey.descriptor,
        location,
        locationSignature: crypto.signLocation(
          location,
          peer,
          new ArrayBuffer(0),
        ),
      },
      syrupCodec,
    );
    second.power.recordInbound(token, 1n, response);
    second.handlers.handleMessageData(connection, response, 1n);
    second.power.recordProcessed(token, 1n);
    const saved = sessionStore.getMeta();
    t.is(saved.hubSessionKey, 'handoff:restore-test');
    t.is(
      saved.identity.selfPrivateKeyB64,
      encodeBase64(originator.privateKeyBytes),
    );
    t.is(
      saved.identity.peerPublicKeyQB64,
      encodeBase64(peer.publicKey.descriptor.q),
    );
    t.is(writes.length, 1);
    await second.daemon.shutdown();
    const third = await setup(t, first.path);
    const restored = third.handlers.makeConnection(third.layer, true, {
      write() {
        t.fail('established session must not restart its handshake');
      },
      end() {},
    });
    third.power.restoreSession(third.handlers, restored, token);
    t.deepEqual(sessionStore.getMeta().identity, saved.identity);
  },
);
