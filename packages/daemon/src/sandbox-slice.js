// @ts-check

/**
 * Minting the live slice a `sandbox` formula evaluates to, from the profile
 * `sandbox.js` normalized. Everything here is platform-neutral: the two
 * effects a slice actually needs — a sandbox backend (bwrap / podman) and a
 * 9P mount projector — arrive as injected functions through the
 * `DaemonicPowers` host-tool seam (`host-tool-powers.js`), the same way
 * `git` and `shell` receive theirs, so the XS daemon bundle never sees
 * `node:child_process`.
 *
 * A slice is a live confined process namespace: a container or a bwrap child,
 * its bind mounts, and any 9P bridge sockets holding a projected mount open.
 * None of that is durable. The formula persists only the profile and re-mints
 * the slice on the first `provide()` after a restart, replaying no work: a
 * job that must survive a restart has to be recorded durably and re-issued.
 */

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { Far } from '@endo/pass-style';
import { SandboxHandleInterface } from '@endo/sandbox/interfaces.js';

import { throwFailures } from './context.js';

/** @import { FormulaIdentifier, FormulaNumber, SandboxEscalationRecord, SandboxFormulaProfile, SandboxMountProjection } from './types.js' */
/** @import { MountCap, MountMode, SpawnOpts } from '@endo/sandbox/types.js' */

const SandboxMountResolverInterface = M.interface('SandboxMountResolver', {
  provideScratchMount: M.call(M.string()).returns(M.promise()),
  // The factory receives private grant tokens rather than the original mount
  // capabilities, so the boundary requires a remotable without nominating a
  // public interface name.
  provideHostPath: M.call(M.remotable()).returns(M.promise()),
});
harden(SandboxMountResolverInterface);

/**
 * Allocate a private state directory for one evaluation of a sandbox formula.
 * Initialization and cleanup may operate recursively within this directory
 * without crossing into another incarnation's state.
 *
 * @param {object} args
 * @param {string} args.statePath Daemon state root.
 * @param {FormulaNumber} args.formulaNumber
 * @param {() => Promise<string>} args.randomHex256
 * @param {(...components: string[]) => string} args.joinPath
 */
export const makeSandboxIncarnationPath = async ({
  statePath,
  formulaNumber,
  randomHex256,
  joinPath,
}) => {
  const incarnationNumber = await randomHex256();
  return joinPath(
    makeSandboxFormulaPath({ statePath, formulaNumber, joinPath }),
    'incarnations',
    incarnationNumber,
  );
};
harden(makeSandboxIncarnationPath);

/**
 * Derive the directory that owns every incarnation of one sandbox formula.
 *
 * @param {object} args
 * @param {string} args.statePath
 * @param {FormulaNumber} args.formulaNumber
 * @param {(...components: string[]) => string} args.joinPath
 */
export const makeSandboxFormulaPath = ({
  statePath,
  formulaNumber,
  joinPath,
}) => joinPath(statePath, 'sandboxes', /** @type {string} */ (formulaNumber));
harden(makeSandboxFormulaPath);

/**
 * Mint the live slice a `sandbox` formula evaluates to.
 *
 * The privileged parts are all injected, which is also what makes this
 * testable without a container runtime: a test supplies a fake factory
 * and a fake projector and observes the composition.
 *
 * @param {object} args
 * @param {SandboxFormulaProfile} args.profile
 * @param {FormulaIdentifier} args.sandboxId
 * @param {string} args.statePath Per-slice scratch/mountpoint root.
 * @param {(mountId: FormulaIdentifier) => Promise<unknown>} args.provideMount
 * @param {{ projectMount: (cap: unknown, options: object) => Promise<any> }} args.projector
 * @param {(powers: unknown, context: unknown, options?: object) => Promise<any>} args.makeSandboxFactory
 * @param {(path: string) => Promise<unknown>} args.makePath
 * @param {(path: string) => Promise<unknown>} args.removeDirectory
 * @param {(...components: string[]) => string} args.joinPath
 * @param {{ record: (entry: SandboxEscalationRecord) => unknown }} args.escalations
 * @param {(cap: unknown, mode: 'ro' | 'rw', innerPath: string, projection?: { kind: string }) => void} [args.assertMountGrant]
 *   Called before projection to validate the requested mode and after
 *   projection to validate the realized projection. A projection rejected by
 *   the second call remains registered for cleanup.
 * @param {unknown} [args.farContext] Cancellation context handed to the
 *   sandbox factory, which disposes every live slice when it settles.
 * @param {Record<string, string>} [args.env] Daemon-process environment
 *   the drivers read their own configuration from.
 * @returns {Promise<{ slice: unknown, release: () => Promise<void> }>}
 */
export const makeSandboxSlice = async ({
  profile,
  sandboxId,
  statePath,
  provideMount,
  projector,
  makeSandboxFactory,
  makePath,
  removeDirectory,
  joinPath,
  escalations,
  assertMountGrant = () => {},
  farContext,
  env = {},
}) => {
  await null;
  /** @type {Array<{ innerPath: string, projection: any }>} */
  const projections = [];
  const hostPathForGrant = new Map();

  /**
   * Release this slice's projections, most recent first. `release()`
   * reports its own failures, so one busy mount cannot strand the rest.
   */
  const releaseProjections = async () => {
    await null;
    /** @type {unknown[]} */
    const failures = [];
    let allDetached = true;
    for (const { projection } of [...projections].reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const detached = await projection.release();
        if (projection.kind === '9p' && detached !== true) {
          allDetached = false;
          failures.push(
            makeError(
              X`9P projection at ${q(projection.hostPath)} did not confirm detachment`,
            ),
          );
        }
      } catch (error) {
        allDetached = false;
        failures.push(error);
      }
    }
    if (allDetached) {
      projections.length = 0;
    }
    // Internal mutable result: cleanupResources may need to append a state
    // directory failure after every projection has detached.
    return { allDetached, failures };
  };

  const cleanupResources = async () => {
    await null;
    const { allDetached, failures } = await releaseProjections();
    if (allDetached) {
      try {
        await removeDirectory(statePath);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };

  try {
    // The state path belongs exclusively to this incarnation. Initialize it
    // empty before exposing scratch space or projection mount points.
    await removeDirectory(statePath);
    await makePath(statePath);

    // Project each granted mount to a bindable host path: its own directory
    // when eligible, a 9P projection otherwise.
    let index = 0;
    /**
     * @param {FormulaIdentifier} mountId
     * @param {string} innerPath
     * @param {'ro' | 'rw'} mode
     */
    const project = async (mountId, innerPath, mode) => {
      const cap = await provideMount(mountId);
      assertMountGrant(cap, mode, innerPath);
      const projection = await projector.projectMount(cap, {
        mountPoint: joinPath(statePath, 'mnt', `${index}`),
        readOnly: mode === 'ro',
        label: innerPath,
      });
      index += 1;
      projections.push({ innerPath, projection });
      // Register the projection before validating its realized kind so
      // cleanup includes it if validation rejects.
      assertMountGrant(cap, mode, innerPath, projection);
      // A unique token preserves the one-to-one correspondence between a
      // profile entry and its projected path, including repeated grants of the
      // same source capability.
      const grant = Far('SandboxMountGrant', {});
      hostPathForGrant.set(grant, projection.hostPath);
      return grant;
    };

    /** @type {unknown} */
    let rootfsArg;
    if (profile.rootfs.kind === 'mount') {
      rootfsArg = await project(profile.rootfs.mountId, '/', 'ro');
    } else {
      rootfsArg = harden({ ...profile.rootfs });
    }

    /** @type {Array<{ cap: unknown, innerPath: string, mode: 'ro' | 'rw' }>} */
    const mountArgs = [];
    for (const mount of profile.mounts) {
      // Sequential: each projection may stand up a kernel mount, and a
      // half-failed set must be unwindable, not raced.
      // eslint-disable-next-line no-await-in-loop
      const cap = await project(mount.mountId, mount.innerPath, mount.mode);
      mountArgs.push(
        harden({ cap, innerPath: mount.innerPath, mode: mount.mode }),
      );
    }

    // The slice's writable upper layer. Ephemeral like the slice itself:
    // it is re-created empty when the formula reincarnates.
    const scratchPath = joinPath(statePath, 'scratch');
    await makePath(scratchPath);
    const scratchPathForToken = new Map();
    const scratchTokenForName = new Map();

    // The factory's privileged surface, narrowed to this slice: the mounts
    // this formula declared and its own scratch, nothing else.
    const scratchProvider = makeExo(
      'SandboxMountResolver',
      SandboxMountResolverInterface,
      {
        /** @param {string} name */
        provideScratchMount: async name => {
          const existing = scratchTokenForName.get(name);
          if (existing !== undefined) return existing;
          const token = Far('SandboxScratch', {});
          const hostPath = joinPath(scratchPath, `${scratchTokenForName.size}`);
          await makePath(hostPath);
          scratchTokenForName.set(name, token);
          scratchPathForToken.set(token, hostPath);
          return token;
        },
        /** @param {unknown} cap */
        provideHostPath: async cap => {
          const tokenPath = scratchPathForToken.get(cap);
          if (tokenPath !== undefined) {
            return tokenPath;
          }
          const hostPath = hostPathForGrant.get(cap);
          if (hostPath === undefined) {
            throw makeError(
              X`sandbox ${q(sandboxId)} was not granted this mount; only mounts named in its profile are resolvable`,
            );
          }
          return hostPath;
        },
      },
    );

    /** @type {() => Promise<void>} */
    let handleBackendDisposal = async () => {};
    const factory = await makeSandboxFactory(scratchProvider, farContext, {
      env,
      ownerId: sandboxId,
      onHandleDisposed: () => handleBackendDisposal(),
    });

    const slice = await E(factory).make(
      harden({
        rootfs: rootfsArg,
        mounts: harden(mountArgs),
        network: profile.network,
        backend: profile.backend,
        seccomp: profile.seccomp,
        env: profile.env,
        ...(profile.cwd !== undefined && { cwd: profile.cwd }),
        ...(profile.limits !== undefined && { limits: profile.limits }),
      }),
    );

    escalations.record(
      harden({
        sandboxId,
        reason: profile.escalation.reason,
        capability: profile.escalation.capability,
        backend: profile.backend,
        network: profile.network,
        projections: harden(
          projections.map(({ innerPath, projection }) =>
            harden({
              innerPath,
              kind: /** @type {SandboxMountProjection} */ (projection.kind),
            }),
          ),
        ),
      }),
    );

    /** @type {Promise<void> | undefined} */
    let releasePromise;
    let wrapperDisposing = false;
    const releaseAfterBackendDisposal = async () => {
      if (wrapperDisposing) return;
      const failures = await cleanupResources();
      if (failures.length > 0) {
        throwFailures(
          failures,
          `Sandbox ${q(sandboxId)} cleanup after backend disposal failed`,
        );
      }
    };
    handleBackendDisposal = releaseAfterBackendDisposal;

    const release = () => {
      if (releasePromise === undefined) {
        wrapperDisposing = true;
        releasePromise = (async () => {
          await null;
          /** @type {unknown[]} */
          const failures = [];
          try {
            await E(slice).dispose();
          } catch (error) {
            failures.push(error);
          } finally {
            wrapperDisposing = false;
          }
          failures.push(...(await cleanupResources()));
          if (failures.length > 0) {
            throwFailures(failures, `Sandbox ${q(sandboxId)} cleanup failed`);
          }
        })().catch(error => {
          // A failed unmount leaves the projection registered and the state
          // directory intact. Allow a later disposal attempt to retry it.
          releasePromise = undefined;
          throw error;
        });
      }
      return releasePromise;
    };

    // Public disposal releases every resource owned by the incarnation: the
    // backend handle, projections, and state directory. Other methods forward
    // to the backend handle.
    const publicSlice = makeExo('SandboxHandle', SandboxHandleInterface, {
      /** @param {string} [methodName] */
      help: methodName =>
        methodName === undefined
          ? 'SandboxHandle: spawn, mount, scratch, open, fork, reset, dispose'
          : `SandboxHandle.${methodName}`,
      /**
       * @param {readonly string[]} argv
       * @param {SpawnOpts} [options]
       */
      spawn: (argv, options) => E(slice).spawn(argv, options),
      /**
       * @param {MountCap} cap
       * @param {string} innerPath
       * @param {MountMode} [mode]
       */
      mount: async (cap, innerPath, mode) => {
        await null;
        assertMountGrant(cap, mode ?? 'ro', innerPath);
        throw makeError(
          X`dynamic mount at ${q(innerPath)} is not implemented; declare the mount in provideSandbox() so daemon policy can project and track it`,
        );
      },
      /** @param {string} innerPath */
      scratch: async innerPath => {
        await null;
        throw makeError(
          X`dynamic scratch at ${q(innerPath)} is not implemented before the backend can attach it`,
        );
      },
      /** @param {string} innerPath */
      open: innerPath => E(slice).open(innerPath),
      fork: async () => {
        await null;
        throw makeError(
          X`fork is not implemented before daemon policy can wrap the child slice`,
        );
      },
      reset: () => E(slice).reset(),
      dispose: () => release(),
    });

    return harden({ slice: publicSlice, release });
  } catch (error) {
    // Unwind the projections this attempt stood up; a half-built slice
    // must not leave kernel mounts behind.
    const cleanupFailures = await cleanupResources();
    return throwFailures(
      [error, ...cleanupFailures],
      `Sandbox ${q(sandboxId)} mint cleanup failed`,
    );
  }
};
harden(makeSandboxSlice);
