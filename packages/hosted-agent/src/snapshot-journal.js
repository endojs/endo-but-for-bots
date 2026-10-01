// @ts-check

import { E } from '@endo/eventual-send';

/**
 * A versioned snapshot journal over an Endo pet store.
 *
 * Each write publishes a complete snapshot under a unique sequence name before
 * pruning old entries. Reads take the highest-numbered entry; this is not an
 * event log or a new state owner. The caller owns its namespace, record shape,
 * fixed prefix and single writer, including draining that writer at handoff.
 * Independent journal instances do not coordinate writes to the same prefix.
 *
 * @param {object} options
 * @param {any} options.powers - A namespace with list/lookup/storeValue/remove.
 * @param {string} options.prefix - The caller's existing persisted name prefix.
 * @param {number} [options.keep] - Older snapshots to retain.
 */
export const makeSnapshotJournal = ({ powers, prefix, keep = 4 }) => {
  const sequenceWidth = 20;
  const namePattern = new RegExp(`^${prefix}[0-9]{${sequenceWidth}}$`);
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  const listNames = async () => {
    const names = await E(powers).list();
    return (Array.isArray(names) ? names : [])
      .filter(name => typeof name === 'string' && namePattern.test(name))
      .sort();
  };

  return harden({
    read: async () => {
      const names = await listNames();
      if (names.length === 0) return undefined;
      return E(powers).lookup(names[names.length - 1]);
    },
    /** @param {any} snapshot */
    write: async snapshot => {
      const result = writeChain.then(async () => {
        const names = await listNames();
        const last = names[names.length - 1];
        const sequence = last ? BigInt(last.slice(prefix.length)) + 1n : 0n;
        const name = `${prefix}${`${sequence}`.padStart(sequenceWidth, '0')}`;
        await E(powers).storeValue(snapshot, name);
        // Trim only after the new snapshot is durable, so the journal is never
        // momentarily empty.
        for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
          // eslint-disable-next-line no-await-in-loop
          await E(powers)
            .remove(stale)
            .catch(() => {});
        }
      });
      writeChain = result.catch(() => {});
      return result;
    },
  });
};
harden(makeSnapshotJournal);
