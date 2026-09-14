// @ts-check
/**
 * The mechanism under designs/manual-persistence-vats.md.
 *
 * A guest awaiting a host *answer* loses it when the host restarts. A guest
 * listening on a host *promise* does not, provided the host can re-create that
 * promise from the durable description its resource factory is keyed by.
 *
 * Two properties, both load-bearing and neither obvious.
 */
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import harden from '@endo/harden';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

/** @param {() => Promise<boolean>} predicate */
const tickUntil = async predicate => {
  for (let i = 0; i < 500; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await macrotask();
  }
  return false;
};

test.serial(
  'a host promise resource re-seats and settles after a restart',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-restorable-'));
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    /** Settlers are per-process: the first incarnation's are gone after a crash. */
    /** @type {Map<string, (value: unknown) => void>} */
    const settlers = new Map();
    const resources = {
      'pending-value': (/** @type {any} */ description) => {
        const promise = new Promise(resolve => {
          settlers.set(JSON.stringify(description), resolve);
        });
        void promise.catch(() => {});
        return promise;
      },
    };
    /** @param {string} path */
    const makeDaemon = path =>
      makeThixotropeDaemon(nodePowers, {
        store: makeFsStore(nodePowers, path),
        engine: makePeerSnapshottingReplayEngine(nodePowers),
        codec: syrupCodec,
        resources,
        makeNetlayer: ({ handlers, logger }) =>
          makeTcpNetLayer({ handlers, logger }),
      });

    {
      const d1 = await makeDaemon(statePath);
      const worker = await d1.createWorker({ debugLabel: 'listener' });
      const pending = d1.makeResource('pending-value', { id: 'a1' });
      const watcher = await worker.evaluate(
        `
      (() => {
        let got = null;
        Promise.resolve(pending).then(value => { got = value; });
        return Far('Watcher', { getGot: () => got });
      })()
      `,
        { pending },
      );
      t.is(await E(watcher).getGot(), null);
      d1.publish(watcher, 'watcher-cap');
      await worker.sleep();
      await d1.crash();
    }

    settlers.clear();

    {
      const d2 = await makeDaemon(statePath);
      t.teardown(() => d2.shutdown());
      const watcher = await d2.lookup('watcher-cap');
      t.is(await E(watcher).getGot(), null, 'still pending after the restart');

      // Re-seating the guest's export re-ran the factory for the same
      // description, so this process owns a fresh resolver for the same alarm.
      const settle = settlers.get(JSON.stringify({ id: 'a1' }));
      t.truthy(settle, 'the factory re-ran for the same description');
      settle?.('after-restart');

      /** @type {any} */
      let got = null;
      const ok = await tickUntil(async () => {
        got = await E(watcher).getGot();
        return got !== null;
      });
      t.true(ok);
      t.is(got, 'after-restart', 'the settlement reached the listener');
    }
  },
);

test.serial(
  'a promise reaches a guest as a reference only inside a record',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-handover-'));
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    /** @type {(value: unknown) => void} */
    let settle = () => {};
    const held = new Promise(resolve => {
      settle = resolve;
    });
    void held.catch(() => {});

    const daemon = await makeThixotropeDaemon(nodePowers, {
      store: makeFsStore(nodePowers, statePath),
      engine: makePeerSnapshottingReplayEngine(nodePowers),
      codec: syrupCodec,
      resources: {
        gate: () =>
          Far('Gate', {
            bare: () => held,
            wrapped: () => harden({ settlement: held }),
          }),
      },
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    });
    t.teardown(() => daemon.shutdown());

    const worker = await daemon.createWorker({ debugLabel: 'handover' });
    const gate = daemon.makeResource('gate');
    const probe = await worker.evaluate(
      `
    (() => {
      let wrapped = false;
      let bare = false;
      return Far('Probe', {
        callWrapped: () => { E(gate).wrapped().then(() => { wrapped = true; }); },
        callBare: () => { E(gate).bare().then(() => { bare = true; }); },
        state: () => harden({ wrapped, bare }),
      });
    })()
    `,
      { gate },
    );

    await E(probe).callWrapped();
    await E(probe).callBare();
    await tickUntil(async () => (await E(probe).state()).wrapped);
    const state = await E(probe).state();

    t.true(state.wrapped, 'a record answer settles without waiting');
    t.false(
      state.bare,
      'a bare promise return becomes the answer, so the call waits for it — ' +
        'which would also make it abort on restart, the opposite of what an ' +
        'alarm needs',
    );

    // Settle before teardown so the held promise leaves no pending listener.
    settle('done');
    await tickUntil(async () => (await E(probe).state()).bare);
  },
);
