// @ts-check

import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { makeEndoClient, purge, restart, start, stop } from '../index.js';

/** @param {string} root */
const makeConfig = root => ({
  statePath: join(root, 'state'),
  ephemeralStatePath: join(root, 'run'),
  cachePath: join(root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? String.raw`\\?\pipe\endo-provision-${basename(root)}.sock`
      : join(root, 'endo.sock'),
  address: '127.0.0.1:0',
  gcEnabled: false,
  pets: new Map(),
  values: new Map(),
});

/**
 * @param {import('ava').ExecutionContext} t
 */
export const makeProvisioningFixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-daemon-'));
  const workspace = join(root, 'workspace');
  const config = makeConfig(root);
  /** @type {Array<() => Promise<void>>} */
  const clientCleanups = [];

  const closeClients = async () => {
    await Promise.allSettled(clientCleanups.map(cleanup => cleanup()));
    clientCleanups.length = 0;
  };

  t.teardown(async () => {
    await stop(config);
    await closeClients();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'initial\n');
  await purge(config);
  await start(config);

  const connectHost = async name => {
    const { cancelled, cancel } = makeCancelKit();
    const client = await makeEndoClient(name, config.sockPath, cancelled);
    client.closed.catch(() => {});
    const bootstrap = await client.getBootstrap();
    const host = await E(bootstrap).host();
    clientCleanups.push(async () => {
      cancel(Error(`${name} closed`));
      await client.closed.catch(() => {});
    });
    return host;
  };

  const trackSession = session => {
    clientCleanups.push(session.cleanup);
    return session;
  };

  const restartDaemon = async () => {
    await closeClients();
    await restart(config);
  };

  return harden({
    root,
    workspace,
    sockPath: config.sockPath,
    closeClients,
    connectHost,
    restartDaemon,
    trackSession,
  });
};
harden(makeProvisioningFixture);
