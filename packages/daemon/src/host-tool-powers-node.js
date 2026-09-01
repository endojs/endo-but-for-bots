// @ts-check
/* global process */

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
 * The 9P mount projector the `sandbox` formula resolves its mounts through.
 * Per-projector, not daemon-wide, so a cancelled sandbox unmounts exactly
 * its own; `mount(2)` needs `CAP_SYS_ADMIN`, so an unprivileged daemon can
 * only project mounts eligible for a direct bind.
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
    getEnvironment: () =>
      harden({ .../** @type {Record<string, string>} */ (process.env) }),
    gitClone,
    makeNativeGitBackend,
    makeHostSpawner,
    makeSandboxFactory,
    makeMountProjector: makeNodeMountProjector,
  });
harden(makeNodeHostToolPowers);
