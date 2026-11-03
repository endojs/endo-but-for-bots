// @ts-check
/// <reference types="ses"/>

/** @import { Message, Model } from '@earendil-works/pi-ai' */
/** @import { Agent, AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { GetApiKey, ThinkingLevel } from './types.js' */

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';

/**
 * Construct a pi-agent-core `Agent` from harness-level inputs. This is the one
 * place the harness builds a `PiAgent`: it owns the `initialState` shape, the
 * default thinking level (`reasoning ? 'medium' : 'off'`), the default
 * `streamFn` (`streamFn ?? streamSimple`), and `toolExecution: 'sequential'`. A
 * `getApiKey` is included in the constructor options only when one is supplied,
 * matching the conditional-spread the callers relied on (pi-agent-core may
 * distinguish an absent hook from an explicit `undefined`).
 *
 * @param {object} options
 * @param {Model<string>} options.model
 * @param {AgentTool<any>[]} options.tools
 * @param {string} options.systemPrompt
 * @param {AgentMessage[]} [options.messages]
 * @param {StreamFn} [options.streamFn] - Stream function for the pi-agent-core
 *   `Agent`. Defaults to `streamSimple` from `@earendil-works/pi-ai/compat`
 *   when omitted; two callers (`@endo/lal`'s worker loop and
 *   `define-agent.js`) rely on this default rather than passing one.
 * @param {(messages: AgentMessage[]) => Message[] | Promise<Message[]>} [options.convertToLlm] -
 *   Defaults to pi-agent-core's own filter. A replacement must keep `system`
 *   messages: they are the only carrier of the system prompt and the tool
 *   declarations in the request.
 * @param {GetApiKey} [options.getApiKey]
 * @param {ThinkingLevel} [options.thinkingLevel]
 * @param {'sequential' | 'parallel'} [options.toolExecution]
 * @returns {Agent}
 */
export const makePiAgent = ({
  model,
  tools,
  systemPrompt,
  messages = [],
  streamFn,
  convertToLlm,
  getApiKey,
  thinkingLevel = model?.reasoning ? 'medium' : 'off',
  toolExecution = 'sequential',
}) =>
  new PiAgent({
    initialState: {
      systemPrompt,
      model,
      tools,
      messages,
      thinkingLevel,
    },
    convertToLlm,
    toolExecution,
    // Pi 0.81 evaluates `runtimeOptions.streamFn ?? getDefaultStreamFn()` in
    // the Agent constructor, and `getDefaultStreamFn()` throws unless someone
    // called the upstream `setDefaultStreamFn` hook (ambient mutable module
    // state this harness deliberately declines). Keep the harness's
    // established compat-registry behavior when callers omit one.
    streamFn: streamFn ?? streamSimple,
    // Include getApiKey only when supplied, so a non-Ollama caller leaves the
    // hook absent rather than explicitly `undefined`.
    ...(getApiKey ? { getApiKey } : {}),
  });
harden(makePiAgent);
