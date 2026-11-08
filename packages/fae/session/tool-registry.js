// @ts-check

import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';
import {
  assertToolArguments,
  makeAdoptTool,
  makeDescribeCapabilityTool,
  makeExecTool,
  makeViewImageTool,
  makeListPetnamesTool,
  makeLookupTool,
  makeRemoveTool,
  makeReadSourcesTool,
  makeReplyTool,
  makeSendTool,
  makeStoreTool,
} from '../src/tool-makers.js';
import { makeSubagentTools } from '../src/subagent.js';
import { discoverTools, executeTool } from '../src/tools.js';

import { makeAccountStatusTool } from './account-tool.js';
import { makeWorkflowTools, REVIEW_TOOL_NAMES } from './workflow-tools.js';

const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_RECORD_KEYS = 1024;
const MAX_SCHEMA_STRING_LENGTH = 64 * 1024;
const MAX_SCHEMA_BYTES = 1024 * 1024;

/**
 * Copy JSON schema data across the hosted seam without retaining a capability,
 * accessor, exotic prototype, bigint, cycle, or unbounded data structure.
 *
 * @param {any} root
 */
export const projectToolInputSchema = root => {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  /** @param {string} text */
  const consumeText = text => {
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_SCHEMA_BYTES) {
      throw Error('Floot tool schema exceeds the byte limit');
    }
  };
  /**
   * @param {any} value
   * @param {number} depth
   */
  const visit = (value, depth) => {
    nodes += 1;
    bytes += 8;
    nodes <= MAX_SCHEMA_NODES ||
      (() => {
        throw Error('Floot tool schema exceeds the node limit');
      })();
    depth <= MAX_SCHEMA_DEPTH ||
      (() => {
        throw Error('Floot tool schema exceeds the depth limit');
      })();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      value.length <= MAX_SCHEMA_STRING_LENGTH ||
        (() => {
          throw Error('Floot tool schema contains an oversized string');
        })();
      consumeText(value);
      return value;
    }
    if (typeof value === 'number') {
      Number.isFinite(value) ||
        (() => {
          throw Error('Floot tool schema contains a non-finite number');
        })();
      return value;
    }
    let style;
    try {
      style = passStyleOf(value);
    } catch {
      throw Error('Floot tool schema must contain only passable JSON data');
    }
    style === 'copyArray' ||
      style === 'copyRecord' ||
      (() => {
        throw Error('Floot tool schema must not contain capabilities');
      })();
    !ancestors.has(value) ||
      (() => {
        throw Error('Floot tool schema must not contain cycles');
      })();
    ancestors.add(value);
    let projected;
    if (style === 'copyArray') {
      projected = value.map(item => visit(item, depth + 1));
    } else {
      const keys = Reflect.ownKeys(value);
      keys.every(key => typeof key === 'string') ||
        (() => {
          throw Error('Floot tool schema must have only string keys');
        })();
      const stringKeys = /** @type {string[]} */ (keys);
      stringKeys.length <= MAX_SCHEMA_RECORD_KEYS ||
        (() => {
          throw Error('Floot tool schema record has too many fields');
        })();
      projected = Object.fromEntries(
        stringKeys.map(key => {
          key.length <= MAX_SCHEMA_STRING_LENGTH ||
            (() => {
              throw Error('Floot tool schema contains an oversized key');
            })();
          consumeText(key);
          return [key, visit(value[key], depth + 1)];
        }),
      );
    }
    ancestors.delete(value);
    return harden(projected);
  };
  return visit(root, 0);
};
harden(projectToolInputSchema);

/**
 * Convert the OpenAI-compatible schema used by FAE providers to Codex
 * app-server's dynamic-tool descriptor without changing the tool authority.
 *
 * @param {any} schema
 */
export const projectToolSchema = schema => {
  const fn = schema?.function;
  const name = /** @type {unknown} */ (fn?.name);
  const description = /** @type {unknown} */ (fn?.description);
  if (
    schema?.type !== 'function' ||
    typeof name !== 'string' ||
    name === '' ||
    name.length > 128 ||
    typeof description !== 'string' ||
    description.length > 16_384 ||
    !fn?.parameters ||
    typeof fn.parameters !== 'object'
  ) {
    throw Error('Floot tool returned an invalid function schema');
  }
  return harden({
    type: 'function',
    function: harden({
      name,
      description,
      parameters: projectToolInputSchema(fn.parameters),
    }),
  });
};
harden(projectToolSchema);

/**
 * A snapshot keeps advertised tool schemas and executable capabilities
 * together for the duration of a model round.
 *
 * @param {any} powers
 * @param {object} [options]
 * @param {boolean} [options.imageInputs] Whether the backend can retain image tool results.
 * @param {any} [options.spawner] - A `SubagentSpawner` capability.
 * @param {any} [options.delegations] - The session's delegation registry.
 * @param {any} [options.subagentLimits] Operator delegation budgets.
 * @param {(refresh?: boolean) => Promise<any>} [options.readAccounts]
 * @param {Set<string>} [options.settledMail]
 * @param {Map<string, any>} [options.extraTools] Session tools supplied by the preset.
 */
export const makeFlootToolRegistry = (
  powers,
  {
    imageInputs = true,
    spawner,
    delegations,
    subagentLimits,
    readAccounts,
    settledMail,
    extraTools,
  } = {},
) => {
  /** @type {Map<string, any>} */
  const builtins = new Map();
  builtins.set('exec', makeExecTool(powers));
  if (imageInputs) builtins.set('viewImage', makeViewImageTool(powers));
  builtins.set('list', makeListPetnamesTool(powers));
  builtins.set('lookup', makeLookupTool(powers));
  builtins.set('describeCapability', makeDescribeCapabilityTool(powers));
  builtins.set('readSources', makeReadSourcesTool(powers));
  builtins.set('store', makeStoreTool(powers));
  builtins.set('remove', makeRemoveTool(powers));
  builtins.set(
    'listMessages',
    harden({
      schema: () =>
        harden({
          type: 'function',
          function: {
            name: 'listMessages',
            description:
              'List inbox messages with their number, sender, text, and attached object edge names.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
      execute: async () => {
        const messages = await E(powers).listMessages();
        const summary = (Array.isArray(messages) ? messages : []).map(
          message => ({
            number: Number(message.number),
            from: message.from,
            type: message.type,
            text: Array.isArray(message.strings)
              ? message.strings.join('')
              : undefined,
            edgeNames: Array.isArray(message.names) ? message.names : [],
          }),
        );
        return JSON.stringify(summary, null, 2);
      },
      help: () => 'List inbox messages with their numbers and edge names.',
    }),
  );
  builtins.set('adopt', makeAdoptTool(powers));
  builtins.set('send', makeSendTool(powers));
  builtins.set('reply', makeReplyTool(powers));
  for (const [name, tool] of makeWorkflowTools(powers, {
    settled: settledMail,
  }))
    builtins.set(name, tool);
  if (spawner && delegations) {
    for (const [name, tool] of makeSubagentTools({
      powers,
      spawner,
      delegations,
      limits: subagentLimits,
      // A Floot session dismisses every message it handles, a delegation reply
      // included, so telling the model to adopt from one would be a lie.
      retainsAttachments: false,
    })) {
      builtins.set(name, tool);
    }
  }
  if (readAccounts) {
    builtins.set('accountStatus', makeAccountStatusTool({ readAccounts }));
  }
  // Only this registry's built-ins have a closed named-argument convention.
  // User-stored tools and factory extras retain their own schema semantics.
  const builtinTools = new Set(builtins.values());
  for (const [name, tool] of extraTools ?? []) {
    if (builtins.has(name)) {
      throw Error(`Floot tool "${name}" is already defined`);
    }
    builtins.set(name, tool);
  }

  const snapshot = async () => {
    const reviewAvailable = await E(powers).has('dev-review');
    // Discover with every reserved built-in name, even when it is unavailable.
    // Otherwise an adopted tool could impersonate the missing workflow.
    const { schemas: discoveredSchemas, toolMap } = await discoverTools(
      powers,
      builtins,
    );
    const schemas = discoveredSchemas.filter(
      schema =>
        reviewAvailable || !REVIEW_TOOL_NAMES.includes(schema.function.name),
    );
    if (!reviewAvailable) {
      for (const name of REVIEW_TOOL_NAMES) toolMap.delete(name);
    }
    const builtinSchemas = new Map();
    const providerSchemas = schemas.map(schema => {
      const projected = projectToolSchema(schema);
      const { function: fn } = projected;
      if (!builtinTools.has(toolMap.get(fn.name))) return projected;
      const closed = harden({
        ...projected,
        function: harden({
          ...fn,
          parameters: harden({ ...fn.parameters, additionalProperties: false }),
        }),
      });
      builtinSchemas.set(fn.name, closed);
      return closed;
    });
    return harden({
      providerSchemas,
      names: providerSchemas.map(schema => schema.function.name).sort(),
      execute: async (name, args) => {
        const schema = builtinSchemas.get(name);
        if (schema) assertToolArguments(schema, args);
        return executeTool(name, args, toolMap);
      },
    });
  };

  return harden({ snapshot });
};
harden(makeFlootToolRegistry);
