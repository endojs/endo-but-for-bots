// @ts-check

import { Fail } from '@endo/errors';
import {
  assertBrokerModels,
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';
import { makeSecretRotator } from '@endo/hosted-agent/secret-rotator.js';
import { M, matches } from '@endo/patterns';

import { makeCodexSubscriptionCredential } from './subscription-auth.js';

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
    makePolicy: config => ({
      accountRef: config.accountRef,
      policy: harden({
        origin: 'https://chatgpt.com',
        authMode: 'subscription',
        routes: [{ method: 'POST', path: '/v1/responses' }],
        models: [...config.models],
        maxConcurrentRequests: 4,
        maxRequestBytes: 8n * 1024n ** 2n,
        maxResponseBytes: 16n * 1024n ** 2n,
      }),
    }),
    makeCredential: (config, secret) =>
      makeCredential({
        secret,
        rotate: makeSecretRotator(secret),
        accountRef: config.accountRef,
        now: Date.now,
        fetch: globalThis.fetch,
      }),
    makeServiceKit,
    reportError,
  });
harden(makeOwnedCodexBrokerService);

/** Retained unconfined operator entrypoint. Its facet exposes only scopes. */
export const make = makeOwnedCodexBrokerService();
harden(make);
