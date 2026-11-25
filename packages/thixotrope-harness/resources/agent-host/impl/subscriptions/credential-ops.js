// @ts-check
/**
 * The `CredentialOps` facet (M4 W4.6; `designs/m4-interfaces.md` 3.2, 4.1;
 * H-3: the manager reaches it as `ops.credentials()`).
 *
 * The manager vat is its only caller. It fills the Secrets catalogue's
 * generation, state and bytes (`describeSecrets`, one call per page), keeps
 * the store's audit labels in step with a description edit
 * (`setSecretDescription`), and hands out the adapter-local `AuditReader`
 * and `Accounts` (R7-63, R4-84). No method answers a value (R7-26).
 * `poolsChanged()` (answered, XB, X-FIX: the manager's retirement returns
 * only after this answer) is the manager's word that it retired a
 * pool or a member, or added a member to a pool: every pool this
 * incarnation loaded is asked again at its next use (m4-interfaces 3.1:
 * the next turn fails or skips the member, or may choose the new one).
 * `checkCredential(secret, provider)` reads the Secret once (resolved by
 * presence; an audited store read) and answers `{ ok: true }` or
 * `{ ok: false, code }` (`checkCredentialValue`): the value stays here.
 *
 * The store is the incarnation's one Secrets store (m4-interfaces 8,
 * assumption 4): read from `secrets().store` at call time, so this facet
 * can be made before the Secrets operations are (they are made on first
 * use, `AH/index.js`). The audit reader resolves a `Secret` filter with the
 * Secrets operations' cached resolver when they export one, else with this
 * facet's own cache over `sink.resolveSecrets` (one manager crank per new
 * Secret per incarnation).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { m4Interfaces } from '../../../../guest/lib/interfaces-m4.js';
import { textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { makeAuditReader } from '../secrets/audit.js';
import { describeKeys } from '../secrets/catalog.js';
import { checkCredentialValue } from './credentials.js';

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
const lazy = value =>
  typeof value === 'function' ? /** @type {() => T} */ (value)() : value;

/**
 * A resolver of `Secret` presences to store keys over the manager's sink,
 * cached per presence for this incarnation (as `makeSecretsOps` does).
 * @param {any} sink the `AgentHostSink`, or a function answering it
 * @returns {(secret: any) => Promise<string | null>}
 */
export const makeSecretResolver = sink => {
  /** @type {WeakMap<any, string>} */
  const keys = new WeakMap();
  return async secret => {
    const known = keys.get(secret);
    if (known !== undefined) return known;
    const target = lazy(sink);
    if (target === undefined) throw Error('the agent host is not attached');
    const [key] = await E(target).resolveSecrets(harden([secret]));
    if (typeof key !== 'string' || key.length > limits.idUnits) return null;
    keys.set(secret, key);
    return key;
  };
};
harden(makeSecretResolver);

/** Store failure codes a check answers as they are; any other is `READ_FAILED`. */
const STORE_CODES = harden(['REVOKED', 'UNKNOWN_SECRET']);

/**
 * @param {object} options
 * @param {any} options.secrets the Secrets operations (or a function
 *   answering them): `store` is read from them at call time
 * @param {any} options.accounts the `Accounts` exo, or a function answering
 *   it (W4.5's `AccountsCore.accounts`)
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret
 *   the audit reader's `Secret` filter
 * @param {() => void} [options.poolsChanged] marks the loaded pool states
 *   stale (`makeSubscriptions`)
 * @param {() => number} [options.now] the clock of `checkCredential`'s
 *   expiry rule
 */
export const makeCredentialOps = ({
  secrets,
  accounts,
  resolveSecret,
  poolsChanged = () => {},
  now = () => Date.now(),
}) => {
  const storeOf = () => {
    const store = lazy(secrets)?.store;
    if (store === undefined) throw Error(textOf.notBuilt('credentials'));
    return store;
  };
  /** One reader per incarnation (it holds no state of its own). */
  /** @type {any} */
  let reader;
  return makeExo('CredentialOps', m4Interfaces.CredentialOps, {
    /** @param {string[]} keys */
    describeSecrets: keys => describeKeys({ store: storeOf(), keys }),
    /**
     * @param {string} key
     * @param {string} text
     */
    setSecretDescription: async (key, text) => {
      await storeOf().setDescription(key, text);
      return undefined;
    },
    auditReader: () => {
      reader ??= makeAuditReader({ store: storeOf(), resolveSecret });
      return reader;
    },
    accounts: () => lazy(accounts),
    poolsChanged: () => {
      poolsChanged();
      return undefined;
    },
    /**
     * @param {any} secret
     * @param {'claude' | 'codex'} provider
     */
    checkCredential: async (secret, provider) => {
      const key = await resolveSecret(secret);
      if (key === null) return harden({ ok: false, code: 'UNKNOWN_SECRET' });
      /** @type {string} */
      let value;
      try {
        ({ value } = await storeOf().read(key));
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        return harden({
          ok: false,
          code: STORE_CODES.includes(code) ? code : 'READ_FAILED',
        });
      }
      return checkCredentialValue(value, provider, now());
    },
  });
};
harden(makeCredentialOps);
