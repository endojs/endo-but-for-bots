// @ts-check
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { M } from '@endo/patterns';

/**
 * What a workspace lets the host's registry do to it: resolve the grants an
 * installation names to the inventory values they stand for, and put an
 * installed value under its name. A workspace manages nothing; it holds
 * references to what the host installed, and this is the whole of its part
 * in installing.
 *
 * Shipped by source: this factory is evaluated in the workspace vat, so it
 * may import only what the guest prelude provides, under those names.
 *
 * @param {any} inventory the workspace's observable map
 */
export const makeWorkspaceAccess = inventory => {
  // Shipped by source: the guards travel with the factory, defined here.
  const GrantsShape = M.arrayOf(harden([M.string(), M.string()]));
  const WorkspaceAccessI = M.interface('WorkspaceAccess', {
    help: M.call().returns(M.string()),
    lookupGrants: M.call(GrantsShape).returns(M.record()),
    has: M.call(M.string()).returns(M.boolean()),
    put: M.call(M.string(), M.raw()).returns(M.undefined()),
    remove: M.call(M.string(), M.raw()).returns(M.boolean()),
  });
  /**
   * Whether a value the user put into the inventory is a capability; a value
   * that is not even passable is not, rather than an error to explain.
   * @param {unknown} value
   */
  const isRemotable = value => {
    try {
      return passStyleOf(value) === 'remotable';
    } catch (_error) {
      return false;
    }
  };
  return makeExo('WorkspaceAccess', WorkspaceAccessI, {
    help: () =>
      "The registry's hold on this workspace: lookupGrants(grants) resolves [power, key] pairs to the inventory values under the keys; put(name, value) places an installed value under a free name; remove(name, value) takes it out again if it is still there.",
    /**
     * Admit only remotable capabilities, not potentially large copy data;
     * the wire marshaller validates the complete pass style when they travel.
     * @param {ReadonlyArray<string[]>} grants already matched against
     *   GrantsShape
     */
    lookupGrants: grants => {
      /** @type {Record<string, unknown>} */
      const powers = {};
      for (const [power, key] of grants) {
        !(power in powers) || Fail`Duplicate power name`;
        inventory.has(key) || Fail`Unknown inventory grant`;
        const value = inventory.get(key);
        isRemotable(value) ||
          Fail`Installation grants must be remotable capabilities`;
        Object.defineProperty(powers, power, { value, enumerable: true });
      }
      return harden(powers);
    },
    /** @param {string} name */
    has: name => inventory.has(name),
    /**
     * The installed value takes the name only if nothing else took it
     * meanwhile; a concurrent inventory edit wins, and the installation
     * reports it.
     * @param {string} name
     * @param {unknown} value
     */
    put: (name, value) => {
      name.length > 0 || Fail`Expected an inventory name`;
      !inventory.has(name) ||
        Fail`Inventory name became occupied during installation`;
      inventory.set(name, value);
    },
    /**
     * The inventory entry goes only if it is still the installation's
     * value; a value the user put there since is theirs.
     * @param {string} name
     * @param {unknown} value
     */
    remove: (name, value) => {
      if (!inventory.has(name) || inventory.get(name) !== value) return false;
      inventory.delete(name);
      return true;
    },
  });
};
harden(makeWorkspaceAccess);
