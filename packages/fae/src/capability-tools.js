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
      if (typeof result === 'string') {
        return result;
      }
      // A void/undefined result (e.g. a git `createBranch` that resolves to
      // nothing) must still reach the model as text: `JSON.stringify(undefined)`
      // is `undefined`, not a string, so coerce it to an explicit token.
      const rendered = JSON.stringify(result);
      return rendered === undefined ? 'ok' : rendered;
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
 * A discovered tool whose name is already served by a statically-registered
 * built-in is skipped: the static tool wins, so discovery only ever *adds*
 * (a `shell` capability's `exec` record must not clobber Fae's built-in
 * JavaScript `exec`). This matches Lal's `spawnWorkerLoop` collision
 * precedence (daemon-agent-tools Phase 4).
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
    // A static built-in of the same name wins; discovery only adds.
    if (!localTools.has(record.name)) {
      localTools.set(record.name, toFaeTool(record));
      registered.push(record.name);
    }
  }
  return registered;
};
harden(registerCapabilityTools);
