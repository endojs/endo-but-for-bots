// @ts-check
import { decodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../../src/core/daemon.js';
import {
  callerSource,
  counterSource,
} from '../../src/ironhorse/demo-counter-vats.js';
import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { makeFsStore } from '../../src/store/store-fs.js';

import { makeNodePowers } from '../../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @import { ExecutionContext } from 'ava' */
/** @import { WorkerEngine } from '../../src/core/worker-engine.js' */

const packagePath = fileURLToPath(new URL('../../', import.meta.url));
const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  join(packagePath, '../../target/release/thixotrope-ironhorse-worker');
const bootPaths = harden(
  ['boot.js', 'worker-peer.js'].map(name =>
    join(
      process.env.THIXOTROPE_BOOT_DIR ?? join(packagePath, 'dist-ironhorse'),
      name,
    ),
  ),
);
// Fail at module load, never turn missing CI artifacts into skipped tests.
await Promise.all([workerBinary, ...bootPaths].map(path => access(path)));

/**
 * Each test owns two real guest processes and an independent comms/store.
 * @param {ExecutionContext} t
 * @param {{ ownerSource?: string, guestSource?: string, endowment?: string, gcPolicy?: import('../../src/ironhorse/ironhorse-limits.js').GcPolicyName }} [options]
 *   gcPolicy: the workers' collection schedule (default: the limits' default)
 */
export const makeFixture = async (
  t,
  {
    ownerSource = counterSource,
    guestSource = callerSource,
    endowment = 'counter',
    gcPolicy = undefined,
  } = {},
) => {
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-ci-'));
  /** @type {Awaited<ReturnType<typeof makeThixotropeDaemon>> | undefined} */
  let daemon;
  t.teardown(async () => {
    try {
      await daemon?.crash();
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  });
  const store = makeFsStore(nodePowers, statePath);
  const rawEngine = makeIronhorseEngine(nodePowers, {
    workerBinary,
    bootPaths,
    storePath: join(statePath, 'heaps'),
    gcPolicy,
  });
  const injected = [];
  /** @type {{ phase: string, observed: () => void } | undefined} */
  let fault;
  /**
   * @param {string} phase
   * @param {string} debugName
   */
  const inject = (phase, debugName) => {
    if (fault?.phase !== phase || !debugName.startsWith('owner(')) return;
    const { observed } = fault;
    fault = undefined;
    injected.push(phase);
    observed();
    throw Error(`injected ${phase}`);
  };
  /** @type {WorkerEngine} */
  const engine = harden({
    ...rawEngine,
    start: async options => {
      let incrementCrank = false;
      const worker = await rawEngine.start({
        ...options,
        onOutboundBatch:
          options.onOutboundBatch === undefined
            ? undefined
            : frames => {
                if (incrementCrank && frames.length > 0)
                  inject('after commit before outbound', options.debugName);
                options.onOutboundBatch?.(frames);
              },
        onOutbound: frame => {
          if (incrementCrank)
            inject('after commit before outbound', options.debugName);
          options.onOutbound(frame);
        },
      });
      /** @param {any} message */
      const isIncrement = message => {
        if (
          !fault ||
          !options.debugName.startsWith('owner(') ||
          message.t !== 'f' ||
          typeof message.b64 !== 'string'
        ) {
          return false;
        }
        // Match the actual counter call, not introductions or GC traffic.
        const reader = syrupCodec.makeReader(decodeBase64(message.b64));
        reader.enterRecord();
        if (reader.readSelectorAsString() !== 'op:deliver') return false;
        reader.enterRecord();
        reader.readSelectorAsString();
        reader.readInteger();
        reader.exitRecord();
        reader.enterList();
        return reader.readSelectorAsString() === 'incr';
      };
      /**
       * @param {any[]} messages one crank's frames
       * @param {() => Promise<void>} run
       */
      const crank = async (messages, run) => {
        incrementCrank = messages.some(isIncrement);
        try {
          if (incrementCrank) inject('before delivery', options.debugName);
          await run();
        } finally {
          incrementCrank = false;
        }
      };
      const { deliverBatch } = worker;
      return harden({
        ...worker,
        deliver: async message =>
          crank([message], () => worker.deliver(message)),
        // GC frames held for the counter call share its crank.
        ...(deliverBatch === undefined
          ? {}
          : {
              deliverBatch: async (/** @type {any[]} */ messages) =>
                crank(messages, () => deliverBatch(messages)),
            }),
      });
    },
  });
  const start = () =>
    makeThixotropeDaemon(nodePowers, {
      store,
      engine,
      codec: syrupCodec,
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    });
  daemon = await start();
  const ownerVat = await daemon.createWorker({ debugLabel: 'owner' });
  const guestVat = await daemon.createWorker({ debugLabel: 'guest' });
  const owner = await ownerVat.evaluate(ownerSource);
  const guest = await guestVat.evaluate(guestSource, { [endowment]: owner });
  const publication = daemon.publish(guest);
  return harden({
    statePath,
    store,
    publication,
    ownerId: ownerVat.workerId,
    guestId: guestVat.workerId,
    get daemon() {
      if (!daemon) throw Error('fixture not started');
      return daemon;
    },
    // The source strings define each test's interface; evaluate/lookup are
    // deliberately untyped capability boundaries.
    guest: () => /** @type {Promise<any>} */ (daemon?.lookup(publication)),
    get injectedFaults() {
      return [...injected];
    },
    /**
     * @param {boolean} [crash]
     * @param {() => Promise<void>} [beforeStart]
     */
    restart: async (crash = false, beforeStart = async () => {}) => {
      if (crash) await daemon?.crash();
      else await daemon?.shutdown();
      if (!crash) {
        // Both guest heaps must exist before starting a fresh daemon.
        for (const id of [ownerVat.workerId, guestVat.workerId]) {
          const snapshot = store.provideWorkerStore(id).getMeta().snapshot;
          t.truthy(snapshot);
          // eslint-disable-next-line no-await-in-loop
          await access(
            join(statePath, 'heaps', 'snapshots', `${snapshot?.ref}.sqlite`),
          );
        }
      }
      await beforeStart();
      daemon = await start();
    },
    /** @param {'before delivery' | 'after commit before outbound'} phase */
    armFault: phase =>
      new Promise(resolve => {
        fault = { phase, observed: () => resolve(undefined) };
      }),
  });
};
harden(makeFixture);

/**
 * Wait for a settlement traveling through comms, with a test-owned deadline.
 * @param {any} listener
 * @returns {Promise<any>}
 */
export const settled = async listener => {
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await E(listener).read();
    if (result.settled) return result;
  }
  throw Error('listener did not settle after 100 comms round trips');
};
harden(settled);
