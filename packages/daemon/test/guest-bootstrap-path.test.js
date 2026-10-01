// @ts-check

// `EndoBootstrap.guestBootstrapPath`: a socket whose CapTP bootstrap is one
// guest facet and nothing else.

// Establish a perimeter:
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { start, stop, purge, makeEndoClient } from '../index.js';
import { parseId } from '../src/formula-identifier.js';

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

// The guest socket is served by the Node daemon entry; the Go and Rust
// supervisors do not serve guest sockets.
const testNodeDaemon = process.env.ENDO_BIN ? test.skip : test;

/** @param {string} name */
const makeConfig = name => ({
  statePath: path.join(dirname, 'tmp', name, 'state'),
  ephemeralStatePath: path.join(dirname, 'tmp', name, 'run'),
  cachePath: path.join(dirname, 'tmp', name, 'cache'),
  sockPath: path.join(
    os.tmpdir(),
    `endo-${process.pid.toString(36)}-${name}.sock`,
  ),
  address: '127.0.0.1:0',
  gcEnabled: true,
  pets: new Map(),
  values: new Map(),
});

/**
 * @param {string} socketPath
 * @param {Promise<never>} cancelled
 */
const connect = async (socketPath, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    socketPath,
    cancelled,
  );
  closed.catch(() => {});
  return getBootstrap();
};

testNodeDaemon('a guest bootstrap path reaches only its guest', async t => {
  const config = makeConfig('guest-bootstrap');
  const { cancelled, cancel } = makeCancelKit();
  cancelled.catch(() => {});
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    cancel(Error('teardown'));
  });

  const root = await connect(config.sockPath, cancelled);
  const host = E(root).host();
  await E(host).provideGuest('scoped', { agentName: 'scoped-agent' });
  await E(host).storeValue(10, 'ten');
  await E(host).move(['ten'], ['scoped-agent', 'ten']);
  const guestId = /** @type {string} */ (
    await E(host).identify('scoped-agent')
  );

  const guestPath = await E(root).guestBootstrapPath(guestId);
  t.is(path.dirname(path.dirname(guestPath)), path.dirname(config.sockPath));
  const { mode } = await fs.stat(path.dirname(guestPath));
  t.is(
    mode.toString(8).slice(-3),
    '700',
    'the guest socket directory is private',
  );

  // Issuing again, by full id or by bare number, names the same socket.
  t.is(await E(root).guestBootstrapPath(guestId), guestPath);
  t.is(await E(root).guestBootstrapPath(parseId(guestId).number), guestPath);

  const scoped = await connect(guestPath, cancelled);
  t.is(await E(scoped).identify('@agent'), guestId);
  t.true(await E(scoped).has('ten'));
  t.is(await E(scoped).lookup('ten'), 10);
  // The bootstrap is the guest itself, so the root's methods are absent.
  await t.throwsAsync(() => E(scoped).host());
  await t.throwsAsync(() => E(scoped).terminate());
  await t.throwsAsync(() => E(scoped).guestBootstrapPath(guestId));
});

testNodeDaemon('a guest bootstrap path refuses a non-guest', async t => {
  const config = makeConfig('guest-bootstrap-refuse');
  const { cancelled, cancel } = makeCancelKit();
  cancelled.catch(() => {});
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    cancel(Error('teardown'));
  });

  const root = await connect(config.sockPath, cancelled);
  const host = E(root).host();
  const hostId = /** @type {string} */ (await E(host).identify('@agent'));
  await t.throwsAsync(() => E(root).guestBootstrapPath(hostId), {
    message: /is not a local guest/,
  });
  await E(host).storeValue(10, 'ten');
  const valueId = /** @type {string} */ (await E(host).identify('ten'));
  await t.throwsAsync(() => E(root).guestBootstrapPath(valueId), {
    message: /is not a local guest/,
  });
});
