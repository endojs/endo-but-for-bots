// @ts-check
/**
 * Entry point for instantiating a static asset server as a formulated
 * Endo caplet via `host.makeUnconfined`.
 *
 * The server runs in an unconfined Node worker so it can hold a real
 * `node:http` listening socket. The formula value is the
 * `AssetServerAdmin` exo: `list()`, `getTarget(id)`, `revoke(id)`,
 * `stop()`, and `publisher()` for the serve-only facet, whose
 * `serve(target)` mounts a Filesystem, Mount or Git capability under a
 * fresh capability path. Made with a host agent of its own as powers,
 * the server is the retention root for what it serves: it keeps a
 * read-only facet of each capability in that agent's pet store, and
 * restores every route when it is next incarnated. A route ends only
 * when it is revoked.
 *
 * Configuration is via environment variables passed through
 * `makeUnconfined({ env: [...] })`:
 *
 *   ENDO_FS_ASSET_SERVER_PORT         Optional. Port to listen on.
 *                                     `0` / unset asks the OS to
 *                                     assign one (read it back with
 *                                     `E(server).getAddress()`).
 *
 *   ENDO_FS_ASSET_SERVER_HOST         Optional. Interface to bind.
 *                                     Defaults to `127.0.0.1`
 *                                     (loopback only). Set to
 *                                     `0.0.0.0` to expose on all
 *                                     interfaces.
 *
 *   ENDO_FS_ASSET_SERVER_PUBLIC_BASE  Optional. Origin to advertise
 *                                     in returned URLs when the
 *                                     server sits behind a proxy,
 *                                     e.g. `https://assets.example`.
 *
 * End-to-end recipe (see README.md): give the server a host agent of its own
 * as `powersName` (`provideHost(handle, { agentName })` — the agent, not the
 * handle), name the result `assets-admin`, derive the serve-only facet as a
 * formula (`evaluate('@main', 'E(admin).publisher()', ['admin'],
 * ['assets-admin'], 'assets')`), and pin all three.
 */

import { E } from '@endo/eventual-send';
import { makeNodeHttpBackend } from '@endo/platform/http/node';

import { makeAssetServerKit } from './asset-server.js';
import { makeEndoAssetStore } from './endo-store.js';

const STORE_METHODS = ['provideSubMount', 'storeValue', 'lookup', 'list', 'has', 'remove'];

/**
 * @param {unknown} powers  the server's own Endo host agent (pass its pet
 *   name as `powersName`). Its pet store is where the server retains what it
 *   serves, so it must belong to the server alone. Without one the server
 *   still runs and retains in memory only: every route is lost on restart,
 *   and it says so once at startup.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [opts]
 * @returns {Promise<object>} the `AssetServerAdmin` exo; `publisher()` is the
 *   serve-only facet to hand out.
 */
export const make = async (powers, _context, opts = {}) => {
  const env = opts.env || {};

  const portStr = env.ENDO_FS_ASSET_SERVER_PORT;
  // Port 0 (OS-assigned) is falsy, so test the empty string rather
  // than truthiness.
  const port = portStr !== undefined && portStr !== '' ? Number(portStr) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `asset-server-module: env.ENDO_FS_ASSET_SERVER_PORT must be an integer in 0..65535, got ${JSON.stringify(
        portStr,
      )}`,
    );
  }

  const host = env.ENDO_FS_ASSET_SERVER_HOST || '127.0.0.1';
  const publicBase = env.ENDO_FS_ASSET_SERVER_PUBLIC_BASE;

  const getRandomValues = bytes => globalThis.crypto.getRandomValues(bytes);

  // No powers at all is a deliberate choice of an in-memory server, and is
  // said out loud. Powers that are not a host agent are a mistake — a handle
  // in place of its agent, a guest — and running anyway would look durable
  // and lose every route at the next restart, so that is refused.
  const durable = powers !== undefined && powers !== null;
  if (durable) {
    /** @type {string[]} */
    let methods;
    try {
      // eslint-disable-next-line no-underscore-dangle
      methods = await E(powers).__getMethodNames__();
    } catch (cause) {
      throw new Error(
        `asset-server-module: powers could not be introspected: ${/** @type {Error} */ (cause).message}`,
      );
    }
    const missing = STORE_METHODS.filter(name => !methods.includes(name));
    if (missing.length > 0) {
      throw new Error(
        `asset-server-module: powers must be a host agent of the server's own (pass the agent's pet name as powersName, not its handle); missing ${missing.join(', ')}`,
      );
    }
  } else {
    console.error(
      'asset-server-module: made without powers, so served routes are kept in memory and lost on restart. Make the server with `powersName` naming a host agent of its own.',
    );
  }

  // Wire the platform-agnostic asset server onto the Node HTTP backend.
  const backend = makeNodeHttpBackend();

  const { admin } = await makeAssetServerKit({
    backend,
    getRandomValues,
    port,
    host,
    publicBase,
    ...(durable ? { store: makeEndoAssetStore(/** @type {object} */ (powers)) } : {}),
  });
  return admin;
};
harden(make);
