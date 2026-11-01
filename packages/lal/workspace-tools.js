// @ts-check
/// <reference types="ses"/>

/** @import { AgentTool } from '@earendil-works/pi-agent-core' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitWorkspaceGrant } from '@endo/agent-tools' */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { provisionGitWorkspaceTools } from '@endo/agent-tools';
import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';

/**
 * The manager-store directory holding the only capabilities a form submitter
 * may name as a workspace.
 */
export const WORKSPACES_DIRECTORY = 'workspaces';

/**
 * Resolve optional workspace names from the `workspaces` directory of Lal's
 * own guest store. The deployer places there exactly the `Git` and
 * `GitRemote` capabilities a form submitter may hand a worker, so a submitted
 * name never reaches the rest of the manager's store. Keeping both the source
 * store and resulting capabilities away from the worker guest prevents it from
 * looking up a broader Git facet later.
 *
 * @param {ERef<{ has: (...path: string[]) => Promise<boolean>, lookup: (path: string[]) => Promise<unknown> }>} store
 * @param {{ git?: string, remote?: string }} config
 * @returns {Promise<GitWorkspaceGrant | undefined>}
 */
export const resolveLalWorkspace = async (store, config) => {
  const gitName = config.git?.trim();
  const remoteName = config.remote?.trim();
  !remoteName || gitName || Fail`A Git remote requires a Git workspace`;
  if (!gitName) {
    return undefined;
  }
  /** @param {string} name */
  const lookupGrant = async name => {
    (await E(store).has(WORKSPACES_DIRECTORY, name)) ||
      Fail`Workspace grant ${q(name)} is not in the ${q(WORKSPACES_DIRECTORY)} directory`;
    return E(store).lookup([WORKSPACES_DIRECTORY, name]);
  };
  const git = /** @type {GitWorkspaceGrant['git']} */ (
    await lookupGrant(gitName)
  );
  const remote = remoteName
    ? /** @type {GitWorkspaceGrant['remote']} */ (await lookupGrant(remoteName))
    : undefined;
  return harden({ git, ...(remote === undefined ? {} : { remote }) });
};
harden(resolveLalWorkspace);

/**
 * Adapt a confined Git workspace grant to Lal's Pi tool surface.
 *
 * @param {GitWorkspaceGrant} grant
 * @returns {Promise<AgentTool[]>}
 */
export const provisionLalWorkspaceTools = async grant => {
  const records = await provisionGitWorkspaceTools(grant);
  return harden(
    records.map(record =>
      toPiAgentTool(record, { renderToolResult: toolResultToSmallcaps }),
    ),
  );
};
harden(provisionLalWorkspaceTools);
