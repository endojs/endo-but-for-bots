// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  decodeChannelId,
  decodeFrame,
  MSG_CLOSE,
  MSG_DATA,
  MSG_HELLO,
  MSG_OPEN,
  toHex,
} from '@endo/relay-server/protocol.js';
import { makeBrowserEndo } from '../src/index.js';
import { makeCounter } from '../src/counter.js';
import {
  connectApplication,
  parseApplicationConfig,
} from '../src/application.js';
import { startRelay } from './helpers.js';

const peer = (t, options) => {
  const runtime = makeBrowserEndo(options);
  t.teardown(runtime.close);
  return runtime;
};

test.serial(
  'three peers share counter snapshots, import browser exports, reconnect, and deduplicate submissions',
  async t => {
    t.timeout(15_000);
    const options = await startRelay(t);
    const owner = peer(t, options);
    const a = peer(t, options);
    const b = peer(t, options);
    const locator = await owner.export(makeCounter());
    const first = await a.import(locator);
    const second = await b.import(locator);
    const streamA = await E(first).follow();
    const streamB = await E(second).follow();
    t.teardown(() => {
      E(streamA)
        .close()
        .catch(() => {});
      E(streamB)
        .close()
        .catch(() => {});
    });
    const iterA = iterateReader(streamA);
    const iterB = iterateReader(streamB);
    t.deepEqual((await iterA.next()).value, { value: 0n, revision: 0n });
    t.deepEqual((await iterB.next()).value, { value: 0n, revision: 0n });
    const incrementer = await E(first).makeIncrementer();
    await E(incrementer).increment(1n); // Deliberately discard the first response.
    t.deepEqual(await E(incrementer).increment(1n), {
      value: 1n,
      revision: 1n,
    });
    t.deepEqual((await iterA.next()).value, { value: 1n, revision: 1n });
    t.deepEqual((await iterB.next()).value, { value: 1n, revision: 1n });
    await t.throwsAsync(() => E(incrementer).increment(3n), {
      message: /next increment sequence/,
    });

    // An inbound peer also dials another peer: channel id spaces must not collide.
    const echoLocator = await b.export(Far('Echo', { echo: x => x }));
    const echo = await owner.import(echoLocator);
    const local = Far('Browser Object', { ping: () => 'pong' });
    t.is(await E(echo).echo(local), local);
    t.deepEqual(await E(first).snapshot(), { value: 1n, revision: 1n });
    a.close();
    const fresh = peer(t, options);
    const reconnected = await fresh.import(locator);
    t.deepEqual(await E(reconnected).snapshot(), { value: 1n, revision: 1n });
    await E(await E(reconnected).makeIncrementer()).increment(1n);
    t.deepEqual((await iterB.next()).value, { value: 2n, revision: 2n });
    await t.throwsAsync(() => a.import(locator), { message: /closed/ });
  },
);

test.serial(
  'failed authentication, open timeout and early cancellation settle and permit recovery',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const wrong = peer(t, { ...options, relayDomain: 'wrong' });
    await t.throwsAsync(wrong.ready, { message: /authentication failed/ });
    await wrong.closed;
    const early = peer(t, options);
    early.close();
    await t.throwsAsync(early.ready, { message: /closed/ });
    const owner = peer(t, options);
    const locator = await owner.export(makeCounter());
    owner.close();
    const waiting = peer(t, { ...options, timeoutMs: 50 });
    await t.throwsAsync(() => waiting.import(locator), {
      message: /timed out/,
    });
    const replacement = peer(t, options);
    const newLocator = await replacement.export(makeCounter());
    t.deepEqual(await E(await peer(t, options).import(newLocator)).snapshot(), {
      value: 0n,
      revision: 0n,
    });
  },
);

test.serial(
  'application connector shares explicit endowments with unique per-runtime identities',
  async t => {
    const options = await startRelay(t);
    const owner = peer(t, options);
    const locator = await owner.export(makeCounter());
    const fragment = new URLSearchParams({
      relay: options.relay,
      relayDomain: options.relayDomain,
      'cap.counter': locator,
    }).toString();
    const config = parseApplicationConfig(`#${fragment}`);
    const app = connectApplication(config, options);
    t.teardown(app.close);
    const { counter } = await app.endowments;
    t.deepEqual(await E(counter).snapshot(), { value: 0n, revision: 0n });
    t.not(app.runtime?.getNodeId(), owner.getNodeId());
    t.deepEqual(Object.keys(await app.endowments), ['counter']);
    t.throws(() => parseApplicationConfig('?cap.counter=secret'), {
      message: /configured in the fragment/,
    });
    t.throws(() => parseApplicationConfig('#cap.counter=x&cap.counter=y'), {
      message: /duplicate/,
    });
  },
);

test.serial(
  'simultaneous bilateral imports recover crossed greetings',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const a = peer(t, options);
    const b = peer(t, options);
    const [la, lb] = await Promise.all([
      a.export(makeCounter()),
      b.export(makeCounter()),
    ]);
    const [ca, cb] = await Promise.all([a.import(lb), b.import(la)]);
    t.deepEqual(await E(ca).snapshot(), { value: 0n, revision: 0n });
    t.deepEqual(await E(cb).snapshot(), { value: 0n, revision: 0n });
  },
);

test.serial(
  'application closes on endowment peer loss while relay remains available',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const owner = peer(t, options);
    const locator = await owner.export(makeCounter());
    const app = connectApplication(
      { ...options, endowments: { counter: locator } },
      options,
    );
    t.teardown(app.close);
    await app.endowments;
    owner.close();
    await app.closed;
    const freshOwner = peer(t, options);
    const next = connectApplication(
      {
        ...options,
        endowments: { counter: await freshOwner.export(makeCounter()) },
      },
      options,
    );
    t.teardown(next.close);
    t.deepEqual(await E((await next.endowments).counter).snapshot(), {
      value: 0n,
      revision: 0n,
    });
  },
);

test.serial(
  'crossed greetings survive losing-channel close before the winning hello without replay',
  async t => {
    t.timeout(10_000);
    const options = await startRelay(t);
    const sockets = new Map();
    let highSocket;
    let lowSocket;
    let released = false;
    let losingCloseObserved = false;
    let heldFrames = 0;
    const calls = [];
    const held = [];
    const decoder = new TextDecoder();

    class DelayedWebSocket extends options.WebSocket {
      peerId = '';
      outboundId = -1;

      constructor(url) {
        super(url);
        this.addEventListener('message', event => {
          const { type, payload } = decodeFrame(new Uint8Array(event.data));
          if (
            this === lowSocket &&
            type === MSG_CLOSE &&
            decodeChannelId(payload) === this.outboundId
          ) {
            losingCloseObserved = true;
            // Let the losing channel's cancellation and rejected hello fully
            // propagate before delivering any bytes on the surviving channel.
            // A microtask-only release would accidentally mask the race.
            nextTurn().then(() => {
              released = true;
              for (const frame of held.splice(0)) highSocket.send(frame);
            });
          }
        });
      }

      send(data) {
        const frame = new Uint8Array(data);
        const { type, payload } = decodeFrame(frame);
        if (type === MSG_HELLO) {
          this.peerId = toHex(payload);
          sockets.set(this.peerId, this);
        }
        if (type === MSG_OPEN) this.outboundId = decodeChannelId(payload);
        if (type === MSG_DATA) {
          if (
            this === highSocket &&
            decodeChannelId(payload) === this.outboundId &&
            !released
          ) {
            heldFrames += 1;
            held.push(frame);
            return;
          }
          // makeNetstringCapTP's chunked writer emits the JSON payload as its
          // own frame, between separate length and comma frames. Observe calls
          // without changing their serialization or delivery.
          try {
            const message = JSON.parse(decoder.decode(payload.subarray(4)));
            if (message.type === 'CTP_CALL') {
              const [method] = JSON.parse(
                message.method.body.replace(/^#/, ''),
              );
              calls.push({ peer: this.peerId, method });
            }
          } catch {
            // Netstring length and delimiter frames are not JSON messages.
          }
        }
        super.send(frame);
      }
    }

    const a = peer(t, { ...options, WebSocket: DelayedWebSocket });
    const b = peer(t, { ...options, WebSocket: DelayedWebSocket });
    await Promise.all([a.ready, b.ready]);
    const [low, high] = a.getNodeId() < b.getNodeId() ? [a, b] : [b, a];
    lowSocket = sockets.get(low.getNodeId());
    highSocket = sockets.get(high.getNodeId());
    let lowMutations = 0;
    let highMutations = 0;
    const [lowLocator, highLocator] = await Promise.all([
      low.export(
        Far('Low object', {
          mutate() {
            lowMutations += 1;
            return lowMutations;
          },
        }),
      ),
      high.export(
        Far('High object', {
          mutate() {
            highMutations += 1;
            return highMutations;
          },
        }),
      ),
    ]);
    const [highObject, lowObject] = await Promise.all([
      low.import(highLocator),
      high.import(lowLocator),
    ]);
    t.true(losingCloseObserved);
    t.true(
      heldFrames > 0,
      'winning hello was withheld until losing channel closed',
    );
    t.true(released);
    t.deepEqual(
      await Promise.all([E(highObject).mutate(), E(lowObject).mutate()]),
      [1, 1],
    );
    t.is(lowMutations, 1);
    t.is(highMutations, 1);
    for (const runtime of [low, high]) {
      const sent = calls.filter(call => call.peer === runtime.getNodeId());
      t.is(
        sent.filter(call => call.method === 'provide').length,
        1,
        'import must not replay provide',
      );
      t.is(
        sent.filter(call => call.method === 'mutate').length,
        1,
        'application mutation must not replay',
      );
    }
  },
);
