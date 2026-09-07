// @ts-check

import { M } from '@endo/patterns';

/**
 * Runtime `M.interface()` guards for the `@endo/sandbox` capability
 * surface. The compile-time shapes live in `./types.d.ts`; these guards
 * are what `makeExo` enforces at the CapTP boundary.
 */

// ---------------------------------------------------------------------------
// Shared shape fragments
// ---------------------------------------------------------------------------

const NetworkProfileShape = M.or(
  'none',
  'broker-only',
  'private',
  'host-loopback',
  'host-lan',
  'host-net',
);

const BackendNameShape = M.or(
  'bwrap',
  'podman',
  'lima',
  'containerization',
  'wsl',
);

const BackendSelectorShape = M.or('auto', BackendNameShape);

const MountModeShape = M.or('ro', 'rw');

const EnvShape = M.recordOf(M.string(), M.string());

const RootfsSpecShape = M.or(
  M.remotable('Mount'),
  M.splitRecord({ kind: 'host-bind' }),
  M.splitRecord({ kind: 'minimal' }),
  M.splitRecord({ kind: 'oci', ref: M.string() }),
);

const MountSpecShape = M.splitRecord(
  {
    cap: M.remotable('Mount'),
    innerPath: M.string(),
  },
  {
    mode: MountModeShape,
  },
);

const SeccompPolicyShape = M.or(
  'default',
  'unconfined',
  M.splitRecord({ profile: M.any() }),
);

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

/**
 * Shape of an enforced deployment policy. The guard admits the record;
 * `assertSlicePolicyRequest` in `./policy.js` is what insists on exact
 * key sets, portable names, and a mount table whose ceilings add up,
 * because those are policy questions rather than marshalling ones.
 */
const SlicePolicyMountShape = M.or(
  M.splitRecord({
    role: M.string(),
    kind: 'tmpfs',
    destination: M.string(),
    sizeBytes: M.nat(),
  }),
  M.splitRecord({
    role: M.string(),
    kind: 'volume',
    source: M.string(),
    destination: M.string(),
    sizeBytes: M.nat(),
  }),
);

const SlicePolicyRequestShape = M.splitRecord({
  profile: 'hosted-agent-v1',
  imageDigest: M.string(),
  uid: M.number(),
  gid: M.number(),
  brokerSidecar: M.or(
    M.splitRecord({ container: M.string() }),
    M.splitRecord({ netnsPath: M.string() }),
  ),
  resources: M.splitRecord({
    memoryBytes: M.nat(),
    pids: M.number(),
    cpuCores: M.number(),
    openFiles: M.number(),
    coreBytes: M.nat(),
    writableBytes: M.nat(),
  }),
  mounts: M.arrayOf(SlicePolicyMountShape),
  attestationArgv: M.arrayOf(M.string()),
});

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
    policy: SlicePolicyRequestShape,
  },
);

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

/**
 * A live sandbox slice — pinned by the formula that minted it.
 */
export const SandboxHandleInterface = M.interface('SandboxHandle', {
  help: M.call().optional(M.string()).returns(M.string()),
  spawn: M.call(M.arrayOf(M.string()))
    .optional(SpawnOptsShape)
    .returns(M.promise()),
  policy: M.call().returns(M.promise()),
  mount: M.call(M.remotable('Mount'), M.string())
    .optional(MountModeShape)
    .returns(M.promise()),
  scratch: M.call(M.string()).returns(M.promise()),
  open: M.call(M.string()).returns(M.promise()),
  fork: M.call().optional(SandboxMakeOptsShape).returns(M.promise()),
  reset: M.call().returns(M.promise()),
  dispose: M.call().returns(M.promise()),
});

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

// ---------------------------------------------------------------------------
// Re-exported shape fragments — useful for tests / driver authors
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
  SlicePolicyMountShape,
  SlicePolicyRequestShape,
  SpawnOptsShape,
  TerminationSignalShape,
};
