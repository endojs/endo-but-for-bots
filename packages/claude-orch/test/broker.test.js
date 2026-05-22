// @ts-nocheck
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';

import { makeBroker } from '../src/broker/main.js';

/**
 * Drive a broker over its UDS the same way the orchestrator does.
 * Returns a request fn that round-trips a single JSON line and
 * resolves with the parsed reply, plus a `close` for teardown.
 */
const connectBroker = socketPath =>
  new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.once('error', reject);
    conn.once('connect', () => {
      let buf = '';
      /** @type {((res: any) => void) | null} */
      let resolveNext = null;
      conn.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          const i = buf.indexOf('\n');
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const reply = JSON.parse(line);
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r(reply);
          }
        }
      });
      resolve({
        request: req =>
          new Promise(r => {
            resolveNext = r;
            conn.write(`${JSON.stringify(req)}\n`);
          }),
        close: () => conn.destroy(),
      });
    });
  });

const setupBroker = async (t, opts = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'broker-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'broker.sock');
  const broker = makeBroker({
    socketPath,
    apiKey: 'sk-initial',
    ...opts,
  });
  const server = await broker.listen();
  t.teardown(
    () => new Promise(r => server.close(() => r(undefined))),
  );
  return { socketPath, server };
};

test('broker: issue returns the stored apiKey and tracks per-session state', async t => {
  const { socketPath } = await setupBroker(t);
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  const reply = await client.request({ type: 'issue', sessionId: 'sess-A' });
  t.is(reply.type, 'creds');
  t.is(reply.credentials.apiKey, 'sk-initial');

  // Issue against a different session — same key (single-credential v1
  // broker), distinct tracking.
  const reply2 = await client.request({ type: 'issue', sessionId: 'sess-B' });
  t.is(reply2.type, 'creds');
  t.is(reply2.credentials.apiKey, 'sk-initial');
});

test('broker: revoke drops per-session state without affecting other sessions', async t => {
  const { socketPath } = await setupBroker(t);
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  await client.request({ type: 'issue', sessionId: 'sess-A' });
  await client.request({ type: 'issue', sessionId: 'sess-B' });

  const revoke = await client.request({ type: 'revoke', sessionId: 'sess-A' });
  t.is(revoke.type, 'ok');

  // sess-B can still rotate-or-be-reissued because its entry remains.
  const reissue = await client.request({ type: 'issue', sessionId: 'sess-B' });
  t.is(reissue.type, 'creds');
});

test('broker: rotate_if_needed is a noop by default (pins v1 contract)', async t => {
  // Without a `rotatePolicy`, the broker preserves the documented v1
  // "API-key mode never rotates" behaviour. The README M3 status row
  // marks this `[~]` exactly because this is the noop that needs to
  // become a real rotation in v2.
  const { socketPath } = await setupBroker(t);
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  await client.request({ type: 'issue', sessionId: 'sess-A' });
  const reply = await client.request({
    type: 'rotate_if_needed',
    sessionId: 'sess-A',
  });
  t.is(reply.type, 'noop');
});

test('broker: rotate_if_needed honours an injected rotatePolicy', async t => {
  // Inject a deterministic rotator and prove the broker:
  //  1. returns the new credentials on the rotation request,
  //  2. updates its in-memory credentials so a subsequent `issue` on a
  //     different session sees the rotated key (the broker is a single-
  //     credential store; rotation replaces the global current key),
  //  3. refreshes the per-session entry for an already-issued session.
  let nthCall = 0;
  const rotatePolicy = (_sessionId, _current) => {
    nthCall += 1;
    return nthCall === 1 ? { apiKey: 'sk-rotated-1' } : null;
  };
  const { socketPath } = await setupBroker(t, { rotatePolicy });
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  await client.request({ type: 'issue', sessionId: 'sess-A' });
  const rot = await client.request({
    type: 'rotate_if_needed',
    sessionId: 'sess-A',
  });
  t.is(rot.type, 'creds');
  t.is(rot.credentials.apiKey, 'sk-rotated-1');

  // The current key updated: a fresh issue on a new session sees it.
  const issuedB = await client.request({
    type: 'issue',
    sessionId: 'sess-B',
  });
  t.is(issuedB.credentials.apiKey, 'sk-rotated-1');

  // Second rotation call returns null → broker reports noop.
  const noop = await client.request({
    type: 'rotate_if_needed',
    sessionId: 'sess-B',
  });
  t.is(noop.type, 'noop');
});

test('broker: rotatePolicy returning a non-object yields an error reply', async t => {
  const rotatePolicy = () => /** @type {any} */ ({ apiKey: '' });
  const { socketPath } = await setupBroker(t, { rotatePolicy });
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  const reply = await client.request({
    type: 'rotate_if_needed',
    sessionId: 'sess-A',
  });
  t.is(reply.type, 'error');
  t.regex(reply.message, /rotatePolicy/);
});

test('broker: malformed JSON line keeps the broker alive (no crash)', async t => {
  // kumavis review #1 — pin the JSON.parse-safety fix. Send a non-JSON
  // line; expect an `error` reply; subsequent valid requests still work.
  const { socketPath } = await setupBroker(t);
  const client = await connectBroker(socketPath);
  t.teardown(() => client.close());

  // Use a raw write since `client.request` expects JSON-serializable.
  const reply = await new Promise(resolve => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    conn.on('data', chunk => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        conn.destroy();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
    conn.once('connect', () => conn.write('this-is-not-json\n'));
  });
  t.is(reply.type, 'error');

  // Subsequent valid request still succeeds.
  const issued = await client.request({ type: 'issue', sessionId: 'sess-A' });
  t.is(issued.type, 'creds');
});

test('broker: UDS is bound 0600', async t => {
  const { socketPath } = await setupBroker(t);
  const info = await stat(socketPath);
  // eslint-disable-next-line no-bitwise
  const mode = info.mode & 0o777;
  t.is(mode, 0o600);
});
