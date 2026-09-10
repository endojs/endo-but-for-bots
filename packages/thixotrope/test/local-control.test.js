// @ts-check
import { Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';
import { once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

import { connectLocalControl, makeLocalControl } from '../src/local-control.js';
import { serveThixotrope } from '../src/supervisor.js';

/** @import { ExecutionContext } from 'ava' */

/** @param {ExecutionContext} t */
const fixture = async t => {
  const path = await mkdtemp('/tmp/thix-wire-');
  const socketPath = join(path, 'admin.sock');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void makeLocalControl(
      socket,
      'worker',
      Far('Admin', { echo: value => value }),
    ).catch(() => socket.destroy());
  });
  t.teardown(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(path, { recursive: true, force: true });
  });
  const listening = once(server, 'listening');
  server.listen(socketPath);
  await listening;
  return socketPath;
};

test.serial(
  'local control frames large messages across socket chunks and supports independent clients',
  async t => {
    // This integration test includes two handshakes and a 500 KB echo.
    // Busy macOS CI has reported successful runs taking 13s. Allow 30s
    // overall, without resetting the deadline between protocol phases.
    t.timeout(30_000);
    t.log('starting local-control server');
    const path = await fixture(t);
    t.log('connecting first client');
    const first = await connectLocalControl(path);
    t.teardown(first.close);
    t.log('connecting second client');
    const second = await connectLocalControl(path);
    t.teardown(second.close);
    const payload = 'hello'.repeat(100_000);
    t.log('echoing 500 KB through first client');
    t.is(await first.call('echo', payload), payload);
    t.log('closing first client');
    first.close();
    t.log('echoing through independent second client');
    t.is(await second.call('echo', 42), 42);
    t.log('both echoes completed');
  },
);

test.serial('malformed local frame closes only that connection', async t => {
  t.timeout(10_000);
  const path = await fixture(t);
  const bad = createConnection(path);
  t.teardown(() => bad.destroy());
  const closed = once(bad, 'close');
  await once(bad, 'connect');
  bad.write(new Uint8Array([255, 255, 255, 255]));
  await closed;
  const client = await connectLocalControl(path);
  t.teardown(client.close);
  t.is(await client.call('echo', 'still available'), 'still available');
});

test.serial('connecting without a supervisor rejects promptly', async t => {
  t.timeout(10_000);
  const path = await mkdtemp('/tmp/thix-missing-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  await t.throwsAsync(() => connectLocalControl(join(path, 'missing.sock')), {
    message: /Supervisor disconnected/,
  });
});

test.serial(
  'supervisor refuses a state directory accessible to other users',
  async t => {
    const path = await mkdtemp('/tmp/thix-permissions-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    await chmod(path, 0o755);
    await t.throwsAsync(() => serveThixotrope(path), {
      message: /private directory/,
    });
  },
);
