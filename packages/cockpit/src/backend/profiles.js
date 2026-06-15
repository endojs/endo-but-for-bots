// @ts-check
//
// Provider profiles: (provider, apiKey, baseUrl) tuples the cockpit stores in
// the daemon's petstore under a `cockpit-profiles` directory, addressed by a
// profile name. A profile is the bridge between a code-mode model config and a
// real provider key: an agentry thread names a profile, and the engine resolves
// the key at make() time via `getProfile` (backend only — the key never leaves
// the host).
//
// SECURITY: `listProfiles` returns MASKED views ({ name, provider, baseUrl })
// only. The apiKey is never returned to callers or the UI. Only `getProfile`,
// used by the engine on the trusted backend, returns the key.

import { E } from '@endo/far';

const PROFILE_DIR = 'cockpit-profiles';
harden(PROFILE_DIR);

/**
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} provider
 * @property {string} apiKey
 * @property {string} [baseUrl]
 *
 * @typedef {object} MaskedProfile
 * @property {string} name
 * @property {string} provider
 * @property {string} [baseUrl]
 */

/**
 * The EndoHost subset profiles need: pet-name lookup, store, list, has, and
 * makeDirectory. `has`/`list` take rest path segments; `storeValue` and
 * `makeDirectory` take a name-or-path.
 *
 * @typedef {object} ProfileHost
 * @property {(...path: string[]) => Promise<boolean>} has
 * @property {(...path: string[]) => Promise<string[]>} list
 * @property {(value: unknown, petNameOrPath: string | string[]) => Promise<unknown>} storeValue
 * @property {(petNameOrPath: string | string[]) => Promise<unknown>} lookup
 * @property {(petNameOrPath: string | string[]) => Promise<unknown>} makeDirectory
 */

/**
 * Ensure the `cockpit-profiles` directory exists in the petstore. Idempotent.
 *
 * @param {ProfileHost} host
 * @returns {Promise<void>}
 */
export const ensureProfileDir = async host => {
  const exists = await E(host).has(PROFILE_DIR);
  if (!exists) {
    await E(host).makeDirectory(PROFILE_DIR);
  }
};
harden(ensureProfileDir);

/**
 * @param {string} name
 * @returns {string}
 */
const requireName = name => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('profile name must be a non-empty string');
  }
  return name;
};

/**
 * Define (or overwrite) a provider profile, stored at
 * `['cockpit-profiles', name]` in the petstore. The whole tuple — including the
 * apiKey — is stored; masking happens only on the read path (`listProfiles`).
 *
 * @param {ProfileHost} host
 * @param {Profile} profile
 * @returns {Promise<MaskedProfile>}
 */
export const defineProfile = async (
  host,
  { name, provider, apiKey, baseUrl },
) => {
  requireName(name);
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('profile provider must be a non-empty string');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('profile apiKey must be a non-empty string');
  }
  await ensureProfileDir(host);
  const tuple = harden({ name, provider, apiKey, baseUrl });
  await E(host).storeValue(tuple, [PROFILE_DIR, name]);
  return harden({ name, provider, baseUrl });
};
harden(defineProfile);

/**
 * Resolve the full profile tuple — INCLUDING the apiKey. Backend only; the
 * engine calls this at make() time to obtain the provider key. Never expose the
 * result over the wire.
 *
 * @param {ProfileHost} host
 * @param {string} name
 * @returns {Promise<Profile>}
 */
export const getProfile = async (host, name) => {
  requireName(name);
  const tuple = /** @type {Profile} */ (
    await E(host).lookup([PROFILE_DIR, name])
  );
  return tuple;
};
harden(getProfile);

/**
 * List the stored profiles as MASKED views: name, provider, and baseUrl only.
 * The apiKey is deliberately dropped — this is the surface the UI and the wire
 * protocol see.
 *
 * @param {ProfileHost} host
 * @returns {Promise<MaskedProfile[]>}
 */
export const listProfiles = async host => {
  const hasDir = await E(host).has(PROFILE_DIR);
  if (!hasDir) {
    return harden([]);
  }
  const names = await E(host).list(PROFILE_DIR);
  const tuples = await Promise.all(
    names.map(
      name =>
        /** @type {Promise<Profile>} */ (E(host).lookup([PROFILE_DIR, name])),
    ),
  );
  return harden(
    tuples.map(tuple =>
      harden({
        name: tuple.name,
        provider: tuple.provider,
        baseUrl: tuple.baseUrl,
      }),
    ),
  );
};
harden(listProfiles);

export { PROFILE_DIR };
