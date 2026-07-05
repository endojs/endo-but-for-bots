// @ts-check
/**
 * Interface guards for the static asset server.
 *
 * `AssetServer` is the formula value produced by
 * `asset-server-module.js`. `AssetMount` is the revoker handle
 * returned by `AssetServer.serve(...)`: it names the capability path
 * a Filesystem is served under and can revoke that mount.
 *
 * Naming follows the rest of the repo (`<TypeName>Interface`, no
 * `Endo*` prefix).
 */

import { M } from '@endo/patterns';

/**
 * Revoker handle for a single `serve(...)` mount. The unguessable
 * `path` is itself the capability — anyone who can reach the server
 * and knows the path can read the served Filesystem until the mount
 * is revoked.
 */
export const AssetMountInterface = M.interface('AssetMount', {
  // Stop serving the Filesystem at this mount. Idempotent.
  revoke: M.call().returns(M.undefined()),
  // The capability path segment under which the Filesystem is served,
  // e.g. `/_h7Qd.../`.
  getPath: M.call().returns(M.string()),
  // The full URL (origin + path) the Filesystem is served at.
  getUrl: M.call().returns(M.string()),
  isRevoked: M.call().returns(M.boolean()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * The static asset server. `serve(filesystem, opts)` mints a fresh
 * capability path, registers the Filesystem under it, and returns a
 * record `{ path, url, revoke }`; the mount persists until
 * `revoke.revoke()` (or the server stops). `getAddress()` reports the
 * bound host/port and public origin.
 *
 * `sloppy: true` so future convenience methods (e.g. listing mounts)
 * can land without an interface bump.
 */
export const AssetServerInterface = M.interface(
  'AssetServer',
  {
    // Accepts a Filesystem, exo-git workspace, Mount, or Layer (coerced and
    // validated before mounting). Async so validation can fail fast; resolves
    // to `{ path, url, revoke }`.
    serve: M.call(M.eref(M.remotable('Filesystem')))
      .optional(M.record())
      .returns(M.promise()),
    // Serve at a caller-chosen, stable path segment instead of a minted
    // token — the basis for a persistent static site.
    serveAt: M.call(M.string(), M.eref(M.remotable('Filesystem')))
      .optional(M.record())
      .returns(M.promise()),
    getAddress: M.call().returns(M.record()),
    stop: M.call().returns(M.promise()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
  { sloppy: true },
);

/**
 * The agent-facing facet of the asset server: everything in
 * `AssetServerInterface` EXCEPT `stop()`. The server is a shared
 * singleton (one per daemon, bound to a fixed loopback port that Caddy
 * proxies), so handing `stop()` to arbitrary caller agents is a
 * footgun — one guest stopping it tears the HTTP listener out from
 * under every other user and can wedge the caplet (the daemon then
 * reincarnates the formula into a new worker that collides on the still
 * held port). `asset-server-module.js` returns this facet; the full
 * `AssetServerInterface` (with `stop`) stays internal / for tests.
 */
export const AssetServerPublicInterface = M.interface(
  'AssetServer',
  {
    serve: M.call(M.eref(M.remotable('Filesystem')))
      .optional(M.record())
      .returns(M.promise()),
    serveAt: M.call(M.string(), M.eref(M.remotable('Filesystem')))
      .optional(M.record())
      .returns(M.promise()),
    getAddress: M.call().returns(M.record()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
  { sloppy: true },
);
