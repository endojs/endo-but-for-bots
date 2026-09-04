// @ts-check

/**
 * Structured error factories for package-registry trees and the deprecated
 * EndoRegistry compatibility surface.
 *
 * The legacy four classes come from `designs/registry-capability.md`. The
 * tree-originated not-found, path-syntax, and offline failures additionally
 * share the `PackageRegistryError` discriminant from
 * `designs/npm-registry-as-directory-tree.md` while retaining distinct native
 * constructors and concrete names.
 *
 * Eviction-driven re-fetch that succeeds is silent; an eviction-driven
 * re-fetch that fails surfaces as `RegistryNetworkError` or
 * `RegistryOfflineError` per the existing classification (see the
 * design's Failure surface refinements section).
 */

import { makeError, q, X } from '@endo/errors';

const TAMPERED = 'RegistryTamperedError';
const MISSING = 'RegistryMissingPackageError';
const NETWORK = 'RegistryNetworkError';
const OFFLINE = 'RegistryOfflineError';

// Every structured registry error carries its classification through
// `makeError`'s `errorName` option, which SES records out-of-band via
// `tagError` — it is NOT installed as an own property, so the error stays
// passable (an own property outside `{message, stack, cause, errors}` makes an
// error non-passable, enumerable or not — `packages/pass-style/src/error.js`).
// The native constructor (`RangeError`/`SyntaxError`) is preserved via
// `makeError`'s second argument, and `registryErrorName`'s message-prefix
// fallback recovers the concrete name across a marshal boundary, where the tag
// does not travel.

/**
 * A registry path names no published node.
 * @param {string} path
 */
export const RegistryNotFoundError = path =>
  // `q(path)` keeps the offending path in the message under a default
  // `lockdown()`, where a bare `${path}` substitution is redacted to
  // `(a string)`.
  makeError(X`Package registry has no entry at ${q(path)}`, RangeError, {
    errorName: 'RegistryNotFoundError',
  });
harden(RegistryNotFoundError);

/**
 * A slash-bearing segment is not npm's one accepted scoped-name spelling.
 * @param {string} segment
 */
export const RegistryPathSyntaxError = segment =>
  makeError(
    X`Invalid package-registry path segment ${q(segment)}; use @scope/package or a string-array path`,
    SyntaxError,
    { errorName: 'RegistryPathSyntaxError' },
  );
harden(RegistryPathSyntaxError);

/**
 * The fetched tarball's hash did not match the upstream registry's
 * `dist.integrity`.
 *
 * The two-argument shape `RegistryTamperedError(name, version,
 * expectedIntegrity, actualHash)` and the one-argument shape
 * `RegistryTamperedError(reason)` both produce an error tagged
 * `TAMPERED`. Layer 2 callers that surface tampering via the
 * resolution walk use the reason shape; the integrity-check helper
 * uses the structured shape.
 *
 * @param {string} nameOrReason
 * @param {string} [version]
 * @param {string} [expectedIntegrity]
 * @param {string} [actualHash]
 * @returns {Error}
 */
export const RegistryTamperedError = (
  nameOrReason,
  version,
  expectedIntegrity,
  actualHash,
) => {
  if (version === undefined) {
    return makeError(
      X`Registry contents tampered: ${q(nameOrReason)}`,
      undefined,
      { errorName: TAMPERED },
    );
  }
  return makeError(
    X`Registry contents for ${q(nameOrReason)}@${q(version)} failed integrity check (expected ${q(expectedIntegrity)}, got ${q(actualHash)})`,
    undefined,
    { errorName: TAMPERED },
  );
};
harden(RegistryTamperedError);

/**
 * A `(name, version)` pair in the resolver's transitive closure was
 * not found on the configured registry.
 *
 * Two shapes: `RegistryMissingPackageError(name, version)` for the
 * canonical missing-pair case, and `RegistryMissingPackageError(reason)`
 * for arbitrary missing-package surfaces the MVS walk raises
 * (unsatisfied range, unmet peer, workspace miss).
 *
 * @param {string} nameOrReason
 * @param {string} [version]
 * @returns {Error}
 */
export const RegistryMissingPackageError = (nameOrReason, version) => {
  if (version === undefined) {
    return makeError(
      X`Registry missing package: ${q(nameOrReason)}`,
      undefined,
      {
        errorName: MISSING,
      },
    );
  }
  return makeError(
    X`Registry has no package ${q(nameOrReason)}@${q(version)}`,
    undefined,
    {
      errorName: MISSING,
    },
  );
};
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
  makeError(X`Registry network error: ${q(reason)}`, undefined, {
    errorName: NETWORK,
    cause,
  });
harden(RegistryNetworkError);

/**
 * `options.offline` was set and the resolution touched a package not
 * yet in the table. The caller asked the registry to fail rather than
 * reach for the network and the registry honored that ask.
 *
 * Two shapes: `RegistryOfflineError(name, version)` for the canonical
 * cache-miss case, and `RegistryOfflineError(reason)` for arbitrary
 * offline failure surfaces.
 *
 * @param {string} nameOrReason
 * @param {string} [version]
 * @returns {Error}
 */
export const RegistryOfflineError = (nameOrReason, version) =>
  // `q(...)` keeps the name/version visible under a default `lockdown()`, where
  // a bare `${nameOrReason}` substitution is redacted to `(a string)`. Passing
  // `errorName` restores the passable, `tagError`-classified shape this
  // pre-existing factory carried before the tree errors were added.
  version === undefined
    ? makeError(X`Registry is offline: ${q(nameOrReason)}`, undefined, {
        errorName: OFFLINE,
      })
    : makeError(
        X`Registry is in offline mode and ${q(nameOrReason)}@${q(version)} is not cached`,
        undefined,
        { errorName: OFFLINE },
      );
harden(RegistryOfflineError);

/**
 * Whether an error belongs to the directory-tree registry contract family.
 * @param {unknown} error
 */
export const isPackageRegistryError = error => {
  // Classify through `registryErrorName` (which recovers the concrete name from
  // the message when the out-of-band `tagError` classification does not travel
  // a marshal boundary) so the family predicate holds for an error received
  // over CapTP as well as one caught same-vat. The tree family is exactly
  // {NotFound, PathSyntax, Offline}.
  const concreteName = registryErrorName(error);
  return (
    concreteName === 'RegistryNotFoundError' ||
    concreteName === 'RegistryPathSyntaxError' ||
    concreteName === OFFLINE
  );
};
harden(isPackageRegistryError);

/**
 * Tag interrogation: returns the registry error class of `err`, or
 * undefined if it is not a registry error.
 *
 * `makeError` records the supplied `errorName` out-of-band via `tagError`
 * (not as an own property, which would make the error non-passable) and the
 * runtime error's `name` property still reflects its constructor (`Error`,
 * `RangeError`, etc.).  This helper probes any own classification property a
 * sibling factory may set (e.g. the daemon's `.name`-tagged errors) and falls
 * back to the message-prefix check, which is the channel that survives a
 * marshal boundary and the path every registry error takes.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const registryErrorName = err => {
  if (err === null || typeof err !== 'object') return undefined;
  // Registry errors carry their class in the message (below); these own-property
  // probes only catch a sibling factory that tags via `.name`/`.errorName`.
  const candidates = [
    /** @type {{ registryErrorName?: unknown }} */ (err).registryErrorName,
    /** @type {{ errorName?: unknown }} */ (err).errorName,
    /** @type {{ name?: unknown }} */ (err).name,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      (candidate === TAMPERED ||
        candidate === MISSING ||
        candidate === NETWORK ||
        candidate === OFFLINE ||
        candidate === 'RegistryNotFoundError' ||
        candidate === 'RegistryPathSyntaxError')
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
  if (message.startsWith('Registry contents tampered')) return TAMPERED;
  if (message.startsWith('Registry has no package')) return MISSING;
  if (message.startsWith('Registry missing package')) return MISSING;
  if (message.startsWith('Registry network error')) return NETWORK;
  if (message.startsWith('Registry is in offline mode')) return OFFLINE;
  if (message.startsWith('Registry is offline')) return OFFLINE;
  // The tree-originated not-found and path-syntax errors carry their `errorName`
  // as an out-of-band `tagError` classification same-vat, but that does not
  // travel a marshal boundary; the message is the surviving channel.
  if (message.startsWith('Package registry has no entry at'))
    return 'RegistryNotFoundError';
  if (message.startsWith('Invalid package-registry path segment'))
    return 'RegistryPathSyntaxError';
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
