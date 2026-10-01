// @ts-check

import { Fail } from '@endo/errors';
import {
  createProvider,
  makeSubscriptionResponsesProvider,
} from '@endo/lal/providers/index.js';

/**
 * Own the loop's local provider, not its credential or subscription broker.
 *
 * Holding the token behind a `SecretBlob` only buys rotation and revocation if
 * something actually re-reads it. A provider built once, when an agent's loop
 * starts, goes on presenting the credential it was built with for as long as
 * the daemon runs — so a revoked secret stops the next *provisioning* rather
 * than the next turn, which is the opposite of what revocation is for.
 *
 * The token is therefore read once per turn — the caller resolves this before
 * the turn's first model call, not for every tool round — and the provider is
 * rebuilt only when the bytes change, so an unrotated deployment pays one
 * secret read per turn and nothing else.
 *
 * @param {object} options
 * @param {{ provider?: any, host?: string, model?: string, authToken?: string,
 *   kind?: string, subscription?: any, reasoningEffort?: string, contextLength?: number }} options.config
 * @param {string} [options.sessionId] Stable agent identity for pool affinity.
 * @param {() => Promise<string>} [options.provideAuthToken] - Secret resolver;
 *   absent only for tokenless or explicitly injected providers.
 * @param {(env: Record<string, string | undefined>) => any} [options.buildProvider]
 * @returns {{ forTurn(): Promise<any>, dispose(): Promise<void> }}
 */
export const makeProviderOwner = ({
  config,
  sessionId,
  provideAuthToken,
  buildProvider = createProvider,
}) => {
  !Object.hasOwn(config, 'authToken') ||
    Fail`Inline provider authToken is unsupported; use a Secrets resolver`;
  config.kind === undefined ||
    config.kind === 'subscription-responses' ||
    Fail`Unsupported Fae provider kind`;
  const subscriptionBacked = config.kind === 'subscription-responses';
  if (subscriptionBacked) {
    const fields = harden([
      'kind',
      'subscription',
      'model',
      'reasoningEffort',
      'contextLength',
    ]);
    Object.keys(config).every(key => fields.includes(key)) ||
      Fail`Subscription provider cannot carry host, secret, or injected-provider configuration`;
    config.subscription !== undefined || Fail`Subscription capability required`;
    sessionId !== undefined || Fail`Stable inference session identity required`;
  } else {
    !Object.hasOwn(config, 'subscription') ||
      Fail`Subscription requires the subscription-responses provider kind`;
  }
  /** @type {any} */
  let cachedProvider;
  /** @type {string | undefined} */
  let cachedToken;
  let disposed = false;
  const assertLive = () => {
    !disposed || Fail`Fae provider owner disposed`;
  };
  const release = async () => {
    await null;
    // Injected providers are borrowed. Only constructed adapters belong to us.
    await cachedProvider?.dispose?.();
    cachedProvider = undefined;
    cachedToken = undefined;
  };
  const forTurn = async () => {
    await null;
    assertLive();
    // An injected provider (a test double, or a caller that built its own) is
    // the whole configuration; there is no token to follow.
    if (config.provider) return config.provider;
    if (subscriptionBacked) {
      cachedProvider ??= makeSubscriptionResponsesProvider({
        subscription: config.subscription,
        sessionId: /** @type {string} */ (sessionId),
        model: config.model || '',
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
        ...(config.contextLength === undefined
          ? {}
          : { contextLength: config.contextLength }),
      });
      return cachedProvider;
    }
    /** @type {string | undefined} */
    let authToken;
    try {
      authToken = provideAuthToken ? await provideAuthToken() : '';
    } catch (error) {
      // A revoked secret must not leave the token it replaced sitting in this
      // closure, nor a provider still holding it: drop both and fail the call.
      await release();
      throw error;
    }
    assertLive();
    if (cachedProvider === undefined || authToken !== cachedToken) {
      await release();
      assertLive();
      cachedProvider = buildProvider({
        LAL_HOST: config.host,
        LAL_MODEL: config.model,
        LAL_AUTH_TOKEN: authToken,
      });
      cachedToken = authToken;
    }
    return cachedProvider;
  };
  return harden({
    forTurn,
    async dispose() {
      disposed = true;
      await release();
    },
  });
};
harden(makeProviderOwner);
