// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { hasFrozenLockfile, selectManager } from './detect.js';
import { makePackageManagerError } from './errors.js';
import {
  PackageManagerExecutorInterface,
  PackageManagerInstallerInterface,
  PackageManagerReaderInterface,
} from './interfaces.js';

/**
 * @import {
 *   InstallOnlyEndoPackageManager,
 *   PackageManagerFacet,
 *   PackageManagerFacetName,
 *   PackageManagerKit,
 *   PackageManagerMakeExecutorOptions,
 *   PackageManagerMakeInstallerOptions,
 *   PackageManagerMakeOptions,
 *   PackageManagerMakeReaderOptions,
 *   ProjectExecutionEndoPackageManager,
 *   ReadOnlyEndoPackageManager,
 *   PackageCommandResult,
 *   PackageInstallInput,
 *   PackageManagerDetection,
 *   PackageManagerPolicy,
 *   PackageScripts,
 *   PackageScriptRunInput,
 *   PackageWorkspaceInput,
 *   PackageManagerBackend,
 * } from './types.js'
 */

/** @type {WeakMap<object, PackageManagerFacetName>} */
const packageManagerFacets = new WeakMap();

let nextOperationNamespace = 1n;

/**
 * Return the facet name for a PackageManager minted in this realm.
 * Foreign remotables and non-PackageManager values fail closed to undefined.
 *
 * @param {unknown} pm
 * @returns {PackageManagerFacetName | undefined}
 */
export const getPackageManagerFacetName = pm =>
  typeof pm === 'object' && pm !== null
    ? packageManagerFacets.get(pm)
    : undefined;
harden(getPackageManagerFacetName);

/**
 * Host-private accessor: whether a minted package-manager exo is read-only.
 *
 * @param {unknown} pm
 * @returns {boolean | undefined}
 */
export const isPackageManagerReadOnly = pm => {
  const facet = getPackageManagerFacetName(pm);
  return facet === undefined ? undefined : facet === 'reader';
};
harden(isPackageManagerReadOnly);

const READER_HELP_TEXT = harden({
  '':
    'EndoPackageManager reader facet: portable npm/pnpm/yarn metadata and ' +
    'declared-script inspection.',
  help: 'help(method?): short description of the capability or a named method.',
  detect:
    'detect(input?): select npm/pnpm/yarn from explicit choice, packageManager field, manager markers, and policy without spawning.',
  scripts:
    'scripts(input?): list declared package.json script names for the selected package target.',
  readOnly: 'readOnly(): return this reader facet.',
  scope: 'scope("reader"): return this reader facet.',
});

const INSTALLER_HELP_TEXT = harden({
  ...READER_HELP_TEXT,
  '':
    'EndoPackageManager installer facet: portable npm/pnpm/yarn metadata and ' +
    'safe dependency installation.',
  install:
    'install(input): hydrate declared dependencies with fixed manager argv and lifecycle execution disabled.',
  cancel: 'cancel(operationId): request cancellation of an in-flight install.',
  readOnly: 'readOnly(): attenuate to the reader facet.',
  scope:
    'scope(name): select the reader or installer facet from this capability.',
});

const EXECUTOR_HELP_TEXT = harden({
  ...INSTALLER_HELP_TEXT,
  '':
    'EndoPackageManager executor facet: portable npm/pnpm/yarn metadata, safe ' +
    'dependency installation, and separately granted named-script execution.',
  run: 'run(input): run a declared package.json script with fixed manager argv. Not a general shell.',
  cancel:
    'cancel(operationId): request cancellation of an in-flight install or run.',
  scope:
    'scope(name): select the reader, installer, or executor facet from this capability.',
});

const HELP_TEXT_BY_FACET = harden({
  reader: READER_HELP_TEXT,
  installer: INSTALLER_HELP_TEXT,
  executor: EXECUTOR_HELP_TEXT,
});

/**
 * @param {PackageManagerFacetName} facet
 * @param {string} [method]
 * @returns {string}
 */
const helpFor = (facet, method) => {
  const helpText = HELP_TEXT_BY_FACET[facet];
  if (method === undefined || method === '') {
    return helpText[''];
  }
  if (Object.hasOwn(helpText, method)) {
    return helpText[method];
  }
  if (Object.hasOwn(EXECUTOR_HELP_TEXT, method)) {
    return `Method ${method} is not available on the ${facet} facet`;
  }
  return `Unknown method ${method}`;
};

/**
 * @param {number | undefined} requested
 * @param {number} defaultValue
 * @param {number} maximum
 * @returns {number}
 */
const effectiveTimeout = (requested, defaultValue, maximum) => {
  if (requested === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    throw makePackageManagerError(
      'policy-denied',
      'timeoutMs must be a positive finite number',
      { timeoutMs: requested },
    );
  }
  return Math.min(maximum, requested);
};

/**
 * @param {readonly string[]} args
 */
const assertDenseStringArray = args => {
  if (!Array.isArray(args)) {
    throw makePackageManagerError(
      'policy-denied',
      'args must be an array of strings',
    );
  }
  for (let index = 0; index < args.length; index += 1) {
    if (typeof args[index] !== 'string') {
      throw makePackageManagerError(
        'policy-denied',
        'args must be a dense array of strings',
      );
    }
  }
};

/**
 * Resolve a workspace cwd entry to mount-relative segments after lineage check.
 *
 * @param {object} powers
 * @param {object} powers.mount
 * @param {(value: unknown) => object | undefined} powers.lineageOf
 * @param {object | undefined} [cwd]
 * @returns {Promise<{ segments: string[], displayPath: string }>}
 */
const resolveCwd = async ({ mount, lineageOf }, cwd) => {
  const mountLineage = lineageOf(mount);
  if (cwd === undefined) {
    return { segments: [], displayPath: '.' };
  }
  const otherLineage = lineageOf(cwd);
  if (otherLineage === undefined) {
    throw makePackageManagerError(
      'workspace-invalid',
      'cwd is not an EndoMountEntry minted by this daemon',
    );
  }
  if (otherLineage !== mountLineage) {
    throw makePackageManagerError(
      'workspace-invalid',
      'cwd was minted by a different mount lineage',
    );
  }
  const segments = await E(cwd).segments();
  if (!Array.isArray(segments)) {
    throw makePackageManagerError(
      'workspace-invalid',
      'cwd.segments() did not return an array',
    );
  }
  /** @type {string[]} */
  const validated = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (typeof segment !== 'string') {
      throw makePackageManagerError(
        'workspace-invalid',
        `cwd segment ${index} must be a string`,
      );
    }
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      throw makePackageManagerError(
        'workspace-invalid',
        `cwd segment ${q(segment)} must be a single non-traversing name`,
      );
    }
    validated.push(segment);
  }
  return {
    segments: validated,
    displayPath: validated.length === 0 ? '.' : validated.join('/'),
  };
};

/**
 * Construct the three cumulative PackageManager capability facets.
 *
 * The portable package does not import process APIs or start commands. Those
 * effects live behind the injected backend.
 *
 * @param {object} args
 * @param {object} args.mount Workspace mount carrying path authority.
 * @param {PackageManagerBackend} args.backend
 * @param {PackageManagerPolicy} [args.policy]
 * @param {(value: unknown) => object | undefined} args.lineageOf
 * @returns {PackageManagerKit}
 */
export const makePackageManagerKit = ({
  mount,
  backend,
  policy = harden({}),
  lineageOf,
}) => {
  if (typeof lineageOf !== 'function') {
    throw makeError(X`makePackageManager requires lineageOf`);
  }
  if (backend === undefined || backend === null) {
    throw makeError(X`makePackageManager requires a backend`);
  }
  if (mount === undefined || mount === null) {
    throw makeError(X`makePackageManager requires a mount`);
  }

  const {
    allowedManagers,
    defaultManager,
    allowLockfileUpdate = false,
    defaultTimeoutMs: configuredDefaultTimeoutMs,
    maxTimeoutMs = 600_000,
    maxOutputBytes = 1_048_576,
    allowCorepack = false,
  } = policy;

  const defaultTimeoutMs = configuredDefaultTimeoutMs ?? maxTimeoutMs;

  if (!Number.isFinite(maxTimeoutMs) || maxTimeoutMs <= 0) {
    throw makeError(
      X`makePackageManager: policy.maxTimeoutMs must be positive and finite`,
    );
  }
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw makeError(
      X`makePackageManager: policy.defaultTimeoutMs must be positive and finite`,
    );
  }
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw makeError(
      X`makePackageManager: policy.defaultTimeoutMs must not exceed policy.maxTimeoutMs`,
    );
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw makeError(
      X`makePackageManager: policy.maxOutputBytes must be a positive integer`,
    );
  }

  const operationNamespace = `pm-${nextOperationNamespace}`;
  nextOperationNamespace += 1n;

  /**
   * @typedef {object} OperationState
   * @property {string} backendOperationId
   * @property {boolean} cancelled
   * @property {boolean} started
   */

  /** @type {Map<string, OperationState>} */
  const operations = new Map();

  /**
   * @param {string | undefined} operationId
   * @returns {OperationState | undefined}
   */
  const claimOperation = operationId => {
    if (operationId === undefined) {
      return undefined;
    }
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
    const operation = {
      backendOperationId: `${operationNamespace}:${operationId}`,
      cancelled: false,
      started: false,
    };
    operations.set(operationId, operation);
    return operation;
  };

  /**
   * @param {string | undefined} operationId
   */
  const releaseOperation = operationId => {
    if (operationId !== undefined) {
      operations.delete(operationId);
    }
  };

  /**
   * @param {OperationState | undefined} operation
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
   * @param {string | undefined} versionRequest
   */
  const assertVersionRequestAllowed = versionRequest => {
    if (versionRequest !== undefined && !allowCorepack) {
      throw makePackageManagerError(
        'policy-denied',
        `packageManager version ${q(versionRequest)} requires allowCorepack`,
      );
    }
  };

  /**
   * @param {PackageWorkspaceInput} [input]
   */
  const resolveSelection = async (input = {}) => {
    const { cwd, manager: explicit = 'auto' } = input;
    const { segments, displayPath } = await resolveCwd(
      { mount, lineageOf },
      cwd,
    );
    const snapshot = await backend.inspectWorkspace(
      harden({
        segments,
        displayPath,
      }),
    );
    if (snapshot === undefined || snapshot === null) {
      throw makePackageManagerError(
        'workspace-invalid',
        `workspace at ${displayPath} is not a usable package directory`,
      );
    }
    const selection = selectManager({
      explicit,
      packageManagerField: snapshot.packageManagerField,
      markers: snapshot.markers,
      allowedManagers,
      defaultManager,
    });
    return harden({
      selection,
      snapshot,
      segments,
      displayPath,
    });
  };

  const methods = {
    /**
     * @param {PackageWorkspaceInput} [input]
     * @returns {Promise<PackageManagerDetection>}
     */
    async detect(input = {}) {
      const { selection, snapshot, displayPath } =
        await resolveSelection(input);
      return harden({
        manager: selection.manager,
        source: selection.source,
        markerManagers: selection.markerManagers,
        markersPresent: selection.markersPresent,
        displayPath,
        ...(selection.versionRequest !== undefined
          ? { versionRequest: selection.versionRequest }
          : {}),
        // package.json#name is identity metadata, not a monorepo selector.
        ...(snapshot.packageName !== undefined
          ? { packageName: snapshot.packageName }
          : {}),
        hasFrozenLockfile: hasFrozenLockfile(
          selection.manager,
          snapshot.markers,
        ),
      });
    },

    /**
     * @param {PackageWorkspaceInput} [input]
     * @returns {Promise<PackageScripts>}
     */
    async scripts(input = {}) {
      const { selection, snapshot, displayPath } =
        await resolveSelection(input);
      const scriptNames = Array.isArray(snapshot.scriptNames)
        ? [...snapshot.scriptNames]
        : [];
      return harden({
        scriptNames,
        displayPath,
        manager: selection.manager,
        // package.json#name is identity metadata, not a monorepo selector.
        ...(snapshot.packageName !== undefined
          ? { packageName: snapshot.packageName }
          : {}),
      });
    },

    /**
     * @param {PackageInstallInput} input
     * @returns {Promise<PackageCommandResult>}
     */
    async install(input = {}) {
      const {
        lockfileMode = 'frozen',
        offline = false,
        production = false,
        timeoutMs,
        operationId,
        ...workspaceInput
      } = input;

      const operation = claimOperation(operationId);
      await null;
      try {
        assertNotCancelled(operation);
        if (lockfileMode === 'update' && !allowLockfileUpdate) {
          throw makePackageManagerError(
            'policy-denied',
            'lockfileMode update is not permitted by host policy',
          );
        }
        const { selection, snapshot, segments, displayPath } =
          await resolveSelection(workspaceInput);
        assertNotCancelled(operation);
        assertVersionRequestAllowed(selection.versionRequest);

        if (
          lockfileMode === 'frozen' &&
          !hasFrozenLockfile(selection.manager, snapshot.markers)
        ) {
          throw makePackageManagerError(
            'lockfile-missing',
            `frozen install requires a lockfile for ${selection.manager}`,
            {
              manager: selection.manager,
              markersPresent: selection.markersPresent,
            },
          );
        }

        const effectiveTimeoutMs = effectiveTimeout(
          timeoutMs,
          defaultTimeoutMs,
          maxTimeoutMs,
        );
        assertNotCancelled(operation);
        if (operation !== undefined) {
          operation.started = true;
        }
        return await backend.install(
          harden({
            manager: selection.manager,
            versionRequest: selection.versionRequest,
            segments,
            displayPath,
            expectedSnapshot: snapshot,
            packageName: snapshot.packageName,
            // Only a true monorepo selector; never package.json#name alone.
            // Spawn cwd is already the selected package directory.
            workspaceSelector: snapshot.workspaceSelector,
            yarnMajorVersion: snapshot.yarnMajorVersion,
            yarnMinorVersion: snapshot.yarnMinorVersion,
            lockfileMode,
            offline,
            lifecycleScripts: 'disabled',
            production,
            timeoutMs: effectiveTimeoutMs,
            maxOutputBytes,
            operationId: operation?.backendOperationId,
          }),
        );
      } finally {
        releaseOperation(operationId);
      }
    },

    /**
     * @param {PackageScriptRunInput} input
     * @returns {Promise<PackageCommandResult>}
     */
    async run(input) {
      const {
        script,
        args = [],
        timeoutMs,
        operationId,
        ...workspaceInput
      } = input;
      const operation = claimOperation(operationId);
      await null;
      try {
        assertNotCancelled(operation);
        if (typeof script !== 'string' || script.length === 0) {
          throw makePackageManagerError(
            'script-not-declared',
            'run requires a non-empty script name',
          );
        }
        if (script.startsWith('-')) {
          throw makePackageManagerError(
            'script-not-declared',
            'run does not accept script names beginning with "-"',
          );
        }
        assertDenseStringArray(args);

        const { selection, snapshot, segments, displayPath } =
          await resolveSelection(workspaceInput);
        assertNotCancelled(operation);
        assertVersionRequestAllowed(selection.versionRequest);

        const scriptNames = Array.isArray(snapshot.scriptNames)
          ? snapshot.scriptNames
          : [];
        if (!scriptNames.includes(script)) {
          throw makePackageManagerError(
            'script-not-declared',
            `script ${q(script)} is not declared in package.json`,
            { script, scriptNames },
          );
        }

        const effectiveTimeoutMs = effectiveTimeout(
          timeoutMs,
          defaultTimeoutMs,
          maxTimeoutMs,
        );
        assertNotCancelled(operation);
        if (operation !== undefined) {
          operation.started = true;
        }
        return await backend.run(
          harden({
            manager: selection.manager,
            versionRequest: selection.versionRequest,
            segments,
            displayPath,
            expectedSnapshot: snapshot,
            packageName: snapshot.packageName,
            // Only a true monorepo selector; never package.json#name alone.
            // Spawn cwd is already the selected package directory.
            workspaceSelector: snapshot.workspaceSelector,
            yarnMajorVersion: snapshot.yarnMajorVersion,
            yarnMinorVersion: snapshot.yarnMinorVersion,
            script,
            args: [...args],
            timeoutMs: effectiveTimeoutMs,
            maxOutputBytes,
            operationId: operation?.backendOperationId,
          }),
        );
      } finally {
        releaseOperation(operationId);
      }
    },

    /**
     * @param {string} operationId
     * @returns {Promise<boolean>}
     */
    async cancel(operationId) {
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw makeError(X`cancel requires a non-empty operationId`);
      }
      const operation = operations.get(operationId);
      if (operation === undefined) {
        return false;
      }
      operation.cancelled = true;
      if (!operation.started) {
        return true;
      }
      return backend.cancel(operation.backendOperationId);
    },
  };

  const readerMethods = {
    /** @param {string} [method] */
    help(method) {
      return helpFor('reader', method);
    },
    detect: methods.detect,
    scripts: methods.scripts,
    readOnly() {
      return reader;
    },
    /** @param {'reader'} name */
    scope(name) {
      if (name !== 'reader') {
        throw makeError(X`Reader scope cannot select ${q(name)}`);
      }
      return reader;
    },
  };

  /** @type {ReadOnlyEndoPackageManager} */
  const reader = makeExo(
    'PackageManagerReader',
    PackageManagerReaderInterface,
    readerMethods,
  );

  /** @type {InstallOnlyEndoPackageManager} */
  const installer = makeExo(
    'PackageManagerInstaller',
    PackageManagerInstallerInterface,
    {
      ...readerMethods,
      /** @param {string} [method] */
      help(method) {
        return helpFor('installer', method);
      },
      install: methods.install,
      cancel: methods.cancel,
      /** @param {'reader' | 'installer'} name */
      scope(name) {
        return name === 'reader' ? reader : installer;
      },
    },
  );

  /** @type {ProjectExecutionEndoPackageManager} */
  const executor = makeExo(
    'PackageManagerExecutor',
    PackageManagerExecutorInterface,
    {
      ...readerMethods,
      /** @param {string} [method] */
      help(method) {
        return helpFor('executor', method);
      },
      install: methods.install,
      cancel: methods.cancel,
      run: methods.run,
      /** @param {PackageManagerFacetName} name */
      scope(name) {
        /** @type {PackageManagerKit} */
        const kit = { reader, installer, executor };
        return kit[name];
      },
    },
  );

  packageManagerFacets.set(reader, 'reader');
  packageManagerFacets.set(installer, 'installer');
  packageManagerFacets.set(executor, 'executor');
  return harden({ reader, installer, executor });
};
harden(makePackageManagerKit);

/**
 * Construct one selected PackageManager facet. The default remains the full
 * project-execution facet for compatibility with the original factory.
 *
 * @overload
 * @param {Parameters<typeof makePackageManagerKit>[0]} powers
 * @param {PackageManagerMakeReaderOptions} options
 * @returns {ReadOnlyEndoPackageManager}
 */
/**
 * @overload
 * @param {Parameters<typeof makePackageManagerKit>[0]} powers
 * @param {PackageManagerMakeInstallerOptions} options
 * @returns {InstallOnlyEndoPackageManager}
 */
/**
 * @overload
 * @param {Parameters<typeof makePackageManagerKit>[0]} powers
 * @param {PackageManagerMakeExecutorOptions} [options]
 * @returns {ProjectExecutionEndoPackageManager}
 */
/**
 * @overload
 * @param {Parameters<typeof makePackageManagerKit>[0]} powers
 * @param {PackageManagerMakeOptions} [options]
 * @returns {PackageManagerFacet}
 */
/**
 * @param {Parameters<typeof makePackageManagerKit>[0]} powers
 * @param {PackageManagerMakeOptions} [options]
 * @returns {PackageManagerFacet}
 */
export const makePackageManager = (powers, { facet = 'executor' } = {}) => {
  const kit = makePackageManagerKit(powers);
  if (facet === 'reader' || facet === 'installer' || facet === 'executor') {
    return kit[facet];
  }
  throw makeError(X`Unknown package manager facet ${q(facet)}`);
};
harden(makePackageManager);
