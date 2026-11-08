// @ts-check
/* global process */
import { readAccountAuthority } from '@endo/hosted-agent/hosted-setup.js';
import { readBrokerWorkloadEnv } from '@endo/hosted-agent/provider-broker-service.js';
import { setupDirectSubscription } from '@endo/hosted-agent/setup-direct-subscription.js';
import { readCodexBrokerConfig } from './src/codex-broker-service-agent.js';
import { prepareCodexSubscriptions } from './src/codex-pool-setup.js';

/**
 * Provision direct OpenAI Responses inference over the operator's subscriptions.
 * @param {any} host
 * @param {{env?: Record<string,string|undefined>}} [options]
 */
export const main = async (host, { env = process.env } = {}) => {
  const accountAuthority = readAccountAuthority(
    env,
    'ENDO_CODEX_ACCOUNT_AUTHORITY',
    'Codex',
  );
  return setupDirectSubscription(host, {
    id: 'codex',
    providerId: 'codex',
    label: 'Codex',
    flootDir: env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot',
    accountAuthority,
    ownerModule: new URL('./src/codex-broker-service-agent.js', import.meta.url)
      .href,
    workloadEnv: readBrokerWorkloadEnv(env),
    readProfile: readCodexBrokerConfig,
    profile: { pool: env.ENDO_CODEX_SUBSCRIPTIONS !== undefined },
    prepareCredentials: () =>
      prepareCodexSubscriptions(host, env, accountAuthority),
  });
};
harden(main);
