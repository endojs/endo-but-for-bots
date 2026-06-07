// @ts-check

/**
 * Structured error classes for the EndoRegistry capability.
 *
 * The four failure classes come from `designs/registry-capability.md`
 * § Failure surface. They are tagged via `@endo/errors`'s `errorName`
 * option so callers branch on the failure class without inspecting
 * message text, which is fragile across both the JS and the future
 * Rust-backed lanes.
 *
 * Eviction-driven re-fetch that succeeds is silent; an eviction-driven
 * re-fetch that fails surfaces as `RegistryNetworkError` or
 * `RegistryOfflineError` per the existing classification (see the
 * design's § Failure surface refinements).
 */

import { makeError, X } from '@endo/errors';

const TAMPERED = 'RegistryTamperedError';
const MISSING = 'RegistryMissingPackageError';
const NETWORK = 'RegistryNetworkError';
const OFFLINE = 'RegistryOfflineError';

/**
 * The fetched tarball's hash did not match the upstream registry's
 * `dist.integrity`.
 *
 * @param {string} name
 * @param {string} version
 * @param {string} expectedIntegrity
 * @param {string} actualHash
 * @returns {Error}
 */
export const RegistryTamperedError = (
  name,
  version,
  expectedIntegrity,
  actualHash,
) =>
  makeError(
    X`Registry contents for ${name}@${version} failed integrity check (expected ${expectedIntegrity}, got ${actualHash})`,
    undefined,
    { errorName: TAMPERED },
  );
harden(RegistryTamperedError);

/**
 * A `(name, version)` pair in the resolver's transitive closure was
 * not found on the configured registry.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Error}
 */
export const RegistryMissingPackageError = (name, version) =>
  makeError(X`Registry has no package ${name}@${version}`, undefined, {
    errorName: MISSING,
  });
harden(RegistryMissingPackageError);

/**
 * The bus call to the backend resolver failed in transit. Examples:
 * subsystem restart, bus disconnect, registry-host TCP error. A
 * mid-resolve restart or bus disconnect surfaces here; the caller
 * may retry.
 *
 * @param {string} reason
 * @param {Error} [cause]
 * @returns {Error}
 */
export const RegistryNetworkError = (reason, cause) =>
  makeError(X`Registry network error: ${reason}`, undefined, {
    errorName: NETWORK,
    cause,
  });
harden(RegistryNetworkError);

/**
 * `options.offline` was set and the resolution touched a package not
 * yet in the table. The caller asked the registry to fail rather than
 * reach for the network and the registry honored that ask.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Error}
 */
export const RegistryOfflineError = (name, version) =>
  makeError(
    X`Registry is in offline mode and ${name}@${version} is not cached`,
    undefined,
    { errorName: OFFLINE },
  );
harden(RegistryOfflineError);

/**
 * Tag interrogation: returns the registry error class of `err`, or
 * undefined if it is not a registry error.
 *
 * `makeError` records the supplied `errorName` on the SES `assert`
 * channel but the runtime error's `name` property still reflects its
 * constructor (`Error`, `URIError`, etc.).  This helper inspects the
 * `Symbol.for('asserted')`-style annotation that SES exposes through
 * the error's enumerable `errorName` property when present, and falls
 * back to a message-prefix check for environments that do not.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const registryErrorName = err => {
  if (err === null || typeof err !== 'object') return undefined;
  // SES annotates errors created via `makeError(_, _, { errorName })`
  // with an `errorName` property visible to assertion logs; the
  // runtime error's `.name` reflects the constructor.  We probe
  // multiple properties to stay resilient across SES versions.
  const candidates = [
    /** @type {{ errorName?: unknown }} */ (err).errorName,
    /** @type {{ name?: unknown }} */ (err).name,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      (candidate === TAMPERED ||
        candidate === MISSING ||
        candidate === NETWORK ||
        candidate === OFFLINE)
    ) {
      return candidate;
    }
  }
  // Fallback: inspect message for the tag prefix the makeError calls
  // above install. This keeps `isRegistryError` honest when SES does
  // not expose `errorName` on the error object itself (the assertion
  // log still carries it).  In the absence of the SES annotation,
  // this path is what every test exercises today; do not remove
  // without first confirming SES exposes `errorName` on the error.
  const message = /** @type {{ message?: unknown }} */ (err).message;
  if (typeof message !== 'string') return undefined;
  if (message.startsWith('Registry contents for')) return TAMPERED;
  if (message.startsWith('Registry has no package')) return MISSING;
  if (message.startsWith('Registry network error')) return NETWORK;
  if (message.startsWith('Registry is in offline mode')) return OFFLINE;
  return undefined;
};
harden(registryErrorName);

/**
 * Predicate version of `registryErrorName`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export const isRegistryError = err => registryErrorName(err) !== undefined;
harden(isRegistryError);
