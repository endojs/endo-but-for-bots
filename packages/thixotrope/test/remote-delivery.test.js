// @ts-check
import test from '@endo/ses-ava/test.js';

import {
  greet,
  headerOf,
  makeNetwork,
  makeNode,
  makeState,
  onlyRecord,
} from './_delivery-network.js';

const encoder = new TextEncoder();

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
