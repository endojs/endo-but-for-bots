// @ts-check

/**
 * The Node implementations of the host tool powers, for every
 * supervisor that runs in a Node process (the classic daemon, the bus
 * daemon, and the Go supervisor).  The XS supervisor supplies none,
 * and `provideHostToolPowers` in `host-tool-powers.js` fills in
 * stand-ins that refuse.
 *
 * Only this module and the Node powers factories that call it import
 * `@endo/git` and `@endo/host-spawner`, which keeps their `node:`
 * builtins off the XS daemon bundle's compartment graph.
 */

import { makeNodeFsMounter } from '@endo/9p-server/mount-caplet.js';
import { makeMountProjector } from '@endo/9p-server/mount-projection.js';
import { gitClone, makeNativeGitBackend } from '@endo/git';
import { makeHostSpawner } from '@endo/host-spawner';
import { make as makeSandboxFactory } from '@endo/sandbox';

/** @import { HostToolPowers } from './types.js' */

/**
 * Build the 9P mount projector the `sandbox` formula resolves its
 * granted mounts through.
 *
 * The mounter is per-projector rather than daemon-wide so that a
 * cancelled sandbox tears down exactly its own kernel mounts: the
 * mounter unmounts everything it minted when its `cancelled` promise
 * settles.  `mount(2)` needs `CAP_SYS_ADMIN`, so on an unprivileged
 * daemon the 9P branch fails and only physically-backed mounts project
 * — which is the common case, since every mount the daemon mints over a
 * real directory takes the physical path.
 *
 * @param {{
 *   env?: Record<string, string>,
 *   cancelled?: Promise<never> | null,
 *   resolveHostPath?: (cap: unknown) => Promise<string | undefined>,
 * }} options
 */
const makeNodeMountProjector = ({
  env = {},
  cancelled = null,
  resolveHostPath,
}) =>
  makeMountProjector({
    mounter: makeNodeFsMounter({ env, cancelledP: cancelled }),
    ...(resolveHostPath !== undefined ? { resolveHostPath } : {}),
  });

/**
 * @returns {HostToolPowers}
 */
export const makeNodeHostToolPowers = () =>
  harden({
    gitClone,
    makeNativeGitBackend,
    makeHostSpawner,
    makeSandboxFactory,
    makeMountProjector: makeNodeMountProjector,
  });
harden(makeNodeHostToolPowers);
