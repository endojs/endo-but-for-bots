// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeRuntime } from './code-mode-runtime.js' */

import { makeCodeModeRuntime } from './code-mode-runtime.js';

/**
 * @param {unknown} pi
 * @returns {asserts pi is {
 *   registerTool: (tool: object) => unknown,
 *   registerCommand?: (name: string, command: object) => unknown,
 *   on?: (eventName: string, handler: (event: unknown, ctx?: unknown) => unknown) => unknown,
 * }}
 */
const assertPiExtensionApi = pi => {
  if (
    pi === null ||
    typeof pi !== 'object' ||
    typeof /** @type {{ registerTool?: unknown }} */ (pi).registerTool !==
      'function'
  ) {
    throw new Error('Endo code-mode extension requires pi.registerTool');
  }
};

/**
 * @param {CodeModeRuntime} runtime
 */
const makeExecuteRegistration = runtime =>
  harden({
    name: 'execute',
    description: runtime.tool.description,
    parameters: runtime.tool.parameters,
    execute: async (args, _ctx) =>
      runtime.tool.invoke(/** @type {Record<string, unknown>} */ (args || {})),
  });

/**
 * Register the Endo-backed code-mode surface with a Pi ExtensionAPI object.
 * The adapter registers only the Endo `execute` tool; Pi remains the event
 * driver and receives no ambient filesystem, shell, or Git tool authority.
 *
 * @param {unknown} pi
 * @param {Parameters<typeof makeCodeModeRuntime>[0] & { runtime?: CodeModeRuntime }} options
 * @returns {CodeModeRuntime}
 */
export const registerEndoCodeModeExtension = (pi, options) => {
  assertPiExtensionApi(pi);
  const runtime = options.runtime || makeCodeModeRuntime(options);
  pi.registerTool(makeExecuteRegistration(runtime));

  pi.registerCommand?.('endo:status', {
    run: async () => runtime.describe(),
  });
  pi.registerCommand?.('endo:globals', {
    run: async () =>
      harden(runtime.globals.map(global => harden({ ...global }))),
  });
  pi.on?.('tool_call', event => {
    /**
     * @type {CodeModeRuntime & {
     *   auditToolCall?: (event: unknown) => unknown,
     * }}
     */
    const maybeRuntime = runtime;
    return maybeRuntime.auditToolCall?.(event);
  });
  return runtime;
};
harden(registerEndoCodeModeExtension);

/**
 * @param {Parameters<typeof makeCodeModeRuntime>[0] & { runtime?: CodeModeRuntime }} options
 * @returns {(pi: unknown) => CodeModeRuntime}
 */
export const makeEndoCodeModeExtension = options => pi =>
  registerEndoCodeModeExtension(pi, options);
harden(makeEndoCodeModeExtension);

/**
 * Default export shape for Pi extension loaders that call the module export
 * with the ExtensionAPI object.
 *
 * @param {unknown} pi
 * @param {Parameters<typeof makeCodeModeRuntime>[0] & { runtime?: CodeModeRuntime }} [options]
 * @returns {CodeModeRuntime}
 */
export default function endoCodeModeExtension(pi, options = {}) {
  return registerEndoCodeModeExtension(pi, options);
}
