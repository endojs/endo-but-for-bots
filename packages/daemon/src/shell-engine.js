// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeSandboxSpawner } from '@endo/host-spawner/src/sandbox-spawner.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import { SandboxFactoryLike } from './types.js'
 */

/** Where a sandboxed shell's mount appears inside its slice. */
export const SANDBOX_SHELL_WORKDIR = '/work';

/**
 * Reject unless `factory` reports at least one usable backend.  A sandboxed
 * shell never falls back to the host engine, so an unusable sandbox is a
 * construction error.
 *
 * @param {ERef<SandboxFactoryLike>} factory
 */
export const assertSandboxBackendAvailable = async factory => {
  const backends = await E(factory).listBackends();
  if (!backends.some(backend => backend.available)) {
    const reasons = backends
      .map(backend => `${backend.name}: ${backend.reason ?? 'unavailable'}`)
      .join('; ');
    throw makeError(
      X`Shell sandbox engine: no usable sandbox backend (${q(reasons || 'none registered')}); refusing to fall back to the host engine`,
    );
  }
};
harden(assertSandboxBackendAvailable);

/**
 * Mint the slice a `'sandbox'`-engine shell runs its children in, and the
 * spawner over it.  The slice has no network, the factory's default seccomp
 * profile, read-only host system directories, and the shell's writable mount
 * at {@link SANDBOX_SHELL_WORKDIR}.  The mount is declared at `make` time:
 * the bwrap driver assembles its bind table once, so a later
 * `SandboxHandle.mount` would not reach the running namespace.
 *
 * The slice belongs to the formula incarnation: `onCancel` disposes it, and
 * the next incarnation mints a fresh one.
 *
 * @param {object} options
 * @param {ERef<SandboxFactoryLike>} options.factory
 * @param {unknown} options.mount  The shell's daemon-minted writable mount.
 * @param {(hook: () => Promise<void>) => void} options.onCancel
 */
export const makeSandboxShellEngine = async ({ factory, mount, onCancel }) => {
  await assertSandboxBackendAvailable(factory);
  const slice = /** @type {any} */ (
    await E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        mounts: [{ cap: mount, innerPath: SANDBOX_SHELL_WORKDIR, mode: 'rw' }],
        network: 'none',
        seccomp: 'default',
        // PATH is left to the slice, which derives it from the directories
        // its rootfs binds; the policy's host search path need not exist
        // inside the slice.
        env: { LC_ALL: 'C' },
        cwd: SANDBOX_SHELL_WORKDIR,
      }),
    )
  );
  onCancel(() => E(slice).dispose());
  return harden({
    cwd: SANDBOX_SHELL_WORKDIR,
    spawner: makeSandboxSpawner(slice),
  });
};
harden(makeSandboxShellEngine);
