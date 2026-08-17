// @ts-check

import { M } from '@endo/patterns';

// #region Shape primitives

const ManagerNameShape = M.or('npm', 'pnpm', 'yarn');
const ManagerChoiceShape = M.or('auto', ManagerNameShape);
const LockfileModeShape = M.or('frozen', 'update');
const TerminationShape = M.or('exit', 'timeout', 'cancelled', 'output-limit');
const OperationShape = M.or('install', 'run');

const PathEntryShape = M.remotable('EndoMountEntry');

const PackageWorkspaceInputShape = M.splitRecord(
  {},
  {
    cwd: PathEntryShape,
    manager: ManagerChoiceShape,
  },
  harden({}),
);
harden(PackageWorkspaceInputShape);

const PackageInstallInputShape = M.splitRecord(
  {},
  {
    cwd: PathEntryShape,
    manager: ManagerChoiceShape,
    operationId: M.string(),
    lockfileMode: LockfileModeShape,
    offline: M.boolean(),
    production: M.boolean(),
    timeoutMs: M.number(),
  },
  harden({}),
);
harden(PackageInstallInputShape);

const PackageScriptRunInputShape = M.splitRecord(
  {
    script: M.string(),
  },
  {
    cwd: PathEntryShape,
    manager: ManagerChoiceShape,
    operationId: M.string(),
    args: M.arrayOf(M.string()),
    timeoutMs: M.number(),
  },
  harden({}),
);
harden(PackageScriptRunInputShape);

const PackageCommandResultShape = M.splitRecord(
  {
    ok: M.boolean(),
    operation: OperationShape,
    manager: ManagerNameShape,
    target: M.splitRecord(
      { displayPath: M.string() },
      { packageName: M.string() },
    ),
    command: M.splitRecord({
      operation: OperationShape,
      manager: ManagerNameShape,
      args: M.arrayOf(M.string()),
      redacted: M.boolean(),
    }),
    exitCode: M.or(M.number(), M.null()),
    signal: M.or(M.string(), M.null()),
    termination: TerminationShape,
    durationMs: M.number(),
    stdout: M.string(),
    stderr: M.string(),
    truncated: M.splitRecord({
      stdout: M.boolean(),
      stderr: M.boolean(),
    }),
    changed: M.splitRecord({
      packageJson: M.boolean(),
      lockfile: M.boolean(),
      dependencyTree: M.boolean(),
    }),
  },
  {
    managerVersion: M.string(),
  },
);
harden(PackageCommandResultShape);

const PackageManagerDetectionShape = M.splitRecord(
  {
    manager: ManagerNameShape,
    source: M.or('explicit', 'manifest', 'marker', 'default'),
    markerManagers: M.arrayOf(ManagerNameShape),
    markersPresent: M.arrayOf(M.string()),
    displayPath: M.string(),
    hasFrozenLockfile: M.boolean(),
  },
  {
    versionRequest: M.string(),
    packageName: M.string(),
  },
);
harden(PackageManagerDetectionShape);

const PackageScriptsShape = M.splitRecord(
  {
    scriptNames: M.arrayOf(M.string()),
    displayPath: M.string(),
    manager: ManagerNameShape,
  },
  {
    packageName: M.string(),
  },
);
harden(PackageScriptsShape);

// #endregion

/**
 * Guarded public `EndoPackageManager` surface.
 *
 * Methods whose resolved values need a return guard use `callWhen`.
 */
const PACKAGE_MANAGER_METHOD_GUARDS = harden({
  help: M.call().optional(M.string()).returns(M.string()),
  detect: M.callWhen()
    .optional(PackageWorkspaceInputShape)
    .returns(PackageManagerDetectionShape),
  scripts: M.callWhen()
    .optional(PackageWorkspaceInputShape)
    .returns(PackageScriptsShape),
  install: M.callWhen(PackageInstallInputShape).returns(
    PackageCommandResultShape,
  ),
  run: M.callWhen(PackageScriptRunInputShape).returns(
    PackageCommandResultShape,
  ),
  cancel: M.callWhen(M.string()).returns(M.boolean()),
  readOnly: M.call().returns(M.remotable('PackageManagerReader')),
  scopeReader: M.call('reader').returns(M.remotable('PackageManagerReader')),
  scopeInstaller: M.call(M.or('reader', 'installer')).returns(M.remotable()),
  scopeExecutor: M.call(M.or('reader', 'installer', 'executor')).returns(
    M.remotable(),
  ),
});

const READER_METHOD_GUARDS = harden({
  detect: PACKAGE_MANAGER_METHOD_GUARDS.detect,
  help: PACKAGE_MANAGER_METHOD_GUARDS.help,
  readOnly: PACKAGE_MANAGER_METHOD_GUARDS.readOnly,
  scope: PACKAGE_MANAGER_METHOD_GUARDS.scopeReader,
  scripts: PACKAGE_MANAGER_METHOD_GUARDS.scripts,
});

const INSTALLER_METHOD_GUARDS = harden({
  ...READER_METHOD_GUARDS,
  cancel: PACKAGE_MANAGER_METHOD_GUARDS.cancel,
  install: PACKAGE_MANAGER_METHOD_GUARDS.install,
  scope: PACKAGE_MANAGER_METHOD_GUARDS.scopeInstaller,
});

const EXECUTOR_METHOD_GUARDS = harden({
  ...INSTALLER_METHOD_GUARDS,
  run: PACKAGE_MANAGER_METHOD_GUARDS.run,
  scope: PACKAGE_MANAGER_METHOD_GUARDS.scopeExecutor,
});

export const PackageManagerReaderInterface = M.interface(
  'PackageManagerReader',
  READER_METHOD_GUARDS,
);
harden(PackageManagerReaderInterface);

export const PackageManagerInstallerInterface = M.interface(
  'PackageManagerInstaller',
  INSTALLER_METHOD_GUARDS,
);
harden(PackageManagerInstallerInterface);

export const PackageManagerExecutorInterface = M.interface(
  'PackageManagerExecutor',
  EXECUTOR_METHOD_GUARDS,
);
harden(PackageManagerExecutorInterface);

/** @deprecated Use `PackageManagerReaderInterface`. */
export const ReadOnlyPackageManagerInterface = M.interface(
  'ReadOnlyPackageManager',
  READER_METHOD_GUARDS,
);
harden(ReadOnlyPackageManagerInterface);

/** Compatibility interface for the full executor method set. */
export const PackageManagerInterface = M.interface(
  'PackageManager',
  EXECUTOR_METHOD_GUARDS,
);
harden(PackageManagerInterface);

export {
  ManagerNameShape,
  ManagerChoiceShape,
  LockfileModeShape,
  PackageWorkspaceInputShape,
  PackageInstallInputShape,
  PackageScriptRunInputShape,
  PackageCommandResultShape,
  PackageManagerDetectionShape,
  PackageScriptsShape,
};
