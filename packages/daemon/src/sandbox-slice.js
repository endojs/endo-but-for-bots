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
import { Far } from '@endo/pass-style';
import { M } from '@endo/patterns';
import { SandboxHandleInterface } from '@endo/sandbox/interfaces.js';

import { throwFailures } from './context.js';
import { makeSerialJobs } from './serial-jobs.js';

/** @import { FormulaIdentifier, FormulaNumber, SandboxEscalationRecord, SandboxFormulaProfile, SandboxMountProjection } from './types.js' */
/** @import { MountCap, MountMode, SpawnOpts } from '@endo/sandbox/types.js' */

/**
 * One scratch name's bookkeeping: the host directory assigned to it for the
 * life of the slice, and the capability token that currently names it. The
 * token is `undefined` between a reset and the next allocation.
 *
 * @typedef {{ hostPath: string, token?: unknown }} ScratchEntry
 */

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
 * @param {(path: string) => Promise<void>} [args.clearDirectory]
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
  clearDirectory,
  joinPath,
  escalations,
  assertMountGrant = () => {},
  farContext,
  env = {},
}) => {
  await null;
  /** @type {Array<{ innerPath: string, projection: any } | undefined>} */
  const projections = [];
  const hostPathForGrant = new Map();

  /**
   * Return the projections that have been realized, in profile order.
   * Parallel minting may leave holes while sibling operations are in flight.
   *
   * @returns {Array<{ innerPath: string, projection: any }>}
   */
  const realizedProjections = () => {
    /** @type {Array<{ innerPath: string, projection: any }>} */
    const realized = [];
    for (const entry of projections) {
      if (entry !== undefined) {
        realized.push(entry);
      }
    }
    return realized;
  };

  /**
   * Release this slice's projections, most recent first. `release()`
   * reports its own failures, so one busy mount cannot strand the rest.
   */
  const releaseProjections = async () => {
    await null;
    /** @type {unknown[]} */
    const failures = [];
    let allDetached = true;
    const releaseOrder = realizedProjections().reverse();
    const releaseResults = await Promise.allSettled(
      releaseOrder.map(async ({ projection }) => projection.release()),
    );
    for (let index = 0; index < releaseOrder.length; index += 1) {
      const { projection } = releaseOrder[index];
      const result = releaseResults[index];
      if (result.status === 'rejected') {
        allDetached = false;
        failures.push(result.reason);
      } else if (projection.kind === '9p' && result.value !== true) {
        allDetached = false;
        failures.push(
          makeError(
            X`9P projection at ${q(projection.hostPath)} did not confirm detachment`,
          ),
        );
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

  /** @type {Promise<unknown[]> | undefined} */
  let cleanupInFlight;
  /**
   * The one teardown critical section. A backend that self-disposes after a
   * containment failure and a context-driven `release()` can each reach
   * cleanup, and either may win. Assigning the memo synchronously — before
   * any await — makes the loser await the winner's sweep instead of running a
   * second one concurrently over the same projections and state directory.
   *
   * A sweep that reports failures has left the projections registered and the
   * state directory intact, so the memo is dropped and a later attempt
   * retries.
   *
   * @returns {Promise<unknown[]>} The failures of the sweep both callers share.
   */
  const cleanupOnce = () => {
    if (cleanupInFlight === undefined) {
      cleanupInFlight = cleanupResources().then(
        failures => {
          if (failures.length > 0) {
            cleanupInFlight = undefined;
          }
          return failures;
        },
        error => {
          cleanupInFlight = undefined;
          throw error;
        },
      );
    }
    return cleanupInFlight;
  };

  /** @type {SandboxEscalationRecord | undefined} */
  let escalationRecorded;
  /**
   * Record every mint attempt exactly once. A failed attempt is recorded
   * before cleanup, so the entry describes the authority and projections
   * that were actually assembled even when the backend cannot make a
   * slice from them.
   */
  const recordEscalation = () => {
    if (escalationRecorded !== undefined) return;
    const record = harden({
      sandboxId,
      reason: profile.escalation.reason,
      capability: profile.escalation.capability,
      backend: profile.backend,
      network: profile.network,
      projections: harden(
        realizedProjections().map(({ innerPath, projection }) =>
          harden({
            innerPath,
            kind: /** @type {SandboxMountProjection} */ (projection.kind),
          }),
        ),
      ),
    });
    escalationRecorded = record;
    escalations.record(record);
  };

  try {
    // The state path belongs exclusively to this incarnation. Initialize it
    // empty before exposing scratch space or projection mount points.
    await removeDirectory(statePath);
    await makePath(statePath);

    // The writable upper layer depends only on the state root, so create it
    // concurrently with the mount projections below.
    const scratchPath = joinPath(statePath, 'scratch');
    const scratchPathPromise = makePath(scratchPath);

    // Project each granted mount to a bindable host path: its own directory
    // when eligible, a 9P projection otherwise.
    /**
     * @param {FormulaIdentifier} mountId
     * @param {string} innerPath
     * @param {'ro' | 'rw'} mode
     * @param {number} projectionIndex
     */
    const project = async (mountId, innerPath, mode, projectionIndex) => {
      const cap = await provideMount(mountId);
      assertMountGrant(cap, mode, innerPath);
      const projection = await projector.projectMount(cap, {
        mountPoint: joinPath(statePath, 'mnt', `${projectionIndex}`),
        readOnly: mode === 'ro',
        label: innerPath,
      });
      projections[projectionIndex] = { innerPath, projection };
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

    let projectionIndex = 0;
    /** @type {Promise<unknown>} */
    let rootfsPromise;
    if (profile.rootfs.kind === 'mount') {
      rootfsPromise = project(
        profile.rootfs.mountId,
        '/',
        'ro',
        projectionIndex,
      );
      projectionIndex += 1;
    } else {
      rootfsPromise = Promise.resolve(harden({ ...profile.rootfs }));
    }

    const mountPromises = profile.mounts.map(mount => {
      const currentProjectionIndex = projectionIndex;
      projectionIndex += 1;
      return project(
        mount.mountId,
        mount.innerPath,
        mount.mode,
        currentProjectionIndex,
      ).then(cap =>
        harden({
          cap,
          innerPath: mount.innerPath,
          mode: mount.mode,
        }),
      );
    });
    const [scratchPathResult, ...projectionResults] = await Promise.allSettled([
      scratchPathPromise,
      rootfsPromise,
      ...mountPromises,
    ]);
    if (scratchPathResult.status === 'rejected') {
      throw scratchPathResult.reason;
    }
    const projectionFailure = projectionResults.find(
      result => result.status === 'rejected',
    );
    if (projectionFailure?.status === 'rejected') {
      throw projectionFailure.reason;
    }
    const [rootfsArg, ...mountArgs] = projectionResults.map(result => {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      return result.value;
    });

    // Scratch capability tokens are invalidated at every reset, but the
    // name-to-path assignments remain stable because a backend may retain a
    // bind to one of these directory inodes for the lifetime of the slice.
    /** @type {Map<string, ScratchEntry>} */
    const scratchForName = new Map();
    // Reverse index over the same entries, so a token resolves to a path in
    // one step. Derived, never independently authoritative: `bindScratchName`
    // is the only writer of either map, which is what keeps a retired token
    // from surviving here and resolving to a live host path.
    /** @type {Map<unknown, string>} */
    const scratchNameForToken = new Map();

    /**
     * Bind `name` to `hostPath` under `token`, retiring whatever token the
     * name held. Omitting `token` retires the current one while retaining the
     * name's path, which is what a reset wants.
     *
     * @param {string} name
     * @param {string} hostPath
     * @param {unknown} [token]
     */
    const bindScratchName = (name, hostPath, token) => {
      const previous = scratchForName.get(name);
      if (previous !== undefined && previous.token !== undefined) {
        scratchNameForToken.delete(previous.token);
      }
      scratchForName.set(name, harden({ hostPath, token }));
      if (token !== undefined) {
        scratchNameForToken.set(token, name);
      }
    };

    // One queue, not one per name: a reset rewrites every entry, so it has to
    // exclude every allocation, and the only await an allocation holds the
    // queue across is its own `makePath`.
    const scratchJobs = makeSerialJobs();

    const resetScratch = () =>
      scratchJobs.enqueue(async () => {
        // Keep each scratch root directory itself intact because the backend
        // may still hold a bind mount to that inode after its processes stop.
        // Retain the path memo across resets so later resets also clear files
        // written through those still-bound directories.
        if (clearDirectory !== undefined) {
          await Promise.all(
            [...scratchForName.values()].map(({ hostPath }) =>
              clearDirectory(hostPath),
            ),
          );
        }
        for (const [name, { hostPath }] of scratchForName) {
          bindScratchName(name, hostPath);
        }
      });

    // The factory's privileged surface, narrowed to this slice: the mounts
    // this formula declared and its own scratch, nothing else.
    const scratchProvider = makeExo(
      'SandboxMountResolver',
      SandboxMountResolverInterface,
      {
        /** @param {string} name */
        provideScratchMount: name =>
          scratchJobs.enqueue(async () => {
            const existing = scratchForName.get(name);
            if (existing !== undefined && existing.token !== undefined) {
              return existing.token;
            }
            let hostPath = existing?.hostPath;
            if (hostPath === undefined) {
              hostPath = joinPath(scratchPath, `${scratchForName.size}`);
              // Record nothing until the directory exists, so a failed
              // allocation leaves the name unclaimed for a later retry.
              await makePath(hostPath);
            }
            const token = Far('SandboxScratch', {});
            bindScratchName(name, hostPath, token);
            return token;
          }),
        /** @param {unknown} cap */
        provideHostPath: async cap => {
          const scratchName = scratchNameForToken.get(cap);
          if (scratchName !== undefined) {
            return /** @type {ScratchEntry} */ (scratchForName.get(scratchName))
              .hostPath;
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
      resetScratch,
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

    recordEscalation();

    /** @type {Promise<void> | undefined} */
    let releasePromise;
    let wrapperDisposing = false;
    let backendDisposed = false;
    const releaseAfterBackendDisposal = async () => {
      backendDisposed = true;
      // Re-entrancy, not mutual exclusion: when `release()` is the caller of
      // `dispose()`, the backend runs this hook from inside that call, so
      // awaiting the release path here would deadlock it. Cleanup belongs to
      // the release that is already unwinding. Concurrent teardown from an
      // unprompted backend disposal is excluded by `cleanupOnce` instead.
      if (wrapperDisposing) return;
      const failures = await cleanupOnce();
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
          if (!backendDisposed) {
            try {
              await E(slice).dispose();
            } catch (error) {
              failures.push(error);
            } finally {
              wrapperDisposing = false;
            }
          } else {
            wrapperDisposing = false;
          }
          failures.push(...(await cleanupOnce()));
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
    /** @type {unknown | undefined} */
    let escalationFailure;
    try {
      recordEscalation();
    } catch (recordError) {
      escalationFailure = recordError;
    }
    // Unwind the projections this attempt stood up; a half-built slice
    // must not leave kernel mounts behind.
    const cleanupFailures = await cleanupOnce();
    return throwFailures(
      [
        error,
        ...(escalationFailure === undefined ? [] : [escalationFailure]),
        ...cleanupFailures,
      ],
      `Sandbox ${q(sandboxId)} mint cleanup failed`,
    );
  }
};
harden(makeSandboxSlice);
