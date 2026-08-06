// @ts-check
/// <reference types="ses"/>

/** @import { Tool } from '@earendil-works/pi-ai' */
/** @import { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core' */
/** @import { ToolRecord } from '../types.js' */

/**
 * `renderCall`/`renderResult` are typed opaquely here: this package does not
 * depend on Pi's TUI, so it neither knows nor constrains their real
 * signatures. The engine-specific caller (e.g. `@endo/agentry`) supplies
 * functions matching Pi's own `ToolDefinition['renderCall'/'renderResult']`
 * shape; that assignment is checked at the call site, not here.
 *
 * @typedef {AgentTool<Tool['parameters']> & {
 *   renderCall?: (...args: any[]) => any,
 *   renderResult?: (...args: any[]) => any,
 * }} PiToolDefinition
 */

/**
 * Default tool-result renderer: plain strings pass through unchanged; every
 * other value is `JSON.stringify`-ed. Marshalling-aware callers (e.g.
 * `@endo/agentry`, which speaks SmallCaps) inject their own renderer through
 * the `renderToolResult` option so this package carries no marshalling
 * dependency.
 *
 * @param {unknown} result
 * @returns {string}
 */
const defaultRenderToolResult = result =>
  typeof result === 'string' ? result : JSON.stringify(result);

/**
 * Bridge a provider-independent {@link ToolRecord} into a pi-agent-core
 * {@link AgentTool}. The model-facing surface (`name`, `description`,
 * `parameters`) is copied verbatim; the bridge `invoke`s the record and renders
 * its completion value to the text the model reads, retaining the raw value as
 * the tool result's structured `details`.
 *
 * The text rendering is injected, not built in: pass `renderToolResult` to
 * encode results in whatever wire format the caller's transcript expects (the
 * default is plain-string-passthrough plus `JSON.stringify`). This keeps
 * `@endo/agent-tools` free of any marshalling dependency while letting a
 * SmallCaps-speaking caller round-trip BigInts and sigil-prefixed strings.
 *
 * The optional `renderCall`/`renderResult` functions are opaque to this
 * package: they exist for engines (e.g. Pi) whose `ToolDefinition` accepts
 * TUI renderers alongside the `AgentTool` shape. This module carries no
 * dependency on any such TUI, so it passes them through unmodified onto the
 * returned object rather than typing or interpreting them.
 *
 * @param {ToolRecord} tool
 * @param {{
 *   renderToolResult?: (result: unknown) => string,
 *   renderCall?: (...args: any[]) => any,
 *   renderResult?: (...args: any[]) => any,
 * }} [options]
 * @returns {PiToolDefinition}
 */
export const toPiAgentTool = (tool, options = {}) => {
  const {
    renderToolResult = defaultRenderToolResult,
    renderCall,
    renderResult,
  } = options;
  return harden({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: /** @type {Tool['parameters']} */ (tool.parameters),
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      const result = await tool.invoke(
        /** @type {Record<string, unknown>} */ (params ?? {}),
        { signal },
      );
      /** @type {AgentToolResult<unknown>} */
      const toolResult = {
        content: [{ type: 'text', text: renderToolResult(result) }],
        details: result,
      };
      return toolResult;
    },
    ...(renderCall && { renderCall }),
    ...(renderResult && { renderResult }),
  });
};
harden(toPiAgentTool);
