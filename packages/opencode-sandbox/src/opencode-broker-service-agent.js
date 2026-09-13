// @ts-check

import { Fail } from '@endo/errors';
import { M, matches } from '@endo/patterns';
import { makeOwnedNativeService } from '@endo/sandbox/owned-native-service.js';

import { makeOpencodeBrokerServiceKit } from './opencode-broker-service.js';

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
 * Construct a module-instance retained operator entrypoint. Its sole powers
 * argument is the original SecretBlob read facet, not a host or session powers
 * bundle. Provision makeUnconfined with that secret's name as powersName once:
 * the daemon formula stores the resolved powers ID and retains its dependency.
 * Subsequent sessions never look up a secret through a mutable namespace.
 *
 * Cancellation reaches the retained broker kit even during later lazy opening.
 * Failed cleanup remains in the shared native-owner registry until a subsequent
 * invocation retries it; live duplicates refuse without affecting the original.
 * Separate processes still depend on the broker runtime's native ownership
 * checks, and process loss is not a cleanup acknowledgement.
 *
 * @param {object} [powers]
 * @param {typeof makeOpencodeBrokerServiceKit} [powers.makeServiceKit]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOwnedOpencodeBrokerService = ({
  makeServiceKit = makeOpencodeBrokerServiceKit,
  reportError = error =>
    console.error('OpenCode broker cleanup pending', error),
} = {}) => {
  /**
   * @param {ReturnType<typeof readOpencodeBrokerConfig>} config
   * @param {{readBase64(): Promise<string>}} secret
   * @param {Record<string,string>} env
   */
  const makeKit = (config, secret, env) => {
    const kit = makeServiceKit({ ...config, secret, env });
    return harden({ open: async () => kit.service, close: kit.close });
  };
  return makeOwnedNativeService({
    readConfig: readOpencodeBrokerConfig,
    makeKit,
    reportError,
  });
};
harden(makeOwnedOpencodeBrokerService);

/** Unconfined operator entrypoint. The returned facet contains only scopes. */
export const make = makeOwnedOpencodeBrokerService();
harden(make);
