// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';

import { makeChannelTransport } from '../src/channel-transport.js';

/**
 * A loopback channel whose replies are driven by the test.  Deliberately not
 * hardened: it accumulates the frames it was sent.
 *
 * @param {object} [options]
 * @param {boolean} [options.failSend]
 */
const makeLoopbackChannel = ({ failSend = false } = {}) => {
  /** @type {any[]} */
  const sent = [];
  /** @type {((frame: unknown) => void)[]} */
  let handlers = [];
  return {
    sent,
    channel: {
      /** @param {any} frame */
      send: frame => {
        if (failSend) {
          throw new Error('channel is closed');
        }
        sent.push(frame);
      },
      /** @param {(frame: unknown) => void} handler */
      subscribe: handler => {
        handlers.push(handler);
        return () => {
          handlers = handlers.filter(item => item !== handler);
        };
      },
    },
    /** @param {unknown} frame */
    deliver: frame => {
      for (const handler of handlers) {
        handler(frame);
      }
    },
    handlerCount: () => handlers.length,
  };
};

const lockNow = harden({ v: 1, action: 'lockNow', args: {} });

test('a request is framed with a correlation id and answered', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport } = makeChannelTransport({ channel: loop.channel });

  const promise = transport(lockNow);
  t.is(loop.sent.length, 1);
  const { id, request } = loop.sent[0];
  t.is(typeof id, 'number');
  t.deepEqual(request, lockNow);

  loop.deliver({ id, result: { ok: true } });
  t.deepEqual(await promise, { ok: true });
});

test('concurrent calls are matched to their own replies', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport } = makeChannelTransport({ channel: loop.channel });

  const first = transport(harden({ v: 1, action: 'getDeviceState', args: {} }));
  const second = transport(lockNow);
  t.is(loop.sent.length, 2);

  // Answer out of order: correlation, not arrival order, decides the match.
  loop.deliver({ id: loop.sent[1].id, result: { ok: true, value: 'second' } });
  loop.deliver({ id: loop.sent[0].id, result: { ok: true, value: 'first' } });

  t.deepEqual(await first, { ok: true, value: 'first' });
  t.deepEqual(await second, { ok: true, value: 'second' });
});

test('a silent bridge rejects rather than hanging forever', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport } = makeChannelTransport({
    channel: loop.channel,
    timeoutMs: 50,
  });

  // The failure mode this guards: over a remote link, a wedged Android side
  // would otherwise leave the operator's CapTP call pending indefinitely.
  await t.throwsAsync(() => transport(lockNow), {
    message: /did not answer .*lockNow.* within/,
  });
});

test('a reply arriving after its timeout is dropped quietly', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport } = makeChannelTransport({
    channel: loop.channel,
    timeoutMs: 50,
  });

  await t.throwsAsync(() => transport(lockNow), { message: /within/ });
  // The late reply must not throw out of the channel listener.
  t.notThrows(() =>
    loop.deliver({ id: loop.sent[0].id, result: { ok: true } }),
  );
});

test('a malformed frame does not escape the listener', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport } = makeChannelTransport({ channel: loop.channel });
  const promise = transport(lockNow);

  t.notThrows(() => loop.deliver(null));
  t.notThrows(() => loop.deliver({ noId: true }));

  // The real reply still settles the call.
  loop.deliver({ id: loop.sent[0].id, result: { ok: true } });
  t.deepEqual(await promise, { ok: true });
});

test('a send failure rejects the call immediately', async t => {
  await null;
  const loop = makeLoopbackChannel({ failSend: true });
  const { transport } = makeChannelTransport({ channel: loop.channel });

  await t.throwsAsync(() => transport(lockNow), {
    message: /send failed .*lockNow/,
  });
});

test('stop unsubscribes and fails every in-flight call', async t => {
  await null;
  const loop = makeLoopbackChannel();
  const { transport, stop } = makeChannelTransport({ channel: loop.channel });

  const promise = transport(lockNow);
  t.is(loop.handlerCount(), 1);

  stop();

  await t.throwsAsync(() => promise, { message: /transport was stopped/ });
  t.is(loop.handlerCount(), 0);
});

test('construction validates the channel and timeout', t => {
  const loop = makeLoopbackChannel();
  t.throws(() => makeChannelTransport({ channel: /** @type {any} */ ({}) }), {
    message: /send function/,
  });
  t.throws(
    () =>
      makeChannelTransport({
        channel: /** @type {any} */ ({ send: () => {} }),
      }),
    { message: /subscribe function/ },
  );
  t.throws(
    () => makeChannelTransport({ channel: loop.channel, timeoutMs: 0 }),
    { message: /positive integer/ },
  );
});
