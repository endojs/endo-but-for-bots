// @ts-check
/// <reference types="ses"/>

/** @import { AgentTool } from '@earendil-works/pi-agent-core' */
/** @import { ERef } from '@endo/eventual-send' */

import { E } from '@endo/eventual-send';
import { provisionGitWorkspaceTools } from '@endo/agent-tools';
import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';

/**
 * @typedef {object} LalWorkspaceGrant
 * @property {ERef<object>} git
 * @property {ERef<object>} [remote]
 */

/**
 * Resolve optional workspace pet names from Lal's own guest store. Keeping
 * both the source store and resulting capabilities away from the worker guest
 * prevents it from looking up a broader Git facet later.
 *
 * @param {ERef<{ lookup: (name: string) => object }>} store
 * @param {{ git?: string, remote?: string }} config
 * @returns {Promise<LalWorkspaceGrant | undefined>}
 */
export const resolveLalWorkspace = async (store, config) => {
  const gitName = config.git?.trim();
  const remoteName = config.remote?.trim();
  if (remoteName && !gitName) {
    throw new Error('A Git remote requires a Git workspace');
  }
  if (!gitName) {
    return undefined;
  }
  return harden({
    git: await E(store).lookup(gitName),
    ...(remoteName ? { remote: await E(store).lookup(remoteName) } : {}),
  });
};
harden(resolveLalWorkspace);

/**
 * Adapt a confined Git workspace grant to Lal's Pi tool surface.
 *
 * @param {LalWorkspaceGrant} grant
 * @param {{ maxChars?: number }} [options]
 * @returns {Promise<AgentTool[]>}
 */
export const provisionLalWorkspaceTools = async (
  { git, remote },
  { maxChars } = {},
) => {
  const records = await provisionGitWorkspaceTools({
    git,
    remote: /** @type {any} */ (remote),
    maxChars,
  });
  return harden(
    records.map(record =>
      toPiAgentTool(record, { renderToolResult: toolResultToSmallcaps }),
    ),
  );
};
harden(provisionLalWorkspaceTools);
