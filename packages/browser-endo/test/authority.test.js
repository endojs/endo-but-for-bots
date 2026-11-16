// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makePromiseKit } from '@endo/promise-kit';

import { makeBrowserEndo } from '../src/index.js';
import { connectRelay } from '../src/relay.js';
import { startRelay } from './helpers.js';

/**
 * A real authenticated relay peer that can inspect the gateway granted to it.
 * @param {import('ava').ExecutionContext} t
 * @param {Awaited<ReturnType<typeof startRelay>>} options
 * @param {boolean} [stallGreeting]
 */
const inspectablePeer = async (t, options, stallGreeting = false) => {
  const gatewayReceived = makePromiseKit();
  const never = makePromiseKit();
  let provides = 0;
  const object = Far('Explicit test capability', { ping: () => 'pong' });
  const gateway = Far('Inspectable peer gateway', {
    provide: () => {
      provides += 1;
      return object;
    },
  });
  const relay = connectRelay({
    ...options,
    bootstrap: () =>
      Far('Inspectable peer greeter', {
        hello(_node, browserGateway) {
          gatewayReceived.resolve(browserGateway);
          return stallGreeting ? never.promise : gateway;
        },
      }),
  });
  t.teardown(relay.close);
  await relay.ready;
  return {
    relay,
    gateway,
    gatewayReceived: gatewayReceived.promise,
    provides: () => provides,
    locator: `endo://${relay.getNodeId()}/${'ab'.repeat(32)}?type=remote`,
  };
};

test.serial(
  'peer gateways cannot enumerate another peers retained bearer capabilities',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const a = await inspectablePeer(t, options);
    const b = await inspectablePeer(t, options);
    const browser = makeBrowserEndo(options);
    t.teardown(browser.close);
    t.is(await E(await browser.import(a.locator)).ping(), 'pong');
    t.is(await E(await browser.import(b.locator)).ping(), 'pong');
    const gatewayA = await a.gatewayReceived;
    const gatewayB = await b.gatewayReceived;
    await t.throwsAsync(
      () => E(gatewayB).followRetentionSet(a.relay.getNodeId()),
      {
        message: /Retention queries must name the authenticated peer/,
      },
    );
    await t.throwsAsync(
      () => E(gatewayA).followRetentionSet(b.relay.getNodeId()),
      {
        message: /Retention queries must name the authenticated peer/,
      },
    );
    const reader = await E(gatewayB).followRetentionSet(b.relay.getNodeId());
    t.teardown(() =>
      E(reader)
        .close()
        .catch(() => {}),
    );
    const iterator = iterateReader(reader);
    t.deepEqual((await iterator.next()).value, {
      add: ['ab'.repeat(32)],
      remove: [],
    });
    await E(reader).close();
  },
);

test.serial(
  'incoming peer identity is bound and empty retention snapshots can be cancelled while pending',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const browser = makeBrowserEndo(options);
    t.teardown(browser.close);
    await browser.ready;
    const caller = await inspectablePeer(t, options);
    const channel = await caller.relay.connect(browser.getNodeId());
    if (!channel.captp) throw new Error('Expected channel CapTP');
    const greeter = channel.captp.getBootstrap();
    const cancel = Far('Test canceller', () => {});
    await t.throwsAsync(
      () =>
        E(greeter).hello(
          'ff'.repeat(32),
          caller.gateway,
          cancel,
          channel.cancelled,
        ),
      { message: /identity does not match/ },
    );
    const gateway = await E(greeter).hello(
      caller.relay.getNodeId(),
      caller.gateway,
      cancel,
      channel.cancelled,
    );
    const reader = await E(gateway).followRetentionSet(
      caller.relay.getNodeId(),
    );
    const iterator = iterateReader(reader);
    t.deepEqual((await iterator.next()).value, { add: [], remove: [] });
    const pending = iterator.next();
    await E(reader).close();
    t.deepEqual(await pending, { done: true, value: undefined });
    const reader2 = await E(gateway).followRetentionSet(
      caller.relay.getNodeId(),
    );
    const iterator2 = iterateReader(reader2);
    await iterator2.next();
    const pending2 = iterator2.next();
    const rejected = t.throwsAsync(pending2, {
      message: /closed|disconnected/i,
    });
    channel.close();
    await rejected;
    await channel.captp.closed;
    await t.throwsAsync(
      () => E(gateway).followRetentionSet(caller.relay.getNodeId()),
      {
        message: /closed|disconnected/i,
      },
    );
    t.is(caller.provides(), 0);
  },
);

test.serial(
  'stalled greeting times out, closes pending work and permits a fresh runtime',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const stalled = await inspectablePeer(t, options, true);
    const browser = makeBrowserEndo({ ...options, timeoutMs: 500 });
    t.teardown(browser.close);
    await browser.ready;
    await t.throwsAsync(() => browser.import(stalled.locator), {
      message: /Importing peer capability timed out/,
    });
    await browser.closed;
    t.is(
      stalled.provides(),
      0,
      'a greeting timeout cannot dispatch application calls',
    );
    const working = await inspectablePeer(t, options);
    const replacement = makeBrowserEndo(options);
    t.teardown(replacement.close);
    t.is(await E(await replacement.import(working.locator)).ping(), 'pong');
    t.is(working.provides(), 1);
  },
);
