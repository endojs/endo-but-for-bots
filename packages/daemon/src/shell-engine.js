// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeSandboxSpawner } from '@endo/host-spawner/src/sandbox-spawner.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import { SandboxFactoryLike, SandboxSliceLike } from './types.js'
 */

const { apply } = Reflect;
const { isArray } = Array;
const { some, map, join } = Array.prototype;

/** Where a sandboxed shell's mount appears inside its slice. */
export const SANDBOX_SHELL_WORKDIR = '/work';
harden(SANDBOX_SHELL_WORKDIR);

/**
 * Resolve the engine a persisted shell formula names.  Formula JSON crosses
 * a persistence boundary with no validation beyond its `type`, so this fails
 * closed: only an absent engine (a formula written before the field existed)
 * means `'host'`, and any value other than `'host'` or `'sandbox'` refuses to
 * reincarnate rather than run on the more privileged engine.
 *
 * @param {unknown} engine
 * @returns {'host' | 'sandbox'}
 */
export const resolveShellFormulaEngine = engine => {
  if (engine === undefined || engine === 'host') return 'host';
  if (engine === 'sandbox') return 'sandbox';
  throw makeError(
    X`Shell formula names unknown engine ${q(engine)}; refusing to reincarnate it`,
  );
};
harden(resolveShellFormulaEngine);

/**
 * Reject unless `factory` reports at least one usable backend.  A sandboxed
 * shell never falls back to the host engine, so an unusable sandbox is a
 * construction error.
 *
 * @param {ERef<SandboxFactoryLike>} factory
 */
export const assertSandboxBackendAvailable = async factory => {
  const backends = await E(factory).listBackends();
  if (!isArray(backends)) {
    throw makeError(
      X`Shell sandbox engine: the factory's backend list is not an array`,
    );
  }
  // The list crosses a capability boundary, so its own methods are not
  // trusted: the captured primordials run instead.
  if (!apply(some, backends, [backend => backend.available === true])) {
    const reasons = apply(
      join,
      apply(map, backends, [
        backend => `${backend.name}: ${backend.reason ?? 'unavailable'}`,
      ]),
      ['; '],
    );
    throw makeError(
      X`Shell sandbox engine: no usable sandbox backend (${q(reasons || 'none registered')}); refusing to fall back to the host engine`,
    );
  }
};
harden(assertSandboxBackendAvailable);

/**
 * Mint the slice a `'sandbox'`-engine shell runs its children in, and the
 * spawner over it.  The slice has no network, read-only host system
 * directories, and the shell's writable mount at {@link SANDBOX_SHELL_WORKDIR}.
 * It asks the factory for the default seccomp profile, which the factory
 * enforces only where the selected backend supports it; `inspect()` reports
 * the engine, not that profile.  The mount is declared at `make` time: the
 * bwrap driver assembles its bind table once, so a later
 * `SandboxHandle.mount` would not reach the running namespace.
 *
 * The slice belongs to the formula incarnation.  The cancellation hook is
 * registered before the slice is requested, so a cancellation at any point
 * disposes it, including one that lands while `make()` is still pending; a
 * context already cancelled refuses before acquiring anything.  The next
 * incarnation mints a fresh slice.
 *
 * @param {object} options
 * @param {ERef<SandboxFactoryLike>} options.factory
 * @param {unknown} options.mount  The shell's daemon-minted writable mount.
 * @param {{
 *   onCancel: (hook: () => Promise<void>) => void,
 *   assertActive: () => void,
 * }} options.context  The formula incarnation's context.
 */
export const makeSandboxShellEngine = async ({ factory, mount, context }) => {
  /** @type {Promise<SandboxSliceLike> | undefined} */
  let pendingSlice;
  context.onCancel(async () => {
    if (pendingSlice === undefined) return;
    const slice = await pendingSlice.catch(() => undefined);
    if (slice !== undefined) await E(slice).dispose();
  });
  context.assertActive();
  await assertSandboxBackendAvailable(factory);
  // No turn separates this check from the request below, so a cancellation
  // either refuses here or runs the hook after `pendingSlice` is set.
  context.assertActive();
  pendingSlice = E(factory).make(
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
  );
  const slice = await pendingSlice;
  return harden({
    cwd: SANDBOX_SHELL_WORKDIR,
    spawner: makeSandboxSpawner(slice),
  });
};
harden(makeSandboxShellEngine);
