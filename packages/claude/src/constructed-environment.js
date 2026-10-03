// @ts-check
// spell-out-exempt: `CLAUDE_CONFIG_DIR` is Claude Code's own variable name.
//
// The environment a confined Claude Code process runs with, built from
// nothing (designs/endo-claude-inference-backends.md Decisions 3 and 5). The
// parent's environment is never read, so its own credentials, proxies, and
// daemon socket cannot reach the turn.

import { Fail, q } from '@endo/errors';

/** @import { ConstructedEnvironmentSpec } from './backends.types.js' */

/**
 * The variables a granted `acquire()` may deliver. `ANTHROPIC_AUTH_TOKEN`
 * carries a lease token (broker delivery) or a subscription token (interim
 * delivery); `ANTHROPIC_API_KEY` an API key; `ANTHROPIC_BASE_URL` the
 * broker's loopback listener.
 */
export const CREDENTIAL_ENVIRONMENT_KEYS = harden([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
]);

/** The credential variables that authenticate rather than route. */
const AUTHENTICATING_KEYS = harden([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

/**
 * Settings that turn off Claude Code behavior a single confined turn has no
 * use for: background network traffic, self-update, and auto-memory.
 */
const QUIET_SETTINGS = harden({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTOUPDATER: '1',
});

/**
 * @param {string} name
 * @param {unknown} value
 */
const assertNonEmptyString = (name, value) => {
  (typeof value === 'string' && value !== '') ||
    Fail`${q(name)} must be a non-empty string`;
};

/**
 * Builds the confined process's whole environment. The credential variables
 * come only from the grant, and only the ones in
 * `CREDENTIAL_ENVIRONMENT_KEYS`, and at least one of them must authenticate.
 * A grant carrying anything else throws:
 * `CLAUDE_CODE_OAUTH_TOKEN`, for example, is ignored under `--bare`, so a
 * source delivering it is misconfigured and the turn would run
 * unauthenticated.
 *
 * @param {ConstructedEnvironmentSpec} spec
 * @returns {Record<string, string>}
 */
export const buildConstructedEnvironment = ({
  configDirectory,
  pathValue,
  credentialEnvironment,
  lang = 'C.UTF-8',
}) => {
  assertNonEmptyString('configDirectory', configDirectory);
  assertNonEmptyString('pathValue', pathValue);
  /** @type {Record<string, string>} */
  const credentials = {};
  for (const [key, value] of Object.entries(credentialEnvironment)) {
    CREDENTIAL_ENVIRONMENT_KEYS.includes(key) ||
      Fail`credential source delivered unsupported variable ${q(key)}`;
    assertNonEmptyString(key, value);
    credentials[key] = value;
  }
  // `ANTHROPIC_BASE_URL` only routes; on its own the turn would run
  // unauthenticated.
  AUTHENTICATING_KEYS.some(key => key in credentials) ||
    Fail`credential source delivered no authenticating variable`;
  return harden({
    PATH: pathValue,
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    TMPDIR: configDirectory,
    LANG: lang,
    LC_ALL: lang,
    ...QUIET_SETTINGS,
    ...credentials,
  });
};
harden(buildConstructedEnvironment);
