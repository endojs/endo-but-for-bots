// @ts-check
/// <reference types="ses"/>

/** @import { Filesystem } from '@endo/platform/fs/extended' */
/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import {
  makeInMemoryBackend,
  makeNodeFsBackend,
  wrapBackend,
} from '@endo/platform/fs/extended';

import { makeFilesystemGlobal } from './fs.js';

/**
 * Workspace seam setup: mint a workspace backing and the code-mode global
 * descriptor that describes it, as one pair, so the declaration a guest reads
 * cannot drift from the authority it was actually handed.
 *
 * `makeWorkspaceGlobal` on its own describes a capability the host has already
 * built. These helpers close the other half of the seam for the two backings
 * `@endo/agent-tools` can build itself. The daemon seam is deliberately absent:
 * this package imports no daemon implementation. See the README section
 * "Choosing a workspace backing" for that recipe and for the read-only case.
 *
 * The guest-facing binding is `workspace` in every seam, while each returned
 * descriptor names the exact surface of its backing. The daemon mount seam is
 * intentionally assembled by the provisioning host rather than here.
 *
 * @typedef {object} WorkspaceSeam
 * @property {Filesystem} workspace The capability to endow under `workspace`.
 * @property {CodeModeGlobal} global The descriptor to pass to
 *   `makeEvaluateTool`.
 */

/**
 * Mint an in-memory workspace and its `workspace` descriptor: the eval, CI,
 * and test seam. Nothing outlives the process, and no host path is reachable.
 *
 * @returns {WorkspaceSeam}
 */
export const makeInMemoryWorkspaceSeam = () =>
  harden({
    workspace: wrapBackend(makeInMemoryBackend(), {
      description: 'in-memory workspace',
    }),
    global: makeFilesystemGlobal({ name: 'workspace' }),
  });
harden(makeInMemoryWorkspaceSeam);

/**
 * Mint a `node:fs`-backed workspace rooted at `rootPath` and its `workspace`
 * descriptor: the local-development seam. The backing confines every path to
 * `rootPath` — the node backend rejects a symlink whose `realpath` escapes it
 * — so the guest's reach is the subtree the host names here and nothing above
 * it.
 *
 * @param {object} options
 * @param {string} options.rootPath Absolute host path to root the workspace at.
 * @returns {WorkspaceSeam}
 */
export const makeNodeWorkspaceSeam = ({ rootPath }) =>
  harden({
    workspace: wrapBackend(makeNodeFsBackend({ rootPath }), {
      description: 'node:fs workspace',
    }),
    global: makeFilesystemGlobal({ name: 'workspace' }),
  });
harden(makeNodeWorkspaceSeam);
