// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { makeError, q, X } from '@endo/errors';

import { HttpClientInterface, HttpControllerInterface } from './interfaces.js';

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
 * Phase 1 of the cli-http-client design lands the controller's inspect
 * surface only; subsequent phases will add mutators (`addAllowedOrigin`,
 * `setMaxRequestsPerMinute`, etc.) and the `revoke()` knob.
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
 * Build a client exo that fetches against an immutable allowlist.
 *
 * The client's `request()` method delegates the policy check to a
 * controller (passed in as a remotable ERef).  In Phase 1 the controller
 * is the local exo built by `makeHttpController`; in later phases the
 * controller may live on another node or be replaced behind the same
 * exo identity by `revoke()`.
 *
 * @param {ERef<{ inspect(): Promise<{ readonly allowedOrigins: readonly string[] }> }>} controllerRef
 * @param {HttpClientPowers} powers
 */
export const makeHttpClient = (controllerRef, powers) => {
  const { fetch } = powers;
  if (typeof fetch !== 'function') {
    throw makeError(
      X`http-client requires a fetch power; got ${q(typeof fetch)}`,
    );
  }

  /** @param {string} requestUrl */
  const assertOriginAllowed = async requestUrl => {
    let requestOrigin;
    try {
      requestOrigin = new URL(requestUrl).origin;
    } catch (cause) {
      throw makeError(
        X`Request URL does not parse: ${q(requestUrl)} (${q(
          /** @type {Error} */ (cause).message,
        )})`,
      );
    }
    const { allowedOrigins } = await E(controllerRef).inspect();
    if (!allowedOrigins.includes(requestOrigin)) {
      throw makeError(
        X`Request to ${q(requestOrigin)} is not in the allowlist (allowed: ${q(
          allowedOrigins.join(', '),
        )})`,
      );
    }
  };

  return makeExo('EndoHttpClient', HttpClientInterface, {
    async request(req) {
      const { url: requestUrl, method = 'GET', headers } = req;
      await assertOriginAllowed(requestUrl);
      const response = await fetch(requestUrl, {
        method,
        headers,
        // Phase 1 bounds the surface to GET-class verbs: redirect: 'manual'
        // and no body field.  Body and method allowlisting beyond GET land
        // in Phase 4 per the cli-http-client design's Status section.
        redirect: 'manual',
      });
      const responseHeaders = {};
      for (const [name, value] of response.headers.entries()) {
        responseHeaders[name] = value;
      }
      const text = await response.text();
      return harden({
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: harden(responseHeaders),
        body: text,
      });
    },
    async allowedOrigins() {
      const { allowedOrigins } = await E(controllerRef).inspect();
      return harden([...allowedOrigins]);
    },
    help(methodName) {
      if (methodName === 'request') {
        return 'request({ url, method?, headers? }) -> Promise<Response>\nFetch against the controller-bound allowlist.\nPhase 1: GET-class verbs only; bodies and streaming arrive in later phases.';
      }
      if (methodName === 'allowedOrigins') {
        return 'allowedOrigins() -> Promise<string[]>\nReturn the live allowlist as read through the controller.';
      }
      return 'EndoHttpClient - use-the-policy authority paired with an EndoHttpController.\nPhase 1 surface: request(), allowedOrigins().';
    },
  });
};
harden(makeHttpClient);
