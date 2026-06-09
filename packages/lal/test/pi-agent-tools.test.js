// @ts-check
/**
 * Pin the new boundary between `PiAgent` (from `@earendil-works/pi-agent-core`)
 * and lal's tool surface (`toolDefs` + `makeExecuteTool` in `agent.js`).
 *
 * The harness migration moved provider/normalization logic into pi-agent-core
 * (#292) and message shaping into pi-ai (#293), so the pre-migration
 * normalization tests were removed (commit 4e6ed35). This test exercises what
 * remains lal-owned at the new seam: the SmallCaps decode, the
 * `@endo/patterns` validation, and the JSON-encoded-string retry path that
 * `validateAndFixupArgs` in `agent.js` provides.
 *
 * Per the directive on #290 (2026-05-19):
 *   "add a test that stubs convertToLlm and scripts two tool calls
 *    (one normal, one with a JSON-encoded-string arg to hit the
 *    validateAndFixupArgs retry)."
 *
 * Strategy: construct a `PiAgent` the same way `spawnWorkerLoop` does (same
 * `convertToLlm`, same tool surface built from `toolDefs` + `makeExecuteTool`
 * + `toAgentTool`), but supply a scripted `streamFn` so no provider is
 * called. The scripted stream emits one assistant turn carrying two tool
 * calls (one valid args record, one JSON-encoded-string args record) and a
 * second assistant turn that stops. We then assert on the mock powers that
 * both tool calls landed with the expected (validated, fixed-up) arguments.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';

import { toolDefs, makeExecuteTool, toAgentTool } from '../agent.js';
import { makeMockPowers } from '../tools/mock-powers.js';
import {
  stubModel,
  convertToLlm,
  makeScriptedStreamFn,
} from './scripted-pi-agent.js';

test('PiAgent + lal tools: normal arg dispatch + validateAndFixupArgs JSON-string retry', async t => {
  // Track which lal-tool dispatches receive what arguments by wrapping the
  // executeTool with a spy. The mock powers record observable side effects
  // (sent records, removed pet names) separately; the spy lets us assert on
  // the *validated* args record the tool dispatcher saw.
  const { powers, sent } = makeMockPowers({
    initialMessage: {
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      strings: ['placeholder; this test drives PiAgent directly'],
      names: [],
      ids: [],
    },
  });

  // Seed the directory with two pet names so `move(['source-name'],
  // ['destination-name'])` is a legitimate operation against the mock.
  await powers.makeDirectory(['source-name']);

  /** @type {Array<{name: string, rawArgs: any}>} */
  const dispatched = [];
  const rawExecuteTool = makeExecuteTool(powers);
  const executeTool = async (name, rawArgs) => {
    dispatched.push({ name, rawArgs });
    return rawExecuteTool(name, rawArgs);
  };

  const agentTools = toolDefs.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

  // Script two assistant turns:
  //   Turn 1: emit two tool calls in one assistant message:
  //     - `send` with NORMAL args (strings is already an array).
  //     - `move` with JSON-ENCODED-STRING args (fromPath/toPath are
  //       JSON-encoded arrays). The first @endo/patterns match against
  //       NamePathShape (M.arrayOf(M.string())) fails for a string; the
  //       retry parses the strings and re-matches successfully.
  //   Turn 2: stop with no further tool calls so the agent loop ends.
  const streamFn = makeScriptedStreamFn([
    {
      content: [
        {
          type: 'toolCall',
          id: 'call-1-send',
          name: 'send',
          arguments: {
            recipientName: '@host',
            strings: ['hello from the test'],
            edgeNames: [],
            petNames: [],
          },
        },
        {
          type: 'toolCall',
          id: 'call-2-move',
          name: 'move',
          // Both path fields delivered as JSON-encoded strings. Some smaller
          // models do this in practice; without the retry the first
          // mustMatch against M.arrayOf(M.string()) throws.
          arguments: {
            fromPath: '["source-name"]',
            toPath: '["destination-name"]',
          },
        },
      ],
      stopReason: 'toolUse',
    },
    // Second LLM turn after tool results: stop.
    {
      content: [{ type: 'text', text: 'OK' }],
      stopReason: 'stop',
    },
  ]);

  const piAgent = new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    // The reviewer asked specifically for a `convertToLlm` stub; supply the
    // same identity-filter the production `spawnWorkerLoop` installs so the
    // test exercises the same path.
    convertToLlm,
    toolExecution: 'sequential',
    streamFn,
  });

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  // The send tool's normal-arg path should have fired and reached the mock
  // powers. mock-powers records `send`s in `sent`. This proves the
  // normal-args validation path (first @endo/patterns match succeeds; no
  // retry needed) drives the dispatcher through to the powers boundary.
  const sentToHost = sent.filter(s => s.recipient === '@host');
  t.is(sentToHost.length, 1, 'send tool dispatched once');
  t.deepEqual(
    sentToHost[0].strings,
    ['hello from the test'],
    'normal-arg send delivered exact strings array',
  );

  // Both tools were invoked at the executeTool seam, in source order, with
  // the *raw* (pre-fixup) arguments pi-agent-core forwarded from the
  // scripted assistant message.
  t.is(dispatched.length, 2, 'both tool calls dispatched');
  t.is(dispatched[0].name, 'send', 'first dispatch is send');
  t.is(dispatched[1].name, 'move', 'second dispatch is move');
  t.is(
    typeof dispatched[1].rawArgs.fromPath,
    'string',
    'move received the raw JSON-encoded-string args from the scripted stream',
  );

  // The retry-path proof is in the side effect on mock-powers. The mock's
  // `move(fromPath, toPath)` calls `fromPath.join('/')`, which throws on a
  // string. If validateAndFixupArgs had *not* fixed up the JSON-encoded
  // strings into arrays, the inner dispatcher would have surfaced that
  // error and the destination pet name would never have been written.
  // Confirming both pet names below proves the retry parsed each
  // JSON-encoded array and re-matched before the switch dispatched into
  // E(powers).move(...).
  t.true(
    await powers.has('destination-name'),
    'move tool installed destination pet name in directory (proves retry succeeded)',
  );
  t.false(
    await powers.has('source-name'),
    'move tool removed source pet name from directory (proves retry succeeded)',
  );
});
