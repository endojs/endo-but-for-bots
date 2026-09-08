// @ts-check
import test from '@endo/ses-ava/test.js';
import { E } from '@endo/far';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeEphemeralHubClient } from '../src/ephemeral-hub-client.js';
import { makeOcapnHub } from '../src/hub.js';
import { makeWorkerPeer } from '../src/worker-peer.js';

/** @import {ExecutionContext} from 'ava' */
/** @param {ExecutionContext} t */
const setup = async t => {
  const hub = makeOcapnHub({ codec: syrupCodec });
  /** @type {any} */
  let sink;
  /** @type {Uint8Array[]} */
  const outbound = [];
  const workerId = 'b'.repeat(32);
  const worker = await makeWorkerPeer({
    workerId,
    send: bytes => {
      if (sink === undefined) outbound.push(bytes);
      else sink.deliver(bytes);
    },
  });
  t.teardown(() => worker.shutdown());
  sink = hub.attachSession(workerId, {
    send: bytes => worker.deliver(bytes),
    durable: true,
  });
  for (const bytes of outbound) sink.deliver(bytes);
  hub.publish('worker', { session: workerId, position: 0n });
  const client = await makeEphemeralHubClient({
    codec: syrupCodec,
    hub,
    sessionKey: 'transient:first',
  });
  t.teardown(() => client.close());
  const bootstrap = await client.lookup('worker');
  const shell = await E(bootstrap).fetch(
    frozenBytes(new TextEncoder().encode('shell')),
  );
  return { hub, client, shell };
};

test('closing rejects pending calls and releases transient holdings', async t => {
  t.timeout(10_000);
  const { hub, client, shell } = await setup(t);
  const counter = await E(shell).evaluate(`(() => {
    let count = 0;
    return Far('Counter', {
      incr: () => ++count,
      wait: () => new Promise(() => {}),
    });
  })()`);
  t.is(await E(counter).incr(), 1);
  const pending = E(counter).wait();
  const rejection = t.throwsAsync(pending, {
    message: /Session disconnected/,
  });
  // A later call proves the never-settling invocation reached the guest.
  t.is(await E(counter).incr(), 2);
  t.true(
    hub.inspect().holdings.some(row => row.holders.includes('transient:first')),
  );
  client.close();
  client.close();
  await rejection;
  t.false(
    hub.inspect().holdings.some(row => row.holders.includes('transient:first')),
  );
  await t.throwsAsync(() => client.lookup('worker'), {
    message: 'Ephemeral client closed',
  });
});

test('one transient close leaves another client and guest effects intact', async t => {
  t.timeout(10_000);
  const { hub, client, shell } = await setup(t);
  await E(shell).evaluate(`globalThis.count = 0`);
  const second = await makeEphemeralHubClient({
    codec: syrupCodec,
    hub,
    sessionKey: 'transient:second',
  });
  t.teardown(() => second.close());
  const secondBootstrap = await second.lookup('worker');
  const secondShell = await E(secondBootstrap).fetch(
    frozenBytes(new TextEncoder().encode('shell')),
  );
  const pending = E(shell).evaluate(
    'globalThis.count += 1; new Promise(() => {})',
  );
  const rejection = t.throwsAsync(pending, {
    message: /Session disconnected/,
  });
  t.is(await E(secondShell).evaluate('globalThis.count'), 1);
  client.close();
  await rejection;
  t.is(await E(secondShell).evaluate('globalThis.count += 1'), 2);
  t.true(
    hub
      .inspect()
      .holdings.some(row => row.holders.includes('transient:second')),
  );
});

test('failed hub cleanup remains retryable after the client is aborted', async t => {
  t.timeout(10_000);
  const { hub } = await setup(t);
  let fail = true;
  const client = await makeEphemeralHubClient({
    codec: syrupCodec,
    sessionKey: 'transient:retry',
    hub: {
      ...hub,
      forgetSession: key => {
        if (fail) throw Error('Injected cleanup persistence failure');
        hub.forgetSession(key);
      },
    },
  });
  t.teardown(() => {
    fail = false;
    client.close();
  });
  await client.lookup('worker');
  t.throws(() => client.close(), {
    message: 'Injected cleanup persistence failure',
  });
  await t.throwsAsync(() => client.lookup('worker'), {
    message: 'Ephemeral client closed',
  });
  fail = false;
  client.close();
  t.false(
    hub.inspect().holdings.some(row => row.holders.includes('transient:retry')),
  );
});
