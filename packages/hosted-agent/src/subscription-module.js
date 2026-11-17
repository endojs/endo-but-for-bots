// @ts-check

import { E } from '@endo/eventual-send';

/**
 * A provider broker as a `Subscription`, as a formula of its own
 * (`broker-subscription.js`), for the same reason the account source is one:
 * a share needs to open endpoints on the broker and nothing else the broker
 * service can do, so a share's namespace holds this and never the service.
 *
 * This is the operator's subscription whole and unmetered. It is bound under
 * the adapter's directory and given to shares' namespaces only; what is
 * handed to anybody else is a share.
 *
 * Setup mints it again over the broker that exists now on every run and
 * re-points each share's `subscription` name at it.
 *
 * @param {import('@endo/eventual-send').ERef<{ subscription(): unknown }>} broker
 */
export const make = broker => E(broker).subscription();
harden(make);
