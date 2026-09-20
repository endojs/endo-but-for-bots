// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Installed managers live in the workspace, alongside the user's inventory.
 * This factory is evaluated there; install is called locally in that vat so
 * the durable module factory never crosses a process boundary.
 * @param {any} inventory
 * @param {any} makeKeeper
 */
export const makeNativeResourceRegistry = (inventory, makeKeeper) => {
  /** @type {Map<string, {digest: string, registration: any, lifecycle: any}>} */
  const installed = new Map();
  return harden({
    /**
     * @param {string} name
     * @param {string} digest
     * @param {any} make
     * @param {any} adapters
     */
    install: (name, digest, make, adapters) => {
      if (typeof name !== 'string' || !name.length)
        throw Error('Expected an inventory name');
      const previous = installed.get(name);
      if (previous) {
        if (previous.digest !== digest)
          throw Error(
            'Native resource name already installed with different code',
          );
        return previous.registration;
      }
      if (inventory.has(name))
        throw Error('Inventory name is already occupied');
      const kit = make(harden({ E, Far, makeKeeper, adapters }));
      if (
        !kit ||
        kit.registration?.[Symbol.for('passStyle')] !== 'remotable' ||
        kit.lifecycle?.[Symbol.for('passStyle')] !== 'remotable'
      ) {
        throw Error(
          'Native durable module must return registration and lifecycle facets synchronously',
        );
      }
      installed.set(
        name,
        harden({
          digest,
          registration: kit.registration,
          lifecycle: kit.lifecycle,
        }),
      );
      inventory.set(name, kit.registration);
      return kit.registration;
    },
    lifecycle: Far('InstalledNativeResources', {
      started: async () => {
        const results = await Promise.allSettled(
          [...installed.values()].map(kit => E(kit.lifecycle).started()),
        );
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
        }
      },
    }),
  });
};
harden(makeNativeResourceRegistry);
