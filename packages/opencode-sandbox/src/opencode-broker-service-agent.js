// @ts-check

import { Fail } from '@endo/errors';
import { M, matches } from '@endo/patterns';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';

import {
  OPENCODE_BROKER_ACCOUNT,
  buildOpencodeBrokerPolicy,
} from './opencode-broker.js';

const ConfigShape = M.splitRecord(
  {
    ownerId: M.string(),
    directory: M.string(),
    imageRef: M.string(),
    imageDigest: M.string(),
    listenerImageRef: M.string(),
    models: M.arrayOf(M.string()),
  },
  { maxSessions: M.number(), publicInternet: M.boolean() },
  harden({}),
);

/**
 * Read an explicit operator profile stored with the unconfined formula.
 * Runtime hooks and secrets are not configuration fields. The broker kit
 * validates image pins, owner/path identity and existing policy values before
 * acquisition; this reader adds no policy defaults or budgets.
 * @param {Record<string, string>} env
 */
export const readOpencodeBrokerConfig = env => {
  const text = env.OPENCODE_BROKER_CONFIG;
  typeof text === 'string' || Fail`Missing OPENCODE_BROKER_CONFIG`;
  /** @type {unknown} */
  const config = harden(JSON.parse(text));
  if (!matches(config, ConfigShape))
    throw Fail`Invalid OpenCode broker configuration`;
  return config;
};
harden(readOpencodeBrokerConfig);

/**
 * The retained operator entrypoint over the shared owned provider broker
 * service; see `@endo/hosted-agent/provider-broker-service.js`.
 *
 * @param {object} [powers]
 * @param {typeof makeProviderBrokerServiceKit} [powers.makeServiceKit]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedOpencodeBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  reportError = error =>
    console.error('OpenCode broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'OpenCode',
    readConfig: readOpencodeBrokerConfig,
    makePolicy: config => ({
      policy: buildOpencodeBrokerPolicy({ models: config.models }),
      accountRef: OPENCODE_BROKER_ACCOUNT,
    }),
    makeServiceKit,
    reportError,
  });
harden(makeOwnedOpencodeBrokerService);

/** Unconfined operator entrypoint. The returned facet contains only scopes. */
export const make = makeOwnedOpencodeBrokerService();
harden(make);
