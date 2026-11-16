// @ts-check
// Exercise successive connections, including recovery after closing each one.
/* eslint-disable no-await-in-loop */
import '@endo/init';
import test from 'ava';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { makeCapTP } from '@endo/captp';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import {
  connectApplication,
  parseApplicationConfig,
} from '../src/application.js';

test.serial(
  'legacy gateway root slashes connect and reconnect using the same authority',
  async t => {
    t.timeout(10_000);
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    t.teardown(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    });
    const paths = [];
    const tokens = [];
    server.on('connection', (socket, request) => {
      paths.push(request.url);
      const captp = makeCapTP(
        'Test Gateway',
        message =>
          socket.send(new TextEncoder().encode(JSON.stringify(message))),
        Far('Gateway', {
          fetch(token) {
            tokens.push(token);
            return Far('Agent', { ping: () => 'pong' });
          },
        }),
      );
      socket.on('message', data => captp.dispatch(JSON.parse(data.toString())));
      socket.on('close', () => captp.abort());
    });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string') throw new Error('Expected TCP address');
    const gateway = `127.0.0.1:${address.port}`;
    for (const suffix of ['', '/', '//', '/']) {
      const config = parseApplicationConfig(
        `#gateway=${encodeURIComponent(gateway + suffix)}&agent=test-agent`,
      );
      const connection = connectApplication(config, {
        WebSocket: /** @type {typeof globalThis.WebSocket} */ (WebSocket),
        secure: false,
      });
      t.teardown(connection.close);
      const endowments = await connection.endowments;
      t.is(await E(endowments.agent).ping(), 'pong');
      connection.close();
      await connection.closed;
    }
    t.deepEqual(paths, ['/', '/', '/', '/']);
    t.deepEqual(tokens, Array(4).fill('test-agent'));
  },
);

test('gateway compatibility still rejects paths and authority overrides before opening a socket', async t => {
  let opened = false;
  class ForbiddenSocket {
    constructor() {
      opened = true;
      throw new Error('Unexpected socket');
    }
  }
  for (const gateway of [
    '',
    '/',
    'host/path/',
    'host/?query',
    'host/#fragment',
    'user@host/',
    'host\\other/',
    'host /',
    'https://host/',
  ]) {
    const connection = connectApplication(
      { gateway, endowments: { agent: 'test-agent' } },
      {
        WebSocket: /** @type {typeof globalThis.WebSocket} */ (
          /** @type {unknown} */ (ForbiddenSocket)
        ),
      },
    );
    t.teardown(connection.close);
    await t.throwsAsync(connection.endowments, {
      message: 'Invalid gateway address',
    });
    await connection.closed;
  }
  t.false(opened);
});
