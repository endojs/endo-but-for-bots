// @ts-check
import test from '@endo/ses-ava/test.js';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import {
  DescHandoffGiveSigEnvelopeCodec,
  makeHandoffGiveDescriptor,
  makeHandoffGiveSigEnvelope,
} from '@endo/ocapn';
import { makeCryptography, makeSessionId } from '@endo/ocapn/cryptography';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';
import { makeDurableNetLayer } from '../src/net/durable-netlayer.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @param {Uint8Array} bytes */
const hex = bytes =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

test('reattach keeps an attempted frame ahead of new gift withdrawals', t => {
  const crypto = makeCryptography(syrupCodec);
  const { keyPair, privateKeyBytes } =
    crypto.makeOcapnKeyPairWithPrivateBytes();
  const other = crypto.makeOcapnKeyPair();
  const sessionId = makeSessionId(keyPair.publicKey.id, other.publicKey.id);
  const give = makeHandoffGiveDescriptor(
    other.publicKey.descriptor,
    {
      type: 'ocapn-peer',
      transport: 'tcp',
      designator: 'exporter',
      hints: false,
    },
    sessionId,
    keyPair.publicKey.id,
    frozenBytes(new Uint8Array([1])),
  );
  const writer = syrupCodec.makeWriter();
  DescHandoffGiveSigEnvelopeCodec.write(
    makeHandoffGiveSigEnvelope(give, crypto.signHandoffGive(give, keyPair)),
    writer,
  );
  const identity = {
    sessionId: hex(sessionId),
    peerPublicKeyQ: hex(other.publicKey.id),
    selfPrivateKey: hex(privateKeyBytes),
  };
  const empty = {
    epoch: 0,
    ourExports: {},
    nextExport: '1',
    nextAnswer: '3',
    answersOwed: {},
    processedUpTo: 0,
    durable: true,
    queue: [],
    queueSequences: [],
    nextDelivery: '0',
    identity,
    usedGiftHandoffs: [],
    nextHandoffCount: '1',
  };
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    sessions: {
      gifter: { ...empty, pendingWithdraws: [] },
      exporter: {
        ...empty,
        queue: ['00', '01'],
        queueSequences: ['5', ''],
        nextDelivery: '5',
        pendingWithdraws: [1, 2].map(position => ({
          position: String(position),
          giveHex: hex(writer.getBytes()),
          gifterSession: 'gifter',
        })),
      },
    },
    publications: {},
    gifts: {},
    giftWaiters: {},
  };
  /** @type {any[]} */
  const commits = [];
  const hub = makeOcapnHub({
    codec: syrupCodec,
    cryptography: crypto,
    store: {
      getState: () => state,
      setState: value => {
        state = JSON.parse(JSON.stringify(value));
        commits.push(state);
      },
    },
  });
  /** @type {Array<{bytes: number[], sequence: string | undefined}>} */
  const sent = [];
  hub.attachSession('exporter', {
    durable: true,
    send: (bytes, sequence) => sent.push({ bytes: [...bytes], sequence }),
  });
  t.deepEqual(
    sent.map(frame => frame.sequence),
    ['5', '6', '7', '8'],
  );
  t.deepEqual(sent[0].bytes, [0]);
  t.deepEqual(sent[3].bytes, [1]);
  t.true(
    sent
      .slice(1, 3)
      .every(frame =>
        new TextDecoder()
          .decode(new Uint8Array(frame.bytes))
          .includes('withdraw-gift'),
      ),
  );
  const batchCommit = commits.find(
    row => row.sessions.exporter.pendingWithdraws.length === 0,
  );
  t.is(
    batchCommit.sessions.exporter.queue.length,
    4,
    'both withdrawals are committed before any one is released',
  );
});

test('failed pending withdrawal flushes rejection to another attached session', t => {
  const resolverId = 'receiver#0:1';
  const hub = makeOcapnHub({
    codec: syrupCodec,
    logError: () => {},
    store: {
      getState: () => ({
        version: 2,
        refs: {
          'exporter#0:a1': {
            origin: 'exporter',
            position: '1',
            backing: 'answer',
            flavor: 'promise',
            listeners: [resolverId],
          },
          [resolverId]: {
            origin: 'receiver',
            position: '1',
            flavor: 'object',
            resolver: true,
          },
        },
        sessions: {
          receiver: {},
          exporter: {
            identity: {},
            pendingWithdraws: [
              { position: '1', giveHex: '00', gifterSession: 'missing' },
            ],
          },
        },
      }),
      setState: () => {},
    },
  });
  /** @type {Uint8Array[]} */
  const received = [];
  hub.attachSession('receiver', { send: bytes => received.push(bytes) });
  hub.attachSession('exporter', { send: () => {} });
  t.is(
    received.length,
    1,
    'rejection must arrive without an unrelated follow-up message',
  );
  t.true(new TextDecoder().decode(received[0]).includes('break'));
});

test.serial(
  'remote transport restores hub acceptance before draining replayed outbox',
  async t => {
    t.timeout(5000);
    /** @type {any} */
    let physicalHandlers;
    /** @type {any} */
    let logical;
    /** @type {Array<{n: bigint, sequence: string | undefined}>} */
    const recorded = [];
    const layer = await makeDurableNetLayer(nodePowers, {
      handlers: /** @type {any} */ ({
        makeConnection: (netlayer, isOutgoing, operations) => {
          logical = { netlayer, isOutgoing, ...operations };
          return logical;
        },
        handleMessageData: () => {},
        handleConnectionClose: () => {},
      }),
      logger: /** @type {any} */ ({ info() {}, error() {} }),
      makeBaseNetlayer: ({ handlers }) => {
        physicalHandlers = handlers;
        return { location: {}, locationId: 'test', shutdown() {} };
      },
      resumption: {
        isDurableToken: () => true,
        onHello: () => {},
        listSessions: () => [],
        isRetired: () => false,
        recordRetirementConfirmed: () => {},
        recordPeerDurability: () => {},
        recordProcessed: () => {},
        loadForResume: () => ({
          recvSeq: '0',
          sendSeq: '10',
          ackSeq: '10',
          isOriginator: false,
          inbox: [],
          hubDelivery: '7',
          frames: [],
        }),
        restoreSession: (_handlers, connection) => {
          // attachSession may drain immediately during restoration, before flow opens.
          connection.write(new Uint8Array([7]), '7');
          connection.write(new Uint8Array([8]), '8');
        },
        recordOutbound: (_token, n, _bytes, sequence) =>
          recorded.push({ n, sequence }),
        recordAck: () => {},
        recordInbound: () => {},
        onEnd: () => {},
      },
    });
    t.teardown(() => layer.shutdown());
    const physical = physicalHandlers.makeConnection({}, false, {
      write() {},
      end() {},
    });
    physicalHandlers.handleMessageData(
      physical,
      new TextEncoder().encode(
        '{"v":2,"t":"resume","tok":"0123456789abcdef0123456789abcdef","rcv":"10","durability":"restart"}\n',
      ),
    );
    logical.write(new Uint8Array([8]), '8');
    logical.write(new Uint8Array([9]), '9');
    t.deepEqual(recorded, [
      { n: 11n, sequence: '8' },
      { n: 12n, sequence: '9' },
    ]);
  },
);

test('outbox batches accepted-prefix removal with the next sequence commit', t => {
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    publications: {},
    sessions: {
      destination: {
        durable: true,
        queue: ['00', '01'],
        queueSequences: ['', ''],
        nextDelivery: '0',
      },
    },
  };
  let commits = 0;
  const hub = makeOcapnHub({
    codec: syrupCodec,
    store: {
      getState: () => state,
      setState: next => {
        state = JSON.parse(JSON.stringify(next));
        commits += 1;
      },
    },
  });
  const sent = [];
  hub.attachSession('destination', {
    durable: true,
    requireAcceptance: true,
    send: (bytes, sequence) => {
      const saved = state.sessions.destination;
      t.is(
        saved.queueSequences[0],
        sequence,
        'replay identity is durable before wire',
      );
      t.is(
        saved.queue[0],
        hex(bytes),
        'frame ownership is durable before wire',
      );
      sent.push(sequence);
      return true;
    },
  });
  t.deepEqual(sent, ['1', '2']);
  t.is(
    commits,
    4,
    'attach, first sequence, next sequence plus removal, final removal',
  );
  t.deepEqual(state.sessions.destination.queue, []);
});

test('failed final outbox commit replays the accepted tail with its original identity', t => {
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    publications: {},
    sessions: {
      destination: {
        durable: true,
        queue: ['00', '01'],
        queueSequences: ['', ''],
        nextDelivery: '0',
      },
    },
  };
  let fail = true;
  const store = {
    getState: () => state,
    setState: next => {
      if (fail && next.sessions.destination.queue.length === 0) {
        throw Error('injected final commit failure');
      }
      state = JSON.parse(JSON.stringify(next));
    },
  };
  const accepted = new Set();
  const sends = [];
  const adapter = {
    durable: true,
    requireAcceptance: true,
    send: (_bytes, sequence) => {
      sends.push(sequence);
      accepted.add(sequence);
      return true;
    },
  };
  const first = makeOcapnHub({ codec: syrupCodec, store });
  t.throws(() => first.attachSession('destination', adapter), {
    message: /injected final commit failure/,
  });
  t.deepEqual(state.sessions.destination.queueSequences, ['2']);
  fail = false;
  const restored = makeOcapnHub({ codec: syrupCodec, store });
  restored.attachSession('destination', adapter);
  t.deepEqual(sends, ['1', '2', '2']);
  t.deepEqual([...accepted], ['1', '2']);
  t.deepEqual(state.sessions.destination.queue, []);
});

test('sequence commit failure exposes no frame to the transport', t => {
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    publications: {},
    sessions: {
      destination: {
        durable: true,
        queue: ['00'],
        queueSequences: [''],
        nextDelivery: '0',
      },
    },
  };
  let fail = true;
  const store = {
    getState: () => state,
    setState: next => {
      if (fail && next.sessions.destination.queueSequences[0] === '1') {
        throw Error('injected sequence commit failure');
      }
      state = JSON.parse(JSON.stringify(next));
    },
  };
  const sent = [];
  const adapter = {
    durable: true,
    send: (_bytes, sequence) => {
      sent.push(sequence);
      return true;
    },
  };
  const hub = makeOcapnHub({ codec: syrupCodec, store });
  t.throws(() => hub.attachSession('destination', adapter), {
    message: /sequence commit failure/,
  });
  t.deepEqual(sent, []);
  t.deepEqual(state.sessions.destination.queueSequences, ['']);
  fail = false;
  makeOcapnHub({ codec: syrupCodec, store }).attachSession(
    'destination',
    adapter,
  );
  t.deepEqual(sent, ['1']);
});

for (const crash of [false, true]) {
  test(`deferred cleanup retains replay identity (crash: ${crash})`, t => {
    /** @type {any} */
    let state = {
      version: 2,
      refs: {},
      publications: {},
      sessions: {
        destination: {
          durable: true,
          queue: ['00', '01'],
          queueSequences: ['', ''],
          nextDelivery: '0',
        },
      },
    };
    let commits = 0;
    const store = {
      getState: () => state,
      setState: next => {
        state = JSON.parse(JSON.stringify(next));
        commits += 1;
      },
    };
    const sends = [];
    const owned = new Set();
    const adapter = {
      durable: true,
      requireAcceptance: true,
      deferCleanup: true,
      send: (_bytes, sequence) => {
        t.is(state.sessions.destination.queueSequences[0], sequence);
        sends.push(sequence);
        owned.add(sequence);
        return true;
      },
    };
    const hub = makeOcapnHub({ codec: syrupCodec, store });
    const sink = hub.attachSession('destination', adapter);
    t.is(commits, 3, 'no final cleanup commit');
    t.deepEqual(state.sessions.destination.queueSequences, ['2']);
    if (crash) {
      makeOcapnHub({ codec: syrupCodec, store }).attachSession(
        'destination',
        adapter,
      );
      t.deepEqual(sends, ['1', '2', '2']);
    } else {
      sink.flush();
      t.is(commits, 4, 'explicit flush commits deferred removals');
      t.deepEqual(state.sessions.destination.queue, []);
    }
    t.deepEqual([...owned], ['1', '2'], 'receiver applies each identity once');
  });
}
