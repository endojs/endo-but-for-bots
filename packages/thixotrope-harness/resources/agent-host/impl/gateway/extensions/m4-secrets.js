// @ts-check
/**
 * M4's gateway extension (W4.6; `designs/m4-interfaces.md` 9.1 item 3; M3's
 * registry `AH/gateway/extensions/<name>.js`, `contract-m3.js`
 * `GatewayExtension`).
 *
 * The frame guard refuses a call body over `frameBytes` unless its target
 * and method are a registered `LargeCall`. This file registers the
 * gateway's in-process secret writer (`context.secretWriter()`, the object a
 * page finds in `GatewayPowers.extras` under `secretWriterLabel`; M2's
 * `replaceLocal` behind it) and its `replace`, so a secret value typed in the
 * browser up to `m4Limits.browserSecretBytes` reaches the store in process
 * and never crosses the hub (D-6, m3-interfaces A-11). Only the gateway's
 * WebSocket message bound then holds. The hub's `SecretWriter`
 * (`SecretsAdmin.openWriter()`) takes a `SealedBox` only.
 *
 * A synchronous module with no imports, as M3's loader asks.
 */

/** @type {import('../contract-m3.js').GatewayExtension} */
export const gatewayExtension = harden({
  name: 'm4-secrets',
  largeCalls: [
    {
      target: context => context.secretWriter(),
      methods: ['replace'],
    },
  ],
});
