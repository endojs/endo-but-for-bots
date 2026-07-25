// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';

import { makeMcpBridge } from '../src/mcp-bridge.js';
import { startMcpSocketServer, takeLines } from '../src/mcp-socket-server.js';

const schemaFor = (name, description = '') =>
  harden({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  });

const makeDiscover = schemas => async () =>
  harden({
    schemas,
    toolMap: new Map(schemas.map(s => [s.function.name, harden({})])),
  });

test('initialize echoes the requested protocol version and advertises tools', async t => {
  const bridge = makeMcpBridge({
    discover: makeDiscover([]),
    name: 'endo-floot',
    version: '9.9.9',
  });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  t.is(response.result.protocolVersion, '2025-06-18');
  t.deepEqual(response.result.serverInfo, {
    name: 'endo-floot',
    version: '9.9.9',
  });
  t.truthy(response.result.capabilities.tools);
});

test('notifications/initialized takes no reply', async t => {
  const bridge = makeMcpBridge({ discover: makeDiscover([]) });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  t.is(response, undefined);
});

test('tools/list maps OpenAI schemas to MCP inputSchema', async t => {
  const bridge = makeMcpBridge({
    discover: makeDiscover([schemaFor('exec', 'run code'), schemaFor('send')]),
  });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
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
});

test('tools/call dispatches through execute and wraps the text result', async t => {
  const calls = [];
  const bridge = makeMcpBridge({
    discover: makeDiscover([schemaFor('lookup')]),
    execute: async (name, args, toolMap) => {
      calls.push({ name, args, hasTool: toolMap.has('lookup') });
      return 'the answer';
    },
  });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'lookup', arguments: { path: 'x' } },
  });
  t.deepEqual(calls, [{ name: 'lookup', args: { path: 'x' }, hasTool: true }]);
  t.deepEqual(response.result, {
    content: [{ type: 'text', text: 'the answer' }],
  });
});

test('tools/call surfaces a tool failure as an isError result, not a transport error', async t => {
  const bridge = makeMcpBridge({
    discover: makeDiscover([schemaFor('exec')]),
    execute: async () => {
      throw Error('boom');
    },
  });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'exec', arguments: {} },
  });
  t.is(response.result.isError, true);
  t.is(response.result.content[0].text, 'Error: boom');
  t.is(response.error, undefined);
});

test('an unknown method returns JSON-RPC method-not-found', async t => {
  const bridge = makeMcpBridge({ discover: makeDiscover([]) });
  const response = await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'does/not/exist',
  });
  t.is(response.error.code, -32_601);
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'floot-mcp-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  const bridge = makeMcpBridge({
    discover: makeDiscover([schemaFor('exec')]),
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
