// @ts-check

/**
 * Validation for the policy baked into an `http-client` formula.
 *
 * Kept apart from the daemon core so a caller that needs only to validate a
 * policy can import it without the rest of `host.js`: the code-mode
 * provisioning path validates its `http` grant here rather than restating
 * allowlist and bounds rules that would then be free to drift.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

const HTTP_CLIENT_POLICY_MODES = harden(['strict', 'tofu-auto']);
const HTTP_ORIGIN_SCHEMES = harden(['http:', 'https:']);

/**
 * Pin an allowlist entry to the exact origin shape the `HttpClient` exo accepts
 * (`@endo/http-confine`'s `parseAllowedOrigins`): a well-formed `http:`/`https:`
 * URL whose serialized origin (scheme://host[:port], default ports normalized
 * away) equals the entry verbatim — no path, query, or fragment.  Mirrored here
 * so `provideHttpClient` rejects a path-bearing or off-scheme origin up front
 * rather than persisting a formula the exo will reject on every incarnation.
 *
 * @param {string} origin
 */
const assertHttpClientOrigin = origin => {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw makeError(
      X`provideHttpClient: policy.allowedOrigins entry ${q(
        origin,
      )} must be a valid http(s) origin`,
    );
  }
  if (
    !HTTP_ORIGIN_SCHEMES.includes(parsed.protocol) ||
    parsed.origin !== origin
  ) {
    throw makeError(
      X`provideHttpClient: policy.allowedOrigins entry ${q(
        origin,
      )} must be exactly an http(s) origin (scheme://host[:port], no path, query, or fragment)`,
    );
  }
};

/**
 * Validate and normalize a caller-supplied HTTP-client policy into the frozen
 * record baked into the `http-client` formula at `provideHttpClient` time
 * (formula-owned, like `GitRemote`'s endpoint policy), so the capability
 * reconstitutes across daemon restart with identical bounds.  Rejects a
 * malformed policy up front — including a path-bearing origin or an unsafe
 * integer limit the exo would reject at incarnation — so a doomed formula is
 * never persisted.
 *
 * `policyMode` is restricted to the modes a formula-owned policy can honor on
 * its own across a restart: `strict` (only the static allowlist is reachable)
 * and `tofu-auto` (trust-on-first-bind auto-pinning).  The `tofu-prompt` /
 * `tofu-attenuator` modes require a live `policyAuthority` capability that this
 * phase does not wire into the formula, so they are refused rather than
 * silently degraded.
 *
 * @param {unknown} policy
 * @returns {import('./types.js').HttpClientPolicy}
 */
export const normalizeHttpClientPolicy = policy => {
  if (!policy || typeof policy !== 'object') {
    throw makeError(X`provideHttpClient: policy must be an object`);
  }
  const { allowedOrigins, maxRequestsPerMinute, maxResponseBytes, policyMode } =
    /** @type {Record<string, unknown>} */ (policy);

  /** @type {string[]} */
  let normalizedOrigins = [];
  if (allowedOrigins !== undefined) {
    if (
      !Array.isArray(allowedOrigins) ||
      !allowedOrigins.every(o => typeof o === 'string' && o.length > 0)
    ) {
      throw makeError(
        X`provideHttpClient: policy.allowedOrigins must be an array of non-empty origin strings`,
      );
    }
    for (const origin of allowedOrigins) {
      assertHttpClientOrigin(origin);
    }
    normalizedOrigins = [...allowedOrigins];
  }

  // Default to the exo's own defaults (60 / 1 MiB) when unspecified, but bake an
  // explicit number so the formula record is self-describing across a restart.
  const normalizedMaxRequestsPerMinute =
    maxRequestsPerMinute === undefined ? 60 : maxRequestsPerMinute;
  if (
    !Number.isSafeInteger(normalizedMaxRequestsPerMinute) ||
    /** @type {number} */ (normalizedMaxRequestsPerMinute) <= 0
  ) {
    throw makeError(
      X`provideHttpClient: policy.maxRequestsPerMinute must be a positive safe integer`,
    );
  }

  const normalizedMaxResponseBytes =
    maxResponseBytes === undefined ? 1024 * 1024 : maxResponseBytes;
  if (
    !Number.isSafeInteger(normalizedMaxResponseBytes) ||
    /** @type {number} */ (normalizedMaxResponseBytes) <= 0
  ) {
    throw makeError(
      X`provideHttpClient: policy.maxResponseBytes must be a positive safe integer`,
    );
  }

  const normalizedPolicyMode = policyMode === undefined ? 'strict' : policyMode;
  if (
    typeof normalizedPolicyMode !== 'string' ||
    !HTTP_CLIENT_POLICY_MODES.includes(normalizedPolicyMode)
  ) {
    throw makeError(
      X`provideHttpClient: policy.policyMode must be one of ${q(
        HTTP_CLIENT_POLICY_MODES,
      )}`,
    );
  }

  return harden({
    allowedOrigins: harden(normalizedOrigins),
    maxRequestsPerMinute: /** @type {number} */ (
      normalizedMaxRequestsPerMinute
    ),
    maxResponseBytes: /** @type {number} */ (normalizedMaxResponseBytes),
    policyMode: /** @type {import('./types.js').HttpClientPolicyMode} */ (
      normalizedPolicyMode
    ),
  });
};
harden(normalizeHttpClientPolicy);
