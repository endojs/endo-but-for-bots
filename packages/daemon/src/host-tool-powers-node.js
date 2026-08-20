// @ts-check

/**
 * The Node implementations of the host tool powers, for every
 * supervisor that runs in a Node process (the classic daemon, the bus
 * daemon, and the Go supervisor).  The XS supervisor supplies none,
 * and `provideHostToolPowers` in `host-tool-powers.js` fills in
 * stand-ins that refuse.
 *
 * Only this module and the Node powers factories that call it import
 * `@endo/git` and `@endo/host-spawner`, which keeps their `node:`
 * builtins off the XS daemon bundle's compartment graph.
 */

import { access, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeNodeFsMounter } from '@endo/9p-server/mount-caplet.js';
import { makeMountProjector } from '@endo/9p-server/mount-projection.js';
import { gitClone, makeNativeGitBackend } from '@endo/git';
import { makeHostSpawner } from '@endo/host-spawner';
import { make as makeSandboxFactory } from '@endo/sandbox';

import {
  makeSocketPathBinder,
  serveSocketListener,
} from './socket-lifecycle.js';

/** @import { HostToolPowers } from './types.js' */

/**
 * Build the 9P mount projector the `sandbox` formula resolves its
 * granted mounts through.
 *
 * The mounter is per-projector rather than daemon-wide so that a
 * cancelled sandbox tears down exactly its own kernel mounts: the
 * mounter unmounts everything it minted when its `cancelled` promise
 * settles.  `mount(2)` needs `CAP_SYS_ADMIN`, so on an unprivileged
 * daemon the 9P branch fails and only physically-backed mounts project
 * — which is the common case, since every mount the daemon mints over a
 * real directory takes the physical path.
 *
 * @param {{
 *   env?: Record<string, string>,
 *   cancelled?: Promise<never> | null,
 *   resolveHostPath?: (cap: unknown) => Promise<string | undefined>,
 * }} options
 */
const makeNodeMountProjector = ({
  env = {},
  cancelled = null,
  resolveHostPath,
}) =>
  makeMountProjector({
    mounter: makeNodeFsMounter({ env, cancelledP: cancelled }),
    ...(resolveHostPath !== undefined ? { resolveHostPath } : {}),
  });

/**
 * Build the daemon-side half of a sandbox endpoint projection: a place to put
 * a per-projection Unix socket, and the daemon's own listener lifecycle over
 * it.
 *
 * Each projection gets its own short temporary directory, for two reasons.
 * A Unix socket pathname is capped by `sun_path` at 108 bytes, and a path
 * under the daemon's ephemeral state plus a formula-identifier segment
 * exhausts that budget on its own. And a directory per projection is a
 * directory the projection's own close can remove, so releasing the listener
 * releases the pathname *and* what held it — no residue, and no dependence on
 * the daemon reaching an orderly shutdown.
 *
 * The pathname reaches the forwarder, which runs beside the slice rather than
 * inside it; it is never bound into a slice's filesystem or passed in its
 * argv.
 */
const makeNodeSandboxProjectionPowers = () =>
  harden({
    /** @param {string} label */
    provideSocketPath: async label => {
      const dir = await mkdtemp(join(tmpdir(), 'endo-px-'));
      // The label is diagnostic; the daemon owns the directory, so the socket
      // only has to be named, not made unique.
      void label;
      return join(dir, 'p.sock');
    },
    /** @param {{ path: string, cancelled: Promise<never> }} opts */
    serveSocketPath: async ({ path, cancelled }) => {
      const { bind, release } = makeSocketPathBinder({ net, access, path });
      const { connections, close } = await serveSocketListener({
        net,
        listen: bind,
        cancelled,
        afterClose: async () => {
          await release?.();
          // Best-effort: the socket and its marker are already gone by the
          // time this runs, and a directory left behind is inert.
          await rm(dirname(path), { recursive: true, force: true }).catch(
            () => {},
          );
        },
      });
      return harden({ connections, close });
    },
  });

/**
 * @returns {HostToolPowers}
 */
export const makeNodeHostToolPowers = () =>
  harden({
    gitClone,
    makeNativeGitBackend,
    makeHostSpawner,
    makeSandboxFactory,
    makeMountProjector: makeNodeMountProjector,
    makeSandboxProjectionPowers: makeNodeSandboxProjectionPowers,
  });
harden(makeNodeHostToolPowers);
