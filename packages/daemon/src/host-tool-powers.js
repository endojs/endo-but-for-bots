// @ts-check

/**
 * Host tool powers: the capabilities the daemon core needs that are
 * implemented by spawning an operating-system process.
 *
 * `@endo/git` shells out to `git`, `@endo/host-spawner` spawns
 * arbitrary commands, and `@endo/sandbox` / `@endo/9p-server` spawn
 * `bwrap` / `podman` / `mount`, so all four statically import
 * `node:child_process` (and, for git, eight more `node:` builtins).  A
 * static import of any of them from `manager.js` keeps the daemon out of the XS bundle,
 * which has no host process to spawn into and no `node:` builtins to
 * resolve.  They are therefore injected through `DaemonicPowers`
 * rather than imported by the daemon core, the same way
 * `better-sqlite3` reaches the daemon as an injected `Database`
 * constructor.
 *
 * This module holds only the platform-neutral half, so that importing
 * it does not drag the Node implementations back onto the bundle's
 * compartment graph; `host-tool-powers-node.js` holds those.
 *
 * See `designs/platform-neutral-hash.md` and `rust/endo/README.md`
 * § "The XS daemon bundle pulls in Node-only packages".
 */

import { makeError, X, q } from '@endo/errors';

/** @import { HostToolPowers } from './types.js' */

/**
 * @param {string} name
 * @returns {never}
 */
const refuse = name => {
  throw makeError(
    X`This supervisor supplied no host tool powers, so ${q(name)} is unavailable; formulas that spawn host processes (git, shell, sandbox) are not supported here`,
  );
};

/**
 * Fill in refusing stand-ins for a supervisor that supplied no host
 * tools, so the daemon core can call them unconditionally and a `git`
 * or `shell` formula fails with a diagnosis rather than a missing
 * import.
 *
 * @param {Partial<HostToolPowers>} [hostTools]
 * @returns {HostToolPowers}
 */
export const provideHostToolPowers = (hostTools = {}) =>
  harden({
    getEnvironment: hostTools.getEnvironment ?? (() => harden({})),
    gitClone: hostTools.gitClone ?? (() => refuse('gitClone')),
    makeNativeGitBackend:
      hostTools.makeNativeGitBackend ?? (() => refuse('makeNativeGitBackend')),
    makeHostSpawner:
      hostTools.makeHostSpawner ?? (() => refuse('makeHostSpawner')),
    makeSandboxFactory:
      hostTools.makeSandboxFactory ?? (() => refuse('makeSandboxFactory')),
    makeMountProjector:
      hostTools.makeMountProjector ?? (() => refuse('makeMountProjector')),
  });
harden(provideHostToolPowers);
