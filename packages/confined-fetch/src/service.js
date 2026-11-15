// @ts-check

/**
 * The `@endo/confined-fetch` service core. It composes
 * `makeHttpClientAndControl` (`@endo/exo-http-client`) over a durable
 * virtual-file-system store into a `ConfinedFetchService` exo that hands out
 * the two facets, mirroring `ReminderService`:
 *
 * - `client()` - the guest-facing `HttpClient` facet, the only thing a confined
 *   agent ever holds. It can reach only allowlisted or pinned origins, under
 *   rate and byte caps, and never sees the service, the store, or the base.
 * - `control()` - the integration-facing `HttpClientControl` facet, retained by
 *   whoever provisioned the service.
 *
 * The `fetch` transport is required: `makeHttpClientAndControl` would otherwise
 * default to the ambient `globalThis.fetch`. The plugin (`./index.js`) builds
 * it from the endowed base; tests inject a fake. The durable store - not the
 * `env` initials - is authoritative across restarts: persisted policy and pins
 * are adopted when present, and every durable mutation (a control operation or
 * a request-time trust-on-first-bind pin) is written back through the
 * `onPolicyChange` seam, and a control mutation resolves only once its
 * snapshot is committed.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeHttpClientAndControl } from '@endo/exo-http-client';

/** @import { ConfinedFetchServicePowers, ConfinedFetchService } from './types.js' */
/** @import { PolicyMode, PolicySnapshot } from '@endo/exo-http-client' */

export const ConfinedFetchServiceInterface = M.interface(
  'ConfinedFetchService',
  {
    client: M.call().returns(M.remotable('HttpClient')),
    control: M.call().returns(M.remotable('HttpClientControl')),
    help: M.call().returns(M.string()),
  },
);

const confinedFetchServiceHelp = [
  'ConfinedFetchService - a confined outbound-HTTP provider.',
  '',
  '  client()  -> HttpClient          (guest-facing)',
  '  control() -> HttpClientControl   (integration-facing)',
].join('\n');

/**
 * Create a fetch service capability pair over a durable store. Returns
 * `{ service, client, control }`: `service` is the exo the plugin returns (it
 * hands out the two facets), `client` is the guest-facing `HttpClient`, and
 * `control` is the integration-facing `HttpClientControl`.
 *
 * @param {ConfinedFetchServicePowers} powers
 * @returns {Promise<ConfinedFetchService>}
 */
export const makeConfinedFetchService = async powers => {
  const {
    store,
    fetch,
    delay,
    now,
    allowedOrigins: envAllowedOrigins,
    maxRequestsPerMinute: envMaxRequestsPerMinute,
    maxResponseBytes: envMaxResponseBytes,
    policyMode: envPolicyMode,
    policyAuthority,
  } = powers;
  if (typeof fetch !== 'function') {
    throw TypeError(
      '@endo/confined-fetch: a fetch transport built from the endowed base is required',
    );
  }
  if (typeof delay !== 'function' || typeof now !== 'function') {
    throw TypeError(
      '@endo/confined-fetch: delay and now seams built from the endowed timer are required',
    );
  }

  // The durable store is authoritative across restarts; the env-supplied values
  // are only the initial policy at first provisioning. A snapshot that exists
  // but cannot be read rejects here, so revival fails closed instead of
  // reseeding from the env.
  const persisted = await store.readSnapshot();

  // Writes are serialized so overlapping mutations commit in order. Each
  // snapshot is captured synchronously at mutation time, so awaiting one write
  // also awaits every earlier one. A failed write rejects the caller's
  // persist, which the control facet surfaces to the controller; the chain
  // itself continues so a later snapshot can still commit.
  let writeChain = Promise.resolve();
  /** @param {PolicySnapshot} snapshot */
  const persist = snapshot => {
    const written = writeChain.then(() => store.writeSnapshot(snapshot));
    writeChain = written.catch(() => {});
    return written;
  };

  const initial =
    persisted === undefined
      ? {
          allowedOrigins: envAllowedOrigins || [],
          maxRequestsPerMinute: envMaxRequestsPerMinute,
          maxResponseBytes: envMaxResponseBytes,
          policyMode: envPolicyMode,
        }
      : persisted.policy;

  const { client, control } = makeHttpClientAndControl({
    fetch,
    delay,
    now,
    allowedOrigins: initial.allowedOrigins,
    ...(initial.maxRequestsPerMinute !== undefined
      ? { maxRequestsPerMinute: initial.maxRequestsPerMinute }
      : {}),
    ...(initial.maxResponseBytes !== undefined
      ? { maxResponseBytes: initial.maxResponseBytes }
      : {}),
    ...(initial.policyMode !== undefined
      ? { policyMode: initial.policyMode }
      : {}),
    ...(policyAuthority !== undefined ? { policyAuthority } : {}),
    ...(persisted !== undefined ? { initialBindings: persisted.bindings } : {}),
    onPolicyChange: persist,
  });

  if (persisted === undefined) {
    // Seed the store on first provisioning so it reflects the initial policy
    // from the outset. Thereafter the onPolicyChange seam keeps it current.
    const inspected = control.inspect();
    await persist(
      harden({
        policy: {
          allowedOrigins: [...inspected.allowedOrigins],
          maxRequestsPerMinute: inspected.maxRequestsPerMinute,
          maxResponseBytes: inspected.maxResponseBytes,
          // `inspect()` widens `policyMode` to `string`; it is one of the
          // `PolicyMode` literals by construction, so narrow it back.
          policyMode: /** @type {PolicyMode} */ (inspected.policyMode),
          revoked: inspected.revoked,
        },
        bindings: control.listBindings(),
      }),
    );
  } else if (persisted.policy.revoked) {
    // Revocation is durable and permanent: a service persisted as revoked
    // revives revoked.
    await control.revoke();
  }

  // The service exo hands out the two facets. It is what the plugin returns and
  // what an integration pins into `@pins` for wake-on-restart. There are no
  // live timers to tear down: the client is a stateless request/response
  // capability, so cancelling the caplet collapses the worker and with it the
  // guest's reference - no explicit cancellation revoke is needed (and one that
  // persisted `revoked` would wrongly revive the service revoked next boot).
  const service = makeExo(
    'ConfinedFetchService',
    ConfinedFetchServiceInterface,
    {
      client: () => client,
      control: () => control,
      help: () => confinedFetchServiceHelp,
    },
  );

  return harden({ service, client, control });
};
harden(makeConfinedFetchService);
