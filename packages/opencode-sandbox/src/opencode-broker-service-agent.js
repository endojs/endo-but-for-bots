// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeOpenRouterAccountRead } from '@endo/hosted-agent/openrouter-account-read.js';
import {
  makeOpenRouterModelRead,
  modelsFromOpenRouterCatalog,
} from '@endo/hosted-agent/openrouter-model-read.js';
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
  },
  {
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
export const readOpencodeBrokerConfig = env => {
  const text = env.OPENCODE_BROKER_CONFIG;
  typeof text === 'string' || Fail`Missing OPENCODE_BROKER_CONFIG`;
  /** @type {unknown} */
  const config = harden(JSON.parse(text));
  // A profile from before account catalogs admitted models carries an
  // operator model list; it is refused with the way out, not as a shape
  // error, since the broker it belongs to must be retired deliberately.
  !(config && typeof config === 'object' && Object.hasOwn(config, 'models')) ||
    Fail`Retained OpenCode broker configuration names models, which this release no longer reads (models are admitted by the account's own catalog): retire that broker and the sessions bound to it deliberately, then rerun setup`;
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
 * @param {typeof globalThis.fetch} [powers.fetch]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedOpencodeBrokerService = ({
  makeServiceKit = makeProviderBrokerServiceKit,
  fetch = globalThis.fetch,
  reportError = error =>
    console.error('OpenCode broker cleanup pending', error),
} = {}) =>
  makeOwnedProviderBrokerService({
    label: 'OpenCode',
    readConfig: readOpencodeBrokerConfig,
    makePolicy: () => ({
      policy: buildOpencodeBrokerPolicy({}),
      accountRef: OPENCODE_BROKER_ACCOUNT,
    }),
    // For an account oracle's refresh(): OpenRouter says nothing about the
    // account on inference responses, so this read is its only source.
    makeActiveAccountRead: ({ secret }) =>
      makeOpenRouterAccountRead({
        readKey: async () => globalThis.atob(await E(secret).readBase64()),
        fetch: globalThis.fetch,
      }),
    makeModelRead: ({ secret }) => {
      const read = makeOpenRouterModelRead({
        readKey: async () => globalThis.atob(await E(secret).readBase64()),
        fetch,
      });
      return async () => {
        const result = await read();
        return harden({
          observedAt: result.observedAt,
          models: modelsFromOpenRouterCatalog(result.models),
        });
      };
    },
    makeServiceKit,
    reportError,
  });
harden(makeOwnedOpencodeBrokerService);

/** Unconfined operator entrypoint. The returned facet contains only scopes. */
export const make = makeOwnedOpencodeBrokerService();
harden(make);
