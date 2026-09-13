// @ts-check

import { makeOwnedNativeSandboxAgent } from './owned-agent.js';

// This host-only composition exposes scoped native path authority. Provision it
// as one stable operator formula; never hand the service to guest code.
export const make = makeOwnedNativeSandboxAgent();
harden(make);
