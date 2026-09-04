// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitMountToolCapability, ToolRecord } from '../types.js' */

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';

import { makeTool } from '../tool.js';

/**
 * `status()` stays separate from the JSON-transparent, one-to-one guard-mapped
 * slice `makeGitTool` exposes so this agent-facing view can apply the collapsed
 * untracked-file default and project only copy-data rows.
 */

const STATUS_OPTIONS = harden({
  type: 'object',
  properties: {
    maxCount: {
      type: 'integer',
      minimum: 1,
      description: 'Return at most this many status rows.',
    },
    untracked: {
      type: 'string',
      enum: ['all', 'normal', 'no'],
      description:
        'Include all untracked files, collapse them to directories, or omit them.',
    },
  },
  required: [],
  additionalProperties: false,
});

/** JSON Schema shared by the read-only `status` tool. */
const STATUS_PARAMETERS = harden({
  type: 'object',
  properties: { options: STATUS_OPTIONS },
  required: [],
  additionalProperties: false,
});

/**
 * Build the agent-facing `status` tool for a live `Git` capability.
 *
 * @param {ERef<GitMountToolCapability>} gitCap A live `Git` capability.
 * @returns {ToolRecord[]}
 */
export const makeGitMountTools = gitCap => {
  const statusTool = makeTool({
    name: 'status',
    description:
      'Report the working-tree status as { entries, truncated }, with one ' +
      'copy-data row per changed path. By default, untracked directories are ' +
      'collapsed to one row; pass options.untracked="all" for every file.',
    parameters: STATUS_PARAMETERS,
    argGuards: harden([
      M.splitRecord(
        {},
        { maxCount: M.number(), untracked: M.or('all', 'normal', 'no') },
        harden({}),
      ),
    ]),
    execute: async args => {
      const options =
        /** @type {{ maxCount?: number, untracked?: 'all' | 'normal' | 'no' }} */ (
          args.options || {}
        );
      const result = await E(gitCap).status({
        untracked: options.untracked ?? 'normal',
        ...(options.maxCount === undefined
          ? {}
          : { maxCount: options.maxCount }),
      });
      return harden({
        entries: harden(
          result.entries.map(row => {
            const { path, index, worktree, renamedFrom } = row;
            return harden({
              path,
              index,
              worktree,
              ...(renamedFrom !== undefined ? { renamedFrom } : {}),
            });
          }),
        ),
        truncated: result.truncated,
      });
    },
  });

  return harden([statusTool]);
};
harden(makeGitMountTools);
