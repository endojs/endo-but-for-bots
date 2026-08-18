// @ts-check

/* global clearTimeout, setTimeout */

import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { M } from '@endo/patterns';

import {
  MountHandleInterface,
  ProcessHandleInterface,
  SandboxFactoryInterface,
  SandboxHandleInterface,
} from './interfaces.js';
import { resolveLimits } from './limits.js';

const AsyncWriterInterface = M.interface('SandboxWriter', {
  next: M.call().optional(M.any()).returns(M.promise()),
  return: M.call().optional(M.any()).returns(M.promise()),
  throw: M.call().optional(M.any()).returns(M.promise()),
});

/** @import { MakeSandboxFactoryInput, SandboxFactory, SandboxMakeOpts, SandboxDriver, BackendProbe, MountSpec, SliceSpec, MountCap, MountMode, SandboxHandle, ProcessHandle, MountHandle, SpawnOpts, DriverProcess, RootfsSpec, TerminationSignal } from './types.js' */

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
    'opts.network defaults to "none"; opts.backend defaults to "auto".',
});

const HANDLE_HELP_BASE = `\
SandboxHandle — a live confined POSIX slice.

Pinned by the formula that minted it. When dropped, every
ProcessHandle is killed and every MountHandle is unmounted before the
driver tears down the underlying namespace.

Methods:
  spawn(argv, opts)   Spawn a process in the slice.
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
// Captured output is coalesced into blocks of this size so the retained
// structure is bounded by the byte limit alone: at the 16 MiB default the
// queue holds at most 256 blocks, however small the source's chunks are.
const CAPTURE_BLOCK_SIZE = 64 * 1024;
// Blocks the reader pump may pull ahead of consumer demand. This is
// counted in blocks, not source chunks, so it multiplies by
// CAPTURE_BLOCK_SIZE: eight blocks is 512 KiB per stream, already far
// more than enough to keep a CapTP round trip pipelined.
const STREAM_BUFFER = 8;

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
 * @returns {Promise<void>}
 */
const raceDelay = async (work, ms) => {
  await null;
  const timeout = delay(ms);
  try {
    await Promise.race([work, timeout.promise]);
  } finally {
    timeout.cancel();
  }
};
harden(raceDelay);

/**
 * Eagerly pump a driver-local byte source into one passable reader.
 *
 * The pump starts at process admission, rather than when a remote consumer
 * first pulls. This both preserves output from short-lived processes and lets
 * the supervisor enforce a byte limit even when nobody consumes the reader.
 * Only this adapter sees the driver-local iterator; callers receive the one
 * `PassableBytesReader` capability and cannot accidentally merge stdout and
 * stderr authority.
 *
 * @param {AsyncIterable<Uint8Array> | null | undefined} iterable
 * @param {{ label: 'stdout' | 'stderr', byteLimit: bigint, onFailure: (error: Error) => void }} options
 * @returns {{ reader: object, finished: Promise<void>, close: () => void }}
 */
const makeEagerReader = (iterable, { label, byteLimit, onFailure }) => {
  /** @type {Uint8Array[]} */
  const queue = [];
  // Incoming bytes are copied into fixed-size blocks rather than queued
  // one entry per source chunk: the byte limit alone would not bound the
  // queue's per-chunk metadata or allocation overhead against a source
  // that streams one byte at a time.
  /** @type {Uint8Array | undefined} */
  let pendingBlock;
  let pendingLength = 0;
  /** @param {Uint8Array} bytes */
  const enqueueBytes = bytes => {
    let offset = 0;
    while (offset < bytes.length) {
      if (pendingBlock === undefined) {
        pendingBlock = new Uint8Array(CAPTURE_BLOCK_SIZE);
        pendingLength = 0;
      }
      const take = Math.min(
        CAPTURE_BLOCK_SIZE - pendingLength,
        bytes.length - offset,
      );
      pendingBlock.set(bytes.subarray(offset, offset + take), pendingLength);
      pendingLength += take;
      offset += take;
      if (pendingLength === CAPTURE_BLOCK_SIZE) {
        queue.push(pendingBlock);
        pendingBlock = undefined;
      }
    }
  };
  // Copy out a partially-filled block when a consumer catches up with
  // the queue, so consumption latency stays chunk-level while unconsumed
  // output still coalesces.
  const flushPendingBlock = () => {
    if (pendingBlock !== undefined && pendingLength > 0) {
      queue.push(pendingBlock.slice(0, pendingLength));
      pendingLength = 0;
    }
  };
  let byteCount = 0n;
  let ended = false;
  /** @type {Error | undefined} */
  let failure;
  /** @type {(() => void) | undefined} */
  let wakeWaiter;
  // This iterator is single-consumer by construction: one capture pump
  // fills it, one reader drains it, and the single `wakeWaiter` slot
  // above can only ever park one of them. Overlapping `next()` calls —
  // a consumer that pumps the same reader twice — are refused rather
  // than parked, because both alternatives are worse than an error.
  // Parking them overwrites the slot and strands every waiter but the
  // most recent, which is a permanent hang with no diagnostic; queueing
  // them instead would hand two consumers an arbitrary interleaved half
  // of one process's output each, with nothing to tell them apart from
  // the whole of it.
  // Nothing reachable from the `PassableBytesReader` surface can trip
  // this today — `bytesReaderFromIterator` serializes its own pulls —
  // so it is a tripwire on the contract, not a live failure path.
  let nextInFlight = false;
  const { promise: finished, resolve: finish } =
    /** @type {import('@endo/promise-kit').PromiseKit<void>} */ (
      makePromiseKit()
    );

  const wake = () => {
    const waiter = wakeWaiter;
    wakeWaiter = undefined;
    if (waiter !== undefined) waiter();
  };

  // Ending the source and settling `finished` are one event: the pump
  // has no more bytes to contribute. Buffered bytes stay readable.
  const close = () => {
    if (!ended) {
      ended = true;
      finish();
    }
    wake();
  };

  if (iterable === undefined || iterable === null) {
    close();
  } else {
    void (async () => {
      await null;
      try {
        for await (const value of iterable) {
          if (ended) return;
          const bytes =
            value instanceof Uint8Array
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(value);
          const remaining = byteLimit - byteCount;
          if (remaining > 0n) {
            // This conversion is exact because the narrowed branch proves the
            // remaining count is smaller than one typed-array chunk.
            const captured =
              BigInt(bytes.length) <= remaining
                ? bytes
                : bytes.subarray(0, Number(remaining));
            enqueueBytes(captured);
            byteCount += BigInt(captured.length);
            wake();
          }
          if (byteCount >= byteLimit) {
            failure = makeError(
              X`sandbox ${label} byte limit reached (${byteLimit})`,
            );
            onFailure(failure);
            close();
            return;
          }
        }
        close();
      } catch (e) {
        failure = makeError(
          X`sandbox ${label} reader failed: ${q(/** @type {Error} */ (e).message)}`,
        );
        onFailure(failure);
        close();
      }
    })();
  }

  /** @type {AsyncIterableIterator<Uint8Array>} */
  const iterator = {
    async next() {
      // Checked before the first await, so two calls made in the same
      // turn are still distinguishable from one call made twice.
      !nextInFlight ||
        Fail`sandbox ${q(label)} reader is single-consumer: concurrent next() is not supported`;
      nextInFlight = true;
      await null;
      try {
        for (;;) {
          if (queue.length === 0) flushPendingBlock();
          if (queue.length > 0) {
            // Deliberately NOT hardened, and the one place in this file
            // where that is true.
            //
            // `harden` walks a typed array element by element, so
            // freezing a 64 KiB block is 65536 property visits: measured
            // at ~490ms of blocking CPU per captured MiB on this host,
            // against ~0.1ms to freeze the enclosing result object
            // alone. At the 16 MiB default limit that is roughly eight
            // seconds of daemon-wide stall per stream — the daemon is
            // single-threaded, so it is paid by every other vat too.
            //
            // Nothing is given up for it. The block is minted here from
            // a fresh ArrayBuffer, is never aliased by the driver, and
            // is consumed by `bytesReaderFromIterator`, which
            // base64-encodes it into a string before any Passable
            // crosses a boundary. No caller ever holds a reference to
            // the raw buffer, so freezing it would protect nothing that
            // is reachable.
            return {
              done: false,
              value: /** @type {Uint8Array} */ (queue.shift()),
            };
          }
          if (failure !== undefined) throw failure;
          if (ended) return harden({ done: true, value: undefined });
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            wakeWaiter = () => resolve(undefined);
          });
        }
      } finally {
        nextInFlight = false;
      }
    },
    async return() {
      close();
      // A consumer that abandons the stream will never read the
      // buffered blocks, and the process handle outlives them: drop the
      // retained bytes rather than holding up to the byte limit per
      // stream for as long as the caller keeps the handle.
      queue.length = 0;
      pendingBlock = undefined;
      pendingLength = 0;
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return harden({
    reader: bytesReaderFromIterator(iterator, { buffer: STREAM_BUFFER }),
    finished,
    close,
  });
};
harden(makeEagerReader);

/**
 * Wrap driver-side stdin write closures as a `WriterRef`-shaped exo.
 * The driver exposes `writeStdin(chunk)` / `closeStdin()` instead of
 * the raw Node stream so the DriverProcess surface remains hardenable
 * (Node streams cannot be deep-frozen).
 *
 * @param {(chunk: Uint8Array) => Promise<void>} [write]
 * @param {() => Promise<void>} [close]
 * @returns {object}
 */
const makeWriterExoFromClosures = (write, close) => {
  return makeExo(
    'SandboxWriter',
    AsyncWriterInterface,
    /** @type {any} */ ({
      /** @param {Uint8Array} [chunk] */
      async next(chunk) {
        await null;
        if (write === undefined || chunk === undefined) {
          return harden({ done: true, value: undefined });
        }
        await write(chunk);
        return harden({ done: false, value: undefined });
      },
      async return() {
        await null;
        if (close !== undefined) await close();
        return harden({ done: true, value: undefined });
      },
      async throw(error) {
        await null;
        throw error;
      },
    }),
  );
};
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
 * Phase 1 factory.
 *
 * @param {MakeSandboxFactoryInput} input
 * @returns {SandboxFactory}
 */
export const makeSandboxFactory = ({ drivers, scratchProvider, context }) => {
  const driverList = harden([...drivers]);
  /** @type {Set<SandboxHandle>} */
  const liveHandles = new Set();
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
  const listBackends = async () => {
    const probes = await Promise.all(driverList.map(probeDriver));
    return harden(probes);
  };

  /**
   * @param {SandboxMakeOpts['backend']} selector
   * @returns {Promise<{ driver?: SandboxDriver; failures: BackendProbe[] }>}
   */
  const pickDriver = async selector => {
    await null;
    const candidates =
      selector === undefined || selector === 'auto'
        ? driverList
        : driverList.filter(driver => driver.name === selector);
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
      scratchProvider,
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
      scratchProvider,
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
      const scratchCap =
        await E(scratchProvider).provideScratchMount('sandbox-scratch');
      return await resolveHostPath(
        scratchProvider,
        /** @type {MountCap} */ (scratchCap),
        'scratch upper layer',
      );
    } catch (e) {
      throw makeError(
        X`could not allocate sandbox scratch host path: ${q(/** @type {Error} */ (e).message)}`,
      );
    }
  };

  /**
   * @param {SandboxMakeOpts} opts
   * @returns {Promise<SandboxHandle>}
   */
  const make = async opts => {
    if (ownerLost !== undefined) throw ownerCancelledError(ownerLost);
    const selector = opts.backend ?? 'auto';
    const selected = await pickDriver(selector);
    const { driver } = selected;
    if (driver === undefined) {
      const reasons = selected.failures
        .map(probe => `${probe.name}: ${probe.reason ?? 'unavailable'}`)
        .join('; ');
      throw makeError(
        X`no backend available for ${q(selector)}: ${reasons || 'no drivers registered'}`,
      );
    }

    // Resolve everything that requires the privileged
    // `provideHostPath` power up front. Drivers never see Mount caps.
    const rootfs = await resolveRootfs(opts.rootfs);
    const mountSpecs = opts.mounts ?? [];
    const resolvedMounts = await Promise.all(mountSpecs.map(resolveMount));
    let scratchHostPath = '';
    try {
      scratchHostPath = await acquireScratchHostPath();
    } catch (e) {
      // Scratch is optional in Phase 1 — some callers may want a
      // pure read-only slice. Re-throw only if we actually need it
      // (e.g. minimal rootfs with no mounts).  An `oci` rootfs supplies
      // its own writable layer (podman manages a per-container upper
      // overlay) so a missing scratch is not fatal there either.
      if (rootfs.kind === 'minimal' && resolvedMounts.length === 0) {
        throw e;
      }
      // Otherwise leave scratchHostPath empty; the driver skips the
      // scratch bind when the path is empty.
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
      scratchHostPath,
      network: opts.network ?? 'none',
      seccomp: opts.seccomp ?? 'default',
      env: harden({ ...(opts.env ?? {}) }),
      cwd: opts.cwd,
      limits,
    });

    const driverSlice = await driver.prepareSlice(sliceSpec);
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

    /** @type {Set<{ killAndReap: (reason: Error, initialSignal?: TerminationSignal) => Promise<void> }>} */
    const liveProcesses = new Set();
    // Cleanup errors for processes whose containment could not be proven.
    // Their leases have already settled, so dispose() must re-surface
    // these rather than report a clean teardown.
    /** @type {Error[]} */
    const containmentFailures = [];
    /** @type {Set<MountHandle>} */
    const liveMounts = new Set();
    /** @type {Promise<void> | undefined} */
    let disposePromise;
    /** @type {SandboxHandle | undefined} */
    let handle;

    // `disposeSlice` assigns `disposePromise` synchronously, so its
    // presence *is* the "no longer accepting work" flag; a separate
    // status variable could only ever restate it.
    const assertRunning = () => {
      disposePromise === undefined || Fail`sandbox handle has been disposed`;
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
      // never hold up timeout, disposal, or owner cancellation.
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
        void (async () => {
          await null;
          try {
            await proc.kill('SIGKILL');
          } catch {
            // The late process may already be gone.
          }
          await proc.wait().catch(() => undefined);
        })();
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
            );
            for (const control of controls) control.close();
          })();
        }
        return drainPromise;
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
            const waitPromise = driverProc.wait();
            let exited = false;
            const exitTracked = waitPromise.then(
              () => {
                exited = true;
              },
              () => {
                exited = true;
              },
            );
            const hardFirst = initialSignal === 'SIGKILL';
            /** @type {Error[]} */
            const signalFailures = [];
            let hardKillDelivered = false;
            try {
              await driverProc.kill(hardFirst ? 'SIGKILL' : initialSignal);
              if (hardFirst) hardKillDelivered = true;
            } catch (e) {
              // Drivers normalize the expected already-gone cases, so an
              // error reaching this layer is a live backend failure
              // (storage, permission, daemon) and must be preserved.
              signalFailures.push(/** @type {Error} */ (e));
            }
            if (!hardFirst && signalFailures.length === 0) {
              // The grace period exists for the process to act on the
              // soft signal; skip it when nothing was delivered.
              await raceDelay(exitTracked, KILL_GRACE_MS);
            }
            if (!exited && !hardKillDelivered) {
              try {
                await driverProc.kill('SIGKILL');
                hardKillDelivered = true;
              } catch (e) {
                signalFailures.push(/** @type {Error} */ (e));
              }
            }
            if (!exited && !hardKillDelivered) {
              // The backend accepted no signal, so its reap primitive may
              // never settle. Give the process one bounded chance to exit
              // on its own, force backend-level teardown, and surface a
              // cleanup error rather than waiting forever on containment
              // that cannot be proven.
              await raceDelay(exitTracked, KILL_GRACE_MS);
              if (!exited) {
                await raceDelay(
                  driver.teardown(driverSlice).then(
                    () => undefined,
                    e => {
                      signalFailures.push(/** @type {Error} */ (e));
                    },
                  ),
                  KILL_GRACE_MS,
                );
                // Let a teardown-induced exit land before judging.
                await raceDelay(exitTracked, DRAIN_GRACE_MS);
              }
              if (!exited) {
                await boundedDrain();
                const failure = makeError(
                  X`sandbox cleanup could not prove containment: ${q(signalFailures.map(e => e.message).join('; '))}`,
                );
                containmentFailures.push(failure);
                // The remedy above was slice-wide: `driver.teardown`
                // does not take a process, so proving containment for
                // this one cost the slice its backend state (network,
                // seccomp profile, container storage) and killed its
                // other processes. The slice therefore fails as a unit.
                // Disposing it is what stops `assertRunning` from
                // admitting further spawns and mounts against a slice
                // that is no longer there — a spawn admitted after this
                // point would run with whatever policy the torn-down
                // backend defaults to, which is exactly the
                // confinement the caller asked for and no longer has.
                // Disposal also carries this failure to the leases the
                // teardown collected, so the owners of sibling
                // processes learn why their process died rather than
                // watching it exit unexplained.
                const disposal = beginDispose(
                  makeError(
                    X`sandbox slice torn down after a containment failure: ${q(failure.message)}`,
                  ),
                );
                // Deliberately not awaited. Disposal awaits every lease
                // it snapshotted, this one included, so awaiting it
                // from inside this kill would wait on itself. What
                // matters is done synchronously: `beginDispose`
                // assigns `disposePromise` before returning, so
                // admission is already closed when this throw becomes
                // observable, and the sibling kills it started proceed
                // as soon as this kill settles.
                disposal.catch(() => undefined);
                signalContainmentFailure(failure);
                throw failure;
              }
            }
            // Reaping is mandatory. Driver probes fail closed unless their
            // wait primitive is tied to the contained process/container.
            await waitPromise.catch(() => undefined);
            await boundedDrain();
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
      // Lifecycle is bound to the slice; the daemon's scratch GC
      // sweeps the host directory when the cap is unpinned.
      const scratchCap = /** @type {MountCap} */ (
        await E(scratchProvider).provideScratchMount(
          `sandbox-scratch-${innerPath.replace(/[^a-zA-Z0-9-]/g, '-')}`,
        )
      );
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

    const resetSlice = async () => {
      const reason = makeError(X`sandbox handle reset`);
      await Promise.all(
        [...liveProcesses].map(lease => lease.killAndReap(reason)),
      );
    };

    /**
     * Begin — or observe — the one disposal of this slice.
     *
     * Assigning `disposePromise` closes admission, and snapshotting
     * the leases without awaiting makes exactly one spawn/dispose
     * race winner visible.
     *
     * `reason` is the terminal error handed to every process still
     * holding a lease, so a slice torn down because containment failed
     * tells the owners of its *other* processes that, instead of
     * reporting an ordinary disposal.
     *
     * @param {Error} reason
     * @returns {Promise<void>}
     */
    const beginDispose = reason => {
      if (disposePromise === undefined) {
        const leases = [...liveProcesses];
        disposePromise = (async () => {
          // A lease whose cleanup cannot prove containment must not stop
          // the others (or the driver teardown) from running. Swallowing
          // the rejection here loses nothing: `killAndReap` records every
          // such failure in `containmentFailures` before it throws.
          await Promise.all(
            leases.map(lease => lease.killAndReap(reason).catch(() => {})),
          );
          await Promise.all(
            [...liveMounts].map(m =>
              E(m)
                .unmount()
                .catch(() => {}),
            ),
          );
          try {
            await driver.teardown(driverSlice);
          } catch (e) {
            // A teardown that cannot prove containment is one more
            // containment failure, not a separate channel. Folding it in
            // lets the aggregate below report it alongside the
            // per-process failures; letting it propagate here would
            // pre-empt that summary and show the caller one of the two.
            containmentFailures.push(/** @type {Error} */ (e));
          } finally {
            if (handle !== undefined) liveHandles.delete(handle);
          }
          if (containmentFailures.length > 0) {
            throw makeError(
              X`sandbox dispose could not prove containment: ${q(containmentFailures.map(e => e.message).join('; '))}`,
            );
          }
        })();
      }
      return disposePromise;
    };

    const disposeSlice = () =>
      beginDispose(makeError(X`sandbox handle disposed`));

    const mintedHandle = /** @type {SandboxHandle} */ (
      /** @type {unknown} */ (
        makeExo('SandboxHandle', SandboxHandleInterface, {
          help: () => `${HANDLE_HELP_BASE}\n${sliceRuntimeReport}`,
          spawn: spawnProc,
          mount: mountInSlice,
          scratch: scratchInSlice,
          open: openInSlice,
          fork: forkSlice,
          reset: resetSlice,
          dispose: disposeSlice,
        })
      )
    );
    handle = mintedHandle;
    liveHandles.add(mintedHandle);
    // The owner may have been lost while this slice was being built, in
    // which case the cancellation sweep below has already run past this
    // handle: dispose it here rather than hand back a slice nobody is
    // watching.
    const lostDuringMake = ownerLost;
    if (lostDuringMake !== undefined) {
      await disposeSlice();
      throw ownerCancelledError(lostDuringMake);
    }
    return mintedHandle;
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
        ownerLost = makeError(
          X`sandbox factory owner is no longer reachable: ${q(/** @type {Error | undefined} */ (reason)?.message ?? reason)}`,
        );
        return Promise.all(
          [...liveHandles].map(handleRef =>
            E(handleRef)
              .dispose()
              .catch(() => undefined),
          ),
        );
      });
  }

  return /** @type {SandboxFactory} */ (
    /** @type {unknown} */ (
      makeExo('SandboxFactory', SandboxFactoryInterface, {
        help,
        listBackends,
        make,
      })
    )
  );
};
harden(makeSandboxFactory);
