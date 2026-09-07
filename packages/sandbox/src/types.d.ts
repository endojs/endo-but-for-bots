/**
 * Type definitions for the `@endo/sandbox` plugin.
 *
 * These describe the capability surface and backend driver interface.
 * They are the typed contract
 * Phase 1+ implementations will fill in. No runtime code lives here —
 * the runtime guards live in `./interfaces.js`.
 */

import type { ERef, FarRef } from '@endo/eventual-send';
import type {
  PassableBytesReader,
  PassableBytesWriter,
} from '@endo/exo-stream';

// ---------------------------------------------------------------------------
// Network policy
// ---------------------------------------------------------------------------

/**
 * Network policy ladder applied at slice construction. Profiles are
 * strictly ordered from most-confined to least-confined; misconfiguration
 * is a hard error, never an upgrade.
 *
 * - `none`        — no network reachable.
 * - `broker-only` — join a namespace an operator prepared that holds
 *                   loopback and nothing routable, so the only peer is
 *                   the broker's in-namespace listener. Requires — and
 *                   is required by — a `SlicePolicyRequest`, which names
 *                   the namespace and whose attestation proves the
 *                   interface inventory.
 * - `private`     — private namespace, NAT'd outbound, RFC 1918 / loopback
 *                   blocklisted.
 * - `host-loopback` — share host net namespace, only loopback reachable.
 * - `host-lan`    — share host net namespace, no public Internet.
 * - `host-net`    — share host net namespace, no extra filtering.
 */
export type NetworkProfile =
  | 'none'
  | 'broker-only'
  | 'private'
  | 'host-loopback'
  | 'host-lan'
  | 'host-net';

// ---------------------------------------------------------------------------
// Backend driver names and probe results
// ---------------------------------------------------------------------------

/**
 * Backend driver registry. v1 only ships `bwrap` (Phase 1) and
 * `podman` (Phase 2); the rest are reserved for later phases.
 */
export type BackendName =
  'bwrap' | 'podman' | 'lima' | 'containerization' | 'wsl';

/**
 * Backend selection passed to `SandboxFactory.make()`.
 * `'auto'` lets the factory choose the first available backend.
 */
export type BackendSelector = 'auto' | BackendName;

/**
 * Optional kernel-feature detail attached to a backend probe.  Phase
 * 1.5 surfaces Landlock and cgroup v2 status; Phase 2 adds the
 * `rootless` flag for the podman driver so callers can tell whether
 * podman runs as a regular user (the only mode the sandbox supports).
 */
export type BackendProbeDetails = {
  /**
   * Lifecycle properties required by every usable sandbox driver.
   * Drivers that cannot terminate a whole process tree and clean up after
   * an owner crash are reported unavailable rather than silently weakening
   * confinement.
   */
  lifecycle?: {
    available: boolean;
    reason?: string;
  };
  /** Landlock LSM availability (kernel ≥ 5.13). */
  landlock?: {
    available: boolean;
    reason?: string;
  };
  /** cgroup v2 availability + delegated controllers. */
  cgroup2?: {
    available: boolean;
    controllers: string[];
    reason?: string;
  };
  /**
   * Rootless container engine availability (Phase 2; podman driver).
   * `available: false` either means the binary is rootful-only or that
   * rootless support could not be confirmed.
   */
  rootless?: {
    available: boolean;
    reason?: string | undefined;
  };
};

/**
 * Result of probing a backend driver for availability. Probing is
 * best-effort and fast (binary present? `--version` works? kernel
 * feature reachable?).
 */
export type BackendProbe = {
  /** Backend driver name. */
  name: BackendName;
  /** Whether this backend is usable on the current host. */
  available: boolean;
  /** Optional human-readable explanation when `available` is false. */
  reason?: string | undefined;
  /** Optional version string reported by the backend's CLI. */
  version?: string;
  /** Optional kernel-feature detail, populated by Phase 1.5+ drivers. */
  details?: BackendProbeDetails;
};

// ---------------------------------------------------------------------------
// Mount specifications and rootfs
// ---------------------------------------------------------------------------

/** Mount mode — read-only is the default. */
export type MountMode = 'ro' | 'rw';

/**
 * A `Mount` capability the caller has been granted by Endo's existing
 * `provideMount` machinery. The sandbox plugin never accepts string
 * host paths in lieu of a `Mount` capability.
 */
export type MountCap = ERef<unknown>;

/**
 * Specification for a mount to be bound into the slice.
 */
export type MountSpec = {
  /** Mount capability to bind into the slice. */
  cap: MountCap;
  /** Path inside the slice where the mount appears. */
  innerPath: string;
  /** Mount mode (`ro` by default). */
  mode?: MountMode;
};

/**
 * Rootfs selector for the slice. Either:
 * - a `Mount` capability rooted at a directory containing a userland tree,
 * - `{ kind: 'host-bind' }` to bind-mount the host's `/usr` / `/etc` /
 *   etc. read-only (the Flatpak pattern),
 * - `{ kind: 'minimal' }` for a backend-supplied empty / busybox rootfs,
 *   or
 * - `{ kind: 'oci', ref }` to materialise the slice from an OCI image
 *   reference (Phase 2; podman driver only).  The reference uses the
 *   transport / repo / tag form podman accepts directly, e.g.
 *   `docker.io/library/alpine:3.19`.  The driver pulls the image into
 *   the user's container storage on first use; the bwrap driver
 *   rejects `oci` rootfs with a structured error.
 */
export type RootfsSpec =
  | MountCap
  | { kind: 'host-bind' }
  | { kind: 'minimal' }
  | { kind: 'oci'; ref: string };

// ---------------------------------------------------------------------------
// Seccomp policy
// ---------------------------------------------------------------------------

/**
 * Seccomp policy for the slice.
 *
 * - `'default'`     — backend-default profile (podman/docker default-deny).
 * - `'unconfined'`  — disable seccomp entirely (escape hatch).
 * - `{ profile }`   — caller-supplied profile blob (BPF JSON or similar);
 *                     the shape is backend-specific and is opaque to the
 *                     factory.
 */
export type SeccompPolicy = 'default' | 'unconfined' | { profile: unknown };

// ---------------------------------------------------------------------------
// Slice construction
// ---------------------------------------------------------------------------

/**
 * Options accepted by `SandboxFactory.make()`. Many fields are optional;
 * the factory applies safe defaults (network 'none', seccomp 'default',
 * read-only mounts) when omitted.
 */
export type SandboxMakeOpts = {
  rootfs: RootfsSpec;
  mounts?: readonly MountSpec[];
  network?: NetworkProfile;
  backend?: BackendSelector;
  seccomp?: SeccompPolicy;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Resource caps applied via `prlimit` (Phase 1.5+).  Unset values
   * fall back to the driver-default table; see
   * `src/limits.js#DEFAULT_LIMITS`.
   */
  limits?: ResourceLimits;
  /**
   * Enforced deployment policy. When present, `make()` builds the slice
   * under exactly this configuration and rejects unless every control
   * is proved against effective state; `SandboxHandle.policy()` then
   * returns the attestation. Requires `network: 'broker-only'`, and
   * declares the whole mount table, so `mounts` must be empty.
   */
  policy?: SlicePolicyRequest;
};

// ---------------------------------------------------------------------------
// Slice policy — enforced configuration and its attestation
// ---------------------------------------------------------------------------

/**
 * One entry of the exact mount table a policy declares. Every entry is
 * writable and carries a ceiling: a writable path with no ceiling is
 * the aggregate storage bound's missing half, and a read-only path
 * belongs in the image rather than in the table.
 *
 * A `tmpfs` entry is minted per slice; a `volume` entry names durable
 * state an operator created, whose ceiling the storage driver must
 * already have recorded because nothing can impose one afterwards.
 */
export type SlicePolicyMount =
  | {
      role: string;
      kind: 'tmpfs';
      destination: string;
      sizeBytes: bigint;
    }
  | {
      role: string;
      kind: 'volume';
      source: string;
      destination: string;
      sizeBytes: bigint;
    };

/**
 * Resource ceilings a policy requires the host to apply through cgroups
 * and rlimits. Every ceiling is mandatory: a policy with a
 * "leave this one to the host default" hole is exactly the shape whose
 * enforcement nobody can later prove.
 *
 * Byte quantities are `bigint` because Linux expresses cgroup ceilings
 * as unsigned 64-bit quantities; counts the kernel bounds well inside
 * four bytes stay `number`.
 */
export type SlicePolicyResources = {
  memoryBytes: bigint;
  pids: number;
  cpuCores: number;
  openFiles: number;
  coreBytes: bigint;
  writableBytes: bigint;
};

/**
 * The machine-checkable half of a hosted-agent deployment contract.
 *
 * Passing one to `SandboxFactory.make()` makes construction fail closed:
 * the slice is created under exactly this configuration, a live anchor
 * is inspected against the kernel's own account of what happened, and
 * `make()` rejects unless every control is proved.
 */
export type SlicePolicyRequest = {
  /** The only profile v1 implements. */
  profile: 'hosted-agent-v1';
  /** `sha256:<64 lowercase hex digits>`; tags are rejected. */
  imageDigest: string;
  /** Numeric identity inside the slice's user namespace; never 0. */
  uid: number;
  gid: number;
  /**
   * The network namespace to join, named either by the container that
   * holds it or by its path. The operator prepares it with the broker's
   * loopback listener and nothing routable; the attestation proves the
   * inventory rather than trusting the preparation.
   */
  brokerSidecar: { container: string } | { netnsPath: string };
  resources: SlicePolicyResources;
  /** The exact mount table, and nothing else, that the slice may have. */
  mounts: readonly SlicePolicyMount[];
  /**
   * An argv from the pinned image that blocks until it is removed. It
   * runs as the slice's policy anchor: the live container the
   * attestation reads namespace links, identity, and interfaces from.
   * The caller names it because the caller pinned the image.
   */
  attestationArgv: readonly string[];
};

/**
 * What the runtime and the kernel were observed to have done, gathered
 * by the driver and translated by `attestSlicePolicy`.
 */
export type ObservedSliceState = {
  /** Parsed container-runtime inspect record for the live anchor. */
  inspect: unknown;
  /** Whether the container engine runs without host root. */
  rootless: boolean;
  /** Per namespace, whether the anchor's differs from the daemon's. */
  unsharedNamespaces: {
    user: boolean;
    pid: boolean;
    ipc: boolean;
    mount: boolean;
  };
  /** The anchor's network namespace, as `procfs` describes it. */
  network: {
    namespaceId: string;
    interfaces: readonly string[];
    routableRoutes: number;
  };
  /** The anchor's uid/gid inside its own user namespace. */
  processIdentity: { uid: number; gid: number };
  /** Recorded storage ceiling per declared volume; `null` when none is. */
  volumeQuotas: ReadonlyMap<string, bigint | null>;
  /** Host controls the ceilings depend on. */
  resources: { cgroupControllers: readonly string[] };
  /** Whether every descendant is inside something the driver removes. */
  descendantReaping: boolean;
};

/**
 * Proof that a slice runs under its policy, derived entirely from
 * observation. Every field is present only because the corresponding
 * control was observed; `attestSlicePolicy` throws rather than
 * attesting to one it could not read.
 */
export type SlicePolicyAttestation = {
  version: 'SlicePolicyAttestationV1';
  profile: 'hosted-agent-v1';
  backend: 'rootless-podman';
  imageDigest: string;
  network: 'broker-only';
  /** Stable identity of the joined namespace, for a broker lease to bind to. */
  networkNamespaceId: string;
  uid: number;
  gid: number;
  readOnlyRoot: true;
  noNewPrivileges: true;
  dropAllCapabilities: true;
  seccomp: true;
  devices: 'none';
  hostSockets: 'none';
  hostHome: 'none';
  descendantReaping: true;
  namespaces: {
    user: 'private';
    pid: 'private';
    ipc: 'private';
    mount: 'private';
  };
  limits: SlicePolicyResources;
  /** The effective mount table, with the hardening options in force. */
  mounts: readonly {
    role: string;
    /** `tmpfs`, or `volume:<name>`. */
    source: string;
    destination: string;
    mode: 'rw';
    options: readonly string[];
  }[];
};

/**
 * Resource caps applied to the slice's first process (and inherited
 * by every descendant).  Each key matches a `prlimit` long flag.
 *
 * These are per-process rlimits, not cgroup ceilings: they bound what
 * one process can ask for, not what a slice can consume in aggregate.
 * A deployment that needs the aggregate bound wants `SlicePolicyRequest`
 * (`resources`), whose ceilings are applied through cgroups and read
 * back from effective state.
 */
export type ResourceLimits = {
  /** RLIMIT_AS — virtual memory bytes. */
  as?: number;
  /** RLIMIT_CPU — wallclock seconds. */
  cpu?: number;
  /** RLIMIT_NPROC — max processes per uid. */
  nproc?: number;
  /** RLIMIT_NOFILE — open file descriptors. */
  nofile?: number;
  /** RLIMIT_FSIZE — bytes any single file the slice writes can grow to. */
  fsize?: number;
  /** RLIMIT_CORE — core dump size cap (defaults to 0). */
  core?: number;
};

/**
 * Spec passed to a `SandboxDriver` after the factory has resolved every
 * `Mount` capability to a host path. Drivers never see Endo capabilities
 * directly — the factory is the single mediator that performs cap-to-path
 * resolution.
 */
export type SliceSpec = {
  /** Resolved rootfs source. `null` denotes the host-bind / minimal case. */
  rootfs:
    | { kind: 'host-bind' }
    | { kind: 'minimal' }
    | { kind: 'mount'; hostPath: string; mode: MountMode }
    | { kind: 'oci'; ref: string };
  /** Resolved bind-mount triples. */
  mounts: Array<{ hostPath: string; innerPath: string; mode: MountMode }>;
  /** Writable scratch host path provided by the daemon's scratch service. */
  scratchHostPath: string;
  /** Network policy. */
  network: NetworkProfile;
  /** Seccomp policy. */
  seccomp: SeccompPolicy;
  /**
   * Optional precompiled BPF blob the driver can load via the
   * backend's seccomp facility (e.g. `bwrap --seccomp <fd>`).
   * Populated only when `seccomp` was `{ profile: <Buffer> }`; the
   * factory does not compile JSON profiles itself in Phase 1.
   */
  seccompProfile?: Uint8Array;
  /** Environment variables for the slice's `init` / first child. */
  env: Record<string, string>;
  /** Initial cwd inside the slice. */
  cwd?: string | undefined;
  /**
   * Resolved resource caps (defaults merged in by the factory).
   * Drivers translate this into `prlimit` argv before bwrap exec.
   */
  limits?: ResourceLimits;
  /**
   * Enforced deployment policy, passed through unvalidated: the driver
   * validates it, because only the driver can say what its backend can
   * actually enforce and read back.
   */
  policy?: SlicePolicyRequest;
};

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

/** Reader / writer references — Endo's existing stdio plumbing. */
export type ReaderRef = ERef<PassableBytesReader>;
export type WriterRef = ERef<PassableBytesWriter>;

/**
 * Per-spawn options passed to `SandboxHandle.spawn()`.
 */
export type SpawnOpts = {
  /** Per-spawn environment overrides, merged on top of the slice's env. */
  env?: Record<string, string>;
  /** Per-spawn cwd; falls back to the slice's cwd. */
  cwd?: string;
  /** Attach an existing reader as stdin. */
  stdin?: ReaderRef;
  /** Capture stdout as a `PassableBytesReader`. Defaults to true. */
  captureStdout?: boolean;
  /** Capture stderr as a separate `PassableBytesReader`. Defaults to true. */
  captureStderr?: boolean;
  /** Maximum stdout bytes before the whole process tree is terminated. */
  stdoutByteLimit?: bigint;
  /** Maximum stderr bytes before the whole process tree is terminated. */
  stderrByteLimit?: bigint;
  /** Maximum process runtime in milliseconds, capped at `0x7fffffff`. */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Capability shapes
// ---------------------------------------------------------------------------

/**
 * Root capability minted by the plugin's `make-unconfined` entry point.
 * Mints individual sandbox slices.
 */
export type SandboxFactory = FarRef<{
  /** Discoverability — describe the factory or one of its methods. */
  help(methodName?: string): string;
  /** Probe each registered driver and return the results. */
  listBackends(): Promise<BackendProbe[]>;
  /** Mint a new sandbox slice. */
  make(opts: SandboxMakeOpts): Promise<SandboxHandle>;
}>;

/**
 * A live sandbox slice. Pinned by the formula that minted it; when the
 * handle is dropped, every `ProcessHandle` it spawned is killed and every
 * `MountHandle` it minted is unmounted before the driver tears down the
 * underlying namespace / container.
 */
export type SandboxHandle = FarRef<{
  help(methodName?: string): string;
  /**
   * Spawn a process in the slice.
   * `spawn()` rejects for any timeout, disposal, or owner cancellation
   * initiated before it settles, including after driver admission resolves.
   * A resolved handle means the process was admitted and still owned by the
   * caller at settlement; failures initiated later surface through `wait()`.
   */
  spawn(argv: readonly string[], opts?: SpawnOpts): Promise<ProcessHandle>;
  /**
   * Report the slice's policy attestation. Rejects for a slice that was
   * not created under a policy — there is no "unenforced" attestation,
   * because a record saying nothing is enforced is one a caller can
   * mistake for one saying something is.
   */
  policy(): Promise<SlicePolicyAttestation>;
  mount(
    cap: MountCap,
    innerPath: string,
    mode?: MountMode,
  ): Promise<MountHandle>;
  /** Mint an ephemeral, slice-lifetime scratch mount at `innerPath`. */
  scratch(innerPath: string): Promise<MountHandle>;
  /** Open a single file inside the slice as a `ReadableFile`-shaped cap. */
  open(innerPath: string): Promise<ERef<unknown>>;
  /**
   * Mint a nested sub-slice. Phase 0–2 stubs return a structured
   * `notImplemented` error; Phase 3 lands the real implementation behind
   * a kernel-feature probe.
   */
  fork(opts?: SandboxMakeOpts): Promise<SandboxHandle>;
  /** Tear down processes and ephemeral scratch, keeping mounts. */
  reset(): Promise<void>;
  /** Full teardown — all processes killed, all mounts released. */
  dispose(): Promise<void>;
}>;

/**
 * Termination signals the process supervisor supports for
 * `ProcessHandle.kill()`. Every kill is terminal cancellation of the
 * whole process tree, so nonterminating values (a `0` liveness probe,
 * `SIGUSR1`, …) are rejected at the interface guard rather than being
 * silently escalated to `SIGKILL`.
 */
export type TerminationSignal =
  'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

/**
 * A process running inside a slice. Stdio uses Endo's existing
 * `reader-ref` / `writer-ref` plumbing — there is no JSON transcoding of
 * process bytes.
 */
export type ProcessHandle = FarRef<{
  help(methodName?: string): string;
  /** Pid as observed inside the slice's pid namespace. */
  pid(): number;
  /** Stdin writer (present only when the spawn kept stdin open). */
  stdin(): WriterRef;
  /** Stdout reader (present when `captureStdout` was true). */
  stdout(): ReaderRef;
  /** Stderr reader (present when `captureStderr` was true). */
  stderr(): ReaderRef;
  /** Resolves when the process exits. */
  wait(): Promise<{ code: number | null; signal: string | null }>;
  /**
   * Begin terminal cancellation of the process tree: deliver `signal`
   * (default `SIGTERM`), escalate to `SIGKILL` after a bounded grace
   * period, and settle once the process is reaped. Use `wait()` to
   * observe liveness rather than a `kill(0)` probe.
   */
  kill(signal?: TerminationSignal): Promise<void>;
}>;

/**
 * A mount bound into a slice. Holds the original `Mount` capability so
 * the inner path can be related back to the cap it came from.
 */
export type MountHandle = FarRef<{
  help(methodName?: string): string;
  /** Path inside the slice where the mount appears. */
  innerPath(): string;
  /** Back-reference to the original `Mount` capability. */
  cap(): MountCap;
  /** Effective mount mode (`ro` or `rw`). */
  mode(): MountMode;
  /** Detach the mount from the slice. */
  unmount(): Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Backend driver adapter
// ---------------------------------------------------------------------------

/**
 * Driver-side process handle returned by `SandboxDriver.spawn()`. The
 * factory wraps these in `reader-ref` / `writer-ref` adapters before
 * exposing them through `ProcessHandle`.
 */
export type DriverProcess = {
  pid: number;
  stdin?: AsyncIterable<Uint8Array> | null;
  stdout?: AsyncIterable<Uint8Array> | null;
  stderr?: AsyncIterable<Uint8Array> | null;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  /**
   * Deliver one signal to the whole driver-owned process group or
   * container. The supervisor owns the escalation ladder, so the same
   * narrow set of terminal signals it can issue is all a driver has to
   * accept.
   */
  kill(signal?: TerminationSignal): Promise<void>;
};

/**
 * Opaque per-slice context the driver returns from `prepareSlice`. The
 * factory passes it back to every subsequent driver call for the same
 * slice and finally to `teardown`.
 */
export type DriverSliceContext = unknown;

/**
 * Factory-supplied controls for a `SandboxDriver.spawn()` call.
 *
 * The `cancelled` token rejects when the factory abandons the admission
 * (process timeout, handle disposal, or owner cancellation) before the
 * driver has produced a controllable process; `isCancelled` observes the
 * same state synchronously. On cancellation the driver must cancel its
 * in-flight control command, remove the exact named/labelled operation it
 * was creating, and reject the spawn. The factory does not rely on the
 * driver honouring the token for its own liveness — a spawn that
 * resolves after abandonment is terminated and reaped — but an ignored
 * cancellation can leave the external control command running until the
 * driver's own command deadline fires.
 */
export type DriverSpawnControls = {
  cancelled?: import('@endo/cancel').Cancelled;
  isCancelled?: import('@endo/cancel').IsCancelled;
};

/**
 * Adapter the plugin loads at startup to translate `SandboxHandle`
 * operations into a particular runtime (bwrap, podman, lima, etc.).
 *
 * Drivers do **not** receive Endo capabilities directly: the factory
 * resolves each granted `Mount` to a host path and hands the driver
 * plain `{ hostPath, innerPath, mode }` triples in `SliceSpec`.
 */
export type SandboxDriver = {
  /** Stable name (matches `BackendName`). */
  name: BackendName;
  /** Best-effort availability check. */
  probe(): Promise<Omit<BackendProbe, 'name'>>;
  /** Materialise a slice from a fully-resolved `SliceSpec`. */
  prepareSlice(spec: SliceSpec): Promise<DriverSliceContext>;
  /**
   * Report the attestation minted while preparing the slice. Optional:
   * a driver whose backend cannot prove the controls omits it, and the
   * factory then rejects `policy()` rather than inventing a weaker
   * answer.
   */
  policy?(slice: DriverSliceContext): Promise<SlicePolicyAttestation>;
  /** Spawn a process inside a previously-prepared slice. */
  spawn(
    slice: DriverSliceContext,
    argv: string[],
    opts: SpawnOpts,
    controls?: DriverSpawnControls,
  ): Promise<DriverProcess>;
  /** Tear down the slice's namespace / container. */
  teardown(slice: DriverSliceContext): Promise<void>;
};

// ---------------------------------------------------------------------------
// Plugin powers
// ---------------------------------------------------------------------------

/**
 * Powers the `make-unconfined` entry point hands to `makeSandboxFactory`.
 *
 * Phase 0 only required `provideScratchMount`. Phase 1 adds
 * `provideHostPath`, the privileged operation that turns a `Mount`
 * capability into a host filesystem path so the driver can issue a
 * bind-mount.
 *
 * Cap-to-path resolution is the *only* privileged operation the factory
 * performs; drivers never see Endo capabilities directly. The daemon's
 * `EndoHost` exposes both `provideScratchMount` and `provideHostPath`,
 * so a caller invoking `endo run --UNCONFINED packages/sandbox/src/agent.js`
 * with `--powers @host` (the default for `make-unconfined`) gets the
 * full `SandboxPowers` surface for free — no per-caller stub is
 * required.  See `packages/daemon/src/host.js` `provideHostPath` for
 * the resolver implementation; it rejects any cap the daemon did not
 * mint as a top-level `mount` / `scratch-mount` formula.
 *
 * The factory deliberately does **not** receive the daemon's host-paths
 * power directly. All host-path access is mediated through `Mount`
 * capabilities the caller hands in, which `provideHostPath` then
 * resolves on the factory's behalf.
 *
 * Backend-agnostic factory tests (e.g. `test/bwrap.test.js`,
 * `test/podman.test.js`) still construct a stub `provideHostPath` that
 * maps stub Mount exos to real tmpdirs; those stubs are unit-test
 * fixtures that exercise the factory without standing up a full daemon.
 */
export type SandboxPowers = ERef<{
  /** Mint a writable scratch mount. */
  provideScratchMount(petName: string): Promise<MountCap>;
  /**
   * Resolve a `Mount` capability to a host filesystem path. The
   * factory calls this for every granted mount before assembling the
   * driver's `SliceSpec`.  Throws a structured error if the mount cap
   * does not name a directory the daemon can resolve.
   *
   * This is the privileged operation that bridges the Endo capability
   * graph and the kernel's bind-mount surface.  Drivers never call
   * this — only the factory does.
   */
  provideHostPath(cap: MountCap): Promise<string>;
}>;

/**
 * Inputs to the factory constructor.
 */
export type MakeSandboxFactoryInput = {
  /** Registered drivers (empty in Phase 0). */
  drivers: SandboxDriver[];
  /** Powers used to mint the writable scratch upper layer. */
  scratchProvider: SandboxPowers;
  /** Formula/daemon cancellation context that owns every minted handle. */
  context?: ERef<{ whenCancelled(): Promise<unknown> }>;
};
