// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { normalizeSubscriptionSet } from '@endo/hosted-agent/subscription-pool.js';

/**
 * Parse only references to Secrets, never credentials supplied through env.
 * Claude pools use one credential kind and broker policy for every member.
 * @param {Record<string, string | undefined>} env
 */
export const readClaudePool = env => {
  if (env.ENDO_CLAUDE_SUBSCRIPTIONS === undefined) return undefined;
  let declared;
  try {
    declared = JSON.parse(env.ENDO_CLAUDE_SUBSCRIPTIONS);
  } catch {
    throw Fail`ENDO_CLAUDE_SUBSCRIPTIONS is not JSON`;
  }
  (Array.isArray(declared) && declared.length > 0) ||
    Fail`ENDO_CLAUDE_SUBSCRIPTIONS must be a nonempty list`;
  const secrets = declared.map(member => {
    (member !== null &&
      typeof member === 'object' &&
      Object.keys(member).every(name =>
        ['id', 'label', 'weight', 'credsName'].includes(name),
      )) ||
      Fail`Claude subscription fields are id, label, weight and credsName`;
    (typeof member.credsName === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,127}$/.test(member.credsName)) ||
      Fail`Every Claude subscription needs a Secrets name`;
    return member.credsName;
  });
  new Set(secrets).size === secrets.length ||
    Fail`Claude subscriptions must use distinct Secrets entries`;
  const set = normalizeSubscriptionSet({
    members: declared.map(({ id, label, weight }) => ({
      id,
      label,
      weight,
      secretName: `secret-${id}`,
    })),
    ...(env.ENDO_CLAUDE_CACHE_LIFETIME_SECONDS === undefined
      ? {}
      : {
          cacheLifetimeSeconds: Number(env.ENDO_CLAUDE_CACHE_LIFETIME_SECONDS),
        }),
  });
  return harden({ set, secrets });
};
harden(readClaudePool);

/**
 * Preflight the entire set before writes. Keep exact SecretBlob identities:
 * rotation updates the blob, while rebinding a member requires a new id.
 * No token bytes are read, copied or stored by setup.
 * @param {any} host
 * @param {NonNullable<ReturnType<typeof readClaudePool>>} pool
 */
export const prepareClaudePool = async (host, pool) => {
  const powersPath = ['claude-sandbox', 'broker-powers'];
  const existing = await E(host).has(...powersPath);
  const powers = existing ? await E(host).lookup(powersPath) : undefined;
  const locators = await Promise.all(
    pool.secrets.map(async name => {
      (await E(host).has('secrets', name)) ||
        Fail`A declared Claude subscription is missing from Secrets`;
      return E(host).locate('secrets', name);
    }),
  );
  new Set(locators).size === locators.length ||
    Fail`Claude subscriptions must use distinct SecretBlobs`;
  for (const [index, member] of pool.set.members.entries()) {
    // Even a removed member keeps its identity if later reintroduced.
    // eslint-disable-next-line no-await-in-loop
    if (powers && (await E(powers).has(member.secretName))) {
      // eslint-disable-next-line no-await-in-loop
      (await E(powers).locate(member.secretName)) === locators[index] ||
        Fail`Claude subscription ${member.id} is bound to another secret; use a new id`;
    }
  }
  return harden({
    async publish() {
      let namespace = powers;
      if (!namespace) {
        const handleName = 'claude-sandbox.broker-powers-handle';
        const powersName = 'claude-sandbox.broker-powers';
        for (const name of [handleName, powersName]) {
          // eslint-disable-next-line no-await-in-loop
          if (await E(host).has(name)) await E(host).remove(name);
        }
        await E(host).provideGuest(handleName, { agentName: powersName });
        await E(host).move(
          [handleName],
          ['claude-sandbox', 'broker-powers-handle'],
        );
        await E(host).move([powersName], powersPath);
        namespace = await E(host).lookup(powersPath);
      }
      for (const [index, member] of pool.set.members.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await E(namespace).storeLocator(member.secretName, locators[index]);
      }
      await E(namespace).storeValue(pool.set, 'subscriptions');
    },
  });
};
harden(prepareClaudePool);
