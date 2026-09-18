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
 * and knows the path can read the served tree until the mount
 * is revoked.
 */
export const AssetMountInterface = M.interface('AssetMount', {
  // Stop serving at this mount and release what the server retained for it.
  // Idempotent. Async: a durable store forgets the item too.
  revoke: M.call().returns(M.promise()),
  // The capability path segment under which the tree is served,
  // e.g. `/_h7Qd.../`.
  getPath: M.call().returns(M.string()),
  // The full URL (origin + path) the tree is served at.
  getUrl: M.call().returns(M.string()),
  isRevoked: M.call().returns(M.boolean()),
  help: M.call().optional(M.string()).returns(M.string()),
});

// `serve(target, opts)`: `target` is a Filesystem, Mount or Git capability.
// `M.remotable` does not check an interface name; the server classifies the
// capability by the methods it answers and refuses anything else before it
// retains it or mints a URL.
const serveGuard = M.call(M.eref(M.remotable()))
  .optional(M.record())
  .returns(M.promise());

/**
 * The serve-only facet: what is handed to something that has a tree to
 * publish. It cannot list what others published, and `release` and
 * `describe` answer only for an `id` that `serve` returned.
 */
export const AssetPublisherInterface = M.interface('AssetPublisher', {
  serve: serveGuard,
  release: M.call(M.string()).returns(M.promise()),
  describe: M.call(M.string()).returns(M.or(M.record(), M.undefined())),
  // `describe` after asking the target now; for deciding, not for display.
  check: M.call(M.string()).returns(M.promise()),
  getAddress: M.call().returns(M.record()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * The operator's facet. It reads — `list()`, and `getTarget(id)` for the
 * read-only facet a route serves — and it removes. It has no way to serve,
 * or to change what a route serves.
 */
export const AssetServerAdminInterface = M.interface('AssetServerAdmin', {
  list: M.call().returns(M.array()),
  getTarget: M.call(M.string()).returns(M.promise()),
  revoke: M.call(M.string()).returns(M.promise()),
  getAddress: M.call().returns(M.record()),
  stop: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * The value of the daemon formula: the two facets, each to be given a name of
 * its own, and nothing else.
 */
export const AssetServerRootInterface = M.interface('AssetServerRoot', {
  admin: M.call().returns(M.remotable('AssetServerAdmin')),
  publisher: M.call().returns(M.remotable('AssetPublisher')),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * The whole server as one facet, for embedders and tests that hold all of it:
 * `serve(target, opts)` resolves to `{ id, path, url, revoke }`, and the mount
 * lasts until `revoke.revoke()`. `getAddress()` reports the bound host/port
 * and public origin.
 *
 * `sloppy: true` so future convenience methods can land without an
 * interface bump.
 */
export const AssetServerInterface = M.interface(
  'AssetServer',
  {
    serve: serveGuard,
    release: M.call(M.string()).returns(M.promise()),
    describe: M.call(M.string()).returns(M.or(M.record(), M.undefined())),
    check: M.call(M.string()).returns(M.promise()),
    getAddress: M.call().returns(M.record()),
    stop: M.call().returns(M.promise()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
  { sloppy: true },
);
