// @ts-check
import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { makeRelay } from '@endo/relay-server/relay.js';

/**
 * Real relay with browser-compatible WebSocket event handlers.
 * @param {import('ava').ExecutionContext} t
 */
export const startRelay = async t => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const relayDomain = 'browser-endo.test';
  const relay = makeRelay(relayDomain);
  wss.on('connection', relay.handleConnection);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.teardown(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  return {
    relay: `ws://127.0.0.1:${address.port}`,
    relayDomain,
    crypto: /** @type {Crypto} */ (webcrypto),
    WebSocket: /** @type {typeof globalThis.WebSocket} */ (WebSocket),
    timeoutMs: 1000,
  };
};
harden(startRelay);
