// @ts-check

/* global clearTimeout, process, setTimeout */

import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';

import { makeLandlockProbe } from '../landlock.js';
import { makeResourceRegistry } from '../resource-registry.js';
import {
  PRIVATE_BLOCKED_RANGES,
  HOST_LOOPBACK_ALLOWED_RANGES,
  HOST_LAN_ALLOWED_RANGES,
} from '../net/blocked-ranges.js';
import {
  assemblePrlimitArgv,
  makeCgroup2Probe,
  resolveLimits,
} from '../limits.js';
import {
  killProcessGroup,
  readableToAsyncIterable,
  spawnAndCollect,
} from './child-process.js';
import {
  CANONICAL_BIN_PATHS,
  DEFAULT_PATH,
  detectMountBinPaths,
  elevateSurvivorToMountRoot,
  filterAmbientPathForHostBind,
  joinPathEntries,
  probeMountRootfsBinPaths,
} from './path.js';

/** @import { SandboxDriver, SliceSpec, SpawnOpts, DriverProcess, BackendProbe, BackendProbeDetails } from '../types.js' */

/**
 * `SandboxDriver` for `bubblewrap` (`bwrap`) on Linux.
 *
 * Translates a fully-resolved `SliceSpec` (host paths only, no Endo
 * capabilities) into a `bwrap` argv invocation. The per-slice context
 * returned by `prepareSlice` carries the assembled argv prefix,
 * process cleanup ownership, and resolved mount table.
 */

/**
 * Deadline applied to lifecycle-critical bwrap control commands. A
 * stalled probe must not be able to wedge backend selection, and
 * therefore `make()`, indefinitely.
 */
const CONTROL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Grace allowed, after the SIGKILL sweep in `teardown`, for each
 * straggler's stdio to reach `'close'`.
 *
 * A slice releases child ownership on `'close'`, not on `'exit'`.  That
 * asymmetry is deliberate — a descendant that escaped the process group
 * still holding an inherited pipe keeps the parent's stdio open, and the
 * driver wants to know about it — but it also means such a straggler
 * retains its owner, so an unbounded wait here would hang `teardown`,
 * and with it the factory's `dispose()`.
 *
 * The value mirrors `KILL_GRACE_MS` in `../factory.js`: that is the
 * grace the supervisor allows a signalled process, and it is also the
 * budget it races `driver.teardown()` against on its own cleanup path.
 * A longer bound would be invisible there — the supervisor gives up
 * first — while making `dispose()`, which does not race, hang longer.  A
 * shorter one would report an escape for a process group that is merely
 * slow to finish dying.
 */
const TEARDOWN_CLOSE_GRACE_MS = 1000;

/**
 * Wait for `child` to emit `'close'`, giving up after `ms`.
 *
 * Resolves `true` when the stdio closed within the bound and `false`
 * when it did not.  Both outcomes release the timer and the `'close'`
 * listener, so a child that outlives the bound leaves nothing of ours
 * attached to it.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
const raceChildClose = (child, ms) =>
  new Promise(resolve => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, ms);
    // Nothing should stay alive merely to keep watching a straggler.
    if (typeof timer.unref === 'function') timer.unref();
    child.once('close', onClose);
  });
harden(raceChildClose);

/**
 * Inner mount points the driver always installs for a usable rootfs.
 *
 * `--proc /proc` mounts a fresh procfs inside the pid namespace,
 * `--dev /dev` provides a minimal device tree, and `--tmpfs /tmp`
 * gives the slice a writable scratch volume that is wiped at
 * teardown by the kernel when the namespace is torn down.
 */
const ROOTFS_BASE_FLAGS = harden([
  ['--proc', '/proc'],
  ['--dev', '/dev'],
  ['--tmpfs', '/tmp'],
]);

/**
 * Host paths bind-mounted read-only when `rootfs.kind === 'host-bind'`.
 * Each entry is tried with `--ro-bind-try` so a missing host path is
 * skipped rather than failing the slice.
 *
 * The bin-dir entries here mirror `CANONICAL_BIN_PATHS` from
 * `./path.js`; the rootfs binds also include `/usr`, `/lib`,
 * `/lib32`, `/lib64`, and `/etc` so dynamic linkers, multilib
 * runtimes, and configuration files are reachable.  The bin dirs
 * by themselves are not enough: classically the binaries under
 * `/bin` and `/sbin` are dynamically linked against `/lib*`, and
 * tools under `/usr/bin` reach into `/usr/share` for data files.
 * Mounting the parent roots wholesale lets those references
 * resolve inside the slice without piecemeal probing.
 */
const HOST_BIND_ROOTFS_PATHS = harden([
  '/usr',
  '/lib',
  '/lib32',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc',
]);

/**
 * Parse `bwrap --version` output into a version string.
 *
 * @param {string} stdout
 * @returns {string | undefined}
 */
const parseBwrapVersion = stdout => {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  // Expected shape: "bubblewrap X.Y.Z" — but accept anything that
  // contains digits to stay tolerant of distro patches.
  const match = trimmed.match(/(\d+(?:\.\d+){0,3})/);
  return match ? match[1] : trimmed;
};
harden(parseBwrapVersion);

/**
 * Internal slice context the driver hands back from `prepareSlice` and
 * receives in `spawn` / `teardown`.
 *
 * @typedef {object} BwrapSliceContext
 * @property {string[]} sliceArgv      Bwrap argv prefix (everything
 *                                     before the `--` separator).
 * @property {string[]} prlimitArgv    `prlimit ...` prefix prepended
 *                                     to every spawn so resource caps
 *                                     are applied before bwrap execs
 *                                     the slice command.  Empty when
 *                                     no caps are configured.
 * @property {SliceSpec} spec          Original slice spec.
 * @property {ReturnType<typeof makeResourceRegistry>} operations Acquisitions and retained children.
 * @property {{ landlock: { available: boolean, reason?: string }, cgroup2: { available: boolean, controllers: string[], reason?: string }, prlimit: { applied: string[] } }} runtimeDetails
 *                                     Hardening-layer report the
 *                                     factory weaves into per-slice
 *                                     `help()` output.
 */

/**
 * Assemble the bwrap argv prefix from a `SliceSpec`.  Returns the
 * arguments that go BEFORE the `--` separator and the user's argv.
 *
 * The assembly order is:
 *   1. Namespace flags (`--unshare-all`, optional `--share-net`).
 *   2. Lifecycle (`--die-with-parent`).
 *   3. Capability drop (`--cap-drop ALL`).
 *   4. Seccomp fd (when a precompiled BPF blob is supplied).
 *   5. Rootfs binds.
 *   6. Caller-granted mount binds.
 *   7. Scratch mount as the writable upper layer.
 *   8. Inner `/proc`, `/dev`, `/tmp`.
 *   9. Environment variables.
 *  10. Initial `--chdir` (when `cwd` is set).
 *
 * @param {SliceSpec} spec
 * @param {{
 *   seccompFd: number | null,
 *   ambientPath?: string,
 *   exists?: (path: string) => boolean,
 *   realpath?: (path: string) => Promise<string | null>,
 * }} extras  `ambientPath` is the daemon-side `$PATH` mined for
 *            host-bind PATH synthesis; defaults to `process.env.PATH`.
 *            `exists` is the host-disk probe used by the synthesis
 *            helpers; defaults to `fs.existsSync`.  `realpath` is the
 *            symlink-resolving canonicaliser applied to ambient PATH
 *            survivors; defaults to identity (no resolution) so test
 *            harnesses without a filesystem can call this directly.
 * @returns {Promise<string[]>}
 */
export const assembleSliceArgv = async (spec, extras) => {
  // Hoisted `await null` so the `safe-await-separator` rule sees a
  // top-level await before the conditional `await
  // filterAmbientPathForHostBind(...)` further down.
  await null;
  /** @type {string[]} */
  const argv = [];

  // 1. Namespace flags.
  argv.push('--unshare-all');
  // bwrap 0.11+ already implies `--no-new-privileges` and exposes no
  // separate flag for it; do NOT pass `--no-new-privileges`.
  if (
    spec.network === 'host-loopback' ||
    spec.network === 'host-lan' ||
    spec.network === 'host-net'
  ) {
    // Phase 1.5 host-* profiles share the host's net namespace.  The
    // actual filtering for `host-loopback` / `host-lan` is the
    // operator's responsibility (see README § "Host network
    // profiles") because installing host-firewall rules requires
    // CAP_NET_ADMIN that the rootless slice does not hold.  The
    // driver still validates that the profile name is one of the
    // three documented values.
    argv.push('--share-net');
  }
  // For `none` (default) and `private` (pasta-managed netns) the
  // slice keeps its own private net namespace; bwrap's --unshare-all
  // is sufficient.

  // 2. Lifecycle.
  argv.push('--die-with-parent');
  argv.push('--new-session');

  // 3. Drop all capabilities.
  argv.push('--cap-drop', 'ALL');

  // 4. Seccomp.  Only attach when a precompiled BPF blob fd is
  //    available; the JSON profile in src/seccomp/default.json is
  //    documentation, not a kernel-loadable program.
  if (extras.seccompFd !== null) {
    argv.push('--seccomp', String(extras.seccompFd));
  }

  // 5. Rootfs.
  //
  // `defaultPathEntries` accumulates the slice-internal directories
  // we believe should be on `$PATH` if the caller did not supply one.
  // We compose the final string at the bottom of step 9 so the
  // entries observe the documented precedence:
  //
  //   1. Rootfs-derived defaults (host-bind canonical bin dirs, mount
  //      rootfs probed bin dirs, or `DEFAULT_PATH` for `minimal`).
  //   2. Daemon-side ambient `$PATH` survivors (host-bind only;
  //      `/opt`, `/snap/bin`, etc. that the operator added to the
  //      daemon's environment).
  //   3. Caller-granted mount bin-dirs (a hostile caller cannot
  //      shadow `/usr/bin` because their entries land last).
  /** @type {string[]} */
  const defaultPathEntries = [];
  // Track every host path requested via `--ro-bind-try` in the rootfs
  // section so we never emit a duplicate or a strictly redundant child
  // bind.  A new request is dropped when the path is identical to a
  // prior bind or lives underneath one (the parent already covers it).
  // The `--ro-bind-try` flavour tolerates missing paths, so the dedup
  // scope is just bookkeeping; we are not promising the directory
  // exists, only that we will not ask for it twice.
  /** @type {Set<string>} */
  const roBindTrySeen = new Set();
  /**
   * Append a `--ro-bind-try host host` pair unless an earlier entry
   * already covers `hostPath`.
   *
   * @param {string} hostPath
   */
  const tryAddRoBindTry = hostPath => {
    if (roBindTrySeen.has(hostPath)) return;
    for (const seen of roBindTrySeen) {
      if (hostPath.startsWith(`${seen}/`)) return;
    }
    roBindTrySeen.add(hostPath);
    argv.push('--ro-bind-try', hostPath, hostPath);
  };
  if (
    typeof spec.rootfs === 'object' &&
    spec.rootfs !== null &&
    'kind' in spec.rootfs
  ) {
    if (spec.rootfs.kind === 'host-bind') {
      for (const path of HOST_BIND_ROOTFS_PATHS) {
        // `--ro-bind-try` skips missing paths (e.g. /lib64 on pure
        // 32-bit hosts) instead of failing the slice.
        tryAddRoBindTry(path);
      }
      // Canonical bin dirs first — these are the same paths we just
      // bound above and they end up in `DEFAULT_PATH` order.
      for (const binPath of CANONICAL_BIN_PATHS) {
        defaultPathEntries.push(binPath);
      }
      // Then mine the daemon's `$PATH` for distro-shaped extras
      // (`/opt/...`, `/snap/bin`, `/var/lib/flatpak/exports/bin`, …).
      // The filter rejects user-private and world-writable entries,
      // canonicalises through `realpath` to defeat the
      // `/opt/eve → /tmp/attacker` symlink trick, and drops any
      // non-existent host paths; survivors are elevated to a package
      // root and bound read-only into the slice, then appended to the
      // path string in their daemon-PATH order.
      //
      // Elevation is needed because binding only the bin dir leaves
      // dangling symlinks: `/snap/bin/foo` is a symlink to
      // `/snap/foo/current/...`, `/opt/rocm/bin/foo` links against
      // `/opt/rocm/lib`, and `/var/lib/flatpak/exports/bin/foo` execs
      // into `/var/lib/flatpak/app/...`.  See
      // `elevateSurvivorToMountRoot` in `./path.js` for the heuristic.
      // The PATH entry stays at the original survivor path so commands
      // resolve at the directory the operator actually placed on
      // `$PATH`; only the *mount* widens to the package root.
      const ambientSurvivors = await filterAmbientPathForHostBind(
        extras.ambientPath,
        { exists: extras.exists, realpath: extras.realpath },
      );
      for (const survivor of ambientSurvivors) {
        const mountRoot = elevateSurvivorToMountRoot(survivor);
        tryAddRoBindTry(mountRoot);
        defaultPathEntries.push(survivor);
      }
    } else if (spec.rootfs.kind === 'minimal') {
      // Nothing — caller is expected to bind their own rootfs via
      // `mounts`.  We still get /proc, /dev, /tmp from the base
      // rootfs flags below.  Caller-mount bin-dirs (step 6 below)
      // and the `DEFAULT_PATH` fallback at the end of step 9 cover
      // the env-PATH side.
    } else if (spec.rootfs.kind === 'mount') {
      const mountSpec =
        /** @type {{ kind: 'mount'; hostPath: string; mode: 'ro' | 'rw' }} */ (
          spec.rootfs
        );
      const flag = mountSpec.mode === 'rw' ? '--bind' : '--ro-bind';
      argv.push(flag, mountSpec.hostPath, '/');
      // Probe the host directory for the canonical bin dirs.  The
      // mount is rooted at `/`, so `<hostPath>/usr/bin` becomes
      // `/usr/bin` inside the slice.  When the probe finds nothing —
      // either because `hostPath` is relative (the helper bails out)
      // or because the rootfs genuinely lacks any of the canonical
      // bin layouts — we synthesise an empty `$PATH` rather than
      // falling back to `DEFAULT_PATH`: those default paths point at
      // directories the slice has just demonstrated it does not
      // contain, so claiming they exist would produce confusing
      // `command not found` failures inside the slice.  Callers with
      // an unconventional rootfs are expected to set `spec.env.PATH`
      // explicitly.
      for (const innerPath of probeMountRootfsBinPaths(mountSpec.hostPath, {
        exists: extras.exists,
      })) {
        defaultPathEntries.push(innerPath);
      }
    } else if (spec.rootfs.kind === 'oci') {
      // OCI image refs are the podman driver's surface; bwrap has no
      // way to materialise an OCI image without an external store.
      // Surfaced as a structured error from `prepareSlice` below; the
      // argv assembly should never see this branch.
      throw makeError(
        X`bwrap driver does not support oci rootfs; use backend: 'podman' instead`,
      );
    }
  }

  // 6. Caller-granted mounts.
  for (const mount of spec.mounts) {
    const flag = mount.mode === 'rw' ? '--bind' : '--ro-bind';
    argv.push(flag, mount.hostPath, mount.innerPath);
    // Caller-mount bin-dirs land **after** rootfs-derived defaults so
    // a hostile mount cannot shadow `/usr/bin` with `bin/foo` of its
    // own.
    for (const innerPath of detectMountBinPaths(mount, {
      exists: extras.exists,
    })) {
      defaultPathEntries.push(innerPath);
    }
  }

  // 7. Writable scratch upper layer.  Mounted as `/scratch` so it is
  //    visible without conflicting with any rootfs bind.  A caller's
  //    workspace integration can point its own env var here.
  if (spec.scratchHostPath !== '') {
    argv.push('--bind', spec.scratchHostPath, '/scratch');
  }

  // 8. Base rootfs flags (proc / dev / tmp).
  for (const flagPair of ROOTFS_BASE_FLAGS) {
    argv.push(...flagPair);
  }

  // 9. Environment.
  argv.push('--clearenv');
  let hadPath = false;
  for (const [key, value] of Object.entries(spec.env)) {
    argv.push('--setenv', key, value);
    if (key === 'PATH') hadPath = true;
  }
  if (!hadPath) {
    // Caller did not set `PATH`.  Use the synthesised entries; if
    // synthesis turned up nothing the fallback depends on the rootfs
    // shape:
    //   - `host-bind` and `minimal` fall back to `DEFAULT_PATH` so the
    //     slice can find `sh`/`echo` against the host bin dirs that
    //     `host-bind` always binds (or that a `minimal` caller is
    //     expected to bind explicitly via `mounts`).
    //   - `mount`-rootfs slices fall back to the empty string: the
    //     probe just demonstrated that none of the canonical bin
    //     layouts exist inside the rootfs, so `DEFAULT_PATH` would
    //     point at directories the slice does not contain.  A caller
    //     who knows their rootfs uses an unusual layout is expected
    //     to set `spec.env.PATH` explicitly.
    const synthesised = joinPathEntries(defaultPathEntries);
    const isMountRootfs =
      typeof spec.rootfs === 'object' &&
      spec.rootfs !== null &&
      'kind' in spec.rootfs &&
      spec.rootfs.kind === 'mount';
    let pathValue;
    if (synthesised !== '') {
      pathValue = synthesised;
    } else if (isMountRootfs) {
      pathValue = '';
    } else {
      pathValue = DEFAULT_PATH;
    }
    argv.push('--setenv', 'PATH', pathValue);
  }

  // 10. Cwd inside the slice.
  if (spec.cwd !== undefined && spec.cwd !== '') {
    argv.push('--chdir', spec.cwd);
  }

  return argv;
};
harden(assembleSliceArgv);

/**
 * Construct the bwrap driver.
 *
 * @param {object} [input]
 * @param {Record<string, string>} [input.env]                Daemon env
 *                                                            (PATH etc.).
 *                                                            The `PATH`
 *                                                            field, when
 *                                                            present, is
 *                                                            mined for
 *                                                            host-bind
 *                                                            slices so a
 *                                                            slice can
 *                                                            see operator-
 *                                                            installed
 *                                                            bin dirs
 *                                                            like `/opt`
 *                                                            and `/snap/bin`.
 *                                                            Defaults to
 *                                                            an empty
 *                                                            object — a
 *                                                            test that
 *                                                            wants
 *                                                            deterministic
 *                                                            argv shape
 *                                                            should pass
 *                                                            `env: {}`
 *                                                            explicitly
 *                                                            so the driver
 *                                                            does not
 *                                                            inherit the
 *                                                            ambient
 *                                                            `process.env.PATH`.
 * @param {typeof import('child_process')} [input.childProcess] Child-
 *                                                            process module
 *                                                            override
 *                                                            (tests).
 * @param {typeof import('fs')} [input.fs]                    fs module
 *                                                            override.  Used
 *                                                            for the
 *                                                            `existsSync`
 *                                                            probe and the
 *                                                            `promises.realpath`
 *                                                            canonicaliser
 *                                                            that back the
 *                                                            ambient-PATH
 *                                                            and mount-bin
 *                                                            synthesis;
 *                                                            tests can
 *                                                            inject a
 *                                                            stub.
 * @returns {SandboxDriver}
 */
export const makeBwrapDriver = ({
  env = {},
  childProcess: childProcessModule,
  fs: fsModule,
} = {}) => {
  // Lazy-resolve `child_process` so callers in test environments can
  // inject a stub without paying the import cost up front.
  /** @type {typeof import('child_process') | undefined} */
  let cpModule = childProcessModule;
  let nextOperation = 0n;
  const getCp = async () => {
    await null;
    if (cpModule === undefined) {
      cpModule = await import('child_process');
    }
    return cpModule;
  };

  // Phase 1.5 surfaces these kernel-feature probes via
  // `BackendProbe.details` so callers can tell which hardening layers
  // are actually in effect on this host.  The probes are stateless and
  // best-effort; failures degrade gracefully to `available: false` with
  // a human-readable reason.
  const landlockProbe = makeLandlockProbe();
  const cgroup2Probe = makeCgroup2Probe();

  /** @returns {Promise<Omit<BackendProbe, 'name'>>} */
  const probe = async () => {
    await null;
    let cp;
    try {
      cp = await getCp();
    } catch (e) {
      const cause = /** @type {Error} */ (e);
      return harden({
        available: false,
        reason: `child_process unavailable: ${cause.message}`,
      });
    }

    let result;
    try {
      result = await spawnAndCollect(cp, 'bwrap', ['--version'], {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      });
    } catch (e) {
      const cause = /** @type {Error & { code?: string }} */ (e);
      const reason =
        cause.code === 'ENOENT'
          ? 'bwrap binary not found on PATH'
          : `failed to spawn bwrap: ${cause.message}`;
      return harden({ available: false, reason });
    }

    if (result.code !== 0) {
      return harden({
        available: false,
        reason: `bwrap --version exited with code ${q(result.code)}: ${result.stderr.trim() || result.stdout.trim()}`,
      });
    }

    const version = parseBwrapVersion(result.stdout);
    if (version === undefined) {
      return harden({
        available: false,
        reason: `could not parse bwrap --version output: ${q(result.stdout)}`,
      });
    }

    let helpResult;
    try {
      helpResult = await spawnAndCollect(cp, 'bwrap', ['--help'], {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      });
    } catch (e) {
      return harden({
        available: false,
        version,
        reason: `failed to probe bwrap lifecycle flags: ${/** @type {Error} */ (e).message}`,
      });
    }
    // bwrap writes its usage to either stream depending on version, so
    // test both rather than materialising a concatenated copy.
    const advertises = (/** @type {string} */ flag) =>
      helpResult.stdout.includes(flag) || helpResult.stderr.includes(flag);
    if (
      helpResult.code !== 0 ||
      !advertises('--die-with-parent') ||
      !advertises('--new-session')
    ) {
      return harden({
        available: false,
        version,
        reason:
          'bwrap does not advertise required --die-with-parent and --new-session lifecycle support',
        details: harden({
          lifecycle: harden({
            available: false,
            reason: 'required bwrap lifecycle flags unavailable',
          }),
        }),
      });
    }

    // Run Phase 1.5 kernel-feature probes in parallel.  These never
    // throw — `LandlockProbe.probe()` / `Cgroup2Probe.probe()` always
    // resolve, with `available: false` on any error path.
    const [landlock, cgroup2] = await Promise.all([
      landlockProbe.probe(),
      cgroup2Probe.probe(),
    ]);
    /** @type {BackendProbeDetails} */
    const details = harden({
      lifecycle: harden({
        available: true,
      }),
      landlock: harden({
        available: landlock.available,
        ...(landlock.reason !== undefined ? { reason: landlock.reason } : {}),
      }),
      cgroup2: harden({
        available: cgroup2.available,
        controllers: cgroup2.controllers,
        ...(cgroup2.reason !== undefined ? { reason: cgroup2.reason } : {}),
      }),
    });
    return harden({ available: true, version, details });
  };

  /**
   * @param {SliceSpec} spec
   * @returns {Promise<BwrapSliceContext>}
   */
  const prepareSlice = async spec => {
    // Validate network profile up front.  Phase 1.5 lifts the
    // `notImplemented` stubs for the `host-*` family.  Each is mapped
    // to bwrap's `--share-net` in `assembleSliceArgv()`; in-slice
    // filtering for `host-loopback` / `host-lan` is the operator's
    // responsibility (see README § "Host network profiles") because
    // the rootless slice does not hold CAP_NET_ADMIN.
    if (spec.policy !== undefined || spec.network === 'broker-only') {
      // The bwrap driver has no container-runtime inspect surface to
      // read effective state back from, so it can apply a policy's
      // flags but never prove them. Attesting from the flags it passed
      // is the failure mode the whole attestation exists to exclude, so
      // it declines instead.
      throw makeError(
        X`bwrap driver cannot enforce or attest a slice policy; use the podman backend`,
      );
    }
    if (
      spec.network !== 'none' &&
      spec.network !== 'private' &&
      spec.network !== 'host-loopback' &&
      spec.network !== 'host-lan' &&
      spec.network !== 'host-net'
    ) {
      throw makeError(X`unknown network profile ${q(spec.network)}`);
    }

    if (
      typeof spec.rootfs === 'object' &&
      spec.rootfs !== null &&
      'kind' in spec.rootfs &&
      spec.rootfs.kind === 'oci'
    ) {
      throw makeError(
        X`bwrap driver does not support oci rootfs; use backend: 'podman' instead`,
      );
    }

    // Phase 1 does not compile JSON seccomp profiles to BPF.  If the
    // caller supplied a precompiled blob via SeccompPolicy.profile we
    // would write it to a temp file and pass the fd; for now leave
    // it pluggable but unused.  The argv assembly already gates on
    // `seccompFd !== null`.
    /** @type {number | null} */
    const seccompFd = null;

    // Lazy-resolve `fs` for the existsSync probe and the
    // promise-returning `realpath` resolver used by the PATH
    // synthesis helpers.  We require fs only when the slice has
    // either a `host-bind` rootfs (ambient `$PATH` mining +
    // realpath) or a `mount` rootfs / caller-granted mounts
    // (canonical bin-dir probing).  When `fs` cannot be loaded, fall
    // back to a "always exists" probe and an identity realpath —
    // `--ro-bind-try` already tolerates missing host paths, so the
    // worst case is a `$PATH` entry that points at a directory the
    // slice cannot reach.
    await null;
    /** @type {(p: string) => boolean} */
    let exists = () => true;
    /** @type {(p: string) => Promise<string | null>} */
    let realpath = async p => p;
    try {
      const fs = fsModule ?? (await import('fs'));
      exists = p => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      };
      realpath = async p => {
        // Hoisted `await null` to satisfy `safe-await-separator`.
        await null;
        try {
          return await fs.promises.realpath(p);
        } catch {
          // ENOENT / EACCES / EIO / ELOOP — the filter treats this as
          // a drop signal rather than a hard failure so a single
          // unreadable PATH entry does not poison the whole slice.
          return null;
        }
      };
    } catch {
      // best-effort
    }

    const sliceArgv = await assembleSliceArgv(spec, {
      seccompFd,
      ambientPath: env.PATH,
      exists,
      realpath,
    });

    // Phase 1.5 resource caps.  The factory passes a fully-resolved
    // limits dictionary in `spec.limits`; the driver maps it onto a
    // `prlimit` argv prefix that wraps every spawn.  Limits set on
    // the bwrap process survive `execve` and propagate to the slice's
    // child PIDs via the kernel's standard inheritance rules
    // (RLIMIT_NPROC counts processes per host UID after the userns
    // mapping; RLIMIT_AS / RLIMIT_NOFILE / RLIMIT_CORE / RLIMIT_FSIZE
    // are per-process and inherited at exec time).
    const limits = resolveLimits(spec.limits);
    const prlimitArgv = assemblePrlimitArgv(limits);

    // Run kernel-feature probes once per slice so the runtime report
    // reflects the host the slice actually runs on (the daemon's
    // `probe()` cache could be stale across host reconfigurations).
    const [landlock, cgroup2] = await Promise.all([
      landlockProbe.probe(),
      cgroup2Probe.probe(),
    ]);
    const runtimeDetails = harden({
      landlock: harden({
        available: landlock.available,
        ...(landlock.reason !== undefined ? { reason: landlock.reason } : {}),
      }),
      cgroup2: harden({
        available: cgroup2.available,
        controllers: cgroup2.controllers,
        ...(cgroup2.reason !== undefined ? { reason: cgroup2.reason } : {}),
      }),
      prlimit: harden({ applied: harden([...prlimitArgv]) }),
    });

    /** @type {BwrapSliceContext} */
    const ctx = {
      sliceArgv,
      prlimitArgv,
      spec,
      operations: makeResourceRegistry(),
      runtimeDetails,
    };

    return ctx;
  };

  /**
   * @param {BwrapSliceContext} slice
   * @param {string[]} argv
   * @param {SpawnOpts} opts
   * @param {import('../types.js').DriverSpawnControls} [controls]
   * @returns {Promise<DriverProcess>}
   */
  const spawn = (slice, argv, opts, controls) => {
    const operationId = String(nextOperation);
    nextOperation += 1n;
    return slice.operations.inOrder(operationId, () =>
      acquireOperation(slice, operationId, argv, opts, controls),
    );
  };

  /**
   * @param {BwrapSliceContext} slice
   * @param {string} operationId
   * @param {string[]} argv
   * @param {SpawnOpts} opts
   * @param {import('../types.js').DriverSpawnControls} [controls]
   * @returns {Promise<DriverProcess>}
   */
  const acquireOperation = async (slice, operationId, argv, opts, controls) => {
    if (argv.length === 0) {
      throw makeError(X`spawn argv must be non-empty`);
    }
    const cp = await getCp();

    /** @type {string[]} */
    const fullArgv = [...slice.sliceArgv];

    // Per-spawn cwd override.  Layer on top of the slice's cwd.
    if (opts.cwd !== undefined) {
      fullArgv.push('--chdir', opts.cwd);
    }

    // Per-spawn env overrides.
    if (opts.env !== undefined) {
      for (const [key, value] of Object.entries(opts.env)) {
        fullArgv.push('--setenv', key, value);
      }
    }

    fullArgv.push('--', ...argv);

    // Phase 1.5: when the factory supplied resource caps, prepend
    // `prlimit --foo=N -- bwrap …` so the rlimits are set on the
    // bwrap process and inherited into the slice via execve.  The
    // empty-prefix case (`prlimitArgv.length === 0`) preserves the
    // Phase 1 behaviour of execing bwrap directly.
    /** @type {string} */
    let execProgram;
    /** @type {string[]} */
    let execArgv;
    if (slice.prlimitArgv.length === 0) {
      execProgram = 'bwrap';
      execArgv = fullArgv;
    } else {
      execProgram = slice.prlimitArgv[0];
      execArgv = [...slice.prlimitArgv.slice(1), 'bwrap', ...fullArgv];
    }

    /** @type {import('child_process').ChildProcess} */
    let child;
    slice.operations.assertOpen();
    if (controls?.isCancelled?.()) {
      throw makeError(X`bwrap operation admission aborted`);
    }
    try {
      child = cp.spawn(execProgram, execArgv, {
        stdio: [
          'pipe',
          opts.captureStdout === false ? 'ignore' : 'pipe',
          opts.captureStderr === false ? 'ignore' : 'pipe',
        ],
        // A distinct host process group lets every termination path signal
        // bwrap, its launcher, and all descendants with one negative pid.
        // `--die-with-parent` independently covers an ungraceful daemon exit.
        detached: true,
        // Inherit minimal env: bwrap itself needs PATH to find
        // libraries; the slice's clearenv inside takes effect after
        // the bwrap binary execs.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
    } catch (e) {
      throw makeError(
        X`failed to spawn ${q(execProgram)}: ${q(/** @type {Error} */ (e).message)}`,
      );
    }

    let closed = false;
    const stop = async () => {
      await null;
      if (closed) return;
      // Arm before signalling. A retry may signal a still-live child, but
      // killProcessGroup declines a group whose leader Node already reaped.
      const closing = raceChildClose(child, TEARDOWN_CLOSE_GRACE_MS);
      try {
        killProcessGroup(child, 'SIGKILL');
      } catch {
        // A signal refusal is not a close proof; still wait for close.
      }
      if (!(await closing)) {
        throw makeError(
          X`bwrap teardown could not prove containment: child still held stdio open ${q(TEARDOWN_CLOSE_GRACE_MS)}ms after SIGKILL`,
        );
      }
    };
    slice.operations.retain(operationId, stop);
    child.once('close', () => {
      closed = true;
      slice.operations.release(operationId, stop);
    });

    const {
      promise: exited,
      resolve: resolveExit,
      reject: rejectExit,
    } = /** @type {import('@endo/promise-kit').PromiseKit<{ code: number | null, signal: string | null }>} */ (
      makePromiseKit()
    );
    child.once('error', err => {
      rejectExit(err);
    });
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    exited.catch(() => undefined);

    // The DriverProcess surface exposes async-iterables for stdout
    // and stderr, plus closures that the factory wires into a
    // writer-ref adapter for stdin.  We do NOT expose the raw Node
    // streams as object properties because `harden()` would attempt
    // to deep-freeze their internal state.
    const stdinStream = child.stdin;
    /** @type {DriverProcess & { writeStdin(chunk: Uint8Array): Promise<void>, closeStdin(): Promise<void> }} */
    const driverProcExtended = harden({
      pid: child.pid ?? -1,
      stdin: null,
      stdout: readableToAsyncIterable(child.stdout),
      stderr: readableToAsyncIterable(child.stderr),
      wait: () => exited,
      kill: async signal => {
        killProcessGroup(child, signal ?? 'SIGTERM');
      },
      /** @param {Uint8Array} chunk */
      writeStdin: async chunk => {
        if (stdinStream === null || stdinStream === undefined) return;
        await new Promise((resolve, reject) => {
          stdinStream.write(chunk, err =>
            err ? reject(err) : resolve(undefined),
          );
        });
      },
      closeStdin: async () => {
        if (stdinStream === null || stdinStream === undefined) return;
        await new Promise(resolve => stdinStream.end(() => resolve(undefined)));
      },
    });
    return /** @type {DriverProcess} */ (driverProcExtended);
  };

  /**
   * Fence admission, drain acquisitions, and attempt every retained child.
   * A bounded close failure retains its owner for the next teardown attempt.
   *
   * @param {BwrapSliceContext} slice
   * @returns {Promise<void>}
   */
  const teardown = slice => slice.operations.shutdown();

  return harden({
    name: /** @type {const} */ ('bwrap'),
    probe,
    prepareSlice,
    spawn,
    teardown,
  });
};
harden(makeBwrapDriver);

export {
  PRIVATE_BLOCKED_RANGES,
  HOST_LOOPBACK_ALLOWED_RANGES,
  HOST_LAN_ALLOWED_RANGES,
};
