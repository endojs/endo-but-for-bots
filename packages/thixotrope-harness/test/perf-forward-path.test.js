import test from '@endo/ses-ava/test.js';
import { analyzeForwards } from '../perf/_forward-path.mjs';

const sample = {
  senderTurn: 't4',
  recipientTurn: 't3',
  recipientRound: 0,
  start: 100,
  end: 150,
};
const row = (vat, method, outbound, began) => ({
  vat,
  methods: ['op:gc-answers', method],
  outbound: [outbound],
  began,
  ended: began + 1,
  incomingDetails: /** @type {Array<Record<string, any>>} */ ([]),
  outgoingDetails: /** @type {Array<Record<string, any>>} */ ([]),
});
const graph = () => {
  const sender = row('vat-session-s3-X', 'roundFinal', 'post', 105);
  sender.outbound = ['publish', 'post'];
  sender.incomingDetails.push({
    method: 'roundFinal',
    targetSlot: '6',
    round: 0,
  });
  const factory = row('vat-app-harness-X', 'post', 'deliverMail', 115);
  factory.outgoingDetails.push({ method: 'deliverMail', postmark: 37 });
  const receiver = row('vat-session-s2-X', 'deliverMail', 'startRound', 125);
  receiver.outbound = [
    'changed',
    'publish',
    'holdTurn',
    'fulfill',
    'startRound',
  ];
  receiver.incomingDetails.push({ method: 'deliverMail', postmark: 37 });
  receiver.outgoingDetails.push({
    method: 'startRound',
    turnId: 't3',
    sinkSlot: '9',
  });
  const dispatch = row(receiver.vat, 'dispatching', 'fulfill', 140);
  dispatch.incomingDetails.push({
    method: 'dispatching',
    targetSlot: '9',
    round: 0,
  });
  dispatch.outgoingDetails.push({ method: 'fulfill', boolean: true });
  const started = row(sender.vat, 'enqueueOnce', 'startRound', 70);
  started.outgoingDetails.push({
    method: 'startRound',
    turnId: 't4',
    sinkSlot: '6',
  });
  return [sender, factory, receiver, dispatch, started];
};

test('counts the prepared-turn path once per durable worker crank', t => {
  const rows = graph();
  rows.splice(2, 0, row(rows[1].vat, 'changed', 'publish', 121));
  const [result] = analyzeForwards([sample], rows);
  t.is(result.path.length, 4);
  t.is(result.other.length, 1);
  t.is(result.postmark, 37);
});

test('fails closed on an omitted, ambiguous or additional causal delivery', t => {
  const rows = graph();
  t.throws(() => analyzeForwards([sample], rows.slice(1)), {
    message: /sender roundFinal/,
  });
  t.throws(() => analyzeForwards([sample], [...rows, rows[1]]), {
    message: /factory post/,
  });
  t.throws(
    () =>
      analyzeForwards(
        [sample],
        [...rows, row(rows[2].vat, 'readPage', 'fulfill', 130)],
      ),
    { message: /Additional recipient work/ },
  );
  t.throws(
    () =>
      analyzeForwards(
        [sample],
        [...rows, row('vat-extra-X', 'fetch', 'fulfill', 130)],
      ),
    { message: /Unclassified overlapping/ },
  );
  rows[3].methods.push('(unparsed)');
  t.throws(() => analyzeForwards([sample], rows), {
    message: /Unexpected application frame/,
  });
});

test('requires matching forwarded envelope, recipient turn, ordering and unique samples', t => {
  const rows = graph();
  t.throws(
    () => analyzeForwards([{ ...sample, recipientTurn: 'wrong' }], rows),
    { message: /recipient delivery/ },
  );
  rows[2].incomingDetails[0].postmark = 38;
  t.throws(() => analyzeForwards([sample], rows), {
    message: /recipient delivery/,
  });
  rows[2].incomingDetails[0].postmark = 37;
  t.throws(() => analyzeForwards([sample, sample], rows), {
    message: /Duplicate/,
  });
  rows[1].began = 104;
  t.throws(() => analyzeForwards([sample], rows), {
    message: /Broken causal order/,
  });
});

test('reads the selector and scalar mail identity from short and batched Syrup frames', async t => {
  const { Buffer } = await import('node:buffer');
  const { dispatchMethods, methodOf } =
    await import('../perf/_forward-worker.mjs');
  const frame = bytes => ({
    t: 'f',
    b64: Buffer.from(bytes).toString('base64'),
  });
  const gc = frame("<13'op:gc-answers[19+]>");
  const delivery = frame(
    '<10\'op:deliver<11\'desc:export1+>[11\'deliverMail{4"body4"ping8"postmark33+}]ff>',
  );
  const request = frame(
    '<10\'op:deliver<11\'desc:export1+>[10\'startRound{6"append[1+2+]6"turnId2"t7}]ff>',
  );
  const call = msg =>
    `thixotropeDispatch(${JSON.stringify(JSON.stringify(msg))});`;
  const metadata = [];
  t.deepEqual(dispatchMethods(call(gc) + call(delivery), metadata), [
    'op:gc-answers',
    'deliverMail',
  ]);
  t.is(methodOf(request, metadata), 'startRound');
  t.deepEqual(metadata, [
    { method: 'deliverMail', postmark: 33 },
    { method: 'startRound', turnId: 't7' },
  ]);
  t.throws(() => dispatchMethods(`${call(gc)}unexpected()`, []), {
    message: /Unrecognized native dispatch/,
  });
});
