// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeOcapnCommsKit } from '../src/client/ocapn.js';
import { makeGcBatcher } from '../src/codecs/gc-batch.js';

const answers = (...positions) =>
  harden({ type: 'op:gc-answers', answerPositions: positions });
const exports = (positions, deltas) =>
  harden({
    type: 'op:gc-exports',
    exportPositions: positions,
    wireDeltas: deltas,
  });

test('GC batches preserve positions, deltas and ordinary-message barriers', t => {
  const sent = [];
  const batch = makeGcBatcher(message => sent.push(message));
  batch.send(answers(1n, 2n));
  batch.send(answers(3n));
  t.is(sent.length, 0);
  batch.send(exports([4n], [2n]));
  batch.send(exports([5n, 4n], [3n, 1n]));
  const call = harden({ type: 'op:deliver', args: ['call'] });
  batch.send(call);
  batch.send(answers(6n));
  batch.flush();
  batch.flush();
  t.deepEqual(sent, [
    answers(1n, 2n, 3n),
    exports([4n, 5n, 4n], [2n, 3n, 1n]),
    call,
    answers(6n),
  ]);
  t.false(batch.hasPending());
});

test('GC bursts are bounded without losing or duplicating positions', t => {
  const sent = [];
  const batch = makeGcBatcher(message => sent.push(message));
  const positions = Array.from({ length: 145 }, (_, i) => BigInt(i));
  batch.send(answers(...positions));
  t.deepEqual(
    sent.map(message => message.answerPositions.length),
    [64, 64],
  );
  batch.flush();
  t.deepEqual(
    sent.flatMap(message => message.answerPositions),
    positions,
  );
  t.deepEqual(
    sent.map(message => message.answerPositions.length),
    [64, 64, 17],
  );
});

test('a failed GC emit is propagated and not retried with a fresh identity', t => {
  let attempts = 0;
  const batch = makeGcBatcher(() => {
    attempts += 1;
    throw Error('uncertain acceptance');
  });
  batch.send(answers(1n));
  t.throws(() => batch.flush(), { message: 'uncertain acceptance' });
  batch.flush();
  t.is(attempts, 1);
  t.false(batch.hasPending());
});

test('empty lists and malformed notices retain immediate codec behavior', t => {
  const sent = [];
  const batch = makeGcBatcher(message => {
    if (message.type === 'op:gc-exports' && message.wireDeltas[0] === 0n)
      throw Error('invalid delta');
    sent.push(message);
  });
  batch.send(answers(1n));
  batch.send(answers());
  t.deepEqual(sent, [answers(1n), answers()]);
  t.throws(() => batch.send(exports([2n], [0n])), { message: 'invalid delta' });
  t.false(batch.hasPending());
});

test('a deferred GC send failure invokes the session abort handler once', async t => {
  t.timeout(1_000);
  const error = Error('write failed after uncertain acceptance');
  let attempts = 0;
  let resolveFailure;
  const failed = new Promise(resolve => {
    resolveFailure = resolve;
  });
  const noop = () => {};
  const comms = makeOcapnCommsKit({
    logger: { info: noop, error: noop, log: noop },
    rawDispatch: noop,
    onReject: noop,
    rawSend: () => {
      attempts += 1;
      throw error;
    },
    onSendError: reason => {
      comms.doUnplug(reason);
      resolveFailure(reason);
    },
    clearPendingRefCounts: noop,
    commitSentRefCounts: noop,
  });
  comms.send(answers(1n));
  t.is(await failed, error);
  comms.send(answers(2n));
  await Promise.resolve();
  t.is(attempts, 1, 'failed or unplugged sends are not retried');
  t.truthy(comms.didUnplug());
});
