// @ts-check

/* global Buffer, process */

import { makeError, q, X } from '@endo/errors';

import { makeCgroup2Probe } from '../limits.js';
import { readableToAsyncIterable, spawnAndCollect } from './child-process.js';
import { DEFAULT_PATH } from './path.js';

/** @import { SandboxDriver, SliceSpec, SpawnOpts, DriverProcess, BackendProbe, BackendProbeDetails } from '../types.js' */

/**
 * `SandboxDriver` for rootless `podman` on Linux.
 *
 * Translates a fully-resolved `SliceSpec` (host paths only, no Endo
 * capabilities) into one operation container per spawn. The driver is
 * stateless except for the per-slice context returned from `prepareSlice`,
 * which carries immutable construction policy, live operation containers,
 * and the runtime-feature report woven into `slice.help()`.
 *
 * Lifecycle:
 *   1. `prepareSlice` verifies the OCI image, network backend, runtime, and
 *      immutable policy without starting a container.
 *   2. `spawn` creates an exactly labelled operation container whose PID 1
 *      is the requested argv, then attaches its three standard streams.
 *   3. wait, kill, and teardown remove each operation container before
 *      settling.
 *
 * Crash reconciliation is scoped by the exact `PODMAN_OWNER_LABEL=ownerId`
 * filter. A stable, host-private owner id is mandatory; a missing id or a
 * failed reconciliation makes the driver unavailable.
 */

/**
 * Container-name prefix for operations minted by this driver. Names are for
 * diagnostics only; cleanup authority comes exclusively from exact labels.
 */
export const ENDO_SANDBOX_PREFIX = 'endo-sandbox-';
harden(ENDO_SANDBOX_PREFIX);

export const PODMAN_OWNER_LABEL = 'io.endo.sandbox.owner';
harden(PODMAN_OWNER_LABEL);

export const PODMAN_OPERATION_LABEL = 'io.endo.sandbox.operation';
harden(PODMAN_OPERATION_LABEL);

/**
 * Deadline applied to lifecycle-critical podman control commands
 * (`create`, `kill`, `rm`) and to every command on the probe path
 * (`--version`, `info`, the orphan sweep's `ps`). A stalled control
 * command must not be able to wedge admission, termination, or
 * reaping, and a stalled probe must not be able to wedge backend
 * selection — and therefore `make()` — indefinitely, which is why the
 * bwrap driver bounds its probes with the same 30s budget. Commands
 * with legitimately unbounded duration (`pull`) are not subject to it.
 */
const CONTROL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Parse `podman --version` output into a version string.
 *
 * @param {string} stdout
 * @returns {string | undefined}
 */
const parsePodmanVersion = stdout => {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  // Expected shape: "podman version X.Y.Z" — accept anything that
  // contains a digit run so distro patches do not break the parser.
  const match = trimmed.match(/(\d+(?:\.\d+){0,3})/);
  return match ? match[1] : trimmed;
};
harden(parsePodmanVersion);

/**
 * Recognise podman's "the container is already gone" family of errors.
 *
 * Removal and signalling are both idempotent goals rather than
 * commands: a container that no longer exists is the desired state, not
 * a failure. Every other non-zero exit is a live backend failure
 * (storage, permission, daemon) that the supervisor must see.
 *
 * Exported for unit testing.
 *
 * @param {{ stdout: string, stderr: string }} result
 * @returns {boolean}
 */
export const reportsContainerGone = ({ stdout, stderr }) =>
  /no such (container|object)|does not exist/i.test(`${stderr}\n${stdout}`);
harden(reportsContainerGone);

/**
 * Recognise podman's "the container is not in a killable state" family
 * of errors, which is the signalling counterpart of
 * `reportsContainerGone`.
 *
 * podman refuses to signal a container that has already stopped:
 *
 *   Error: can only kill running containers. <id> is in state exited:
 *   container state improper
 *
 * That is reachable on the ordinary graceful path. `podman rm -f` gates
 * the operation's `wait()`, so a process that handled SIGTERM promptly
 * but whose removal is still in flight looks un-exited to the
 * supervisor's kill ladder, which then escalates onto a container that
 * is already gone in every sense that matters. Treating the refusal as
 * a backend failure would make the supervisor declare that it could not
 * prove containment of a process that exited on its own.
 *
 * The match is deliberately anchored on podman's kill-path prefix and
 * on the non-running container states it names, not on the generic
 * `container state improper` sentinel: that sentinel also covers the
 * opposite verdict (`cannot remove container ... as it is running`),
 * which must stay a live failure. Storage, permission, and daemon
 * failures name none of these.
 *
 * Exported for unit testing.
 *
 * @param {{ stdout: string, stderr: string }} result
 * @returns {boolean}
 */
export const reportsContainerNotRunning = ({ stdout, stderr }) => {
  const text = `${stderr}\n${stdout}`;
  return (
    /can only kill running containers/i.test(text) ||
    /is in state (configured|created|exited|stopped|removing)\b/i.test(text)
  );
};
harden(reportsContainerNotRunning);

/**
 * Generate a fresh operation-container name. The single-owner invariant and
 * process-local counter make the value unique within a daemon incarnation;
 * the pid and time keep diagnostics distinct across clean restarts. Crash
 * reconciliation removes the exact owner's prior incarnation before spawn.
 *
 * @returns {string}
 */
let nextOperationNumber = 0n;
const makeOperationName = () => {
  nextOperationNumber += 1n;
  return `${ENDO_SANDBOX_PREFIX}${process.pid.toString(16)}-${Date.now().toString(16)}-${nextOperationNumber.toString(16)}`;
};
harden(makeOperationName);

/**
 * Rootless network backend the driver prefers when mapping the
 * `private` profile to a `--network` value.  `slirp4netns` is the
 * historical podman default but recent rootless installs ship `pasta`
 * (passt) instead, and on those hosts `slirp4netns` is absent.  The
 * Phase 2 TODO explicitly anticipates the `pasta` fallback, so the
 * driver autodetects which backend is available and chooses
 * accordingly.  When both are present, slirp4netns wins for
 * compatibility with the documented egress nftables ruleset; when
 * only pasta is present, the driver picks pasta and surfaces the
 * choice via `slice.help()`.
 *
 * @typedef {'slirp4netns' | 'pasta' | null} RootlessNetBackend
 */

/**
 * Map a `SeccompPolicy` onto a `--security-opt seccomp=` argument.
 * Returns `undefined` for `'default'` because podman ships the same
 * containers/common allow-list the package documents in
 * `src/seccomp/default.json`; supplying our copy explicitly would only
 * drift over time.  `'unconfined'` becomes `seccomp=unconfined`; a
 * caller-supplied `{ profile }` is materialised at `prepareSlice` time
 * (the path is then folded into `assembleCreateArgv` via
 * `extras.seccompProfilePath`).
 *
 * A caller-supplied `{ profile }` with no materialised path fails
 * closed. Returning `undefined` there would silently downgrade the
 * container to podman's default allow-list — a weaker policy than the
 * caller asked for, applied without any signal. The predicate here is
 * the same one `prepareSlice` uses to decide whether to materialise a
 * profile, so the two cannot drift apart.
 *
 * Exported for unit testing.
 *
 * @param {SliceSpec['seccomp']} policy
 * @param {string | null} seccompProfilePath
 * @returns {string | undefined}
 * @throws {Error} when `policy` names a caller-supplied profile that
 *   was never materialised to a path.
 */
export const seccompSecurityOpt = (policy, seccompProfilePath) => {
  if (policy === 'unconfined') return 'seccomp=unconfined';
  if (typeof policy === 'object' && policy !== null && 'profile' in policy) {
    if (seccompProfilePath === null) {
      throw makeError(
        X`podman driver: caller-supplied seccomp profile was requested but no materialised profile path is available`,
      );
    }
    return `seccomp=${seccompProfilePath}`;
  }
  return undefined;
};
harden(seccompSecurityOpt);

/**
 * Translate a `NetworkProfile` into the `--network` arg podman
 * accepts.  The `private` profile honours `backend` so the driver
 * can fall back to pasta on hosts that ship pasta but not
 * slirp4netns.  Unknown profiles raise a structured error (the
 * caller already validated upstream, but we re-validate as a defence
 * in depth).
 *
 * @param {SliceSpec['network']} profile
 * @param {RootlessNetBackend} backend
 * @returns {string}
 */
const networkArgForProfile = (profile, backend) => {
  switch (profile) {
    case 'none':
      return 'none';
    case 'private':
      // Both pasta and slirp4netns give the slice a private netns
      // with NAT'd outbound; in-netns nftables egress filtering is
      // the operator's responsibility under rootless podman, exactly
      // as the README documents for the bwrap driver's `private`
      // profile.
      if (backend === 'pasta') return 'pasta';
      // Default and `slirp4netns` both pick slirp4netns; the
      // explicit `port_handler=slirp4netns` keeps inbound port
      // forwarding behaviour stable across podman versions.
      return 'slirp4netns:port_handler=slirp4netns';
    case 'host-loopback':
    case 'host-lan':
    case 'host-net':
      // Per-profile filtering for host-loopback / host-lan needs
      // CAP_NET_ADMIN; the rootless slice cannot install host
      // firewall rules from inside.  Operators install the rules
      // from `HOST_LOOPBACK_ALLOWED_RANGES` / `HOST_LAN_ALLOWED_RANGES`
      // (see README).
      return 'host';
    default:
      throw makeError(X`unknown network profile ${q(profile)}`);
  }
};
harden(networkArgForProfile);

/**
 * Resolve the OCI image reference the slice should use as its rootfs.
 * Returns `undefined` for non-OCI rootfs specs; the caller will fall
 * back to a minimal image.  Phase 2 only supports `oci` rootfs on the
 * podman driver — `host-bind` / `mount` / `minimal` are bwrap-shaped.
 *
 * @param {SliceSpec['rootfs']} rootfs
 * @returns {string | undefined}
 */
const ociRefFromRootfs = rootfs => {
  if (
    typeof rootfs === 'object' &&
    rootfs !== null &&
    'kind' in rootfs &&
    rootfs.kind === 'oci'
  ) {
    const ociSpec = /** @type {{ kind: 'oci'; ref: string }} */ (rootfs);
    return ociSpec.ref;
  }
  return undefined;
};
harden(ociRefFromRootfs);

/**
 * Probe which rootless network backend is reachable from the daemon's
 * PATH.  Used at slice construction to pick the `private` profile's
 * `--network` value.  Returns the first available backend in
 * preference order (slirp4netns → pasta) or `null` if neither is
 * present, in which case the driver still constructs `none` and
 * `host-*` slices but rejects `private` with a structured error.
 *
 * @param {typeof import('child_process')} cp
 * @returns {Promise<RootlessNetBackend>}
 */
const probeRootlessNetBackend = async cp => {
  await null;
  for (const candidate of /** @type {const} */ (['slirp4netns', 'pasta'])) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await spawnAndCollect(cp, candidate, ['--version'], {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      });
    } catch (e) {
      const cause = /** @type {Error & { code?: string }} */ (e);
      // eslint-disable-next-line no-continue
      if (cause.code === 'ENOENT') continue;
      // Other spawn errors (EACCES on a stripped binary, etc.) — skip
      // and try the next candidate; the empty PATH case is already
      // handled by the ENOENT branch.

      // eslint-disable-next-line no-continue
      continue;
    }
    if (result.code === 0) return candidate;
  }
  return null;
};
harden(probeRootlessNetBackend);

/**
 * Internal slice context the driver hands back from `prepareSlice` and
 * receives in `spawn` / `teardown`.
 *
 * @typedef {object} PodmanSliceContext
 * @property {SliceSpec} spec          Original slice spec.
 * @property {string} ref              Pinned OCI image reference.
 * @property {RootlessNetBackend} netBackend Rootless network backend.
 * @property {string} runtime          Resolved OCI runtime override
 *                                     (`crun`, `runc`, …) or empty
 *                                     string when podman's default is
 *                                     in use.  Pinned at slice
 *                                     creation so subsequent spawns
 *                                     stay on the same runtime even if
 *                                     the host's default flips.
 * @property {Map<string, { child: import('child_process').ChildProcess, wait: Promise<{ code: number | null, signal: string | null }> }>} live
 *                                     Live operation containers keyed by
 *                                     container name, with the attached
 *                                     podman client for each.
 * @property {string | null} seccompTempPath  Temp file path holding the
 *                                     caller-supplied seccomp profile,
 *                                     or `null` when no profile was
 *                                     materialised.  Unlinked at
 *                                     teardown.
 * @property {{ cgroup2: { available: boolean, controllers: string[], reason?: string }, rootless: { available: boolean, reason?: string }, rootlessNet: { backend: RootlessNetBackend, reason?: string }, path: { value: string, source: 'env' | 'image' | 'fallback' } }} runtimeDetails
 *                                     Hardening-layer report the
 *                                     factory weaves into per-slice
 *                                     `help()` output.  `path`
 *                                     records which `PATH` the slice
 *                                     ended up with and where it came
 *                                     from (caller env, OCI image,
 *                                     or canonical fallback).
 */

/**
 * Resolve which `PATH` value the slice will actually use, and where it
 * came from.  Mirrors the bwrap driver's "caller wins, then the rootfs
 * defaults, then the canonical fallback" precedence so the two backends
 * present a consistent surface.
 *
 * Precedence:
 *   1. Caller-supplied `spec.env.PATH` — `'env'`.  An explicit empty
 *      string is honoured (the caller is opting out of any PATH).
 *   2. Image's `Config.Env` `PATH` — `'image'`.
 *   3. `DEFAULT_PATH` from `./path.js` — `'fallback'`.
 *
 * The `source` is surfaced in `slice.help()` so operators can tell
 * which case fired without inspecting the container's env directly.
 *
 * @param {SliceSpec} spec
 * @param {string | null} imagePath
 * @returns {{ value: string, source: 'env' | 'image' | 'fallback' }}
 */
const resolveSlicePath = (spec, imagePath) => {
  if (typeof spec.env.PATH === 'string') {
    return harden({ value: spec.env.PATH, source: 'env' });
  }
  if (typeof imagePath === 'string' && imagePath !== '') {
    return harden({ value: imagePath, source: 'image' });
  }
  return harden({ value: DEFAULT_PATH, source: 'fallback' });
};
harden(resolveSlicePath);

/**
 * Parse the JSON array emitted by
 * `podman image inspect --format '{{json .Config.Env}}'` and return the
 * value of the `PATH=` entry, if any.  Tolerant of malformed input:
 * non-array JSON, non-string entries, missing PATH all return `null`.
 *
 * Exported for unit testing — the integration path is exercised via
 * the live podman driver, but isolated parser tests want to drive
 * pathological shapes without rebuilding an OCI image.
 *
 * @param {string} configEnvJson
 * @returns {string | null}
 */
export const parseImagePathFromConfigEnv = configEnvJson => {
  let parsed;
  try {
    parsed = JSON.parse(configEnvJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry.startsWith('PATH=')) {
      return entry.slice('PATH='.length);
    }
  }
  return null;
};
harden(parseImagePathFromConfigEnv);

/**
 * Assemble the `podman create` argv for a slice.  The image reference
 * and the trailing pid-1 command are appended last so the caller can
 * pass them in explicitly.
 *
 * @param {SliceSpec} spec
 * @param {string} containerName
 * @param {RootlessNetBackend} netBackend
 * @param {{ seccompProfilePath: string | null, pathInjection: string | null, ownerId: string, operationId: string }} extras
 *   `pathInjection` is the `PATH` value to inject as `-e PATH=…` when
 *   the caller did not set one.  `null` means "leave the image's
 *   `Config.Env` PATH alone" — used when the caller's `spec.env`
 *   already includes a `PATH` (the per-key loop below emits the `-e`
 *   itself), or when the helper is invoked from a code path that
 *   does not need the synthesis.
 * @returns {string[]}
 */
const assembleCreateArgv = (spec, containerName, netBackend, extras) => {
  /** @type {string[]} */
  const argv = [
    'create',
    '--name',
    containerName,
    '--replace=false',
    '--label',
    `${PODMAN_OWNER_LABEL}=${extras.ownerId}`,
    '--label',
    `${PODMAN_OPERATION_LABEL}=${extras.operationId}`,
    // Hardening flags equivalent to bwrap's `--unshare-all` +
    // `--cap-drop ALL` posture.
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    // The slice's upper rootfs layer is read-only; writes go to the
    // scratch volume bound at /scratch (see below).  podman supplies a
    // tmpfs at /tmp /run /dev /var/tmp by default when --read-only is
    // set, which mirrors bwrap's `--tmpfs /tmp` etc.
    '--read-only',
    '--read-only-tmpfs=true',
    '--network',
    networkArgForProfile(spec.network, netBackend),
  ];

  // Optional seccomp override.  `'default'` falls through to podman's
  // bundled containers/common allow-list (no flag).
  const seccompOpt = seccompSecurityOpt(
    spec.seccomp,
    extras.seccompProfilePath,
  );
  if (seccompOpt !== undefined) {
    argv.push('--security-opt', seccompOpt);
  }

  // Caller-granted mounts.  podman's `--mount type=bind,…` form is
  // explicit about read-only vs. read-write.  We use `bind-propagation=rprivate`
  // (the default) so mount events do not leak across the namespace.
  for (const mount of spec.mounts) {
    const parts = [
      'type=bind',
      `source=${mount.hostPath}`,
      `target=${mount.innerPath}`,
    ];
    if (mount.mode === 'ro') parts.push('readonly');
    argv.push('--mount', parts.join(','));
  }

  // Writable scratch layer.  Mirrors the bwrap driver's `/scratch`
  // contract so callers see the same inner path on both backends.
  if (spec.scratchHostPath !== '') {
    argv.push(
      '--mount',
      `type=bind,source=${spec.scratchHostPath},target=/scratch`,
    );
  }

  // Environment.  podman starts its containers with a minimal env
  // already; we override / append the caller-supplied keys via -e.
  // When the caller did NOT set `PATH`, we inject `extras.pathInjection`
  // explicitly so the slice's `PATH` is observable from the host and
  // does not depend on whether the OCI image happened to set
  // `Config.Env`.  This mirrors the bwrap driver's `--setenv PATH=…`
  // path-synthesis behaviour.
  let hadPath = false;
  for (const [key, value] of Object.entries(spec.env)) {
    argv.push('-e', `${key}=${value}`);
    if (key === 'PATH') hadPath = true;
  }
  if (!hadPath && extras.pathInjection !== null) {
    argv.push('-e', `PATH=${extras.pathInjection}`);
  }

  if (spec.cwd !== undefined && spec.cwd !== '') {
    argv.push('--workdir', spec.cwd);
  }

  return argv;
};
harden(assembleCreateArgv);

/**
 * Construct the podman driver.
 *
 * @param {object} [input]
 * @param {Record<string, string>} [input.env]                Daemon env
 *                                                            (PATH etc.)
 * @param {typeof import('child_process')} [input.childProcess] Child-
 *                                                            process module
 *                                                            override
 *                                                            (tests).
 * @param {string} [input.ociRuntime]                         Override the
 *                                                            podman OCI
 *                                                            runtime
 *                                                            (`crun`, `runc`,
 *                                                            `krun`, …).  When
 *                                                            unset, the driver
 *                                                            keeps podman's
 *                                                            default runtime
 *                                                            unless that
 *                                                            runtime cannot
 *                                                            host `podman
 *                                                            exec` (e.g.
 *                                                            `krun`'s microVM
 *                                                            handler) — in
 *                                                            which case the
 *                                                            driver falls back
 *                                                            to `crun` /
 *                                                            `runc` so the
 *                                                            slice's spawn
 *                                                            surface keeps
 *                                                            working.
 * @param {string} [input.ownerId]                           Stable,
 *                                                            host-private
 *                                                            cleanup scope
 *                                                            (normally the
 *                                                            owning formula
 *                                                            id). Required
 *                                                            for availability.
 * @returns {SandboxDriver}
 */
export const makePodmanDriver = ({
  env: _env = {},
  childProcess: childProcessModule,
  ociRuntime,
  ownerId,
} = {}) => {
  // Lazy-resolve `child_process` so callers in test environments can
  // inject a stub without paying the import cost up front.
  /** @type {typeof import('child_process') | undefined} */
  let cpModule = childProcessModule;
  const getCp = async () => {
    await null;
    if (cpModule === undefined) {
      cpModule = await import('child_process');
    }
    return cpModule;
  };

  // cgroup v2 is the only kernel-feature probe that is meaningful for
  // podman: Landlock applies to the daemon's own filesystem view, not
  // the container's, so we do not surface it on this driver.
  const cgroup2Probe = makeCgroup2Probe();

  /** @type {boolean} */
  let orphanSweepDone = false;

  /**
   * Cached OCI-runtime selection.  `null` until the first probe / slice
   * resolves it, then either a runtime name (`crun` / `runc`) we
   * inject as `--runtime <name>` or the empty string meaning "leave
   * podman's default alone".
   *
   * @type {string | null}
   */
  let resolvedRuntime = ociRuntime ?? null;

  /**
   * Runtimes we know support `podman exec`.  `krun` runs containers
   * inside a libkrun microVM, which the upstream conmon handler
   * cannot attach to via exec — that surfaces as the cryptic "the
   * handler does not support exec" error.  Falling back to `crun`
   * (or `runc`) keeps the slice spawn surface working without
   * requiring the caller to know about the discrepancy.
   *
   * Order is preference for fallback selection.
   */
  const EXEC_CAPABLE_RUNTIMES = harden(['crun', 'runc']);
  const EXEC_INCAPABLE_RUNTIMES = harden(['krun']);

  /**
   * Resolve the OCI runtime once per driver lifetime.  Caches into
   * `resolvedRuntime` so subsequent slices skip the probe.  When the
   * caller passed `ociRuntime` explicitly we honour their choice
   * verbatim; otherwise we look at podman's default and only override
   * it when the default is known to refuse exec.
   *
   * @param {typeof import('child_process')} cp
   * @returns {Promise<string>}  Empty string ⇒ no `--runtime` flag
   *                              should be added.
   */
  const ensureRuntime = async cp => {
    await null;
    if (resolvedRuntime !== null) return resolvedRuntime;
    let info;
    try {
      info = await spawnAndCollect(
        cp,
        'podman',
        ['info', '--format', '{{.Host.OCIRuntime.Name}}'],
        { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS },
      );
    } catch {
      resolvedRuntime = '';
      return resolvedRuntime;
    }
    const defaultRuntime = info.code === 0 ? info.stdout.trim() : '';
    if (
      defaultRuntime === '' ||
      !EXEC_INCAPABLE_RUNTIMES.includes(defaultRuntime)
    ) {
      // Either we could not detect a default (use podman's choice) or
      // the default already supports exec.  Either way: no override.
      resolvedRuntime = '';
      return resolvedRuntime;
    }
    // Default is exec-incapable.  Pick the first fallback that exists
    // on PATH; if none exist, surface the default and let podman fail
    // with its own error message.
    for (const candidate of EXEC_CAPABLE_RUNTIMES) {
      // eslint-disable-next-line no-await-in-loop
      const v = await spawnAndCollect(cp, candidate, ['--version'], {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      }).catch(() => null);
      if (v !== null && v.code === 0) {
        resolvedRuntime = candidate;
        return resolvedRuntime;
      }
    }
    resolvedRuntime = '';
    return resolvedRuntime;
  };

  /**
   * Build a podman invocation argv with the resolved runtime prefix.
   * The prefix appears as a global flag (`--runtime crun`) before the
   * subcommand, matching podman's documented CLI ordering.
   *
   * @param {string} runtime  Empty string ⇒ no prefix.
   * @param {string[]} args
   * @returns {string[]}
   */
  const podmanArgs = (runtime, args) =>
    runtime === '' ? args : ['--runtime', runtime, ...args];

  /**
   * Remove one operation container, forcibly and under the control
   * deadline. Every removal path — orphan sweep, abandoned admission,
   * reap, teardown — goes through here so the deadline policy cannot be
   * applied to some of them and forgotten on the rest.
   *
   * @param {typeof import('child_process')} cp
   * @param {string} runtime
   * @param {string} name
   */
  const removeContainer = (cp, runtime, name) =>
    spawnAndCollect(cp, 'podman', podmanArgs(runtime, ['rm', '-f', name]), {
      timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
    });

  /**
   * Reap containers with this driver's exact owner label from a previous
   * daemon run. Listing or removal failures make the lifecycle probe fail
   * closed.
   *
   * @param {typeof import('child_process')} cp
   * @returns {Promise<void>}
   */
  const sweepOrphans = async cp => {
    const runtime = await ensureRuntime(cp);
    const listing = await spawnAndCollect(
      cp,
      'podman',
      podmanArgs(runtime, [
        'ps',
        '-a',
        '--filter',
        `label=${PODMAN_OWNER_LABEL}=${ownerId}`,
        '--format',
        '{{.Names}}',
      ]),
      { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS },
    );
    if (listing.code !== 0) {
      throw makeError(
        X`podman exact-label orphan listing failed: ${q(listing.stderr.trim() || listing.stdout.trim())}`,
      );
    }
    const names = listing.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s !== '');
    const removals = await Promise.all(
      names.map(async name => {
        await null;
        const result = await removeContainer(cp, runtime, name);
        if (result.code === 0) return undefined;
        return `${name}: ${result.stderr.trim() || result.stdout.trim()}`;
      }),
    );
    const failures = removals.filter(result => result !== undefined);
    if (failures.length > 0) {
      throw makeError(
        X`podman exact-label orphan removal failed: ${q(failures.join('; '))}`,
      );
    }
  };

  /**
   * Probe podman availability and rootless mode.  Phase 2 requires
   * rootless: rootful podman is intentionally rejected because the
   * sandbox security model assumes the slice cannot escalate beyond
   * the daemon's user identity.
   *
   * @returns {Promise<Omit<BackendProbe, 'name'>>}
   */
  /**
   * Report the driver unavailable because crash cleanup cannot be
   * proven. Process-group termination is never in doubt for podman —
   * the operation is container PID 1 — so only the cleanup half varies.
   *
   * @param {string} reason           Caller-facing summary.
   * @param {string} lifecycleReason  Which lifecycle proof is missing.
   * @param {Partial<Omit<BackendProbe, 'name' | 'available' | 'reason'>>} [extra]
   * @returns {Omit<BackendProbe, 'name'>}
   */
  const crashCleanupUnavailable = (reason, lifecycleReason, extra = {}) =>
    harden({
      available: false,
      ...extra,
      reason,
      details: harden({
        lifecycle: harden({
          available: false,
          processGroups: true,
          crashCleanup: false,
          reason: lifecycleReason,
        }),
        ...extra.details,
      }),
    });

  const probe = async () => {
    await null;
    if (ownerId === undefined || ownerId === '' || /[\0\r\n]/.test(ownerId)) {
      return crashCleanupUnavailable(
        'podman driver requires a stable ownerId for exact-label crash cleanup',
        'stable ownerId is not configured',
      );
    }
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

    let versionResult;
    try {
      versionResult = await spawnAndCollect(cp, 'podman', ['--version'], {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      });
    } catch (e) {
      const cause = /** @type {Error & { code?: string }} */ (e);
      const reason =
        cause.code === 'ENOENT'
          ? 'podman binary not found on PATH'
          : `failed to spawn podman: ${cause.message}`;
      return harden({ available: false, reason });
    }
    if (versionResult.code !== 0) {
      return harden({
        available: false,
        reason: `podman --version exited with code ${q(versionResult.code)}: ${versionResult.stderr.trim() || versionResult.stdout.trim()}`,
      });
    }
    const version = parsePodmanVersion(versionResult.stdout);
    if (version === undefined) {
      return harden({
        available: false,
        reason: `could not parse podman --version output: ${q(versionResult.stdout)}`,
      });
    }

    // Rootless check.  `podman info --format` returns "true" / "false"
    // (or an error message) on stdout.  A non-zero exit means podman
    // could not initialise its storage; that is fatal for the driver.
    let rootlessResult;
    try {
      rootlessResult = await spawnAndCollect(
        cp,
        'podman',
        ['info', '--format', '{{.Host.Security.Rootless}}'],
        { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS },
      );
    } catch (e) {
      const cause = /** @type {Error} */ (e);
      return harden({
        available: false,
        reason: `podman info failed: ${cause.message}`,
      });
    }
    if (rootlessResult.code !== 0) {
      return harden({
        available: false,
        reason: `podman info exited with code ${q(rootlessResult.code)}: ${rootlessResult.stderr.trim() || rootlessResult.stdout.trim()}`,
      });
    }
    const rootlessText = rootlessResult.stdout.trim();
    /** @type {{ available: boolean; reason?: string }} */
    let rootless;
    if (rootlessText === 'true') {
      rootless = harden({ available: true });
    } else if (rootlessText === 'false') {
      rootless = harden({
        available: false,
        reason:
          'podman is configured for rootful mode; the @endo/sandbox driver requires rootless podman',
      });
    } else {
      rootless = harden({
        available: false,
        reason: `podman info returned unexpected rootless flag: ${q(rootlessText)}`,
      });
    }
    if (!rootless.available) {
      return harden({
        available: false,
        version,
        reason: rootless.reason,
        details: harden({ rootless }),
      });
    }

    // Resolve the OCI runtime up front so the orphan-reap step (and
    // every subsequent slice) honours the same `--runtime` choice as
    // `prepareSlice` / `spawn`.  The resolution is best-effort:
    // failures degrade to "no override".
    await ensureRuntime(cp);

    // Boot-time orphan reap. Reconciliation is the crash-cleanup proof,
    // so a failure here makes the driver unavailable rather than
    // degrading it.
    if (!orphanSweepDone) {
      try {
        await sweepOrphans(cp);
        orphanSweepDone = true;
      } catch (e) {
        return crashCleanupUnavailable(
          /** @type {Error} */ (e).message,
          'exact-label orphan reconciliation failed',
          harden({ version, details: harden({ rootless }) }),
        );
      }
    }

    const cgroup2 = await cgroup2Probe.probe();
    /** @type {BackendProbeDetails} */
    const details = harden({
      lifecycle: harden({
        available: true,
        processGroups: true,
        crashCleanup: true,
      }),
      cgroup2: harden({
        available: cgroup2.available,
        controllers: cgroup2.controllers,
        ...(cgroup2.reason !== undefined ? { reason: cgroup2.reason } : {}),
      }),
      rootless,
    });
    return harden({ available: true, version, details });
  };

  /**
   * Cache of `image ref` → `Config.Env` PATH (or `null` when the
   * image declares no PATH / inspection failed).  Image refs are
   * effectively immutable once pulled; caching for the lifetime of
   * the driver avoids repeating `podman image inspect` for every
   * slice that reuses the same image, and the worst case under a
   * concurrent retag is a stale fallback that still produces a
   * working `PATH`.
   *
   * @type {Map<string, string | null>}
   */
  const imagePathCache = new Map();

  /**
   * Probe the OCI image's `Config.Env` for a `PATH=` entry and return
   * its value (or `null` when the image declares none).  Result is
   * cached in `imagePathCache` keyed by `ref`.
   *
   * Best-effort: any failure (inspect non-zero, malformed JSON, no
   * `Config.Env` key) is swallowed and surfaces as `null`, which
   * `resolveSlicePath` then maps onto the canonical `DEFAULT_PATH`.
   *
   * @param {typeof import('child_process')} cp
   * @param {string} ref
   * @returns {Promise<string | null>}
   */
  const inspectImagePath = async (cp, ref) => {
    if (imagePathCache.has(ref)) {
      // `Map.get` returns `T | undefined`; the `has` guard guarantees
      // the value is in the map, so a non-null assertion via cast is
      // safer than a `??` that would conflate "cached as null" with
      // "missing".
      return /** @type {string | null} */ (imagePathCache.get(ref) ?? null);
    }
    const runtime = await ensureRuntime(cp);
    let result;
    try {
      result = await spawnAndCollect(
        cp,
        'podman',
        podmanArgs(runtime, [
          'image',
          'inspect',
          '--format',
          '{{json .Config.Env}}',
          ref,
        ]),
      );
    } catch {
      imagePathCache.set(ref, null);
      return null;
    }
    if (result.code !== 0) {
      imagePathCache.set(ref, null);
      return null;
    }
    const imagePath = parseImagePathFromConfigEnv(result.stdout.trim());
    imagePathCache.set(ref, imagePath);
    return imagePath;
  };

  /**
   * Ensure the OCI image referenced by the slice spec is present in
   * the user's container storage.  No-op when the image is already
   * present (`podman image exists` exits 0).
   *
   * @param {typeof import('child_process')} cp
   * @param {string} ref
   * @returns {Promise<void>}
   */
  const ensureImage = async (cp, ref) => {
    const runtime = await ensureRuntime(cp);
    const exists = await spawnAndCollect(
      cp,
      'podman',
      podmanArgs(runtime, ['image', 'exists', ref]),
    );
    if (exists.code === 0) return;
    const pulled = await spawnAndCollect(
      cp,
      'podman',
      podmanArgs(runtime, ['pull', ref]),
    );
    if (pulled.code !== 0) {
      throw makeError(
        X`podman pull ${q(ref)} failed: ${q(pulled.stderr.trim() || pulled.stdout.trim())}`,
      );
    }
  };

  /**
   * @param {SliceSpec} spec
   * @returns {Promise<PodmanSliceContext>}
   */
  const prepareSlice = async spec => {
    if (
      spec.network !== 'none' &&
      spec.network !== 'private' &&
      spec.network !== 'host-loopback' &&
      spec.network !== 'host-lan' &&
      spec.network !== 'host-net'
    ) {
      throw makeError(X`unknown network profile ${q(spec.network)}`);
    }

    const ref = ociRefFromRootfs(spec.rootfs);
    if (ref === undefined) {
      // Phase 2 only supports OCI rootfs on the podman driver.  Other
      // shapes are bwrap-specific (host-bind / mount) or would require
      // bind-mounting the host as the container's rootfs, which is
      // out of scope for the OCI-image-centric driver.
      throw makeError(
        X`podman driver only supports rootfs: { kind: 'oci', ref }; got ${q(/** @type {any} */ (spec.rootfs).kind ?? typeof spec.rootfs)}`,
      );
    }

    const cp = await getCp();
    await ensureImage(cp, ref);

    // Probe the image's `Config.Env` PATH so the slice's `$PATH`
    // synthesis (below) has an image-derived default available.
    // The probe is cached per `ref` for the driver's lifetime; the
    // first slice for a given image pays the cost.
    const imagePath = await inspectImagePath(cp, ref);

    // Pick the rootless network backend up front so the runtime
    // report reflects what the slice actually got.  `none` and
    // `host-*` profiles do not require pasta / slirp4netns; only
    // `private` does.  When neither binary is on PATH but the caller
    // asked for `private`, fail with a structured error rather than
    // letting podman emit a generic ENOENT later.
    const netBackend = await probeRootlessNetBackend(cp);
    if (spec.network === 'private' && netBackend === null) {
      throw makeError(
        X`podman driver: network 'private' requires either slirp4netns or pasta on PATH; neither was found`,
      );
    }

    // Materialise a caller-supplied seccomp profile to a temp file so
    // podman can load it via `--security-opt seccomp=<path>`.  The
    // built-in `'default'` and `'unconfined'` policies do not need a
    // file — `seccompSecurityOpt` returns the right flag value (or
    // `undefined` for podman's default) without any side effect.
    /** @type {string | null} */
    let seccompTempPath = null;
    if (
      typeof spec.seccomp === 'object' &&
      spec.seccomp !== null &&
      'profile' in spec.seccomp
    ) {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'endo-sandbox-seccomp-'),
      );
      const file = path.join(dir, 'profile.json');
      const profile = /** @type {{ profile: unknown }} */ (spec.seccomp)
        .profile;
      const body =
        typeof profile === 'string'
          ? profile
          : profile instanceof Uint8Array
            ? Buffer.from(profile).toString('utf8')
            : JSON.stringify(profile);
      fs.writeFileSync(file, body);
      seccompTempPath = file;
    }

    const runtime = await ensureRuntime(cp);
    // Each spawn gets a one-operation container. The slice retains only
    // immutable construction policy, so terminating one operation never
    // depends on signalling a `podman exec` proxy or disturbs a sibling.
    const slicePath = resolveSlicePath(spec, imagePath);

    const cgroup2 = await cgroup2Probe.probe();
    /** @type {PodmanSliceContext['runtimeDetails']} */
    const runtimeDetails = harden({
      cgroup2: harden({
        available: cgroup2.available,
        controllers: cgroup2.controllers,
        ...(cgroup2.reason !== undefined ? { reason: cgroup2.reason } : {}),
      }),
      rootless: harden({ available: true }),
      rootlessNet: harden(
        netBackend === null
          ? {
              backend: /** @type {RootlessNetBackend} */ (null),
              reason:
                'no rootless network backend on PATH (slirp4netns / pasta)',
            }
          : { backend: netBackend },
      ),
      path: slicePath,
    });

    /** @type {PodmanSliceContext} */
    const ctx = {
      spec,
      ref,
      netBackend,
      runtime,
      live: new Map(),
      seccompTempPath,
      runtimeDetails,
    };
    return ctx;
  };

  /**
   * @param {PodmanSliceContext} slice
   * @param {string[]} argv
   * @param {SpawnOpts} opts
   * @param {import('../types.js').DriverSpawnControls} [controls]
   * @returns {Promise<DriverProcess>}
   */
  const spawn = async (slice, argv, opts, controls) => {
    if (argv.length === 0) {
      throw makeError(X`spawn argv must be non-empty`);
    }
    const cp = await getCp();
    if (ownerId === undefined) {
      throw makeError(X`podman driver ownerId is not configured`);
    }
    const admissionSignal = controls?.signal;

    const containerName = makeOperationName();
    // Names include pid, time, and a counter, so the operation label remains
    // unique even when multiple handles share one formula owner.
    const operationId = containerName;
    const operationSpec = harden({
      ...slice.spec,
      env: harden({ ...slice.spec.env, ...(opts.env ?? {}) }),
      cwd: opts.cwd ?? slice.spec.cwd,
    });
    const slicePath = resolveSlicePath(
      operationSpec,
      slice.runtimeDetails.path.value,
    );
    const pathInjection = slicePath.source === 'env' ? null : slicePath.value;
    const createArgv = podmanArgs(slice.runtime, [
      ...assembleCreateArgv(operationSpec, containerName, slice.netBackend, {
        seccompProfilePath: slice.seccompTempPath,
        pathInjection,
        ownerId,
        operationId,
      }),
      slice.ref,
      ...argv,
    ]);
    // Bounded removal of the exact named operation this spawn minted.
    // Used on every abandonment path so an aborted or failed admission
    // cannot leak the container.
    const removeOperation = () =>
      removeContainer(cp, slice.runtime, containerName).catch(() => undefined);

    let created;
    try {
      created = await spawnAndCollect(cp, 'podman', createArgv, {
        timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
        signal: admissionSignal,
      });
    } catch (e) {
      // The stalled or aborted create may have registered the name
      // before dying; remove it so nothing outlives the admission.
      await removeOperation();
      throw e;
    }
    if (created.code !== 0) {
      throw makeError(
        X`podman operation create failed: ${q(created.stderr.trim() || created.stdout.trim())}`,
      );
    }
    if (admissionSignal?.aborted) {
      await removeOperation();
      throw makeError(X`podman operation admission aborted`);
    }

    const startArgv = podmanArgs(slice.runtime, [
      'start',
      '--attach',
      '--interactive',
      containerName,
    ]);

    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = cp.spawn('podman', startArgv, {
        stdio: [
          'pipe',
          opts.captureStdout === false ? 'ignore' : 'pipe',
          opts.captureStderr === false ? 'ignore' : 'pipe',
        ],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
    } catch (e) {
      await removeOperation();
      throw makeError(
        X`failed to attach podman operation: ${q(/** @type {Error} */ (e).message)}`,
      );
    }

    /** @type {Promise<{ code: number | null; signal: string | null }>} */
    const proxyExited = new Promise((resolve, reject) => {
      child.once('error', err => {
        reject(err);
      });
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    proxyExited.catch(() => undefined);

    const exited = (async () => {
      await null;
      let status;
      let proxyFailure;
      try {
        status = await proxyExited;
      } catch (e) {
        proxyFailure = e;
      }
      const removed = await removeContainer(cp, slice.runtime, containerName);
      slice.live.delete(containerName);
      if (removed.code !== 0 && !reportsContainerGone(removed)) {
        throw makeError(
          X`podman operation reap failed: ${q(removed.stderr.trim() || removed.stdout.trim())}`,
        );
      }
      if (proxyFailure !== undefined) throw proxyFailure;
      return /** @type {{ code: number | null, signal: string | null }} */ (
        status
      );
    })();
    exited.catch(() => undefined);
    // Not hardened: the entry holds a Node ChildProcess, whose internal
    // stream state cannot survive a deep freeze.
    slice.live.set(containerName, { child, wait: exited });

    const stdinStream = child.stdin;
    /** @type {DriverProcess & { writeStdin(chunk: Uint8Array): Promise<void>, closeStdin(): Promise<void> }} */
    const driverProcExtended = harden({
      pid: child.pid ?? -1,
      stdin: null,
      stdout: readableToAsyncIterable(child.stdout),
      stderr: readableToAsyncIterable(child.stderr),
      wait: () => exited,
      kill: async signal => {
        // The operation itself is container PID 1. Signalling the exact
        // container therefore covers every descendant, unlike signalling a
        // host-side `podman exec` proxy.
        const result = await spawnAndCollect(
          cp,
          'podman',
          podmanArgs(slice.runtime, [
            'kill',
            '--signal',
            String(signal ?? 'SIGTERM'),
            containerName,
          ]),
          { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS },
        );
        if (
          result.code !== 0 &&
          !reportsContainerGone(result) &&
          !reportsContainerNotRunning(result)
        ) {
          throw makeError(
            X`podman operation signal failed: ${q(result.stderr.trim() || result.stdout.trim())}`,
          );
        }
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
   * @param {PodmanSliceContext} slice
   * @returns {Promise<void>}
   */
  const teardown = async slice => {
    const cp = await getCp();
    // The factory owns the graceful ladder and reaps every operation
    // before it calls teardown(), so a straggler here has already spent
    // the soft path: remove it forcibly rather than running a second
    // escalation on a budget that disagrees with the factory's. Each
    // operation removes and then awaits its own reaper independently,
    // so one slow container does not gate the rest; the reaper tolerates
    // finding the container already gone.
    await Promise.all(
      [...slice.live].map(async ([name, operation]) => {
        await null;
        await removeContainer(cp, slice.runtime, name).catch(() => undefined);
        await operation.wait.catch(() => undefined);
      }),
    );
    slice.live.clear();

    // Unlink any seccomp profile we materialised for `--security-opt
    // seccomp=<path>`.  Best-effort: if the temp file was already
    // collected by an external sweep, swallow the error.
    if (slice.seccompTempPath !== null) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const seccompPath = slice.seccompTempPath;
        await fs.promises.unlink(seccompPath);
        await fs.promises.rmdir(path.dirname(seccompPath));
      } catch {
        // already gone
      }
      slice.seccompTempPath = null;
    }
  };

  return harden({
    name: /** @type {const} */ ('podman'),
    probe,
    prepareSlice,
    spawn,
    teardown,
  });
};
harden(makePodmanDriver);
