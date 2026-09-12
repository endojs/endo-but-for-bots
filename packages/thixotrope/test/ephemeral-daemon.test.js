// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeMemoryStore } from '../src/store/store-memory.js';
import { parkWorkers } from './_park-workers.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

test.serial(
  'disposable daemon clients release unanswered calls and vat roots',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      engine: makePeerJournalReplayEngine(nodePowers),
      codec: syrupCodec,
      makeNetlayer: () => ({
        location: {
          type: 'ocapn-peer',
          network: 'test',
          transport: 'test',
          designator: 'ephemeral',
          hints: false,
        },
        shutdown() {},
      }),
    });

    t.teardown(() => daemon.shutdown());
    const worker = await daemon.createWorker();
    const root = await worker.evaluate(
      "Far('Handler', { handle: () => new Promise(() => {}) })",
    );
    const secret = daemon.publish(root);
    const client = await daemon.openEphemeralClient();
    t.teardown(() => client.close());
    const handler = await client.lookup(secret);
    const result = E(handler).handle();
    result.catch(() => {});
    // A later evaluation lets the worker process the accepted call.
    const marker = await worker.evaluate('true');
    t.true(marker);
    daemon.unpublish(secret);
    await parkWorkers(daemon);
    t.deepEqual(daemon.inspectReachability().collectible, []);
    client.close();
    await t.throwsAsync(() => result, { message: /Session disconnected/ });
    await parkWorkers(daemon);
    t.deepEqual(daemon.inspectReachability().collectible, [worker.workerId]);
    t.false(
      Object.keys(store.getHubState().sessions).some(key =>
        key.startsWith('transient:'),
      ),
    );
    const second = await daemon.openEphemeralClient();
    await daemon.shutdown();
    await t.throwsAsync(() => second.lookup(secret), {
      message: /Ephemeral client closed/,
    });
    await t.throwsAsync(() => daemon.openEphemeralClient(), {
      message: /stopping/,
    });
  },
);

test.serial(
  'failed transient startup cleanup closes transports before releasing ownership',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const engine = makePeerJournalReplayEngine(nodePowers);
    const makeNetlayer = () => ({
      location: {
        type: 'ocapn-peer',
        network: 'test',
        transport: 'test',
        designator: 'cleanup',
        hints: false,
      },
      shutdown() {},
    });
    const first = await makeThixotropeDaemon(nodePowers, {
      store,
      engine,
      codec: syrupCodec,
      makeNetlayer,
    });
    t.teardown(() => first.shutdown());
    await first.openEphemeralClient();
    const crashImage = JSON.parse(JSON.stringify(store.getHubState()));
    const transientKey = Object.keys(crashImage.sessions).find(key =>
      key.startsWith('transient:'),
    );
    t.truthy(transientKey);
    await first.shutdown();
    // Save the session image from before orderly cleanup. No worker ran in this
    // fixture, so only the hub has state to recover; the native test uses SIGKILL.
    store.setHubState(crashImage);
    /** @type {string[]} */
    const events = [];
    await t.throwsAsync(
      () =>
        makeThixotropeDaemon(nodePowers, {
          store: harden({
            ...store,
            setHubState: state => {
              if (
                !Object.keys(state.sessions).some(key =>
                  key.startsWith('transient:'),
                )
              )
                throw Error('injected transient cleanup write failure');
              store.setHubState(state);
            },
          }),
          engine: harden({
            ...engine,
            acquireStore: async () => async () => {
              events.push('release');
            },
          }),
          codec: syrupCodec,
          makeNetlayer: () => ({
            ...makeNetlayer(),
            shutdown: () => {
              events.push('stop transport');
            },
          }),
        }),
      { message: /injected transient cleanup write failure/ },
    );
    t.deepEqual(events, ['stop transport', 'release']);
    const recovered = await makeThixotropeDaemon(nodePowers, {
      store,
      engine,
      codec: syrupCodec,
      makeNetlayer,
    });
    t.teardown(() => recovered.shutdown());
    t.false(
      Object.keys(store.getHubState().sessions).some(key =>
        key.startsWith('transient:'),
      ),
    );
  },
);

test.serial('shutdown drains a client still being constructed', async t => {
  t.timeout(10_000);
  const store = makeMemoryStore();
  let released = false;
  const engine = makePeerJournalReplayEngine(nodePowers);
  const daemon = await makeThixotropeDaemon(nodePowers, {
    store: harden({
      ...store,
      setHubState: state => {
        t.false(
          released,
          'hub writes occur before store ownership is released',
        );
        store.setHubState(state);
      },
    }),
    engine: harden({
      ...engine,
      acquireStore: async () => async () => {
        released = true;
      },
    }),
    codec: syrupCodec,
    makeNetlayer: () => ({
      location: {
        type: 'ocapn-peer',
        network: 'test',
        transport: 'test',
        designator: 'opening',
        hints: false,
      },
      shutdown() {},
    }),
  });
  t.teardown(() => daemon.shutdown());
  const opening = daemon.openEphemeralClient();
  const rejected = t.throwsAsync(() => opening, { message: /stopping/ });
  await daemon.shutdown();
  await rejected;
  t.true(released);
  t.false(
    Object.keys(store.getHubState().sessions).some(key =>
      key.startsWith('transient:'),
    ),
  );
});
