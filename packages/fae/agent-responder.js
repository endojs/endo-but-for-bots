// @ts-check

import { makeAgentResponderCaplet } from '@endo/hosted-agent/agent-responder-module.js';
import { makeBrokeredMessagesProvider } from '@endo/lal/providers/brokered-messages.js';

import { guestSystemPrompt } from './agent.js';
import { discoverTools, executeTool } from './src/tools.js';
import {
  makeAdoptTool,
  makeAdoptToolTool,
  makeDismissTool,
  makeListMessagesTool,
  makeListPetnamesTool,
  makeLookupTool,
  makeMessageHistoryTool,
  makeRemoveTool,
  makeReplyTool,
  makeSendTool,
} from './src/tool-makers.js';
import { runAgenticTurn } from './src/turn-engine.js';

const MAXIMUM_TOOL_ROUNDS = 64;

/**
 * Parse a model's tool arguments, reporting a bad call back to the model.
 *
 * @param {any} call
 * @param {any} toolMap
 */
const runToolCall = async (call, toolMap) => {
  let content;
  await null;
  try {
    const { name, arguments: encoded } = call.function;
    content = await executeTool(name, JSON.parse(encoded), toolMap);
  } catch (error) {
    content = `Error: ${/** @type {Error} */ (error).message}`;
  }
  return harden({ role: 'tool', tool_call_id: call.id, content });
};

/**
 * One Fae conversation answering one prompt at a time, with the tools its
 * powers profile can serve. The transcript lasts this worker's lifetime, and a
 * failed turn is rolled out of it.
 *
 * @param {{ powers: any, inference: any, model: string, maxTokens?: number }} endowment
 */
export const makeFaeTurnRunner = async ({
  powers,
  inference,
  model,
  maxTokens,
}) => {
  await null;
  const provider = makeBrokeredMessagesProvider(
    harden({
      inference,
      model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }),
  );
  const localTools = new Map(
    Object.entries({
      list: makeListPetnamesTool(powers),
      lookup: makeLookupTool(powers),
      remove: makeRemoveTool(powers),
      adopt: makeAdoptTool(powers),
      adoptTool: makeAdoptToolTool(powers),
      send: makeSendTool(powers),
      reply: makeReplyTool(powers),
      listMessages: makeListMessagesTool(powers),
      messageHistory: makeMessageHistoryTool(powers),
      dismiss: makeDismissTool(powers),
    }),
  );
  /** @type {any[]} */
  let transcript = [{ role: 'system', content: guestSystemPrompt }];

  return harden({
    /**
     * @param {string} prompt
     * @param {AbortSignal} signal
     */
    runTurn: async (prompt, signal) => {
      /** @type {any[]} */
      const turn = [...transcript, { role: 'user', content: prompt }];
      const outcome = await runAgenticTurn({
        leafId: '',
        maxRounds: MAXIMUM_TOOL_ROUNDS,
        signal,
        getTools: () => discoverTools(powers, localTools),
        getContext: async leafId =>
          harden({ leafId, messages: harden([...turn]) }),
        invoke: async (messages, tools) => {
          const response = await provider.chatStream(
            [...messages],
            tools.schemas,
            undefined,
            signal,
          );
          return harden({ message: response.message });
        },
        getToolCalls: message => message.tool_calls ?? [],
        runTools: (calls, tools) =>
          Promise.all(calls.map(call => runToolCall(call, tools.toolMap))),
        commitStep: async (leafId, message, results) => {
          turn.push(message, ...results);
          return leafId;
        },
        commitFinal: async (leafId, message) => {
          turn.push(message);
          return leafId;
        },
      });
      transcript = turn;
      return harden({ text: /** @type {any} */ (outcome).message?.content });
    },
    dispose: () => provider.dispose(),
  });
};
harden(makeFaeTurnRunner);

export const make = makeAgentResponderCaplet(makeFaeTurnRunner);
