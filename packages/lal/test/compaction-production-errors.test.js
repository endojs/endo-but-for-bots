// @ts-check
// `@endo/ses-ava/prepare-endo.js` locks down with `errorTaming: 'unsafe'`, which
// stops `Fail` from redacting, so these errors must be tested under the plain
// `@endo/init` lockdown that a daemon worker runs (`daemon/src/worker-node.js`).
import '@endo/init';

import test from 'ava';

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { makePiAgent } from '@endo/agentry/harness';
import { formatLocator, formatLocatorWithHints } from '@endo/daemon/locator.js';
import { Fail } from '@endo/errors';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { defaultCompactionSettings, makeCompactor } from '../compaction.js';
import { runInboxLoop } from '../inbox-loop.js';

const node = '0'.repeat(64);
const hostId = `${'a'.repeat(64)}:${node}`;
const selfId = `${'b'.repeat(64)}:${node}`;
const hostLocator = formatLocator(hostId, 'host');

/** @type {any} */
const model = harden({
  id: 'stub',
  name: 'stub/stub',
  api: 'stub-api',
  provider: 'stub',
  baseUrl: 'https://stub.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
});

/**
 * @param {string} role
 * @param {string} text
 * @returns {any}
 */
const textMessage = (role, text) => ({
  role,
  content: [{ type: 'text', text }],
  timestamp: 0,
});

/**
 * What the host reads after `/compact` meets the given summary response.
 *
 * @param {object} response
 * @returns {Promise<string[]>}
 */
const replyToFailedSummary = async response => {
  /** @type {any} */
  const message = {
    ...textMessage('assistant', ''),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...response,
  };
  /** @type {any} */
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'error', reason: 'error', error: message });
    stream.end(message);
    return stream;
  };
  const filler = 'x'.repeat(800);
  const piAgent = makePiAgent({
    systemPrompt: 'system',
    model,
    tools: [],
    messages: [
      textMessage('user', filler),
      textMessage('user', filler),
      textMessage('user', filler),
    ],
    streamFn,
    getApiKey: () => 'key',
  });
  const compactor = makeCompactor({
    piAgent,
    streamFn,
    settings: harden({
      ...defaultCompactionSettings,
      reserveTokens: 1000,
      keepRecentTokens: 100,
    }),
  });
  /** @type {string[]} */
  const replies = [];
  await runInboxLoop({
    powers: /** @type {any} */ (
      harden({
        send: async () => {},
        locate: async (/** @type {string} */ name) =>
          formatLocatorWithHints(name === '@self' ? selfId : hostId, 'host', [
            'tcp://127.0.0.1:1234',
          ]),
        followMessages: () =>
          readerFromIterator(
            (async function* follow() {
              yield harden({
                number: 1n,
                from: hostLocator,
                type: 'package',
                done: true,
                strings: ['/compact'],
                names: [],
                ids: [],
              });
            })(),
          ),
        reply: async (
          /** @type {unknown} */ _number,
          /** @type {string[]} */ strings,
        ) => {
          replies.push(...strings);
        },
        dismiss: async () => {},
      })
    ),
    getCancelled: async () => null,
    runOneRound: async () => {
      throw Error('a command is not a round');
    },
    handleCompactCommand: async () => {
      await compactor.compact();
      return 'compacted';
    },
  });
  return replies;
};

test('this lockdown redacts bare substitutions', t => {
  t.throws(() => Fail`${'secret'}`, { message: '(a string)' });
});

test('a failed summary tells the host why', async t => {
  t.deepEqual(
    await replyToFailedSummary({
      stopReason: 'error',
      errorMessage: 'provider down',
    }),
    [
      '/compact failed: Compaction summary stopped with "error": "provider down"',
    ],
  );
});

test('a partial summary tells the host how it stopped', async t => {
  t.deepEqual(await replyToFailedSummary({ stopReason: 'length' }), [
    '/compact failed: Compaction summary stopped with "length": "no error message"',
  ]);
});
