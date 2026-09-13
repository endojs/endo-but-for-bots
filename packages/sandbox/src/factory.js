// @ts-check

/* global clearTimeout, setTimeout */

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';

import {
  MountHandleInterface,
  ProcessHandleInterface,
  SandboxFactoryInterface,
  SandboxHandleInterface,
  NativeSpawnOptsShape,
} from './interfaces.js';
import { makeEagerReader } from './eager-reader.js';
import { makeResourceRegistry } from './resource-registry.js';
import { resolveLimits } from './limits.js';
import { validateGeneratedFiles } from './generated-files.js';

/** @import { MakeSandboxFactoryInput, SandboxFactory, SandboxMakeOpts, SandboxDriver, BackendProbe, MountSpec, SliceSpec, MountCap, MountMode, SandboxHandle, ProcessHandle, MountHandle, SpawnOpts, DriverProcess, RootfsSpec, TerminationSignal } from './types.js' */
/** @import { NativeSandboxMakeOpts, NativeSandboxHandle, MakeSandboxFactoryKitInput } from './native-factory-types.js' */

const NativeHandleInterface = harden(
  M.interface('NativeSandboxHandle', {
    help: M.call().optional(M.string()).returns(M.string()),
    spawn: M.call(M.arrayOf(M.string()))
      .optional(NativeSpawnOptsShape)
      .returns(M.promise()),
    policy: M.call().returns(M.promise()),
    reset: M.call().returns(M.promise()),
    dispose: M.call().returns(M.promise()),
  }),
);

const FACTORY_HELP = `\
SandboxFactory — root capability of the @endo/sandbox plugin.

Mints confined POSIX slices via a registered backend driver
(bwrap, podman, lima, …). Phase 1 ships the bwrap driver on Linux.

Methods:
  help([methodName])    Documentation for the factory or a method.
  listBackends()        Probe every registered driver and return the
                        list of { name, available, reason?, version? }.
  make(opts)            Mint a new sandbox slice. See SandboxMakeOpts.
`;

const METHOD_HELP = harden({
  help: 'help([methodName]) — return documentation for the factory or a specific method.',
  listBackends:
    'listBackends() — probe every registered driver. Returns Array<BackendProbe>.',
  make:
    'make(opts) — mint a new SandboxHandle. opts.rootfs is required; ' +
    'opts.network defaults to "none"; opts.backend defaults to "auto". ' +
    'opts.policy enforces a deployment policy and makes policy() report ' +
    'its attestation: it requires network "broker-only", a ' +
    'digest-pinned OCI rootfs, and an empty opts.mounts, since the ' +
    'policy declares the whole mount table.',
});

const HANDLE_HELP_BASE = `\
SandboxHandle — a live confined POSIX slice.

Pinned by the formula that minted it. When dropped, every
ProcessHandle is killed and every MountHandle is unmounted before the
driver tears down the underlying namespace.

Methods:
  spawn(argv, opts)   Spawn a process in the slice.
  policy()            Report the slice's policy attestation.
  mount(cap, …)       Bind a Mount capability into the slice.
  scratch(innerPath)  Mint an ephemeral scratch mount.
  open(innerPath)     Open a single file inside the slice.
  fork(opts)          Mint a nested sub-slice (Phase 3).
  reset()             Tear down processes / scratch, keep mounts.
  dispose()           Full teardown.
`;

/**
 * Render a per-slice "hardening layers in effect" report.  Drivers
 * may attach a `runtimeDetails` field to the slice context with
 * `landlock` / `cgroup2` / `prlimit` summaries; the report formats
 * those as a stable, human-readable block appended to `help()`.
 *
 * Driver-attached fields:
 *   - `runtimeDetails.landlock:   { available, reason? }` (bwrap)
 *   - `runtimeDetails.cgroup2:    { available, controllers, reason? }`
 *   - `runtimeDetails.prlimit:    { applied: string[] }` (bwrap)
 *   - `runtimeDetails.rootless:   { available, reason? }` (podman)
 *   - `runtimeDetails.rootlessNet:{ backend, reason? }` (podman)
 *   - `runtimeDetails.path:       { value, source }`     (podman)
 *
 * Missing fields render as "not detected" so the report stays
 * informative across drivers that do not implement every layer.
 *
 * @param {{ runtimeDetails?: { landlock?: { available: boolean, reason?: string }, cgroup2?: { available: boolean, controllers: string[], reason?: string }, prlimit?: { applied: string[] }, rootless?: { available: boolean, reason?: string }, rootlessNet?: { backend: string | null, reason?: string }, path?: { value: string, source: 'env' | 'image' | 'fallback' } } }} driverSlice
 * @param {SliceSpec} spec
 * @returns {string}
 */
const renderSliceRuntimeReport = (driverSlice, spec) => {
  const details = driverSlice.runtimeDetails;
  const lines = ['Hardening layers in effect:'];
  // Network profile is always present.
  lines.push(`  network: ${spec.network}`);
  if (details === undefined) {
    lines.push('  (driver did not report runtime details)');
    return lines.join('\n');
  }
  if (details.landlock !== undefined) {
    if (details.landlock.available) {
      lines.push('  landlock: available');
    } else {
      const why =
        details.landlock.reason !== undefined
          ? ` (${details.landlock.reason})`
          : '';
      lines.push(`  landlock: unavailable${why}`);
    }
  } else {
    lines.push('  landlock: not detected');
  }
  if (details.cgroup2 !== undefined) {
    if (details.cgroup2.available) {
      lines.push(
        `  cgroup2: available (controllers: ${details.cgroup2.controllers.join(', ')})`,
      );
    } else {
      const why =
        details.cgroup2.reason !== undefined
          ? ` (${details.cgroup2.reason})`
          : '';
      lines.push(`  cgroup2: unavailable${why}`);
    }
  } else {
    lines.push('  cgroup2: not detected');
  }
  if (details.prlimit !== undefined && details.prlimit.applied.length > 0) {
    lines.push(`  prlimit: ${details.prlimit.applied.join(' ')}`);
  } else {
    lines.push('  prlimit: (none applied)');
  }
  if (details.rootless !== undefined) {
    if (details.rootless.available) {
      lines.push('  rootless: yes');
    } else {
      const why =
        details.rootless.reason !== undefined
          ? ` (${details.rootless.reason})`
          : '';
      lines.push(`  rootless: no${why}`);
    }
  }
  if (details.rootlessNet !== undefined) {
    if (details.rootlessNet.backend !== null) {
      lines.push(`  rootless-net: ${details.rootlessNet.backend}`);
    } else {
      const why =
        details.rootlessNet.reason !== undefined
          ? ` (${details.rootlessNet.reason})`
          : '';
      lines.push(`  rootless-net: none${why}`);
    }
  }
  if (details.path !== undefined) {
    // `source` distinguishes "caller set this" / "the OCI image set
    // this" / "we fell back to the cross-driver default" — useful
    // when debugging "why can't my slice find `apk`" cases.
    lines.push(
      `  path: ${details.path.value} (source: ${details.path.source})`,
    );
  }
  return lines.join('\n');
};
harden(renderSliceRuntimeReport);

const PROCESS_HELP = `\
ProcessHandle — a process running inside a slice.

Stdio uses Endo's reader-ref / writer-ref plumbing.

Methods:
  pid()               Pid as observed inside the slice.
  stdin/stdout/stderr Stdio refs (when captured).
  wait()              Resolves with { code, signal }.
  kill(signal?)       Terminate the process tree: deliver the
                      termination signal (SIGTERM by default), escalate
                      to SIGKILL, and reap.
`;

const MOUNT_HELP = `\
MountHandle — a mount bound into a slice.

Methods:
  innerPath()  Path inside the slice.
  cap()        Back-reference to the original Mount capability.
  mode()       'ro' or 'rw'.
  unmount()    Detach the mount from the slice.
`;

const KILL_GRACE_MS = 1000;
const DRAIN_GRACE_MS = 250;
const DEFAULT_BYTE_LIMIT = 16n * 1024n * 1024n;
/**
 * Resolve after a bounded delay without keeping the daemon alive solely for
 * the timer.
 *
 * @param {number} ms
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
const delay = ms => {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const promise = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  // Every caller races this against real work, so the loser is dead the
  // moment the race settles; `cancel` lets the caller drop the timer
  // (and the resolve closure it retains) instead of leaving one live
  // entry in the timer heap per spawn and per kill.
  return harden({ promise, cancel: () => clearTimeout(timer) });
};
harden(delay);

/**
 * Race real work against a bounded delay, releasing the timer either
 * way.
 *
 * @param {Promise<unknown>} work
 * @param {number} ms
 * @param {typeof delay} [makeDelay]
 * @returns {Promise<void>}
 */
const raceDelay = async (work, ms, makeDelay = delay) => {
  await null;
  const timeout = makeDelay(ms);
  try {
    await Promise.race([work, timeout.promise]);
  } finally {
    timeout.cancel();
  }
};
harden(raceDelay);

/**
 * Wrap driver-side stdin write closures as the `PassableBytesWriter` that
 * `ProcessHandle.stdin()` hands out: the same exo-stream plumbing as the
 * stdout and stderr readers, driven by `iterateBytesWriter` with the bytes
 * crossing CapTP base64-encoded. A writer that took chunks directly could not
 * be used at all: a mutable `Uint8Array` is not passable, so its own guard
 * refused every write.
 *
 * The driver exposes `writeStdin(chunk)` / `closeStdin()` instead of
 * the raw Node stream so the DriverProcess surface remains hardenable
 * (Node streams cannot be deep-frozen). A process spawned without a
 * writable stdin rejects every write: the pump acknowledges a chunk its sink
 * accepted whatever the sink answers, so reporting `done` there would let
 * the bytes vanish while the caller believes they were delivered.
 *
 * @param {(chunk: Uint8Array) => Promise<void>} [write]
 * @param {() => Promise<void>} [close]
 */
const makeWriterExoFromClosures = (write, close) =>
  bytesWriterFromIterator(
    harden({
      /** @param {Uint8Array} chunk */
      async next(chunk) {
        await null;
        if (write === undefined) {
          throw makeError(X`sandbox process stdin is not writable`);
        }
        await write(chunk);
        return harden({ done: false, value: undefined });
      },
      async return() {
        await null;
        if (close !== undefined) await close();
        return harden({ done: true, value: undefined });
      },
    }),
  );
harden(makeWriterExoFromClosures);

/**
 * Resolve a `Mount` capability to a host filesystem path via the
 * `provideHostPath` power. Throws a structured error when the power
 * is missing or when the resolution fails.
 *
 * @param {any} scratchProvider
 * @param {MountCap} cap
 * @param {string} context
 * @returns {Promise<string>}
 */
const resolveHostPath = async (scratchProvider, cap, context) => {
  await null;
  // Always go through eventual-send.  This works for both local
  // record-shaped powers and remote refs, and lets us treat the
  // resolution failure as a structured error consistently.
  try {
    return await E(scratchProvider).provideHostPath(cap);
  } catch (e) {
    throw makeError(
      X`failed to resolve mount cap for ${q(context)}: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
};

/**
 * Construct the guarded public factory and its host-only shutdown control.
 * The runtime owner must retain close for retries until all resources are gone.
 *
 * The local makeResolved method grants native path authority. Only a host
 * administrator may call it, after resolving and retaining mount formulas.
 * It shares the public factory's admission and cleanup owner, but never
 * acquires daemon mounts and returns a handle with static mounts only.
 *
 * @param {MakeSandboxFactoryKitInput} input
 * @param {{ makeDelay?: typeof delay }} [powers]
 * @returns {Readonly<{ factory: SandboxFactory, makeResolved(opts: NativeSandboxMakeOpts): Promise<NativeSandboxHandle>, close(reason?: Error): Promise<void> }>}
 */
export const makeSandboxFactoryKit = (
  { drivers, scratchProvider, context },
  { makeDelay = delay } = {},
) => {
  const requireScratchProvider = () => {
    if (scratchProvider === null)
      throw Fail`Sandbox capability construction requires a scratch provider`;
    return scratchProvider;
  };
  const driverList = harden([...drivers]);
  const slices = makeResourceRegistry();
  /** @type {Set<() => Promise<void>>} */
  const liveClosers = new Set();
  let nextAcquisition = 0n;
  /** @type {Promise<void> | undefined} */
  let closeFlight;
  // Set once the factory has lost its owner — by cancellation, by
  // disconnection, or by being handed a context that cannot report
  // either. See the `whenCancelled` hookup at the end of this function
  // for why those three are deliberately one case. Its presence *is*
  // the "no longer minting slices" flag; the value is kept so later
  // callers can be told which of the three happened.
  /** @type {Error | undefined} */
  let ownerLost;

  /**
   * @param {Error} lost
   * @returns {Error}
   */
  const ownerCancelledError = lost =>
    makeError(X`sandbox factory owner has been cancelled: ${q(lost.message)}`);

  const assertOwner = () => {
    if (ownerLost !== undefined) throw ownerCancelledError(ownerLost);
  };

  /**
   * @template T
   * @param {(id: string) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const acquire = operation => {
    if (ownerLost !== undefined)
      return Promise.reject(ownerCancelledError(ownerLost));
    const id = String(nextAcquisition);
    nextAcquisition += 1n;
    return slices.inOrder(id, () => operation(id));
  };

  /**
   * Require the lifecycle proof that this cut relies on. A driver may have a
   * working binary while still lacking whole-tree termination or crash
   * cleanup; that driver is unavailable, not a weaker fallback.
   *
   * @param {SandboxDriver} driver
   * @param {Omit<BackendProbe, 'name'>} probe
   * @returns {BackendProbe}
   */
  const normalizeProbe = (driver, probe) => {
    const lifecycle = probe.details?.lifecycle;
    if (probe.available && lifecycle?.available !== true) {
      return harden({
        name: driver.name,
        available: false,
        ...(probe.version !== undefined ? { version: probe.version } : {}),
        ...(probe.details !== undefined ? { details: probe.details } : {}),
        reason:
          lifecycle?.reason ??
          'driver did not prove process-group termination and crash cleanup',
      });
    }
    return harden({ name: driver.name, ...probe });
  };

  /**
   * Probe one driver, reporting a thrown probe as an unavailable
   * backend rather than propagating it. Both the listing and the
   * selection path go through here so the failure shape cannot drift
   * between them.
   *
   * @param {SandboxDriver} driver
   * @returns {Promise<BackendProbe>}
   */
  const probeDriver = driver =>
    driver.probe().then(
      value => normalizeProbe(driver, value),
      e =>
        harden({
          name: driver.name,
          available: false,
          reason: /** @type {Error} */ (e).message || String(e),
        }),
    );

  /**
   * @returns {Promise<BackendProbe[]>}
   */
  const listBackends = () =>
    acquire(async () => {
      const probes = await Promise.all(driverList.map(probeDriver));
      assertOwner();
      return harden(probes);
    });

  /**
   * @param {SandboxMakeOpts['backend']} selector
   * @param {boolean} [needsPolicy] Consider only drivers that can
   *   enforce and attest a slice policy.
   * @param {boolean} [needsGeneratedFiles] Require private literal-file staging.
   * @returns {Promise<{ driver?: SandboxDriver; failures: BackendProbe[] }>}
   */
  const pickDriver = async (
    selector,
    needsPolicy = false,
    needsGeneratedFiles = false,
  ) => {
    await null;
    const named =
      selector === undefined || selector === 'auto'
        ? driverList
        : driverList.filter(driver => driver.name === selector);
    // A backend that cannot attest is not a candidate for a slice that
    // has to be attested. Without this, `auto` picks the first available
    // driver — bwrap, which `agent.js` registers first — and every
    // policy slice fails on a host that has both backends installed.
    const candidates = named.filter(
      driver =>
        (!needsPolicy || driver.policy !== undefined) &&
        (!needsGeneratedFiles || driver.supportsGeneratedFiles === true),
    );
    /** @type {BackendProbe[]} */
    const failures = [];
    for (const driver of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await probeDriver(driver);
      if (probe.available)
        return harden({ driver, failures: harden(failures) });
      failures.push(probe);
    }
    return harden({ driver: undefined, failures: harden(failures) });
  };

  /**
   * Resolve the `RootfsSpec` to a driver-friendly shape.
   *
   * @param {RootfsSpec} rootfs
   * @returns {Promise<SliceSpec['rootfs']>}
   */
  const resolveRootfs = async rootfs => {
    if (
      typeof rootfs === 'object' &&
      rootfs !== null &&
      'kind' in rootfs &&
      (rootfs.kind === 'host-bind' || rootfs.kind === 'minimal')
    ) {
      return harden({ kind: rootfs.kind });
    }
    if (
      typeof rootfs === 'object' &&
      rootfs !== null &&
      'kind' in rootfs &&
      rootfs.kind === 'oci'
    ) {
      const ociSpec = /** @type {{ kind: 'oci'; ref: string }} */ (rootfs);
      return harden({ kind: 'oci', ref: ociSpec.ref });
    }
    // Otherwise treat it as a Mount cap.
    const hostPath = await resolveHostPath(
      requireScratchProvider(),
      /** @type {MountCap} */ (rootfs),
      'rootfs',
    );
    return harden({ kind: 'mount', hostPath, mode: 'ro' });
  };

  /**
   * @param {MountSpec} mount
   * @returns {Promise<{ hostPath: string; innerPath: string; mode: MountMode }>}
   */
  const resolveMount = async mount => {
    const hostPath = await resolveHostPath(
      requireScratchProvider(),
      mount.cap,
      `mount ${mount.innerPath}`,
    );
    return harden({
      hostPath,
      innerPath: mount.innerPath,
      mode: /** @type {MountMode} */ (mount.mode ?? 'ro'),
    });
  };

  /**
   * Acquire a writable scratch host path. Tries `provideHostPath`
   * against a freshly minted scratch mount; if the powers cannot
   * resolve it, falls back to a daemon-side scratch path string when
   * the powers expose one. Phase 1 supports both pathways so tests
   * can supply a real tmpdir without round-tripping through a Mount
   * cap.
   *
   * @returns {Promise<string>}
   */
  const acquireScratchHostPath = async () => {
    await null;
    // Preferred path: mint a scratch mount and resolve it via
    // `provideHostPath`.
    try {
      const scratchCap = await E(requireScratchProvider()).provideScratchMount(
        'sandbox-scratch',
      );
      return await resolveHostPath(
        requireScratchProvider(),
        /** @type {MountCap} */ (scratchCap),
        'scratch upper layer',
      );
    } catch (e) {
      throw makeError(
        X`could not allocate sandbox scratch host path: ${q(/** @type {Error} */ (e).message)}`,
      );
    }
  };

  /** @param {SandboxMakeOpts} opts */
  const resolvePathsFromCaps = async opts => {
    const rootfs = await resolveRootfs(opts.rootfs);
    assertOwner();
    const resolvedMounts = await Promise.all(
      (opts.mounts ?? []).map(resolveMount),
    );
    assertOwner();
    let scratchHostPath = '';
    try {
      // A policy already declares the complete mount table. OCI provides its
      // own writable layer; the generic capability API still permits scratch
      // when its provider can supply one.
      if (opts.policy === undefined)
        scratchHostPath = await acquireScratchHostPath();
    } catch (error) {
      if (rootfs.kind === 'minimal' && resolvedMounts.length === 0) throw error;
    }
    return harden({ rootfs, mounts: resolvedMounts, scratchHostPath });
  };

  /**
   * @param {SandboxMakeOpts | NativeSandboxMakeOpts} opts
   * @param {string} sliceId
   * @param {() => Promise<Pick<SliceSpec, 'rootfs' | 'mounts' | 'scratchHostPath'>>} resolvePaths
   * @param {boolean} nativeOnly
   * @returns {Promise<NativeSandboxHandle | SandboxHandle>}
   */
  const buildSlice = async (opts, sliceId, resolvePaths, nativeOnly) => {
    assertOwner();
    if ((opts.network === 'join') !== (opts.networkRef !== undefined)) {
      // Backend-independent: every driver must agree the container ref is
      // exactly what `network: 'join'` names, so a driver that ignores the
      // field cannot silently run the slice somewhere else.
      throw makeError(
        X`network 'join' requires a networkRef container and no other profile accepts one`,
      );
    }
    if (opts.network === 'join' && opts.policy !== undefined) {
      throw makeError(X`network 'join' cannot be combined with a slice policy`);
    }
    const selector = opts.backend ?? 'auto';
    const needsPolicy = opts.policy !== undefined;
    const generatedFiles = validateGeneratedFiles(
      opts.generatedFiles ?? [],
      (opts.mounts ?? []).map(mount => mount.innerPath),
    );
    if (needsPolicy && generatedFiles.length > 0) {
      throw makeError(
        X`Generated files cannot extend an exact slice policy mount table`,
      );
    }
    const selected = await pickDriver(
      selector,
      needsPolicy,
      generatedFiles.length > 0,
    );
    assertOwner();
    const { driver } = selected;
    if (driver === undefined) {
      if (generatedFiles.length > 0) {
        throw makeError(
          X`No available sandbox backend supports generated files for ${q(selector)}`,
        );
      }
      const reasons = selected.failures
        .map(probe => `${probe.name}: ${probe.reason ?? 'unavailable'}`)
        .join('; ');
      throw makeError(
        needsPolicy
          ? X`no backend that can enforce and attest a slice policy is available for ${q(selector)}: ${reasons || 'no policy-capable driver registered'}`
          : X`no backend available for ${q(selector)}: ${reasons || 'no drivers registered'}`,
      );
    }

    const {
      rootfs,
      mounts: resolvedMounts,
      scratchHostPath,
    } = await resolvePaths();
    assertOwner();
    if (needsPolicy && scratchHostPath !== '') {
      throw makeError(
        X`Scratch cannot extend an exact slice policy mount table`,
      );
    }

    // Phase 1.5: merge caller-supplied resource caps onto the driver
    // defaults.  Drivers translate the resolved dictionary into a
    // `prlimit` prefix before exec.  Passing the merged dictionary
    // (rather than the raw overrides) keeps drivers ignorant of the
    // default policy table.
    const limits = resolveLimits(opts.limits);

    /** @type {SliceSpec} */
    const sliceSpec = harden({
      rootfs,
      mounts: harden(resolvedMounts),
      ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
      scratchHostPath,
      network: opts.network ?? 'none',
      ...(opts.networkRef !== undefined ? { networkRef: opts.networkRef } : {}),
      seccomp: opts.seccomp ?? 'default',
      env: harden({ ...(opts.env ?? {}) }),
      cwd: opts.cwd,
      limits,
      // Passed through as the caller wrote it: validating a policy
      // means saying which controls the backend can enforce and read
      // back, and only the driver knows that.
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    });

    assertOwner();
    let preparation;
    if (driver.prepareSliceKit !== undefined) {
      preparation = driver.prepareSliceKit(sliceSpec);
    } else {
      // Legacy drivers only transfer ownership after successful preparation.
      // Their failed acquisitions cannot be cleaned up through this factory.
      const slice = await driver.prepareSlice(sliceSpec);
      preparation = {
        value: Promise.resolve(slice),
        close: () => driver.teardown(slice),
      };
    }
    // Retain before waiting for preparation, rendering, or handle construction.
    // Once built, disposal also releases processes and dynamic mounts.
    let disposeOwned = preparation.close;
    /** @type {Promise<void> | undefined} */
    let cleanupFlight;
    const cleanupOwned = () => {
      cleanupFlight ??= (async () => {
        await disposeOwned();
        slices.release(sliceId, cleanupOwned);
        liveClosers.delete(cleanupOwned);
      })().catch(error => {
        cleanupFlight = undefined;
        throw error;
      });
      return cleanupFlight;
    };
    slices.retain(sliceId, cleanupOwned);
    liveClosers.add(cleanupOwned);
    const driverSlice = await preparation.value;
    // Drivers may attach a `runtimeDetails` summary to the slice
    // context.  When present, the factory weaves it into the
    // per-slice `help()` text so callers can see which hardening
    // layers (Landlock, cgroup v2, prlimit) are actually in effect
    // without having to round-trip through `listBackends()`.
    /** @type {string} */
    const sliceRuntimeReport = renderSliceRuntimeReport(
      /** @type {any} */ (driverSlice),
      sliceSpec,
    );

    /**
     * Refuse the mount-granting methods on a policy slice.
     *
     * The policy declares the whole mount table and `policy()` attests
     * that table as exact. Handing back a `MountHandle` afterwards would
     * consume a host scratch allocation the daemon must later reclaim and
     * report an `innerPath` the slice does not have — a capability that
     * contradicts the attestation the same slice hands out.
     *
     * @param {string} method
     */
    const assertNoPolicy = method => {
      if (needsPolicy) {
        throw makeError(
          X`${q(method)} is not available on a policy slice: the policy declares the whole mount table`,
        );
      }
    };

    /** @type {Set<{ killAndReap: (reason: Error, initialSignal?: TerminationSignal) => Promise<void> }>} */
    const liveProcesses = new Set();
    /** @type {Set<MountHandle>} */
    const liveMounts = new Set();
    /** @type {Promise<void> | undefined} */
    let disposePromise;
    /** @type {Error | undefined} */
    let stoppingReason;

    // Stopping is permanent; a failed cleanup attempt remains retryable.
    const assertRunning = () => {
      stoppingReason === undefined || Fail`sandbox handle has been disposed`;
    };

    /**
     * @param {readonly string[]} argv
     * @param {SpawnOpts} [spawnOpts]
     * @returns {Promise<ProcessHandle>}
     *
     * Termination initiated before this promise settles rejects the spawn,
     * even when admission has already resolved; the background reap
     * continues. A resolved handle means admission and ownership were still
     * valid at settlement. Later failures surface through `wait()`.
     */
    const spawnProc = async (argv, spawnOpts = {}) => {
      assertRunning();

      // Assigned at the registration point below, before the driver
      // boundary is crossed and therefore before anything can read it.
      /** @type {Promise<DriverProcess>} */
      let driverProcessPromise;

      // Admission cancellation. The driver receives the token so it can
      // abort its in-flight control command and remove the exact named
      // operation; the factory additionally treats a pending admission as
      // abandonable, so a driver that stalls (or ignores the token) can
      // never hold up the caller's admission timeout. Disposal still requires
      // the driver to account for every pending acquisition.
      const {
        cancelled: admissionCancelled,
        cancel: cancelAdmission,
        isCancelled: isAdmissionCancelled,
      } = makeCancelKit();
      const spawnControls = harden({
        cancelled: admissionCancelled,
        isCancelled: isAdmissionCancelled,
      });
      let admissionAbandoned = false;
      /** @type {DriverProcess | undefined} */
      let admittedProc;
      // Record the admitted process, and reap a process a driver produces
      // only after the lease has been abandoned so the operation cannot
      // outlive its owner. Whichever of this reaction and an abandoning
      // path runs last observes the other's state, so exactly one of
      // them terminates a late arrival.
      /** @param {DriverProcess} proc */
      const observeAdmission = proc => {
        admittedProc = proc;
        if (!admissionAbandoned) return;
        void reapProcess(
          proc,
          terminalError ?? makeError(X`sandbox admission abandoned`),
          'SIGKILL',
        ).catch(() => undefined);
      };

      /** @type {Error | undefined} */
      let terminalError;
      // Rejects if cleanup cannot prove containment, so wait() settles
      // with the cleanup error instead of hanging on the driver's reap
      // primitive.
      const { cancelled: containmentFailed, cancel: signalContainmentFailure } =
        makeCancelKit();
      /** @type {Promise<void> | undefined} */
      let killPromise;
      // The capture readers cannot be built until admission returns the
      // driver's streams, but termination and drain may both run before
      // that. One promise of the controls carries the "not yet attached"
      // state, so no early-exit path has to remember to trip a separate
      // latch as well as publish the (possibly empty) array.
      const { promise: streamControls, resolve: publishStreamControls } =
        /** @type {import('@endo/promise-kit').PromiseKit<Array<{ finished: Promise<void>, close: () => void }>>} */ (
          makePromiseKit()
        );
      /** @type {Promise<void> | undefined} */
      let drainPromise;

      const boundedDrain = () => {
        if (drainPromise === undefined) {
          drainPromise = (async () => {
            const controls = await streamControls;
            await raceDelay(
              Promise.all(controls.map(control => control.finished)),
              DRAIN_GRACE_MS,
              makeDelay,
            );
            for (const control of controls) control.close();
          })();
        }
        return drainPromise;
      };

      /**
       * Reap one admitted process, including a late arrival after abandonment.
       * Failure fences the slice before initiating its single disposal path.
       *
       * @param {DriverProcess} driverProc
       * @param {Error} reason
       * @param {TerminationSignal} initialSignal
       */
      const reapProcess = async (driverProc, reason, initialSignal) => {
        const failures = [];
        let reaped = false;
        const exitTracked = Promise.resolve()
          .then(() => driverProc.wait())
          .then(
            () => {
              reaped = true;
            },
            error => {
              failures.push(error);
            },
          );
        const hardFirst = initialSignal === 'SIGKILL';
        let hardKillDelivered = false;
        try {
          await driverProc.kill(initialSignal);
          hardKillDelivered = hardFirst;
        } catch (error) {
          failures.push(error);
        }
        if (!hardFirst && failures.length === 0) {
          await raceDelay(exitTracked, KILL_GRACE_MS, makeDelay);
        }
        if (!reaped && !hardKillDelivered) {
          try {
            await driverProc.kill('SIGKILL');
          } catch (error) {
            failures.push(error);
          }
        }
        // A delivered signal is not a reap proof. Bound the wait even when
        // SIGKILL was accepted, and never treat a rejected wait as success.
        if (!reaped) await raceDelay(exitTracked, KILL_GRACE_MS, makeDelay);
        if (!reaped) {
          const detail = failures.length
            ? failures
                .map(error =>
                  error instanceof Error ? error.message : String(error),
                )
                .join('; ')
            : 'driver did not report process reaped';
          const failure = makeError(
            X`sandbox cleanup could not prove containment: ${q(detail)}`,
          );
          // Do not await disposal here: it awaits this process's lease.
          // Admission closes synchronously before any slice teardown starts.
          void beginDispose(
            makeError(
              X`sandbox slice torn down after a containment failure: ${q(reason.message)}; ${q(failure.message)}`,
            ),
          ).catch(() => undefined);
          signalContainmentFailure(failure);
          await boundedDrain();
          throw failure;
        }
        await boundedDrain();
      };

      /**
       * The sole termination path. It is safe to call before the driver has
       * finished spawning: a pending admission is cancelled and abandoned
       * rather than awaited, so a stalled driver call cannot delay
       * settlement, and a process that arrives after abandonment is still
       * terminated and reaped. Once a process is admitted this signals the
       * whole driver-owned process group/container, escalates, and does not
       * settle until the driver reports the child reaped.
       *
       * @param {Error} reason
       * @param {TerminationSignal} [initialSignal]
       */
      const killAndReap = (reason, initialSignal = 'SIGTERM') => {
        terminalError ??= reason;
        if (killPromise === undefined) {
          killPromise = (async () => {
            await null;
            // Cancel a still-pending admission first so this settles even
            // when the driver call never does.
            cancelAdmission(reason);
            // The cancellation loses the race only when the admission
            // never landed; a process that landed while the race was
            // settling is still visible in `admittedProc`, and is
            // terminated here rather than by the abandonment reaction.
            const driverProc = await Promise.race([
              driverProcessPromise,
              admissionCancelled,
            ]).catch(() => admittedProc);
            if (driverProc === undefined) {
              // No controllable process exists yet. A late arrival is
              // reaped by the abandoned-admission reaction above.
              admissionAbandoned = true;
              return;
            }
            await reapProcess(driverProc, reason, initialSignal);
          })();
          killPromise.catch(() => undefined);
        }
        return killPromise;
      };

      const lease = harden({ killAndReap });
      // Registration happens before the first driver call. JavaScript's
      // run-to-completion rule makes this the serialized admission point:
      // dispose either snapshots this lease or spawn observes stopping.
      liveProcesses.add(lease);

      // Cross the driver boundary only after the lease is observable.
      // `Promise.resolve().then` defers the call itself to a microtask,
      // so the registration above is already visible when it runs.
      driverProcessPromise = Promise.resolve().then(() =>
        driver.spawn(driverSlice, [...argv], spawnOpts, spawnControls),
      );
      driverProcessPromise.then(observeAdmission, () => undefined);

      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timeoutTimer;
      if (spawnOpts.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          void killAndReap(
            makeError(
              X`sandbox process timed out after ${spawnOpts.timeoutMs}ms`,
            ),
          );
        }, spawnOpts.timeoutMs);
        if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
      }

      let driverProc;
      try {
        // Waiting on admission races the cancellation so a stalled driver
        // call rejects the caller instead of hanging the spawn.
        // eslint-disable-next-line @jessie.js/safe-await-separator
        driverProc = await Promise.race([
          driverProcessPromise,
          admissionCancelled,
        ]);
      } catch (e) {
        admissionAbandoned = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        publishStreamControls([]);
        liveProcesses.delete(lease);
        throw e;
      }

      // Preserve the admission-failure contract when termination wins between
      // driver admission and spawn settlement; reap in the background.
      if (terminalError !== undefined) {
        admissionAbandoned = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        publishStreamControls([]);
        liveProcesses.delete(lease);
        throw terminalError;
      }

      /**
       * @param {Error} error
       * @param {'stdout' | 'stderr'} label
       */
      const onReaderFailure = (error, label) => {
        void killAndReap(
          makeError(
            X`sandbox ${label} failure requires process termination: ${q(error.message)}`,
          ),
        );
      };
      /**
       * @param {'stdout' | 'stderr'} label
       * @param {boolean | undefined} capture
       * @param {bigint | undefined} byteLimit
       */
      const captureStream = (label, capture, byteLimit) =>
        makeEagerReader(
          capture === false
            ? undefined
            : /** @type {AsyncIterable<Uint8Array> | null} */ (
                driverProc[label] ?? undefined
              ),
          {
            label,
            byteLimit: byteLimit ?? DEFAULT_BYTE_LIMIT,
            onFailure: error => onReaderFailure(error, label),
          },
        );
      const stdoutControl = captureStream(
        'stdout',
        spawnOpts.captureStdout,
        spawnOpts.stdoutByteLimit,
      );
      const stderrControl = captureStream(
        'stderr',
        spawnOpts.captureStderr,
        spawnOpts.stderrByteLimit,
      );
      publishStreamControls([stdoutControl, stderrControl]);

      // The driver exposes `writeStdin` / `closeStdin` closures (see
      // drivers/bwrap.js) so the writer adapter does not need to
      // touch the raw Node stream.
      const extDriverProc =
        /** @type {{ writeStdin?: (chunk: Uint8Array) => Promise<void>; closeStdin?: () => Promise<void> }} */ (
          /** @type {any} */ (driverProc)
        );
      const stdinRef = makeWriterExoFromClosures(
        extDriverProc.writeStdin,
        extDriverProc.closeStdin,
      );

      const completion = (async () => {
        await null;
        let status;
        try {
          status = await Promise.race([driverProc.wait(), containmentFailed]);
        } catch (e) {
          const failure = makeError(
            X`sandbox process wait failed: ${q(/** @type {Error} */ (e).message)}`,
          );
          await killAndReap(failure);
          throw failure;
        } finally {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        }
        await boundedDrain();
        if (terminalError !== undefined) {
          await killAndReap(terminalError);
          throw terminalError;
        }
        return status;
      })().finally(() => liveProcesses.delete(lease));
      completion.catch(() => undefined);

      /** @type {ProcessHandle} */
      const procHandle = /** @type {any} */ (
        makeExo('SandboxProcess', ProcessHandleInterface, {
          help: () => PROCESS_HELP,
          pid: () => driverProc.pid,
          stdin: () => stdinRef,
          stdout: () => stdoutControl.reader,
          stderr: () => stderrControl.reader,
          wait: () => completion,
          // The interface guard narrows `signal` to a TerminationSignal
          // and `killAndReap` supplies the default, so this forwards
          // verbatim rather than re-defaulting.
          kill: async signal => {
            await killAndReap(makeError(X`sandbox process cancelled`), signal);
          },
        })
      );
      return procHandle;
    };

    /**
     * @param {MountCap} cap
     * @param {string} innerPath
     * @param {MountMode} [mode]
     * @returns {MountHandle}
     */
    const makeMountHandle = (cap, innerPath, mode = 'ro') => {
      let unmounted = false;
      /** @type {MountHandle} */
      const m = /** @type {any} */ (
        makeExo('SandboxMount', /** @type {any} */ (MountHandleInterface), {
          help: () => MOUNT_HELP,
          innerPath: () => innerPath,
          cap: () => /** @type {any} */ (cap),
          mode: () => mode,
          unmount: async () => {
            unmounted = true;
            liveMounts.delete(m);
          },
        })
      );
      void unmounted;
      liveMounts.add(m);
      return m;
    };

    /**
     * @param {MountCap} cap
     * @param {string} innerPath
     * @param {MountMode} [mode]
     */
    const mountInSlice = async (cap, innerPath, mode = 'ro') => {
      assertRunning();
      assertNoPolicy('mount');
      // Phase 1 only supports mounts declared at slice construction;
      // dynamic mounts after the fact would require remounting bwrap.
      // We still mint a tracker so dispose() can iterate.
      return makeMountHandle(cap, innerPath, mode);
    };

    /**
     * @param {string} innerPath
     */
    const scratchInSlice = async innerPath => {
      assertRunning();
      assertNoPolicy('scratch');
      // Lifecycle is bound to the slice; the daemon's scratch GC
      // sweeps the host directory when the cap is unpinned.
      const scratchCap = /** @type {MountCap} */ (
        await E(requireScratchProvider()).provideScratchMount(
          `sandbox-scratch-${innerPath.replace(/[^a-zA-Z0-9-]/g, '-')}`,
        )
      );
      assertRunning();
      return makeMountHandle(scratchCap, innerPath, 'rw');
    };

    /**
     * @param {string} innerPath
     */
    const openInSlice = async innerPath => {
      throw makeError(
        X`open(${q(innerPath)}) requires a ReadableFile cap from the slice driver; not implemented before Phase 2`,
      );
    };

    const forkSlice = async () => {
      throw makeError(X`fork not implemented before Phase 3`);
    };

    /**
     * Report the slice's policy attestation.
     *
     * `assertRunning` first: an attestation is a statement about a
     * slice that is still confined by what it describes, and a disposed
     * slice is not confined by anything.
     *
     * @returns {Promise<import('./types.js').SlicePolicyAttestation>}
     */
    const attestPolicy = async () => {
      assertRunning();
      if (driver.policy === undefined) {
        throw makeError(
          X`backend ${q(driver.name)} cannot attest a slice policy`,
        );
      }
      return driver.policy(driverSlice);
    };

    const resetSlice = async () => {
      const reason = makeError(X`sandbox handle reset`);
      await Promise.all(
        [...liveProcesses].map(lease => lease.killAndReap(reason)),
      );
    };

    /**
     * Permanently stop admission and start or share a cleanup attempt.
     * Failed attempts retain the handle for retry. Historical process errors
     * remain on their process promises; current driver release proves disposal.
     *
     * @param {Error} reason
     * @returns {Promise<void>}
     */
    const beginDispose = reason => {
      stoppingReason ??= reason;
      const stopReason = stoppingReason;
      if (disposePromise === undefined) {
        const leases = [...liveProcesses];
        disposePromise = (async () => {
          // Independent lease failures must not prevent driver cleanup.
          await Promise.allSettled(
            leases.map(lease => lease.killAndReap(stopReason)),
          );
          // Only the driver can prove that pending acquisitions and retained
          // processes are released, even when their historical waits failed.
          try {
            await driver.teardown(driverSlice);
          } catch (error) {
            const failure =
              error instanceof Error ? error : makeError(X`${q(error)}`);
            throw makeError(
              X`sandbox dispose could not prove containment: ${q(failure.message)}`,
              undefined,
              { cause: failure },
            );
          }
          await Promise.all([...liveMounts].map(m => E(m).unmount()));
          slices.release(sliceId, cleanupOwned);
          liveClosers.delete(cleanupOwned);
        })().catch(error => {
          disposePromise = undefined;
          throw error;
        });
      }
      return disposePromise;
    };

    const disposeSlice = () =>
      beginDispose(makeError(X`sandbox handle disposed`));
    disposeOwned = disposeSlice;

    const sharedMethods = {
      help: () =>
        nativeOnly
          ? `Native sandbox with static mounts. Methods: help, spawn, policy, reset, dispose.\n${sliceRuntimeReport}`
          : `${HANDLE_HELP_BASE}\n${sliceRuntimeReport}`,
      spawn: (argv, spawnOptions = {}) => {
        if (nativeOnly) assertCopyData(harden(spawnOptions));
        return spawnProc(argv, spawnOptions);
      },
      policy: attestPolicy,
      reset: resetSlice,
      dispose: disposeSlice,
    };
    const mintedHandle = /** @type {NativeSandboxHandle | SandboxHandle} */ (
      /** @type {unknown} */ (
        nativeOnly
          ? makeExo('NativeSandboxHandle', NativeHandleInterface, sharedMethods)
          : makeExo('SandboxHandle', SandboxHandleInterface, {
              ...sharedMethods,
              mount: mountInSlice,
              scratch: scratchInSlice,
              open: openInSlice,
              fork: forkSlice,
            })
      )
    );
    // The owner may have been lost while this slice was being built, in
    // which case the cancellation sweep below has already run past this
    // handle: reject publication and let the acquisition wrapper clean up.
    const lostDuringMake = ownerLost;
    if (lostDuringMake !== undefined) {
      throw ownerCancelledError(lostDuringMake);
    }
    return mintedHandle;
  };

  /**
   * @overload
   * @param {SandboxMakeOpts} opts
   * @param {() => Promise<Pick<SliceSpec, 'rootfs' | 'mounts' | 'scratchHostPath'>>} resolvePaths
   * @param {false} nativeOnly
   * @returns {Promise<SandboxHandle>}
   */
  /**
   * @overload
   * @param {NativeSandboxMakeOpts} opts
   * @param {() => Promise<Pick<SliceSpec, 'rootfs' | 'mounts' | 'scratchHostPath'>>} resolvePaths
   * @param {true} nativeOnly
   * @returns {Promise<NativeSandboxHandle>}
   */
  /**
   * @param {SandboxMakeOpts | NativeSandboxMakeOpts} opts
   * @param {() => Promise<Pick<SliceSpec, 'rootfs' | 'mounts' | 'scratchHostPath'>>} resolvePaths
   * @param {boolean} nativeOnly
   */
  const makeOwned = (opts, resolvePaths, nativeOnly) =>
    acquire(async sliceId => {
      try {
        return await buildSlice(opts, sliceId, resolvePaths, nativeOnly);
      } catch (error) {
        try {
          await slices.stop(sliceId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Sandbox construction cleanup pending',
          );
        }
        throw error;
      }
    });

  /** @param {SandboxMakeOpts} opts */
  const make = opts => {
    requireScratchProvider();
    return makeOwned(opts, () => resolvePathsFromCaps(opts), false);
  };

  /** @param {NativeSandboxMakeOpts} opts */
  const makeResolved = opts => {
    const approved = harden(opts);
    assertCopyData(approved);
    return makeOwned(
      approved,
      async () =>
        harden({
          rootfs: approved.rootfs,
          mounts: [...(approved.mounts ?? [])],
          scratchHostPath: approved.scratchHostPath ?? '',
        }),
      true,
    );
  };

  /**
   * Host-only shutdown. Fence immediately and stop existing slices even while
   * another acquisition is pending. Registry drain accounts for late arrivals.
   * Failures retain ownership; only a successful close is cached permanently.
   * @param {Error} [reason]
   * @returns {Promise<void>}
   */
  const close = (reason = makeError(X`sandbox factory closed`)) => {
    ownerLost ??= reason;
    if (closeFlight !== undefined) return closeFlight;
    const drained = slices.shutdown();
    const stopping = [...liveClosers].map(cleanup => cleanup());
    closeFlight = (async () => {
      const results = await Promise.allSettled([drained, ...stopping]);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, 'Sandbox factory shutdown pending');
      }
    })().catch(error => {
      closeFlight = undefined;
      throw error;
    });
    return closeFlight;
  };

  /**
   * @param {string} [methodName]
   * @returns {string}
   */
  const help = methodName => {
    if (methodName === undefined) return FACTORY_HELP;
    const text =
      METHOD_HELP[/** @type {keyof typeof METHOD_HELP} */ (methodName)];
    if (text === undefined) {
      return `No documentation for method ${q(methodName)}.`;
    }
    return text;
  };

  if (context !== undefined) {
    // `whenCancelled` is typed `() => Promise<never>` (see
    // `packages/daemon/src/types.d.ts`, `FarContext`): it never
    // fulfills, so `.catch` is the idiomatic way to hook it up, not a
    // sign that only errors are being handled here.
    //
    // Three different events land in this handler, and all three are
    // deliberately treated as "the owner is gone":
    //   1. the owner really was cancelled — the intended case;
    //   2. the CapTP connection to the owner dropped, so the promise
    //      rejects as disconnected rather than as cancelled;
    //   3. `context` does not implement `whenCancelled` at all, so the
    //      send rejects immediately with a method-missing error.
    // Failing to *observe* cancellation is not the same event as
    // cancellation, but for a sandbox the safe collapse is the fail-
    // closed one: a slice that has lost contact with the owner whose
    // authority it runs on must stop running that owner's code, and a
    // factory that cannot tell whether its owner is alive must stop
    // minting slices. Case 3 is a construction bug, and burning the
    // factory immediately is how it gets noticed.
    //
    // Non-goal for now: distinguishing a transient disconnect from a
    // real cancellation and reconnecting across it. That needs a
    // reconnect-aware context (and a policy for what a slice may keep
    // doing while unreachable); revisit it when we need a sandbox to
    // survive a disconnection rather than fail closed on one. Until
    // then, the reason is carried into `ownerLost` so a later `make()`
    // says which of the three happened.
    E(context)
      .whenCancelled()
      .catch(reason => {
        const lost = makeError(
          X`sandbox factory owner is no longer reachable: ${q(/** @type {Error | undefined} */ (reason)?.message ?? reason)}`,
        );
        // The host kit retains retry authority if automatic cleanup fails.
        // No new admission can occur after this close attempt begins.
        return close(lost).catch(() => undefined);
      });
  }

  const factory = /** @type {SandboxFactory} */ (
    /** @type {unknown} */ (
      makeExo('SandboxFactory', SandboxFactoryInterface, {
        help,
        listBackends,
        make,
      })
    )
  );
  return harden({ factory, makeResolved, close });
};
harden(makeSandboxFactoryKit);

/**
 * Convenience constructor for callers that only need the public factory.
 * Runtime resource owners must retain the kit and await close before release.
 * @param {MakeSandboxFactoryInput} input
 * @param {{ makeDelay?: typeof delay }} [powers]
 * @returns {SandboxFactory}
 */
export const makeSandboxFactory = (input, powers) => {
  input.scratchProvider !== null ||
    Fail`Sandbox factory requires a scratch provider`;
  return makeSandboxFactoryKit(input, powers).factory;
};
harden(makeSandboxFactory);
