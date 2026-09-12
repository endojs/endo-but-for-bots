// @ts-check
import '@endo/init';
import test from 'ava';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';

import { makeMcpBridge } from '@endo/hosted-agent/mcp-bridge.js';

import { startMcpSocketServer } from '../src/mcp-socket-server.js';

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

test('socket server relays JSON-RPC over a Unix socket and installs the bridge + config', async t => {
  t.timeout(5000);
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
    t.teardown(() => socket.destroy());
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

test('socket frames are handled concurrently and an unbounded frame drops the peer', async t => {
  t.timeout(5000);
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
  t.teardown(() => socket.destroy());
  t.teardown(release);
  socket.setEncoding('utf8');
  const replies = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
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

test('failed socket-file cleanup can retry; a successful close cannot unlink a successor', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcp-retry-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const server = await startMcpSocketServer({
    socketDir: directory,
    bridge: { handleMessage: async () => undefined },
  });
  t.teardown(async () => {
    await rm(server.socketPath, { recursive: true, force: true });
    // The regression leaves a rejected cached promise even after the listener
    // has closed. Still release all real resources when that assertion fails.
    await server.close().catch(() => {});
  });
  // A directory cannot be removed by the wrapper's nonrecursive unlink.
  // The listener remains owned even after its socket name has been removed.
  await rm(server.socketPath);
  await mkdir(server.socketPath);
  const first = server.close();
  t.is(server.close(), first, 'concurrent callers share the close attempt');
  await t.throwsAsync(first, { code: 'ERR_FS_EISDIR' });
  await rm(server.socketPath, { recursive: true });
  await t.notThrowsAsync(server.close());
  // A stale successful owner must not touch a replacement at the same path.
  await writeFile(server.socketPath, 'successor');
  await server.close();
  t.is(await readFile(server.socketPath, 'utf8'), 'successor');
});
