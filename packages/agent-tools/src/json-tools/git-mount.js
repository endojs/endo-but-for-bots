// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { GitMountToolCapability, ToolRecord } from '../types.js' */

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';

import { makeTool } from '../tool.js';

/**
 * The git tools in this module bridge the writable Git methods whose native
 * signatures traffic in live capabilities — `add()` and `checkoutConflict()`
 * take arrays of `PathEntry` remotables — so they cannot sit in the
 * JSON-transparent, one-to-one guard-mapped slice `makeGitTool` exposes.
 * `status()` remains here as the mount-bridged agent tool so it can apply the
 * agent-facing untracked-file default. Each tool here holds the
 * mount/git capability pair (the mount reached through `Git.worktree()`) and
 * converts at the boundary: path strings in, JSON-safe records out. The
 * capability, never a path string, remains the confinement boundary — a `../`
 * segment is contained by the mount (clamped at the worktree root), not by a
 * brittle string check here.
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
 * JSON Schema for `add`. The tool takes mount-relative path *strings*; the
 * maker resolves each to the `PathEntry` remotable `Git.add` actually
 * wants. This is the deliberate wire↔cap divergence the mount bridge exists to
 * span, which is why `add` lives here and not in `makeGitTool`'s
 * divergence-gated slice.
 */
const addParameters = harden({
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Mount-relative paths to stage, each addressing a file (not the ' +
        'worktree root). Each is resolved through the worktree mount; a ' +
        '"../" segment is contained by the capability, clamped at the ' +
        'worktree root rather than escaping it.',
    },
  },
  required: ['paths'],
  additionalProperties: false,
});

const checkoutConflictParameters = harden({
  type: 'object',
  properties: {
    paths: addParameters.properties.paths,
    side: {
      type: 'string',
      enum: ['ours', 'theirs'],
      description:
        'The unmerged Git index stage to select for every path: "ours" is ' +
        'stage 2 and "theirs" is stage 3. These names identify index ' +
        'stages, not stable branch roles. During rebase, Git treats the ' +
        'upstream onto which commits are replayed as ours and the commit ' +
        'being replayed as theirs, inverted from intuitive ' +
        'current/incoming branch wording.',
    },
  },
  required: ['paths', 'side'],
  additionalProperties: false,
});

/**
 * Split a mount-relative path string into entry segments, dropping empty and
 * `.` components so `a/b`, `a//b`, and `a/b/` resolve identically. A `..`
 * segment is preserved and contained by the mount capability (clamped at the
 * worktree root), not by a brittle string check here. A path built only from
 * dropped components (`.`, `/`, `//`, `./`) yields an empty segment list; the
 * caller rejects that so it never resolves to the worktree-root entry.
 *
 * @param {string} path
 * @returns {string[]}
 */
const pathToSegments = path =>
  path.split('/').filter(segment => segment !== '' && segment !== '.');

/**
 * @param {string} verb
 * @param {string[]} paths
 * @returns {string[][]}
 */
const pathsToSegments = (verb, paths) => {
  if (paths.length === 0) {
    throw new Error(`${verb} requires a non-empty array of paths`);
  }
  return paths.map(path => {
    if (path === '') {
      throw new Error(`${verb} paths must be non-empty strings`);
    }
    const segments = pathToSegments(path);
    if (segments.length === 0) {
      throw new Error(
        `${verb} paths must address a file, not the worktree root`,
      );
    }
    return segments;
  });
};

/**
 * @param {ERef<GitMountToolCapability>} gitCap
 * @param {string[][]} segmentsByPath
 */
const entriesForSegments = async (gitCap, segmentsByPath) => {
  const mount = await E(gitCap).worktree();
  return Promise.all(segmentsByPath.map(segments => E(mount).entry(segments)));
};

/**
 * Build the mount-bridged git tool records — `status`, `add`, and
 * `checkoutConflict` — for a live `Git` capability.
 * These complement
 * `makeGitTool`'s JSON-transparent slice.
 *
 * @param {ERef<GitMountToolCapability>} gitCap A live `Git` capability. The
 *   worktree mount is reached through `E(gitCap).worktree()`; a writable Git
 *   yields the writable mount, a read-only Git a read-only view that fails
 *   `add` closed at the capability regardless.
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

  const addTool = makeTool({
    name: 'add',
    description:
      'Stage files for the next commit by mount-relative path. Staging is ' +
      'additive and never discards working-tree changes.',
    parameters: addParameters,
    argGuards: harden([M.arrayOf(M.string())]),
    execute: async args => {
      const { paths } = /** @type {{ paths: string[] }} */ (args);
      // Normalize every path up front and reject any that addresses no file.
      // Beyond the empty string, a path built only from dropped components
      // (`.`, `/`, `//`, `./`) collapses to zero segments, which would resolve
      // to the worktree-ROOT entry and reach `Git.add` as an empty pathspec —
      // rejected by the backend only with an opaque low-level error. Reject it
      // here, at the tool, with a clear message. A leading `..` is deliberately
      // NOT rejected here: the mount contains it (clamped at the root).
      const segmentsByPath = pathsToSegments('add', paths);
      // Resolve each path to a `PathEntry` minted by this Git's own
      // worktree mount, so `Git.add`'s lineage check accepts it. `callWhen`
      // does not deeply await array elements, so the entries must be settled
      // remotables — not promises — before the call.
      const entries = await entriesForSegments(gitCap, segmentsByPath);
      await E(gitCap).add(harden(entries));
      return `Staged ${paths.length} path${paths.length === 1 ? '' : 's'}.`;
    },
  });

  const checkoutConflictTool = makeTool({
    name: 'checkoutConflict',
    description:
      'Resolve conflicted paths by selecting Git index stage 2 ("ours") ' +
      'or stage 3 ("theirs"), then stage the resolution. These are index ' +
      'stages, not stable branch roles: during rebase, ours is the upstream ' +
      'side and theirs is the commit being replayed, inverted from ' +
      'intuitive current/incoming wording. Fails on a path whose selected ' +
      'side has no version — a delete/modify conflict, where that side ' +
      'deleted the file — or a path that is not actually unmerged; resolve ' +
      'those by picking the surviving side or removing the path. Paths are ' +
      'processed left to right, so on failure the earlier paths are already ' +
      'staged and the error names the path that stopped it.',
    parameters: checkoutConflictParameters,
    argGuards: harden([M.arrayOf(M.string()), M.or('ours', 'theirs')]),
    execute: async args => {
      const { paths, side } =
        /** @type {{ paths: string[], side: 'ours' | 'theirs' }} */ (args);
      const segmentsByPath = pathsToSegments('checkoutConflict', paths);
      const entries = await entriesForSegments(gitCap, segmentsByPath);
      await E(gitCap).checkoutConflict(harden(entries), side);
      return (
        `Selected ${side} for ${paths.length} conflicted ` +
        `path${paths.length === 1 ? '' : 's'}.`
      );
    },
  });

  return harden([statusTool, addTool, checkoutConflictTool]);
};
harden(makeGitMountTools);
