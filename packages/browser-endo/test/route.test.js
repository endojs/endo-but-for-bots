// @ts-check
import '@endo/init';
import test from 'ava';
import { routeLocator } from '../src/route.js';

const agent = 'a'.repeat(64);
const number = 'b'.repeat(64);
const transport = 'c'.repeat(64);
const relay = 'wss://relay.test/endo/relay';
const hint = (node = transport, url = relay) =>
  `ws-relay+captp0://${node}?relay=${encodeURIComponent(url)}`;
const locator = (...hints) =>
  `endo://${agent}/${[number, ...hints].map(encodeURIComponent).join('@')}?type=host`;

test('agent aliases use an explicit transport route without rewriting object identity', t => {
  const route = routeLocator(locator(hint()), relay);
  t.is(String(route.node), agent);
  t.is(String(route.number), number);
  t.is(route.peerNode, transport);
  t.is(routeLocator(locator(), relay).peerNode, agent);
});

test('foreign relay hints cannot redirect a capability to their transport peer', t => {
  t.is(
    routeLocator(locator(hint(transport, 'wss://other.test')), relay).peerNode,
    agent,
  );
});

test('ambiguous or malformed routes are rejected before opening a channel', t => {
  t.throws(() => routeLocator(locator(hint(), hint('d'.repeat(64))), relay), {
    message: 'Ambiguous peer route',
  });
  for (const node of ['not-a-key', `user@${transport}`, `${transport}:1234`]) {
    t.throws(() => routeLocator(locator(hint(node)), relay), {
      message: 'Invalid peer route',
    });
  }
});
