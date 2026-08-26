// @ts-check

import { M } from '@endo/patterns';

/**
 * Runtime `M.interface()` guards for the `@endo/sandbox` capability
 * surface. The compile-time shapes live in `./types.d.ts`; these guards
 * are what `makeExo` enforces at the CapTP boundary.
 *
 * This module also carries the declarative backend-capability table that
 * callers need in order to reject an unconstructible profile before a
 * driver ever sees it. It deliberately imports nothing but `M`, so a
 * policy layer can consume it without pulling a `node:` builtin into an
 * XS bundle.
 */

// ---------------------------------------------------------------------------
// Shared shape fragments
// ---------------------------------------------------------------------------

const NetworkProfileShape = M.or(
  'none',
  'private',
  'host-loopback',
  'host-lan',
  'host-net',
);
harden(NetworkProfileShape);

const BackendNameShape = M.or(
  'bwrap',
  'podman',
  'lima',
  'containerization',
  'wsl',
);
harden(BackendNameShape);

const BackendSelectorShape = M.or('auto', BackendNameShape);
harden(BackendSelectorShape);

const MountModeShape = M.or('ro', 'rw');
harden(MountModeShape);

const EnvShape = M.recordOf(M.string(), M.string());
harden(EnvShape);

const RootfsSpecShape = M.or(
  M.remotable('Mount'),
  M.splitRecord({ kind: 'host-bind' }),
  M.splitRecord({ kind: 'minimal' }),
  M.splitRecord({ kind: 'oci', ref: M.string() }),
);
harden(RootfsSpecShape);

/**
 * Rootfs kinds each implemented backend can actually materialise, keyed
 * by `BackendName`.
 *
 * The drivers already reject the pairs they cannot serve — see
 * `bwrap.js`'s `oci` refusal and `podman.js`'s "only supports rootfs:
 * { kind: 'oci', ref }" — but they can only do so at `prepareSlice`
 * time, long after a policy layer has validated and persisted the
 * profile. Publishing the table lets that layer refuse
 * `{ backend: 'podman', rootfs: { kind: 'host-bind' } }` up front,
 * with an error about the profile rather than about the driver.
 *
 * A backend absent from this table carries no constraint: it is either
 * unimplemented (`lima`, `containerization`, `wsl`) or the `'auto'`
 * selector, whose resolution is a runtime property of the host. Callers
 * should read a missing entry as "not known to be impossible" and let
 * `make()` report the real availability.
 *
 * `'mount'` is the resolved kind a `Mount` capability normalizes to; it
 * is not spelled in `RootfsSpecShape` because callers pass the cap
 * itself.
 *
 * @type {Readonly<Record<string, readonly string[] | undefined>>}
 */
const backendRootfsKinds = harden({
  bwrap: ['host-bind', 'minimal', 'mount'],
  podman: ['oci'],
});

const MountSpecShape = M.splitRecord(
  {
    cap: M.remotable('Mount'),
    innerPath: M.string(),
  },
  {
    mode: MountModeShape,
  },
);
harden(MountSpecShape);

const SeccompPolicyShape = M.or(
  'default',
  'unconfined',
  M.splitRecord({ profile: M.any() }),
);
harden(SeccompPolicyShape);

// `kill()` always begins terminal cancellation of the whole process
// tree, so only the termination signals the supervisor supports are
// accepted. A nonterminating value such as `0` (liveness probe) or
// `SIGUSR1` would still escalate to SIGKILL and destroy the process,
// so it is rejected at the boundary instead.
const TerminationSignalShape = M.or(
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGKILL',
);
harden(TerminationSignalShape);

const ResourceLimitsShape = M.splitRecord(
  {},
  {
    as: M.number(),
    cpu: M.number(),
    nproc: M.number(),
    nofile: M.number(),
    fsize: M.number(),
    core: M.number(),
  },
);
harden(ResourceLimitsShape);

const SandboxMakeOptsShape = M.splitRecord(
  {
    rootfs: RootfsSpecShape,
  },
  {
    mounts: M.arrayOf(MountSpecShape),
    network: NetworkProfileShape,
    backend: BackendSelectorShape,
    seccomp: SeccompPolicyShape,
    env: EnvShape,
    cwd: M.string(),
    limits: ResourceLimitsShape,
  },
);
harden(SandboxMakeOptsShape);

const SpawnOptsShape = M.splitRecord(
  {},
  {
    env: EnvShape,
    cwd: M.string(),
    stdin: M.remotable('Reader'),
    captureStdout: M.boolean(),
    captureStderr: M.boolean(),
    stdoutByteLimit: M.and(M.nat(), M.gte(1n)),
    stderrByteLimit: M.and(M.nat(), M.gte(1n)),
    // Capped at ~24.8 days by choice, not by the domain: a process
    // deadline is not inherently a 32-bit quantity, but every timer
    // implementation we target clamps there, and a single un-rearmed
    // timer is the simpler mechanism. Lifting the cap means re-arming
    // across the clamp, not widening this bound alone.
    timeoutMs: M.and(M.number(), M.gte(1), M.lte(0x7fff_ffff)),
  },
);
harden(SpawnOptsShape);

const BackendProbeDetailsShape = M.splitRecord(
  {},
  {
    lifecycle: M.splitRecord(
      { available: M.boolean() },
      { reason: M.string() },
    ),
    landlock: M.splitRecord({ available: M.boolean() }, { reason: M.string() }),
    cgroup2: M.splitRecord(
      { available: M.boolean(), controllers: M.arrayOf(M.string()) },
      { reason: M.string() },
    ),
    rootless: M.splitRecord({ available: M.boolean() }, { reason: M.string() }),
  },
);
harden(BackendProbeDetailsShape);

const BackendProbeShape = M.splitRecord(
  {
    name: BackendNameShape,
    available: M.boolean(),
  },
  {
    reason: M.string(),
    version: M.string(),
    details: BackendProbeDetailsShape,
  },
);
harden(BackendProbeShape);

const ExitStatusShape = harden({
  code: M.or(M.number(), M.null()),
  signal: M.or(M.string(), M.null()),
});

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Root capability minted by the plugin's `make-unconfined` entry point.
 * Mints individual sandbox slices.
 */
export const SandboxFactoryInterface = M.interface('SandboxFactory', {
  help: M.call().optional(M.string()).returns(M.string()),
  listBackends: M.call().returns(M.promise()),
  make: M.call(SandboxMakeOptsShape).returns(M.promise()),
});
harden(SandboxFactoryInterface);

/**
 * A live sandbox slice — pinned by the formula that minted it.
 */
export const SandboxHandleInterface = M.interface('SandboxHandle', {
  help: M.call().optional(M.string()).returns(M.string()),
  spawn: M.call(M.arrayOf(M.string()))
    .optional(SpawnOptsShape)
    .returns(M.promise()),
  mount: M.call(M.remotable('Mount'), M.string())
    .optional(MountModeShape)
    .returns(M.promise()),
  scratch: M.call(M.string()).returns(M.promise()),
  open: M.call(M.string()).returns(M.promise()),
  fork: M.call().optional(SandboxMakeOptsShape).returns(M.promise()),
  reset: M.call().returns(M.promise()),
  dispose: M.call().returns(M.promise()),
});
harden(SandboxHandleInterface);

/**
 * A process running inside a slice. Stdio uses Endo's existing
 * `reader-ref` / `writer-ref` plumbing.
 */
export const ProcessHandleInterface = M.interface('SandboxProcess', {
  help: M.call().optional(M.string()).returns(M.string()),
  pid: M.call().returns(M.number()),
  stdin: M.call().returns(M.remotable('Writer')),
  stdout: M.call().returns(M.remotable('PassableBytesReader')),
  stderr: M.call().returns(M.remotable('PassableBytesReader')),
  wait: M.call().returns(M.promise()),
  kill: M.call().optional(TerminationSignalShape).returns(M.promise()),
});
harden(ProcessHandleInterface);

/**
 * A mount bound into a slice.
 */
export const MountHandleInterface = M.interface('SandboxMount', {
  help: M.call().optional(M.string()).returns(M.string()),
  innerPath: M.call().returns(M.string()),
  cap: M.call().returns(M.remotable('Mount')),
  mode: M.call().returns(MountModeShape),
  unmount: M.call().returns(M.promise()),
});
harden(MountHandleInterface);

// ---------------------------------------------------------------------------
// Re-exported shape fragments and the backend-capability table — useful
// for tests, driver authors, and policy layers that validate a profile
// before a driver sees it.
// ---------------------------------------------------------------------------

export {
  BackendNameShape,
  BackendProbeDetailsShape,
  BackendProbeShape,
  BackendSelectorShape,
  EnvShape,
  ExitStatusShape,
  MountModeShape,
  MountSpecShape,
  NetworkProfileShape,
  ResourceLimitsShape,
  RootfsSpecShape,
  SandboxMakeOptsShape,
  SeccompPolicyShape,
  SpawnOptsShape,
  TerminationSignalShape,
  backendRootfsKinds,
};
