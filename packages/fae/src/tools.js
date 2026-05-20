// @ts-check

/* eslint-disable no-await-in-loop */

import { E } from '@endo/eventual-send';

/**
 * @typedef {import('./tool-makers.js').ToolSchema} ToolSchema
 * @typedef {import('./tool-makers.js').FaeTool} FaeTool
 */

/**
 * @typedef {object} DiscoveredTools
 * @property {ToolSchema[]} schemas - OpenAI function-calling schemas for the LLM
 * @property {Map<string, FaeTool | object>} toolMap - name → tool object
 */

// OpenAI function-calling names are restricted to this character class
// (letters, digits, underscore, hyphen) with length 1..64. Petnames that
// satisfy this are translated to the model-facing dispatch name; petnames
// that don't fall back to the schema's intrinsic name with a warning.
const OPENAI_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Translate the kebab-case petnames humans use in chat into the
 * camelCase function names models see in tool schemas.
 *
 * Existing mixed-case and underscore names pass through unchanged.
 *
 * @param {string} name
 */
const kebabToCamel = name =>
  name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Discover all available tools by merging local built-in tools with any
 * daemon-side tools stored in the `tools/` petname directory.
 *
 * Called at the start of each agent turn so that tools adopted between
 * turns (e.g., received via mail) are immediately available.
 *
 * ## Dispatch contract
 *
 * Local tools (passed in via `localTools`) keep their intrinsic schema
 * function names as their dispatch keys — these are fixed agent
 * built-ins (`reply`, `exec`, `adoptTool`, etc.) and are not renamed.
 *
 * Daemon-side tools stored under `tools/<petName>` are dispatched by a
 * camelCase function name derived from the petname. The discovered
 * schema's `function.name` is rewritten to that function name so that:
 *
 *   - humans can keep using kebab-case petnames in chats and lookup paths;
 *   - the LLM sees JavaScript-style callable names such as `readFile`;
 *   - the same underlying tool adopted under multiple petnames produces
 *     multiple callable entries when those translated names remain distinct.
 *
 * If a petname is not a legal OpenAI function name (regex
 * `^[a-zA-Z0-9_-]{1,64}$`), the schema's intrinsic `function.name` is
 * used instead and a warning is emitted. If two petnames translate to
 * the same dispatch name, only the first registration wins (with a
 * warning), since the LLM cannot disambiguate them.
 *
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @param {Map<string, FaeTool>} localTools
 * @returns {Promise<DiscoveredTools>}
 */
export const discoverTools = async (host, localTools) => {
  /** @type {ToolSchema[]} */
  const schemas = [];
  for (const tool of localTools.values()) {
    schemas.push(tool.schema());
  }

  /** @type {Map<string, FaeTool | object>} */
  const toolMap = new Map(localTools);

  /** @type {unknown} */
  let maybeToolNames;
  try {
    maybeToolNames = await E(host).list('tools');
  } catch {
    // No tools/ directory in this agent's namespace — that's fine
    maybeToolNames = [];
  }
  const names = (Array.isArray(maybeToolNames) ? maybeToolNames : []).filter(
    /**
     * @param x
     * @returns {x is string}
     */ x => typeof x === 'string',
  );
  await Promise.allSettled(
    names.map(async petName => {
      try {
        const tool = await E(host).lookup(['tools', petName]);
        const toolSchema = /** @type {ToolSchema} */ (await E(tool).schema());
        const intrinsicName = toolSchema.function?.name;
        if (!intrinsicName) {
          throw new Error('schema.function.name is required');
        }

        let dispatchName;
        if (OPENAI_FUNCTION_NAME_RE.test(petName)) {
          // Petnames stay kebab-case in storage and chat, while the
          // model-facing callable name follows JavaScript camelCase.
          dispatchName = kebabToCamel(petName);
        } else {
          console.warn(
            `[fae] tools/${petName}: petname is not a legal OpenAI function name; falling back to intrinsic schema name "${intrinsicName}"`,
          );
          dispatchName = intrinsicName;
        }

        if (toolMap.has(dispatchName)) {
          console.warn(
            `[fae] tools/${petName}: skipping duplicate dispatch name "${dispatchName}"`,
          );
          return;
        }

        // Rewrite the schema so the function name the LLM sees matches
        // the dispatch key. Petnames are the public name; the schema's
        // intrinsic name is only used as a fallback.
        /** @type {ToolSchema} */
        const rewrittenSchema = harden({
          ...toolSchema,
          function: { ...toolSchema.function, name: dispatchName },
        });

        toolMap.set(dispatchName, /** @type {object} */ (tool));
        schemas.push(rewrittenSchema);
      } catch (/** @type {any} */ err) {
        console.warn(
          `[fae] tools/${petName}: not a valid FaeTool: ${err.message || err}`,
        );
      }
    }),
  );

  return harden({ schemas, toolMap });
};
harden(discoverTools);

/**
 * Execute a tool by name using the discovered tool map.
 *
 * Uses E() so that both local tools and daemon far-reference tools
 * are called uniformly via eventual send.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Map<string, FaeTool | object>} toolMap
 * @returns {Promise<string>}
 */
export const executeTool = async (name, args, toolMap) => {
  const tool = toolMap.get(name);
  if (!tool) {
    const available = [...toolMap.keys()].join(', ');
    throw new Error(`Unknown tool: "${name}". Available tools: ${available}`);
  }
  const result = await E(tool).execute(args);
  return /** @type {string} */ (result);
};
harden(executeTool);
