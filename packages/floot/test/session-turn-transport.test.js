// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeCapTP } from '@endo/captp';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { makeSessionTurnSlot } from '../src/session-turn-slot.js';

/**
 * Two real CapTP endpoints over an asynchronously delivered, JSON-serialized
 * wire. Reconnection creates fresh endpoints and fresh remote presences; only
 * the daemon bootstrap survives. No local capability crosses the wire.
 *
 * @param {object} bootstrap
 */
const connect = bootstrap => {
  let connected = true;
  /** @type {ReturnType<typeof makeCapTP>} */
  let daemon;
  /** @param {any} packet */
  const serialize = packet => JSON.parse(JSON.stringify(packet));
  const client = makeCapTP('browser', packet => {
    const copy = serialize(packet);
    queueMicrotask(() => {
      if (connected) daemon.dispatch(copy);
    });
  });
  daemon = makeCapTP(
    'daemon',
    packet => {
      const copy = serialize(packet);
      queueMicrotask(() => {
        if (connected) client.dispatch(copy);
      });
    },
    bootstrap,
  );
  return {
    session: client.getBootstrap(),
    disconnect: () => {
      connected = false;
      client.abort();
      daemon.abort();
    },
  };
};

test('a CapTP disconnect preserves the daemon turn for recovery and cancellation', async t => {
  t.timeout(5000);
  /** @type {any[]} */
  const history = [];
  /** @type {any} */
  let writer;
  /** @type {AbortSignal | undefined} */
  let signal;
  let settle = () => {};
  const slot = makeSessionTurnSlot(
    async (input, turnWriter, turnSignal, setHistory) => {
      writer = turnWriter;
      signal = turnSignal;
      setHistory(harden([...history]));
      await new Promise(resolve => {
        settle = () => resolve(undefined);
      });
      history.push(harden({ role: 'user', text: input }));
      history.push(
        harden({
          role: 'assistant',
          text: turnSignal.aborted ? 'partial' : 'next reply',
        }),
      );
    },
  );
  t.teardown(() => settle());
  const daemonSession = Far('TransportTestSession', {
    startTurn: input => slot.start(input),
    getCurrentTurn: () => slot.getCurrent(),
    getHistory: () => harden([...history]),
  });
  const first = connect(daemonSession);
  t.teardown(first.disconnect);
  const original = await E(first.session).startTurn('hello');
  const abandoned = iterateReader(await E(original).watch());
  t.teardown(() => abandoned.return().catch(() => undefined));
  t.like(await abandoned.next(), { value: { type: 'snapshot' } });
  writer.delta('partial');
  t.like(await abandoned.next(), { value: { type: 'delta', text: 'partial' } });

  const disconnectedRead = t.throwsAsync(abandoned.next(), {
    instanceOf: Error,
  });
  const disconnectedFinish = t.throwsAsync(E(original).whenFinished(), {
    instanceOf: Error,
  });
  first.disconnect();
  await Promise.all([disconnectedRead, disconnectedFinish]);
  t.false(signal?.aborted);
  t.truthy(slot.getCurrent());

  const second = connect(daemonSession);
  t.teardown(second.disconnect);
  const recovered = await E(second.session).getCurrentTurn();
  t.is(recovered.input, 'hello');
  t.deepEqual(await recovered.history, []);
  t.is((await E(second.session).getCurrentTurn()).turn, recovered.turn);
  t.not(recovered.turn, original, 'a new connection imports a new presence');
  const view = iterateReader(await E(recovered.turn).watch());
  t.teardown(() => view.return().catch(() => undefined));
  t.like(await view.next(), {
    value: {
      type: 'snapshot',
      status: { streamingText: 'partial', done: false },
    },
  });
  await E(recovered.turn).cancel();
  t.true(signal?.aborted);
  t.like(await view.next(), { value: { type: 'phase', phase: 'cancelling' } });
  t.false((await E(recovered.turn).getStatus()).done);
  t.is((await E(second.session).getCurrentTurn()).turn, recovered.turn);
  await t.throwsAsync(E(second.session).startTurn('too soon'), {
    message: /active turn/,
  });

  settle();
  await E(recovered.turn).whenFinished();
  t.like(await view.next(), { value: { type: 'end' } });
  t.like(await E(recovered.turn).getStatus(), {
    done: true,
    phase: 'cancelled',
  });
  t.is(await E(second.session).getCurrentTurn(), null);
  t.deepEqual(await E(second.session).getHistory(), [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'partial' },
  ]);
  const next = await E(second.session).startTurn('next');
  t.not(next, recovered.turn);
  writer.final('next reply');
  settle();
  await E(next).whenFinished();
  t.is(await E(second.session).getCurrentTurn(), null);
  t.is((await E(second.session).getHistory()).length, 4);
});

test('CapTP discovery exposes a queued turn before its history promise settles', async t => {
  t.timeout(5000);
  /** @type {(history: any[]) => void} */
  let establishHistory = () => {};
  /** @type {AbortSignal | undefined} */
  let signal;
  let settle = () => {};
  const slot = makeSessionTurnSlot(
    async (input, writer, turnSignal, setHistory) => {
      signal = turnSignal;
      establishHistory = setHistory;
      await new Promise(resolve => {
        settle = () => resolve(undefined);
      });
    },
  );
  t.teardown(() => settle());
  const connection = connect(
    Far('QueuedSession', {
      startTurn: input => slot.start(input),
      getCurrentTurn: () => slot.getCurrent(),
    }),
  );
  t.teardown(connection.disconnect);
  const turn = await E(connection.session).startTurn('queued');
  // Awaiting discovery must not await the promise nested in this record: its
  // baseline cannot exist until preceding mail finishes on the execution chain.
  const discovered = await E(connection.session).getCurrentTurn();
  t.is(discovered.turn, turn);
  t.is(discovered.input, 'queued');
  let historyReady = false;
  const history = discovered.history.then(value => {
    historyReady = true;
    return value;
  });
  const view = iterateReader(await E(turn).watch());
  t.teardown(() => view.return().catch(() => undefined));
  t.like(await view.next(), {
    value: { type: 'snapshot', status: { done: false } },
  });
  await E(turn).cancel();
  t.true(signal?.aborted);
  t.like(await view.next(), { value: { type: 'phase', phase: 'cancelling' } });
  t.false(
    historyReady,
    'watching and cancellation do not wait for queued history',
  );
  t.false((await E(turn).getStatus()).done);
  t.is((await E(connection.session).getCurrentTurn()).turn, turn);
  const baseline = harden([
    { role: 'user', text: 'preceding mail' },
    { role: 'assistant', text: 'preceding reply' },
  ]);
  establishHistory(baseline);
  t.deepEqual(await history, baseline);
  settle();
  await E(turn).whenFinished();
  t.like(await view.next(), { value: { type: 'end' } });
  t.is(await E(connection.session).getCurrentTurn(), null);
});
