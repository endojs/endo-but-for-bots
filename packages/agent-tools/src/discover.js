// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { ToolRecord, CapabilityToolOptions } from './types.js' */

import { E } from '@endo/eventual-send';
import { mountAsFilesystem } from '@endo/platform/fs/extended';

import { makeMountFsTools } from './mount-fs.js';
import { makeShellTool } from './shell-tool.js';
import { makeGitTool } from './git-tool.js';
import { makeGitMountTools } from './git-mount-tool.js';

/**
 * Look up a capability by pet name in an agent's namespace, returning
 * `undefined` when the name is absent (or any other lookup failure) rather
 * than throwing. A missing name is the discovery signal that the capability
 * was not granted, so it is not an error — the agent simply registers no
 * tools for it.
 *
 * @param {ERef<any>} powers
 * @param {string} petName
 * @returns {Promise<unknown>}
 */
const tryLookup = async (powers, petName) => {
  await null;
  try {
    return await E(powers).lookup([petName]);
  } catch {
    return undefined;
  }
};

/**
 * Discover the coding tools an agent's *granted capabilities* afford, by
 * looking up the well-known capability pet names in the agent's own namespace
 * and registering exactly the tool records each granted capability backs:
 *
 * - a `Dir` / mount capability (default name `fs`) → the filesystem read /
 *   list / stat / edit tools (`makeMountFsTools`), the mount projected into a
 *   `Filesystem` via `mountAsFilesystem`;
 * - a `Shell` capability (default name `shell`) → the allowlisted `exec` /
 *   `inspect` tools (`makeShellTool`);
 * - a `Git` capability (default name `git`) → the read / branch tools
 *   (`makeGitTool`) plus the mount-bridged `status` / `add` tools
 *   (`makeGitMountTools`).
 *
 * A capability that was not granted contributes no tools, so the same agent
 * code runs with or without coding capabilities — it simply has fewer tools
 * available (daemon-agent-tools Phase 4, "Agent tool discovery").
 *
 * @param {ERef<any>} powers - The agent's namespace, supporting
 *   `lookup([petName])`. A guest's own powers reference is the usual argument.
 * @param {CapabilityToolOptions} [options]
 * @returns {Promise<ToolRecord[]>}
 */
export const discoverCapabilityTools = async (powers, options = {}) => {
  const {
    fsName = 'fs',
    shellName = 'shell',
    gitName = 'git',
    readOnly = false,
    maxChars,
  } = options;

  /** @type {ToolRecord[]} */
  const records = [];

  const mount = await tryLookup(powers, fsName);
  if (mount !== undefined) {
    const filesystem = mountAsFilesystem(mount);
    const fsOpts =
      maxChars !== undefined ? { readOnly, maxChars } : { readOnly };
    records.push(...makeMountFsTools(filesystem, fsOpts));
  }

  const shell = await tryLookup(powers, shellName);
  if (shell !== undefined) {
    records.push(...makeShellTool(/** @type {any} */ (shell)));
  }

  const git = await tryLookup(powers, gitName);
  if (git !== undefined) {
    records.push(...makeGitTool(/** @type {any} */ (git)));
    records.push(...makeGitMountTools(/** @type {any} */ (git)));
  }

  return harden(records);
};
harden(discoverCapabilityTools);
