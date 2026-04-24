// @ts-nocheck

// `makeMessageSlots` is the slot-machine drop-in for
// `makeMessageCapTP`.  Tests here drive two instances connected by
// an in-memory queue pair with a direction-flipping relay in the
// middle, mimicking the Rust supervisor's kref translation for the
// bootstrap case.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far, E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';

import { Direction } from '../src/descriptor.js';
import { makeMessageSlots } from '../src/message.js';
import {
  encodeDeliverPayload,
  decodeDeliverPayload,
  encodeResolvePayload,
  decodeResolvePayload,
} from '../src/payload.js';

const flipDesc = d => ({
  ...d,
  dir: d.dir === Direction.Local ? 1 : 0,
});
const flipArr = arr => arr.map(flipDesc);

const flipPayload = (verb, payload) => {
  if (verb === 'deliver') {
    const p = decodeDeliverPayload(payload);
    return encodeDeliverPayload({
      target: flipDesc(p.target),
      body: p.body,
      targets: flipArr(p.targets),
      promises: flipArr(p.promises),
      reply: p.reply ? flipDesc(p.reply) : null,
    });
  }
  if (verb === 'resolve') {
    const p = decodeResolvePayload(payload);
    return encodeResolvePayload({
      target: flipDesc(p.target),
      isReject: p.isReject,
      body: p.body,
      targets: flipArr(p.targets),
      promises: flipArr(p.promises),
    });
  }
  return payload;
};

// A direction-flipping pipe pair: whatever A writes reaches B with
// all descriptors flipped, and vice versa.
const makeFlippingPair = () => {
  const [aToBReader, aToBWriter] = makePipe();
  const [bToAReader, bToAWriter] = makePipe();
  const flipStream = async function* (upstream) {
    for await (const env of upstream) {
      yield { verb: env.verb, payload: flipPayload(env.verb, env.payload) };
    }
  };
  return {
    aWriter: aToBWriter,
    aReader: flipStream(bToAReader),
    bWriter: bToAWriter,
    bReader: flipStream(aToBReader),
  };
};

test('makeMessageSlots — bootstrap + method round-trip', async t => {
  const { aWriter, aReader, bWriter, bReader } = makeFlippingPair();

  const { promise: cancelled } = makePromiseKit();

  const bRoot = Far('b-root', {
    greet(name) {
      return `hello ${name}`;
    },
  });
  const b = makeMessageSlots('b', bWriter, bReader, cancelled, bRoot);

  const aRoot = Far('a-root', {});
  const a = makeMessageSlots('a', aWriter, aReader, cancelled, aRoot);

  const remoteB = a.getBootstrap();
  t.is(await E(remoteB).greet('slot-machine'), 'hello slot-machine');

  await a.close();
  await b.close();
});

test('makeMessageSlots — rejection propagates', async t => {
  const { aWriter, aReader, bWriter, bReader } = makeFlippingPair();
  const { promise: cancelled } = makePromiseKit();

  const bRoot = Far('b-root', {
    fail() {
      throw Error('from b');
    },
  });
  const b = makeMessageSlots('b', bWriter, bReader, cancelled, bRoot);
  const a = makeMessageSlots(
    'a',
    aWriter,
    aReader,
    cancelled,
    Far('a-root', {}),
  );
  const remoteB = a.getBootstrap();
  await t.throwsAsync(() => E(remoteB).fail(), { message: /from b/ });

  await a.close();
  await b.close();
});
