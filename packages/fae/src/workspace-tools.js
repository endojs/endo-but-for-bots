// @ts-check

import { provisionGitWorkspaceTools } from '@endo/agent-tools';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { ToolRecord } from '@endo/agent-tools' */
/** @import { FaeTool, ToolSchema } from './tool-makers.js' */

/**
 * The capabilities a Fae agent's workspace is provisioned from: already-granted
 * daemon capabilities, never host paths.
 *
 * @typedef {object} FaeWorkspaceGrant
 * @property {ERef<object>} git - A `Git` from `provideGit` / `provideGitClone`,
 *   or its read-only facet.
 * @property {ERef<object>} [remote] - A `GitRemote` from `provideGitRemote`.
 */

/**
 * @param {ToolRecord} record
 * @returns {FaeTool<unknown>}
 */
export const faeToolFromRecord = record => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: record.name,
      description: record.description,
      parameters: record.parameters,
    },
  });
  return harden({
    schema: () => toolSchema,
    execute: toolArguments => record.invoke(harden({ ...toolArguments })),
    help: () => record.description,
  });
};
harden(faeToolFromRecord);

/**
 * Build the workspace tools for a Fae agent from a granted `Git` and, when
 * present, a granted `GitRemote`.
 *
 * A remote is refused beside a read-only `Git` because `pull` would mutate the
 * worktree the remote is bound to, and `fetch` / `push` mutate repository and
 * remote state. A writable `Git` is narrowed to its writer scope before any
 * tool closes over it, so history rewrite stays a separate, elevated grant.
 *
 * @param {FaeWorkspaceGrant} grant
 * @param {{ maxChars?: number }} [options]
 * @returns {Promise<Map<string, FaeTool<unknown>>>} tool name -> tool
 */
export const provisionFaeWorkspaceTools = async (
  { git, remote },
  { maxChars } = {},
) => {
  const records = await provisionGitWorkspaceTools({
    git,
    remote: /** @type {any} */ (remote),
    maxChars,
  });

  /** @type {Map<string, FaeTool<unknown>>} */
  const tools = new Map();
  for (const record of records) {
    tools.set(record.name, faeToolFromRecord(record));
  }
  return tools;
};
harden(provisionFaeWorkspaceTools);
