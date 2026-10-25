// @ts-check

import { assertValidLocator } from '@endo/daemon/locator.js';
import { makeError } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { validateProviderConfig } from './provider-service.js';

/** @import { ProviderConfig } from './provider-service.js' */
/** @typedef {ProviderConfig & {name: string, moduleUrl?: string}} ProviderSetupConfig */

const CONFIG_KEYS = harden([
  'name',
  'kind',
  'host',
  'model',
  'maxTokens',
  'maxMessages',
  'moduleUrl',
]);
/** @type {WeakMap<object, Set<string>>} */
const inFlight = new WeakMap();

/**
 * Trusted administration utility. Provision one isolated provider guest and
 * introduce only its selected SecretBlob locator. Never pass a secrets manager
 * or a credential string here. This helper never reads the secret.
 *
 * Existing service or guest names are rejected, including incomplete attempts;
 * a caller must inspect and clean up a failed attempt or choose a fresh name.
 * @param {any} host
 * @param {ProviderSetupConfig} config
 * @param {string} [authSecretLocator]
 * @returns {Promise<any>} The provider service, also stored under config.name.
 */
export const provisionProviderService = async (
  host,
  config,
  authSecretLocator,
) => {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some(key => !CONFIG_KEYS.includes(key))
  ) {
    throw makeError(
      'Unsupported provider setup configuration. Credentials must be SecretBlob locators.',
    );
  }
  const { name, kind, model, maxTokens, maxMessages } = config;
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw makeError(
      'Provider name must begin with a letter and contain at most 64 letters, digits, hyphens, or underscores.',
    );
  }
  const validated = validateProviderConfig({
    kind,
    host: config.host,
    model,
    maxTokens,
    maxMessages,
  });
  if (kind === 'local') {
    if (authSecretLocator !== undefined)
      throw makeError(
        'Local providers do not accept an authentication secret.',
      );
  } else {
    try {
      if (typeof authSecretLocator !== 'string') throw Error('missing locator');
      assertValidLocator(authSecretLocator);
    } catch {
      throw makeError(
        'Cloud provider authentication requires a valid SecretBlob locator.',
      );
    }
  }
  let moduleUrl;
  try {
    moduleUrl = new URL(
      config.moduleUrl ??
        new URL('./provider-service.js', import.meta.url).href,
    );
    if (
      moduleUrl.protocol !== 'file:' ||
      (moduleUrl.hostname !== '' && moduleUrl.hostname !== 'localhost') ||
      !moduleUrl.pathname.endsWith('/provider-service.js') ||
      moduleUrl.search ||
      moduleUrl.hash
    ) {
      throw Error('invalid module');
    }
  } catch {
    throw makeError(
      'Provider module must be a local provider-service.js file URL.',
    );
  }

  let pending = inFlight.get(host);
  if (!pending) {
    pending = new Set();
    inFlight.set(host, pending);
  }
  if (pending.has(name))
    throw makeError('A provider with this name is already being provisioned.');
  pending.add(name);
  await null;
  try {
    const handleName = `provider-${name}-handle`;
    const profileName = `profile-for-provider-${name}`;
    const occupied = await Promise.all([
      E(host).has(name),
      E(host).has(handleName),
      E(host).has(profileName),
    ]);
    if (occupied.some(Boolean)) {
      throw makeError(
        'Provider service or guest name already exists. Inspect the existing setup or choose a new name.',
      );
    }
    // No introducedNames: the guest receives neither host authority nor the
    // secrets manager. Only the explicitly selected blob is introduced below.
    const guest = await E(host).provideGuest(
      handleName,
      harden({ agentName: profileName }),
    );
    if (authSecretLocator !== undefined) {
      await E(guest).storeLocator('llm-auth-secret', authSecretLocator);
    }
    const env = harden({
      PROVIDER_KIND: validated.kind,
      PROVIDER_HOST: validated.host,
      PROVIDER_MODEL: validated.model,
      ...(validated.maxTokens === undefined
        ? {}
        : { PROVIDER_MAX_TOKENS: validated.maxTokens }),
      ...(validated.maxMessages === undefined
        ? {}
        : { PROVIDER_MAX_MESSAGES: validated.maxMessages }),
    });
    return await E(host).makeUnconfined(
      '@node',
      moduleUrl.href,
      harden({
        powersName: profileName,
        resultName: name,
        env,
      }),
    );
  } finally {
    pending.delete(name);
  }
};
harden(provisionProviderService);
