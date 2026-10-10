// @ts-check
/* eslint-disable no-await-in-loop */
/* global process, setTimeout */
// endo run --UNCONFINED fae-factory-setup.js --powers @agent \
//   -E PROVIDER_NAME=default -E FACTORY_NAME=fae

import { E } from '@endo/eventual-send';

import { AUTH_SECRET_PETNAME } from './src/credentials.js';

const faeFactorySpecifier = new URL('agent.js', import.meta.url).href;

/**
 * Attempt to resolve a provider's formula ID, retrying briefly if the
 * llm-provider-factory caplet hasn't finished processing the form submission yet.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} providerName
 * @returns {Promise<string>}
 */
const resolveProvider = async (agent, providerName) => {
  const maxAttempts = 5;
  const delayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const id = /** @type {string} */ (await E(agent).identify(providerName));
      if (id) return id;
    } catch {
      // Name not found yet; retry.
    }
    if (attempt < maxAttempts) {
      console.log(
        `Provider "${providerName}" not found yet, retrying (${attempt}/${maxAttempts})...`,
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Provider "${providerName}" not found after ${maxAttempts} attempts. Run provider-setup.sh first.`,
  );
};

/**
 * Create a fae-factory guest bound to a named LLM provider, then
 * spawn a default "fae" agent instance for direct mailbox chat.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  const providerName = process.env.PROVIDER_NAME || 'default';
  const factoryName = process.env.FACTORY_NAME || 'fae-factory';
  const guestName = `${factoryName}-handle`;
  const agentName = `profile-for-${guestName}`;

  const providerId = await resolveProvider(agent, providerName);

  // Create the factory guest if it doesn't already exist.
  const hasFactory = await E(agent).has(guestName);
  if (!hasFactory) {
    await E(agent).provideGuest(guestName, {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName,
    });
  }

  // Write the provider reference into the factory's petstore.
  // E(agent).identify(...) returns a bare formula id, so use
  // storeIdentifier rather than storeLocator (which requires endo://).
  const factoryPowers = await E(agent).lookup(agentName);
  await E(factoryPowers).storeIdentifier('llm-provider', providerId);

  // The provider config names the pet name its token was bound to under
  // `secrets/`. A name means nothing to the factory — it has no `secrets`
  // directory — so resolve it here, where it does mean something, and delegate
  // the `SecretBlob` capability itself.
  const providerConfig = /** @type {any} */ (
    await E(agent).lookup(providerName)
  );
  const authSecretName = providerConfig?.authSecretName;
  if (typeof authSecretName === 'string' && authSecretName !== '') {
    const secretLocator = await E(agent).locate('secrets', authSecretName);
    if (typeof secretLocator !== 'string') {
      throw new Error(
        `Provider "${providerName}" names secret "${authSecretName}", which does not exist.`,
      );
    }
    await E(factoryPowers).storeLocator(AUTH_SECRET_PETNAME, secretLocator);
  } else if (await E(factoryPowers).has(AUTH_SECRET_PETNAME)) {
    // A provider that reverted to a plaintext token must not keep silently
    // reading a stale blob, which the resolver would prefer.
    await E(factoryPowers).remove(AUTH_SECRET_PETNAME);
  }

  // Launch the fae-factory caplet.
  await E(agent).makeUnconfined('@main', faeFactorySpecifier, {
    powersName: agentName,
    resultName: factoryName,
  });

  console.log(
    `Fae factory "${factoryName}" created, bound to provider "${providerName}".`,
  );

  // Create a default "fae" agent instance for direct mailbox chat.
  // Pin by default so the agent survives daemon restarts.
  const factory = await E(agent).lookup(factoryName);
  const faeProfileName = await E(factory).createAgent(
    'fae',
    harden({ pin: true }),
  );
  console.log(
    `Default agent "fae" created and pinned (profile: ${faeProfileName}). Add a space with this profile to chat.`,
  );
};
harden(main);
