// @ts-check

/**
 * `@endo/confined-fetch` - the confined plugin that attenuates an endowed
 * `@endo/fetch` capability into a policy-bound `HttpClient`.
 *
 * The module exports the standard confined-caplet maker,
 * `make(powers, context, { env })`. It resolves everything it needs by name
 * through `powers` and has no route to the network except the endowed base:
 *
 * - `E(powers).lookup('fetch')` -> the unfettered `Fetch` capability of
 *   `@endo/fetch`, the only transport the client and control pair is built
 *   over. Without it, `make()` rejects.
 * - `E(powers).lookup('fetch-store')` -> a writable virtual-file-system
 *   directory private to this service, backing the durable policy store
 *   (`./store.js`).
 * - `E(powers).lookup('fetch-policy-authority')` (optional) -> the referral
 *   target for trust-on-first-bind decisions. Without it, the prompt modes are
 *   unavailable and unknown origins fail closed.
 *
 * Initial `allowedOrigins` (comma-separated), `maxRequestsPerMinute`,
 * `maxResponseBytes`, and `policyMode` arrive via `env` only on first
 * provisioning; thereafter the store is authoritative.
 *
 * Revival is integration-owned: the integration pins the service under
 * `@pins` and restores the same base and directory at boot, so `revivePins()`
 * re-incarnates it with identical policy and pins. See the README.
 */

import { E } from '@endo/eventual-send';
import { makeFetchStore } from './store.js';
import { makeConfinedFetchService } from './service.js';
import { makeTransportFromBase } from './transport.js';

/** @import { PolicyMode } from '@endo/exo-http-client' */
/** @import { ConfinedFetchServiceExo, ConfinedFetchServicePowers } from './types.js' */

/**
 * Parse a positive integer from a formula-env string, or `undefined` if the key
 * is absent. Throws on a present-but-invalid value so a misconfigured
 * provisioning fails loudly rather than silently defaulting.
 *
 * @param {string | undefined} value
 * @param {string} name
 * @returns {number | undefined}
 */
const parseOptionalPositiveInteger = (value, name) => {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw Error(`@endo/confined-fetch: env.${name} must be a positive integer`);
  }
  return n;
};

/**
 * Parse a comma-separated allowlist into an array of origins, or `undefined`
 * when the key is absent. Blank entries are dropped; validation of the origin
 * shape happens in `makeHttpClientAndControl`.
 *
 * @param {string | undefined} value
 * @returns {string[] | undefined}
 */
const parseOptionalOriginList = value => {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
};

/**
 * Resolve an optional power by name, returning `undefined` when it is absent
 * rather than throwing, so the plugin degrades to strict behavior when no
 * policy authority is granted.
 *
 * @param {any} powers
 * @param {string} name
 * @returns {Promise<any>}
 */
const lookupOptional = async (powers, name) => {
  await null;
  try {
    return await E(powers).lookup(name);
  } catch (_error) {
    return undefined;
  }
};

/**
 * Confined-caplet entry point. Builds the service over the endowed base `Fetch`
 * and the private VFS store, reconstitutes persisted policy and pins, and
 * returns the `ConfinedFetchService` exo.
 *
 * @param {any} powers - agent-shaped powers granted at provisioning.
 * @param {any} [_context] - caplet lifecycle context. Unused: the client is a
 *   stateless request/response capability with no live timers.
 * @param {{ env?: Record<string, string>, now?: () => number }} [options] -
 *   `env` carries first-run policy initials; `now` is a test seam.
 * @returns {Promise<ConfinedFetchServiceExo>}
 */
export const make = async (powers, _context, { env = {}, now } = {}) => {
  const base = await E(powers).lookup('fetch');
  const storeDirectory = await E(powers).lookup('fetch-store');
  const policyAuthority = await lookupOptional(
    powers,
    'fetch-policy-authority',
  );
  // A confined compartment has no `Math.random`. The store serializes its
  // writes, so a per-incarnation counter keeps temporary names distinct, and a
  // name left behind by a crash is simply overwritten.
  let temporaryCounter = 0;
  const makeTemporaryId = async () => {
    temporaryCounter += 1;
    return `${temporaryCounter}`;
  };
  const store = await makeFetchStore(storeDirectory, makeTemporaryId);

  const allowedOrigins = parseOptionalOriginList(env.allowedOrigins);
  const maxRequestsPerMinute = parseOptionalPositiveInteger(
    env.maxRequestsPerMinute,
    'maxRequestsPerMinute',
  );
  const maxResponseBytes = parseOptionalPositiveInteger(
    env.maxResponseBytes,
    'maxResponseBytes',
  );
  // `env.policyMode` is an unvalidated formula-env string; narrow it to the
  // `PolicyMode` union here (the pair validates the value at construction).
  const policyMode =
    env.policyMode === undefined
      ? undefined
      : /** @type {PolicyMode} */ (env.policyMode);

  /** @type {ConfinedFetchServicePowers} */
  const makeOptions = {
    store,
    fetch: makeTransportFromBase(base),
    ...(now !== undefined ? { now } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute } : {}),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(policyMode !== undefined ? { policyMode } : {}),
    ...(policyAuthority !== undefined ? { policyAuthority } : {}),
  };

  const { service } = await makeConfinedFetchService(makeOptions);

  return service;
};
harden(make);
