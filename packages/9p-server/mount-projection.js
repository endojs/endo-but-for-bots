// @ts-check

/**
 * Mount projection: turn a capability that *describes* a filesystem into
 * a host path a kernel bind-mount (or an OCI slice) can consume.
 *
 * Two consumers need exactly this chain and used to carry private copies
 * of it:
 *
 *   - `@endo/daemon`'s `sandbox` formula, which binds daemon-minted
 *     `Mount` capabilities into a `@endo/sandbox` slice, and
 *   - `@endo/claude-sandbox`, which mounts a session `Filesystem` cap for
 *     a per-session podman slice.
 *
 * The layer answers one question — *what host path names this
 * capability's contents?* — with two answers:
 *
 *   1. **Physical.** The capability is a locally-minted mount over a real
 *      directory and its resolver is willing to name that directory, so
 *      the resolver hands it back. Nothing is created and `release()` is
 *      a no-op. This is the fast path and the only one that survives a
 *      host without `CAP_SYS_ADMIN`. A resolver may decline: a bind
 *      carries the directory, not the capability's attenuation.
 *   2. **9P.** There is no local directory to name — the capability is a
 *      remote presence, an in-memory or layered `Filesystem`, or a mount
 *      whose backing this process cannot see. The projection serves the
 *      capability over 9P2000.L on a private Unix socket and attaches it
 *      to the kernel at `mountPoint` (`mount-caplet.js`), so the host
 *      path exists for as long as the projection is held.
 *
 * The 9P branch is a *live* projection: it holds a socket, a bridge, and
 * a kernel mount, none of which survive a daemon restart. Callers that
 * persist anything must persist the inputs and re-project, never the
 * resulting path.
 *
 * @module
 */

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { mountAsFilesystem } from '@endo/platform/fs/extended/from-mount.js';

/** @import { ERef } from '@endo/eventual-send' */

/**
 * @typedef {object} MountProjection
 * @property {'physical' | '9p'} kind How the host path was obtained.
 * @property {string} hostPath Host filesystem path naming the contents.
 * @property {unknown} [mountCap] Daemon-minted `Mount` capability over
 *   `hostPath`, when the projector was given a `provideMount` power. For
 *   a physical projection this is the source capability itself.
 * @property {{ unmount: () => Promise<void> }} [mountHandle] The 9P mount
 *   handle, absent on the physical branch. Exposed for callers that hand
 *   teardown to another component (`@endo/claude-sandbox` passes it to
 *   `makeClaudeClient`).
 * @property {() => Promise<boolean>} release Idempotent teardown of whatever
 *   this projection created. Resolves `true` only after a 9P mount has been
 *   detached; a failed unmount is reported on stderr and resolves `false` so
 *   callers can preserve any state that a live mount could still reach.
 */

/**
 * @typedef {object} ProjectOptions
 * @property {string} mountPoint Host path the 9P branch attaches to. The
 *   mounter creates it when absent. Ignored on the physical branch.
 * @property {boolean} [readOnly] Project read-only: the kernel mount gets
 *   `ro` and the intermediate `Filesystem` is labelled `readOnly`.
 * @property {Record<string, unknown>} [mountOptions] Extra mounter
 *   options merged over the projector's defaults (`lazyUnmount`,
 *   `socketPath`, …). The mounter pins `trans` / `version` / `access`.
 * @property {string} [label] Diagnostic label used in error messages.
 */

/**
 * Build a mount projector.
 *
 * Every effect is injected: the projector itself imports no `node:`
 * builtin, so it loads in a worker, in the daemon, or under a test that
 * substitutes a fake mounter. The privileged parts live behind
 * `mounter` (which shells out to `mount(8)`) and `provideMount` (which
 * mints a daemon formula).
 *
 * @param {object} powers
 * @param {ERef<{ mount: (fs: unknown, mountPoint: string, options?: object) => Promise<any> }>} [powers.mounter]
 *   9P mounter (`@endo/9p-server/mount-caplet.js`). Required for the 9P
 *   branch; a projector without one refuses rather than silently
 *   degrading a capability it cannot project.
 * @param {(cap: unknown) => Promise<string | undefined>} [powers.resolveHostPath]
 *   Physical-backing resolver. Returns the directory naming the
 *   capability's contents, or `undefined` when there is none or when the
 *   resolver declines to name one. A thrown error propagates rather than
 *   falling through to 9P, so a broken resolver is not mistaken for a
 *   virtual filesystem.
 * @param {(hostPath: string) => Promise<unknown>} [powers.provideMount]
 *   Registers `hostPath` as a daemon-minted `Mount` capability. Callers
 *   that need only a path (the daemon's own `sandbox` formula) omit it.
 * @param {(cap: any, opts: { posture: 'readOnly' | 'readWrite' }) => unknown} [powers.asFilesystem]
 *   Projects a `Mount` capability into a `Filesystem`. Defaults to
 *   `@endo/platform`'s `mountAsFilesystem`, whose parameter is an
 *   `object` rather than `unknown`, so the seam is typed permissively
 *   here — what a mount capability *is* belongs to its own package.
 * @param {Record<string, unknown>} [powers.defaultMountOptions]
 *   Mounter options applied to every 9P projection.
 */
export const makeMountProjector = ({
  mounter,
  resolveHostPath,
  provideMount,
  asFilesystem = mountAsFilesystem,
  defaultMountOptions = {},
}) => {
  /**
   * Serve `fs` over 9P and attach it to the kernel at `mountPoint`.
   *
   * @param {unknown} fs `@endo/platform/fs/extended` `Filesystem` cap.
   * @param {ProjectOptions} options
   * @returns {Promise<MountProjection & { mountHandle: { unmount: () => Promise<void> } }>}
   *   A 9P projection always carries its mount handle; only the physical
   *   branch omits one.
   */
  const projectFilesystem = async (fs, options) => {
    const { mountPoint, readOnly = false, mountOptions = {}, label } = options;
    if (mounter === undefined) {
      throw makeError(
        X`mount projection for ${q(label ?? mountPoint)} needs a 9P mounter: this capability has no host path to bind`,
      );
    }
    if (typeof mountPoint !== 'string' || mountPoint.length === 0) {
      throw makeError(
        X`mount projection for ${q(label ?? '(unlabelled)')} requires a mountPoint`,
      );
    }
    const kernelOptions = harden({
      ...defaultMountOptions,
      ...mountOptions,
      // Only state `ro` when it is wanted: the mounter's option string
      // omits the flag otherwise, and a caller-visible options record
      // that always carries `readOnly: false` reads like a decision the
      // projector made rather than the default it inherited.
      ...(readOnly ? { readOnly: true } : {}),
    });

    const mountHandle = await E(mounter).mount(fs, mountPoint, kernelOptions);

    let released = false;
    const release = async () => {
      await null;
      if (released) return true;
      try {
        await E(mountHandle).unmount();
        released = true;
        return true;
      } catch (error) {
        // Best-effort: a busy mount must not derail a teardown sweep, but the
        // false result lets a security-sensitive caller retain its state.
        console.error(
          `[mount-projection] unmount of ${mountPoint} failed`,
          error,
        );
        return false;
      }
    };

    /** @type {unknown} */
    let mountCap;
    if (provideMount !== undefined) {
      try {
        mountCap = await provideMount(mountPoint);
      } catch (error) {
        // The kernel mount is live but unusable to the caller; drop it
        // rather than leak a mount over a name nobody holds. Go through the
        // normal release path so a failed detach is diagnosed and remains
        // retryable by the mounter's cancellation sweep.
        await release();
        throw error;
      }
    }

    return harden({
      kind: /** @type {const} */ ('9p'),
      hostPath: mountPoint,
      ...(mountCap !== undefined ? { mountCap } : {}),
      mountHandle,
      release,
    });
  };

  /**
   * Project a `Mount` capability to a host path, preferring its physical
   * backing and falling back to the 9P chain.
   *
   * @param {unknown} mount
   * @param {ProjectOptions} options
   * @returns {Promise<MountProjection>}
   */
  const projectMount = async (mount, options) => {
    await null;
    const { readOnly = false } = options;
    if (resolveHostPath !== undefined) {
      const hostPath = await resolveHostPath(mount);
      if (typeof hostPath === 'string' && hostPath.length > 0) {
        return harden({
          kind: /** @type {const} */ ('physical'),
          hostPath,
          mountCap: mount,
          release: async () => true,
        });
      }
    }
    const fs = asFilesystem(mount, {
      posture: readOnly ? 'readOnly' : 'readWrite',
    });
    return projectFilesystem(fs, options);
  };

  return harden({ projectMount, projectFilesystem });
};
harden(makeMountProjector);
