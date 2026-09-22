// @ts-check

import { Fail } from '@endo/errors';
import { makeCodexModelRead } from '@endo/hosted-agent/codex-model-read.js';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';
import { makeSecretRotator } from '@endo/hosted-agent/secret-rotator.js';
import { M, matches } from '@endo/patterns';
import { readFile } from 'node:fs/promises';

import { assertAccountAuthority } from '@endo/hosted-agent/account-authority.js';
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
    // The account authority this broker serves (`account-authority.js`):
    // the id every plan records and every grant reports.
    accountAuthority: M.string(),
  },
  {
    // The provider account the one credential is bound to, verified against
    // the credential's own state; absent for a pool, whose members each
    // name theirs.
    accountRef: M.string(),
    maxSessions: M.number(),
    publicInternet: M.boolean(),
    diagnostics: M.boolean(),
    // Several subscriptions: the formula's powers are then a namespace that
    // holds the declared set and each member's credential.
    pool: M.boolean(),
  },
  harden({}),
);

/**
 * Operator-only broker configuration. No guest-supplied origins, refresh
 * endpoints, credentials, or runtime constructors enter the saved record.
 * No model list either: the account's catalog, read from the provider, is
 * what admits models (`@endo/hosted-agent/model-catalog.js`).
 * @param {Record<string, string>} env
 */
export const readCodexBrokerConfig = env => {
  const text = env.CODEX_BROKER_CONFIG;
  typeof text === 'string' || Fail`Missing CODEX_BROKER_CONFIG`;
  const config = harden(JSON.parse(text));
  // A profile from before account catalogs admitted models carries an
  // operator model list; it is refused with the way out, not as a shape
  // error, since the broker it belongs to must be retired deliberately.
  !(config && typeof config === 'object' && Object.hasOwn(config, 'models')) ||
    Fail`Retained Codex broker configuration names models, which this release no longer reads (models are admitted by the account's own catalog): retire that broker and the sessions bound to it deliberately, then rerun setup`;
  // A profile from before plans recorded the account authority names none;
  // it is refused with the way out, not as a shape error, since the broker
  // it belongs to must be retired deliberately. Only a profile that is
  // otherwise whole reads as one from before; anything less is a shape error.
  !(
    config &&
    typeof config === 'object' &&
    [
      'ownerId',
      'directory',
      'imageRef',
      'imageDigest',
      'listenerImageRef',
    ].every(name => Object.hasOwn(config, name)) &&
    !Object.hasOwn(config, 'accountAuthority')
  ) ||
    Fail`Retained Codex broker configuration names no account authority, which this release records into every session plan; retire that broker deliberately and set ENDO_CODEX_ACCOUNT_AUTHORITY for the next mint`;
  if (!matches(config, ConfigShape))
    throw Fail`Invalid Codex broker configuration`;
  assertAccountAuthority(config.accountAuthority, 'Codex');
  if (config.pool === true) {
    config.accountRef === undefined ||
      Fail`A Codex pool's profile names no account; its members name theirs`;
  } else {
    (typeof config.accountRef === 'string' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(config.accountRef)) ||
      Fail`Invalid Codex subscription account`;
  }
  return config;
};
harden(readCodexBrokerConfig);

/**
 * One renewing credential and common broker owner per persisted operator
 * service. Session scopes never receive the renewal-capable Secrets facet.
 * @param {object} [powers]
 * @param {typeof makeProviderBrokerServiceKit} [powers.makeServiceKit]
 * @param {typeof makeCodexSubscriptionCredential} [powers.makeCredential]
 * @param {typeof globalThis.fetch} [powers.fetch]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedCodexBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  makeCredential = makeCodexSubscriptionCredential,
  fetch = globalThis.fetch,
  reportError = error => console.error('Codex broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'Codex',
    readConfig: readCodexBrokerConfig,
    makePolicy: config => ({
      ...makeCodexSubscriptionProfile({ accountRef: config.accountRef }),
      accountAuthority: config.accountAuthority,
    }),
    makeCredential: (config, secret) =>
      makeCredential({
        secret,
        rotate: makeSecretRotator(secret),
        accountRef:
          config.accountRef ??
          Fail`A Codex credential must be bound to an account`,
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
    makeModelRead:
      ({ credential, accountRef }) =>
      async () => {
        // The packaged runtime is the version authority, not a second pin in
        // broker configuration. Read lazily: constructing an owner stays inert.
        const manifest = JSON.parse(
          await readFile(
            new URL('../oci/package.json', import.meta.url),
            'utf8',
          ),
        );
        return makeCodexModelRead({
          current: () => credential.current(),
          accountRef,
          clientVersion: manifest.dependencies['@openai/codex'],
          fetch,
        })();
      },
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
