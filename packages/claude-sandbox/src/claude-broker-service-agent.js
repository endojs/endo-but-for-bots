// @ts-check

/**
 * The `claude-sandbox/broker-service` caplet: the retained Anthropic broker
 * the daemon session owner records as each session's `brokerService` role.
 * Minted by `setup-hosted.js` with the managed credential's SecretBlob read
 * facet as its sole powers; its operator profile is persisted in the formula
 * environment, so sessions never resolve a mutable credential name.
 *
 * Formula env (set by `setup-hosted.js`):
 *   CLAUDE_BROKER_CONFIG  JSON: ownerId, directory, imageRef, imageDigest,
 *                         listenerImageRef, credentialKind, and optional
 *                         anthropicBeta, maxSessions, publicInternet. No model
 *                         list: the account's catalog, read from Anthropic,
 *                         admits models.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeAnthropicModelRead } from '@endo/hosted-agent/anthropic-model-read.js';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';
import { M, matches } from '@endo/patterns';
import { assertAccountAuthority } from '@endo/hosted-agent/account-authority.js';
import {
  makeClaudeAccountRead,
  makeClaudeSubscriptionCredential,
} from './subscription-auth.js';

import {
  ANTHROPIC_BETA_PATTERN,
  DEFAULT_OAUTH_BETA,
  buildClaudeBrokerPolicy,
} from './claude-broker.js';
import {
  CREDENTIAL_KINDS,
  assertCredentialKind,
} from './claude-credential-kinds.js';

const ConfigShape = M.splitRecord(
  {
    ownerId: M.string(),
    directory: M.string(),
    imageRef: M.string(),
    imageDigest: M.string(),
    listenerImageRef: M.string(),
    credentialKind: M.or(...CREDENTIAL_KINDS),
    // The account authority this broker serves (`account-authority.js`):
    // the id every plan records and every grant reports.
    accountAuthority: M.string(),
  },
  {
    anthropicBeta: M.string(),
    maxSessions: M.number(),
    publicInternet: M.boolean(),
    diagnostics: M.boolean(),
    pool: M.boolean(),
  },
  harden({}),
);

/**
 * Read an explicit operator profile stored with the unconfined formula.
 * Runtime hooks and secrets are not configuration fields. The broker kit
 * validates image pins, owner/path identity and existing policy values before
 * acquisition; this reader adds no policy defaults or budgets.
 * @param {Record<string, string>} env
 */
export const readClaudeBrokerConfig = env => {
  const text = env.CLAUDE_BROKER_CONFIG;
  typeof text === 'string' || Fail`Missing CLAUDE_BROKER_CONFIG`;
  /** @type {unknown} */
  const config = harden(JSON.parse(text));
  // A profile from before account catalogs admitted models carries an
  // operator model list; it is refused with the way out, not as a shape
  // error, since the broker it belongs to must be retired deliberately.
  !(config && typeof config === 'object' && Object.hasOwn(config, 'models')) ||
    Fail`Retained Claude broker configuration names models, which this release no longer reads (models are admitted by the account's own catalog): retire that broker and the sessions bound to it deliberately, then rerun setup`;
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
    Fail`Retained Claude broker configuration names no account authority, which this release records into every session plan; retire that broker deliberately and set ENDO_CLAUDE_ACCOUNT_AUTHORITY for the next mint`;
  if (!matches(config, ConfigShape))
    throw Fail`Invalid Claude broker configuration`;
  config.pool !== true ||
    config.credentialKind === 'oauthToken' ||
    Fail`Claude pools require oauthToken credentials`;
  assertAccountAuthority(config.accountAuthority, 'Claude');
  // What the broker grant refuses at every admission is refused here, at
  // construction, where a retained formula would otherwise be bound unusable.
  config.anthropicBeta === undefined ||
    ANTHROPIC_BETA_PATTERN.test(config.anthropicBeta) ||
    Fail`Invalid Claude broker configuration: anthropicBeta ${q(config.anthropicBeta)}`;
  return harden({
    ...config,
    credentialKind: assertCredentialKind(config.credentialKind),
  });
};
harden(readClaudeBrokerConfig);

/**
 * The retained operator entrypoint over the shared owned provider broker
 * service; see `@endo/hosted-agent/provider-broker-service.js`.
 *
 * @param {object} [powers]
 * @param {typeof makeProviderBrokerServiceKit} [powers.makeServiceKit]
 * @param {typeof makeClaudeSubscriptionCredential} [powers.makeCredential]
 * @param {typeof globalThis.fetch} [powers.fetch]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedClaudeBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  makeCredential = makeClaudeSubscriptionCredential,
  fetch = globalThis.fetch,
  reportError = error => console.error('Claude broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'Claude',
    readConfig: readClaudeBrokerConfig,
    makePolicy: config => ({
      policy: {
        ...buildClaudeBrokerPolicy({
          credentialKind: config.credentialKind,
          ...(config.anthropicBeta === undefined
            ? {}
            : { anthropicBeta: config.anthropicBeta }),
        }),
        ...(config.pool === true
          ? { authMode: /** @type {const} */ ('oauth') }
          : {}),
      },
      accountAuthority: config.accountAuthority,
    }),
    makeCredential: (config, secret) =>
      config.pool === true
        ? makeCredential({
            secret,
            rotate: secret,
            // A pool member's own account, supplied for the member; the
            // pool's profile names none.
            accountRef:
              /** @type {{ accountRef?: string }} */ (config).accountRef ??
              Fail`A Claude pool member must name its account`,
            now: Date.now,
            fetch: globalThis.fetch,
          })
        : undefined,
    makeActiveAccountRead: ({ credential }) =>
      credential === undefined
        ? async () => {
            throw Fail`Claude usage requires a subscription pool credential`;
          }
        : makeClaudeAccountRead({ credential, fetch: globalThis.fetch }),
    // What the account may be served, from Anthropic's model list, under the
    // same credential the broker sends inference with: the pool member's
    // renewing OAuth credential, or the one API key or subscription token.
    // Nothing here starts a conversation or a runtime.
    makeModelRead: ({ config, secret, credential }) =>
      makeAnthropicModelRead({
        readAuthorization: async () => {
          if (credential !== undefined) {
            const { state } = await credential.current();
            return harden({ header: 'bearer', token: state.accessToken });
          }
          const token = globalThis.atob(await E(secret).readBase64());
          return harden({
            header:
              config.credentialKind === 'oauthToken' ? 'bearer' : 'x-api-key',
            token,
          });
        },
        fetch,
        anthropicBeta: config.anthropicBeta ?? DEFAULT_OAUTH_BETA,
      }),
    makeServiceKit,
    reportError,
  });
harden(makeOwnedClaudeBrokerService);

/** Unconfined operator entrypoint. The returned facet contains only scopes. */
export const make = makeOwnedClaudeBrokerService();
harden(make);
