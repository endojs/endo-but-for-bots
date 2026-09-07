// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeSessionTurn } from '../src/session-turn.js';

/**
 * A turn whose body is driven by the test: `writer` is handed out once
 * `makeSessionTurn` starts it, and `settle` resolves the run promise the way a
 * real turn's `agent.converse` would.
 */
const makeDrivenTurn = () => {
  /** @type {any} */
  let writer;
  /** @type {AbortSignal} */
  let signal;
  /** @type {() => void} */
  let settle = () => {};
  /** @type {(error: Error) => void} */
  let fail = () => {};
  const turn = makeSessionTurn({
    run: (turnWriter, turnSignal) => {
      writer = turnWriter;
      signal = turnSignal;
      return new Promise((resolve, reject) => {
        settle = () => resolve(undefined);
        fail = reject;
      });
    },
  });
  return {
    turn,
    writer: () => writer,
    signal: () => signal,
    settle: () => settle(),
    fail: (/** @type {Error} */ error) => fail(error),
  };
};

/**
 * Read a view stream to completion.
 *
 * @param {any} view
 * @returns {Promise<any[]>}
 */
const collect = async view => {
  const events = [];
  for await (const event of iterateReader(view)) events.push(event);
  return events;
};

/**
 * Turn the microtask queue until the turn's status satisfies `predicate`. The
 * drain loop folds a pushed event several turns later — it reads through
 * `iterateReader`'s protocol chain — so inspecting state straight after a push
 * would race it.
 *
 * @param {any} turn
 * @param {(status: any) => boolean} predicate
 * @returns {Promise<any>} the satisfying status
 */
const untilStatus = async (turn, predicate) => {
  for (let tries = 0; tries < 100; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const status = await E(turn).getStatus();
    if (predicate(status)) return status;
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  throw Error('the turn never reached the expected state');
};

test('a closed view does not stop the turn', async t => {
  const driven = makeDrivenTurn();
  const abandoned = iterateReader(await E(driven.turn).watch());
  t.like(await abandoned.next(), { value: { type: 'snapshot' } });

  // What a dropped tab looks like from the daemon's side: the consumer stops
  // pulling. Under `converse(input) -> replyReader` this aborted the turn.
  await abandoned.return();
  await null;

  driven.writer().delta('still here');
  driven.writer().final('still here');
  driven.writer().end();
  driven.settle();
  await E(driven.turn).whenFinished();

  t.false(driven.signal().aborted);
  t.like(await E(driven.turn).getStatus(), {
    done: true,
    error: null,
    messages: [{ role: 'assistant', text: 'still here' }],
  });
});

test('a view opens on a snapshot of the turn so far', async t => {
  const driven = makeDrivenTurn();
  driven.writer().setPhase('using tools');
  driven.writer().delta('partial ');
  driven.writer().delta('answer');
  await untilStatus(
    driven.turn,
    status => status.streamingText === 'partial answer',
  );

  const view = iterateReader(await E(driven.turn).watch());
  const opening = await view.next();
  t.deepEqual(opening.value, {
    type: 'snapshot',
    status: {
      phase: 'using tools',
      streamingText: 'partial answer',
      messages: [],
      done: false,
      error: null,
      usage: null,
    },
  });

  // Live events resume exactly where the snapshot left off — no gap, no repeat.
  driven.writer().delta('!');
  const next = await view.next();
  t.deepEqual(next.value, { type: 'delta', text: '!' });
  await view.return();
});

test('concurrent views each see the rest of the turn', async t => {
  const driven = makeDrivenTurn();
  const first = collect(await E(driven.turn).watch());
  const second = collect(await E(driven.turn).watch());

  driven.writer().delta('hi');
  driven.writer().final('hi');
  driven.writer().end();
  driven.settle();

  const expected = [
    {
      type: 'snapshot',
      status: {
        phase: 'thinking',
        streamingText: '',
        messages: [],
        done: false,
        error: null,
        usage: null,
      },
    },
    { type: 'delta', text: 'hi' },
    { type: 'final', text: 'hi' },
    { type: 'end' },
  ];
  t.deepEqual(await first, expected);
  t.deepEqual(await second, expected);
});

test('cancel aborts the run and ends every view', async t => {
  const driven = makeDrivenTurn();
  const view = collect(await E(driven.turn).watch());
  driven.writer().delta('half a thought');
  await null;

  await E(driven.turn).cancel();
  t.true(driven.signal().aborted);

  // An aborted turn returns without settling its writer; only `cancel()`'s
  // close releases the daemon-side drain.
  driven.settle();
  await E(driven.turn).whenFinished();
  t.deepEqual((await view).at(-1), { type: 'end' });
  t.like(await E(driven.turn).getStatus(), {
    done: true,
    error: null,
    messages: [{ role: 'assistant', text: 'half a thought' }],
  });
});

test('cancellation remains observable until backend teardown settles', async t => {
  t.timeout(2000);
  const driven = makeDrivenTurn();
  const events = [];
  const view = await E(driven.turn).watch();
  const collected = (async () => {
    for await (const event of iterateReader(view)) events.push(event);
  })();
  let finished = false;
  const completion = E(driven.turn)
    .whenFinished()
    .then(() => {
      finished = true;
    });
  await E(driven.turn).cancel();
  await new Promise(resolve => setImmediate(resolve));
  t.false(finished);
  t.false(events.some(event => event.type === 'end' || event.type === 'abort'));
  t.like(await E(driven.turn).getStatus(), { done: false, error: null });
  driven.fail(Error('Hosted turn cancellation failed: backend wedged'));
  await completion;
  await collected;
  t.deepEqual(events.at(-1), {
    type: 'abort',
    reason: 'Hosted turn cancellation failed: backend wedged',
  });
  const finalStatus = await E(driven.turn).getStatus();
  t.like(finalStatus, {
    done: true,
    error: 'Hosted turn cancellation failed: backend wedged',
  });
  await E(driven.turn).cancel();
  t.deepEqual(await E(driven.turn).getStatus(), finalStatus);
});

test('writer termination does not outrun the execution barrier', async t => {
  t.timeout(2000);
  const driven = makeDrivenTurn();
  const events = collect(await E(driven.turn).watch());
  driven.writer().delta('buffered output');
  driven.writer().end();
  const pending = await untilStatus(
    driven.turn,
    status => status.messages.length === 1,
  );
  t.false(pending.done);
  driven.fail(Error('commit failed after output'));
  await E(driven.turn).whenFinished();
  t.deepEqual((await events).at(-1), {
    type: 'abort',
    reason: 'commit failed after output',
  });
});

test('a run returning without a terminal event still finishes', async t => {
  t.timeout(2000);
  const turn = makeSessionTurn({ run: async () => {} });
  await E(turn).whenFinished();
  t.true((await E(turn).getStatus()).done);
});

test('a turn that failed outright aborts its views', async t => {
  const driven = makeDrivenTurn();
  const view = collect(await E(driven.turn).watch());
  driven.fail(Error('provider exploded'));
  await E(driven.turn).whenFinished();
  t.deepEqual((await view).at(-1), {
    type: 'abort',
    reason: 'provider exploded',
  });
  t.like(await E(driven.turn).getStatus(), {
    done: true,
    error: 'provider exploded',
  });
});

test('a view opened after the turn ended replays the result and stops', async t => {
  const driven = makeDrivenTurn();
  driven.writer().final('done');
  driven.writer().end();
  driven.settle();
  await E(driven.turn).whenFinished();

  t.deepEqual(await collect(await E(driven.turn).watch()), [
    {
      type: 'snapshot',
      status: {
        phase: 'thinking',
        streamingText: '',
        messages: [{ role: 'assistant', text: 'done' }],
        done: true,
        error: null,
        usage: null,
      },
    },
    { type: 'end' },
  ]);
});

test('tool calls pair with their results across a snapshot', async t => {
  const driven = makeDrivenTurn();
  driven.writer().delta('checking');
  driven.writer().toolCall({ id: 'a', name: 'shell', args: '{}' });
  driven.writer().toolCall({ id: 'b', name: 'read', args: '{}' });
  const status = await untilStatus(
    driven.turn,
    ({ messages }) => messages.length === 3,
  );
  t.deepEqual(status.messages, [
    { role: 'assistant', text: 'checking' },
    { role: 'tool', id: 'a', name: 'shell', args: '{}', result: null },
    { role: 'tool', id: 'b', name: 'read', args: '{}', result: null },
  ]);

  // Concurrent calls settle out of order.
  driven.writer().toolResult({ id: 'b', name: 'read', result: 'contents' });
  driven.writer().toolResult({ id: 'a', name: 'shell', result: 'ok' });
  driven.writer().usage({ inputTokens: 11, outputTokens: 3, turns: 1 });
  driven.writer().final('checked');
  driven.writer().end();
  driven.settle();
  await E(driven.turn).whenFinished();

  t.deepEqual(await E(driven.turn).getStatus(), {
    phase: 'thinking',
    streamingText: '',
    messages: [
      { role: 'assistant', text: 'checking' },
      { role: 'tool', id: 'a', name: 'shell', args: '{}', result: 'ok' },
      { role: 'tool', id: 'b', name: 'read', args: '{}', result: 'contents' },
      { role: 'assistant', text: 'checked' },
    ],
    done: true,
    error: null,
    usage: { inputTokens: 11, outputTokens: 3, turns: 1 },
  });
});
