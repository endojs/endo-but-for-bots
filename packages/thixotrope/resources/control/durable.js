// @ts-check
/** @import { GuestGlobals } from '../../guest.js' */
/** @import { NativeDurablePowers, NativeDurableKit } from '../../src/native/contract.js' */
import harden from '@endo/harden';

// The rest of the prelude is read off globalThis, as in the vat; `harden`
// is imported so the module loads in a host that has not locked down, since
// the supervisor imports it to ship `make` by source.
const { makeExo, M } = /** @type {GuestGlobals} */ (globalThis);

/**
 * What this side registers under the socket path and the adapter listens
 * on: the path, and the host's administration, whose `connect()` makes the
 * per-connection facet each client's session starts from.
 * @typedef {object} ControlSpec
 * @property {string} path
 * @property {any} admin
 */

/**
 * The control socket: the local administration listener as a native
 * resource. The listener is the adapter's, a process that accepts each
 * client's OCapN session on the Unix socket and relays it to a facet the
 * host's administration makes for that connection, so the operator's
 * authority stays host code and works while vats are broken; this side only
 * keeps the one registration, the path and the administration, durable for
 * free, and rebuilds the adapter at every start and after it exits.
 *
 * Process creation and restart are the manager kit's; listening is the
 * adapter's. The supervisor ships this factory by source, so it may use
 * only the guest prelude and what it defines inside itself.
 * @param {NativeDurablePowers & { admin: any }} powers
 * @returns {NativeDurableKit}
 */
export const make = ({ makeManager, admin }) => {
  const PathShape = M.string({ stringLengthLimit: 4096 });
  const ControlI = M.interface('ControlSocket', {
    help: M.call().returns(M.string()),
    serve: M.call(PathShape).returns(M.promise()),
    status: M.call().returns(M.promise()),
    close: M.call().returns(M.promise()),
  });
  /** @type {ReturnType<typeof makeManager>} */
  const manager = makeManager({
    label: 'Control socket',
    /**
     * @param {ControlSpec} existing
     * @param {ControlSpec} wanted
     */
    same: (existing, wanted) =>
      existing.path === wanted.path && existing.admin === wanted.admin,
    // The same path with another administration takes the new one.
    replaces: () => true,
    /**
     * @param {unknown} key
     * @param {ControlSpec | undefined} spec
     * @param {'bound' | 'inactive' | 'closed'} state
     * @param {string} [error]
     */
    describe: (key, spec, state, error) =>
      harden({
        path: key,
        status: state === 'bound' ? 'listening' : state,
        ...(error === undefined ? {} : { error }),
      }),
  });
  /** The one registration's handle and path, kept across restarts. */
  /** @type {any} */
  let handle;
  /** @type {string | undefined} */
  let served;
  const facet = makeExo('ControlSocket', ControlI, {
    help: () =>
      'serve(path) listens for local administration sessions on the Unix socket at path, each starting from a facet of its own that the administration this resource was provided makes; status() reports the listener; close() stops it.',
    /**
     * Listen at the path, or report the listener already there. A
     * registration the adapter could not take would otherwise wait in
     * silence until the next rebuild; the caller hears about it instead.
     * @param {string} path
     */
    serve: async path => {
      if (handle !== undefined && served !== path) {
        const closing = handle;
        handle = undefined;
        served = undefined;
        await closing.close();
      }
      if (handle === undefined) {
        handle = await manager.register(path, harden({ path, admin }));
        served = path;
      }
      const status = /** @type {{status: string, error?: string}} */ (
        await handle.status()
      );
      if (status.status === 'inactive') {
        // Nothing stays desired across lifetimes for a path this side could
        // not take, which the host may be serving itself.
        const closing = handle;
        handle = undefined;
        served = undefined;
        await closing.close();
        throw Error(
          `Control socket not served: ${status.error ?? 'adapter unavailable'}`,
        );
      }
      return status;
    },
    status: async () =>
      handle === undefined ? harden({ status: 'closed' }) : handle.status(),
    close: async () => {
      if (handle === undefined) return false;
      const closing = handle;
      handle = undefined;
      served = undefined;
      return closing.close();
    },
  });
  return harden({ facet, lifecycle: manager.lifecycle });
};
harden(make);
