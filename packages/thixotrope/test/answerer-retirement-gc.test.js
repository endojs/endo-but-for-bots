// @ts-check

/**
 * Answers a durable worker asks of an ephemeral session.
 *
 * In the live supervisor the asker is a durable worker and the answerer is
 * a native adapter (`transient:native:*`, attached `durable: false`). Each
 * call allocates an answer row at the adapter and an answer route on the
 * worker's session. Only the asker's `op:gc-answers` releases the route,
 * and that frame comes from the asker's collector, which an Ironhorse realm
 * without `WeakRef` never runs. The rows must therefore not outlive the
 * adapter's retirement: before this test's change, retirement tombstoned
 * them and the worker's routes kept every tombstone persisted.
 */
import test from '@endo/ses-ava/test.js';

import { frozenBytes } from '@endo/immutable-arraybuffer';
import { E, Far } from '@endo/far';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';
import { makePipeNetwork } from '../src/net/pipe-network.js';
import { makeWorkerPeer } from '../src/core/worker-peer.js';
import { makeTestOcapn } from './_util.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();
const textEncoder = new TextEncoder();
/** @param {string} text */
const bytesOf = text => frozenBytes(textEncoder.encode(text));

const CALLER_SOURCE = `
Far('Caller', {
  run: async n => {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += await E(adapter).ping(i);
    return sum;
  },
})
`;

const QUESTIONS = 25;

const setup = async () => {
  /** @type {any} */
  let persisted;
  const store = {
    getState: () => persisted,
    setState: (/** @type {any} */ state) => {
      persisted = JSON.parse(JSON.stringify(state));
    },
  };
  const hub = makeOcapnHub({ codec: syrupCodec, store });
  const workerId = 'a'.repeat(32);
  const adapterKey = 'transient:native:test';

  /** @type {any} */
  let workerSink;
  /** @type {Uint8Array[]} */
  const workerPending = [];
  const worker = await makeWorkerPeer(nodePowers, {
    workerId,
    debugLabel: 'asker',
    // No gc frames from the asker, as from a realm without WeakRef:
    // retirement alone must release the rows.
    enableImportCollection: false,
    send: frame => {
      if (workerSink === undefined) workerPending.push(frame);
      else workerSink.deliver(frame);
    },
  });
  workerSink = hub.attachSession(workerId, {
    send: (/** @type {Uint8Array} */ bytes) => worker.deliver(bytes),
    durable: true,
  });
  for (const frame of workerPending.splice(0)) workerSink.deliver(frame);

  /** @type {any} */
  let adapterSink;
  /** @type {Uint8Array[]} */
  const adapterPending = [];
  const pipe = makePipeNetwork({
    codec: syrupCodec,
    workerId: adapterKey,
    role: 'worker',
    send: frame => {
      if (adapterSink === undefined) adapterPending.push(frame);
      else adapterSink.deliver(frame);
    },
  });
  const client = await makeTestOcapn({
    codec: syrupCodec,
    network: pipe.network,
    debugLabel: 'adapter',
  });
  const session = await client.provideSession(pipe.peerLocation);
  adapterSink = hub.attachSession(adapterKey, {
    send: (/** @type {Uint8Array} */ bytes) => pipe.deliver(bytes),
    durable: false,
  });
  for (const frame of adapterPending.splice(0)) adapterSink.deliver(frame);

  hub.publish('worker', { session: workerId, position: 0n });
  const shell = await E(
    E(session.getBootstrap()).fetch(bytesOf('worker')),
  ).fetch(bytesOf('shell'));
  const adapter = Far('Adapter', { ping: (/** @type {number} */ n) => n });
  const caller = await E(shell).evaluate(CALLER_SOURCE, { adapter });

  /** Answer rows at the adapter, and worker routes naming them. */
  const census = () => {
    const rows = Object.entries(persisted.refs).filter(
      ([, row]) =>
        /** @type {any} */ (row).origin === adapterKey &&
        /** @type {any} */ (row).backing === 'answer',
    );
    const ids = new Set(rows.map(([refId]) => refId));
    /** @type {Array<any>} */
    const owed = Object.values(persisted.sessions[workerId].answersOwed);
    const routes = owed.filter(route => ids.has(route.ref));
    const retired = owed.filter(
      route => route.local === null && /retired/.test(route.reason),
    );
    return {
      rows: rows.length,
      routes: routes.length,
      retired: retired.length,
    };
  };

  return { hub, worker, client, caller, census, adapterKey };
};

test('retiring the answerer releases the answer rows a durable asker still routes to', async t => {
  t.timeout(60_000);
  const { hub, worker, client, caller, census, adapterKey } = await setup();
  t.teardown(() => client.shutdown());
  t.teardown(() => worker.shutdown());

  t.is(await E(caller).run(QUESTIONS), (QUESTIONS * (QUESTIONS - 1)) / 2);
  const settled = census();
  // While the answerer lives and the asker sends no gc frames: one row and
  // one route per question.
  t.true(settled.rows >= QUESTIONS, `rows ${settled.rows}`);
  t.true(settled.routes >= QUESTIONS, `routes ${settled.routes}`);

  hub.forgetSession(adapterKey);

  const forgotten = census();
  t.is(forgotten.rows, 0, 'no tombstone of an answer survives retirement');
  t.is(forgotten.routes, 0);
  // Each route still answers its position, now with the retirement's
  // break: a later pipelined send on it breaks as it did at a tombstone.
  t.is(forgotten.retired, settled.routes);
});
