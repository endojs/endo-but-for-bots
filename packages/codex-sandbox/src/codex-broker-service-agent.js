// @ts-check

import { Fail } from '@endo/errors';
import {
  assertBrokerModels,
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';
import { makeSecretRotator } from '@endo/hosted-agent/secret-rotator.js';
import { M, matches } from '@endo/patterns';

import { makeCodexAccountRead } from './codex-account-read.js';
import { makeCodexResetRedeem } from './codex-reset-credit.js';
import { makeCodexSubscriptionCredential } from './subscription-auth.js';
import { makeCodexSubscriptionProfile } from './codex-subscription-profile.js';

const ConfigShape = M.splitRecord(
  {
    ownerId: M.string(),
    directory: M.string(),
    imageRef: M.string(),
    imageDigest: M.string(),
    listenerImageRef: M.string(),
    accountRef: M.string(),
    models: M.arrayOf(M.string()),
  },
  {
    maxSessions: M.number(),
    publicInternet: M.boolean(),
    diagnostics: M.boolean(),
    // Several subscriptions: the formula's powers are then a namespace that
    // holds the declared set and each member's credential, and `accountRef`
    // is the pool's label, not an account.
    pool: M.boolean(),
  },
  harden({}),
);

/**
 * Operator-only broker configuration. No guest-supplied origins, refresh
 * endpoints, credentials, or runtime constructors enter the saved record.
 * @param {Record<string, string>} env
 */
export const readCodexBrokerConfig = env => {
  const text = env.CODEX_BROKER_CONFIG;
  typeof text === 'string' || Fail`Missing CODEX_BROKER_CONFIG`;
  const config = harden(JSON.parse(text));
  if (!matches(config, ConfigShape))
    throw Fail`Invalid Codex broker configuration`;
  /^[A-Za-z0-9_-]{1,256}$/.test(config.accountRef) ||
    Fail`Invalid Codex subscription account`;
  assertBrokerModels(config.models, 'Codex');
  return config;
};
harden(readCodexBrokerConfig);

/**
 * One renewing credential and common broker owner per persisted operator
 * service. Session scopes never receive the renewal-capable Secrets facet.
 * @param {object} [powers]
 * @param {typeof makeProviderBrokerServiceKit} [powers.makeServiceKit]
 * @param {typeof makeCodexSubscriptionCredential} [powers.makeCredential]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedCodexBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  makeCredential = makeCodexSubscriptionCredential,
  reportError = error => console.error('Codex broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'Codex',
    readConfig: readCodexBrokerConfig,
    makePolicy: makeCodexSubscriptionProfile,
    makeCredential: (config, secret) =>
      makeCredential({
        secret,
        rotate: makeSecretRotator(secret),
        accountRef: config.accountRef,
        now: Date.now,
        fetch: globalThis.fetch,
      }),
    // For an account oracle's refresh(): the plan, the windows and the banked
    // resets from the usage endpoint, with the same renewing credential.
    makeActiveAccountRead: ({ credential, accountRef }) =>
      makeCodexAccountRead({
        credential,
        accountRef,
        fetch: globalThis.fetch,
      }),
    // For the operator's subscription admin: the one call that spends a
    // banked rate-limit reset. Nothing in the broker runs it.
    makeResetRedeem: ({ credential, accountRef }) =>
      makeCodexResetRedeem({
        credential,
        accountRef,
        fetch: globalThis.fetch,
      }),
    makeServiceKit,
    reportError,
  });
harden(makeOwnedCodexBrokerService);

/** Retained unconfined operator entrypoint. Its facet exposes only scopes. */
export const make = makeOwnedCodexBrokerService();
harden(make);
