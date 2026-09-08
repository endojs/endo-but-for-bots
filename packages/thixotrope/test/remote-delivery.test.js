// @ts-check
import test from '@endo/ses-ava/test.js';

import { makeDurableNetLayer } from '../src/durable-netlayer.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {Uint8Array} bytes */
const headerOf = bytes =>
  JSON.parse(decoder.decode(bytes.subarray(0, bytes.indexOf(10))));

/** A manually pumped network: no wall-clock connection or retransmission races. */
const makeNetwork = () => {
  /** @type {Map<string, any>} */
  const endpoints = new Map();
  /** @type {Array<{to: any, physical: any, bytes: Uint8Array, after?: () => void}>} */
  const queue = [];
  let rejectDials = false;
  return {
    queue,
    endpoints,
    setRejectDials: (/** @type {boolean} */ reject) => {
      rejectDials = reject;
    },
    makeBase: (/** @type {string} */ name, /** @type {any} */ handlers) => {
      const endpoint = { handlers };
      endpoints.set(name, endpoint);
      return {
        location: { name },
        locationId: name,
        connect: (/** @type {{name: string}} */ location) => {
          if (rejectDials) throw Error('dial unavailable');
          const peer = endpoints.get(location.name);
          if (!peer) throw Error('peer unavailable');
          /** @type {any} */
          let local;
          /** @type {any} */
          let remote;
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            // Stream close notifications follow already-written data. In
            // particular, a final retirement response must arrive first.
            for (const [physical, owner] of [
              [local, endpoint],
              [remote, peer],
            ]) {
              const pending = queue.findLast(
                entry => entry.physical === physical,
              );
              const notify = () =>
                owner.handlers.handleConnectionClose(physical);
              if (pending) pending.after = notify;
              else notify();
            }
          };
          local = handlers.makeConnection({}, true, {
            write: (/** @type {Uint8Array} */ bytes) =>
              queue.push({ to: peer, physical: remote, bytes }),
            end: close,
          });
          remote = peer.handlers.makeConnection({}, false, {
            write: (/** @type {Uint8Array} */ bytes) =>
              queue.push({ to: endpoint, physical: local, bytes }),
            end: close,
          });
          return local;
        },
        shutdown: () => {},
      };
    },
    pumpOne: (/** @type {string | undefined} */ type = undefined) => {
      const index =
        type === undefined
          ? 0
          : queue.findIndex(entry => headerOf(entry.bytes).t === type);
      if (index < 0 || queue.length === 0)
        throw Error(`no queued ${type ?? 'message'}`);
      const [entry] = queue.splice(index, 1);
      entry.to.handlers.handleMessageData(entry.physical, entry.bytes);
      entry.after?.();
      return entry;
    },
  };
};

/** Durable state belongs to the node, independently of each layer incarnation. */
const makeState = () => ({
  /** @type {Map<string, any>} */
  records: new Map(),
  /** @type {Array<{n: bigint, bytes: number[]}>} */
  delivered: [],
});

/**
 * @param {ReturnType<typeof makeNetwork>} network
 * @param {string} name
 * @param {ReturnType<typeof makeState>} state
 * @param {{ receive?: () => void, failInbound?: boolean, durable?: boolean }} [options]
 */
const makeNode = async (network, name, state, options = {}) => {
  /** @type {any[]} */
  const connections = [];
  const layer = await makeDurableNetLayer({
    reconnectDelayMs: 1_000_000,
    maxReconnectDelayMs: 1_000_000,
    logger: { info() {}, error() {} },
    handlers: {
      makeConnection: (
        /** @type {any} */ netlayer,
        /** @type {boolean} */ isOutgoing,
        /** @type {any} */ operations,
      ) => {
        const connection = { netlayer, isOutgoing, ...operations };
        connections.push(connection);
        return connection;
      },
      handleMessageData: (
        /** @type {any} */ connection,
        /** @type {Uint8Array} */ bytes,
        /** @type {bigint} */ n,
      ) => {
        options.receive?.();
        state.delivered.push({ n, bytes: [...bytes] });
      },
      handleConnectionClose() {},
    },
    makeBaseNetlayer: ({ handlers }) => network.makeBase(name, handlers),
    resumption:
      options.durable === false
        ? undefined
        : {
            isDurableToken: token => !state.records.get(token)?.retired,
            isRetired: token => state.records.get(token)?.retired === true,
            recordRetirementConfirmed: token => {
              state.records.set(token, {
                ...state.records.get(token),
                retirementConfirmed: true,
              });
            },
            recordPeerDurability: (token, peerDurability) => {
              state.records.set(token, {
                ...state.records.get(token),
                peerDurability,
              });
            },
            onHello: (token, location) => {
              if (state.records.has(token)) throw Error('duplicate creation');
              state.records.set(token, {
                recvSeq: '0',
                sendSeq: '0',
                ackSeq: '0',
                hubDelivery: '0',
                frames: [],
                inbox: [],
                isOriginator: location !== undefined,
                location,
              });
            },
            listSessions: () =>
              [...state.records.keys()].filter(token => {
                const record = state.records.get(token);
                return (
                  !record.retired ||
                  (record.isOriginator && !record.retirementConfirmed)
                );
              }),
            loadForResume: token => {
              const record = state.records.get(token);
              // Loading cannot share mutable protocol buffers with persisted state.
              return (
                record && {
                  ...record,
                  frames: record.frames.map((/** @type {any} */ entry) => ({
                    ...entry,
                    bytes: entry.bytes.slice(),
                  })),
                  inbox: record.inbox.map((/** @type {any} */ entry) => ({
                    ...entry,
                    bytes: entry.bytes.slice(),
                  })),
                }
              );
            },
            restoreSession() {},
            recordOutbound: (token, n, bytes, hubSequence) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                sendSeq: String(n),
                hubDelivery: hubSequence ?? record.hubDelivery,
                frames: [
                  ...record.frames,
                  { n: String(n), bytes: bytes.slice() },
                ],
              });
            },
            recordAck: (token, n) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                ackSeq: String(n),
                frames: record.frames.filter(
                  (/** @type {any} */ entry) => BigInt(entry.n) > n,
                ),
              });
            },
            recordInbound: (token, n, bytes) => {
              if (options.failInbound) throw Error('inbox commit failed');
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                recvSeq: String(n),
                inbox: [
                  ...record.inbox,
                  { n: String(n), bytes: bytes.slice() },
                ],
              });
            },
            recordProcessed: (token, n) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                inbox: record.inbox.filter(
                  (/** @type {any} */ entry) => BigInt(entry.n) > n,
                ),
              });
            },
            onEnd: token => {
              state.records.set(token, {
                ...state.records.get(token),
                retired: true,
                frames: [],
                inbox: [],
              });
            },
          },
  });
  return { layer, connections };
};

/** @param {ReturnType<typeof makeNetwork>} network */
const greet = network => {
  network.pumpOne('hello');
  network.pumpOne('welcome');
};

/** @param {ReturnType<typeof makeState>} state */
const onlyRecord = state => [...state.records.values()][0];

test('receiver recovers accepted payload after sender releases its only copy', async t => {
  const network = makeNetwork();
  const senderState = makeState();
  const receiverState = makeState();
  const sender = await makeNode(network, 'sender', senderState);
  const receiver = await makeNode(network, 'receiver', receiverState, {
    receive: () => {
      // Sender consumes the durable receipt before the receiver's dispatch crashes.
      network.pumpOne('ack');
      throw Error('crash before hub commit');
    },
  });
  t.teardown(() => sender.layer.shutdown());
  t.teardown(() => receiver.layer.shutdown());
  const connection = sender.layer.connect({ name: 'receiver' });
  greet(network);
  t.true(connection.write(new Uint8Array([42]), '1'));
  network.pumpOne('f');
  t.is(onlyRecord(senderState).frames.length, 0);
  t.is(onlyRecord(receiverState).inbox.length, 1);
  t.is(receiverState.delivered.length, 0);
  sender.layer.shutdown();
  receiver.layer.shutdown();
  const recoveredReceiver = await makeNode(network, 'receiver', receiverState);
  t.teardown(() => recoveredReceiver.layer.shutdown());
  recoveredReceiver.layer.start();
  t.deepEqual(receiverState.delivered, [{ n: 1n, bytes: [42] }]);
  t.is(onlyRecord(receiverState).inbox.length, 0);
});

test('lost acceptance acknowledgement is repeated without redispatching payload', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  connection.write(new Uint8Array([1]), '1');
  const original = network.pumpOne('f');
  network.queue.length = 0; // Drop the first receipt.
  t.is(onlyRecord(aState).frames.length, 1);
  network.queue.push(original);
  network.pumpOne('f');
  network.pumpOne('ack');
  t.is(bState.delivered.length, 1);
  t.is(onlyRecord(aState).frames.length, 0);
});

test('inbox commit failure emits no acceptance and retains sender obligation', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState, { failInbound: true });
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  connection.write(new Uint8Array([1]), '1');
  network.pumpOne('f');
  t.false(network.queue.some(entry => headerOf(entry.bytes).t === 'ack'));
  t.is(onlyRecord(aState).frames.length, 1);
  t.is(onlyRecord(bState).recvSeq, '0');
  t.is(bState.delivered.length, 0);
});

test('future acknowledgement cannot release an issued message', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  connection.write(new Uint8Array([1]), '1');
  network.pumpOne('f');
  const receipt = network.queue[0];
  receipt.bytes = encoder.encode('{"v":2,"t":"ack","n":"2"}\n');
  network.pumpOne('ack');
  t.is(onlyRecord(aState).ackSeq, '0');
  t.is(onlyRecord(aState).frames.length, 1);
});

test('initial dial failure preserves accepted sends across both node restarts', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  network.setRejectDials(true);
  const connection = a.layer.connect({ name: 'b' });
  t.true(connection.write(new Uint8Array([7]), '11'));
  t.is(onlyRecord(aState).frames.length, 1);
  a.layer.shutdown();
  b.layer.shutdown();
  t.false(connection.write(new Uint8Array([8]), '12'));
  network.setRejectDials(false);
  const recoveredB = await makeNode(network, 'b', bState);
  const recoveredA = await makeNode(network, 'a', aState);
  t.teardown(() => recoveredA.layer.shutdown());
  t.teardown(() => recoveredB.layer.shutdown());
  recoveredB.layer.start();
  recoveredA.layer.start();
  greet(network);
  network.pumpOne('f');
  network.pumpOne('ack');
  t.deepEqual(bState.delivered, [{ n: 1n, bytes: [7] }]);
  t.is(onlyRecord(aState).frames.length, 0);
  t.true(recoveredA.connections[0].write(new Uint8Array([7]), '11'));
  t.is(
    network.queue.length,
    0,
    'hub retry retains its existing transport identity',
  );
});

test('resumed delivery sequences remain exact beyond JavaScript number range', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const token = 'a'.repeat(32);
  const prior = 9_007_199_254_740_993n;
  const empty = {
    frames: [],
    inbox: [],
    hubDelivery: '0',
    ackSeq: '0',
    sendSeq: '0',
    recvSeq: '0',
  };
  aState.records.set(token, {
    ...empty,
    isOriginator: true,
    location: { name: 'b' },
    sendSeq: String(prior),
    ackSeq: String(prior),
  });
  bState.records.set(token, {
    ...empty,
    isOriginator: false,
    recvSeq: String(prior),
  });
  const b = await makeNode(network, 'b', bState);
  const a = await makeNode(network, 'a', aState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  b.layer.start();
  a.layer.start();
  greet(network);
  a.connections[0].write(new Uint8Array([3]), '1');
  t.is(headerOf(network.queue[0].bytes).n, String(prior + 1n));
  network.pumpOne('f');
  network.pumpOne('ack');
  t.deepEqual(bState.delivered, [{ n: prior + 1n, bytes: [3] }]);
  t.is(onlyRecord(aState).ackSeq, String(prior + 1n));
});

test('both established peers restart and deliver a settlement queued while disconnected', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  connection.write(new Uint8Array([1]), '1');
  network.pumpOne('f');
  network.queue.length = 0; // The invocation ran but its receipt was lost.
  const token = [...aState.records.keys()][0];
  a.layer.shutdown();
  // Result production is independent of the originator's current connection.
  t.true(b.connections[0].write(new Uint8Array([2]), '1'));
  b.layer.shutdown();
  network.queue.length = 0;
  const restoredB = await makeNode(network, 'b', bState);
  const restoredA = await makeNode(network, 'a', aState);
  t.teardown(() => restoredA.layer.shutdown());
  t.teardown(() => restoredB.layer.shutdown());
  restoredB.layer.start();
  restoredA.layer.start();
  greet(network);
  t.is(
    onlyRecord(aState).frames.length,
    0,
    'resumption acknowledges the original invocation',
  );
  network.pumpOne('f');
  network.pumpOne('ack');
  t.deepEqual([...aState.records.keys()], [token]);
  t.deepEqual([...bState.records.keys()], [token]);
  t.deepEqual(bState.delivered, [{ n: 1n, bytes: [1] }]);
  t.deepEqual(aState.delivered, [{ n: 1n, bytes: [2] }]);
  t.is(onlyRecord(bState).frames.length, 0);
});

test('offline retirement is confirmed on reconnect when the original bye was lost', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  a.layer.connect({ name: 'b' });
  greet(network);
  b.connections[0].end();
  t.true(onlyRecord(bState).retired);
  network.queue.length = 0; // Retirement's best-effort notification is lost.
  a.layer.shutdown();
  b.layer.shutdown();
  const restoredB = await makeNode(network, 'b', bState);
  const restoredA = await makeNode(network, 'a', aState);
  t.teardown(() => restoredA.layer.shutdown());
  t.teardown(() => restoredB.layer.shutdown());
  restoredB.layer.start();
  restoredA.layer.start();
  network.pumpOne('hello');
  network.pumpOne('retired');
  t.true(onlyRecord(aState).retired);
  t.false(restoredA.connections[0].write(new Uint8Array([1]), '1'));
  t.is(
    restoredB.connections.length,
    0,
    'retired session cannot resurrect a logical connection',
  );
  t.is(bState.records.size, 1);
});

test('a restarted peer cannot change its negotiated acceptance durability', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  t.is(onlyRecord(aState).peerDurability, 'restart');
  connection.write(new Uint8Array([1]), '1');
  network.queue.length = 0; // Invocation remains in sender's durable outbox.
  a.layer.shutdown();
  b.layer.shutdown();
  const restoredB = await makeNode(network, 'b', bState);
  const restoredA = await makeNode(network, 'a', aState);
  t.teardown(() => restoredA.layer.shutdown());
  t.teardown(() => restoredB.layer.shutdown());
  restoredB.layer.start();
  restoredA.layer.start();
  network.pumpOne('hello');
  const response = network.queue.find(
    entry => headerOf(entry.bytes).t === 'welcome',
  );
  t.truthy(response);
  if (!response) throw Error('welcome missing');
  response.bytes = encoder.encode(
    '{"v":2,"t":"welcome","durability":"process","rcv":"1"}\n',
  );
  network.pumpOne('welcome');
  t.is(onlyRecord(aState).peerDurability, 'restart');
  t.is(
    onlyRecord(aState).frames.length,
    1,
    'untrusted profile must not release obligations',
  );
  t.is(onlyRecord(aState).ackSeq, '0');
  t.is(bState.delivered.length, 0);
});

test('offline originator retries retirement across restart until peer confirms', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState);
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  greet(network);
  b.layer.shutdown();
  connection.end();
  t.true(onlyRecord(aState).retired);
  t.false(onlyRecord(bState).retired === true);
  t.false(connection.write(new Uint8Array([9]), '1'));
  a.layer.shutdown();
  const restoredB = await makeNode(network, 'b', bState);
  const restoredA = await makeNode(network, 'a', aState);
  t.teardown(() => restoredA.layer.shutdown());
  t.teardown(() => restoredB.layer.shutdown());
  restoredB.layer.start();
  restoredA.layer.start();
  network.pumpOne('retire');
  t.true(onlyRecord(bState).retired);
  network.queue.length = 0; // Lose the first terminal confirmation too.
  restoredA.layer.shutdown();
  const retriedA = await makeNode(network, 'a', aState);
  t.teardown(() => retriedA.layer.shutdown());
  retriedA.layer.start();
  network.pumpOne('retire');
  network.pumpOne('retired');
  t.true(onlyRecord(aState).retirementConfirmed);
  t.false(retriedA.connections[0].write(new Uint8Array([9]), '1'));
  retriedA.layer.shutdown();
  const confirmedA = await makeNode(network, 'a', aState);
  t.teardown(() => confirmedA.layer.shutdown());
  confirmedA.layer.start();
  t.is(
    network.queue.length,
    0,
    'confirmed retirement does not redial after restart',
  );
  t.is(aState.records.size, 1);
  t.is(bState.records.size, 1);
});

test('peer durability exposes the negotiated distinction between process and restart acceptance', async t => {
  const network = makeNetwork();
  const aState = makeState();
  const bState = makeState();
  const a = await makeNode(network, 'a', aState);
  const b = await makeNode(network, 'b', bState, { durable: false });
  t.teardown(() => a.layer.shutdown());
  t.teardown(() => b.layer.shutdown());
  const connection = a.layer.connect({ name: 'b' });
  t.is(a.layer.getPeerDurability(connection), undefined);
  greet(network);
  t.is(a.layer.getPeerDurability(connection), 'process');
  t.is(b.layer.getPeerDurability(b.connections[0]), 'restart');
  t.is(onlyRecord(aState).peerDurability, 'process');
});
