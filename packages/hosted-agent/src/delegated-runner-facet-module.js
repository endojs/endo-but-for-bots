// @ts-check

import { E } from '@endo/eventual-send';

/**
 * A delegated runner, as the formula that is handed out. Its powers are the
 * runner's kit (`delegated-runner-module.js`) and its value is only the kit's
 * `runner()`: a hosted backend factory within the operator's limits. The
 * name an operator sends to a peer is this one's, so the peer can store it
 * (and name it in `FLOOT_BACKEND_FACTORIES`), and it revives with the daemon,
 * with no path to the kit, its revocation, or the backend beneath.
 *
 * @param {import('@endo/eventual-send').ERef<{ runner(): unknown }>} kit
 */
export const make = kit => E(kit).runner();
harden(make);
