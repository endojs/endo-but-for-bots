// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import {
  makeMcpSocketServer,
  startMcpSocketServer,
} from '../src/mcp-socket-server.js';

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

test('failed socket-file cleanup can retry; a successful close cannot unlink a successor', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-retry-'));
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

/** @import net from 'node:net' */

test('inert server close has no native storage effects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-inert-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const socketDir = join(directory, 'absent');
  const server = makeMcpSocketServer({
    socketDir,
    bridge: { handleMessage: async () => undefined },
  });
  await t.throwsAsync(() => stat(socketDir), { code: 'ENOENT' });
  await server.close();
  t.throws(() => server.start(), { message: /closed/ });
  await t.throwsAsync(() => stat(socketDir), { code: 'ENOENT' });
});

test('close drains admitted relay installation and fences later startup effects', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-install-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  let release = () => {};
  const pending = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let entered = () => {};
  const admission = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  let writes = 0;
  const server = makeMcpSocketServer({
    socketDir: directory,
    bridge: { handleMessage: async () => undefined },
    installBridge: async () => {
      entered();
      await pending;
    },
    writeConfig: async () => {
      writes += 1;
    },
  });
  t.teardown(async () => {
    release();
    await server.close();
  });
  const starting = server.start();
  const failedStart = t.throwsAsync(starting, { message: /closed/ });
  await admission;
  const closing = server.close();
  t.is(server.close(), closing);
  let finished = false;
  void closing.then(() => {
    finished = true;
  });
  await Promise.resolve();
  t.false(finished);
  release();
  await failedStart;
  await closing;
  t.is(writes, 0);
  await t.throwsAsync(() => stat(server.socketPath), { code: 'ENOENT' });
});

test('post-listen permission failure retains native listener until close retry succeeds', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-chmod-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const native = new EventEmitter();
  let closes = 0;
  let failClose = true;
  Object.assign(native, {
    listen(socketPath, callback) {
      void writeFile(socketPath, 'owned socket placeholder').then(callback);
    },
    close(callback) {
      closes += 1;
      callback(failClose ? Error('native close failed') : undefined);
    },
  });
  const netModule = /** @type {typeof net} */ (
    /** @type {unknown} */ ({ createServer: () => native })
  );
  const server = makeMcpSocketServer({
    socketDir: directory,
    netModule,
    bridge: { handleMessage: async () => undefined },
    setPermissions: async (nativePath, mode) => {
      if (nativePath === join(directory, 'mcp.sock'))
        throw Error('socket chmod failed');
      await chmod(nativePath, mode);
    },
  });
  t.teardown(async () => {
    failClose = false;
    await server.close();
  });
  await t.throwsAsync(server.start(), { message: /socket chmod failed/ });
  await t.throwsAsync(server.close(), { message: /cleanup pending/ });
  t.is(await readFile(server.socketPath, 'utf8'), 'owned socket placeholder');
  failClose = false;
  await server.close();
  t.is(closes, 2);
  await t.throwsAsync(() => stat(server.socketPath), { code: 'ENOENT' });
});

test('existing socket paths are refused without taking deletion authority', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-collision-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'mcp.sock');
  await writeFile(socketPath, 'prior owner');
  const server = makeMcpSocketServer({
    socketDir: directory,
    bridge: { handleMessage: async () => undefined },
  });
  t.teardown(() => server.close());
  await t.throwsAsync(server.start(), { message: /already exists/ });
  await server.close();
  t.is(await readFile(socketPath, 'utf8'), 'prior owner');
});
