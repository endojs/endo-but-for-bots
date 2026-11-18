// @ts-check
/**
 * The Secrets panel's daemon objects of one connection (W4.7;
 * m4-interfaces.md 3.3, 9.1): `Operator.getSecrets()` -> the M4
 * `SecretsAdmin`, the gateway's in-process secret writer (the
 * `GatewayPowers.extras` service labelled `secretWriterLabel`: the value
 * goes over this page's WebSocket to the agent-host process and never
 * crosses the hub, m3-interfaces A-11; the hub's `openWriter()` takes sealed
 * boxes only) and its audit reader (`auditReader()`, adapter-local). Each is
 * asked for once per connection's powers and asked again after a failure,
 * so a reconnect (new powers) starts afresh.
 */
import { E } from '@endo/far';

import { secretWriterLabel } from '../../../resources/agent-host/impl/gateway/protocol.js';

/** When the gateway offers no secret writer (an older gateway). */
export const noWriterText = 'this gateway offers no secret writer';

/**
 * @typedef {object} SecretsObjects
 * @property {() => Promise<any>} admin the M4 `SecretsAdmin`
 * @property {() => Promise<any>} writer the gateway's in-process writer
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
        const offered = (powers.extras ?? []).find(
          (/** @type {any} */ extra) => extra.label === secretWriterLabel,
        );
        if (!offered) throw Error(noWriterText);
        return offered.service;
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
