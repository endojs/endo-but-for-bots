// @ts-check
import '@endo/init';
import test from 'ava';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { Far } from '@endo/far';

import {
  makeMcpBridge,
  makeMcpBridgeForToolSet,
  pinToolCatalog,
} from '../src/mcp-bridge.js';
import { startMcpSocketServer, takeLines } from '../src/mcp-socket-server.js';

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

test('takeLines frames newline-delimited JSON and carries a partial tail', t => {
  const first = takeLines('{"a":1}\n{"b":2}\n{"c":');
  t.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  t.is(first.rest, '{"c":');
  const second = takeLines(`${first.rest}3}\n`);
  t.deepEqual(second.lines, ['{"c":3}']);
  t.is(second.rest, '');
});

test('socket server relays JSON-RPC over a Unix socket and installs the bridge + config', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-mcp-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec')),
    execute: async () => 'ok',
  });
  const server = await startMcpSocketServer({
    socketDir: dir,
    bridge,
    innerDir: '/endo-mcp',
    serverName: 'endo',
  });
  t.teardown(() => server.close());

  // The stdio relay and MCP config land in the directory that gets mounted.
  await t.notThrowsAsync(() => stat(path.join(dir, server.stdioBridgeName)));
  const config = JSON.parse(
    await readFile(path.join(dir, server.configFileName), 'utf8'),
  );
  t.is(config.mcpServers.endo.command, 'node');
  t.deepEqual(config.mcpServers.endo.args, [
    `/endo-mcp/${server.stdioBridgeName}`,
    '/endo-mcp/mcp.sock',
  ]);
  t.is(server.innerConfigPath, '/endo-mcp/mcp.json');

  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(server.socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'exec', arguments: {} },
      })}\n`,
    );
  });
  t.is(reply.id, 7);
  t.deepEqual(reply.result.content, [{ type: 'text', text: 'ok' }]);
});

test('a JSON-RPC batch is refused with a reply rather than dropped', async t => {
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('exec')),
    execute: async () => 'ok',
  });
  const response = await bridge.handleMessage([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  ]);
  t.is(response.id, null);
  t.is(response.error.code, -32_600);
});

test('socket frames are handled concurrently and an unbounded frame drops the peer', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-mcp-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const bridge = makeMcpBridge({
    tools: catalogOf(toolFor('slow'), toolFor('fast')),
    execute: async name => {
      await (name === 'slow' ? gate : null);
      return name;
    },
  });
  const server = await startMcpSocketServer({
    socketDir: dir,
    bridge,
    maxFrameLength: 256,
  });
  t.teardown(() => server.close());

  const socket = net.connect(server.socketPath);
  socket.setEncoding('utf8');
  const replies = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { lines, rest } = takeLines(buffer);
    buffer = rest;
    for (const line of lines) replies.push(JSON.parse(line));
  });
  const closed = new Promise(resolve => socket.on('close', resolve));
  const call = (id, name) =>
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: {} },
    })}\n`;
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(call(1, 'slow'));
  socket.write(call(2, 'fast'));
  // The fast call answers while the slow one is still running: a parallel
  // tool call (or a cancellation) does not queue behind a slow Endo tool.
  for (let tries = 0; replies.length < 1 && tries < 1000; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  t.is(replies.length, 1);
  t.is(replies[0].id, 2);
  release();
  for (let tries = 0; replies.length < 2 && tries < 1000; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  t.is(replies[1].id, 1);

  // A frame longer than the cap with no newline is not a JSON-RPC peer: the
  // server drops the connection instead of buffering it.
  socket.write('x'.repeat(1024));
  await closed;
  t.pass();
});
