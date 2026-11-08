// @ts-check
/* global process */
import { readAccountAuthority } from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedCredentials } from '@endo/hosted-agent/managed-credentials.js';
import { readBrokerWorkloadEnv } from '@endo/hosted-agent/provider-broker-service.js';
import { setupDirectSubscription } from '@endo/hosted-agent/setup-direct-subscription.js';
import { Fail } from '@endo/errors';
import { assertCredentialKind } from './src/claude-credential-kinds.js';
import { readClaudeBrokerConfig } from './src/claude-broker-service-agent.js';
import { prepareClaudePool, readClaudePool } from './src/claude-pool-setup.js';

/**
 * Provision direct Anthropic Messages inference over the operator's subscriptions.
 * @param {any} host
 * @param {{env?: Record<string,string|undefined>}} [options]
 */
export const main = async (host, { env = process.env } = {}) => {
  const accountAuthority = readAccountAuthority(
    env,
    'ENDO_CLAUDE_ACCOUNT_AUTHORITY',
    'Claude',
  );
  const pool = readClaudePool(env);
  const credentialKind = assertCredentialKind(
    env.ENDO_CLAUDE_CREDS_KIND ||
      (pool || env.ENDO_CLAUDE_OAUTH_TOKEN ? 'oauthToken' : 'apiKey'),
  );
  if (pool && credentialKind !== 'oauthToken')
    throw Fail`Claude pools require OAuth credentials`;
  const credsName = env.ENDO_CLAUDE_CREDS_NAME || 'claude-creds';
  const anthropicBeta = env.ENDO_CLAUDE_ANTHROPIC_BETA;
  return setupDirectSubscription(host, {
    id: 'claude',
    providerId: 'anthropic',
    label: 'Claude',
    flootDir: env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot',
    accountAuthority,
    ownerModule: new URL(
      './src/claude-broker-service-agent.js',
      import.meta.url,
    ).href,
    workloadEnv: readBrokerWorkloadEnv(env),
    readProfile: readClaudeBrokerConfig,
    profile: {
      pool: !!pool,
      credentialKind,
      ...(anthropicBeta ? { anthropicBeta } : {}),
    },
    singlePowersPath: ['secrets', credsName],
    prepareCredentials: async () => {
      if (pool) {
        const prepared = await prepareClaudePool(host, pool);
        await prepared.publish();
        return { subscriptionIds: pool.set.members.map(member => member.id) };
      }
      await provideManagedCredentials(host, {
        name: credsName,
        kind: credentialKind,
        label: 'Anthropic',
        apiKey: env.ENDO_CLAUDE_OAUTH_TOKEN || env.ENDO_FLOOT_AUTH_TOKEN,
      });
      return {};
    },
  });
};
harden(main);
