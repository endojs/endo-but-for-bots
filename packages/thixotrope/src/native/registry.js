// @ts-check
import harden from '@endo/harden';

/**
 * Workspace bookkeeping, not manager state. Retaining the worker facade roots
 * an unfinished installation until its registration is ready for inventory.
 * This self-contained factory is evaluated in the workspace.
 * @param {any} inventory
 */
export const makeNativeResourceRegistry = inventory => {
  /** @type {Map<string, {digest: string, allocationKey: string, workerId?: string, worker?: any, registration?: any, complete: boolean}>} */
  const installed = new Map();
  /** @param {string} name @param {string} digest */
  const entryFor = (name, digest) => {
    const entry = installed.get(name);
    if (!entry || entry.digest !== digest)
      throw Error('Native resource name has a different installation');
    return entry;
  };
  return harden({
    /** @param {string} name @param {string} digest @param {string} allocationKey */
    prepare: (name, digest, allocationKey) => {
      if (typeof name !== 'string' || !name.length)
        throw Error('Expected an inventory name');
      let entry = installed.get(name);
      if (entry) {
        entryFor(name, digest);
      } else {
        if (inventory.has(name))
          throw Error('Inventory name is already occupied');
        entry = { digest, allocationKey, complete: false };
        installed.set(name, entry);
      }
      return harden({
        allocationKey: entry.allocationKey,
        workerId: entry.workerId,
        complete: entry.complete,
      });
    },
    /** @param {string} name @param {string} digest @param {string} workerId @param {any} worker */
    attach: (name, digest, workerId, worker) => {
      const entry = entryFor(name, digest);
      if (entry.workerId !== undefined && entry.workerId !== workerId)
        throw Error('Native manager allocation changed');
      entry.workerId = workerId;
      entry.worker = worker;
    },
    /** @param {string} name @param {string} digest @param {any} registration */
    finish: (name, digest, registration) => {
      const entry = entryFor(name, digest);
      if (entry.complete) return;
      if (entry.workerId === undefined)
        throw Error('Native manager has not been allocated');
      if (inventory.has(name))
        throw Error('Inventory name became occupied during installation');
      inventory.set(name, registration);
      entry.registration = registration;
      entry.complete = true;
    },
  });
};
harden(makeNativeResourceRegistry);
