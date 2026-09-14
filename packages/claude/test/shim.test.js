// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeMcpShim } from '../src/shim.js';

const mkShim = forward => makeMcpShim({ forward });

test('initialize returns protocol + tools capability without touching the broker', async t => {
  let forwarded = 0;
  const shim = mkShim(async () => {
    forwarded += 1;
  });
  const res = /** @type {any} */ (
    await shim.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
  );
  t.is(res.result.serverInfo.name, 'endo-claude-shim');
  t.deepEqual(res.result.capabilities, { tools: {} });
  t.is(forwarded, 0);
});

test('tools/list and tools/call forward to the broker', async t => {
  const calls = [];
  const shim = mkShim(async (method, params) => {
    calls.push({ method, params });
    if (method === 'tools/list') return { tools: [{ name: 'writeText' }] };
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  const list = /** @type {any} */ (
    await shim.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
  );
  t.deepEqual(list.result.tools, [{ name: 'writeText' }]);

  const call = /** @type {any} */ (
    await shim.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'writeText', arguments: { path: 'a', text: 'b' } },
    })
  );
  t.deepEqual(call.result.content, [{ type: 'text', text: 'ok' }]);
  t.deepEqual(
    calls.map(c => c.method),
    ['tools/list', 'tools/call'],
  );
});

test('a broker error becomes a JSON-RPC error, not a thrown shim', async t => {
  const shim = mkShim(async () => {
    throw new Error('broker down');
  });
  const res = /** @type {any} */ (
    await shim.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {},
    })
  );
  t.is(res.error.code, -32_000);
  t.is(res.error.message, 'broker down');
});

test('an unknown method is method-not-found; a notification yields no response', async t => {
  const shim = mkShim(async () => ({}));
  const res = /** @type {any} */ (
    await shim.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'nope',
    })
  );
  t.is(res.error.code, -32_601);
  const notif = await shim.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  t.is(notif, undefined);
});

test('a non-2.0 or non-object message is Invalid Request, echoing its id when present', async t => {
  const shim = mkShim(async () => ({}));
  const bad = /** @type {any} */ (
    await shim.handleMessage({ id: 7, method: 'initialize' })
  );
  t.is(bad.error.code, -32_600);
  t.is(bad.id, 7);
  // A message with no usable id null-fills, and never touches the broker.
  const noId = await shim.handleMessage(/** @type {any} */ ('not an object'));
  t.deepEqual(noId, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_600, message: 'Invalid Request' },
  });
});

test('ping is answered with an empty result without touching the broker', async t => {
  let forwarded = 0;
  const shim = mkShim(async () => {
    forwarded += 1;
  });
  const res = await shim.handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'ping',
  });
  t.deepEqual(res, { jsonrpc: '2.0', id: 6, result: {} });
  t.is(forwarded, 0);
});

test('an unknown-method notification and a broker error on a notification both yield no response', async t => {
  const okShim = mkShim(async () => ({}));
  // Unknown method with no id: notification, so the default case stays silent.
  const silent = await okShim.handleMessage({ jsonrpc: '2.0', method: 'nope' });
  t.is(silent, undefined);
  // A broker throw on a notification is swallowed (no id to answer).
  const throwing = mkShim(async () => {
    throw new Error('broker down');
  });
  t.is(
    await throwing.handleMessage({ jsonrpc: '2.0', method: 'tools/call' }),
    undefined,
  );
});

test('handleLine parses newline-delimited JSON-RPC and serializes a response line', async t => {
  const shim = mkShim(async () => ({ tools: [] }));
  const out = await shim.handleLine(
    '{"jsonrpc":"2.0","id":9,"method":"tools/list"}',
  );
  t.is(
    out,
    `${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [] } })}\n`,
  );
  t.is(await shim.handleLine('   '), undefined); // blank line
  const bad = await shim.handleLine('{not json');
  t.regex(bad ?? '', /-32700/); // parse error
});
