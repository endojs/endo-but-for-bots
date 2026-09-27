// @ts-check
/// <reference types="ses"/>

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
 * passes every grant, provisioning derives only the Filesystem view of the
 * supplied Git worktree, and no petstore is enumerated or probed for powers.
 *
 * @param {AgentConfig} [config]
 */
export const defineWorkspaceAgent = (config = {}) => {
  const makeAgent = defineAgent(config);

  /**
   * @param {AgentMakeOptions & { workspaceGrants: ProvisionWorkspaceGrants }} options
   */
  const makeWorkspaceAgent = async ({ workspaceGrants, ...options }) => {
    await null;
    const records = await provisionWorkspaceTools(workspaceGrants);
    const tools = records.map(record =>
      toPiAgentTool(record, { renderToolResult: toolResultToSmallcaps }),
    );
    return makeAgent({ ...options, tools: harden(tools) });
  };

  return harden(makeWorkspaceAgent);
};
harden(defineWorkspaceAgent);
