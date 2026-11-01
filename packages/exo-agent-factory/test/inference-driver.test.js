// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { Fail } from '@endo/errors';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { make } from '../src/inference-driver.js';

const self = 'endo://fake/child';
const parent = 'endo://fake/parent';

/**
 * A driver guest whose directory is the ledger, a child mailbox over a fixed
 * message list, and a child-scoped inference capability that answers from a
 * script.
 *
 * @param {object} options
 * @param {any[]} options.messages
 * @param {any[]} options.results
 * @param {number} options.expectedDismissals
 * @param {Map<string, unknown>} [options.directory] - A previous
 *   incarnation's driver guest directory, to replay against.
 * @param {any} [options.lifecycle]
 */
const runDriver = ({
  messages,
  results,
  expectedDismissals,
  directory = new Map(),
  lifecycle = Far('Lifecycle', {
    isActive: () => true,
    followActive: () => Fail`an active lifecycle need not be followed`,
  }),
}) => {
  let followed = false;
  const replies = [];
  const dismissed = [];
  const requests = [];
  const finished = makePromiseKit();
  const agent = Far('Agent', {
    locate: name => (name === '@self' ? self : undefined),
    followMessages: () => {
      followed = true;
      return readerFromIterator(
        (async function* stream() {
          await null;
          yield* messages;
        })(),
      );
    },
    reply: (number, strings) => {
      replies.push([number, strings]);
    },
    dismiss: number => {
      dismissed.push(number);
      if (dismissed.length === expectedDismissals) finished.resolve(undefined);
    },
  });
  const inference = Far('ChildInference', {
    infer: request => {
      requests.push(request);
      return harden(results.shift());
    },
  });
  directory.set('agent', agent);
  directory.set(
    'inference-source',
    Far('InferenceSource', {
      childInference: child => {
        child === agent || Fail`grant requested for a foreign agent`;
        return inference;
      },
    }),
  );
  directory.set('agent-lifecycle', lifecycle);
  const powers = Far('Powers', {
    has: name => directory.has(name),
    lookup: name => directory.get(name),
    storeValue: (value, name) => {
      directory.set(name, value);
    },
  });
  return {
    powers,
    directory,
    replies,
    dismissed,
    requests,
    finished: finished.promise,
    wasFollowed: () => followed,
  };
};

/**
 * @param {bigint} number
 * @param {string[]} strings
 * @param {object} [extra]
 */
const mail = (number, strings, extra = {}) =>
  harden({ type: 'package', from: parent, number, strings, ...extra });

test('inference driver answers completed packages and skips everything else', async t => {
  const run = runDriver({
    messages: [
      harden({ type: 'request', from: parent, strings: [], number: 1n }),
      mail(2n, ['partial'], { done: false }),
      mail(3n, ['own echo']),
      mail(4n, ['hel', 'lo']),
      mail(5n, ['again'], { done: true }),
    ].map(message =>
      message.number === 3n ? harden({ ...message, from: self }) : message,
    ),
    results: [
      { type: 'ok', text: 'hi' },
      { type: 'limit-exceeded', which: 'max-turns' },
    ],
    expectedDismissals: 2,
  });
  run.directory.set('instructions', 'Be brief.');
  const driver = await make(run.powers, undefined, {
    env: {
      MAX_WALL_CLOCK_MS: '10',
      MAX_OUTPUT_BYTES: '20',
      MAX_TURNS: '3',
      MODEL: 'test-model',
    },
  });
  t.truthy(driver);
  await run.finished;
  t.deepEqual(run.dismissed, [4n, 5n]);
  t.deepEqual(run.replies, [
    [4n, ['hi']],
    [5n, ['Inference limit exceeded: max-turns.']],
  ]);
  t.deepEqual(
    run.requests.map(({ prompt }) => prompt),
    ['Be brief.\n\nhello', 'Be brief.\n\nagain'],
  );
  t.false('guest' in run.requests[0], 'the grant derives its own projection');
  t.is(run.requests[0].promptOrigin, 'guest-influenced');
  t.is(run.requests[0].model, 'test-model');
  t.deepEqual(run.requests[0].limits, {
    maxWallClockMs: 10,
    maxOutputBytes: 20,
    maxTurns: 3,
  });
  t.deepEqual(run.directory.get('turn-4-result'), {
    type: 'TurnResult',
    key: 4n,
    result: { type: 'ok', text: 'hi' },
  });
  t.deepEqual(run.directory.get('turn-5-published'), {
    type: 'Published',
    key: 5n,
  });
});

test('inference driver applies default limits without a model or instructions', async t => {
  const run = runDriver({
    messages: [mail(1n, ['ask'])],
    results: [{ type: 'ok', text: 'answer' }],
    expectedDismissals: 1,
  });
  await make(run.powers, undefined);
  await run.finished;
  t.false('model' in run.requests[0]);
  t.is(run.requests[0].prompt, 'ask');
  t.deepEqual(run.requests[0].limits, {
    maxWallClockMs: 300_000,
    maxOutputBytes: 1_000_000,
    maxTurns: 32,
  });
});

test('a revived inference driver republishes a recorded result without inference', async t => {
  const first = runDriver({
    messages: [mail(7n, ['question'])],
    results: [{ type: 'ok', text: 'recorded answer' }],
    expectedDismissals: 1,
  });
  await make(first.powers, undefined);
  await first.finished;

  // Model a crash after `TurnResult` and before `Published`: the next
  // incarnation sees the result record but no publication, and the message is
  // still in the mailbox.
  const directory = new Map(first.directory);
  directory.delete('turn-7-published');
  directory.delete('turn-cursor');
  const second = runDriver({
    messages: [mail(7n, ['question']), mail(8n, ['next'])],
    results: [{ type: 'ok', text: 'fresh answer' }],
    expectedDismissals: 2,
    directory,
  });
  await make(second.powers, undefined);
  await second.finished;

  t.deepEqual(second.replies, [
    [7n, ['recorded answer']],
    [8n, ['fresh answer']],
  ]);
  t.deepEqual(
    second.requests.map(({ prompt }) => prompt),
    ['next'],
    'the recorded turn does not call inference again',
  );

  // A third incarnation over a fully published ledger answers nothing again
  // but still dismisses, so a crash between `Published` and dismissal heals.
  const third = runDriver({
    messages: [mail(7n, ['question']), mail(8n, ['next'])],
    results: [],
    expectedDismissals: 2,
    directory: new Map(second.directory),
  });
  await make(third.powers, undefined);
  await third.finished;
  t.deepEqual(third.replies, []);
  t.deepEqual(third.requests, []);
  t.deepEqual(third.dismissed, [7n, 8n]);
});

/**
 * A lifecycle that starts inactive and then reports the given transitions.
 *
 * @param {boolean[]} transitions
 */
const makePendingLifecycle = transitions => {
  const reported = makePromiseKit();
  let active = false;
  const lifecycle = Far('Lifecycle', {
    isActive: () => active,
    followActive: () =>
      Far('ActiveIterator', {
        next: async () => {
          await null;
          if (transitions.length === 0) {
            reported.resolve(undefined);
            return harden({ done: true, value: undefined });
          }
          active = /** @type {boolean} */ (transitions.shift());
          return harden({ done: false, value: active });
        },
      }),
  });
  return { lifecycle, reported: reported.promise };
};

test('a runner formulated before its child commits waits for activation', async t => {
  const { lifecycle } = makePendingLifecycle([true]);
  const run = runDriver({
    messages: [mail(1n, ['early'])],
    results: [{ type: 'ok', text: 'answered' }],
    expectedDismissals: 1,
    lifecycle,
  });
  await make(run.powers, undefined);
  await run.finished;
  t.deepEqual(run.replies, [[1n, ['answered']]]);
});

test('a runner revived during removal never opens its mailbox', async t => {
  const { lifecycle, reported } = makePendingLifecycle([false]);
  const run = runDriver({
    messages: [mail(1n, ['ignored'])],
    results: [],
    expectedDismissals: 1,
    lifecycle,
  });
  await make(run.powers, undefined);
  await reported;
  await new Promise(resolve => setTimeout(resolve, 10));
  t.false(run.wasFollowed());
  t.deepEqual(run.requests, []);
});
