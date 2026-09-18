// @ts-check
/**
 * Entry point for instantiating a static asset server as a formulated
 * Endo caplet via `host.makeUnconfined`.
 *
 * The server runs in an unconfined Node worker so it can hold a real
 * `node:http` listening socket. The formula value is the
 * `AssetServerRoot` exo, from which two facets are taken and named:
 * `admin()` — `list()`, `getTarget(id)`, `revoke(id)`, `stop()` — and
 * `publisher()`, the serve-only facet, whose `serve(target)` mounts a
 * Filesystem, Mount or Git capability under a fresh capability path. Made with a host agent of its own as powers,
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
 *   ENDO_FS_ASSET_SERVER_DURABLE      Optional. `1` refuses to start
 *                                     unless the powers can retain what
 *                                     is served (a host agent of the
 *                                     server's own). Unset, powers that
 *                                     cannot are an in-memory server.
 *
 *   ENDO_FS_ASSET_SERVER_PUBLIC_BASE  Optional. Origin to advertise
 *                                     in returned URLs when the
 *                                     server sits behind a proxy,
 *                                     e.g. `https://assets.example`.
 *
 * End-to-end recipe (see README.md): give the server a host agent of its own
 * as `powersName` (`provideHost(handle, { agentName })` — the agent, not the
 * handle), name the result `assets-root`, derive each facet as a formula of
 * its own (`evaluate('@main', 'E(root).admin()', ['root'], ['assets-root'],
 * 'assets-admin')`, and likewise `publisher()` as `assets`), and pin them.
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
 * @returns {Promise<object>} the `AssetServerRoot` exo: `admin()` and
 *   `publisher()`, each to be given a name of its own.
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

  // Under a daemon a module is always handed some powers: with no
  // `powersName` they are the least-authority guest, which can name values
  // but cannot mint the read-only mount a durable route needs. So what the
  // powers can do decides the mode, and `ENDO_FS_ASSET_SERVER_DURABLE=1` is
  // how an operator says that in-memory is not acceptable: then powers that
  // cannot retain — a handle in place of its agent, a guest, none — fail the
  // server instead of giving one that looks durable and loses every route at
  // the next restart.
  /** @type {string[]} */
  let methods = [];
  try {
    // eslint-disable-next-line no-underscore-dangle
    methods = await E(powers).__getMethodNames__();
  } catch (_cause) {
    methods = [];
  }
  const missing = STORE_METHODS.filter(name => !methods.includes(name));
  const durable = missing.length === 0;
  if (!durable && env.ENDO_FS_ASSET_SERVER_DURABLE === '1') {
    throw new Error(
      `asset-server-module: ENDO_FS_ASSET_SERVER_DURABLE=1 needs a host agent of the server's own as powers (pass the agent's pet name as powersName, not its handle); missing ${missing.join(', ')}`,
    );
  }
  if (!durable) {
    console.error(
      'asset-server-module: these powers cannot retain what is served, so routes are kept in memory and lost on restart. Make the server with `powersName` naming a host agent of its own (and ENDO_FS_ASSET_SERVER_DURABLE=1 to insist on it).',
    );
  }

  // Wire the platform-agnostic asset server onto the Node HTTP backend.
  const backend = makeNodeHttpBackend();

  const { root } = await makeAssetServerKit({
    backend,
    getRandomValues,
    port,
    host,
    publicBase,
    ...(durable ? { store: makeEndoAssetStore(/** @type {object} */ (powers)) } : {}),
  });
  return root;
};
harden(make);
