// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { makeClockService } from '../src/clock-service.js';

/** @import {ExecutionContext} from 'ava' */
const deferred = () => {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise(done => {
    resolve = () => done(undefined);
  });
  return { resolve, promise };
};

/**
 * Keep guest compartments across host reconstruction. The forwarding scheduler
 * stands in for the daemon's restored resource export identity; it never grants
 * the clock's private control facet to callers.
 * @param {ExecutionContext} t
 * @param {'allocate'|'evaluate'} [pause]
 */
const setup = async (t, pause) => {
  const statePath = await mkdtemp('/tmp/thix-clock-service-');
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const entered = deferred();
  const resume = deferred();
  /** @type {Map<string, any>} */
  const workers = new Map();
  /** @type {Map<string, any>} */
  const publications = new Map();
  let created = 0;
  let evaluated = 0;
  let clients = 0;
  let time = 100n;
  let daemonAvailable = true;
  /** @type {ReturnType<typeof makeClockService>} */
  let service;
  const daemon = {
    inspectWorkers: () => [...workers.values()],
    listWorkerIds: () => [...workers.keys()],
    /** @param {{debugLabel: string}} options */
    createWorker: async ({ debugLabel }) => {
      created += 1;
      const workerId = created.toString(16).padStart(32, '0');
      const compartment = new Compartment({ E, Far, harden });
      const worker = {
        workerId,
        debugLabel,
        /**
         * @param {string} source
         * @param {Record<string, any>} powers
         */
        evaluate: async (source, powers) => {
          evaluated += 1;
          Object.assign(compartment.globalThis, powers);
          const result = compartment.evaluate(source);
          await null;
          if (pause === 'evaluate') {
            entered.resolve();
            await resume.promise;
          }
          return result;
        },
      };
      workers.set(workerId, worker);
      await null;
      if (pause === 'allocate') {
        entered.resolve();
        await resume.promise;
      }
      return worker;
    },
    /** @param {string} id */
    getWorker: id => workers.get(id),
    /**
     * @param {string} name
     * @param {{workerId: string}} description
     */
    makeResource: (name, description) => {
      t.is(name, 'alarm-scheduler');
      return Far('RestoredSchedulerProxy', {
        /**
         * @param {bigint} id
         * @param {bigint} deadline
         */
        schedule: (id, deadline) =>
          E(service.resource(description)).schedule(id, deadline),
        now: () => E(service.resource(description)).now(),
      });
    },
    /**
     * @param {any} control
     * @param {string} secret
     */
    publish: (control, secret) => {
      publications.set(secret, control);
    },
    openEphemeralClient: async () => {
      clients += 1;
      let closed = false;
      return {
        /** @param {string} secret */
        lookup: secret => publications.get(secret),
        close: () => {
          if (!closed) {
            closed = true;
            clients -= 1;
          }
        },
      };
    },
  };
  const restore = () => {
    service = makeClockService({
      statePath,
      getDaemon: () => {
        if (!daemonAvailable) throw Error('Daemon not assigned');
        return /** @type {any} */ (daemon);
      },
      now: () => time,
    });
    const restored = service;
    t.teardown(() => restored.shutdown());
    return service;
  };
  service = restore();
  return {
    statePath,
    service,
    restore,
    daemon,
    publications,
    entered,
    resume,
    created: () => created,
    evaluated: () => evaluated,
    clients: () => clients,
    /** @param {bigint} value */
    advance: value => {
      time = value;
    },
    /** @param {boolean} value */
    daemonAvailable: value => {
      daemonAvailable = value;
    },
  };
};

test('clock service is lazy, coalesces initialization and caches the public capability', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  const { service } = fixture;
  await service.start();
  t.is(fixture.created(), 0);
  t.false(service.status().configured);
  const [first, second] = await Promise.all([
    service.getClock(),
    service.getClock(),
  ]);
  t.is(first, second);
  t.is(fixture.created(), 1);
  t.is(fixture.evaluated(), 1);
  t.is(await E(first).now(), 100n);
  t.is(await E(first).when(100n), 100n);
  t.is(await service.getClock(), first);
  t.is(fixture.evaluated(), 1);
  const config = JSON.parse(
    await readFile(join(fixture.statePath, 'clock.json'), 'utf8'),
  );
  t.deepEqual(Object.keys(config).sort(), [
    'allocationId',
    'secret',
    'version',
    'workerId',
  ]);
  t.regex(config.secret, /^[0-9a-f]{32}$/);
  // OCapN's standard introspection method is a protocol-defined name.
  // eslint-disable-next-line no-underscore-dangle
  t.false((await E(first).__getMethodNames__()).includes('fire'));
  await service.shutdown();
  t.is(fixture.clients(), 0);
});

test('clock service restoration reuses guest globals, alarm state and stable publication', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  const first = await fixture.service.getClock();
  const pending = E(first).when(1000n);
  await setImmediate();
  const originalPublication = [...fixture.publications];
  const configBefore = await readFile(
    join(fixture.statePath, 'clock.json'),
    'utf8',
  );
  await fixture.service.shutdown();
  fixture.advance(2000n);
  const restored = fixture.restore();
  await restored.start();
  t.is(
    await restored.getClock(),
    first,
    'clockKit is reused within the selected guest heap',
  );
  t.is(await pending, 2000n);
  t.is(fixture.created(), 1);
  t.is(
    fixture.evaluated(),
    2,
    'one idempotent initialization evaluation per host lifetime',
  );
  t.deepEqual([...fixture.publications], originalPublication);
  t.is(
    await readFile(join(fixture.statePath, 'clock.json'), 'utf8'),
    configBefore,
  );
});

test('clock service never adopts a guest vat with the public durable-clock label', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  const hostile = await fixture.daemon.createWorker({
    debugLabel: `durable-clock:${'b'.repeat(32)}`,
  });
  await hostile.evaluate(
    "globalThis.clockKit = Far('SpoofedClockKit', { getControl: () => { throw Error('spoof adopted'); } })",
    {},
  );
  await fixture.service.start();
  t.false(fixture.service.status().configured);
  const clock = await fixture.service.getClock();
  t.is(await E(clock).now(), 100n);
  t.is(fixture.created(), 2);
  t.not(fixture.service.status().workerId, hostile.workerId);
});

test('clock service recovers a private allocation intent whose worker selection did not commit', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  await fixture.service.shutdown();
  const allocationId = 'b'.repeat(32);
  const intent = { version: 1, allocationId, secret: 'c'.repeat(32) };
  await writeFile(
    join(fixture.statePath, 'clock.json'),
    JSON.stringify(intent),
  );
  const worker = await fixture.daemon.createWorker({
    debugLabel: `durable-clock:${allocationId}`,
  });
  const restored = fixture.restore();
  t.throws(() => restored.resource({ workerId: undefined }), {
    message: /Invalid alarm scheduler description/,
  });
  await restored.start();
  t.is(fixture.created(), 1);
  t.is(restored.status().workerId, worker.workerId);
  const selected = JSON.parse(
    await readFile(join(fixture.statePath, 'clock.json'), 'utf8'),
  );
  t.deepEqual(selected, { ...intent, workerId: worker.workerId });
});

test('clock service restores selection before guest initialization and reifies resources inertly', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  const worker = await fixture.daemon.createWorker({
    debugLabel: `durable-clock:${'b'.repeat(32)}`,
  });
  await fixture.service.shutdown();
  const config = {
    version: 1,
    allocationId: 'b'.repeat(32),
    workerId: worker.workerId,
    secret: 'a'.repeat(32),
  };
  await writeFile(
    join(fixture.statePath, 'clock.json'),
    JSON.stringify(config),
  );
  fixture.daemonAvailable(false);
  const restored = fixture.restore();
  const scheduler = restored.resource({ workerId: worker.workerId });
  t.is(restored.resource({ workerId: worker.workerId }), scheduler);
  const time = E(scheduler).now();
  await setImmediate();
  t.is(fixture.clients(), 0);
  t.is(fixture.evaluated(), 0);
  fixture.daemonAvailable(true);
  await restored.start();
  t.is(await time, 100n);
  t.is(fixture.created(), 1);
  t.is(fixture.evaluated(), 1);
  t.true(fixture.publications.has(config.secret));
});

test('clock service rejects malformed and foreign resource or selection metadata', async t => {
  t.timeout(10_000);
  const fixture = await setup(t);
  for (const description of [
    null,
    {},
    { workerId: 'x' },
    { workerId: 'a'.repeat(32) },
  ]) {
    t.throws(() => fixture.service.resource(description), {
      message: /Invalid alarm scheduler description/,
    });
  }
  await fixture.service.shutdown();
  const worker = await fixture.daemon.createWorker({
    debugLabel: 'application',
  });
  await writeFile(
    join(fixture.statePath, 'clock.json'),
    JSON.stringify({
      version: 1,
      allocationId: 'b'.repeat(32),
      workerId: worker.workerId,
      secret: 'a'.repeat(32),
    }),
  );
  const invalidSelection = fixture.restore();
  await t.throwsAsync(() => invalidSelection.start(), {
    message: /does not select a clock vat/,
  });
  t.is(fixture.evaluated(), 0);
  t.is(fixture.publications.size, 0);
  await invalidSelection.shutdown();
  await writeFile(
    join(fixture.statePath, 'clock.json'),
    JSON.stringify({
      version: 1,
      allocationId: 'b'.repeat(32),
      workerId: worker.workerId,
      secret: 'malformed',
    }),
  );
  t.throws(() => fixture.restore(), { message: /Invalid clock metadata/ });
});

for (const phase of /** @type {const} */ (['allocate', 'evaluate'])) {
  test(`clock shutdown drains pending ${phase} without late publication`, async t => {
    t.timeout(10_000);
    const fixture = await setup(t, phase);
    const initialization = fixture.service.getClock();
    const rejected = t.throwsAsync(() => initialization, {
      message: /shut down/,
    });
    await fixture.entered.promise;
    const intent = JSON.parse(
      await readFile(join(fixture.statePath, 'clock.json'), 'utf8'),
    );
    t.regex(intent.allocationId, /^[0-9a-f]{32}$/);
    t.regex(intent.secret, /^[0-9a-f]{32}$/);
    if (phase === 'allocate')
      t.is(
        intent.workerId,
        undefined,
        'private intent commits before worker allocation finishes',
      );
    let stopped = false;
    const stopping = fixture.service.shutdown().then(() => {
      stopped = true;
    });
    await setImmediate();
    t.false(
      stopped,
      'shutdown must wait for the operation that can still affect its heap',
    );
    fixture.resume.resolve();
    await Promise.all([stopping, rejected]);
    t.is(fixture.publications.size, 0);
    t.is(fixture.clients(), 0);
    t.true(fixture.service.status().stopped);
    await t.throwsAsync(() => fixture.service.getClock(), {
      message: /shut down/,
    });
  });
}
