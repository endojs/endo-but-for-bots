// @ts-check
/// <reference types="ses"/>

/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { Credentials, GetApiKey } from '../harness/credentials.js' */
/** @import { ThinkingLevel } from '../harness/model.js' */
/** @import { Evaluate, CodeModeGlobal } from '@endo/agent-tools/code-mode/evaluate-tool.js' */

import { makeCodeModeAgent } from '../code-mode.js';

/**
 * @typedef {object} GitScenarioAgentOptions
 * @property {Model<string>} model
 * @property {Evaluate} evaluate
 * @property {CodeModeGlobal[]} globals
 * @property {string} [systemPrompt]
 * @property {AgentMessage[]} [messages]
 * @property {StreamFn} [streamFn]
 * @property {GetApiKey} [getApiKey]
 * @property {ThinkingLevel} [thinkingLevel]
 */

/**
 * Build the eval-only repository agent.
 *
 * This fixture keeps the eval runner's repository-oriented preamble and
 * wiring beside the eval harness rather than making it a second public agent
 * preset.
 *
 * @param {GitScenarioAgentOptions} options
 * @returns {Agent}
 */
export const makeGitScenarioAgent = options => {
  const { agent } = makeCodeModeAgent({
    model: options.model,
    evaluate: options.evaluate,
    globals: options.globals,
    systemPrompt: options.systemPrompt,
    preamble: [
      'You are an Endo-hosted Pi coding agent.',
      'Use the evaluate tool to inspect and edit the repository through the workspace Filesystem and Git capabilities.',
    ].join(' '),
    messages: options.messages,
    streamFn: options.streamFn,
    getApiKey: options.getApiKey,
    thinkingLevel: options.thinkingLevel,
  });
  return agent;
};
harden(makeGitScenarioAgent);
