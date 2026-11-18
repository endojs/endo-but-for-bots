// @ts-check
/**
 * The Secrets panel's daemon objects of one connection (W4.7;
 * m4-interfaces.md 3.3, 9.1): `Operator.getSecrets()` -> the M4
 * `SecretsAdmin`, its writer (`openWriter()`, adapter-local: the value stays
 * in the agent-host process, A-11) and its audit reader (`auditReader()`,
 * adapter-local). Each is asked for once per connection's powers and asked
 * again after a failure, so a reconnect (new powers) starts afresh.
 */
import { E } from '@endo/far';

/**
 * @typedef {object} SecretsObjects
 * @property {() => Promise<any>} admin the M4 `SecretsAdmin`
 * @property {() => Promise<any>} writer the `SecretWriter`
 * @property {() => Promise<any>} reader the `AuditReader`
 */

/** @type {WeakMap<object, SecretsObjects>} */
const byPowers = new WeakMap();

/**
 * A promise kept until it rejects.
 *
 * @param {() => Promise<any>} make
 * @returns {() => Promise<any>}
 */
const once = make => {
  /** @type {Promise<any> | undefined} */
  let kept;
  return () => {
    if (!kept) {
      const made = make();
      kept = made;
      made.catch(() => {
        if (kept === made) kept = undefined;
      });
    }
    return kept;
  };
};

/**
 * @param {any} powers the connection's `GatewayPowers`
 * @returns {SecretsObjects}
 */
export const secretsOf = powers => {
  let found = byPowers.get(powers);
  if (!found) {
    const admin = once(() => E(powers.operator).getSecrets());
    found = harden({
      admin,
      writer: once(async () => {
        const secrets = await admin();
        return E(secrets).openWriter();
      }),
      reader: once(async () => {
        const secrets = await admin();
        return E(secrets).auditReader();
      }),
    });
    byPowers.set(powers, found);
  }
  return found;
};
