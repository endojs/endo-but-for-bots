// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  makeMcpBridge,
  makeMcpBridgeForToolSet,
  pinToolCatalog,
  MAX_PENDING_CALLS,
} from '../src/mcp-bridge.js';

const toolFor = (name, description = '') =>
  harden({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  });

const catalogOf = (...tools) => harden({ dynamicTools: tools });

test('initialize echoes the requested protocol version and advertises tools', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(),
    execute: async () => '',
    name: 'endo',
    version: '9.9.9',
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
  );
  t.is(response.result.protocolVersion, '2025-06-18');
  t.deepEqual(response.result.serverInfo, { name: 'endo', version: '9.9.9' });
  t.truthy(response.result.capabilities.tools);
});

test('notifications/initialized takes no reply', async t => {
  const bridge = makeMcpBridge({ tools: catalogOf(), execute: async () => '' });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  t.is(response, undefined);
});

test('tools/list serves the pinned hosted catalog as MCP tools', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec', 'run code'), toolFor('send')),
    execute: async () => '',
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  );
  t.deepEqual(
    response.result.tools.map(tool => tool.name),
    ['exec', 'send'],
  );
  const exec = response.result.tools[0];
  t.is(exec.description, 'run code');
  t.deepEqual(exec.inputSchema, {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });
  t.deepEqual(bridge.toolNames, ['exec', 'send']);
});

test('tools/call dispatches through execute and wraps the text result', async t => {
  const calls = [];
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('lookup')),
    execute: async (name, args) => {
      calls.push({ name, args });
      return 'the answer';
    },
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'lookup', arguments: { path: 'x' } },
    })
  );
  t.deepEqual(calls, [{ name: 'lookup', args: { path: 'x' } }]);
  t.deepEqual(response.result, {
    content: [{ type: 'text', text: 'the answer' }],
  });
});

test('tools/call refuses a name outside the pinned catalog before execute', async t => {
  let executed = 0;
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('lookup')),
    execute: async () => {
      executed += 1;
      return '';
    },
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'evaluate', arguments: {} },
    })
  );
  t.is(executed, 0);
  t.is(response.error.code, -32_600);
  t.regex(response.error.message, /Unknown tool: evaluate/);
});

test('tools/call surfaces a tool failure as an isError result, not a transport error', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec')),
    execute: async () => {
      throw Error('boom');
    },
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'exec', arguments: {} },
    })
  );
  t.is(response.result.isError, true);
  t.is(response.result.content[0].text, 'Error: boom');
  t.is(response.error, undefined);
});

test('an unknown method returns JSON-RPC method-not-found', async t => {
  const bridge = makeMcpBridge({ tools: catalogOf(), execute: async () => '' });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'does/not/exist',
    })
  );
  t.is(response.error.code, -32_601);
});

test('pinToolCatalog drops names the CLI grammar cannot address', t => {
  const { tools, byName } = pinToolCatalog([
    toolFor('exec'),
    toolFor('bad__name'),
    toolFor('a,b'),
    toolFor('read*'),
    toolFor('__proto__'),
    toolFor('exec'),
  ]);
  t.deepEqual(
    tools.map(tool => tool.name),
    ['exec'],
  );
  t.is(Object.getPrototypeOf(byName), null);
  t.false('constructor' in byName);
});

test('makeMcpBridgeForToolSet pins describe() once and dispatches through execute', async t => {
  let describes = 0;
  const calls = [];
  const toolSet = Far('HostedToolSet', {
    describe: async () => {
      describes += 1;
      return catalogOf(toolFor('listMessages'));
    },
    execute: async (name, args) => {
      calls.push({ name, args });
      return `ran ${name}`;
    },
    help: () => 'test',
  });
  const bridge = await makeMcpBridgeForToolSet(toolSet);
  await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'listMessages', arguments: {} },
    })
  );
  t.is(describes, 1, 'the catalog is pinned, not re-read per request');
  t.deepEqual(calls, [{ name: 'listMessages', args: {} }]);
  t.deepEqual(response.result.content, [
    { type: 'text', text: 'ran listMessages' },
  ]);
});

test('a JSON-RPC batch is refused with a reply rather than dropped', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec')),
    execute: async () => 'ok',
  });
  const response = await bridge.handleMessage([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  ]);
  t.deepEqual(response, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_600, message: 'Expected a single JSON-RPC object' },
  });
});

test('tool admission is synchronous, bounded, reusable, and independent of controls', async t => {
  t.timeout(5000);
  /** @type {Array<() => void>} */
  const releases = [];
  t.teardown(() => releases.forEach(release => release()));
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec')),
    execute: async () => {
      await new Promise(resolve => {
        releases.push(() => resolve(undefined));
      });
      return 'done';
    },
  });
  const call = id =>
    bridge.handleMessage({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'exec' },
    });
  const pending = Array.from({ length: MAX_PENDING_CALLS }, (_, i) => call(i));
  t.is(bridge.pendingCalls(), MAX_PENDING_CALLS, 'visible without yielding');
  t.is(releases.length, MAX_PENDING_CALLS, 'the first admitted burst runs');

  const excess = /** @type {any} */ (await call('excess'));
  t.regex(excess.error.message, /Too many in-flight/);
  t.is(releases.length, MAX_PENDING_CALLS, 'no rejected operation is executed');
  const invalid = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 'unknown',
      method: 'tools/call',
      params: { name: 'not-granted' },
    })
  );
  t.regex(invalid.error.message, /Unknown tool/);
  t.is(releases.length, MAX_PENDING_CALLS);
  const control = bridge.handleMessage({
    jsonrpc: '2.0',
    id: 'ping',
    method: 'ping',
  });
  t.is(bridge.pendingCalls(), MAX_PENDING_CALLS);
  t.deepEqual(await control, { jsonrpc: '2.0', id: 'ping', result: {} });
  t.is(
    await bridge.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
    }),
    undefined,
  );
  t.is(
    bridge.pendingCalls(),
    MAX_PENDING_CALLS,
    'notification is not proof of settlement',
  );

  releases[0]();
  await pending[0];
  t.is(bridge.pendingCalls(), MAX_PENDING_CALLS - 1);
  pending.push(call('replacement'));
  t.is(bridge.pendingCalls(), MAX_PENDING_CALLS);
  releases.forEach(release => release());
  await Promise.all(pending);
  t.is(bridge.pendingCalls(), 0);

  // Completed work never consumes a lifetime quota.
  for (let i = 0; i < MAX_PENDING_CALLS * 3; i += 1) {
    const next = call(i);
    releases[releases.length - 1]();
    // eslint-disable-next-line no-await-in-loop
    await next;
    t.is(bridge.pendingCalls(), 0);
  }
});

test('synchronous throws and asynchronous tool failures release admission', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('sync'), toolFor('async')),
    execute: name => {
      if (name === 'sync') throw Error('sync failure');
      return Promise.reject(Error('async failure'));
    },
  });
  for (const name of ['sync', 'async']) {
    const response = /** @type {any} */ (
      // eslint-disable-next-line no-await-in-loop
      await bridge.handleMessage({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name },
      })
    );
    t.true(response.result.isError);
    t.is(bridge.pendingCalls(), 0);
  }
});
