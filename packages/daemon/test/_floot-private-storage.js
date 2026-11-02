// @ts-check
/* eslint-disable import/no-relative-packages -- Cross-package storage integration. */
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import {
  createPrivateTurnStorage,
  providePrivateTurnStorage,
  providePrivateNetworkStorage,
  retirePrivateTurnStorage,
} from '../../floot/src/private-turn-storage.js';

/** Real worker: no directory presence may cross this boundary. @param {any} host */
export const make = host =>
  Far('PrivateStorageProbe', {
    /** @param {string} id @param {number} count */
    seed: async (id, count) => {
      await createPrivateTurnStorage(host, id);
      const journal = await providePrivateTurnStorage(host, id);
      const network = await providePrivateNetworkStorage(host, id);
      for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        await E(journal).storeValue(
          harden({ event: index }),
          `floot-turn-event-${`${index}`.padStart(20, '0')}`,
        );
      }
      await E(network).storeValue(
        harden({ policy: 'off' }),
        `floot-network-${id.length}-${id}-00000000000000000001`,
      );
      await E(journal).close();
      await E(network).close();
    },
    read: async id => {
      const journal = await providePrivateTurnStorage(host, id);
      const names = await E(journal).list();
      const value = await E(journal).lookup(names.at(-1));
      await E(journal).close();
      return harden({ count: names.length, value });
    },
    retire: id => retirePrivateTurnStorage(host, id),
    ping: () => 'alive',
  });
harden(make);
