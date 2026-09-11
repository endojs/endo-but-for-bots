// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/**
 * @import {
 *   InstallOnlyEndoPackageManager,
 *   PackageManagerFacet,
 *   PackageManagerChoice,
 *   PackageScriptRunInput,
 *   ProjectExecutionEndoPackageManager,
 * } from '@endo/exo-package-manager'
 */
/** @import { ToolInvocationContext, ToolRecord } from '../types.js' */

import { E } from '@endo/eventual-send';
import { getPackageManagerFacetName } from '@endo/exo-package-manager';

import { makeTool } from '../tool.js';

/**
 * @typedef {PackageManagerFacet} PackageManagerToolCapability
 */

/**
 * @typedef {object} PackageManagerToolsOptions
 * @property {ERef<{ entry: (segments: string[]) => Promise<object> }>} [mount]
 *   Mount issuer used to resolve mount-relative path strings to PathEntry
 *   remotables. Required when tools accept a `cwd` path string.
 * @property {boolean} [includeReadTools] When true (default), emit
 *   `detectPackageManager` and `listPackageScripts`.
 */

/**
 * @typedef {object} InstallDependenciesToolInput
 * @property {string} [cwd]
 * @property {string} [manager]
 * @property {string} [lockfileMode]
 * @property {boolean} [offline]
 * @property {boolean} [production]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} RunPackageScriptToolInput
 * @property {string} script
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {string} [manager]
 * @property {number} [timeoutMs]
 */

/**
 * Split a mount-relative path into entry segments.
 *
 * @param {string} path
 * @returns {string[]}
 */
const pathToSegments = path =>
  path.split('/').filter(segment => segment !== '' && segment !== '.');

/**
 * @param {ERef<{ entry: (segments: string[]) => Promise<object> }>} mount
 * @param {unknown} cwdPath
 * @returns {Promise<object | undefined>}
 */
const resolveCwdEntry = async (mount, cwdPath) => {
  if (cwdPath === undefined || cwdPath === null) {
    return undefined;
  }
  if (typeof cwdPath !== 'string') {
    throw new Error('cwd must be a mount-relative path string');
  }
  if (cwdPath === '' || cwdPath === '.') {
    return undefined;
  }
  const segments = pathToSegments(cwdPath);
  if (segments.length === 0) {
    return undefined;
  }
  return E(mount).entry(segments);
};

/**
 * Generate a stable-enough operation id for cancel bridging.
 *
 * @returns {string}
 */
const newOperationId = () =>
  `pm-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

/**
 * Bridge an AbortSignal to package-manager cancel(operationId).
 *
 * @param {ERef<InstallOnlyEndoPackageManager>} pmCap
 * @param {string} operationId
 * @param {AbortSignal | undefined} signal
 * @returns {() => void} cleanup
 */
const bridgeSignalToCancel = (pmCap, operationId, signal) => {
  if (signal === undefined || signal === null) {
    return () => {};
  }
  if (signal.aborted) {
    void E(pmCap).cancel(operationId);
    return () => {};
  }
  const onAbort = () => {
    void E(pmCap).cancel(operationId);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
};

const managerChoiceProp = harden({
  type: 'string',
  enum: ['auto', 'npm', 'pnpm', 'yarn'],
  description: 'Package manager selection; auto uses manifest and lockfiles.',
});

const cwdProp = harden({
  type: 'string',
  description:
    'Mount-relative path to the package directory (default: mount root). ' +
    'Resolved through the mount issuer; host paths are not accepted.',
});

/**
 * Build agent tools over a confined EndoPackageManager capability.
 *
 * The surface is install of declared dependencies and run of named package.json
 * scripts (plus detect/list metadata). It is a peer grant next to git/fs/shell,
 * not a general shell substitute, not a polyglot toolchain, and not a
 * substitute for registry resolve+import.
 *
 * Tool presence follows the granted facet: readers add metadata tools,
 * installers add safe dependency hydration, and executors add named-script
 * execution. Unknown or promised capabilities fail closed to reader tools.
 * Path strings in tool schemas never include host paths; they are resolved to
 * mount entries locally.
 *
 * @param {ERef<PackageManagerToolCapability>} pmCap
 * @param {PackageManagerToolsOptions} [options]
 * @returns {ToolRecord[]}
 */
export const makePackageManagerTools = (pmCap, options = {}) => {
  const { mount, includeReadTools = true } = options;
  const facet = getPackageManagerFacetName(pmCap) ?? 'reader';
  const installerCap =
    facet === 'installer' || facet === 'executor'
      ? /** @type {ERef<InstallOnlyEndoPackageManager>} */ (pmCap)
      : undefined;
  const executorCap =
    facet === 'executor'
      ? /** @type {ERef<ProjectExecutionEndoPackageManager>} */ (pmCap)
      : undefined;

  /** @type {ToolRecord[]} */
  const tools = [];

  if (includeReadTools) {
    tools.push(
      makeTool({
        name: 'detectPackageManager',
        description:
          'Detect the package manager (npm/pnpm/yarn) for a package directory ' +
          'from explicit choice, packageManager field, and lockfile markers.',
        parameters: harden({
          type: 'object',
          properties: {
            cwd: cwdProp,
            manager: managerChoiceProp,
          },
          required: [],
          additionalProperties: false,
        }),
        execute: async args => {
          await null;
          const input = /** @type {{ cwd?: string, manager?: string }} */ (
            args
          );
          /** @type {Record<string, unknown>} */
          const payload = {};
          if (input.manager !== undefined) {
            payload.manager = input.manager;
          }
          if (input.cwd !== undefined) {
            if (mount === undefined) {
              throw new Error(
                'detectPackageManager cwd requires a mount issuer',
              );
            }
            const entry = await resolveCwdEntry(mount, input.cwd);
            if (entry !== undefined) {
              payload.cwd = entry;
            }
          }
          return E(pmCap).detect(harden(payload));
        },
      }),
    );

    tools.push(
      makeTool({
        name: 'listPackageScripts',
        description:
          'List declared package.json script names for the selected package.',
        parameters: harden({
          type: 'object',
          properties: {
            cwd: cwdProp,
            manager: managerChoiceProp,
          },
          required: [],
          additionalProperties: false,
        }),
        execute: async args => {
          await null;
          const input = /** @type {{ cwd?: string, manager?: string }} */ (
            args
          );
          /** @type {Record<string, unknown>} */
          const payload = {};
          if (input.manager !== undefined) {
            payload.manager = input.manager;
          }
          if (input.cwd !== undefined) {
            if (mount === undefined) {
              throw new Error('listPackageScripts cwd requires a mount issuer');
            }
            const entry = await resolveCwdEntry(mount, input.cwd);
            if (entry !== undefined) {
              payload.cwd = entry;
            }
          }
          return E(pmCap).scripts(harden(payload));
        },
      }),
    );
  }

  if (installerCap !== undefined) {
    tools.push(
      makeTool({
        name: 'installDependencies',
        description:
          'Install declared package dependencies with the selected manager. ' +
          'Frozen lockfile mode is the default. Lifecycle execution is always ' +
          'disabled; this does not add packages.',
        parameters: harden({
          type: 'object',
          properties: {
            cwd: cwdProp,
            manager: managerChoiceProp,
            lockfileMode: {
              type: 'string',
              enum: ['frozen', 'update'],
              description:
                'frozen (default) requires a lockfile and does not change it; ' +
                'update requires host policy allowance.',
            },
            offline: {
              type: 'boolean',
              description: 'Use only granted caches; network none.',
            },
            production: {
              type: 'boolean',
              description: 'Omit dev dependencies when supported.',
            },
            timeoutMs: {
              type: 'number',
              description: 'Per-call timeout; may only narrow host policy.',
            },
          },
          required: [],
          additionalProperties: false,
        }),
        /**
         * @param {Record<string, unknown>} args
         * @param {ToolInvocationContext} [context]
         */
        execute: async (args, context) => {
          await null;
          const input = /** @type {InstallDependenciesToolInput} */ (args);
          const operationId = newOperationId();
          /** @type {Record<string, unknown>} */
          const payload = { operationId };
          for (const key of [
            'manager',
            'lockfileMode',
            'offline',
            'production',
            'timeoutMs',
          ]) {
            if (input[key] !== undefined) {
              payload[key] = input[key];
            }
          }
          if (input.cwd !== undefined) {
            if (mount === undefined) {
              throw new Error(
                'installDependencies cwd requires a mount issuer',
              );
            }
            const entry = await resolveCwdEntry(mount, input.cwd);
            if (entry !== undefined) {
              payload.cwd = entry;
            }
          }
          const cleanup = bridgeSignalToCancel(
            installerCap,
            operationId,
            context?.signal,
          );
          try {
            return await E(installerCap).install(harden(payload));
          } finally {
            cleanup();
          }
        },
      }),
    );
  }

  if (executorCap !== undefined) {
    tools.push(
      makeTool({
        name: 'runPackageScript',
        description:
          'Run a declared package.json script with the selected manager. ' +
          'Not a general shell or arbitrary package-manager subcommand.',
        parameters: harden({
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'Declared script name from package.json#scripts.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments forwarded after the script name.',
            },
            cwd: cwdProp,
            manager: managerChoiceProp,
            timeoutMs: {
              type: 'number',
              description: 'Per-call timeout; may only narrow host policy.',
            },
          },
          required: ['script'],
          additionalProperties: false,
        }),
        /**
         * @param {Record<string, unknown>} args
         * @param {ToolInvocationContext} [context]
         */
        execute: async (args, context) => {
          await null;
          const input = /** @type {RunPackageScriptToolInput} */ (args);
          const operationId = newOperationId();
          /** @type {PackageScriptRunInput} */
          const payload = {
            operationId,
            script: input.script,
          };
          if (input.args !== undefined) {
            payload.args = input.args;
          }
          if (input.manager !== undefined) {
            payload.manager = /** @type {PackageManagerChoice} */ (
              input.manager
            );
          }
          if (input.timeoutMs !== undefined) {
            payload.timeoutMs = input.timeoutMs;
          }
          if (input.cwd !== undefined) {
            if (mount === undefined) {
              throw new Error('runPackageScript cwd requires a mount issuer');
            }
            const entry = await resolveCwdEntry(mount, input.cwd);
            if (entry !== undefined) {
              payload.cwd = entry;
            }
          }
          const cleanup = bridgeSignalToCancel(
            executorCap,
            operationId,
            context?.signal,
          );
          try {
            return await E(executorCap).run(harden(payload));
          } finally {
            cleanup();
          }
        },
      }),
    );
  }

  return harden(tools);
};
harden(makePackageManagerTools);
