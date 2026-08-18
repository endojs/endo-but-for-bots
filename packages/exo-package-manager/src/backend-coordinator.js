// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';

import { buildInstallArgv, buildRunArgv } from './argv.js';
import { hasFrozenLockfile, selectManager } from './detect.js';
import { makePackageManagerError } from './errors.js';

/** @import {
 *   InstallBackendInput,
 *   PackageCommandResult,
 *   PackageManagerBackend,
 *   PackageManagerBackendCoordinatorOptions,
 *   PackageManagerConfiguration,
 *   PackageManagerConfigurationProvider,
 *   PackageManagerEffectState,
 *   PackageManagerName,
 *   PackageManagerRunnerResult,
 *   PackageManagerWorkspaceInspection,
 *   RunBackendInput,
 *   WorkspaceSnapshot,
 * } from './types.js' */

/** @type {PackageManagerConfigurationProvider} */
const noConfiguration = async () => undefined;

/**
 * @param {Readonly<Record<string, boolean>> | readonly string[]} markers
 * @returns {readonly string[]}
 */
const markerNamesOf = markers =>
  (Array.isArray(markers)
    ? [...markers]
    : Object.entries(markers)
        .filter(([, present]) => present)
        .map(([name]) => name)
  ).sort();

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 */
const sameStringArray = (left, right) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * @param {Readonly<Record<string, string>>} left
 * @param {Readonly<Record<string, string>>} right
 */
const sameStringRecord = (left, right) => {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([name, digest], index) =>
        name === rightEntries[index]?.[0] &&
        digest === rightEntries[index]?.[1],
    )
  );
};

/**
 * Compare only portable metadata and the adapter-supplied content token.
 * Host paths and other adapter details never enter this comparison.
 *
 * @param {WorkspaceSnapshot} expected
 * @param {WorkspaceSnapshot} actual
 */
const sameSnapshot = (expected, actual) => {
  const expectedScripts = [...(expected.scriptNames || [])].sort();
  const actualScripts = [...(actual.scriptNames || [])].sort();
  return (
    typeof expected.snapshotDigest === 'string' &&
    typeof actual.snapshotDigest === 'string' &&
    expected.snapshotDigest === actual.snapshotDigest &&
    expected.packageManagerField === actual.packageManagerField &&
    expected.packageName === actual.packageName &&
    expected.workspaceSelector === actual.workspaceSelector &&
    expected.yarnMajorVersion === actual.yarnMajorVersion &&
    expected.yarnMinorVersion === actual.yarnMinorVersion &&
    expected.displayPath === actual.displayPath &&
    sameStringArray(
      markerNamesOf(expected.markers),
      markerNamesOf(actual.markers),
    ) &&
    sameStringArray(expectedScripts, actualScripts)
  );
};

/**
 * @param {unknown} value
 * @param {PackageManagerName} manager
 * @returns {value is PackageManagerConfiguration}
 */
const isConfigurationFor = (value, manager) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const configuration = /** @type {{
    manager?: unknown;
    format?: unknown;
    contents?: unknown;
  }} */ (value);
  if (
    configuration.manager !== manager ||
    !(configuration.contents instanceof Uint8Array)
  ) {
    return false;
  }
  return manager === 'yarn'
    ? configuration.format === 'yarnrc-yml'
    : configuration.format === 'npmrc';
};

/**
 * @param {PackageManagerEffectState} before
 * @param {PackageManagerEffectState} after
 * @param {'install' | 'run'} operation
 * @param {PackageManagerRunnerResult | undefined} processResult
 */
const changedState = (before, after, operation, processResult) =>
  harden({
    packageJson: before.manifestDigest !== after.manifestDigest,
    lockfile: !sameStringRecord(before.lockfiles, after.lockfiles),
    dependencyTree: operation === 'install' && processResult !== undefined,
  });

/**
 * @param {object} input
 * @param {'install' | 'run'} input.operation
 * @param {PackageManagerName} input.manager
 * @param {string} input.displayPath
 * @param {string | undefined} input.packageName
 * @param {readonly string[]} input.argv
 * @param {PackageManagerRunnerResult | undefined} input.processResult
 * @param {PackageManagerEffectState} input.before
 * @param {PackageManagerEffectState} input.after
 * @param {number} input.durationMs
 * @returns {PackageCommandResult}
 */
const makeResult = ({
  operation,
  manager,
  displayPath,
  packageName,
  argv,
  processResult,
  before,
  after,
  durationMs,
}) =>
  harden({
    ok:
      processResult !== undefined &&
      processResult.termination === 'exit' &&
      processResult.exitCode === 0,
    operation,
    manager,
    ...(processResult?.managerVersion === undefined
      ? {}
      : { managerVersion: processResult.managerVersion }),
    target: harden({
      displayPath,
      ...(packageName === undefined ? {} : { packageName }),
    }),
    command: harden({
      operation,
      manager,
      args: argv,
      redacted: false,
    }),
    exitCode: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    termination: processResult?.termination ?? 'cancelled',
    durationMs,
    stdout: processResult?.stdout ?? '',
    stderr: processResult?.stderr ?? '',
    truncated: harden({
      stdout: processResult?.truncated.stdout ?? false,
      stderr: processResult?.truncated.stderr ?? false,
    }),
    changed: changedState(before, after, operation, processResult),
  });

/**
 * Construct the backend-independent package-manager operation coordinator.
 *
 * The workspace adapter owns selection and revalidation of a target, while
 * the runner owns manager resolution and process lifecycle. This layer owns
 * the fixed argv policy, configuration hand-off, operation bounds, and
 * structured results shared by trusted and confined runners.
 *
 * @template Target
 * @param {PackageManagerBackendCoordinatorOptions<Target>} options
 * @returns {PackageManagerBackend}
 */
export const makePackageManagerBackendCoordinator = options => {
  if (options === null || typeof options !== 'object') {
    throw makeError(X`backend coordinator options must be a record`);
  }
  const { workspace, runner } = options;
  if (workspace === undefined || runner === undefined) {
    throw makeError(X`backend coordinator requires workspace and runner`);
  }
  const configurationProvider =
    options.configurationProvider || noConfiguration;
  const now = options.now || Date.now;

  /** @type {Map<string, { cancelled: boolean; started: boolean }>} */
  const operations = new Map();

  /**
   * @param {string | undefined} operationId
   */
  const claimOperation = operationId => {
    if (operationId === undefined) return undefined;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw makePackageManagerError(
        'policy-denied',
        'operationId must be a non-empty string',
      );
    }
    if (operations.has(operationId)) {
      throw makePackageManagerError(
        'policy-denied',
        `operationId ${q(operationId)} is already active`,
      );
    }
    const operation = { cancelled: false, started: false };
    operations.set(operationId, operation);
    return operation;
  };

  /**
   * @param {string | undefined} operationId
   */
  const releaseOperation = operationId => {
    if (operationId !== undefined) operations.delete(operationId);
  };

  /**
   * @param {object | undefined} operation
   */
  const assertNotCancelled = operation => {
    if (operation?.cancelled) {
      throw makePackageManagerError(
        'operation-cancelled',
        'operation was cancelled before backend execution',
      );
    }
  };

  /**
   * @param {InstallBackendInput | RunBackendInput} input
   * @param {'install' | 'run'} operationName
   * @returns {Promise<PackageCommandResult>}
   */
  const execute = async (input, operationName) => {
    const operation = claimOperation(input.operationId);
    const startedAt = now();
    await null;
    /** @type {readonly string[]} */
    let argv;
    try {
      if (operationName === 'install') {
        const installInput = /** @type {InstallBackendInput} */ (input);
        if (installInput.lifecycleScripts !== 'disabled') {
          throw makePackageManagerError(
            'policy-denied',
            'package-manager installs must disable lifecycle scripts',
          );
        }
        if (
          installInput.lockfileMode === 'frozen' &&
          !hasFrozenLockfile(
            installInput.manager,
            installInput.expectedSnapshot.markers,
          )
        ) {
          throw makePackageManagerError(
            'lockfile-missing',
            `frozen install requires a ${installInput.manager} lockfile`,
          );
        }
        argv = buildInstallArgv({
          manager: installInput.manager,
          lockfileMode: installInput.lockfileMode,
          offline: installInput.offline,
          production: installInput.production,
          workspaceSelector: installInput.workspaceSelector,
          yarnMajorVersion: installInput.yarnMajorVersion,
          yarnMinorVersion: installInput.yarnMinorVersion,
        });
      } else {
        const runInput = /** @type {RunBackendInput} */ (input);
        argv = buildRunArgv({
          manager: runInput.manager,
          script: runInput.script,
          args: runInput.args,
          workspaceSelector: runInput.workspaceSelector,
        });
      }

      assertNotCancelled(operation);
      /** @type {PackageManagerConfiguration | undefined} */
      let configuration;
      try {
        configuration = await configurationProvider({
          manager: input.manager,
          operation: operationName,
        });
      } catch {
        throw makePackageManagerError(
          'manager-unavailable',
          'package-manager configuration could not be provided',
        );
      }
      if (
        configuration !== undefined &&
        !isConfigurationFor(configuration, input.manager)
      ) {
        throw makePackageManagerError(
          'policy-denied',
          'package-manager configuration does not match the selected manager',
        );
      }

      // This is the final coordinator operation before runner execution.
      // Adapters must reread their selected root and content token here.
      const current = await workspace.revalidateWorkspace({
        segments: input.segments,
        displayPath: input.displayPath,
      });
      if (!sameSnapshot(input.expectedSnapshot, current.snapshot)) {
        throw makePackageManagerError(
          'workspace-invalid',
          'workspace snapshot changed before package-manager execution',
        );
      }
      const selected = selectManager({
        explicit: input.manager,
        packageManagerField: current.snapshot.packageManagerField,
        markers: current.snapshot.markers,
      });
      if (
        selected.manager !== input.manager ||
        selected.versionRequest !== input.versionRequest
      ) {
        throw makePackageManagerError(
          'manager-mismatch',
          'selected manager changed before package-manager execution',
        );
      }
      if (operationName === 'run') {
        const runInput = /** @type {RunBackendInput} */ (input);
        if (!(current.snapshot.scriptNames || []).includes(runInput.script)) {
          throw makePackageManagerError(
            'script-not-declared',
            `script ${q(runInput.script)} is no longer declared`,
          );
        }
      }

      if (operation?.cancelled) {
        return makeResult({
          operation: operationName,
          manager: input.manager,
          displayPath: input.displayPath,
          packageName: input.packageName,
          argv,
          processResult: undefined,
          before: current.effectState,
          after: current.effectState,
          durationMs: Math.max(0, now() - startedAt),
        });
      }

      if (operation !== undefined) operation.started = true;
      const processResult = await runner.run({
        operation: operationName,
        manager: input.manager,
        versionRequest: input.versionRequest,
        target: current.target,
        command: harden({
          operation: operationName,
          manager: input.manager,
          args: argv.slice(1),
        }),
        ...(configuration === undefined ? {} : { configuration }),
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        operationId: input.operationId,
      });
      if (processResult.cleanup !== 'complete') {
        throw makePackageManagerError(
          'manager-unavailable',
          'package-manager runner did not confirm cleanup',
        );
      }
      if (
        input.versionRequest !== undefined &&
        processResult.managerVersion !== input.versionRequest
      ) {
        throw makePackageManagerError(
          'manager-unavailable',
          `runner did not establish requested ${input.manager} version`,
        );
      }
      const after = await workspace.readEffectState(
        current.target,
        input.manager,
      );
      return makeResult({
        operation: operationName,
        manager: input.manager,
        displayPath: input.displayPath,
        packageName: input.packageName,
        argv,
        processResult,
        before: current.effectState,
        after,
        durationMs: Math.max(0, now() - startedAt),
      });
    } finally {
      releaseOperation(input.operationId);
    }
  };

  const backend = {
    async inspectWorkspace(input) {
      const inspection = await workspace.inspectWorkspace(input);
      return inspection.snapshot;
    },
    async install(input) {
      return execute(input, 'install');
    },
    async run(input) {
      return execute(input, 'run');
    },
    async cancel(operationId) {
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw makeError(X`cancel requires a non-empty operationId`);
      }
      const operation = operations.get(operationId);
      if (operation === undefined) return false;
      operation.cancelled = true;
      if (!operation.started) return true;
      return runner.cancel(operationId);
    },
  };
  return harden(backend);
};
harden(makePackageManagerBackendCoordinator);
