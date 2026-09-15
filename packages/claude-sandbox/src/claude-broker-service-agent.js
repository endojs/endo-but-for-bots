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
 *                         listenerImageRef, models, credentialKind, and
 *                         optional anthropicBeta, maxSessions, publicInternet.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';
import { M, matches } from '@endo/patterns';

import {
  ANTHROPIC_BETA_PATTERN,
  CLAUDE_BROKER_ACCOUNT,
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
    models: M.arrayOf(M.string()),
    credentialKind: M.or(...CREDENTIAL_KINDS),
  },
  {
    anthropicBeta: M.string(),
    maxSessions: M.number(),
    publicInternet: M.boolean(),
    diagnostics: M.boolean(),
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
  if (!matches(config, ConfigShape))
    throw Fail`Invalid Claude broker configuration`;
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
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedClaudeBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  reportError = error => console.error('Claude broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'Claude',
    readConfig: readClaudeBrokerConfig,
    makePolicy: config => ({
      policy: buildClaudeBrokerPolicy({
        models: config.models,
        credentialKind: config.credentialKind,
        ...(config.anthropicBeta === undefined
          ? {}
          : { anthropicBeta: config.anthropicBeta }),
      }),
      accountRef: CLAUDE_BROKER_ACCOUNT,
    }),
    makeServiceKit,
    reportError,
  });
harden(makeOwnedClaudeBrokerService);

/** Unconfined operator entrypoint. The returned facet contains only scopes. */
export const make = makeOwnedClaudeBrokerService();
harden(make);
