// @ts-check
/// <reference types="ses"/>

/** @import { Agent } from '@earendil-works/pi-agent-core' */
/** @import { AgentConfig, AgentMakeOptions } from './types.js' */
/** @import { ProvisionWorkspaceGrants } from '@endo/agent-tools/types-index.js' */

import { toPiAgentTool } from '@endo/agent-tools/pi';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
import { provisionWorkspaceTools } from '@endo/agent-tools/workspace.js';

import { defineAgent } from './define-agent.js';

/**
 * Define a Pi agent whose tool surface is assembled from an explicit set of
 * already-granted workspace capabilities.
 *
 * This is deliberately not capability discovery: the caller chooses and
 * passes every grant, and no petstore is enumerated or probed for powers. The
 * only capability provisioning derives rather than receives is the Filesystem
 * view of a supplied Git worktree, and only when no `filesystem` grant is
 * passed alongside it.
 *
 * The workspace grants are the agent's only tool source. A `tools` entry in
 * the config or the make options, or tools returned by an `endow` hook, would
 * otherwise be silently replaced or would bypass the explicit grants, so each
 * fails closed. An `endow` hook may still contribute `getApiKey`. The hook
 * runs with a view of the make options that omits the provisioned `tools`, so
 * it never holds the granted `push`, `fetch`, or `exec` closures.
 *
 * @param {Omit<AgentConfig, 'tools'>} [config]
 * @returns {(options: Omit<AgentMakeOptions, 'tools'> & { workspaceGrants: ProvisionWorkspaceGrants }) => Promise<Agent>}
 *   the powered-stage maker, which provisions the grants and constructs the agent
 */
export const defineWorkspaceAgent = (config = {}) => {
  if (/** @type {AgentConfig} */ (config).tools !== undefined) {
    throw TypeError(
      'defineWorkspaceAgent: tools come only from workspaceGrants; remove config.tools',
    );
  }
  const { endow } = config;
  const makeAgent = defineAgent({
    ...config,
    endow:
      endow &&
      ((definition, options) => {
        const { tools: _granted, ...grantFreeOptions } = options;
        const endowments = endow(definition, harden(grantFreeOptions));
        if (endowments === null || typeof endowments !== 'object') {
          throw TypeError(
            'defineWorkspaceAgent: an endow hook must return an endowments object',
          );
        }
        if (endowments.tools !== undefined) {
          throw TypeError(
            'defineWorkspaceAgent: tools come only from workspaceGrants; an endow hook may not return tools',
          );
        }
        return endowments;
      }),
  });

  /**
   * @param {Omit<AgentMakeOptions, 'tools'> & { workspaceGrants: ProvisionWorkspaceGrants }} options
   */
  const makeWorkspaceAgent = async ({ workspaceGrants, ...options }) => {
    await null;
    if (/** @type {AgentMakeOptions} */ (options).tools !== undefined) {
      throw TypeError(
        'defineWorkspaceAgent: tools come only from workspaceGrants; remove options.tools',
      );
    }
    const records = await provisionWorkspaceTools(workspaceGrants);
    const tools = records.map(record =>
      toPiAgentTool(record, { renderToolResult: toolResultToSmallcaps }),
    );
    return makeAgent({ ...options, tools: harden(tools) });
  };

  return harden(makeWorkspaceAgent);
};
harden(defineWorkspaceAgent);
