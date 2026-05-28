// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';

import { makeBroker } from '../src/broker/main.js';
import { makeBrokerClient } from '../src/broker-client/index.js';
import { makeOAuthRefresher } from '../src/broker/oauth.js';

/**
 * Open a UDS subscription and yield an interface that lets the test
 * inject requests + read events as they arrive. Mirrors what
 * `broker-client` does but with explicit pump-the-queue control so
 * tests can assert about ordering.
 */
const openSubscriber = socketPath =>
  new Promise(resolve => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    /** @type {object[]} */
    const events = [];
    const settlers = [];
    const settle = () => {
      while (settlers.length > 0 && events.length > 0) {
        const r = settlers.shift();
        r(events.shift());
      }
    };
    conn.on('data', chunk => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        events.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      settle();
    });
    conn.once('connect', () =>
      resolve({
        send: msg => conn.write(`${JSON.stringify(msg)}\n`),
        next: () =>
          new Promise(r => {
            settlers.push(r);
            settle();
          }),
        close: () => conn.destroy(),
      }),
    );
  });

const setupBroker = async (t, opts = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'broker-sub-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'broker.sock');
  const broker = makeBroker({
    socketPath,
    initialCredentials: opts.initialCredentials ?? { apiKey: 'sk-initial' },
    refresher: opts.refresher,
    refreshWindowMs: opts.refreshWindowMs,
    log: opts.log,
  });
  const server = await broker.listen();
  t.teardown(() => new Promise(r => server.close(() => r(undefined))));
  return { socketPath, broker, server };
};

test('subscribe: immediately yields current credentials', async t => {
  const { socketPath } = await setupBroker(t);
  const sub = await openSubscriber(socketPath);
  t.teardown(() => sub.close());

  sub.send({ type: 'subscribe', sessionId: 'sess-A' });
  const first = await sub.next();

  t.is(first.type, 'creds');
  t.is(first.sessionId, 'sess-A');
  t.is(first.credentials.apiKey, 'sk-initial');
});

test('api-key mode: no rotation timer; subscribers stay quiet', async t => {
  const { socketPath } = await setupBroker(t);
  const sub = await openSubscriber(socketPath);
  t.teardown(() => sub.close());

  sub.send({ type: 'subscribe', sessionId: 'sess-A' });
  await sub.next(); // initial

  // No refresher means no further pushes ever. We can't prove a
  // negative directly; we wait a beat and assert the queue is empty
  // by racing next() against a timeout.
  const result = await Promise.race([
    sub.next().then(m => ({ got: m })),
    new Promise(r => setTimeout(() => r({ got: null }), 100)),
  ]);
  t.is(result.got, null, 'no rotation events should arrive in api-key mode');
});

test('refresher push: forced refresh fans out to every subscriber', async t => {
  // The autoschedule path is exercised by setting expiresAt in the
  // past — but that races with subscribe in tests. Here we use a
  // far-future expiry so the scheduler stays quiet, and drive
  // rotations with `broker.forceRefresh()` for deterministic
  // ordering.
  let nthCall = 0;
  const refresher = async () => {
    nthCall += 1;
    return {
      oauthToken: {
        accessToken: `tok-${nthCall}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  };
  const { socketPath, broker } = await setupBroker(t, {
    initialCredentials: {
      oauthToken: {
        accessToken: 'tok-initial',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    refresher,
  });

  const subA = await openSubscriber(socketPath);
  const subB = await openSubscriber(socketPath);
  t.teardown(() => {
    subA.close();
    subB.close();
  });

  subA.send({ type: 'subscribe', sessionId: 'sess-A' });
  subB.send({ type: 'subscribe', sessionId: 'sess-B' });

  const initA = await subA.next();
  const initB = await subB.next();
  t.is(initA.credentials.oauthToken.accessToken, 'tok-initial');
  t.is(initB.credentials.oauthToken.accessToken, 'tok-initial');

  // Force two rotations. Both subscribers must see them in order.
  await broker.forceRefresh();
  await broker.forceRefresh();

  const a1 = await subA.next();
  const b1 = await subB.next();
  const a2 = await subA.next();
  const b2 = await subB.next();
  t.is(a1.credentials.oauthToken.accessToken, 'tok-1');
  t.is(b1.credentials.oauthToken.accessToken, 'tok-1');
  t.is(a2.credentials.oauthToken.accessToken, 'tok-2');
  t.is(b2.credentials.oauthToken.accessToken, 'tok-2');
});

test('refresher failure: forceRefresh propagates the error and leaves state intact', async t => {
  let nthCall = 0;
  const refresher = async () => {
    nthCall += 1;
    if (nthCall === 1) throw new Error('IdP went away');
    return {
      oauthToken: {
        accessToken: 'tok-recovered',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  };
  const { socketPath, broker } = await setupBroker(t, {
    initialCredentials: {
      oauthToken: {
        accessToken: 'tok-initial',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    refresher,
  });

  const sub = await openSubscriber(socketPath);
  t.teardown(() => sub.close());

  sub.send({ type: 'subscribe', sessionId: 'sess-A' });
  const initial = await sub.next();
  t.is(initial.credentials.oauthToken.accessToken, 'tok-initial');

  // First forceRefresh: refresher throws. The broker doesn't
  // broadcast an error from forceRefresh (only the auto-scheduler
  // path does that), but it must propagate the throw to the caller
  // and leave `current` unchanged.
  await t.throwsAsync(() => broker.forceRefresh(), {
    message: /IdP went away/,
  });

  // Second forceRefresh: refresher succeeds and the recovered
  // token reaches subscribers.
  await broker.forceRefresh();
  const recovered = await sub.next();
  t.is(recovered.credentials.oauthToken.accessToken, 'tok-recovered');
});

test('unsubscribe: removes the connection from the subscriber set', async t => {
  // After unsubscribe, a subsequent `forceRefresh()` from another
  // path must not deliver creds to this subscriber. The expiries are
  // pushed well beyond the default refreshWindowMs (5 min) so the
  // auto-scheduler does not race the unsubscribe; rotations come
  // exclusively from forceRefresh().
  let nthCall = 0;
  const refresher = async () => {
    nthCall += 1;
    return {
      oauthToken: {
        accessToken: `tok-${nthCall}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  };
  const { socketPath, broker } = await setupBroker(t, {
    initialCredentials: {
      oauthToken: {
        accessToken: 'tok-0',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    refresher,
  });

  const sub = await openSubscriber(socketPath);
  t.teardown(() => sub.close());

  sub.send({ type: 'subscribe', sessionId: 'sess-A' });
  const initial = await sub.next();
  t.is(initial.type, 'creds');

  sub.send({ type: 'unsubscribe', sessionId: 'sess-A' });
  // Give the broker a tick to process the unsubscribe.
  await new Promise(r => setTimeout(r, 20));

  await broker.forceRefresh();
  // The subscriber should NOT receive a push.
  const stale = await Promise.race([
    sub.next().then(m => ({ got: m })),
    new Promise(r => setTimeout(() => r({ got: null }), 100)),
  ]);
  t.is(stale.got, null, 'unsubscribed connection received a stale push');
});

test('UDS is bound 0600', async t => {
  const { socketPath } = await setupBroker(t);
  const info = await stat(socketPath);
  // eslint-disable-next-line no-bitwise
  const mode = info.mode & 0o777;
  t.is(mode, 0o600);
});

test('malformed JSON line: error response, broker stays alive', async t => {
  const { socketPath } = await setupBroker(t);
  const sub = await openSubscriber(socketPath);
  t.teardown(() => sub.close());

  // Send a raw non-JSON line bypassing send()'s JSON.stringify.
  const raw = net.createConnection(socketPath);
  await new Promise(r => raw.once('connect', r));
  raw.write('this-is-not-json\n');
  const errReply = await new Promise(resolve => {
    let buf = '';
    raw.on('data', chunk => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        raw.destroy();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
  });
  t.is(errReply.type, 'error');

  // Original subscriber still works.
  sub.send({ type: 'subscribe', sessionId: 'sess-A' });
  const ok = await sub.next();
  t.is(ok.type, 'creds');
});

// --- broker-client buffering ---

test('broker-client buffers rotations that arrive before the first onRotate', async t => {
  // The race: `subscribe()` resolves with `initial` once the broker
  // sends its first `creds` reply, and the caller registers
  // `onRotate` from a `.then` microtask after that resolve. If a
  // rotation arrives in the gap between the resolve and the .then
  // running, the broker-client used to dispatch into an empty
  // handlers array and silently drop it. We force the gap by *not*
  // registering onRotate immediately, calling `forceRefresh()` on
  // the broker, waiting a tick, and only then registering. The
  // buffered rotation must drain into the handler.
  let nthCall = 0;
  const refresher = async () => {
    nthCall += 1;
    return {
      oauthToken: {
        accessToken: `tok-${nthCall}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  };
  const { socketPath, broker } = await setupBroker(t, {
    initialCredentials: {
      oauthToken: {
        accessToken: 'tok-initial',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    refresher,
  });

  const client = makeBrokerClient({ socketPath });
  const sub = await client.subscribe('sess-A');
  t.is(sub.initial.oauthToken.accessToken, 'tok-initial');

  // Push a rotation *before* registering onRotate. Then wait for the
  // broker-client's data handler to observe it.
  await broker.forceRefresh();
  await new Promise(r => setTimeout(r, 50));

  /** @type {string[]} */
  const seen = [];
  sub.onRotate(creds => seen.push(creds.oauthToken.accessToken));
  // Buffered rotation must drain synchronously when onRotate runs.
  t.deepEqual(seen, ['tok-1']);

  // And subsequent rotations go straight through.
  await broker.forceRefresh();
  await new Promise(r => setTimeout(r, 50));
  t.deepEqual(seen, ['tok-1', 'tok-2']);

  await sub.close();
});

// --- OAuth refresher unit tests ---

test('OAuth refresher: refresh-token grant against an injected fetch', async t => {
  /** @type {Array<{url: string, body: Record<string,string>}>} */
  const calls = [];
  let nthCall = 0;
  const httpFetch = async req => {
    calls.push(req);
    nthCall += 1;
    return {
      status: 200,
      body: {
        access_token: `at-${nthCall}`,
        refresh_token: `rt-${nthCall + 1}`,
        expires_in: 3600,
        token_type: 'Bearer',
      },
    };
  };
  const oauth = makeOAuthRefresher({
    tokenUrl: 'https://idp.example.com/oauth/token',
    clientId: 'client-1',
    clientSecret: 'secret',
    refreshToken: 'rt-initial',
    scope: ['user:read', 'sandbox:create'],
    httpFetch,
  });

  const first = await oauth.refresh();
  t.is(first.oauthToken.accessToken, 'at-1');
  t.truthy(Date.parse(first.oauthToken.expiresAt));
  t.is(calls[0].url, 'https://idp.example.com/oauth/token');
  t.is(calls[0].body.grant_type, 'refresh_token');
  t.is(calls[0].body.refresh_token, 'rt-initial');
  t.is(calls[0].body.client_id, 'client-1');
  t.is(calls[0].body.client_secret, 'secret');
  t.is(calls[0].body.scope, 'user:read sandbox:create');

  // Second call uses the rotated refresh token (rt-2 from the
  // previous response).
  await oauth.refresh();
  t.is(calls[1].body.refresh_token, 'rt-2');
});

test('OAuth refresher: HTTP non-2xx surfaces the IdP body in the thrown error', async t => {
  const httpFetch = async () => ({
    status: 401,
    body: { error: 'invalid_grant', error_description: 'expired refresh' },
  });
  const oauth = makeOAuthRefresher({
    tokenUrl: 'https://idp.example.com/oauth/token',
    clientId: 'c',
    refreshToken: 'r',
    httpFetch,
  });
  await t.throwsAsync(() => oauth.refresh(), {
    message: /OAuth refresh failed: HTTP 401.*invalid_grant/,
  });
});

test('OAuth refresher: missing access_token in response throws clearly', async t => {
  const httpFetch = async () => ({
    status: 200,
    body: { expires_in: 3600 }, // missing access_token
  });
  const oauth = makeOAuthRefresher({
    tokenUrl: 'https://idp.example.com/oauth/token',
    clientId: 'c',
    refreshToken: 'r',
    httpFetch,
  });
  await t.throwsAsync(() => oauth.refresh(), {
    message: /missing access_token/,
  });
});

test('OAuth refresher: missing expires_in throws (we need expiry for scheduling)', async t => {
  const httpFetch = async () => ({
    status: 200,
    body: { access_token: 'at-1' },
  });
  const oauth = makeOAuthRefresher({
    tokenUrl: 'https://idp.example.com/oauth/token',
    clientId: 'c',
    refreshToken: 'r',
    httpFetch,
  });
  await t.throwsAsync(() => oauth.refresh(), {
    message: /expires_in/,
  });
});
