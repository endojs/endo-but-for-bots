// @ts-check
import '@endo/init';
import test from 'ava';
import { parseApplicationConfig } from '@endo/browser-endo/application.js';
import { Far } from '@endo/far';
import { parseLocator } from '@endo/daemon/locator.js';
import {
  peerFragmentForChat,
  upgradeChatConnection,
} from '../peer-connection.js';

const node = '1'.repeat(64);
const agent = `${'2'.repeat(64)}:${node}`;
const info = relay => ({
  node,
  addresses: [
    `ws-relay+captp0://${node}?relay=${encodeURIComponent(relay)}&domain=chat.test`,
  ],
});

test('agent-owned identity is preserved while routing through its hosting daemon', t => {
  const agentId = `${'2'.repeat(64)}:${'4'.repeat(64)}`;
  const config = parseApplicationConfig(
    peerFragmentForChat(
      'chat.test',
      agentId,
      info('wss://chat.test/endo/relay'),
    ) || '',
  );
  if (!('relay' in config)) throw new Error('Expected peer config');
  const parsed = parseLocator(config.endowments.agent);
  t.is(`${parsed.number}:${parsed.node}`, agentId);
  t.is(new URL(parsed.hints[0]).hostname, node);
});

test('hosted gateway bookmarks upgrade to peer endowments on their trusted host', t => {
  const fragment = peerFragmentForChat(
    'chat.test',
    agent,
    info('wss://chat.test/endo/relay'),
  );
  t.truthy(fragment);
  const config = parseApplicationConfig(fragment || '');
  if (!('relay' in config)) throw new Error('Expected peer config');
  t.is(config.relay, 'wss://chat.test/endo/relay');
  t.deepEqual(Object.keys(config.endowments), ['agent']);
  t.true(config.endowments.agent.startsWith('endo://'));
  t.is(
    peerFragmentForChat(
      'chat.test/',
      agent,
      info('wss://chat.test/endo/relay'),
    ),
    fragment,
  );
});

test('migration does not move authority to an unrelated relay or different peer identity', t => {
  t.is(
    peerFragmentForChat('chat.test', agent, info('wss://other.test/')),
    undefined,
  );
  t.is(
    peerFragmentForChat('chat.test', agent, info('ws://chat.test/')),
    undefined,
  );
  t.is(
    peerFragmentForChat('chat.test', agent, {
      ...info('wss://chat.test/'),
      node: '3'.repeat(64),
    }),
    undefined,
  );
  t.is(
    peerFragmentForChat('chat.test', agent, { node, addresses: [] }),
    undefined,
  );
});

test('failed peer upgrade preserves the working gateway and bookmark', async t => {
  let oldClosed = false;
  let candidateClosed = false;
  const powers = Far('Host', {
    __getMethodNames__: () => ['getPeerInfo'],
    getPeerInfo: () => info('wss://chat.test/endo/relay'),
  });
  const connection = harden({
    close() {
      oldClosed = true;
    },
  });
  const result = await upgradeChatConnection({
    connection,
    powers,
    gateway: 'chat.test',
    agent,
    connect: () => ({
      powers: Promise.reject(new Error('Relay unavailable')),
      close() {
        candidateClosed = true;
      },
    }),
  });
  t.is(result.connection, connection);
  t.is(result.fragment, undefined);
  t.false(oldClosed);
  t.true(candidateClosed);
});

test('successful peer upgrade closes the gateway only after powers arrive', async t => {
  let oldClosed = false;
  const powers = Far('Host', {
    __getMethodNames__: () => ['getPeerInfo'],
    getPeerInfo: () => info('wss://chat.test/endo/relay'),
  });
  const nextPowers = Far('Peer Host', {});
  const connection = harden({
    close() {
      oldClosed = true;
    },
  });
  const candidate = harden({ powers: Promise.resolve(nextPowers), close() {} });
  const result = await upgradeChatConnection({
    connection,
    powers,
    gateway: 'chat.test',
    agent,
    connect: () => {
      t.false(oldClosed);
      return candidate;
    },
  });
  t.is(result.connection, candidate);
  t.is(result.powers, nextPowers);
  t.truthy(result.fragment);
  t.true(oldClosed);
});

test('stalled optional peer migration is bounded and preserves the gateway', async t => {
  t.timeout(1000);
  let oldClosed = false;
  let candidateClosed = false;
  const powers = Far('Host', {
    __getMethodNames__: () => ['getPeerInfo'],
    getPeerInfo: () => info('wss://chat.test/endo/relay'),
  });
  const connection = harden({
    close() {
      oldClosed = true;
    },
  });
  const result = await upgradeChatConnection({
    connection,
    powers,
    gateway: 'chat.test',
    agent,
    timeoutMs: 10,
    connect: () => ({
      powers: new Promise(() => {}),
      close() {
        candidateClosed = true;
      },
    }),
  });
  t.is(result.connection, connection);
  t.is(result.fragment, undefined);
  t.false(oldClosed);
  t.true(candidateClosed);
});
