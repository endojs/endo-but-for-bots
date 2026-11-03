// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';

import { defineAgent, makeEnvCredentials } from '../src/define-agent.js';
import { makePiAgent } from '../src/harness/pi-agent.js';
import { resolveModel } from '../src/harness/model.js';

/** @import { AddressInfo } from 'node:net' */
/** @import { ExecutionContext } from 'ava' */
/** @import { Model, Context } from '@earendil-works/pi-ai' */
/** @import { AgentTool, StreamFn } from '@earendil-works/pi-agent-core' */

/** @type {Model<string>} */
const scriptedModel = harden({
  id: 'scripted',
  name: 'scripted/model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:1/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});

/**
 * @param {() => void} [onExecute]
 * @returns {AgentTool<any>}
 */
const makeProbeTool = (onExecute = () => {}) => ({
  name: 'probeTool',
  label: 'probeTool',
  description: 'A tool the provider must be told about.',
  parameters: /** @type {any} */ ({ type: 'object', properties: {} }),
  execute: async () => {
    onExecute();
    return { content: [{ type: 'text', text: 'probed' }], details: undefined };
  },
});

/**
 * A stream function that records each context it receives and ends the turn.
 *
 * @param {Context[]} contexts
 * @returns {StreamFn}
 */
const makeRecordingStreamFn = contexts => (model, context) => {
  contexts.push(context);
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
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
      },
    });
  });
  return stream;
};

/**
 * Pi 0.86 and later carry the system prompt and the tool declarations only in
 * a leading system message of the context, not in `systemPrompt` and `tools`
 * fields.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {Context} context
 */
const assertContextCarriesSystemMessage = (t, context) => {
  const [first] = context.messages;
  t.is(first.role, 'system');
  const system = /** @type {any} */ (first);
  t.is(system.content, 'SYS');
  t.deepEqual(
    system.toolsAdded.map(tool => tool.name),
    ['probeTool'],
  );
};

test('makePiAgent passes the system prompt and tools to the stream function', async t => {
  /** @type {Context[]} */
  const contexts = [];
  const agent = makePiAgent({
    model: scriptedModel,
    tools: [makeProbeTool()],
    systemPrompt: 'SYS',
    streamFn: makeRecordingStreamFn(contexts),
  });

  await agent.prompt('hello');

  t.is(contexts.length, 1);
  t.deepEqual(
    contexts[0].messages.map(message => message.role),
    ['system', 'user'],
  );
  assertContextCarriesSystemMessage(t, contexts[0]);
});

test('makePiAgent passes the system prompt ahead of seeded messages', async t => {
  /** @type {Context[]} */
  const contexts = [];
  const agent = makePiAgent({
    model: scriptedModel,
    tools: [makeProbeTool()],
    systemPrompt: 'SYS',
    messages: [{ role: 'user', content: 'earlier', timestamp: 1 }],
    streamFn: makeRecordingStreamFn(contexts),
  });

  await agent.prompt('hello');

  t.deepEqual(
    contexts[0].messages.map(message => message.role),
    ['system', 'user', 'user'],
  );
  assertContextCarriesSystemMessage(t, contexts[0]);
});

test('makePiAgent honors a caller-supplied convertToLlm', async t => {
  /** @type {Context[]} */
  const contexts = [];
  const agent = makePiAgent({
    model: scriptedModel,
    tools: [],
    systemPrompt: 'SYS',
    convertToLlm: messages =>
      /** @type {any} */ (messages.filter(message => message.role === 'user')),
    streamFn: makeRecordingStreamFn(contexts),
  });

  await agent.prompt('hello');

  t.deepEqual(
    contexts[0].messages.map(message => message.role),
    ['user'],
  );
});

test('defineAgent passes its instructions and tools to the stream function', async t => {
  /** @type {Context[]} */
  const contexts = [];
  const maker = defineAgent({
    model: scriptedModel,
    instructions: 'SYS',
    tools: [makeProbeTool()],
  });
  const agent = maker({ streamFn: makeRecordingStreamFn(contexts) });

  await agent.prompt('hello');

  assertContextCarriesSystemMessage(t, contexts[0]);
});

/**
 * Serve an OpenAI-compatible streaming endpoint that records each request body
 * and replies with the next scripted delta.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {Array<{ delta: object, finishReason: string }>} script
 * @returns {Promise<{ origin: string, requests: any[] }>}
 */
const startFakeProvider = async (t, script) => {
  /** @type {any[]} */
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      const { delta, finishReason } = script[requests.length];
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      /** @param {object} choice */
      const writeChunk = choice =>
        response.write(
          `data: ${JSON.stringify({
            id: 'chunk',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake',
            choices: [{ index: 0, ...choice }],
          })}\n\n`,
        );
      writeChunk({ delta, finish_reason: null });
      writeChunk({ delta: {}, finish_reason: finishReason });
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  t.teardown(() => {
    server.close();
  });
  const address = /** @type {AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${address.port}`, requests };
};

/**
 * A `fetch` over `node:http` with keep-alive disabled (`agent: false`). The
 * global `fetch` (undici) pools sockets per origin and, on Node 24, closes the
 * pool once its sockets disconnect; the `ClientDestroyedError` it builds then
 * assigns `message` over SES's frozen `Error.prototype`, which surfaces as a
 * fatal unhandled rejection. Each request here owns and closes its socket.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
const httpFetch = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        agent: false,
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
      },
      res => {
        resolve(
          new Response(/** @type {ReadableStream} */ (Readable.toWeb(res)), {
            status: res.statusCode,
            headers: /** @type {Record<string, string>} */ (res.headers),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });

/** @type {StreamFn} */
const streamOverHttp = (model, context, options) =>
  streamSimple(model, context, { ...options, fetch: httpFetch });

test('makePiAgent declares the system prompt and tools to a real provider adapter', async t => {
  const { origin, requests } = await startFakeProvider(t, [
    {
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'probeTool', arguments: '{}' },
          },
        ],
      },
      finishReason: 'tool_calls',
    },
    {
      delta: { role: 'assistant', content: 'OK' },
      finishReason: 'stop',
    },
  ]);
  let executions = 0;
  const agent = makePiAgent({
    model: await resolveModel(
      'ollama/fake',
      makeEnvCredentials({ OLLAMA_HOST: origin }),
    ),
    tools: [
      makeProbeTool(() => {
        executions += 1;
      }),
    ],
    systemPrompt: 'SYS',
    streamFn: streamOverHttp,
    getApiKey: async () => 'ollama',
  });

  await agent.prompt('hello');

  t.is(agent.state.errorMessage, undefined);
  t.is(executions, 1);
  t.is(requests.length, 2);
  for (const { messages, tools } of requests) {
    t.like(messages[0], { role: 'system', content: 'SYS' });
    t.deepEqual(
      tools.map(tool => tool.function.name),
      ['probeTool'],
    );
  }
  t.deepEqual(
    requests[1].messages.map(message => message.role),
    ['system', 'user', 'assistant', 'tool'],
  );
});
