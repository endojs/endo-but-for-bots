// @ts-check
/// <reference types="ses"/>

/** @import { Tool } from '@earendil-works/pi-ai' */
/** @import { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core' */
/** @import { ToolRecord } from '../types.js' */

/** @type {TextEncoder} */
const encoder = new TextEncoder();

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
 * Return the longest whole-code-point prefix whose UTF-8 encoding fits.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, bytes: number }}
 */
const utf8Prefix = (text, maxBytes) => {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).length;
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return { text: text.slice(0, end), bytes };
};

/**
 * Apply a ToolRecord's policy to already-rendered model text.
 *
 * The marker is included in the byte budget. Its counters describe the exact
 * UTF-8 byte counts known at this adapter boundary; no source-level result
 * metadata is inferred or rewritten.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
const limitModelText = (text, maxBytes) => {
  const totalBytes = encoder.encode(text).length;
  if (totalBytes <= maxBytes) return text;

  const makeDetailedMarker = retainedBytes =>
    `\n[truncated: retained ${retainedBytes} bytes; omitted ${totalBytes - retainedBytes} bytes; total ${totalBytes} bytes]`;
  const fallbackMarker = '[truncated]';
  const smallestMarker = '[!]';
  const markerBytes = marker => encoder.encode(marker).length;
  const markerFor = retainedBytes => {
    const detailed = makeDetailedMarker(retainedBytes);
    if (markerBytes(detailed) <= maxBytes) return detailed;
    if (markerBytes(fallbackMarker) <= maxBytes) return fallbackMarker;
    if (markerBytes(smallestMarker) <= maxBytes) return smallestMarker;
    throw new RangeError(
      'resultPolicy.maxBytes is too small to include a truncation marker',
    );
  };

  // The detailed marker contains the retained count, so solve the small
  // budget equation to a fixed point. The fallback markers make the result
  // stable immediately for unusually small policy limits.
  let retainedBudget = maxBytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prefix = utf8Prefix(text, retainedBudget);
    const marker = markerFor(prefix.bytes);
    const nextBudget = maxBytes - markerBytes(marker);
    if (nextBudget === retainedBudget) {
      return `${prefix.text}${marker}`;
    }
    retainedBudget = nextBudget;
  }

  const prefix = utf8Prefix(text, retainedBudget);
  const marker = markerFor(prefix.bytes);
  const finalPrefix = utf8Prefix(text, maxBytes - markerBytes(marker));
  return `${finalPrefix.text}${markerFor(finalPrefix.bytes)}`;
};

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
      const rendered = renderToolResult(result);
      /** @type {AgentToolResult<unknown>} */
      const toolResult = {
        content: [
          {
            type: 'text',
            text: tool.resultPolicy
              ? limitModelText(rendered, tool.resultPolicy.maxBytes)
              : rendered,
          },
        ],
        details: result,
      };
      return toolResult;
    },
    ...(renderCall && { renderCall }),
    ...(renderResult && { renderResult }),
  });
};
harden(toPiAgentTool);
