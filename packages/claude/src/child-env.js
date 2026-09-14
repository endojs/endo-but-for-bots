// @ts-check
//
// The child environment is a constructed allowlist, not the inherited env minus
// one variable (§ The child environment is a constructed allowlist).
//
// A denylist of one is unsafe for two reasons this must close:
//   - Under `--bare`, `ANTHROPIC_API_KEY` is an HONORED credential path. An
//     inherited key would silently authenticate the child OUTSIDE the pool,
//     bypassing `selectSubscription` and the whole subscription-pooling story.
//   - An inherited `ANTHROPIC_BASE_URL` (or the proxy variables) would redirect
//     inference off-target, to an endpoint the operator did not choose.
//
// So the child starts from an EMPTY base and receives only variables the harness
// explicitly sets. The daemon-socket variables (`ENDO_SOCK`, `XDG_RUNTIME_DIR`
// where it would re-derive the socket) are absent by construction, not scrubbed
// after the fact.

import { makeError, X, q } from '@endo/errors';

/**
 * The only environment variable names the constructed child env may carry. Every
 * one is set by the harness itself; nothing is copied from the parent.
 *
 *   PATH   — scoped to the shim / apiKeyHelper directory, not the harness's PATH.
 *   LANG / LC_ALL — a locale so `claude` renders deterministically.
 *   ENDO_CLAUDE_SESSION_TAG — the one-per-spawn tag, for the apiKeyHelper's fixed
 *                             inputs (never prompt- or guest-derived).
 */
export const ALLOWED_ENV_KEYS = harden([
  'PATH',
  'LANG',
  'LC_ALL',
  'ENDO_CLAUDE_SESSION_TAG',
]);

/**
 * Environment variables that MUST NOT reach the child even if a future edit
 * widens the allowlist by mistake. Kept as an explicit tripwire the assertion
 * below checks, so the pool-bypass and off-target-redirect cases fail loudly
 * rather than silently.
 */
export const FORBIDDEN_ENV_KEYS = harden([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'ENDO_SOCK',
  'XDG_RUNTIME_DIR',
]);

/**
 * @typedef {object} ChildEnvSpec
 * @property {string} pathValue   The PATH the child sees (scoped to the shim).
 * @property {string} sessionTag  The one-per-spawn session tag.
 * @property {string} [lang]      Locale (defaults to `C.UTF-8`).
 */

/**
 * Construct the child environment from an explicit allowlist plus an
 * otherwise-empty base. Does NOT read the parent environment.
 *
 * @param {ChildEnvSpec} spec
 * @returns {Readonly<Record<string, string>>}
 */
export const buildChildEnv = spec => {
  const { pathValue, sessionTag, lang = 'C.UTF-8' } = spec;
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw makeError(X`buildChildEnv: pathValue must be a non-empty string`);
  }
  if (typeof sessionTag !== 'string' || sessionTag.length === 0) {
    throw makeError(X`buildChildEnv: sessionTag must be a non-empty string`);
  }
  /** @type {Record<string, string>} */
  const env = Object.create(null);
  env.PATH = pathValue;
  env.LANG = lang;
  env.LC_ALL = lang;
  env.ENDO_CLAUDE_SESSION_TAG = sessionTag;
  const built = harden(env);
  // Peer of the argv invariant: assert before the child runs, not trusted to the
  // inherited process state.
  assertChildEnvAllowed(built);
  return built;
};
harden(buildChildEnv);

/**
 * Assert every key of a constructed child env is in the allowed set (and none is
 * a forbidden tripwire key). The property test feeds this an env constructed from
 * an arbitrary parent seeded with dangerous keys.
 *
 * @param {Record<string, string>} env
 */
export const assertChildEnvAllowed = env => {
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV_KEYS.includes(key)) {
      throw makeError(
        X`child env carries forbidden variable ${q(key)} (pool bypass / off-target redirect)`,
      );
    }
    if (!ALLOWED_ENV_KEYS.includes(key)) {
      throw makeError(X`child env carries non-allowlisted variable ${q(key)}`);
    }
  }
};
harden(assertChildEnvAllowed);
