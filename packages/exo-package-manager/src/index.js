// @ts-check

export {
  getPackageManagerFacetName,
  makePackageManager,
  makePackageManagerKit,
  isPackageManagerReadOnly,
} from './package-manager.js';

export {
  MANAGER_NAMES,
  MANAGER_MARKERS,
  FROZEN_LOCKFILES,
  parsePackageManagerField,
  managersFromMarkers,
  hasFrozenLockfile,
  selectManager,
} from './detect.js';

export { buildInstallArgv, buildRunArgv } from './argv.js';

export {
  PackageManagerReaderInterface,
  PackageManagerInstallerInterface,
  PackageManagerExecutorInterface,
  PackageManagerInterface,
  ReadOnlyPackageManagerInterface,
  ManagerNameShape,
  ManagerChoiceShape,
  LockfileModeShape,
  PackageWorkspaceInputShape,
  PackageInstallInputShape,
  PackageScriptRunInputShape,
  PackageCommandResultShape,
  PackageManagerDetectionShape,
  PackageScriptsShape,
} from './interfaces.js';
