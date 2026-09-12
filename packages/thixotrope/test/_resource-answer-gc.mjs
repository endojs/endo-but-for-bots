// Capture diagnostic powers before SES removes them from guest globals.
const { gc, WeakRef: HostWeakRef } = globalThis;
if (!gc) throw Error('This fixture requires --expose-gc');
await import('@endo/init');
const { makeNodePowers } = await import('../src/platform/node-powers.js');
const nodePowers = makeNodePowers();
const { E, Far } = await import('@endo/far');
const { syrupCodec } = await import('@endo/ocapn/syrup');
const { setImmediate } = await import('node:timers/promises');
const { makeThixotropeDaemon } = await import('../src/core/daemon.js');
const { makePeerJournalReplayEngine } =
  await import('../src/core/peer-replay-engine.js');
const { makeMemoryStore } = await import('../src/store/store-memory.js');
const { makeWorkerSessionRecords } =
  await import('../src/core/worker-session-records.js');

const collect = async () => {
  for (let i = 0; i < 20; i += 1) {
    // A WeakRef keeps its target alive until the next turn.
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
    gc();
  }
  await setImmediate();
};

// Exercise settlement release independently of the protocol's other caches.
const records = makeWorkerSessionRecords({
  store: makeMemoryStore(),
  reportError: error => {
    throw error;
  },
});
const connection = {};
const endpointId = 'e'.repeat(32);
/** @type {object | undefined} */
let resolver = Far('Resolver', {});
const weak = new HostWeakRef(resolver);
records.registerWorkerConnection(connection, endpointId);
records.registerResumedSession(endpointId, {
  provideImport: () => resolver,
});
records.sessionHooks.onPendingResolver(connection, 'o-1', {
  kind: 'answer',
  position: 1n,
});
resolver = undefined;
await collect();
if (!weak.deref()) throw Error('Pending obligation lost its resolver');
records.sessionHooks.onResolverSettled(connection, 'o-1');
await collect();
if (weak.deref()) throw Error('Settled obligation retained its resolver');

// A real unrooted host promise must retain its durable route until restart.
const store = makeMemoryStore();
/** @type {() => void} */
let entered = () => {};
const gateEntered = new Promise(resolve => {
  entered = () => resolve(undefined);
});
const options = {
  store,
  engine: makePeerJournalReplayEngine(nodePowers),
  codec: syrupCodec,
  resources: {
    gate: () =>
      Far('Gate', {
        wait: () => {
          entered();
          return new Promise(() => {});
        },
      }),
  },
  makeNetlayer: () => ({
    location: {
      type: 'ocapn-peer',
      transport: 'test',
      designator: 'resource-gc',
      hints: false,
    },
    shutdown() {},
  }),
};
let daemon = await makeThixotropeDaemon(nodePowers, options);
try {
  const worker = await daemon.createWorker();
  const waiter = await worker.evaluate(
    `(() => {
      const failed = E(gate).wait().catch(error => error.message);
      return Far('Waiter', { ping: () => true, failure: () => failed });
    })()`,
    { gate: daemon.makeResource('gate') },
  );
  const secret = daemon.publish(waiter);
  await E(waiter).ping();
  await gateEntered;
  const record = store.provideWorkerStore(endpointId).getTablesRecord();
  if (!record?.pendingResolvers) throw Error('Missing host answer record');
  const pending = Object.keys(record.pendingResolvers);
  if (pending.length !== 1) throw Error('Expected one host answer obligation');
  await collect();
  const exports = store.getHubState().sessions.endpoint.ourExports;
  if (!(pending[0].slice(2) in exports))
    throw Error('GC released the pending host answer route');
  await daemon.crash();
  daemon = await makeThixotropeDaemon(nodePowers, options);
  const restored = await daemon.lookup(secret);
  const failure = await E(restored).failure();
  if (!/pending answer aborted/.test(failure))
    throw Error('Restart did not reject the abandoned host answer');
} finally {
  await daemon.shutdown();
}
console.log(
  'pending resolver retained; settled resolver released; restart rejected',
);
