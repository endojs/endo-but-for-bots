// @ts-nocheck

import '@endo/init/debug.js';

import test from 'ava';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { makeCancelKit } from '@endo/cancel';

import { makeSocketPowers } from '../src/manager-node-powers.js';
import { servePrivatePath } from '../src/serve-private-path.js';
import { socketLockPath } from '../src/socket-lock.js';

const unixTest = process.platform === 'win32' ? test.skip : test;

const makeSocketPath = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'endo-socket-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'captp0.sock');
};

const makePowers = () => makeSocketPowers({ net, fsp: { access } });

// These tests never open a connection, so the numbers are never drawn.
const makeConnectionNumbers = function* makeConnectionNumbers() {
  yield 0;
};

// The cancellations below are all deliberate, so the rejection has an owner.
const makeQuietCancelKit = () => {
  const kit = makeCancelKit();
  kit.cancelled.catch(() => {});
  return kit;
};

// Removal happens after the promise a test can await, so poll for it.
const untilAbsent = async (t, target) => {
  const deadlineMs = 5000;
  const step = 50;
  await null;
  for (let waited = 0; waited < deadlineMs; waited += step) {
    // eslint-disable-next-line no-await-in-loop
    const present = await access(target).then(
      () => true,
      () => false,
    );
    if (!present) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, step));
  }
  t.fail(`${target} was still present after ${deadlineMs}ms`);
};

unixTest.serial(
  'private listener cancellation removes its pathname before stopped settles',
  async t => {
    const socketPath = await makeSocketPath(t);
    const powers = makePowers();
    const first = makeQuietCancelKit();
    const firstService = servePrivatePath(
      socketPath,
      {},
      {
        servePath: powers.servePath,
        connectionNumbers: makeConnectionNumbers(),
        cancelled: first.cancelled,
        exitWithError: () => {},
      },
    );

    await firstService.started;
    first.cancel(new Error('clean cancellation'));
    await t.throwsAsync(firstService.stopped, {
      message: 'clean cancellation',
    });

    await t.throwsAsync(() => access(socketPath), { code: 'ENOENT' });
    await t.throwsAsync(() => access(socketLockPath(socketPath)), {
      code: 'ENOENT',
    });

    const second = makeQuietCancelKit();
    const secondConnections = await powers.servePath({
      path: socketPath,
      cancelled: second.cancelled,
    });
    t.pass('the same pathname can be rebound after stopped settles');
    second.cancel(new Error('test cleanup'));
    await t.throwsAsync(secondConnections.next(), {
      message: 'test cleanup',
    });
  },
);

unixTest.serial(
  'a socket pathname left by a killed process is recovered on startup',
  async t => {
    const socketPath = await makeSocketPath(t);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import net from 'node:net'; const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write('ready\\n'));",
        socketPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const childExited = new Promise(resolve => child.once('exit', resolve));
    t.teardown(async () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await childExited;
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    child.kill('SIGKILL');
    await childExited;
    await access(socketPath);
    // A marker whose target is not a pid: nothing we can honour.
    await symlink('not-a-pid', socketLockPath(socketPath));

    const powers = makePowers();
    const { cancelled, cancel } = makeQuietCancelKit();
    const connections = await powers.servePath({
      path: socketPath,
      cancelled,
    });
    await access(socketPath);
    cancel(new Error('test cleanup'));
    await t.throwsAsync(connections.next(), { message: 'test cleanup' });
  },
);

unixTest.serial(
  'cancelling before the bind leaves no listener behind',
  async t => {
    const socketPath = await makeSocketPath(t);
    const powers = makePowers();
    const { cancelled, cancel } = makeQuietCancelKit();
    const started = powers.servePath({ path: socketPath, cancelled });
    // Land the cancellation in the window between the claim and the bind,
    // where the server is not yet listening and so looks closed already.
    cancel(new Error('early cancellation'));
    await t.throwsAsync(started, { message: 'early cancellation' });

    await t.throwsAsync(() => access(socketPath), { code: 'ENOENT' });
    await t.throwsAsync(() => access(socketLockPath(socketPath)), {
      code: 'ENOENT',
    });

    const second = makeQuietCancelKit();
    const connections = await powers.servePath({
      path: socketPath,
      cancelled: second.cancelled,
    });
    t.pass('the pathname is free for the next daemon');
    second.cancel(new Error('test cleanup'));
    await t.throwsAsync(connections.next(), { message: 'test cleanup' });
  },
);

unixTest.serial('a stalled peer cannot hold shutdown open', async t => {
  // A close that waited on the peer would never return.
  t.timeout(30_000);
  const socketPath = await makeSocketPath(t);
  const powers = makePowers();
  const { cancelled, cancel } = makeQuietCancelKit();
  const connections = await powers.servePath({ path: socketPath, cancelled });

  const client = net.createConnection({ path: socketPath });
  t.teardown(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  // Take delivery of the connection and then abandon it, as a daemon whose
  // peer has stopped reading would.
  await connections.next();

  cancel(new Error('test cleanup'));
  await t.throwsAsync(connections.next(), { message: 'test cleanup' });
  await untilAbsent(t, socketPath);
  await untilAbsent(t, socketLockPath(socketPath));
});

unixTest.serial(
  'a marker whose owner pid was recycled is reclaimed',
  async t => {
    const socketPath = await makeSocketPath(t);
    // The marker names a live process — this one — but nothing answers on the
    // pathname, which is what a dead daemon's recycled pid looks like.
    await symlink(`${process.pid}`, socketLockPath(socketPath));

    const powers = makePowers();
    const { cancelled, cancel } = makeQuietCancelKit();
    const connections = await powers.servePath({ path: socketPath, cancelled });
    await access(socketPath);
    cancel(new Error('test cleanup'));
    await t.throwsAsync(connections.next(), { message: 'test cleanup' });
  },
);

unixTest.serial('a live owner keeps EADDRINUSE and its pathname', async t => {
  const socketPath = await makeSocketPath(t);
  const owner = net.createServer();
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.listen({ path: socketPath }, resolve);
  });
  t.teardown(
    () =>
      new Promise(resolve => {
        owner.close(() => resolve());
      }),
  );

  const powers = makePowers();
  const { cancelled } = makeQuietCancelKit();
  const start = powers.servePath({ path: socketPath, cancelled });
  await t.throwsAsync(start, { code: 'EADDRINUSE' });
  await access(socketPath);
  await t.throwsAsync(() => access(socketLockPath(socketPath)), {
    code: 'ENOENT',
  });
});
