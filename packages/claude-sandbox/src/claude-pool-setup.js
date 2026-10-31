// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  provideManagedRenewableCredentials,
  readManagedRenewableCredentials,
} from '@endo/hosted-agent/managed-renewable-credentials.js';
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
    // The pool is the account authority the broker serves; its id is the
    // operator's declared one, when the configuration names it.
    ...(env.ENDO_CLAUDE_ACCOUNT_AUTHORITY
      ? { id: env.ENDO_CLAUDE_ACCOUNT_AUTHORITY }
      : {}),
    members: declared.map(({ id, label, weight }) => ({
      id,
      label,
      weight,
      secretName: `credential-${id}`,
      accountRef: `claude-${id}`,
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
 * @param {object} [options]
 * @param {typeof provideManagedRenewableCredentials} [options.provideCredential]
 * @param {typeof readManagedRenewableCredentials} [options.readCredential]
 */
export const prepareClaudePool = async (
  host,
  pool,
  {
    provideCredential = provideManagedRenewableCredentials,
    readCredential = readManagedRenewableCredentials,
  } = {},
) => {
  const powersPath = ['claude-sandbox', 'broker-powers'];
  const existing = await E(host).has(...powersPath);
  const powers = existing ? await E(host).lookup(powersPath) : undefined;
  const identities = await Promise.all(
    pool.secrets.map(async name => {
      (await E(host).has('secrets', name)) ||
        Fail`A declared Claude subscription is missing from Secrets`;
      const identifier = await E(host).identify('secrets', name);
      (typeof identifier === 'string' && identifier.length > 0) ||
        Fail`A declared Claude subscription has no formula identity`;
      return identifier;
    }),
  );
  new Set(identities).size === identities.length ||
    Fail`Claude subscriptions must use distinct SecretBlobs`;
  for (const [index, member] of pool.set.members.entries()) {
    const identityName = `secret-${member.id}`;
    // Even a removed member keeps its identity if later reintroduced.
    // eslint-disable-next-line no-await-in-loop
    if (powers && (await E(powers).has(identityName))) {
      // eslint-disable-next-line no-await-in-loop
      (await E(powers).identify(identityName)) === identities[index] ||
        Fail`Claude subscription ${member.id} is bound to another secret; use a new id`;
    }
    const namePath = ['claude-sandbox', `credential-${member.id}`];
    // Validate every retained holder before publishing any changed member.
    // eslint-disable-next-line no-await-in-loop
    if (await E(host).has(...namePath)) {
      // eslint-disable-next-line no-await-in-loop
      const retained = await readCredential(host, {
        label: 'Claude',
        namePath,
      });
      JSON.stringify(retained.secretPath) ===
        JSON.stringify(['secrets', pool.secrets[index]]) ||
        Fail`Claude subscription credential is pinned to another secret`;
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
        const namePath = ['claude-sandbox', `credential-${member.id}`];
        // eslint-disable-next-line no-await-in-loop
        await provideCredential(host, {
          namePath,
          secretPath: ['secrets', pool.secrets[index]],
          label: 'Claude',
        });
        // Retain the original blob identity independently of its renewing holder.
        // eslint-disable-next-line no-await-in-loop
        await E(namespace).storeIdentifier(
          `secret-${member.id}`,
          // This guest belongs to the same daemon. Retain the exact formula
          // identity preflight checked, not a freshly resolved mutable name.
          identities[index],
        );
        // eslint-disable-next-line no-await-in-loop
        await E(namespace).storeLocator(
          member.secretName,
          // eslint-disable-next-line no-await-in-loop
          await E(host).locate(...namePath),
        );
      }
      await E(namespace).storeValue(pool.set, 'subscriptions');
    },
  });
};
harden(prepareClaudePool);
