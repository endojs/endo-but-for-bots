/**
 * Public and backend type surface for `@endo/exo-package-manager`.
 *
 * @module
 */

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn';
export type PackageManagerChoice = 'auto' | PackageManagerName;
export type PackageManagerFacetName = 'reader' | 'installer' | 'executor';
export type LockfileMode = 'frozen' | 'update';
export type PackageOperation = 'install' | 'run';
export type PackageTermination =
  'exit' | 'timeout' | 'cancelled' | 'output-limit';

export type PackageManagerCommand = {
  operation: PackageOperation;
  manager: PackageManagerName;
  /** Fixed manager arguments produced by the portable argv builders. */
  args: readonly string[];
};

export type PackageManagerEffectState = {
  manifestDigest?: string;
  lockfiles: Readonly<Record<string, string>>;
};

export type PackageManagerWorkspaceInspection<Target = unknown> = {
  snapshot: WorkspaceSnapshot;
  /** Opaque target selected by the workspace adapter for the runner. */
  target: Target;
  effectState: PackageManagerEffectState;
};

export type PackageManagerWorkspace<Target = unknown> = {
  inspectWorkspace: (
    input: InspectWorkspaceInput,
  ) => Promise<PackageManagerWorkspaceInspection<Target>>;
  /**
   * Reinspect the target immediately before runner execution.
   * The coordinator compares the returned snapshot with its expected value.
   */
  revalidateWorkspace: (
    input: InspectWorkspaceInput,
  ) => Promise<PackageManagerWorkspaceInspection<Target>>;
  readEffectState: (
    target: Target,
    manager: PackageManagerName,
  ) => Promise<PackageManagerEffectState>;
};

export type PackageManagerConfiguration =
  | {
      manager: 'npm' | 'pnpm';
      format: 'npmrc';
      /** Generated operation-scoped material, never a caller-selected path. */
      contents: Uint8Array;
    }
  | {
      manager: 'yarn';
      format: 'yarnrc-yml';
      /** Generated operation-scoped material, never a caller-selected path. */
      contents: Uint8Array;
    };

export type PackageManagerConfigurationProvider = (input: {
  manager: PackageManagerName;
  operation: PackageOperation;
}) => Promise<PackageManagerConfiguration | undefined>;

export type PackageManagerRunnerInput<Target = unknown> = {
  operation: PackageOperation;
  manager: PackageManagerName;
  versionRequest?: string;
  target: Target;
  command: PackageManagerCommand;
  configuration?: PackageManagerConfiguration;
  timeoutMs: number;
  maxOutputBytes: number;
  operationId?: string;
};

export type PackageManagerRunnerResult = {
  /** Present only when the runner established the selected exact version. */
  managerVersion?: string;
  exitCode: number | null;
  signal: string | null;
  termination: PackageTermination;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  cleanup: 'complete' | 'incomplete';
};

export type PackageManagerRunner<Target = unknown> = {
  run: (
    input: PackageManagerRunnerInput<Target>,
  ) => Promise<PackageManagerRunnerResult>;
  cancel: (operationId: string) => Promise<boolean>;
};

export type PackageManagerBackendCoordinatorOptions<Target = unknown> = {
  workspace: PackageManagerWorkspace<Target>;
  runner: PackageManagerRunner<Target>;
  configurationProvider?: PackageManagerConfigurationProvider;
  now?: () => number;
};

/**
 * Inert mount-relative selector accepted by public methods (platform
 * PathEntry or EndoMountEntry).
 */
export type PackagePathEntry = {
  segments: () => readonly string[] | Promise<readonly string[]>;
};

export type PackageWorkspaceInput = {
  cwd?: PackagePathEntry;
  manager?: PackageManagerChoice;
};

export type PackageInstallInput = PackageWorkspaceInput & {
  operationId?: string;
  lockfileMode?: LockfileMode;
  offline?: boolean;
  production?: boolean;
  timeoutMs?: number;
};

export type PackageScriptRunInput = PackageWorkspaceInput & {
  operationId?: string;
  script: string;
  args?: readonly string[];
  timeoutMs?: number;
};

export type PackageCommandResult = {
  ok: boolean;
  operation: PackageOperation;
  manager: PackageManagerName;
  managerVersion?: string;
  target: { displayPath: string; packageName?: string };
  command: {
    operation: PackageOperation;
    manager: PackageManagerName;
    args: readonly string[];
    redacted: boolean;
  };
  exitCode: number | null;
  signal: string | null;
  termination: PackageTermination;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  changed: {
    packageJson: boolean;
    lockfile: boolean;
    dependencyTree: boolean;
  };
};

export type PackageManagerDetection = {
  manager: PackageManagerName;
  source: 'explicit' | 'manifest' | 'marker' | 'default';
  markerManagers: readonly PackageManagerName[];
  markersPresent: readonly string[];
  displayPath: string;
  versionRequest?: string;
  packageName?: string;
  hasFrozenLockfile: boolean;
};

export type PackageScripts = {
  scriptNames: readonly string[];
  displayPath: string;
  manager: PackageManagerName;
  packageName?: string;
};

export type PackageManagerPolicy = {
  allowedManagers?: readonly PackageManagerName[];
  defaultManager?: PackageManagerName;
  allowLockfileUpdate?: boolean;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  allowCorepack?: boolean;
};

export type InstallArgvInput = {
  manager: PackageManagerName;
  lockfileMode?: LockfileMode;
  offline?: boolean;
  production?: boolean;
  /** Monorepo workspace selector, when installation targets a named workspace. */
  workspaceSelector?: string;
  /** Required for Yarn so lifecycle suppression selects known syntax. */
  yarnMajorVersion?: number;
  /** Required for Yarn 2; lifecycle suppression is supported from 2.4. */
  yarnMinorVersion?: number;
};

export type RunArgvInput = {
  manager: PackageManagerName;
  script: string;
  args?: readonly string[];
  workspaceSelector?: string;
};

export type SelectManagerInput = {
  /** Requested manager (`auto` or named). */
  explicit?: PackageManagerChoice;
  /** `package.json#packageManager`. */
  packageManagerField?: unknown;
  /** Marker filenames present at the effective project root. */
  markers?: Readonly<Record<string, boolean>> | readonly string[];
  /** Host policy allowlist. */
  allowedManagers?: readonly PackageManagerName[];
  /** Host policy default when no manager markers are present. */
  defaultManager?: PackageManagerName;
};

export type ManagerSelection = {
  manager: PackageManagerName;
  versionRequest?: string;
  source: 'explicit' | 'manifest' | 'marker' | 'default';
  markerManagers: readonly PackageManagerName[];
  markersPresent: readonly string[];
};

/**
 * Snapshot returned by the backend for pure selection / script listing.
 * Markers are filenames present at the effective project root.
 *
 * `packageName` is `package.json#name` (identity/metadata only).
 * `workspaceSelector` is a monorepo workspace filter for manager argv and
 * must only be set when a workspace package is targeted by name rather than
 * by package-relative cwd. It must not be filled from `packageName` alone —
 * spawn already runs with cwd at the selected package directory.
 */
export type WorkspaceSnapshot = {
  /**
   * Content token supplied by a coordinator workspace adapter for
   * revalidation.
   * Legacy backends may omit it because the portable protocol remains
   * structurally compatible, but coordinator adapters must supply it.
   */
  snapshotDigest?: string;
  packageManagerField?: string;
  markers: Readonly<Record<string, boolean>> | readonly string[];
  /** Omission means that the package declares no named scripts. */
  scriptNames?: readonly string[];
  /** package.json#name for display / audit metadata */
  packageName?: string;
  /**
   * Monorepo workspace selector for install/run argv only.
   * Undefined when targeting via package-relative cwd (the default path).
   */
  workspaceSelector?: string;
  yarnMajorVersion?: number;
  yarnMinorVersion?: number;
  displayPath?: string;
};

export type InspectWorkspaceInput = {
  segments: readonly string[];
  displayPath: string;
};

export type InstallBackendInput = {
  manager: PackageManagerName;
  versionRequest?: string;
  segments: readonly string[];
  displayPath: string;
  /** Snapshot the backend must atomically revalidate before executing. */
  expectedSnapshot: WorkspaceSnapshot;
  /** package.json#name for result metadata only (never an argv selector) */
  packageName?: string;
  /**
   * Monorepo workspace argv selector. Only set when targeting a workspace
   * package by name; omit when spawn cwd is already the package directory.
   */
  workspaceSelector?: string;
  yarnMajorVersion?: number;
  yarnMinorVersion?: number;
  lockfileMode: LockfileMode;
  offline: boolean;
  /** Safe installation always disables lifecycle execution. */
  lifecycleScripts: 'disabled';
  production: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Backend-private identifier, namespaced by the package-manager instance. */
  operationId?: string;
};

export type RunBackendInput = {
  manager: PackageManagerName;
  versionRequest?: string;
  segments: readonly string[];
  displayPath: string;
  /** Snapshot the backend must atomically revalidate before executing. */
  expectedSnapshot: WorkspaceSnapshot;
  /** package.json#name for result metadata only (never an argv selector) */
  packageName?: string;
  /**
   * Monorepo workspace argv selector. Only set when targeting a workspace
   * package by name; omit when spawn cwd is already the package directory.
   */
  workspaceSelector?: string;
  yarnMajorVersion?: number;
  yarnMinorVersion?: number;
  script: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Backend-private identifier, namespaced by the package-manager instance. */
  operationId?: string;
};

/**
 * Backend protocol injected into `makePackageManager`. Host and test backends
 * implement this contract. Before an install or run side effect, the backend
 * must atomically compare `expectedSnapshot` with the workspace metadata that
 * selects the manager, lockfile policy, and named script. A stale snapshot
 * must be rejected.
 */
export type PackageManagerBackend = {
  inspectWorkspace: (
    input: InspectWorkspaceInput,
  ) => Promise<WorkspaceSnapshot>;
  install: (input: InstallBackendInput) => Promise<PackageCommandResult>;
  run: (input: RunBackendInput) => Promise<PackageCommandResult>;
  cancel: (operationId: string) => Promise<boolean>;
};

export type ReadOnlyEndoPackageManager = {
  help: (method?: string) => string;
  detect: (input?: PackageWorkspaceInput) => Promise<PackageManagerDetection>;
  scripts: (input?: PackageWorkspaceInput) => Promise<PackageScripts>;
  readOnly: () => ReadOnlyEndoPackageManager;
  scope: (name: 'reader') => ReadOnlyEndoPackageManager;
};

/** Safe dependency hydration with lifecycle execution always disabled. */
export type InstallOnlyEndoPackageManager = ReadOnlyEndoPackageManager & {
  install: (input: PackageInstallInput) => Promise<PackageCommandResult>;
  cancel: (operationId: string) => Promise<boolean>;
  readOnly: () => ReadOnlyEndoPackageManager;
  scope: (
    name: 'reader' | 'installer',
  ) => ReadOnlyEndoPackageManager | InstallOnlyEndoPackageManager;
};

/** Separately granted authority to execute declared project code. */
export type ProjectExecutionEndoPackageManager =
  InstallOnlyEndoPackageManager & {
    run: (input: PackageScriptRunInput) => Promise<PackageCommandResult>;
    scope: (name: PackageManagerFacetName) => PackageManagerFacet;
  };

/** Compatibility name for the full project-execution capability. */
export type EndoPackageManager = ProjectExecutionEndoPackageManager;

export type PackageManagerFacet =
  | ReadOnlyEndoPackageManager
  | InstallOnlyEndoPackageManager
  | ProjectExecutionEndoPackageManager;

export type PackageManagerKit = {
  reader: ReadOnlyEndoPackageManager;
  installer: InstallOnlyEndoPackageManager;
  executor: ProjectExecutionEndoPackageManager;
};

export type PackageManagerMakeReaderOptions = {
  facet: 'reader';
};

export type PackageManagerMakeInstallerOptions = {
  facet: 'installer';
};

export type PackageManagerMakeExecutorOptions = {
  facet?: 'executor';
};

export type PackageManagerMakeOptions = {
  facet?: PackageManagerFacetName;
};
