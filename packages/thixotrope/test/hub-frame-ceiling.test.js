// @ts-check

/**
 * The hub's inbound frame ceiling (`maxInboundFrameBytes`): a message whose
 * frame toward a bounded session (a vat) would be longer is refused before it
 * is queued, committed or sent, and breaks toward whoever waits on it.
 * Sessions without a ceiling (adapters, clients, peers) take any frame.
 */
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { E, Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { syrupCodec } from '@endo/ocapn/syrup';

import { FRAME_TOO_LARGE, makeOcapnHub } from '../src/net/hub.js';
import { makePipeNetwork } from '../src/net/pipe-network.js';
import { makeWorkerPeer } from '../src/core/worker-peer.js';
import { makeTestOcapn } from './_util.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();
const textEncoder = new TextEncoder();
/** @param {string} text */
const bytesOf = text => frozenBytes(textEncoder.encode(text));

const CEILING = 4096;
const WORKER = 'a'.repeat(32);
const CLIENT = 'c'.repeat(32);

/** A hub over a store that keeps every committed state as JSON text. */
const makeRecordingHub = () => {
  /** @type {Array<string>} */
  const commits = [];
  /** @type {any} */
  let state;
  const hub = makeOcapnHub({
    codec: syrupCodec,
    store: {
      getState: () => state,
      setState: next => {
        const text = JSON.stringify(next);
        commits.push(text);
        state = JSON.parse(text);
      },
    },
  });
  return { hub, commits };
};

/**
 * A worker peer attached with a ceiling, as the daemon attaches a vat.
 *
 * @param {any} hub
 */
const attachBoundedWorker = async hub => {
  /** @type {{ sink: any, pending: Array<Uint8Array> }} */
  const outbound = { sink: undefined, pending: [] };
  /** @type {Array<Uint8Array>} */
  const framesToWorker = [];
  const worker = await makeWorkerPeer(nodePowers, {
    workerId: WORKER,
    debugLabel: 'bounded',
    send: frame => {
      if (outbound.sink === undefined) outbound.pending.push(frame);
      else outbound.sink.deliver(frame);
    },
  });
  outbound.sink = hub.attachSession(WORKER, {
    send: (/** @type {Uint8Array} */ bytes) => {
      framesToWorker.push(bytes);
      worker.deliver(bytes);
    },
    durable: true,
    maxInboundFrameBytes: CEILING,
  });
  for (const frame of outbound.pending.splice(0)) outbound.sink.deliver(frame);
  return { worker, framesToWorker };
};

/**
 * An ordinary client, attached without a ceiling (an adapter or peer).
 *
 * @param {any} hub
 */
const attachClient = async hub => {
  /** @type {{ sink: any, pending: Array<Uint8Array> }} */
  const outbound = { sink: undefined, pending: [] };
  const pipe = makePipeNetwork({
    codec: syrupCodec,
    workerId: CLIENT,
    role: 'worker',
    send: frame => {
      if (outbound.sink === undefined) outbound.pending.push(frame);
      else outbound.sink.deliver(frame);
    },
  });
  const client = await makeTestOcapn({
    codec: syrupCodec,
    network: pipe.network,
    debugLabel: 'client',
  });
  const session = await client.provideSession(pipe.peerLocation);
  outbound.sink = hub.attachSession(CLIENT, {
    send: (/** @type {Uint8Array} */ bytes) => pipe.deliver(bytes),
  });
  for (const frame of outbound.pending.splice(0)) outbound.sink.deliver(frame);
  return { client, session };
};

/** @param {import('ava').ExecutionContext} t */
const setup = async t => {
  const { hub, commits } = makeRecordingHub();
  const { worker, framesToWorker } = await attachBoundedWorker(hub);
  const { client, session } = await attachClient(hub);
  t.teardown(() => client.shutdown());
  t.teardown(() => worker.shutdown());
  hub.publish('worker', { session: WORKER, position: 0n });
  const boot = await E(session.getBootstrap()).fetch(bytesOf('worker'));
  const shell = await E(boot).fetch(bytesOf('shell'));
  return { hub, commits, framesToWorker, shell };
};

/**
 * The hex of a run of one character, as a queued frame would hold it.
 *
 * @param {string} char
 */
const hexRun = char => char.charCodeAt(0).toString(16).repeat(256);

test('a call too large for a vat breaks to its sender and never reaches the vat', async t => {
  const { commits, framesToWorker, shell } = await setup(t);
  const echo = await E(shell).evaluate(
    `Far('Echo', { len: s => s.length, make: n => 'x'.repeat(n) })`,
  );
  t.is(await E(echo).len('ok'), 2);
  const frames = framesToWorker.length;
  const committed = commits.length;

  await t.throwsAsync(() => E(echo).len('y'.repeat(CEILING)), {
    message: FRAME_TOO_LARGE,
  });
  // A deliver-only call has nobody to tell; it is refused just the same.
  E.sendOnly(echo).len('z'.repeat(CEILING));
  t.is(await E(echo).len('still'), 5, 'the vat still serves');

  t.is(framesToWorker.length, frames + 1, 'only the small call reached it');
  t.true(framesToWorker.every(bytes => bytes.length <= CEILING));
  for (const text of commits.slice(committed)) {
    t.false(text.includes(hexRun('y')), 'the refused call was never committed');
    t.false(text.includes(hexRun('z')));
  }
  // Frames toward an unbounded session are not limited.
  t.is((await E(echo).make(CEILING * 4)).length, CEILING * 4);
});

test('a settlement too large for the calling vat breaks its call instead of hanging', async t => {
  const { framesToWorker, shell } = await setup(t);
  const later = makePromiseKit();
  const source = Far('Source', {
    big: () => 'x'.repeat(CEILING * 2),
    small: () => 'ok',
  });
  const caller = await E(shell).evaluate(
    `Far('Caller', {
      call: () => E(src).big(),
      callSmall: () => E(src).small(),
      wait: () => box.later.then(s => s.length),
    })`,
    harden({ src: source, box: { later: later.promise } }),
  );
  t.is(await E(caller).callSmall(), 'ok');
  // The answer to the vat's call is refused; its resolver breaks.
  await t.throwsAsync(() => E(caller).call(), { message: FRAME_TOO_LARGE });
  // A resolution of a promise the vat listens on, likewise.
  const waited = E(caller).wait();
  later.resolve('w'.repeat(CEILING * 2));
  await t.throwsAsync(() => waited, { message: FRAME_TOO_LARGE });
  t.is(await E(caller).callSmall(), 'ok', 'the vat still serves');
  t.true(framesToWorker.every(bytes => bytes.length <= CEILING));
});

test('the ceiling must be a positive integer', t => {
  const hub = makeOcapnHub({ codec: syrupCodec });
  for (const maxInboundFrameBytes of [0, -1, 1.5, Infinity]) {
    t.throws(
      () => hub.attachSession('v', { send: () => true, maxInboundFrameBytes }),
      { message: /maxInboundFrameBytes must be a positive integer/ },
    );
  }
});
