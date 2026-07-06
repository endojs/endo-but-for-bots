// @ts-check

import { discoverCapabilityTools } from '@endo/agent-tools/discover.js';

/**
 * @typedef {import('./tool-makers.js').FaeTool} FaeTool
 * @typedef {import('@endo/agent-tools/types-index.js').ToolRecord} ToolRecord
 * @typedef {import('@endo/agent-tools/types-index.js').CapabilityToolOptions} CapabilityToolOptions
 */

/**
 * Adapt a canonical `@endo/agent-tools` `ToolRecord` into the `FaeTool` shape
 * Fae's tool loop consumes (`schema()` / `execute(args)` / `help()`). The
 * record's JSON Schema becomes the OpenAI function schema verbatim, and a
 * non-string tool result is rendered as JSON so the model always receives text.
 *
 * @param {ToolRecord} record
 * @returns {FaeTool}
 */
export const toFaeTool = record =>
  harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: record.name,
          description: record.description,
          parameters: record.parameters,
        },
      }),
    execute: async (/** @type {Record<string, unknown>} */ args) => {
      const result = await record.invoke(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    help: () => record.description,
  });
harden(toFaeTool);

/**
 * Discover the coding tools this agent's *granted capabilities* afford (a
 * `Dir` under `fs`, a `Shell` under `shell`, a `Git` under `git`) and add them
 * to the local tool map under their canonical names. A capability that was not
 * granted contributes nothing, so the same agent runs with or without coding
 * tools (daemon-agent-tools Phase 4).
 *
 * @param {import('@endo/eventual-send').ERef<any>} powers - The agent's guest
 *   namespace, supporting `lookup([petName])`.
 * @param {Map<string, FaeTool | object>} localTools - Mutated in place.
 * @param {CapabilityToolOptions} [options]
 * @returns {Promise<string[]>} The names of the tools registered.
 */
export const registerCapabilityTools = async (powers, localTools, options) => {
  const records = await discoverCapabilityTools(powers, options);
  /** @type {string[]} */
  const registered = [];
  for (const record of records) {
    localTools.set(record.name, toFaeTool(record));
    registered.push(record.name);
  }
  return registered;
};
harden(registerCapabilityTools);
