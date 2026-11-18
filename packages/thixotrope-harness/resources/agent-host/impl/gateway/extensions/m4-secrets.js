// @ts-check
/**
 * M4's gateway extension (W4.6; `designs/m4-interfaces.md` 9.1 item 3; M3's
 * registry `AH/gateway/extensions/<name>.js`, `contract-m3.js`
 * `GatewayExtension`).
 *
 * The frame guard refuses a call body over `frameBytes` unless its target
 * and method are a registered `LargeCall`. This file registers the
 * incarnation's one `SecretWriter` (`context.secretWriter()`, the object a
 * page reaches through `SecretsAdmin.openWriter()`) and its `replace`, so a
 * secret value typed in the browser up to `m4Limits.browserSecretBytes`
 * reaches the writer in process and never crosses the hub (D-6). Only the
 * gateway's WebSocket message bound then holds.
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
