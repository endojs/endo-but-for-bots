// @ts-check
/// <reference types="ses"/>

/** @import { Message, Model, Tool } from '@earendil-works/pi-ai' */
/** @import { AgentMessage, AgentTool, AgentToolResult, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { ToolRecord } from '@endo/agent-tools' */

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { makeTool } from '@endo/agent-tools/tool.js';

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

const EXECUTE_PARAMETERS = harden({
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description:
        'JavaScript source to evaluate in the code-mode compartment.',
    },
    resultName: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
      description:
        'Optional pet name or pet-name path where the completion value is stored.',
    },
  },
  required: ['source'],
  additionalProperties: false,
});

/**
 * @typedef {object} LalCodeModeGlobal
 * @property {string} name
 * @property {string | string[]} [petName]
 * @property {string} [type]
 * @property {string} [description]
 *
 * @typedef {object} LalCodeModeExecuteInput
 * @property {string} source
 * @property {string | string[]} [resultName]
 * @property {LalCodeModeGlobal[]} globals
 *
 * @typedef {(input: LalCodeModeExecuteInput) => Promise<unknown>} LalCodeModeExecute
 */

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
const isResultName = value =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(part => typeof part === 'string'));

/**
 * @param {unknown} result
 * @returns {string}
 */
const renderToolResult = result => {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result, (_key, value) =>
      typeof value === 'bigint' ? `+${value}` : value,
    );
  } catch {
    return String(result);
  }
};

/**
 * @param {LalCodeModeGlobal[]} globals
 * @returns {LalCodeModeGlobal[]}
 */
export const normalizeLalCodeModeGlobals = globals =>
  harden(
    globals.map(global => {
      const { name, petName = name, type = 'unknown', description } = global;
      if (!IDENTIFIER_RE.test(name)) {
        throw new Error(`code-mode global name must be a JS identifier: ${name}`);
      }
      if (!isResultName(petName)) {
        throw new Error(`code-mode global "${name}" has invalid petName`);
      }
      return harden({ name, petName, type, description });
    }),
  );
harden(normalizeLalCodeModeGlobals);

/**
 * @param {LalCodeModeGlobal[]} globals
 * @returns {string}
 */
const formatGlobalDeclarations = globals =>
  globals
    .map(global => {
      const description = global.description
        ? ` // ${global.description.replaceAll('\n', ' ')}`
        : '';
      return `declare const ${global.name}: ${global.type || 'unknown'};${description}`;
    })
    .join('\n');

/**
 * Build the system prompt for the narrow LAL code-mode agent.
 *
 * @param {LalCodeModeGlobal[]} globals
 * @param {{ preamble?: string }} [options]
 * @returns {string}
 */
export const makeLalCodeModeSystemPrompt = (globals, options = {}) => {
  const normalized = normalizeLalCodeModeGlobals(globals);
  const preamble =
    options.preamble ||
    'You are lalCodeMode, an Endo code-mode agent. You solve tasks by writing JavaScript and calling the execute tool.';
  return `${preamble}

You have exactly one tool: execute. Do not call any other tool and do not answer in prose when a tool call can do the work.

The execute tool evaluates JavaScript source in an Endo Compartment. The compartment includes hardened SES globals plus the powers listed below. These powers are already in lexical scope; do not look them up by pet name.

Use E(capability).method(...) for remotable capabilities. Top-level await is not available, so use an async IIFE when you need multiple awaits or a final awaited result:

\`\`\`js
(async () => {
  const value = await E(example).method();
  return value;
})()
\`\`\`

Return the desired value as the source completion value. Use resultName only when the user asks you to store the result for later.

Available powers:

\`\`\`ts
declare const E: <T>(target: T) => any;
${formatGlobalDeclarations(normalized)}
\`\`\`
`;
};
harden(makeLalCodeModeSystemPrompt);

/**
 * @param {LalCodeModeExecute} execute
 * @param {LalCodeModeGlobal[]} globals
 * @returns {ToolRecord}
 */
export const makeLalCodeModeExecuteTool = (execute, globals) => {
  const normalized = normalizeLalCodeModeGlobals(globals);
  return makeTool({
    name: 'execute',
    description:
      'Evaluate JavaScript source with the code-mode powers in lexical scope.',
    parameters: EXECUTE_PARAMETERS,
    execute: async args => {
      const { source, resultName } = args;
      if (typeof source !== 'string') {
        throw new Error('execute.source must be a string');
      }
      if (resultName !== undefined && !isResultName(resultName)) {
        throw new Error('execute.resultName must be a string or string[]');
      }
      return execute({
        source,
        resultName,
        globals: normalized,
      });
    },
  });
};
harden(makeLalCodeModeExecuteTool);

/**
 * @param {ToolRecord} tool
 * @returns {AgentTool<Tool['parameters']>}
 */
export const toPiAgentTool = tool => {
  return harden({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: /** @type {Tool['parameters']} */ (tool.parameters),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const result = await tool.invoke(
        /** @type {Record<string, unknown>} */ (params ?? {}),
      );
      /** @type {AgentToolResult<unknown>} */
      const toolResult = {
        content: [{ type: 'text', text: renderToolResult(result) }],
        details: result,
      };
      return toolResult;
    },
  });
};
harden(toPiAgentTool);

/**
 * Construct a PiAgent for the narrow code-mode path.
 *
 * @param {object} options
 * @param {Model<string>} options.model
 * @param {LalCodeModeGlobal[]} options.globals
 * @param {LalCodeModeExecute} options.execute
 * @param {string} [options.systemPrompt]
 * @param {AgentMessage[]} [options.messages]
 * @param {StreamFn} [options.streamFn]
 * @param {(messages: AgentMessage[]) => Message[] | Promise<Message[]>} [options.convertToLlm]
 * @param {(provider: string) => Promise<string | undefined> | string | undefined} [options.getApiKey]
 * @param {'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'} [options.thinkingLevel]
 * @returns {PiAgent}
 */
export const makeLalCodeModeAgent = options => {
  const {
    model,
    globals,
    execute,
    systemPrompt = makeLalCodeModeSystemPrompt(globals),
    messages = [],
    streamFn,
    convertToLlm = msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    getApiKey,
    thinkingLevel = model?.reasoning ? 'medium' : 'off',
  } = options;
  const executeTool = makeLalCodeModeExecuteTool(execute, globals);
  return new PiAgent({
    initialState: {
      systemPrompt,
      model,
      tools: [toPiAgentTool(executeTool)],
      messages,
      thinkingLevel,
    },
    convertToLlm,
    toolExecution: 'sequential',
    streamFn,
    getApiKey,
  });
};
harden(makeLalCodeModeAgent);
