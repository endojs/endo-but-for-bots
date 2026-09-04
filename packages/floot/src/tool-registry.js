// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { passStyleOf } from '@endo/pass-style';
import {
  makeAdoptTool,
  makeExecTool,
  makeListPetnamesTool,
  makeLookupTool,
  makeRemoveTool,
  makeReplyTool,
  makeSendTool,
  makeStoreTool,
} from '@endo/fae/src/tool-makers.js';
import { makeSubagentTools } from '@endo/fae/src/subagent.js';
import { discoverTools, executeTool } from '@endo/fae/src/tools.js';
import { HostedToolSetInterface } from '@endo/hosted-agent';

import { makeAccountStatusTool } from './account-tool.js';

const TOOL_POLICY_VERSION = 'floot-endo-tools-v1';
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

/** @param {ReturnType<typeof projectToolSchema>} schema */
const toDynamicTool = schema => {
  const fn = schema.function;
  return harden({
    type: 'function',
    name: fn.name,
    description: fn.description,
    inputSchema: fn.parameters,
  });
};

/**
 * Attenuate a local snapshot to the two operations a hosted backend needs.
 *
 * @param {any} snapshot
 */
export const makeEndoToolSet = snapshot =>
  makeExo('HostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({
        dynamicTools: snapshot.dynamicTools,
        toolSetId: snapshot.toolSetId,
      });
    },
    execute(name, args) {
      return snapshot.execute(name, args);
    },
    help() {
      return 'Pinned Endo tool catalog: describe() and execute(name, args).';
    },
  });
harden(makeEndoToolSet);

/**
 * Build the one authoritative Endo tool catalog used by API providers and
 * hosted backends. A snapshot pins names, schemas, and executable capabilities
 * together so an advertised name cannot be rebound during a turn.
 *
 * Delegation is capability-gated: the subagent tools appear in the catalog only
 * when the factory handed this session a spawner, and their presence changes
 * `toolSetId`, so a hosted thread pinned without them cannot silently resume
 * with them.
 *
 * `accountStatus` is gated the same way, on a read-only account oracle.
 *
 * @param {any} powers
 * @param {object} [options]
 * @param {any} [options.spawner] - A `SubagentSpawner` capability.
 * @param {any} [options.delegations] - The session's delegation registry.
 * @param {any} [options.accountOracle] - A read-only `HostedAccount`.
 * @param {() => Promise<{ inputTokens: number, outputTokens: number }>} [options.getUsage]
 * @param {() => string} [options.getModelId]
 */
export const makeFlootToolRegistry = (
  powers,
  { spawner, delegations, accountOracle, getUsage, getModelId } = {},
) => {
  /** @type {Map<string, any>} */
  const builtins = new Map();
  builtins.set('exec', makeExecTool(powers));
  builtins.set('list', makeListPetnamesTool(powers));
  builtins.set('lookup', makeLookupTool(powers));
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
  if (spawner && delegations) {
    for (const [name, tool] of makeSubagentTools({
      powers,
      spawner,
      delegations,
    })) {
      builtins.set(name, tool);
    }
  }
  if (accountOracle) {
    builtins.set(
      'accountStatus',
      makeAccountStatusTool({ oracle: accountOracle, getUsage, getModelId }),
    );
  }

  const snapshot = async () => {
    const { schemas, toolMap, storedTools } = await discoverTools(
      powers,
      builtins,
    );
    const providerSchemas = schemas.map(projectToolSchema);
    const dynamicTools = providerSchemas.map(toDynamicTool);
    const names = dynamicTools.map(tool => tool.name).sort();
    const storedIdentities = await Promise.all(
      storedTools.map(async ({ petName, functionName }) =>
        harden({
          functionName,
          petName,
          // Endo locators bind the schema to the durable formula/capability,
          // not merely to a same-shaped replacement after reincarnation.
          locator: await E(powers).locate(['tools', petName]),
        }),
      ),
    );
    return harden({
      providerSchemas,
      dynamicTools,
      // A stable identifier for persisted hosted threads. Schema changes must
      // create a new thread instead of silently resuming with different powers.
      toolSetId: JSON.stringify(
        harden({
          policyVersion: TOOL_POLICY_VERSION,
          storedIdentities,
          tools: dynamicTools
            .map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        }),
      ),
      names,
      execute: (name, args) => executeTool(name, args, toolMap),
    });
  };

  return harden({ snapshot });
};
harden(makeFlootToolRegistry);
