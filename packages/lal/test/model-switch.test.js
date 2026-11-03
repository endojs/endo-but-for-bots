// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { createServer } from 'node:http';

import { makeEnvCredentials, makePiAgent } from '@endo/agentry/harness';
import { formatLocator, formatLocatorWithHints } from '@endo/daemon/locator.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

/** @import { AddressInfo } from 'node:net' */

import { spawnWorkerLoop } from '../agent.js';
import { runInboxLoop } from '../inbox-loop.js';
import {
  makeModelCommandHandler,
  makeModelKeyResolver,
  parseModelCommand,
} from '../model-switch.js';
import { runRound } from '../round-runner.js';

const node = '0'.repeat(64);
const hostId = `${'a'.repeat(64)}:${node}`;
const selfId = `${'b'.repeat(64)}:${node}`;
const peerId = `${'c'.repeat(64)}:${node}`;
const hostLocator = formatLocator(hostId, 'host');
const peerLocator = formatLocator(peerId, 'guest');

/**
 * @param {string} provider
 * @param {string} id
 * @param {object} [overrides]
 * @returns {any}
 */
const stubModel = (provider, id, overrides = {}) =>
  harden({
    id,
    name: `${provider}/${id}`,
    api: `${provider}-api`,
    provider,
    baseUrl: `https://${provider}.invalid`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
    ...overrides,
  });

const alpha = stubModel('alpha', 'one');
const alphaTwo = stubModel('alpha', 'two');
const beta = stubModel('beta', 'one', { reasoning: true });
const ollama = stubModel('openai', 'local', {
  name: 'ollama/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
});

/**
 * @param {object} args
 * @param {Array<object>} args.messages Inbound mail, delivered in order.
 */
const makeInboxPowers = ({ messages }) => {
  /** @type {Array<{ number: unknown, strings: string[] }>} */
  const replies = [];
  /** @type {unknown[]} */
  const dismissed = [];
  const powers = harden({
    send: async () => {},
    locate: async (/** @type {string} */ name) =>
      formatLocator(name === '@self' ? selfId : hostId, 'host'),
    followMessages: () =>
      readerFromIterator(
        (async function* follow() {
          yield* messages;
        })(),
      ),
    reply: async (
      /** @type {unknown} */ messageNumber,
      /** @type {string[]} */ strings,
    ) => {
      replies.push({ number: messageNumber, strings });
    },
    dismiss: async (/** @type {unknown} */ messageNumber) => {
      dismissed.push(messageNumber);
    },
  });
  return { powers, replies, dismissed };
};

/**
 * @param {bigint} n
 * @param {string} text
 * @param {string} [from]
 */
const mail = (n, text, from = hostLocator) =>
  harden({
    number: n,
    from,
    type: 'package',
    done: true,
    strings: [text],
    names: [],
    ids: [],
  });

/**
 * A stream function that records what each LLM request saw.
 *
 * @param {Array<{ model: string, apiKey: unknown, texts: string[] }>} calls
 * @returns {any}
 */
const makeRecordingStreamFn = calls => (model, context, options) => {
  calls.push({
    model: `${model.provider}/${model.id}`,
    apiKey: options?.apiKey,
    texts: context.messages.flatMap((/** @type {any} */ { content }) =>
      typeof content === 'string'
        ? [content]
        : content.flatMap((/** @type {any} */ block) =>
            block.type === 'text' ? [block.text] : [],
          ),
    ),
  });
  const stream = createAssistantMessageEventStream();
  const message = /** @type {any} */ ({
    role: 'assistant',
    content: [{ type: 'text', text: `reply ${calls.length}` }],
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
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
  return stream;
};

/**
 * @param {object} args
 * @param {Array<object>} args.messages
 * @param {Record<string, string>} [args.env]
 * @param {any} [args.model]
 */
const runWorker = async ({ messages, env = {}, model = alpha }) => {
  const keyForModel = makeModelKeyResolver(
    makeEnvCredentials(env),
    'worker-token',
    model,
  );
  /** @type {Array<{ model: string, apiKey: unknown, texts: string[] }>} */
  const calls = [];
  /** @type {any} */
  const piAgent = makePiAgent({
    systemPrompt: 'system',
    model,
    tools: [],
    streamFn: makeRecordingStreamFn(calls),
    getApiKey: () => keyForModel(piAgent.state.model),
  });
  const { powers, replies, dismissed } = makeInboxPowers({ messages });
  await runInboxLoop({
    powers,
    getCancelled: async () => null,
    runOneRound: prompt => runRound(piAgent, prompt),
    handleModelCommand: makeModelCommandHandler({
      piAgent,
      keyForModel,
      resolve: async name =>
        ({
          'alpha/one': alpha,
          'alpha/two': alphaTwo,
          'beta/one': beta,
        })[name],
      hasAmbientKey: () => false,
    }),
  });
  return { calls, replies, dismissed, piAgent };
};

test('parseModelCommand accepts only a bare /model line', t => {
  /** @param {string[]} strings */
  const parse = strings => parseModelCommand({ type: 'package', strings });
  t.deepEqual(parse(['/model']), { argument: undefined });
  t.deepEqual(parse([' /model  beta/one \n']), { argument: 'beta/one' });
  t.deepEqual(parse(['/model a b']), { argument: 'a b' });
  t.is(parse(['/models are great']), undefined);
  t.is(parse(['please run /model beta/one']), undefined);
  t.is(parse(['/model ', ' more']), undefined);
  t.is(
    parseModelCommand({ type: 'value', strings: ['/model beta/one'] }),
    undefined,
  );
});

test('the worker auth token stays with its configured endpoint', t => {
  const keyForModel = makeModelKeyResolver(
    makeEnvCredentials({}),
    'worker-token',
    alpha,
  );
  t.is(keyForModel(alphaTwo), 'worker-token');
  t.is(keyForModel(beta), undefined);
  t.is(
    keyForModel(
      stubModel('alpha', 'one', { baseUrl: 'https://other.invalid' }),
    ),
    undefined,
  );
  t.is(keyForModel(ollama), 'ollama');
});

test('a switched model uses the credential of its own provider', t => {
  const keyForModel = makeModelKeyResolver(
    makeEnvCredentials({ BETA_API_KEY: 'beta-key' }),
    'worker-token',
    alpha,
  );
  t.is(keyForModel(beta), 'beta-key');
});

test('/model switches provider between rounds and carries the transcript', async t => {
  const { calls, replies, dismissed, piAgent } = await runWorker({
    env: { BETA_API_KEY: 'beta-key' },
    messages: [
      mail(1n, 'first'),
      mail(2n, '/model beta/one'),
      mail(3n, 'second'),
    ],
  });
  t.is(calls.length, 2, 'the command does not run an LLM round');
  t.is(calls[0].model, 'alpha/one');
  t.is(calls[0].apiKey, 'worker-token');
  t.is(calls[1].model, 'beta/one');
  t.is(calls[1].apiKey, 'beta-key');
  t.true(calls[1].texts.includes('reply 1'));
  t.deepEqual(dismissed, [2n]);
  t.is(replies.length, 1);
  t.is(replies[0].number, 2n);
  t.regex(replies[0].strings[0], /Now using beta\/one/);
  t.is(piAgent.state.thinkingLevel, 'medium');
});

test('/model recognizes the host when its locator carries hints', async t => {
  const { calls } = await runWorker({
    env: { BETA_API_KEY: 'beta-key' },
    messages: [
      mail(
        1n,
        '/model beta/one',
        formatLocatorWithHints(hostId, 'host', ['tcp://127.0.0.1:1']),
      ),
      mail(2n, 'next'),
    ],
  });
  t.is(calls[0].model, 'beta/one');
});

test('/model from a sender other than the host is ordinary mail', async t => {
  const { calls, replies, dismissed } = await runWorker({
    env: { BETA_API_KEY: 'beta-key' },
    messages: [mail(1n, '/model beta/one', peerLocator)],
  });
  t.is(calls.length, 1);
  t.is(calls[0].model, 'alpha/one');
  t.deepEqual(replies, []);
  t.deepEqual(dismissed, []);
});

test('a rejected /model keeps the current model', async t => {
  const { calls, replies, dismissed } = await runWorker({
    messages: [
      mail(1n, '/model nosuch/model'),
      mail(2n, '/model beta/one'),
      mail(3n, '/model not-a-model-string'),
      mail(4n, 'next'),
    ],
  });
  t.is(calls.length, 1);
  t.is(calls[0].model, 'alpha/one');
  t.is(calls[0].apiKey, 'worker-token');
  t.regex(replies[0].strings[0], /Unknown model nosuch\/model/);
  t.regex(replies[1].strings[0], /No credential for beta/);
  t.regex(replies[2].strings[0], /Usage/);
  t.deepEqual(dismissed, [1n, 2n, 3n]);
});

test('/model with no argument reports the current model', async t => {
  const { calls, replies } = await runWorker({
    messages: [mail(1n, '/model')],
  });
  t.is(calls.length, 0);
  t.regex(replies[0].strings[0], /Using alpha\/one/);
});

test('a failing /model replies with the error and skips the round', async t => {
  /** @type {any} */
  const piAgent = makePiAgent({
    systemPrompt: 'system',
    model: alpha,
    tools: [],
    streamFn: makeRecordingStreamFn([]),
  });
  const { powers, replies, dismissed } = makeInboxPowers({
    messages: [mail(1n, '/model beta/one')],
  });
  let rounds = 0;
  await runInboxLoop({
    powers,
    getCancelled: async () => null,
    runOneRound: async () => {
      rounds += 1;
    },
    handleModelCommand: makeModelCommandHandler({
      piAgent,
      keyForModel: () => undefined,
      resolve: async () => {
        throw Error('catalog unavailable');
      },
    }),
  });
  t.is(rounds, 0);
  t.deepEqual(replies, [
    { number: 1n, strings: ['/model failed: catalog unavailable'] },
  ]);
  t.deepEqual(dismissed, [1n]);
  t.is(piAgent.state.model, alpha);
});

test('/model accepts a provider with only an ambient credential', async t => {
  /** @type {any} */
  const piAgent = makePiAgent({
    systemPrompt: 'system',
    model: alpha,
    tools: [],
    streamFn: makeRecordingStreamFn([]),
  });
  const handle = makeModelCommandHandler({
    piAgent,
    keyForModel: () => undefined,
    resolve: async () => beta,
    hasAmbientKey: provider => provider === 'beta',
  });
  const reply = await handle({ argument: 'beta/one' });
  t.regex(reply, /Now using beta\/one/);
  t.is(piAgent.state.model, beta);
  t.is(piAgent.state.thinkingLevel, 'medium');
});

test.serial('spawnWorkerLoop applies /model to real requests', async t => {
  /** @type {Array<{ body: any, authorization: unknown }>} */
  const requests = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => {
      text += chunk;
    });
    request.on('end', () => {
      requests.push({
        body: JSON.parse(text),
        authorization: request.headers.authorization,
      });
      const chunk = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: `reply ${requests.length}` },
            finish_reason: 'stop',
          },
        ],
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  t.teardown(() => server.close());
  const { port } = /** @type {AddressInfo} */ (server.address());
  const priorHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  t.teardown(() => {
    if (priorHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = priorHost;
    }
  });

  const { powers, replies } = makeInboxPowers({
    messages: [
      mail(1n, 'first'),
      mail(2n, '/model nosuch/model'),
      mail(3n, '/model ollama/beta'),
      mail(4n, 'second'),
    ],
  });
  await spawnWorkerLoop(powers, null, {
    LAL_HOST: 'http://localhost:11434',
    LAL_MODEL: 'alpha',
    LAL_AUTH_TOKEN: 'worker-token',
  });

  t.regex(replies[0].strings[0], /Unknown model nosuch\/model/);
  t.regex(replies[1].strings[0], /Now using ollama\/beta/);
  t.is(requests.length, 2);
  t.is(requests[0].body.model, 'alpha');
  t.is(requests[1].body.model, 'beta');
  t.is(requests[1].authorization, 'Bearer worker-token');
  t.true(JSON.stringify(requests[1].body.messages).includes('reply 1'));
});
