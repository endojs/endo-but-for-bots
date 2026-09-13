// @ts-check

import { makeProviderScopes } from '@endo/hosted-agent/provider-scopes.js';

import { makeOpencodeBrokerKit } from './opencode-broker.js';

/**
 * Retain one operator broker before exposing inert per-session scope facets.
 * All scopes share its issuer, runtime, account policy, and configured limits.
 * The service accepts only approved copy specifications; session controllers
 * receive no secret, operator shutdown, or daemon namespace lookup authority.
 *
 * This local kit must remain owned through failed cleanup. A future daemon
 * entrypoint must retain it across context cancellation, and retain the supplied
 * secret as an exact durable dependency of the operator service formula. Never
 * look up a mutable secret name at session startup or compose this per session.
 * There is deliberately no result-only asynchronous constructor here.
 *
 * close() immediately fences both the scopes and the underlying broker. It
 * reaches cancellation-dependent runtime opening without waiting for scope
 * drain first, and succeeds only after both owners acknowledge release. Failed
 * stages remain retryable; successful stages are not repeated.
 *
 * Scope lookup recovers ownership only within this service incarnation. An
 * empty lookup after service loss does not prove earlier listeners stopped.
 * Existing provider-runtime PID recovery and Podman descendant uncertainty are
 * unchanged; this composition adds no native crash-recovery proof.
 *
 * @param {Parameters<typeof makeOpencodeBrokerKit>[0]} options
 */
export const makeOpencodeBrokerServiceKit = options => {
  const broker = makeOpencodeBrokerKit(options);
  const scopes = makeProviderScopes({
    openIssuer: async () => (await broker.start()).issuer,
  });
  let scopesReleased = false;
  let brokerReleased = false;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    if (closing) return closing;
    const closingScopes = (async () => {
      if (!scopesReleased) {
        await scopes.close();
        scopesReleased = true;
      }
    })();
    const closingBroker = (async () => {
      if (!brokerReleased) {
        await broker.close();
        brokerReleased = true;
      }
    })();
    closing = (async () => {
      const results = await Promise.allSettled([closingScopes, closingBroker]);
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw AggregateError(
          failures,
          'OpenCode broker service cleanup pending',
        );
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  return harden({ service: scopes.service, close });
};
harden(makeOpencodeBrokerServiceKit);
