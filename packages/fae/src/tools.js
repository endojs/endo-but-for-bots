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
 * @property {Array<{ petName: string, functionName: string }>} storedTools
 */

/**
 * Discover all available tools by merging local built-in tools with any
 * daemon-side tools stored in the `tools/` petname directory.
 *
 * Called at the start of each agent turn so that tools adopted between
 * turns (e.g., received via mail) are immediately available.
 *
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @param {Map<string, FaeTool>} localTools
 * @returns {Promise<DiscoveredTools>}
 */
export const discoverTools = async (host, localTools) => {
  /** @type {ToolSchema[]} */
  const schemas = [];
  /** @type {Map<string, FaeTool | object>} */
  const toolMap = new Map();
  const storedTools = [];
  for (const [petName, tool] of localTools.entries()) {
    const schema = tool.schema();
    const functionName = schema?.function?.name;
    if (typeof functionName !== 'string' || functionName === '') {
      throw Error(`Local tool ${petName} has no function name`);
    }
    if (toolMap.has(functionName)) {
      throw Error(`Duplicate local tool function name: ${functionName}`);
    }
    schemas.push(schema);
    toolMap.set(functionName, tool);
  }

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
     * @param {unknown} x
     * @returns {x is string}
     */ x => typeof x === 'string',
  );
  // Read every stored tool's schema first, then decide what each name binds
  // to. A tool declares its own function name, and a tool can arrive by mail:
  // installing them one at a time in pet-name order would let an adopted tool
  // claim the name of a tool already installed later in that order, and the
  // displaced one would be reported only as "not a valid FaeTool".
  /** @type {Array<{ petName: string, functionName: string, tool: object, schema: ToolSchema }>} */
  const candidates = [];
  for (const name of names.sort()) {
    try {
      const tool = await E(host).lookup(['tools', name]);
      const toolSchema = /** @type {ToolSchema} */ (await E(tool).schema());
      const functionName = toolSchema?.function?.name;
      if (typeof functionName !== 'string' || functionName === '') {
        throw Error('schema has no function name');
      }
      candidates.push(
        harden({
          petName: name,
          functionName,
          tool: /** @type {object} */ (tool),
          schema: toolSchema,
        }),
      );
    } catch (/** @type {any} */ err) {
      console.warn(
        `[fae] tools/${name}: not a valid FaeTool: ${err.message || err}`,
      );
    }
  }

  /** @type {Map<string, string[]>} */
  const claimants = new Map();
  for (const { petName, functionName } of candidates) {
    claimants.set(functionName, [
      ...(claimants.get(functionName) || []),
      petName,
    ]);
  }

  for (const { petName, functionName, tool, schema } of candidates) {
    if (toolMap.has(functionName)) {
      // A built-in owns the name. The stored tool is refused rather than
      // shadowing it; endowed authority is not up for grabs.
      console.warn(
        `[fae] tools/${petName}: not installed; function name "${functionName}" is a built-in`,
      );
      // eslint-disable-next-line no-continue
      continue;
    }
    const competing = /** @type {string[]} */ (claimants.get(functionName));
    if (competing.length > 1) {
      // Neither wins. Whichever went first would be a name capture, since the
      // order is the agent's choice of pet names and a tool it adopted from a
      // message can influence it. Refusing both is a visible gap the model can
      // report, not a silent substitution.
      console.warn(
        `[fae] function name "${functionName}" is claimed by ${competing
          .map(claimant => `tools/${claimant}`)
          .join(' and ')}; none installed`,
      );
      // eslint-disable-next-line no-continue
      continue;
    }
    toolMap.set(functionName, tool);
    schemas.push(schema);
    storedTools.push(harden({ petName, functionName }));
  }

  return harden({ schemas, toolMap, storedTools });
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
