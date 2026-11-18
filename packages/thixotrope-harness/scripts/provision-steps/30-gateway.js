// @ts-check
/**
 * M3's provisioning step (W3.7, m3-interfaces.md 11 H5), a registered step
 * file (`scripts/provision-steps.js` header): `gateway` serves the chat
 * gateway with `options.gateway` and the harness's `Operator`
 * (`GatewayAdmin.serve`), skipped without `options.gateway` (tests serve
 * their own on port 0) and when the gateway already serves that port and
 * origin (the kit restores it at every start, so serving again is never
 * needed). A trusted-proxy or ceiling change on the same port and origin
 * is not seen by `status()`: stop the gateway first (`scripts/gateway.mjs`).
 */
import { E } from '@endo/far';

import { names } from '../provision-steps.js';

/**
 * @typedef {{ port: number, publicOrigin?: string, trustedProxies?: string[], signInFailuresPerMinute?: number }} GatewayOption
 *   M3 (H5): `GatewayAdmin.serve` settings; the step adds the `Operator`
 */

/** @type {import('../provision-steps.js').ProvisionStep[]} */
export const steps = harden([
  {
    name: 'gateway',
    run: async ({ client, options }) => {
      const wanted = /** @type {GatewayOption | undefined} */ (options.gateway);
      if (wanted === undefined) return { skipped: true };
      const admin = await client.call('lookup', names.agentHost);
      const gateway = await E(admin).gateway();
      const before = await E(gateway).status();
      const sameOrigin =
        wanted.publicOrigin === undefined
          ? before.origin === `http://127.0.0.1:${before.port}`
          : before.origin === wanted.publicOrigin;
      if (
        before.state === 'serving' &&
        wanted.port !== 0 &&
        before.port === wanted.port &&
        sameOrigin
      )
        return { skipped: true, detail: { port: before.port } };
      const harness = await client.call('lookup', names.harness);
      const operator = await E(harness).getOperator();
      const status = await E(gateway).serve(harden({ ...wanted, operator }));
      if (status.state !== 'serving')
        throw Error(status.error ?? `the gateway is ${status.state}`);
      return {
        skipped: false,
        detail: { port: status.port, origin: status.origin },
      };
    },
  },
]);
