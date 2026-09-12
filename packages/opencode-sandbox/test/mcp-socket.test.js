// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { startMcpSocketServer } from '../src/mcp-socket-server.js';

test('installs the shared standalone relay with OpenCode config and private permissions', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const server = await startMcpSocketServer({
    socketDir: directory,
    bridge: {
      handleMessage: async message => ({ id: message.id, result: 'ok' }),
    },
  });
  t.teardown(() => server.close());
  const configPath = join(directory, server.configFileName);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  t.deepEqual(config, {
    mcp: {
      endo: {
        type: 'local',
        command: [
          'node',
          '/endo-mcp/mcp-stdio-bridge.mjs',
          '/endo-mcp/mcp.sock',
        ],
        enabled: true,
      },
    },
  });
  // File mode bits are a bit field.
  // eslint-disable-next-line no-bitwise
  t.is((await stat(directory)).mode & 0o777, 0o700);
  // eslint-disable-next-line no-bitwise
  t.is((await stat(configPath)).mode & 0o777, 0o600);
  // eslint-disable-next-line no-bitwise
  t.is((await stat(server.socketPath)).mode & 0o777, 0o600);

  // Run the installed file outside SES, just as the native CLI will.
  const child = spawn(process.execPath, [
    join(directory, server.stdioBridgeName),
    server.socketPath,
  ]);
  const exited = once(child, 'exit');
  t.teardown(async () => {
    child.kill();
    await exited;
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  const reader = createInterface({ input: child.stdout });
  t.teardown(() => reader.close());
  const reply = once(reader, 'line');
  child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
  const [line] = await reply;
  t.deepEqual(JSON.parse(line), { id: 7, result: 'ok' });
  child.stdin.end();
  t.deepEqual(await exited, [0, null]);
  t.is(stderr, '');
  await server.close();
  await server.close();
  await t.throwsAsync(() => stat(server.socketPath), { code: 'ENOENT' });
});
