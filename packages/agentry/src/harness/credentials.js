// @ts-check
/// <reference types="ses"/>

/** @import { Credentials, GetApiKey } from './types.js' */

// TODO(secure): the credentials provider built below reads whatever record it
// is handed. The default record is the ambient process environment, which is
// not a capability-scoped secret store. Swap the env-backed provider for one
// at construction time: every caller resolves secrets through `.get()`, so the
// swap is local to this module — a powered stage can inject a different
// `Credentials` provider without touching call sites.

/**
 * Read the ambient process environment as a plain record. This is the
 * **fallback** secret source for callers that do not supply their API keys via
 * a better path (a swapped `Credentials` provider injected at construction
 * time); it reaches for `globalThis.process.env` and hands the result to
 * {@link makeEnvCredentials}, keeping the env dependency isolated to one seam.
 *
 * @returns {Record<string, string | undefined>}
 */
export const getAmbientEnv = () =>
  /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    globalThis
  ).process?.env || {};
harden(getAmbientEnv);

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
const nonEmptyString = value =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Build an environment-backed credentials provider — the harness's one choke
 * point for reading secrets. `get(name)` resolves a key out of the supplied
 * `env`; a non-string or empty value reads as `undefined`. The default record
 * is no longer ambient: a caller wanting the process environment passes
 * `getAmbientEnv()` explicitly, so the env dependency is visible at every call
 * site rather than hidden in a default argument.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Credentials}
 */
export const makeEnvCredentials = env =>
  harden({
    get: name => nonEmptyString(env[name]),
  });
harden(makeEnvCredentials);

/**
 * Adapt a `Credentials` seam into a pi-agent-core `getApiKey` hook: the thin
 * adaptor that makes `getApiKey` a view over the one secret seam rather than an
 * ad-hoc reach into ambient env. Resolves `<PROVIDER>_API_KEY` for the given
 * provider through `credentials.get`.
 *
 * @param {Credentials} credentials
 * @returns {GetApiKey}
 */
export const makeApiKeyGetter = credentials => provider =>
  credentials.get(`${provider.toUpperCase()}_API_KEY`);
harden(makeApiKeyGetter);
