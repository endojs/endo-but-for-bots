// @ts-check

/**
 * `@endo/confined-fetch` entry point: `make(powers, context, { env })` builds
 * a `ConfinedFetchService` over the endowed `fetch`, `timer`, and
 * `fetch-store` powers and the optional `fetch-policy-authority`. Revival
 * requires the integration to restore all three required powers. The README
 * covers provisioning, `env` initials, and the `@pins` revival recipe.
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
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Error(`@endo/confined-fetch: env.${name} must be a positive integer`);
  }
  return parsed;
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
  // Only absence degrades; a failing lookup of a granted power rejects.
  const granted = await E(powers).has(name);
  if (!granted) {
    return undefined;
  }
  return E(powers).lookup(name);
};

/**
 * Confined-caplet entry point. Builds the service over the endowed base `Fetch`
 * and the private VFS store, reconstitutes persisted policy and pins, and
 * returns the `ConfinedFetchService` exo.
 *
 * @param {any} powers - agent-shaped powers granted at provisioning.
 * @param {any} [_context] - caplet lifecycle context.
 * @param {{ env?: Record<string, string> }} [options] - `env` carries
 *   first-run policy initials.
 * @returns {Promise<ConfinedFetchServiceExo>}
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  const base = await E(powers).lookup('fetch');
  const storeDirectory = await E(powers).lookup('fetch-store');
  const timer = await E(powers).lookup('timer');
  const policyAuthority = await lookupOptional(
    powers,
    'fetch-policy-authority',
  );
  // A confined compartment has no `Math.random`. The store serializes its
  // writes, so a per-incarnation counter keeps temporary names distinct, and a
  // name left behind by a crash is simply overwritten.
  let temporaryCounter = 0;
  const makeTemporaryIdentifier = async () => {
    temporaryCounter += 1;
    return `${temporaryCounter}`;
  };
  const store = await makeFetchStore(storeDirectory, makeTemporaryIdentifier);

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
    delay: (milliseconds, cancelled) =>
      E(timer)
        .delay(milliseconds, cancelled)
        .then(() => undefined),
    now: () => E(timer).now(),
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
