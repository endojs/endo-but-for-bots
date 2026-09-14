// @ts-check
/**
 * SKETCH test for the manual-persistence HTTP split. The host holds no durable
 * state at all; the vat holds the desired set and re-offers it on reconcile,
 * which is what an eager pin would call. See designs/manual-persistence-vats.md.
 *
 * The vat here is a plain object rather than a real worker: this exercises the
 * host/guest split and the generation contract, not persistence, which
 * durable-alarms.test.js covers.
 */
import test from '@endo/ses-ava/test.js';

import { request } from 'node:http';
import { createServer } from 'node:net';

import { E, Far } from '@endo/far';
import harden from '@endo/harden';

import { makeGuestHttpServices } from '../src/http/guest-http.js';
import { makeHostListeners } from '../src/http/host-listeners.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

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

/** @param {number} port @param {string} [body] */
const call = (port, body = '') =>
  new Promise(resolve => {
    const outgoing = request(
      { host: '127.0.0.1', port, path: '/', method: 'POST', agent: false },
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
    outgoing.once('error', error => resolve({ error }));
    outgoing.end(body);
  });

/** The "vat": a handler plus the guest service, both surviving host restarts. */
const makeVat = listeners => {
  let seen = 0;
  const handler = Far('Handler', {
    handle: (/** @type {any} */ req) => {
      seen += 1;
      return harden({ status: 200, body: `${req.body}:${seen}` });
    },
  });
  return {
    handler,
    services: makeGuestHttpServices(listeners),
    seen: () => seen,
  };
};

test.serial(
  'a vat serves, and survives a host it never saw restart',
  async t => {
    t.timeout(30_000);
    const port = await freePort();

    // The vat's heap outlives every host below. Standing in for the endpoint
    // re-providing a resource by description: the vat keeps one reference, and
    // it resolves to whichever host incarnation is current.
    /** @type {any} */
    let currentHost;
    const granted = Far('GrantedListeners', {
      listen: (/** @type {any} */ options) => E(currentHost).listen(options),
      list: () => E(currentHost).list(),
    });
    const vat = makeVat(granted);

    const host1 = makeHostListeners(nodePowers);
    currentHost = host1.facet();

    await E(vat.services).serve('demo', port, vat.handler);
    t.deepEqual(await call(port, 'one'), { status: 200, body: 'one:1' });
    t.is(host1.status().bound, 1n);

    // The host dies. Nothing of its state is written anywhere.
    await host1.shutdown();
    t.deepEqual(await E(vat.services).list(), [
      { id: 'demo', port, url: `http://127.0.0.1:${port}/` },
    ]);

    const host2 = makeHostListeners(nodePowers);
    t.teardown(() => host2.shutdown());
    currentHost = host2.facet();
    t.is(host2.status().bound, 0n, 'the new host knows nothing');

    // What an eager pin would call on wake.
    t.deepEqual(await E(vat.services).reconcile(), [{ id: 'demo' }]);
    t.is(host2.status().bound, 1n, 'the vat re-established it');
    t.deepEqual(await call(port, 'two'), { status: 200, body: 'two:2' });
  },
);

test.serial('reconcile is idempotent within one host lifetime', async t => {
  t.timeout(30_000);
  const port = await freePort();
  const host = makeHostListeners(nodePowers);
  t.teardown(() => host.shutdown());
  const vat = makeVat(host.facet());

  await E(vat.services).serve('demo', port, vat.handler);
  await E(vat.services).reconcile();
  await E(vat.services).reconcile();
  t.is(host.status().bound, 1n, 'still one binding, not three');
  t.deepEqual(await call(port, 'x'), { status: 200, body: 'x:1' });
});

test.serial('a stale binding cannot close its replacement', async t => {
  t.timeout(30_000);
  const port = await freePort();
  const host = makeHostListeners(nodePowers);
  t.teardown(() => host.shutdown());
  const facet = host.facet();

  const first = Far('First', {
    handle: () => harden({ status: 200, body: 'first' }),
  });
  const second = Far('Second', {
    handle: () => harden({ status: 200, body: 'second' }),
  });

  const { binding: stale } = await E(facet).listen({ port, handler: first });
  t.true(await E(stale).close());
  t.deepEqual((await E(stale).status()).current, false);

  const { binding: current } = await E(facet).listen({
    port,
    handler: second,
  });
  t.deepEqual(await call(port), { status: 200, body: 'second' });

  // The vat still holds the old handle. Closing it must not take down the
  // binding that replaced it.
  t.false(await E(stale).close(), 'the stale handle released nothing');
  t.deepEqual(await call(port), { status: 200, body: 'second' });
  t.true(await E(current).close());
});

test.serial('a port already bound to another handler is refused', async t => {
  t.timeout(30_000);
  const port = await freePort();
  const host = makeHostListeners(nodePowers);
  t.teardown(() => host.shutdown());
  const facet = host.facet();
  const a = Far('A', { handle: () => harden({ status: 200, body: 'a' }) });
  const b = Far('B', { handle: () => harden({ status: 200, body: 'b' }) });

  await E(facet).listen({ port, handler: a });
  await t.throwsAsync(() => E(facet).listen({ port, handler: b }), {
    message: /already bound to another handler/,
  });
});
