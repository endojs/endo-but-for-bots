// @ts-check
/**
 * The `SecretWriter` (M2 W2.3; D-6; `designs/m2-interfaces.md` 3.4, 9.2):
 * the only object that takes a secret value, and it lives in the agent-host
 * adapter, never in a vat. The gateway calls it in process with the value;
 * the CLI calls it through the hub with a box sealed to `publicKey()`.
 *
 * It finds a `Secret`'s store key by amplification: the manager vat's sink
 * maps the presence it is given (`resolveSecrets`), so the caller proves it
 * holds the Secret by passing it, and no id or name is ever exchanged.
 * A writer belongs to one adapter incarnation: after a restart it is a
 * tombstone and the caller opens a new one (`SecretsAdmin.openWriter`).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { interfaces } from '../../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { secretError } from './store.js';

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {{ publicKey: () => string, open: (box: any) => string }} options.seal
 *   ready sealing keys
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret
 */
export const makeSecretWriter = ({ store, seal, resolveSecret }) =>
  makeExo('SecretWriter', interfaces.SecretWriter, {
    /**
     * @param {any} secret
     * @param {string | { format: string, publicKey: string, box: string }} value
     * @param {number} [expectedGeneration]
     */
    replace: async (secret, value, expectedGeneration) => {
      const key = await resolveSecret(secret);
      if (key === null) throw secretError('UNKNOWN_SECRET');
      const plain = typeof value === 'string' ? value : seal.open(value);
      const generation = await store.replace(key, plain, expectedGeneration);
      return harden({ generation });
    },
    publicKey: () => seal.publicKey(),
  });
harden(makeSecretWriter);
