// @ts-check
/**
 * The environments provisioning steps (`designs/m6-interfaces.md` seam
 * P-2, D-M6-3, D-M6-12), a registered step file (`scripts/provision-steps.js`
 * header): install the environments native resource, configure it with
 * `options.environments` (an `EnvironmentSettings`: runtime, allowlist,
 * image pin, limits), and attach its admin to the factory as the
 * `environments` setting (`HarnessRoot.configure`). Each step is skipped
 * without `options.environments`.
 *
 * Idempotent: the install is skipped when the inventory holds the admin;
 * `configure` with equal settings changes nothing in the manager (the
 * registration's `same`: it only reattaches); attaching the same admin
 * again sets the same handle.
 */
import path from 'node:path';

import { E } from '@endo/far';

import { harnessRoot, has, names } from '../provision-steps.js';

/** The inventory name of the environments admin (F.2 c). */
export const environmentsAdminName = 'environmentsAdmin';

/** The environments native resource directory. */
export const environmentsDirectory = path.join(
  harnessRoot,
  'resources',
  'environments',
);

/**
 * The settings asked for, as the manager's `EnvironmentSettings` (fields
 * left out are not sent).
 * @param {Record<string, unknown>} options
 */
const settingsOf = options => {
  const wanted = /** @type {Record<string, unknown> | undefined} */ (
    options.environments
  );
  if (wanted === undefined) return undefined;
  return harden(
    Object.fromEntries(
      Object.entries(wanted).filter(([, value]) => value !== undefined),
    ),
  );
};

/** @type {import('../provision-steps.js').ProvisionStep[]} */
export const steps = harden([
  {
    name: 'install-native environments',
    run: async ({ client, options }) => {
      if (settingsOf(options) === undefined) return { skipped: true };
      if (await has(client, environmentsAdminName)) return { skipped: true };
      await client.call(
        'installNative',
        environmentsAdminName,
        environmentsDirectory,
      );
      return { skipped: false };
    },
  },
  {
    name: 'configure environments',
    run: async ({ client, options }) => {
      const settings = settingsOf(options);
      if (settings === undefined) return { skipped: true };
      const admin = await client.call('lookup', environmentsAdminName);
      // A refused image is the runner's state, not a provisioning failure
      // (R8-42: every command then fails with `imageRefused`); the detail
      // says so.
      const status = await E(admin).configure(settings);
      return {
        skipped: false,
        detail: {
          state: status.state,
          ...(status.runtime === undefined ? {} : { runtime: status.runtime }),
          ...(status.error === undefined ? {} : { error: status.error }),
        },
      };
    },
  },
  {
    name: 'attach environments',
    run: async ({ client, options }) => {
      if (settingsOf(options) === undefined) return { skipped: true };
      const admin = await client.call('lookup', environmentsAdminName);
      const harness = await client.call('lookup', names.harness);
      await E(harness).configure(harden({ environments: admin }));
      return { skipped: false };
    },
  },
]);
