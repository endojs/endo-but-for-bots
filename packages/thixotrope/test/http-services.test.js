// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { setImmediate } from 'node:timers/promises';

import { makeHttpServices } from '../src/http-services.js';

/** @import { ExecutionContext } from 'ava' */
const deferred = () => {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise(done => {
    resolve = done;
  });
  return { resolve, promise };
};
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
 * @param {string | Uint8Array} [body]
 * @param {string} [path]
 * @param {Record<string, string>} [headers]
 */
const call = (port, body = '', path = '/counter', headers = {}) => {
  const answer = deferred();
  const outgoing = request(
    { host: '127.0.0.1', port, path, method: 'POST', agent: false, headers },
    response => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', chunk => {
        text += chunk;
      });
      response.once('end', () =>
        answer.resolve({ status: response.statusCode, body: text }),
      );
      response.once('error', error => answer.resolve({ error }));
    },
  );
  outgoing.once('error', error => answer.resolve({ error }));
  outgoing.end(body);
  return { request: outgoing, answer: answer.promise };
};

/** @param {ExecutionContext} t */
const setup = async t => {
  const statePath = await mkdtemp('/tmp/thix-http-');
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  /** @type {Map<string, any>} */
  const publications = new Map();
  let clients = 0;
  let opened = 0;
  const allOpened = deferred();
  const options = {
    statePath,
    /**
     * @param {any} handler
     * @param {string} secret
     */
    publish: (handler, secret) => {
      publications.set(secret, handler);
    },
    /** @param {string} secret */
    unpublish: secret => {
      publications.delete(secret);
    },
    openClient: async () => {
      clients += 1;
      opened += 1;
      if (opened === 16) allOpened.resolve(undefined);
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
  const manager = makeHttpServices(options);
  t.teardown(() => manager.shutdown());
  const port = await freePort();
  const description = manager.allocate(port);
  const listener = manager.resource(description);
  return {
    manager,
    listener,
    port,
    description,
    options,
    publications,
    clients: () => clients,
    opened: () => opened,
    allOpened,
  };
};

test.serial(
  'HTTP listener persists recipe and restores socket with new request clients',
  async t => {
    t.timeout(10_000);
    const fixture = await setup(t);
    const { manager, listener, port, options, description } = fixture;
    let count = 0n;
    /** @type {any[]} */
    const requests = [];
    const configured = E(listener).listen(
      Far('CounterHttp', {
        handle: input => {
          requests.push(input);
          count += 1n;
          return { status: 201, body: String(count) };
        },
      }),
    );
    await setImmediate();
    t.is(
      fixture.publications.size,
      0,
      'queued listen cannot publish before startup',
    );
    t.is((await E(listener).status()).status, 'inactive');
    await manager.start();
    await configured;
    t.deepEqual(await call(port, 'hello', '/increment?x=1').answer, {
      status: 201,
      body: '1',
    });
    t.deepEqual(requests, [
      { method: 'POST', path: '/increment?x=1', body: 'hello' },
    ]);
    t.is(fixture.clients(), 0);
    await manager.shutdown();
    t.is(manager.list()[0].desired, 'open');
    const restored = makeHttpServices(options);
    t.teardown(() => restored.shutdown());
    const restoredListener = restored.resource(description);
    t.is((await E(restoredListener).status()).status, 'inactive');
    t.truthy(
      (await call(port).answer).error,
      'restoring resources must not bind a socket',
    );
    await restored.start();
    t.deepEqual(await call(port).answer, { status: 201, body: '2' });
    t.is(fixture.opened(), 2);
    t.is(fixture.clients(), 0);
  },
);

test.serial(
  'HTTP close is terminal and an old listener cannot close its replacement',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, publications } = await setup(t);
    const handler = Far('HttpHandler', {
      handle: () => ({ status: 200, body: 'ok' }),
    });
    await manager.start();
    await E(listener).listen(handler);
    await t.throwsAsync(() => E(listener).listen(handler), {
      message: /already configured/,
    });
    await E(listener).close();
    t.is(publications.size, 0);
    await t.throwsAsync(() => E(listener).listen(handler), {
      message: /already configured/,
    });
    const replacement = manager.resource(manager.allocate(port));
    await E(replacement).listen(handler);
    await E(listener).close();
    t.is(publications.size, 1);
    t.deepEqual(await call(port).answer, { status: 200, body: 'ok' });
  },
);

test.serial(
  'HTTP listener recovers interrupted publication preparation as closed',
  async t => {
    t.timeout(10_000);
    const { manager, listener, options, publications, description } =
      await setup(t);
    await manager.shutdown();
    const interrupted = makeHttpServices({
      ...options,
      publish: (handler, secret) => {
        options.publish(handler, secret);
        throw Error('interrupted publication');
      },
    });
    t.teardown(() => interrupted.shutdown());
    const resource = interrupted.resource(description);
    await interrupted.start();
    await t.throwsAsync(() => E(resource).listen(Far('Handler', {})), {
      message: /interrupted publication/,
    });
    t.is(publications.size, 1);
    await interrupted.shutdown();
    const restored = makeHttpServices(options);
    t.teardown(() => restored.shutdown());
    await restored.start();
    t.is(restored.list()[0].desired, 'closed');
    t.is(publications.size, 0);
    t.is((await E(listener).status()).desired, 'allocated');
  },
);

test.serial(
  'HTTP listener exposes bind failure and retries its recipe on restart',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, options } = await setup(t);
    const blocker = createServer();
    t.teardown(() => blocker.close());
    await new Promise(resolve =>
      blocker.listen(port, '127.0.0.1', () => resolve(undefined)),
    );
    await manager.start();
    const result = await E(listener).listen(
      Far('Handler', { handle: () => ({ status: 200, body: 'recovered' }) }),
    );
    t.is(result.desired, 'open');
    t.is(result.status, 'failed');
    t.regex(result.error ?? '', /EADDRINUSE/);
    await new Promise(resolve => blocker.close(() => resolve(undefined)));
    await manager.shutdown();
    const restored = makeHttpServices(options);
    t.teardown(() => restored.shutdown());
    await restored.start();
    t.deepEqual(await call(port).answer, { status: 200, body: 'recovered' });
  },
);

test.serial(
  'HTTP request and response bodies are bounded UTF-8 copies',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, clients } = await setup(t);
    await manager.start();
    await E(listener).listen(
      Far('Handler', {
        handle: ({ body }) => ({
          status: 200,
          body: body === 'large' ? 'x'.repeat(65_537) : body,
        }),
      }),
    );
    t.is((await call(port, 'x'.repeat(65_537)).answer).status, 413);
    t.is((await call(port, new Uint8Array([0xc0, 0xaf])).answer).status, 400);
    t.is((await call(port, 'large').answer).status, 500);
    const boundary = 'é'.repeat(32_768);
    t.deepEqual(await call(port, boundary).answer, {
      status: 200,
      body: boundary,
    });
    t.is(clients(), 0);
  },
);

test.serial(
  'HTTP timeout disconnects its transient client and ignores late results',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, clients } = await setup(t);
    const pending = deferred();
    let calls = 0;
    await manager.start();
    await E(listener).listen(
      Far('PendingHandler', {
        handle: () => {
          calls += 1;
          return pending.promise;
        },
      }),
    );
    const result = await call(port).answer;
    t.is(result.status, 504);
    t.is(clients(), 0);
    pending.resolve({ status: 200, body: 'too late' });
    await setImmediate();
    t.is(calls, 1);
    t.is(clients(), 0);
  },
);

test.serial(
  'HTTP saturation and disconnect release transient clients without reissuing work',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, clients, allOpened } = await setup(t);
    const pending = deferred();
    await manager.start();
    await E(listener).listen(
      Far('PendingHandler', { handle: () => pending.promise }),
    );
    const requests = Array.from({ length: 16 }, () => call(port));
    t.teardown(() => requests.forEach(item => item.request.destroy()));
    await allOpened.promise;
    t.is(clients(), 16);
    t.is((await call(port).answer).status, 503);
    await E(listener).close();
    await Promise.all(requests.map(item => item.answer));
    t.is(clients(), 0);
    pending.resolve({ status: 200, body: 'late' });
    await setImmediate();
    t.is(clients(), 0);
  },
);

test.serial(
  'HTTP port and resource validation does not create recipes or publications',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, publications } = await setup(t);
    for (const invalid of [0, 80, -1, 65_536, 2000.5, NaN])
      t.throws(() => manager.allocate(invalid), { message: /1024/ });
    t.throws(() => manager.allocate(port), { message: /already allocated/ });
    t.throws(() => manager.resource({ id: 'missing' }), {
      message: /Unknown HTTP listener/,
    });
    await t.throwsAsync(() => E(listener).listen({}), { message: /remotable/ });
    t.is(manager.list().length, 1);
    t.is(publications.size, 0);
  },
);

test.serial(
  'HTTP peer disconnect closes the request client while guest work remains pending',
  async t => {
    t.timeout(10_000);
    const { manager, options, description, port, clients } = await setup(t);
    await manager.shutdown();
    const disconnected = deferred();
    const entered = deferred();
    const pending = deferred();
    const live = makeHttpServices({
      ...options,
      openClient: async () => {
        const client = await options.openClient();
        return {
          ...client,
          close: () => {
            client.close();
            disconnected.resolve(undefined);
          },
        };
      },
    });
    t.teardown(() => live.shutdown());
    await live.start();
    await E(live.resource(description)).listen(
      Far('Pending', {
        handle: () => {
          entered.resolve(undefined);
          return pending.promise;
        },
      }),
    );
    const inflight = call(port);
    t.teardown(() => inflight.request.destroy());
    await entered.promise;
    t.is(clients(), 1);
    inflight.request.destroy();
    await disconnected.promise;
    t.is(clients(), 0);
    pending.resolve({ status: 200, body: 'late' });
    await setImmediate();
    t.is(clients(), 0);
  },
);

test.serial(
  'HTTP shutdown closes a client that finishes opening after the request is aborted',
  async t => {
    t.timeout(10_000);
    const { manager, options, description, port } = await setup(t);
    await manager.shutdown();
    const opening = deferred();
    const entered = deferred();
    let closed = 0;
    let lookedUp = 0;
    const live = makeHttpServices({
      ...options,
      openClient: async () => {
        entered.resolve(undefined);
        return opening.promise;
      },
    });
    t.teardown(() => live.shutdown());
    await live.start();
    await E(live.resource(description)).listen(Far('Handler', {}));
    const inflight = call(port);
    t.teardown(() => inflight.request.destroy());
    await entered.promise;
    const stopping = live.shutdown();
    await setImmediate();
    opening.resolve({
      lookup: () => {
        lookedUp += 1;
      },
      close: () => {
        closed += 1;
      },
    });
    await stopping;
    t.is(closed, 1);
    t.is(lookedUp, 0);
    t.truthy((await inflight.answer).error);
  },
);

test.serial(
  'HTTP shutdown rejects configuration waiting for daemon readiness',
  async t => {
    t.timeout(10_000);
    const { manager, listener, publications } = await setup(t);
    const listening = E(listener).listen(Far('Handler', {}));
    const closing = E(listener).close();
    const listenRejected = t.throwsAsync(() => listening, {
      message: /shut down/,
    });
    const closeRejected = t.throwsAsync(() => closing, {
      message: /shut down/,
    });
    await setImmediate();
    t.is(publications.size, 0);
    await manager.shutdown();
    await Promise.all([listenRejected, closeRejected]);
    t.is(publications.size, 0);
  },
);

test.serial(
  'HTTP authority and browser-origin checks run before guest lookup or dispatch',
  async t => {
    t.timeout(10_000);
    const { manager, listener, port, opened } = await setup(t);
    let effects = 0;
    await manager.start();
    await E(listener).listen(
      Far('Handler', {
        handle: () => {
          effects += 1;
          return { status: 200, body: 'accepted' };
        },
      }),
    );
    /** @type {Array<Record<string, string>>} */
    const denied = [
      { host: `attacker.example:${port}` },
      { host: '127.0.0.1' },
      { origin: 'https://attacker.example' },
      { origin: 'null' },
      { origin: `https://127.0.0.1:${port}` },
      { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of denied) {
      // Check each denied request produces a response without dispatching a guest call.
      // eslint-disable-next-line no-await-in-loop
      t.is((await call(port, 'mutate', '/', headers).answer).status, 403);
    }
    t.is(opened(), 0);
    t.is(effects, 0);
    t.is(
      (await call(port).answer).status,
      200,
      'curl without browser metadata is supported',
    );
    t.is(
      (
        await call(port, '', '/', {
          origin: `http://127.0.0.1:${port}`,
          'sec-fetch-site': 'same-origin',
        }).answer
      ).status,
      200,
    );
    t.is(
      (await call(port, '', '/', { 'sec-fetch-site': 'none' }).answer).status,
      200,
    );
    t.is(opened(), 3);
    t.is(effects, 3);
  },
);
