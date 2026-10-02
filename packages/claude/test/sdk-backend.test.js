// @ts-check
// spell-out-exempt: `num_turns` and `CLAUDE_CONFIG_DIR` are names Claude Code defines.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';

import { makeClaudeSdkBackend } from '../src/sdk-backend.js';
import {
  CREDENTIAL,
  FORMULA_IDENTIFIER,
  makeCredentialSource,
  makeManualTimers,
  makeMemoryScratch,
  makeProjection,
  makeRequest,
  settle,
  shapeTable,
} from './_backend-fixtures.js';

/** @import { SdkQuery } from '../src/backends.types.js' */
/** @import { ShapeTable } from '@endo/inference/types.js' */

const VERSION = '2.1.268';

/**
 * @param {string} id
 * @param {string} text
 */
const assistant = (id, text) => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text }] },
});

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'stored',
  num_turns: 3,
  usage: { input_tokens: 7, output_tokens: 2 },
};

/**
 * @param {SdkQuery} query
 * @param {object} [options]
 * @param {ReturnType<typeof makeCredentialSource>} [options.source]
 * @param {ShapeTable} [options.responseShapes]
 * @param {ReturnType<typeof makeMemoryScratch>} [options.scratch]
 */
const makeHarness = (query, options = {}) => {
  const { source = makeCredentialSource(), responseShapes } = options;
  const scratch = options.scratch ?? makeMemoryScratch();
  const manualTimers = makeManualTimers();
  const backend = makeClaudeSdkBackend({
    credentialSource: source.credentialSource,
    query,
    executablePath: '/opt/claude/bin/claude',
    version: VERSION,
    makeScratchDirectory: scratch.makeScratchDirectory,
    timers: manualTimers.timers,
    pathValue: '/opt/claude/bin',
    maxBudgetUsd: 0.25,
    ...(responseShapes === undefined ? {} : { responseShapes }),
  });
  return { backend, scratch, source, manualTimers };
};

/**
 * @param {unknown[]} messages
 */
const replay = messages => {
  /** @type {{ prompt: string, options: Record<string, any> }[]} */
  const calls = [];
  /** @type {SdkQuery} */
  const query = async function* replayQuery(parameters) {
    calls.push(parameters);
    yield* messages;
  };
  return { query, calls };
};

test('describe names the vendor and the harness separately', t => {
  const { backend } = makeHarness(replay([]).query);
  t.deepEqual(backend.describe(), {
    provider: 'anthropic',
    kind: 'claude-sdk',
    version: VERSION,
  });
});

test('a turn hands the projection server in process with the confinement options', async t => {
  const server = harden({ kind: 'in-process-server' });
  const { guest, calls: projectionCalls } = makeProjection(server);
  const { query, calls } = replay([
    { type: 'system', subtype: 'init' },
    assistant('message-1', 'ok'),
    success,
  ]);
  const { backend, source, scratch } = makeHarness(query);
  const result = await backend.infer(
    makeRequest({ guest, model: 'claude-opus-5-5' }),
  );
  t.deepEqual(result, {
    type: 'ok',
    text: 'stored',
    usage: { inputTokens: 7, outputTokens: 2, turns: 3 },
  });

  t.is(calls.length, 1);
  const [{ prompt, options }] = calls;
  t.is(prompt, 'write then read');
  t.is(projectionCalls.buildMcpServer, 1);
  t.is(options.mcpServers.endo.instance, server);
  t.deepEqual(Object.keys(options.mcpServers), ['endo']);
  t.like(options, {
    pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
    cwd: '/scratch/turn',
    tools: [],
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    persistSession: false,
    maxTurns: 4,
    model: 'claude-opus-5-5',
    maxBudgetUsd: 0.25,
    allowedTools: ['mcp__endo__readText', 'mcp__endo__writeText'],
  });
  t.true(options.disallowedTools.includes('Bash'));
  t.is(options.env.ANTHROPIC_AUTH_TOKEN, CREDENTIAL);
  t.is(options.env.HOME, '/scratch/turn/config');
  t.is(options.env.CLAUDE_CONFIG_DIR, '/scratch/turn/config');
  t.is(options.abortController.signal.aborted, false);

  const { abortController: _abort, mcpServers: _servers, ...rest } = options;
  t.false(
    JSON.stringify([prompt, rest]).includes(FORMULA_IDENTIFIER),
    'the formula identifier is a label and never reaches the provider',
  );
  t.deepEqual(source.counts, { acquired: 1, released: 1 });
  t.deepEqual(scratch.state, { made: 1, removed: 1 });
});

test('a refused admission maps to its tag and never queries', async t => {
  const { query, calls } = replay([success]);
  const source = makeCredentialSource({ refusal: { reason: 'rate-limited' } });
  const { backend } = makeHarness(query, { source });
  t.deepEqual(await backend.infer(makeRequest()), { type: 'rate-limited' });
  t.is(calls.length, 0);
});

test('a credential source that rejects is unavailable and never queries', async t => {
  const { query, calls } = replay([success]);
  const source = makeCredentialSource({ failure: Error('vault sealed') });
  const { backend, scratch } = makeHarness(query, { source });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'credential source failed: vault sealed',
  });
  t.is(calls.length, 0);
  t.is(scratch.state.made, 0);
});

test('output beyond the byte limit aborts the query', async t => {
  /** @type {AbortController | undefined} */
  let abortController;
  /** @type {SdkQuery} */
  const query = async function* largeQuery({ options }) {
    abortController = /** @type {AbortController} */ (options.abortController);
    yield assistant('message-1', 'x'.repeat(500));
    yield success;
  };
  const { backend, source } = makeHarness(query);
  t.deepEqual(
    await backend.infer(makeRequest({ limits: { maxOutputBytes: 100 } })),
    { type: 'limit-exceeded', which: 'output-bytes' },
  );
  t.true(abortController?.signal.aborted);
  t.is(source.counts.released, 1);
});

test('more model turns than the limit aborts the query', async t => {
  const { query } = replay([
    assistant('message-1', 'a'),
    assistant('message-2', 'b'),
    assistant('message-3', 'c'),
    success,
  ]);
  const { backend } = makeHarness(query);
  t.deepEqual(await backend.infer(makeRequest({ limits: { maxTurns: 2 } })), {
    type: 'limit-exceeded',
    which: 'max-turns',
  });
});

test('the wall clock aborts a query that never finishes', async t => {
  /** @type {SdkQuery} */
  const query = async function* hangingQuery({ options }) {
    const signal = /** @type {AbortController} */ (options.abortController)
      .signal;
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(Error('aborted'))),
    );
    yield success;
  };
  const { backend, manualTimers } = makeHarness(query);
  const resultP = backend.infer(makeRequest());
  await settle();
  manualTimers.fire();
  t.deepEqual(await resultP, { type: 'limit-exceeded', which: 'wall-clock' });
});

test("the SDK's own turn ceiling maps to limit-exceeded", async t => {
  const { query } = replay([
    { type: 'result', subtype: 'error_max_turns', is_error: true },
  ]);
  const { backend } = makeHarness(query);
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'limit-exceeded',
    which: 'max-turns',
  });
});

test('a query that throws is unavailable unless a pinned row matches', async t => {
  /** @type {SdkQuery} */
  // eslint-disable-next-line require-yield
  const query = async function* failingQuery() {
    throw Error('Claude Code process exited with code 1');
  };
  const { backend, source } = makeHarness(query);
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'turn failed: Claude Code process exited with code 1',
  });
  t.is(source.counts.released, 1);

  const responseShapes = shapeTable({
    [VERSION]: [
      {
        pattern: M.splitRecord({ source: 'thrown' }),
        result: { type: 'usage-exhausted' },
      },
    ],
  });
  const pinned = makeHarness(query, { responseShapes });
  t.deepEqual(await pinned.backend.infer(makeRequest()), {
    type: 'usage-exhausted',
  });
});

test('an error result is unavailable, never needs-auth, without a pinned row', async t => {
  const { query } = replay([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'authentication_error: invalid x-api-key',
    },
  ]);
  const { backend } = makeHarness(query);
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'turn ended with error_during_execution',
  });
});

test('a query that ends with no result is unavailable', async t => {
  const { query } = replay([assistant('message-1', 'partial')]);
  const { backend } = makeHarness(query);
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'no terminal result event',
  });
});

test('a message JSON cannot serialize still counts toward the byte limit', async t => {
  const big = 10n ** 200n;
  /** @type {Record<string, unknown>} */
  const looped = { ...assistant('message-1', 'x') };
  looped.self = looped;
  const { query: bigQuery } = replay([
    { ...assistant('message-1', 'x'), weird: big },
    success,
  ]);
  const { backend: bigBackend } = makeHarness(bigQuery);
  t.deepEqual(
    await bigBackend.infer(makeRequest({ limits: { maxOutputBytes: 150 } })),
    { type: 'limit-exceeded', which: 'output-bytes' },
    'a bigint counts as its digits',
  );
  const { query: loopQuery } = replay([looped, success]);
  const { backend: loopBackend } = makeHarness(loopQuery);
  t.like(await loopBackend.infer(makeRequest()), {
    type: 'ok',
    text: 'stored',
  });
});

test('a projection failure during setup is unavailable, not thrown', async t => {
  const { guest } = makeProjection();
  const { query, calls } = replay([success]);
  const { backend } = makeHarness(query);
  const result = await backend.infer(
    makeRequest({
      guest: harden({
        ...guest,
        buildMcpServer: Far('buildMcpServer', () => {
          throw Error('mcp server build failed');
        }),
      }),
    }),
  );
  t.deepEqual(result, {
    type: 'unavailable',
    detail: 'turn setup failed: mcp server build failed',
  });
  t.is(calls.length, 0);
});

test('a scratch cleanup failure does not replace the turn result', async t => {
  const memory = makeMemoryScratch();
  const scratch = {
    ...memory,
    makeScratchDirectory: async () => {
      const directory = await memory.makeScratchDirectory();
      return harden({
        ...directory,
        remove: async () => {
          throw Error('rm failed');
        },
      });
    },
  };
  const { query } = replay([success]);
  const { backend } = makeHarness(query, { scratch });
  const result = await backend.infer(makeRequest());
  t.like(result, { type: 'ok', text: 'stored' });
});
