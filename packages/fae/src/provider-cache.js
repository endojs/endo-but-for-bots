// @ts-check

import { createProvider } from '@endo/lal/providers/index.js';

/**
 * A provider that follows the credential instead of pinning it.
 *
 * Holding the token behind a `SecretBlob` only buys rotation and revocation if
 * something actually re-reads it. A provider built once, when an agent's loop
 * starts, goes on presenting the credential it was built with for as long as
 * the daemon runs — so a revoked secret stops the next *provisioning* rather
 * than the next turn, which is the opposite of what revocation is for.
 *
 * The token is therefore read per turn, and the provider rebuilt only when the
 * bytes change: an unrotated deployment pays one secret read per turn and
 * nothing else.
 *
 * @param {object} options
 * @param {{ provider?: any, host?: string, model?: string, authToken?: string }} options.config
 * @param {() => Promise<string>} [options.provideAuthToken] - Absent when the
 *   deployment still carries a plaintext token in its provider config.
 * @param {(env: Record<string, string | undefined>) => any} [options.buildProvider]
 * @returns {() => Promise<any>}
 */
export const makeRotatingProvider = ({
  config,
  provideAuthToken,
  buildProvider = createProvider,
}) => {
  /** @type {any} */
  let cachedProvider = config.provider;
  /** @type {string | undefined} */
  let cachedToken;
  return async () => {
    await null;
    // An injected provider (a test double, or a caller that built its own) is
    // the whole configuration; there is no token to follow.
    if (config.provider) return config.provider;
    const authToken = provideAuthToken
      ? await provideAuthToken()
      : config.authToken;
    if (cachedProvider === undefined || authToken !== cachedToken) {
      cachedProvider = buildProvider({
        LAL_HOST: config.host,
        LAL_MODEL: config.model,
        LAL_AUTH_TOKEN: authToken,
      });
      cachedToken = authToken;
    }
    return cachedProvider;
  };
};
harden(makeRotatingProvider);
