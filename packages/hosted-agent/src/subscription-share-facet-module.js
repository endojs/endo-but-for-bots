// @ts-check

import { E } from '@endo/eventual-send';

/**
 * A share, as the formula that is handed out. Its powers are the share's kit
 * (`subscription-share-module.js`) and its value is only the kit's `share()`:
 * a `Subscription` within the grantor's limits. The name a grantor sends to a
 * peer is this one's, so the peer can store it, and it revives with the
 * daemon, with no path to the kit, its revocation, or what is beneath.
 *
 * @param {import('@endo/eventual-send').ERef<{ share(): unknown }>} kit
 */
export const make = kit => E(kit).share();
harden(make);
