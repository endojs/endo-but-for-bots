// @ts-check

import harden from '@endo/harden';

import { Direction, Kind } from './descriptor.js';

/** @import { Descriptor } from './descriptor.js' */

/**
 * Position conventions for the c-list:
 *
 * * Object / Promise / Device: monotonic counter starting at 1.
 * * Answer: monotonic counter starting at 0.
 *
 * Position 1 of the Object space on each side is reserved for the
 * session's **root** — the entry point the local peer exposes to the
 * remote peer.  Neither side explicitly exchanges a root descriptor;
 * both sides simply:
 *
 * 1. Call `clist.exportLocal(root, Kind.Object)` during bootstrap.
 *    The counter starts at 1, so the allocated descriptor is
 *    `{ dir: Local, kind: Object, position: 1 }`.
 * 2. Call `client.makePresence(REMOTE_ROOT)` where
 *    [`REMOTE_ROOT`] = `{ dir: Remote, kind: Object, position: 1 }`
 *    to obtain a HandledPromise for the peer's root.
 *
 * The Rust supervisor's `receive` / `send` machinery will unify the
 * two position-1 descriptors through a shared kref so that calls
 * addressed to one peer's "position 1 Remote" reach the other peer's
 * "position 1 Local" export.
 *
 * If a session requires additional pre-allocated positions (e.g.
 * "position 2 = log sink"), callers should agree on the convention
 * out of band and export them in the same order on both sides.
 */

/** Descriptor for the locally-exported root object. */
export const LOCAL_ROOT = harden(
  /** @type {Descriptor} */ ({
    dir: Direction.Local,
    kind: Kind.Object,
    position: 1,
  }),
);

/** Descriptor for the remote peer's root object. */
export const REMOTE_ROOT = harden(
  /** @type {Descriptor} */ ({
    dir: Direction.Remote,
    kind: Kind.Object,
    position: 1,
  }),
);

/**
 * Convenience: export `root` into `clist` and create a presence for
 * the remote root via `client.makePresence(REMOTE_ROOT)`.  Returns
 * the pair `{ localDesc, remoteRoot }`.  Exposed for callers that
 * want to share a single bootstrap point — they can of course
 * compose `clist.exportLocal` and `client.makePresence` themselves
 * if they prefer more control.
 *
 * @param {object} opts
 * @param {{
 *   exportLocal: (val: unknown, kind?: 0 | 1 | 2 | 3) => Descriptor,
 * }} opts.clist
 * @param {{
 *   makePresence: (desc: Descriptor) => unknown,
 * }} opts.client
 * @param {unknown} opts.root
 * @returns {{ localDesc: Descriptor, remoteRoot: unknown }}
 */
export const bootstrap = ({ clist, client, root }) => {
  const localDesc = clist.exportLocal(root, Kind.Object);
  const remoteRoot = client.makePresence(REMOTE_ROOT);
  return { localDesc, remoteRoot };
};
harden(bootstrap);
