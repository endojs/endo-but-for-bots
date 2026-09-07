// @ts-check

import { E } from '@endo/eventual-send';

/**
 * Give the attenuated Git facet its own formula so it can be stored in the
 * participants' pet stores and reconstructed after daemon restart.
 * @param {any} powers - Git capability for the implementation worktree
 */
export const make = async powers => E(powers).readOnly();
harden(make);
