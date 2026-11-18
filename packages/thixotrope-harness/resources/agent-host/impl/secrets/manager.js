// @ts-check
/**
 * The adapter's Secrets operations (M2 W2.3; D-6; `designs/m2-interfaces.md`
 * sections 3.3, 3.4 and 9): the ops-facet handlers the manager vat forwards
 * to (`secretCreate`, `secretDescribe`, `secretRevoke`, `secretDelete`,
 * `secretAudit`, `secretWriter`) and the providers' read path (`readKey`).
 *
 * The manager vat holds the durable identities (`SecretsAdmin`, `Secret`,
 * `ReadGrant`) and the map from each to its key `k<n>`; this module holds
 * the values (through the store) and, per adapter incarnation, a cache of
 * the keys of the grants and secrets it has met, so a provider's read costs
 * one manager crank per grant per incarnation and nothing per round after
 * that (`sink.resolveGrants`, `sink.resolveSecrets`, at most
 * `blobResolveBatch` per call). The value is read again every round
 * (R4-82, R7-28): a replace takes effect at the next round, a revoke fails
 * the next read.
 *
 * Wiring (m2-interfaces 2.3): `AH/index.js` spreads these handlers into its
 * ops handlers and passes `readKey` to the API providers; the files come
 * from `findSecretsFiles({ stateDir, env })`.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { secretError } from './store.js';
import { makeSecretWriter } from './writer.js';
import { makeCredentialAccess } from './credential-access.js';

/**
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
const resolveLazy = value =>
  typeof value === 'function' ? /** @type {() => T} */ (value)() : value;

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {ReturnType<typeof import('./seal.js').makeSealKeys>} options.seal
 * @param {any} options.sink the manager's `AgentHostSink`, or a function
 *   returning the current one (it is known only after the attach)
 */
export const makeSecretsOps = ({ store, seal, sink }) => {
  /** Grant presence -> key, this incarnation. @type {WeakMap<any, string>} */
  const grantKeys = new WeakMap();
  /** Secret presence -> key, this incarnation. @type {WeakMap<any, string>} */
  const secretKeys = new WeakMap();
  /** @type {any} */
  let writer;

  /**
   * @param {WeakMap<any, string>} cache
   * @param {'resolveGrants' | 'resolveSecrets'} method
   * @param {any} handle
   * @returns {Promise<string | null>}
   */
  const keyOf = async (cache, method, handle) => {
    const known = cache.get(handle);
    if (known !== undefined) return known;
    const [key] = await E(resolveLazy(sink))[method](harden([handle]));
    if (typeof key !== 'string' || key.length > limits.idUnits) return null;
    cache.set(handle, key);
    return key;
  };

  /** @param {any} secret */
  const resolveSecret = secret => keyOf(secretKeys, 'resolveSecrets', secret);

  /**
   * The value behind a read grant, read now and audited (R7-24). Fails
   * `UNKNOWN_GRANT`, `UNKNOWN_SECRET`, `REVOKED` or `READ_FAILED`.
   * @param {any} grant a `ReadGrant` presence (from a backend spec)
   * @returns {Promise<string>}
   */
  const readKey = async grant => {
    const key = await keyOf(grantKeys, 'resolveGrants', grant);
    if (key === null) throw secretError('UNKNOWN_GRANT');
    await store.ready();
    return store.readNow(key).value;
  };

  return harden({
    /** @param {{ key: string, label: string, description: string }} request */
    secretCreate: ({ key, label, description }) =>
      store.create(key, label, description),
    /** @param {string} key */
    secretDescribe: async key => {
      const { generation, state, bytes } = await store.describe(key);
      return harden({ generation, state, bytes });
    },
    /** @param {string} key */
    secretRevoke: key => store.revoke(key),
    /** @param {string} key */
    secretDelete: key => store.delete(key),
    /** @param {{ key?: string, limit: number }} request */
    secretAudit: ({ key, limit }) =>
      store.audit(key === undefined ? { limit } : { key, limit }),
    /** One writer per incarnation, made once the sealing keys are ready. */
    secretWriter: async () => {
      if (writer === undefined) {
        await Promise.all([store.ready(), seal.ready()]);
        writer ??= makeSecretWriter({ store, seal, resolveSecret });
      }
      return writer;
    },
    readKey,
    /**
     * M4 H-5 (W-5): the accessor of one key, read (audited) and replace
     * conditioned on a generation, nothing else; the renewal of a pool
     * member holds this and not the store (m4-interfaces 7).
     * @param {string} key
     */
    credentialFor: key => makeCredentialAccess({ store, key }),
    /**
     * M4 W4.8: the incarnation's store and cached resolver, read by the
     * `CredentialOps` facet (catalogue, description, audit reader;
     * m4-interfaces 8 assumption 4) and the audit reader's `Secret` filter.
     * Adapter-local: nothing here reaches a vat.
     */
    store,
    resolveSecret,
  });
};
harden(makeSecretsOps);
