// @ts-check
/**
 * Child process for `hub-crash-consistency.test.js` (core candidate C-20 of
 * the harness journal): a hub over the real file store, one durable worker
 * session `W` whose frames go through the real durable worker transport
 * (journal before delivery, one fsync per hub flush), and the traffic that
 * stresses the hub's commit points:
 *
 * - `burst`: a disposable observer `transient:A` (as a native adapter, with
 *   coalesced inbound frames) sends N ordinary deliveries toward W's
 *   exports and then a burst of N GC frames releasing them, one frame per
 *   turn or several per turn; a sequenced session `V` (as another worker,
 *   in crank batches) releases its holds of the same exports.
 * - `ordinary`: only `V`, sending deliveries and releases in crank batches.
 *
 * Every export of W starts held once by A and once by V (crafted hub
 * state), so W is owed exactly one `op:gc-exports` per position, when the
 * last holder lets go: by a GC frame, or by A's retirement after a restart.
 *
 * argv: statePath mode(fresh|recover) scenario(burst|ordinary) n killAt
 * [hubStore(file|log) [compactChars]]
 * With killAt > 0 the process SIGKILLs itself just before its killAt-th
 * durable file operation (a hub.json replacement, a hub log append, image
 * or log reset, or a journal append), so the kill lands at every commit
 * point a run has. With the log hub store (C-2) the crafted starting state
 * is written by the whole-file store, so a fresh run starts by migrating it
 * (its writes are kill points too), and the log compacts whenever it
 * outgrows compactChars (default 4,000 characters) so that compactions are
 * killed as well. It prints one JSON line with the hub's remaining reference
 * rows when it finishes.
 */
/* eslint-disable no-await-in-loop */
import '@endo/init';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeDurableWorkerTransport } from '../src/core/durable-worker-transport.js';
import { makeGcFrameTest, makeOcapnHub } from '../src/net/hub.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeFsStore } from '../src/store/store-fs.js';

const [
  statePath,
  mode,
  scenario,
  nText,
  killAtText,
  hubStoreText,
  compactText,
] = process.argv.slice(2);
const N = Number(nText);
const killAt = Number(killAtText ?? 0);
const hubStore = hubStoreText === 'log' ? 'log' : 'file';
const compactChars = Number(compactText ?? 4000);

const nodePowers = makeNodePowers();
let durableOps = 0;
// The crafted starting state is not a kill point: counting starts after it.
let counting = false;
const tick = () => {
  if (!counting) return;
  durableOps += 1;
  if (killAt > 0 && durableOps === killAt) process.kill(process.pid, 'SIGKILL');
};
const syncFiles = harden({
  ...nodePowers.syncFiles,
  writeTextAtomic: (
    /** @type {string} */ path,
    /** @type {string} */ text,
    /** @type {any} */ options,
  ) => {
    tick();
    nodePowers.syncFiles.writeTextAtomic(path, text, options);
  },
  appendTextDurable: (
    /** @type {string} */ path,
    /** @type {string} */ text,
  ) => {
    tick();
    nodePowers.syncFiles.appendTextDurable(path, text);
  },
});
const store = makeFsStore({ ...nodePowers, syncFiles }, statePath, {
  hubStore,
  hubLog: { compactChars, compactRatio: 0 },
});

const W = 'f'.repeat(32);
const V = 'e'.repeat(32);
const A = 'transient:native:a';

/** @param {(w: any) => void} build */
const frame = build => {
  const writer = syrupCodec.makeWriter();
  build(writer);
  return writer.getBytes();
};
/** @param {number} position @param {number} n */
const ping = (position, n) =>
  frame(w => {
    w.enterRecord();
    w.writeSelectorFromString('op:deliver');
    w.enterRecord();
    w.writeSelectorFromString('desc:export');
    w.writeInteger(BigInt(position));
    w.exitRecord();
    w.enterList();
    w.writeSelectorFromString('ping');
    w.writeInteger(BigInt(n));
    w.exitList();
    w.writeBoolean(false);
    w.writeBoolean(false);
    w.exitRecord();
  });
/** @param {number[]} positions */
const release = positions =>
  frame(w => {
    w.enterRecord();
    w.writeSelectorFromString('op:gc-exports');
    w.enterList();
    for (const p of positions) w.writeInteger(BigInt(p));
    w.exitList();
    w.enterList();
    for (const _ of positions) w.writeInteger(1n);
    w.exitList();
    w.exitRecord();
  });

if (mode === 'fresh') {
  // Every export i of W is held at position i by A and by V.
  /** @type {Record<string, any>} */
  const refs = {};
  /** @type {Record<string, string>} */
  const held = {};
  for (let i = 1; i <= N; i += 1) {
    refs[`r${i}`] = {
      origin: W,
      epoch: 0,
      position: String(i),
      backing: 'export',
      flavor: 'object',
      resolver: false,
      dead: false,
      mentionsIn: 1,
      listeners: [],
      refcounts: scenario === 'burst' ? { [A]: 1, [V]: 1 } : { [V]: 1 },
    };
    held[String(i)] = `r${i}`;
  }
  const session = (/** @type {any} */ extra) => ({
    epoch: 0,
    ourExports: {},
    nextExport: String(N + 1),
    nextAnswer: '1',
    answersOwed: {},
    processedUpTo: '0',
    durable: true,
    queue: [],
    queueSequences: [],
    nextDelivery: '0',
    usedGiftHandoffs: [],
    pendingWithdraws: [],
    nextHandoffCount: '1',
    ...extra,
  });
  // The whole-file store writes it: the log store migrates it.
  makeFsStore(nodePowers, statePath, { hubStore: 'file' }).setHubState({
    version: 2,
    refs,
    publications: {},
    sessions: {
      [W]: session({}),
      [V]: session({ ourExports: held }),
      ...(scenario === 'burst'
        ? { [A]: session({ ourExports: held, durable: false }) }
        : {}),
    },
  });
}

counting = true;
const hub = makeOcapnHub({
  codec: syrupCodec,
  store: harden({
    getState: () => store.getHubState(),
    setState: (/** @type {any} */ state) => store.setHubState(state),
  }),
});

// W: the real transport over the file journal, with an engine that only
// counts what it is given (the journal is what a replay reads).
const engine = harden({
  canSnapshot: false,
  start: async () =>
    harden({
      deliver: async () => {},
      deliverBatch: async () => {},
      terminate: async () => {},
    }),
});
const transport = makeDurableWorkerTransport(
  { timers: nodePowers.timers, logging: nodePowers.logging },
  {
    workerId: W,
    store: store.provideWorkerStore(W),
    engine: /** @type {any} */ (engine),
    isGcFrame: makeGcFrameTest(syrupCodec),
    onFrames: () => {},
    onFrame: () => {},
  },
);
hub.attachSession(W, {
  send: (/** @type {Uint8Array} */ bytes, /** @type {any} */ sequence) =>
    transport.write(bytes, sequence),
  sendBatch: (/** @type {any} */ frames) => transport.writeBatch(frames),
  durable: true,
  requireAcceptance: true,
  deferCleanup: true,
});

// A restarted host forgets the observer the previous process left.
if (mode === 'recover' && store.getHubState()?.sessions?.[A] !== undefined)
  hub.forgetSession(A);

const turn = () => new Promise(resolve => setImmediate(resolve));

// V: its frames carry sequence numbers and are re-sent in full after a
// restart (as a worker's journal replays them); the hub skips what it has.
const vSink = hub.attachSession(V, { send: () => true, durable: true });
/** @type {Array<Array<Uint8Array>>} */
const vCranks = [];
for (let i = 1; i <= N; i += 4) {
  const crank = [];
  for (let j = i; j < Math.min(i + 4, N + 1); j += 1) {
    if (scenario === 'ordinary') crank.push(ping(j, 1000 + j));
    crank.push(release([j]));
  }
  vCranks.push(crank);
}
let vSequence = 0;
for (const crank of vCranks) {
  vSink.deliverBatch(
    crank.map(bytes => {
      vSequence += 1;
      return { bytes, sequenceNumber: vSequence };
    }),
  );
  await turn();
}

if (scenario === 'burst' && mode === 'fresh') {
  const aSink = hub.attachSession(A, {
    send: () => true,
    durable: false,
    discardOnRestart: true,
    coalesceInbound: true,
    onAbort: () => {},
  });
  for (let i = 1; i <= N; i += 1) {
    aSink.deliver(ping(i, i));
    if (i % 3 === 0) await turn();
  }
  await turn();
  // The burst: one release per frame, several frames per turn.
  for (let i = 1; i <= N; i += 1) {
    aSink.deliver(release([i]));
    if (i % 7 === 0) await turn();
  }
  await turn();
}

// Let queued cranks settle.
for (let k = 0; k < 5; k += 1) await turn();
const state = store.getHubState();
process.stdout.write(
  `${JSON.stringify({
    done: true,
    durableOps,
    hubStore: store.hubStoreStats?.(),
    refs: Object.keys(state.refs).sort(),
    queues: Object.fromEntries(
      Object.entries(state.sessions).map(([k, s]) => [
        k,
        /** @type {any} */ (s).queue.length,
      ]),
    ),
  })}\n`,
);
process.exit(0);
