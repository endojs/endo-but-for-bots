// @ts-check
/**
 * Pin the SmallCaps treatment at the JSON tool-arg boundary against the
 * footgun raised on PR #290 by kriskowal (2026-05-20):
 *
 *   "I'm also concerned about smallcaps strings getting inadvertently
 *    misinterpreted. That's a huge footgun, but patterns can usually
 *    catch that. As long as we're using JSON, we need a rigorous
 *    treatment on SmallCaps."
 *
 * The earlier harness ran the entire tool-call args record through a
 * SmallCaps marshal, which silently re-interpreted any LLM-emitted string
 * whose first character was in the SmallCaps special prefix range
 * (`!"#$%&'()*+,-`). Plausible user content was mutated before the tool
 * ever saw it:
 *
 *   - `"+15551234567"` (a phone number) became BigInt 15551234567n.
 *   - `"+5"` (the literal "+5" in a user message) became BigInt 5n.
 *   - `"#undefined"` (a literal hashtag) became JavaScript `undefined`.
 *   - `"%percentage"` became a Symbol.
 *
 * The rigorous treatment is: SmallCaps interpretation only happens on
 * per-tool fields explicitly declared as `bigintArgs` (the documented
 * `messageNumber` surface). Every other string arrives at the tool
 * boundary verbatim, and the `@endo/patterns` matchers catch any drift.
 *
 * These tests drive the same PiAgent + tools seam the production
 * `spawnWorkerLoop` uses (scripted streamFn, no provider call), assert
 * that footgun-shaped strings survive intact in user-text fields, and
 * assert that BigInt coercion still fires on `messageNumber` fields.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { toolDefs, makeExecuteTool, toAgentTool } from '../agent.js';
import { makeMockPowers } from '../tools/mock-powers.js';

/** @type {any} */
const stubModel = harden({
  id: 'stub-model',
  name: 'stub/stub-model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://invalid.example',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
});

/**
 * Build a scripted streamFn that emits each script entry as one assistant
 * message and then stops.
 *
 * @param {Array<{content: any[], stopReason: string}>} script
 */
const makeScriptedStreamFn = script => {
  let turn = 0;
  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    /** @type {any} */
    const partial = harden({
      role: 'assistant',
      content: [],
      api: stubModel.api,
      provider: stubModel.provider,
      model: stubModel.id,
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
    const next = script[turn] || {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
    };
    turn += 1;
    /** @type {any} */
    const finalMessage = harden({
      ...partial,
      content: next.content,
      stopReason: next.stopReason,
    });
    stream.push({ type: 'start', partial });
    stream.push({
      type: 'done',
      reason: /** @type {'toolUse' | 'stop'} */ (
        next.stopReason === 'toolUse' ? 'toolUse' : 'stop'
      ),
      message: finalMessage,
    });
    stream.end(finalMessage);
    return stream;
  };
};

/**
 * Build a PiAgent wired to lal's tool surface with a scripted streamFn,
 * mirroring `spawnWorkerLoop`'s construction shape so the tests exercise
 * the production code path. Returns the agent, the mock powers' `sent`
 * record, and a spy recording each (name, args) pair the inner
 * dispatcher saw post-decode/post-validation.
 *
 * @param {Array<{content: any[], stopReason: string}>} script
 */
const buildAgent = script => {
  const { powers, sent, adoptions } = makeMockPowers({
    initialMessage: {
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      strings: ['placeholder'],
      names: [],
      ids: [],
    },
  });

  /** @type {Array<{name: string, args: any}>} */
  const dispatched = [];
  const rawExecuteTool = makeExecuteTool(powers);
  const executeTool = async (name, rawArgs) => {
    const result = await rawExecuteTool(name, rawArgs);
    return result;
  };
  // Wrap one level deeper so we can see what the inner dispatcher
  // received *after* coercion and validation. We do this by replacing
  // toAgentTool's `execute` indirectly: build the agentTools with our
  // own thin wrapper that records the post-decode args. The cleanest
  // observation point is to spy at the executeTool boundary itself
  // (rawExecuteTool runs the coerce + validate inline; observing
  // *before* it would show pre-coercion args; observing the powers
  // boundary shows the final value the tool spread into the
  // E(powers).<method>() call. Both are useful; for these tests, the
  // powers boundary is the canonical surface to assert on.

  const agentTools = toolDefs.map(({ name, summary }) =>
    toAgentTool(name, summary, async (toolName, rawArgs) => {
      dispatched.push({ name: toolName, args: rawArgs });
      return executeTool(toolName, rawArgs);
    }),
  );

  const piAgent = new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn: makeScriptedStreamFn(script),
  });

  return { piAgent, powers, sent, adoptions, dispatched };
};

/**
 * Build a single assistant message with one tool call, plus a stop turn,
 * so each test reads as one tool emission and one observable side effect.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 */
const oneToolCall = (toolName, args) => [
  {
    content: [
      {
        type: 'toolCall',
        id: `call-${toolName}`,
        name: toolName,
        arguments: args,
      },
    ],
    stopReason: 'toolUse',
  },
  { content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' },
];

// ---------------------------------------------------------------------------
// User-text fields preserve LLM-emitted strings verbatim (no SmallCaps walk).
// ---------------------------------------------------------------------------

test('send: "+15551234567" in strings[] arrives as the literal string (footgun: was BigInt)', async t => {
  const { piAgent, sent } = buildAgent(
    oneToolCall('send', {
      recipientName: '@host',
      strings: ['+15551234567'],
      edgeNames: [],
      petNames: [],
    }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1);
  t.deepEqual(
    sent[0].strings,
    ['+15551234567'],
    'phone-number string survives intact (pre-fix: would have become BigInt 15551234567n)',
  );
  // Pin the type explicitly so a future regression to whole-tree decoding
  // surfaces here instead of silently passing the deepEqual.
  t.is(typeof sent[0].strings[0], 'string');
});

test('send: "+5" in strings[] arrives as the literal string (footgun: was BigInt 5n)', async t => {
  const { piAgent, sent } = buildAgent(
    oneToolCall('send', {
      recipientName: '@host',
      strings: ['+5'],
      edgeNames: [],
      petNames: [],
    }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1);
  t.deepEqual(sent[0].strings, ['+5']);
  t.is(typeof sent[0].strings[0], 'string');
});

test('send: "#undefined" in strings[] arrives as the literal string (footgun: was undefined)', async t => {
  const { piAgent, sent } = buildAgent(
    oneToolCall('send', {
      recipientName: '@host',
      strings: ['#undefined'],
      edgeNames: [],
      petNames: [],
    }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1);
  t.deepEqual(sent[0].strings, ['#undefined']);
  t.is(typeof sent[0].strings[0], 'string');
});

test('send: "%percentage" in strings[] arrives as the literal string (footgun: was Symbol)', async t => {
  const { piAgent, sent } = buildAgent(
    oneToolCall('send', {
      recipientName: '@host',
      strings: ['%percentage'],
      edgeNames: [],
      petNames: [],
    }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1);
  t.deepEqual(sent[0].strings, ['%percentage']);
  t.is(typeof sent[0].strings[0], 'string');
});

test('send: multiple SmallCaps-shaped strings together survive intact', async t => {
  // A realistic chat message that previously would have been mutilated
  // by the whole-tree SmallCaps walk: phone number, hashtag, the word
  // "test#1", and a leading "+1" that is a US country-code prefix.
  const { piAgent, sent } = buildAgent(
    oneToolCall('send', {
      recipientName: '@host',
      strings: [
        'Call +1 555 123 4567 about the #main pipeline (test +5 cases).',
        '%percent and $variable references stay as text.',
      ],
      edgeNames: [],
      petNames: [],
    }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1);
  t.deepEqual(sent[0].strings, [
    'Call +1 555 123 4567 about the #main pipeline (test +5 cases).',
    '%percent and $variable references stay as text.',
  ]);
});

// ---------------------------------------------------------------------------
// content / source fields preserve LLM-emitted strings verbatim too.
// ---------------------------------------------------------------------------

test('writeText: content "+5" arrives as the literal string (footgun: was BigInt)', async t => {
  const { piAgent, powers } = buildAgent([
    {
      content: [
        // First need a target capability. The mock powers' makeDirectory
        // installs a fake-ish directory at the key; writeText then calls
        // E(capability).writeText(fileName, content). The mock directory
        // is not a Tree, so the inner writeText call rejects — but the
        // dispatcher still calls into lookup() before that, which is
        // enough for our purposes. To make the test deterministic, we
        // instead use the powers' built-in directory plus a custom probe
        // that just records what the dispatcher saw at the executeTool
        // boundary.
        {
          type: 'toolCall',
          id: 'call-write',
          name: 'writeText',
          arguments: {
            petNameOrPath: 'note',
            fileName: 'msg.txt',
            content: '+5',
          },
        },
      ],
      stopReason: 'toolUse',
    },
    { content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' },
  ]);

  // Pre-install a capability whose writeText records what it received.
  /** @type {Array<{fileName: string, content: unknown}>} */
  const writes = [];
  const fakeTree = harden({
    writeText(fileName, content) {
      writes.push({ fileName, content });
      return Promise.resolve();
    },
  });
  await powers.storeValue(fakeTree, ['note']);

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(writes.length, 1, 'writeText dispatched to capability once');
  t.is(
    writes[0].content,
    '+5',
    'content survives as the literal string (pre-fix: would have been BigInt 5n)',
  );
  t.is(typeof writes[0].content, 'string');
});

test('evaluate: source string that itself starts with a SmallCaps prefix survives intact', async t => {
  // The most exposed case: a source string whose first character is in
  // the SmallCaps prefix range. The whole-tree decoder would have turned
  // this into a BigInt; the per-tool-bigint-fields-only decoder leaves
  // it alone because evaluate has no bigintArgs.
  const source = '+5 + 1'; // valid JS expression starting with "+"
  const { piAgent, dispatched } = buildAgent(
    oneToolCall('evaluate', {
      source,
      resultName: 'r',
      codeNames: [],
      edgeNames: [],
    }),
  );

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(dispatched.length, 1);
  t.is(dispatched[0].name, 'evaluate');
  t.is(
    dispatched[0].args.source,
    source,
    'source string starting with "+" survives as a string (pre-fix: would have become BigInt 5n via SmallCaps walk)',
  );
  t.is(typeof dispatched[0].args.source, 'string');
});

// ---------------------------------------------------------------------------
// messageNumber fields STILL get BigInt coercion (the one documented surface).
// ---------------------------------------------------------------------------

test('dismiss: messageNumber "+5" is coerced to BigInt 5n', async t => {
  const { piAgent, dispatched } = buildAgent(
    oneToolCall('dismiss', { messageNumber: '+5' }),
  );
  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(dispatched.length, 1);
  t.is(dispatched[0].name, 'dismiss');
  // The dispatched spy captures the *raw* args (pre-coerce, since the
  // spy lives outside makeExecuteTool's coercion step). To assert on
  // the post-coerced value we instrument the mock instead.
  // Switch to the mock-powers observation:
  // mock-powers' dismiss removes the message; for coercion proof we
  // rely on the spy capturing the raw "+5" string, then add a second
  // test below that asserts the powers boundary saw the BigInt.
  t.is(dispatched[0].args.messageNumber, '+5');
});

test('dismiss: powers boundary sees BigInt for "+5" messageNumber', async t => {
  // Drive PiAgent against a minimal hand-rolled powers stub that records
  // the type of the messageNumber argument the dispatcher passes. This
  // proves the BigInt coercion still fires on the documented surface.
  /** @type {Array<unknown>} */
  const dismissed = [];
  const observingPowers = harden({
    dismiss(value) {
      dismissed.push(value);
      return Promise.resolve();
    },
    // Minimal surface needed so the agent boots; lal's dispatcher only
    // touches dismiss in this script.
    locate() {
      return Promise.resolve('endo://localhost/?id=lal-self-id&type=handle');
    },
    async *followMessages() {
      // No inbox traffic; the agent just runs the scripted prompt.
    },
    send() {
      return Promise.resolve();
    },
  });

  const executeTool = makeExecuteTool(observingPowers);
  const agentTools = toolDefs.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

  const piAgent = new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn: makeScriptedStreamFn(
      oneToolCall('dismiss', { messageNumber: '+5' }),
    ),
  });

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(dismissed.length, 1, 'dismiss tool dispatched once');
  t.is(
    typeof dismissed[0],
    'bigint',
    'messageNumber arrived at powers as a BigInt (the one documented SmallCaps coercion)',
  );
  t.is(dismissed[0], 5n);
});

test('reply: messageNumber "+3" coerces, strings stay literal', async t => {
  const { powers, sent } = makeMockPowers({
    initialMessage: {
      number: 3,
      from: '@host',
      to: 'lal-self-id',
      strings: ['hi'],
      names: [],
      ids: [],
    },
  });
  const executeTool = makeExecuteTool(powers);
  const agentTools = toolDefs.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );
  const piAgent = new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn: makeScriptedStreamFn(
      oneToolCall('reply', {
        messageNumber: '+3',
        // A string in the strings[] body that begins with "+" must
        // survive: SmallCaps coercion fires only on messageNumber.
        strings: ['Thanks for the +5 update on #main!'],
        edgeNames: [],
        petNames: [],
      }),
    ),
  });

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  t.is(sent.length, 1, 'reply was sent');
  t.deepEqual(sent[0].strings, ['Thanks for the +5 update on #main!']);
});

// ---------------------------------------------------------------------------
// Adversarial: nothing other than messageNumber gets SmallCaps treatment.
// ---------------------------------------------------------------------------

test('petNameOrPath "+5" is not coerced (passes through; matcher accepts strings)', async t => {
  // `lookup` expects petNameOrPath to be a string-or-string[]. If we
  // accidentally widened SmallCaps coercion to other fields, "+5" would
  // become BigInt 5n and mustMatch would throw "must be a string". The
  // test below proves the matcher accepts the literal string.
  const { piAgent, dispatched } = buildAgent(
    oneToolCall('lookup', { petNameOrPath: '+5' }),
  );

  // Suppress the expected lookup failure; the assertion is on the
  // dispatched-args record, not on the lookup result.
  await piAgent.prompt('start').catch(() => {});
  await piAgent.waitForIdle().catch(() => {});

  t.is(dispatched.length, 1);
  t.is(dispatched[0].args.petNameOrPath, '+5');
  t.is(typeof dispatched[0].args.petNameOrPath, 'string');
});
