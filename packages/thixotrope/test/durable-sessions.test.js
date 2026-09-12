// @ts-check
import test from '@endo/ses-ava/test.js';

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makeDurableNetLayer } from '../src/net/durable-netlayer.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeTestOcapn } from './_util.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

const COUNTER_SOURCE = `
(() => {
  let count = 0;
  return Far('Counter', {
    incr: () => {
      count += 1;
      return count;
    },
    getCount: () => count,
  });
})()
`;

/**
 * @param {string} statePath
 * @param {number} port 0 to pick a port; a restarted daemon must pin
 *   its predecessor's port so the peer's reconnect finds it
 * @param resources
 */
const makeDaemon = (statePath, port, resources = {}) =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makePeerJournalReplayEngine(nodePowers),
    codec: syrupCodec,
    resources,
    makeNetlayer: ({ handlers, logger, resumption }) =>
      makeDurableNetLayer(nodePowers, {
        handlers,
        logger,
        resumption,
        makeBaseNetlayer: powers =>
          makeTcpNetLayer({
            ...powers,
            specifiedPort: port,
            specifiedDesignator: basename(statePath),
          }),
      }),
  });

/** @param {string} label */
const makeDurableClient = label =>
  makeTestOcapn({
    codec: syrupCodec,
    debugLabel: label,
    network: (handlers, logger) =>
      makeDurableNetLayer(nodePowers, {
        handlers,
        logger,
        makeBaseNetlayer: powers =>
          makeTcpNetLayer({ ...powers, specifiedDesignator: label }),
        reconnectDelayMs: 25,
      }),
  });

test.serial('live remote references survive a daemon restart', async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-durable-sess-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  const daemon1 = await makeDaemon(statePath, 0);
  t.teardown(() => daemon1.shutdown());
  const port = Number(daemon1.location.hints.port);
  const worker = await daemon1.createWorker({ debugLabel: 'counter' });
  const counter = await worker.evaluate(COUNTER_SOURCE);
  const secret = daemon1.publish(counter);

  const client = await makeDurableClient('restart-client');
  t.teardown(() => client.shutdown());

  const remoteCounter = await client.enlivenSturdyRef(
    client.makeSturdyRef(daemon1.location, secret),
  );
  t.is(await E(remoteCounter).incr(), 1);
  t.is(await E(remoteCounter).incr(), 2);

  // Restart: the first daemon shuts down (parking its durable
  // sessions), and a successor process boots from the same store on
  // the same port. The client is never told anything ended.
  await daemon1.shutdown();
  const daemon2 = await makeDaemon(statePath, port);
  t.teardown(() => daemon2.shutdown());

  t.is(
    await E(remoteCounter).incr(),
    3,
    'the same live presence works across the daemon restart',
  );
  t.is(await E(remoteCounter).getCount(), 3, 'no call was lost or doubled');
});

test.serial('a resumed session continues without a handshake', async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-durable-keys-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  const daemon1 = await makeDaemon(statePath, 0);
  t.teardown(() => daemon1.shutdown());
  const port = Number(daemon1.location.hints.port);
  const worker = await daemon1.createWorker({ debugLabel: 'counter' });
  const counter = await worker.evaluate(COUNTER_SOURCE);
  const secret = daemon1.publish(counter);

  const client = await makeDurableClient('keys-client');
  t.teardown(() => client.shutdown());
  const remoteCounter = await client.enlivenSturdyRef(
    client.makeSturdyRef(daemon1.location, secret),
  );
  t.is(await E(remoteCounter).incr(), 1);

  const store = makeFsStore(nodePowers, statePath);
  const [token] = store.listSessionTokens();
  const metaPath = join(statePath, 'sessions', token, 'meta.json');
  const before = JSON.parse(readFileSync(metaPath, 'utf8'));
  t.is(before.version, 2, 'the session records durable acceptance');
  t.true(Number(before.recvSeq) > 0);

  await daemon1.shutdown();
  const daemon2 = await makeDaemon(statePath, port);
  t.teardown(() => daemon2.shutdown());
  t.is(
    await E(remoteCounter).incr(),
    2,
    'the resumed session continued: same hub rows, no new handshake',
  );

  const after = JSON.parse(readFileSync(metaPath, 'utf8'));
  t.true(
    Number(after.recvSeq) > Number(before.recvSeq),
    'the successor advanced the same watermark record',
  );
});

test.serial('a promise resolution crosses a daemon restart', async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-durable-prom-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  const GIFT_SOURCE = `
  (() => {
    let release = null;
    const gift = new Promise(resolve => {
      release = resolve;
    });
    return Far('Gifter', {
      getGift: () => harden({ gift }),
      release: value => {
        release(value);
        return 'released';
      },
    });
  })()
  `;

  const daemon1 = await makeDaemon(statePath, 0);
  t.teardown(() => daemon1.shutdown());
  const port = Number(daemon1.location.hints.port);
  const worker = await daemon1.createWorker({ debugLabel: 'gifter' });
  const gifter = await worker.evaluate(GIFT_SOURCE);
  const secret = daemon1.publish(gifter);

  const client = await makeDurableClient('promise-client');
  t.teardown(() => client.shutdown());
  const remoteGifter = await client.enlivenSturdyRef(
    client.makeSturdyRef(daemon1.location, secret),
  );

  // The client imports the worker's still-pending promise (and its
  // netlayer auto-subscribes to it via op:listen).
  const { gift } = await E(remoteGifter).getGift();
  /** @type {any} */
  let settled;
  const observed = Promise.resolve(gift).then(
    value => {
      settled = { value };
    },
    reason => {
      settled = { reason };
    },
  );

  await daemon1.shutdown();
  const daemon2 = await makeDaemon(statePath, port);
  t.teardown(() => daemon2.shutdown());

  // The worker resolves the promise AFTER the restart: the resolution
  // flows worker -> restored worker-promise export -> re-attached
  // resolver obligation -> client.
  t.is(await E(remoteGifter).release('gifted'), 'released');
  await observed;
  t.deepEqual(
    settled,
    { value: 'gifted' },
    'the promise a client awaited resolved across the daemon restart',
  );
});

test.serial('an answer a resource owes rejects after a restart', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-durable-ans-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  // A host-resource answer is the one kind of pending obligation that
  // genuinely dies with the daemon process: worker heaps replay their
  // pending state, hub rows persist, but a resource promise lives in
  // endpoint memory. The endpoint's records reject it at-most-once on
  // restart, so the guest sees a rejection, never a hang.
  /** @type {() => void} */
  let entered = () => {};
  const gateEntered = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  let calls = 0;
  const resources = {
    gate: () =>
      Far('Gate', {
        wait: () => {
          calls += 1;
          entered();
          return new Promise(() => {});
        },
      }),
  };

  const daemon1 = await makeDaemon(statePath, 0, resources);
  t.teardown(() => daemon1.shutdown());
  const port = Number(daemon1.location.hints.port);
  const worker = await daemon1.createWorker({ debugLabel: 'waiter' });
  const gate = daemon1.makeResource('gate');
  const waiter = await worker.evaluate(
    `
    (() => {
      let failure = null;
      const failed = E(gate)
        .wait()
        .catch(reason => {
          failure = String((reason && reason.message) || reason);
          return failure;
        });
      return Far('Waiter', {
        ping: () => 'pong',
        getFailure: () => failure,
        waitForFailure: () => failed,
      });
    })()
    `,
    { gate },
  );
  const secret = daemon1.publish(waiter);

  const client = await makeDurableClient('answer-client');
  t.teardown(() => client.shutdown());
  const remoteWaiter = await client.enlivenSturdyRef(
    client.makeSturdyRef(daemon1.location, secret),
  );
  t.is(await E(remoteWaiter).ping(), 'pong');
  // A guest ping does not prove that a separate host-resource call arrived.
  // Cross the actual host dispatch boundary before killing its pending answer.
  await gateEntered;
  t.is(calls, 1);
  t.is(await E(remoteWaiter).getFailure(), null, 'the wait is outstanding');

  // Crash, not clean shutdown: the resource promise dies with the
  // process; everything else is rows and heaps.
  await daemon1.crash();
  const daemon2 = await makeDaemon(statePath, port, resources);
  t.teardown(() => daemon2.shutdown());

  t.is(await E(remoteWaiter).ping(), 'pong', 'the session itself resumed');
  // Await the guest's persisted listener instead of a machine-speed-dependent
  // number of status polls. The explicit test timeout still bounds a lost break.
  const failure = await E(remoteWaiter).waitForFailure();
  t.is(calls, 1, 'recovery must not reissue the host-resource invocation');
  t.regex(
    String(failure),
    /aborted/,
    'the guest saw the at-most-once rejection, not a hang',
  );
});

test.serial(
  'a call issued while the daemon is down completes after restart',
  async t => {
    const statePath = await mkdtemp(
      join(tmpdir(), 'thixotrope-durable-sess2-'),
    );
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    const daemon1 = await makeDaemon(statePath, 0);
    t.teardown(() => daemon1.shutdown());
    const port = Number(daemon1.location.hints.port);
    const worker = await daemon1.createWorker({ debugLabel: 'counter' });
    const counter = await worker.evaluate(COUNTER_SOURCE);
    const secret = daemon1.publish(counter);

    const client = await makeDurableClient('gap-client');
    t.teardown(() => client.shutdown());

    const remoteCounter = await client.enlivenSturdyRef(
      client.makeSturdyRef(daemon1.location, secret),
    );
    t.is(await E(remoteCounter).incr(), 1);

    await daemon1.shutdown();

    // The daemon is down: the call buffers in the client's netlayer,
    // which keeps trying to reconnect.
    const stalled = E(remoteCounter).incr();

    const daemon2 = await makeDaemon(statePath, port);
    t.teardown(() => daemon2.shutdown());

    t.is(await stalled, 2, 'the buffered call was delivered to the successor');
  },
);

test.serial('sessions survive repeated daemon restarts', async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-durable-sess3-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  let daemon = await makeDaemon(statePath, 0);
  // The previous instance closes before replacement; always close the current one
  // if an assertion or restart fails. shutdown also reuses an earlier crash.
  t.teardown(() => daemon.shutdown());
  const port = Number(daemon.location.hints.port);
  const worker = await daemon.createWorker({ debugLabel: 'counter' });
  const counter = await worker.evaluate(COUNTER_SOURCE);
  const secret = daemon.publish(counter);

  const client = await makeDurableClient('serial-client');
  t.teardown(() => client.shutdown());

  const remoteCounter = await client.enlivenSturdyRef(
    client.makeSturdyRef(daemon.location, secret),
  );
  t.is(await E(remoteCounter).incr(), 1);

  for (let expected = 2; expected <= 4; expected += 1) {
    // eslint-disable-next-line no-await-in-loop
    await daemon.shutdown();
    // eslint-disable-next-line no-await-in-loop
    daemon = await makeDaemon(statePath, port);
    // eslint-disable-next-line no-await-in-loop
    t.is(await E(remoteCounter).incr(), expected);
  }
  await daemon.shutdown();
});

test.serial(
  'both durable nodes restart and deliver a settlement to the persisted listener',
  async t => {
    t.timeout(20_000);
    const exporterPath = await mkdtemp(
      join(tmpdir(), 'thix-exporter-restart-'),
    );
    t.teardown(() => rm(exporterPath, { recursive: true, force: true }));
    const holderPath = await mkdtemp(join(tmpdir(), 'thix-holder-restart-'));
    t.teardown(() => rm(holderPath, { recursive: true, force: true }));
    const exporter1 = await makeDaemon(exporterPath, 0);
    t.teardown(() => exporter1.shutdown());
    const holder1 = await makeDaemon(holderPath, 0);
    t.teardown(() => holder1.shutdown());
    const exporterPort = Number(exporter1.location.hints.port);
    const holderPort = Number(holder1.location.hints.port);
    const counterWorker = await exporter1.createWorker();
    const counter = await counterWorker.evaluate(`(() => {
      let count = 0;
      let waiting = false;
      let resolveGate;
      const gate = new Promise(resolve => { resolveGate = resolve; });
      return Far('Counter', {
        incr: () => { count += 1; return count; },
        getCount: () => count,
        wait: () => { waiting = true; return gate; },
        isWaiting: () => waiting,
        settle: value => { resolveGate(value); return true; },
      });
    })()`);
    const counterSecret = exporter1.publish(counter);
    const holderWorker = await holder1.createWorker();
    const holder = await holderWorker.evaluate(`(() => {
    let counter;
    let observed = 'pending';
    return Far('Holder', {
      hold: value => { counter = value; return true; },
      incr: () => E(counter).incr(),
      count: () => E(counter).getCount(),
      watch: () => {
        E(counter).wait().then(
          value => { observed = value; },
          () => { observed = 'rejected'; },
        );
        return E(counter).isWaiting();
      },
      observed: () => observed,
    });
  })()`);
    const holderSecret = holder1.publish(holder);
    const gifter = await makeDurableClient('both-restart-gifter');
    t.teardown(() => gifter.shutdown());
    const remoteCounter = await gifter.enlivenSturdyRef(
      gifter.makeSturdyRef(exporter1.location, counterSecret),
    );
    const remoteHolder = await gifter.enlivenSturdyRef(
      gifter.makeSturdyRef(holder1.location, holderSecret),
    );
    t.true(await E(remoteHolder).hold(remoteCounter));
    t.is(await E(remoteCounter).getCount(), 0);
    t.is(await E(remoteHolder).incr(), 1);
    t.true(
      await E(remoteHolder).watch(),
      'the originating call reached the exporter',
    );
    t.is(await E(remoteHolder).observed(), 'pending');
    const store = makeFsStore(nodePowers, holderPath);
    const outgoing = store
      .listSessionTokens()
      .filter(token => store.provideSessionStore(token).getMeta().isOriginator);
    t.is(
      outgoing.length,
      1,
      'gift withdrawal created a durable originating session',
    );
    const before = store.provideSessionStore(outgoing[0]).getMeta();
    t.true(before.hubSessionKey.startsWith('handoff:'));
    await holder1.shutdown();
    await exporter1.shutdown();
    const exporter2 = await makeDaemon(exporterPath, exporterPort);
    t.teardown(() => exporter2.shutdown());
    t.true(await E(remoteCounter).settle('settled while holder was offline'));
    const exporterSession = makeFsStore(
      nodePowers,
      exporterPath,
    ).provideSessionStore(outgoing[0]);
    t.truthy(
      exporterSession.getMeta().frames[0],
      'the exporter retains settlement delivery while the listener node is offline',
    );
    const holder2 = await makeDaemon(holderPath, holderPort);
    t.teardown(() => holder2.shutdown());
    t.is(await E(remoteHolder).incr(), 2);
    t.is(await E(remoteHolder).count(), 2);
    t.is(await E(remoteHolder).observed(), 'settled while holder was offline');
    const after = store.provideSessionStore(outgoing[0]).getMeta();
    t.deepEqual(
      after.identity,
      before.identity,
      'originating session identity was restored',
    );
    t.is(
      after.hubSessionKey,
      before.hubSessionKey,
      'the hub alias was preserved',
    );
  },
);

for (const importFirst of [true, false]) {
  test.serial(
    `publication imports and third-party gifts share a session (${importFirst ? 'import' : 'gift'} first)`,
    async t => {
      t.timeout(20_000);
      const exporterPath = await mkdtemp(
        join(tmpdir(), 'thix-mixed-exporter-'),
      );
      t.teardown(() => rm(exporterPath, { recursive: true, force: true }));
      const holderPath = await mkdtemp(join(tmpdir(), 'thix-mixed-holder-'));
      t.teardown(() => rm(holderPath, { recursive: true, force: true }));
      const exporter = await makeDaemon(exporterPath, 0);
      t.teardown(() => exporter.shutdown());
      const holder = await makeDaemon(holderPath, 0);
      t.teardown(() => holder.shutdown());
      const counterWorker = await exporter.createWorker();
      const counter = await counterWorker.evaluate(COUNTER_SOURCE);
      const secret = exporter.publish(counter);
      const holderWorker = await holder.createWorker();
      const receiver = await holderWorker.evaluate(`(() => {
        let counter;
        return Far('Receiver', {
          hold: value => { counter = value; return true; },
          incr: () => E(counter).incr(),
        });
      })()`);
      const receiverSecret = holder.publish(receiver);
      const gifter = await makeDurableClient('mixed-route-gifter');
      t.teardown(() => gifter.shutdown());
      const remoteCounter = await gifter.enlivenSturdyRef(
        gifter.makeSturdyRef(exporter.location, secret),
      );
      const remoteReceiver = await gifter.enlivenSturdyRef(
        gifter.makeSturdyRef(holder.location, receiverSecret),
      );
      const importCounter = () =>
        holder.importReference(exporter.location, secret);
      const giveCounter = async () => {
        t.true(await E(remoteReceiver).hold(remoteCounter));
        return E(remoteReceiver).incr();
      };
      let imported;
      if (importFirst) {
        imported = await importCounter();
        t.is(await E(imported).incr(), 1);
        t.is(await giveCounter(), 2);
      } else {
        t.is(await giveCounter(), 1);
        imported = await importCounter();
        t.is(await E(imported).incr(), 2);
      }
      t.is(await E(imported).incr(), 3);
      t.is(await E(remoteReceiver).incr(), 4);
      const store = makeFsStore(nodePowers, holderPath);
      const outgoing = store
        .listSessionTokens()
        .filter(
          token => store.provideSessionStore(token).getMeta().isOriginator,
        );
      t.is(outgoing.length, 1);
      const before = store.provideSessionStore(outgoing[0]).getMeta();
      await holder.shutdown();
      const restored = await makeDaemon(
        holderPath,
        Number(holder.location.hints.port),
      );
      t.teardown(() => restored.shutdown());
      t.is(await E(remoteReceiver).incr(), 5);
      const importedAgain = await restored.importReference(
        exporter.location,
        secret,
      );
      t.is(await E(importedAgain).incr(), 6);
      const after = store.provideSessionStore(outgoing[0]).getMeta();
      t.deepEqual(after.identity, before.identity);
      t.is(after.hubSessionKey, before.hubSessionKey);
    },
  );
}
