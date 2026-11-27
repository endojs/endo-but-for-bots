// @ts-check
/**
 * The subscription sign-in gateway extension: the extras service
 * `subscriptionSignIn` (`AH/subscriptions/sign-in-service.js`), so a
 * signed-in page can add a Claude or ChatGPT account, or sign a member in
 * again, with no terminal. Only signed-in pages receive extras
 * (`GatewayPowers.extras`), so only the operator the gateway serves can
 * start or finish a sign-in; nothing here adds an HTTP route.
 *
 * The provider's tokens are exchanged and written in this process (the
 * agent-host adapter, which owns the Secrets store) and never sent to the
 * page or the hub (D-6). The service and every `PendingSignIn` it answers
 * are gateway objects that never leave toward a vat (`markNeverLeaves`).
 *
 * The context carries `signInPowers` (`AH/index.js` lists this module's
 * `gatewayExtension` object in the gateway's `extensionPowers`): the
 * adapter's `Accounts`, the member accessor of the subscriptions and the
 * adapter's `fetch`. A context without them (an older `AH/index.js`) makes
 * `make` throw, which the loader logs and skips.
 *
 * The page calls with positional arguments (strings and presences): no
 * record keys pass the gateway's key guard, so no vocabulary table changes.
 *
 * Synchronous (no top-level await), as M3's loader asks.
 */
import { E } from '@endo/far';

import { makeSubscriptionSignIn } from '../../subscriptions/sign-in-service.js';
import { markNeverLeaves } from '../powers.js';
import { subscriptionSignInLabel } from '../protocol.js';

/** @import { GatewayContext } from '../protocol.js' */

/** The page's label of the `SubscriptionSignIn` service. */
export const SIGN_IN_LABEL = subscriptionSignInLabel;

/**
 * @param {GatewayContext} context
 */
const makeService = context => {
  const powers = context.signInPowers;
  if (powers === undefined) throw Error('no sign-in powers on this context');
  const service = makeSubscriptionSignIn({
    secretsAdmin: async () => {
      const operator = context.operator?.();
      return operator === undefined ? undefined : E(operator).getSecrets();
    },
    secretWriter: () => context.secretWriter(),
    accounts: powers.accounts,
    memberAccess: powers.memberAccess,
    ...(powers.fetch === undefined ? {} : { fetch: powers.fetch }),
    log: context.log,
    markLocal: markNeverLeaves,
  });
  markNeverLeaves(service);
  return service;
};

/** @type {import('../protocol.js').GatewayExtension} */
export const gatewayExtension = harden({
  name: 'subscription-signin',
  services: [{ label: SIGN_IN_LABEL, make: makeService }],
});
