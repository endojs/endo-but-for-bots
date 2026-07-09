// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { makeError, q, X } from '@endo/errors';
import { makeHttpClientAndControl } from '@endo/exo-http-client';

import { HttpClientInterface, HttpControllerInterface } from './interfaces.js';

// The confinement core (URL/scheme validation, origin allowlist enforcement,
// redirect defense, rate / byte / timeout guards) lives in
// `@endo/http-confine`, exposed as the `HttpClient` / `HttpClientControl`
// exo pair by `@endo/exo-http-client`'s `makeHttpClientAndControl` (PR #566).
// This daemon module is the *integration* layer only: it validates the
// allowlist at mint time, builds the confined client through the landed
// capability, and adapts its `fetch()` surface to the daemon-side
// `request({ url, method?, headers? })` shape that `designs/cli-http-client.md`
// specifies for guests. It no longer re-implements the confinement itself.

/**
 * Parse and normalise a single origin string.
 * Accepts only `http:` and `https:` URLs; the parsed `.origin` is the
 * canonical comparison key.  Throws a structured error otherwise so the
 * failure surfaces on the host's CLI invocation, not on a future guest
 * request.
 *
 * @param {string} entry
 * @returns {string}
 */
export const parseAllowedOrigin = entry => {
  if (typeof entry !== 'string') {
    throw makeError(X`Allowed origin must be a string, got ${q(typeof entry)}`);
  }
  let parsed;
  try {
    parsed = new URL(entry);
  } catch (cause) {
    throw makeError(
      X`Allowed origin does not parse as a URL: ${q(entry)} (${q(
        /** @type {Error} */ (cause).message,
      )})`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw makeError(
      X`Allowed origin must use http: or https:; got ${q(parsed.protocol)} in ${q(
        entry,
      )}`,
    );
  }
  return parsed.origin;
};
harden(parseAllowedOrigin);

/**
 * Parse and freeze a set of allowed origins.  Empty sets are rejected
 * because a controller that allows nothing is indistinguishable from a
 * revoked controller and the caller is almost certainly mistaken.
 *
 * This is the integration layer's mint-time gate: it rejects malformed or
 * empty allowlists on the host's CLI call rather than deferring the error
 * to the first guest request.  The runtime confinement is enforced
 * separately by `@endo/http-confine` inside the landed capability.
 *
 * @param {Iterable<string>} entries
 * @returns {readonly string[]}
 */
export const parseAllowedOrigins = entries => {
  const normalized = [];
  for (const entry of entries) {
    normalized.push(parseAllowedOrigin(entry));
  }
  if (normalized.length === 0) {
    throw makeError(
      X`At least one allowed origin is required to construct an HTTP client`,
    );
  }
  // Deduplicate while preserving insertion order so help() output is stable.
  const seen = new Set();
  const unique = [];
  for (const origin of normalized) {
    if (!seen.has(origin)) {
      seen.add(origin);
      unique.push(origin);
    }
  }
  return harden(unique);
};
harden(parseAllowedOrigins);

/**
 * Build a controller exo over an immutable allowlist.
 *
 * Phase 1 of the cli-http-client design lands the controller's `inspect`
 * surface only; subsequent phases route the landed `HttpClientControl`
 * mutators (`addAllowedOrigin`, `setMaxRequestsPerMinute`, `revoke`, …)
 * through this facet.  The host-retained controller is the policy of
 * record; the paired client (built by `makeHttpClient` from the same
 * allowlist) enforces it.
 *
 * @param {{ allowedOrigins: readonly string[] }} policy
 */
export const makeHttpController = policy => {
  const { allowedOrigins } = policy;

  return makeExo('EndoHttpController', HttpControllerInterface, {
    inspect() {
      return harden({ allowedOrigins: harden([...allowedOrigins]) });
    },
    help(methodName) {
      if (methodName === 'inspect') {
        return 'inspect() -> Promise<{ allowedOrigins: string[] }>\nReturn the policy this controller bears (Phase 1: allowed origin set only).';
      }
      return 'EndoHttpController - host-retained policy capability for an HTTP client.\nPhase 1 surface: inspect().\n  Mutators (allow/deny/set-rate/set-bytes/set-time) and revoke() arrive in later phases.';
    },
  });
};
harden(makeHttpController);

/**
 * @typedef {object} HttpClientPowers
 * @property {(input: string, init?: object) => Promise<Response>} fetch
 *   The platform fetch implementation; injected so tests can stub it.
 *   In production this is `globalThis.fetch`.
 */

/**
 * Build a daemon-side client exo that fetches against an immutable
 * allowlist, delegating all confinement to the landed
 * `@endo/exo-http-client` capability.
 *
 * The heavy lifting — URL parsing, origin/redirect confinement, rate and
 * byte caps, timeout composition — is performed by
 * `makeHttpClientAndControl` (PR #566).  This function constructs that
 * confined client over the host-curated allowlist and adapts its
 * `fetch(url, options)` surface (which returns an `HttpResponse` exo) to
 * the `request({ url, method?, headers? })` -> plain-record surface that
 * `designs/cli-http-client.md` specifies for daemon guests.
 *
 * @param {ERef<{ inspect(): Promise<{ readonly allowedOrigins: readonly string[] }> }>} controllerRef
 *   The paired controller; its `inspect()` is the source of the allowlist.
 * @param {HttpClientPowers} powers
 */
export const makeHttpClient = async (controllerRef, powers) => {
  const { fetch } = powers;
  if (typeof fetch !== 'function') {
    throw makeError(
      X`http-client requires a fetch power; got ${q(typeof fetch)}`,
    );
  }

  // Snapshot the allowlist from the paired controller at incarnation.
  // Phase 1's allowlist is immutable, so a snapshot suffices; later
  // phases will route controller mutations to the landed
  // `HttpClientControl` facet.
  const { allowedOrigins } = await E(controllerRef).inspect();

  // The landed capability owns confinement.  We only consume the client
  // facet; the control facet's mutators are wired to the controller in a
  // later phase.
  const { client } = makeHttpClientAndControl({
    allowedOrigins: harden([...allowedOrigins]),
    fetch: (input, init) => fetch(input, init),
  });

  return makeExo('EndoHttpClient', HttpClientInterface, {
    async request(req) {
      const { url: requestUrl, method = 'GET', headers } = req;
      // Phase 1 of the cli-http-client design admits GET-class verbs
      // only (GET, HEAD).  Methods beyond GET-class (POST, PUT, DELETE,
      // PATCH, etc.) land in Phase 4 alongside the request-body shape.
      // The landed capability accepts a wider method set, so pin the
      // Phase-1 read-only bound here at the integration layer, before
      // delegating to the confined client.
      if (method !== 'GET' && method !== 'HEAD') {
        throw makeError(
          X`Phase 1 http-client admits GET-class verbs only; got ${q(method)}`,
        );
      }
      const response = await E(client).fetch(requestUrl, {
        method,
        ...(headers === undefined ? {} : { headers }),
      });
      // Adapt the landed `HttpResponse` exo to the design's plain record.
      const [status, statusText, ok, responseHeaders, body] = await Promise.all(
        [
          E(response).status(),
          E(response).statusText(),
          E(response).ok(),
          E(response).headers(),
          E(response).text(),
        ],
      );
      return harden({
        status,
        statusText,
        ok,
        headers: harden({ ...responseHeaders }),
        body,
      });
    },
    async allowedOrigins() {
      await null;
      const origins = await E(client).allowedOrigins();
      return harden([...origins]);
    },
    help(methodName) {
      if (methodName === 'request') {
        return 'request({ url, method?, headers? }) -> Promise<Response>\nFetch against the controller-bound allowlist (confinement by @endo/http-confine).\nPhase 1: GET-class verbs only; bodies and streaming arrive in later phases.';
      }
      if (methodName === 'allowedOrigins') {
        return 'allowedOrigins() -> Promise<string[]>\nReturn the live allowlist enforced by the confined client.';
      }
      return 'EndoHttpClient - use-the-policy authority paired with an EndoHttpController.\nPhase 1 surface: request(), allowedOrigins().\nConfinement is delegated to @endo/exo-http-client.';
    },
  });
};
harden(makeHttpClient);
