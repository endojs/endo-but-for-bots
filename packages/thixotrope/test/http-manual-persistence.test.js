// @ts-check
/**
 * HTTP on the durable-manager / ephemeral-adapter pair.
 * See designs/manual-persistence-vats.md.
 *
 * The manager vat is durable and holds the desired set. The adapter vat is
 * ephemeral and holds the bindings. The host holds the sockets, admission and
 * transport limits, and exactly one guest reference: the adapter's.
 */
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makeEphemeralVatKeeper } from '../src/ephemeral-vat-keeper.js';
import { makeHttpAdapter } from '../src/http/http-adapter.js';
import { makeHttpManager } from '../src/http/http-manager.js';
import { makeHttpPorts } from '../src/http/http-port.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { parkWorkers } from './_park-workers.js';

const nodePowers = makeNodePowers();

const freePort = async () => {
  const server = createServer();
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected port');
  await new Promise(resolve => server.close(() => resolve(undefined)));
  return address.port;
};

/**
 * @param {number} port
 * @param {string} [body]
 * @param {Record<string, string>} [headers]
 */
const call = (port, body = '', headers = {}) =>
  new Promise(resolve => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        agent: false,
        headers,
      },
      response => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', chunk => {
          text += chunk;
        });
        response.once('end', () =>
          resolve({ status: response.statusCode, body: text }),
        );
      },
    );
    outgoing.once('error', error => resolve({ error: String(error) }));
    outgoing.end(body);
  });

/** The manager vat's bootstrap: keeper plus manager, both shipped by source. */
const MANAGER_SOURCE = `
  (${makeHttpManager.toString()})({
    makeKeeper: (${makeEphemeralVatKeeper.toString()}),
    vats,
    adapterSource: ${JSON.stringify(`(${makeHttpAdapter.toString()})()`)},
  })
`;

/** A consumer vat: an ordinary durable vat that knows nothing about hosts. */
const CONSUMER_SOURCE = `
  (() => {
    let seen = 0;
    return Far('Consumer', {
      handle: request => {
        seen += 1;
        return harden({ status: 200, body: request.body + ':' + seen });
      },
      seen: () => seen,
    });
  })()
`;

/** @param {string} statePath @param {any} ports */
const makeDaemon = (statePath, ports) =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    codec: syrupCodec,
    resources: { 'http-port': ports.resource },
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });

test.serial('a served vat survives a host restart it never saw', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-http-pair-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const port = await freePort();

  {
    const ports = makeHttpPorts(nodePowers);
    const d1 = await makeDaemon(statePath, ports);
    t.teardown(() => ports.shutdown());
    t.teardown(() => d1.shutdown().catch(() => {}));

    const managerVat = await d1.createWorker({ debugLabel: 'http-manager' });
    const manager = await managerVat.evaluate(MANAGER_SOURCE, {
      vats: d1.makeResource('worker-controller'),
    });
    const consumerVat = await d1.createWorker({ debugLabel: 'consumer' });
    const consumer = await consumerVat.evaluate(CONSUMER_SOURCE);

    d1.publish(manager, 'manager-cap');
    d1.publish(consumer, 'consumer-cap');

    const portCap = d1.makeResource('http-port', { port });
    t.deepEqual(await E(manager).serve('demo', portCap, consumer), {
      id: 'demo',
      port,
    });
    t.deepEqual(await call(port, 'one'), { status: 200, body: 'one:1' });
    t.is(ports.status().bound, 1n, 'the host holds one socket');
    t.is(
      d1.listWorkerIds().length,
      3,
      'manager, consumer, and the ephemeral adapter',
    );

    await parkWorkers(d1);
    await ports.shutdown();
    await d1.crash();
  }

  {
    // A new host: no sockets, and the adapter vat was retired at startup.
    const ports = makeHttpPorts(nodePowers);
    const d2 = await makeDaemon(statePath, ports);
    t.teardown(() => ports.shutdown());
    t.teardown(() => d2.shutdown());

    t.is(ports.status().bound, 0n, 'the new host knows nothing');
    t.is(d2.listWorkerIds().length, 2, 'the adapter did not come back');

    const manager = await d2.lookup('manager-cap');
    t.deepEqual(await E(manager).list(), ['demo'], 'the manager remembers');

    // What an eager pin would call on wake.
    t.deepEqual(await E(manager).reconcile(), [port]);
    t.is(ports.status().bound, 1n, 'the socket is back');
    t.is(d2.listWorkerIds().length, 3, 'a fresh adapter was built');

    // The consumer's own count survived: it is an ordinary durable vat, and
    // nothing about the host restart reached it.
    t.deepEqual(await call(port, 'two'), { status: 200, body: 'two:2' });
  }
});

test.serial('reconcile is idempotent within one host lifetime', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-http-idem-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const port = await freePort();

  const ports = makeHttpPorts(nodePowers);
  const daemon = await makeDaemon(statePath, ports);
  t.teardown(() => ports.shutdown());
  t.teardown(() => daemon.shutdown());

  const managerVat = await daemon.createWorker({ debugLabel: 'http-manager' });
  const manager = await managerVat.evaluate(MANAGER_SOURCE, {
    vats: daemon.makeResource('worker-controller'),
  });
  const consumerVat = await daemon.createWorker({ debugLabel: 'consumer' });
  const consumer = await consumerVat.evaluate(CONSUMER_SOURCE);

  await E(manager).serve(
    'demo',
    daemon.makeResource('http-port', { port }),
    consumer,
  );
  t.deepEqual(await E(manager).reconcile(), [port]);
  t.deepEqual(await E(manager).reconcile(), [port]);
  t.is(ports.status().bound, 1n, 'still one socket, not three');
  t.is(daemon.listWorkerIds().length, 3, 'still one adapter');
  t.deepEqual(await call(port, 'x'), { status: 200, body: 'x:1' });
});

test.serial('the host releases a port whose adapter vat is gone', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-http-gone-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const port = await freePort();

  const ports = makeHttpPorts(nodePowers);
  const daemon = await makeDaemon(statePath, ports);
  t.teardown(() => ports.shutdown());
  t.teardown(() => daemon.shutdown());

  const managerVat = await daemon.createWorker({ debugLabel: 'http-manager' });
  const manager = await managerVat.evaluate(MANAGER_SOURCE, {
    vats: daemon.makeResource('worker-controller'),
  });
  const consumerVat = await daemon.createWorker({ debugLabel: 'consumer' });
  const consumer = await consumerVat.evaluate(CONSUMER_SOURCE);

  await E(manager).serve(
    'demo',
    daemon.makeResource('http-port', { port }),
    consumer,
  );
  t.deepEqual(await call(port, 'a'), { status: 200, body: 'a:1' });

  // Retire the adapter out from under the host, as a crash would.
  const adapter = daemon
    .inspectWorkers()
    .find(worker => worker.debugLabel === 'http-adapter');
  t.truthy(adapter, 'the adapter vat exists');
  await daemon
    .getWorker(/** @type {{workerId: string}} */ (adapter).workerId)
    .retire();

  // The socket is still open in front of a handler that cannot answer. The
  // first request is what tells the host, and it releases the port.
  const answer = /** @type {any} */ (await call(port, 'b'));
  t.is(answer.status, 503, 'the request is refused');
  t.is(ports.status().bound, 0n, 'and the port was released');
});

test.serial(
  "admission is the adapter's, and the consumer never sees a refusal",
  async t => {
    t.timeout(60_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-http-admit-'));
    t.teardown(() => rm(statePath, { recursive: true, force: true }));
    const port = await freePort();

    const ports = makeHttpPorts(nodePowers);
    const daemon = await makeDaemon(statePath, ports);
    t.teardown(() => ports.shutdown());
    t.teardown(() => daemon.shutdown());

    const managerVat = await daemon.createWorker({
      debugLabel: 'http-manager',
    });
    const manager = await managerVat.evaluate(MANAGER_SOURCE, {
      vats: daemon.makeResource('worker-controller'),
    });
    const consumerVat = await daemon.createWorker({ debugLabel: 'consumer' });
    const consumer = await consumerVat.evaluate(CONSUMER_SOURCE);

    await E(manager).serve(
      'demo',
      daemon.makeResource('http-port', { port }),
      consumer,
    );

    // A cross-site request: the adapter refuses on headers alone.
    const refused = /** @type {any} */ (
      await call(port, 'x', { origin: 'http://evil.example' })
    );
    t.is(refused.status, 403);
    t.is(
      await E(consumer).seen(),
      0,
      'the consumer was never consulted for a refused request',
    );

    // Same-origin still works, and only now does the consumer see anything.
    const served = /** @type {any} */ (await call(port, 'ok'));
    t.deepEqual(served, { status: 200, body: 'ok:1' });
    t.is(await E(consumer).seen(), 1);
  },
);

test.serial('a vat can widen its own admission policy', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-http-origins-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const port = await freePort();

  const ports = makeHttpPorts(nodePowers);
  const daemon = await makeDaemon(statePath, ports);
  t.teardown(() => ports.shutdown());
  t.teardown(() => daemon.shutdown());

  const managerVat = await daemon.createWorker({ debugLabel: 'http-manager' });
  const manager = await managerVat.evaluate(MANAGER_SOURCE, {
    vats: daemon.makeResource('worker-controller'),
  });
  const consumerVat = await daemon.createWorker({ debugLabel: 'consumer' });
  const consumer = await consumerVat.evaluate(CONSUMER_SOURCE);

  // Policy is guest-side now, so this needs no daemon change at all.
  await E(manager).serve(
    'demo',
    daemon.makeResource('http-port', { port }),
    consumer,
    { origins: ['http://allowed.example'] },
  );

  const allowed = /** @type {any} */ (
    await call(port, 'y', { origin: 'http://allowed.example' })
  );
  t.is(allowed.status, 200);
  const denied = /** @type {any} */ (
    await call(port, 'z', { origin: 'http://other.example' })
  );
  t.is(denied.status, 403);
});
