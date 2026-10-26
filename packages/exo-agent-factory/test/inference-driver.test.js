// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { make } from '../src/inference-driver.js';

/**
 * @param {any[]} messages
 * @param {Array<{ type: string, text?: string }>} results
 * @param {number} expectedDismissals
 */
const runDriver = async (messages, results, expectedDismissals) => {
  const replies = [];
  const dismissed = [];
  const requests = [];
  const finished = makePromiseKit();
  const agent = Far('Agent', {
    followMessages: () =>
      readerFromIterator(
        (async function* stream() {
          await null;
          yield* messages;
        })(),
      ),
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
  const lifecycle = Far('Lifecycle', { isActive: () => true });
  /** @type {Map<string, unknown>} */
  const named = new Map();
  named.set('agent', agent);
  named.set('inference', inference);
  named.set('agent-lifecycle', lifecycle);
  const powers = Far('Powers', { lookup: name => named.get(name) });
  return { powers, replies, dismissed, requests, finished: finished.promise };
};

test('inference driver answers completed packages and skips everything else', async t => {
  const run = await runDriver(
    [
      harden({ type: 'request', strings: [], number: 1n }),
      harden({
        type: 'package',
        done: false,
        strings: ['partial'],
        number: 2n,
      }),
      harden({ type: 'package', strings: ['hel', 'lo'], number: 3n }),
      harden({ type: 'package', done: true, strings: ['again'], number: 4n }),
    ],
    [{ type: 'ok', text: 'hi' }, { type: 'refused' }],
    2,
  );
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
  t.deepEqual(run.dismissed, [3n, 4n]);
  t.deepEqual(run.replies, [
    [3n, ['hi']],
    [4n, ['Inference did not complete (refused).']],
  ]);
  t.deepEqual(
    run.requests.map(({ prompt }) => prompt),
    ['hello', 'again'],
  );
  t.is(run.requests[0].promptOrigin, 'guest-influenced');
  t.is(run.requests[0].model, 'test-model');
  t.deepEqual(run.requests[0].limits, {
    maxWallClockMs: 10,
    maxOutputBytes: 20,
    maxTurns: 3,
  });
});

test('inference driver applies default limits without a model', async t => {
  const run = await runDriver(
    [harden({ type: 'package', strings: ['ask'], number: 1n })],
    [{ type: 'ok', text: 'answer' }],
    1,
  );
  await make(run.powers, undefined);
  await run.finished;
  t.false('model' in run.requests[0]);
  t.deepEqual(run.requests[0].limits, {
    maxWallClockMs: 300_000,
    maxOutputBytes: 1_000_000,
    maxTurns: 32,
  });
});
