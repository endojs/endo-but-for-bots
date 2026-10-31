// @ts-check

import { E } from '@endo/eventual-send';
import { mountAsFilesystem } from '@endo/platform/fs/extended';
import {
  makeGitMountTools,
  makeGitRemoteTool,
  makeGitTool,
  makeMountFsTools,
} from '@endo/agent-tools';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { ToolRecord } from '@endo/agent-tools' */
/** @import { FaeTool, ToolSchema } from './tool-makers.js' */

/**
 * The capabilities a Fae agent's workspace is provisioned from. Both are
 * already-granted daemon capabilities, never host paths: the operator chose
 * them when the agent was created, and the agent's own pet store is not
 * consulted.
 *
 * @typedef {object} FaeWorkspaceGrant
 * @property {ERef<object>} git - A `Git` from `provideGit` / `provideGitClone`,
 *   or its read-only facet.
 * @property {ERef<object>} [remote] - A `GitRemote` from `provideGitRemote`.
 */

/**
 * Methods whose presence on a granted `Git` marks it writable. The read-only
 * facet (`Git.readOnly()`, or `provideGit` over a read-only mount) carries
 * none of them.
 */
const gitWriterMethods = harden(['add', 'commit']);

/**
 * Adapt one provider-independent agent tool record to the `FaeTool` shape the
 * inbox loop dispatches through. The record's name, description and JSON
 * Schema reach the model unchanged; the result is returned as the passable the
 * record produced, so mount entries in a status or conflict report stay
 * references and the loop's Justin encoding renders them.
 *
 * @param {ToolRecord} record
 * @returns {FaeTool}
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
    execute: async toolArguments =>
      /** @type {Promise<string>} */ (
        record.invoke(harden({ ...toolArguments }))
      ),
    help: () => record.description,
  });
};
harden(faeToolFromRecord);

/**
 * Build the workspace tools for a Fae agent from a granted `Git` and, when
 * present, a granted `GitRemote`.
 *
 * The one `Git` grant yields both the file tools (over the `Filesystem`
 * projected from its own worktree mount) and the versioning tools, so the
 * agent edits and commits one worktree without any path crossing the
 * boundary. This replaces rooting `run-command` / file caplets at `FAE_CWD`
 * for git work: commits are attributed by the identity the `Git` formula
 * fixed at construction, and history, remotes and the worktree are reachable
 * only as far as the granted capabilities reach.
 *
 * The catalog follows the grant. A read-only `Git` gets the reader git tools
 * and read-only file tools, so the model is never offered a verb the
 * capability would refuse. A writable `Git` gets the writer tools; history
 * rewrite is not offered even when the capability carries it, since that is a
 * separate, elevated grant (`makeGitTool(git, { facet: 'rewriter' })`).
 *
 * @param {FaeWorkspaceGrant} grant
 * @param {{ maxChars?: number }} [options]
 * @returns {Promise<Map<string, FaeTool>>} tool name → tool
 */
export const provisionFaeWorkspaceTools = async (
  { git, remote },
  { maxChars } = {},
) => {
  const methodNames = /** @type {string[]} */ (
    // eslint-disable-next-line no-underscore-dangle
    await E(git).__getMethodNames__()
  );
  const writable = gitWriterMethods.every(method =>
    methodNames.includes(method),
  );
  const worktree = await E(git).worktree();
  const filesystem = mountAsFilesystem(/** @type {any} */ (worktree));

  /** @type {ToolRecord[]} */
  const records = [
    ...makeMountFsTools(filesystem, { readOnly: !writable, maxChars }),
    ...(writable
      ? makeGitTool(/** @type {any} */ (git))
      : makeGitTool(/** @type {any} */ (git), { facet: 'reader' })),
    ...makeGitMountTools(/** @type {any} */ (git)),
    ...(remote === undefined
      ? []
      : makeGitRemoteTool(/** @type {any} */ (remote))),
  ];

  /** @type {Map<string, FaeTool>} */
  const tools = new Map();
  for (const record of records) {
    if (tools.has(record.name)) {
      throw Error(`Workspace tool name ${record.name} is emitted twice`);
    }
    tools.set(record.name, faeToolFromRecord(record));
  }
  return tools;
};
harden(provisionFaeWorkspaceTools);
