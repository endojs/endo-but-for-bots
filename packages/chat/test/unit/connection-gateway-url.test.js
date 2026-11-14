// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { connectToGateway } from '../../connection.js';

/**
 * Call connectToGateway with a stand-in page origin and WebSocket, and
 * return the URL it dialed. The stand-in socket never opens, so no CapTP
 * traffic happens.
 *
 * @param {string} protocol - the page's `location.protocol`
 * @param {string} gateway - gateway host:port
 */
const dialedUrl = (protocol, gateway) => {
  const g = /** @type {any} */ (globalThis);
  const saved = { window: g.window, WebSocket: g.WebSocket };
  /** @type {string[]} */
  const urls = [];
  g.window = { location: { protocol } };
  g.WebSocket = class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      urls.push(url);
    }
  };
  try {
    const connection = connectToGateway({ gateway, agent: 'agent' });
    connection.powers.catch(() => {});
    connection.closed.catch(() => {});
  } finally {
    g.window = saved.window;
    g.WebSocket = saved.WebSocket;
  }
  return urls[0];
};

test('an http: page dials ws://', t => {
  t.is(dialedUrl('http:', 'example.test:8920'), 'ws://example.test:8920/');
});

test('an https: page dials wss:// to a remote gateway', t => {
  t.is(dialedUrl('https:', 'example.test:8920'), 'wss://example.test:8920/');
  t.is(dialedUrl('https:', '127.0.0.2:8920'), 'wss://127.0.0.2:8920/');
});

test('an https: page dials ws:// to a loopback gateway', t => {
  t.is(dialedUrl('https:', '127.0.0.1:8920'), 'ws://127.0.0.1:8920/');
  t.is(dialedUrl('https:', 'localhost:8920'), 'ws://localhost:8920/');
  t.is(dialedUrl('https:', '[::1]:8920'), 'ws://[::1]:8920/');
});
