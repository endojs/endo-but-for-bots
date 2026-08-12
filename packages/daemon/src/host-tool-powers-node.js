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

import { gitClone, makeNativeGitBackend } from '@endo/git';
import { makeHostSpawner } from '@endo/host-spawner';

/** @import { HostToolPowers } from './types.js' */

/**
 * @returns {HostToolPowers}
 */
export const makeNodeHostToolPowers = () =>
  harden({
    gitClone,
    makeNativeGitBackend,
    makeHostSpawner,
  });
harden(makeNodeHostToolPowers);
