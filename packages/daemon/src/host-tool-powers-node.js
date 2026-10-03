// @ts-check

/**
 * The Node implementations of the host tool powers, for every
 * supervisor that runs in a Node process (the classic daemon, the bus
 * daemon, and the Go supervisor).  The XS supervisor supplies none,
 * and `provideHostToolPowers` in `host-tool-powers.js` fills in
 * stand-ins that refuse.
 *
 * Only this module and the Node powers factories that call it import
 * `@endo/git`, `@endo/host-spawner`, and (through
 * `capture-node-modules.js`) `@endo/compartment-mapper`, which keeps
 * them off the XS daemon bundle's compartment graph.
 */

import { gitClone, makeNativeGitBackend } from '@endo/git';
import { makeHostSpawner } from '@endo/host-spawner';

import { captureNodeModulesArchive } from './capture-node-modules.js';

/** @import { HostToolPowers } from './types.js' */

/**
 * @returns {HostToolPowers}
 */
export const makeNodeHostToolPowers = () =>
  harden({
    gitClone,
    makeNativeGitBackend,
    makeHostSpawner,
    captureNodeModulesArchive,
  });
harden(makeNodeHostToolPowers);
