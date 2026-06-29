// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import { WebSocket } from 'ws';

import { makePromiseKit } from '@endo/promise-kit';

import { startWsGateway } from '../src/ws-gateway.js';

/** @returns {import('../src/types.js').EndoBootstrap} */
const makeBootstrap = () => {
  /** @type {import('../src/types.js').EndoGateway} */
  const gateway = harden({
    provide: async token => token,
    followRetentionSet: async () => {
      throw Error('not implemented');
    },
  });
  return harden({
    ping: async () => 'pong',
    terminate: async () => {},
    host: async () => {
      throw Error('not implemented');
    },
    leastAuthority: async () => {
      throw Error('not implemented');
    },
    greeter: async () => {
      throw Error('not implemented');
    },
    gateway: async () => gateway,
    nodeId: () => 'node',
    sign: async () => {
      throw Error('not implemented');
    },
    readLog: async () => {
      throw Error('not implemented');
    },
    reviveNetworks: async () => {},
    revivePins: async () => {},
    addPeerInfo: async () => {},
    listKnownPeers: async () => [],
    followPeerChanges: async () => {
      throw Error('not implemented');
    },
  });
};

/**
 * @param {string} location
 * @returns {Promise<{ status: number, body: string }>}
 */
const fetchText = location =>
  new Promise((resolve, reject) => {
    http
      .get(location, res => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body });
        });
      })
      .on('error', reject);
  });

test('ws gateway serves Chat dist files and SPA fallback', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'endo-ws-gateway-'));
  t.teardown(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, 'assets'));
  await fs.writeFile(path.join(temp, 'index.html'), '<h1>Chat</h1>');
  await fs.writeFile(path.join(temp, 'assets', 'app.js'), 'export {};');

  const { promise, reject: cancel } = makePromiseKit();
  const cancelled = /** @type {Promise<never>} */ (promise);
  cancelled.catch(() => {});
  const gateway = startWsGateway({
    endoBootstrap: makeBootstrap(),
    host: '127.0.0.1',
    port: 0,
    cancelled,
    chatDist: temp,
  });
  t.teardown(async () => {
    cancel(Error('teardown'));
    await gateway.stopped;
  });

  const address = await gateway.started;
  t.like(await fetchText(`${address}/`), { body: '<h1>Chat</h1>' });
  t.like(await fetchText(`${address}/assets/app.js`), { body: 'export {};' });
  t.like(await fetchText(`${address}/spaces/example`), {
    body: '<h1>Chat</h1>',
  });
  t.like(await fetchText(`${address}/missing.js`), { status: 404 });
});

test('ws gateway rejects disallowed remote addresses', async t => {
  const { promise, reject: cancel } = makePromiseKit();
  const cancelled = /** @type {Promise<never>} */ (promise);
  cancelled.catch(() => {});
  const gateway = startWsGateway({
    endoBootstrap: makeBootstrap(),
    host: '127.0.0.1',
    port: 0,
    cancelled,
    allowAddress: () => false,
  });
  t.teardown(async () => {
    cancel(Error('teardown'));
    await gateway.stopped;
  });

  const address = await gateway.started;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(address.replace(/^http/u, 'ws'));
    socket.on('close', (code, reason) => {
      t.is(code, 1008);
      t.is(reason.toString(), 'Only local connections allowed');
      resolve(undefined);
    });
    socket.on('error', reject);
  });
});
