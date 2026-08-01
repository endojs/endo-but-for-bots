// @ts-check
/// <reference types="ses"/>

/** @import { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent' */
/** @import { EndoProvisionPersistence, EndoProvisionResult, EndoProvisionSpec } from './code-mode-provisioning-types.js' */

import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { start } from '@endo/daemon';

import { exit, stderr } from 'node:process';

import { makeCodeModeSystemPrompt } from './code-mode.js';
import { EndoCredentialUnavailableError } from './code-mode-provision-host.js';
import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from './code-mode-provision-policy.js';
import { reconstructEndoCodeMode } from './code-mode-provisioning.js';

const FLAG_NAME = 'endo-provision';
const SESSION_ENTRY_TYPE = 'endo.pi-code-mode.provision';
const ACTIVE_TOOL_NAMES = harden(['evaluate']);
const NO_TOOL_NAMES = harden([]);

/**
 * @typedef {object} EndoPiProblem
 * @property {'endo_code_mode_error'} type
 * @property {string} code
 * @property {string} message
 * @property {string} action
 *
 * @typedef {object} CredentialRehydrationRequest
 * @property {EndoCredentialUnavailableError} error
 * @property {EndoProvisionPersistence} persistence
 * @property {boolean} hasUI
 *
 * @typedef {object} EndoCodeModePiExtensionOptions
 * @property {(spec: EndoProvisionSpec | undefined, options: { sessionId: string, cwd: string }) => Promise<EndoProvisionPersistence>} [normalizeProvision]
 * @property {(persistence: unknown) => Promise<EndoProvisionPersistence>} [validatePersistence]
 * @property {(persistence: EndoProvisionPersistence) => Promise<EndoProvisionResult>} [reconstructProvision]
 * @property {() => Promise<void>} [startDaemon]
 * @property {(request: CredentialRehydrationRequest) => Promise<void>} [rehydrateCredential]
 * @property {(problem: EndoPiProblem) => void} [writeDiagnostic]
 * @property {(status: number) => void} [terminate]
 */

class EndoPiLifecycleError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} action
   */
  constructor(code, message, action) {
    super(message);
    this.name = 'EndoPiLifecycleError';
    this.code = code;
    this.action = action;
  }
}
harden(EndoPiLifecycleError);

/**
 * Compare normalized plain data without depending on property insertion order.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
const samePlainData = (left, right) => {
  /** @param {unknown} value */
  const canonicalize = value => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return value;
  };
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
};
// Exported for the property test pinning the "without depending on property
// insertion order" claim above; not part of the extension's public surface.
export { samePlainData };
harden(samePlainData);

/**
 * @param {EndoProvisionPersistence} left
 * @param {EndoProvisionPersistence} right
 * @returns {boolean}
 */
const hasSameAuthority = (left, right) =>
  left.workspacePath === right.workspacePath &&
  samePlainData(left.policy, right.policy);

/**
 * Recreate inert input from validated persistence. This is used for forked
 * sessions so the new Pi session id selects a new retained guest namespace
 * while authority remains byte-for-byte equivalent after normalization.
 *
 * @param {EndoProvisionPersistence} persistence
 * @returns {EndoProvisionSpec}
 */
const persistenceToSpec = persistence =>
  harden({
    workspace: harden({
      path: persistence.workspacePath,
      deniedSegments: harden([...persistence.policy.workspace.deniedSegments]),
    }),
    ...(persistence.policy.fs === undefined
      ? {}
      : { fs: persistence.policy.fs }),
    ...(persistence.policy.git === undefined
      ? {}
      : { git: persistence.policy.git }),
    ...(persistence.policy.gitRemotes === undefined
      ? {}
      : { gitRemotes: persistence.policy.gitRemotes }),
  });

/**
 * @param {readonly SessionEntry[]} entries
 * @returns {unknown}
 */
const findLatestPersistence = entries => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'custom' && entry.customType === SESSION_ENTRY_TYPE) {
      return entry.data;
    }
  }
  return undefined;
};

/**
 * Parse only inert JSON. Raw parser diagnostics are deliberately discarded:
 * they can contain the flag text and therefore accidental credential material.
 *
 * @param {boolean | string | undefined} raw
 * @returns {EndoProvisionSpec | undefined}
 */
const parseProvisionFlag = raw => {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new EndoPiLifecycleError(
      'ENDO_PROVISION_INVALID',
      '--endo-provision must be a JSON object.',
      'Pass a JSON EndoProvisionSpec, for example --endo-provision=\'{"fs":"readOnly"}\'.',
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    return /** @type {EndoProvisionSpec} */ (parsed);
  } catch {
    throw new EndoPiLifecycleError(
      'ENDO_PROVISION_INVALID',
      '--endo-provision must be a JSON object.',
      'Pass a JSON EndoProvisionSpec, for example --endo-provision=\'{"fs":"readOnly"}\'.',
    );
  }
};

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDaemonUnavailable = error => {
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) {
      return false;
    }
    const record =
      /** @type {{ code?: unknown, message?: unknown, cause?: unknown }} */ (
        candidate
      );
    if (
      record.code === 'ENOENT' ||
      record.code === 'ECONNREFUSED' ||
      (typeof record.message === 'string' &&
        record.message.startsWith('Cannot connect to Endo. Is Endo running?'))
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
};

/**
 * @param {unknown} error
 * @returns {EndoPiProblem}
 */
const makeProblem = error => {
  if (error instanceof EndoPiLifecycleError) {
    return harden({
      type: /** @type {const} */ ('endo_code_mode_error'),
      code: error.code,
      message: error.message,
      action: error.action,
    });
  }
  if (error instanceof EndoCredentialUnavailableError) {
    return harden({
      type: /** @type {const} */ ('endo_code_mode_error'),
      code: error.code,
      message: 'A configured remote credential is unavailable.',
      action:
        'Reprovision its host-side credential through a trusted non-echoing TUI or RPC hook, then resume or reload this session.',
    });
  }
  return harden({
    type: /** @type {const} */ ('endo_code_mode_error'),
    code: 'ENDO_PI_STARTUP_FAILED',
    message: 'Endo code mode could not start.',
    action:
      'Check the provision policy and standard Endo daemon, then resume or reload this session.',
  });
};

/**
 * Build a directly loadable Pi extension backed by the standard Endo daemon.
 * Dependency injection is limited to trusted host lifecycle seams so focused
 * tests and TUI/RPC credential rehydration do not need ambient secrets.
 *
 * @param {EndoCodeModePiExtensionOptions} [options]
 * @returns {ExtensionFactory}
 */
export const makeEndoCodeModePiExtension = (options = {}) => {
  const {
    normalizeProvision = normalizeEndoProvisionSpec,
    validatePersistence = validateEndoProvisionPersistence,
    reconstructProvision = persistence =>
      reconstructEndoCodeMode({ persistence }),
    startDaemon = () => start(),
    rehydrateCredential,
    writeDiagnostic = problem => {
      stderr.write(`${JSON.stringify(problem)}\n`);
    },
    terminate = status => {
      exit(status);
    },
  } = options;

  return harden(
    /** @param {ExtensionAPI} pi */
    pi => {
      /** @type {EndoProvisionResult | undefined} */
      let active;
      /** @type {EndoPiProblem | undefined} */
      let problem;

      const cleanupActive = async () => {
        await null;
        const previous = active;
        active = undefined;
        if (previous !== undefined) {
          await previous.cleanup();
        }
      };

      /**
       * @param {EndoProvisionPersistence} persistence
       * @returns {Promise<EndoProvisionResult>}
       */
      const connectWithDaemonRecovery = async persistence => {
        await null;
        try {
          return await reconstructProvision(persistence);
        } catch (error) {
          if (!isDaemonUnavailable(error)) {
            throw error;
          }
        }

        try {
          await startDaemon();
        } catch {
          // Another process may have won the daemon-start race. The single
          // reconnect below decides whether the standard daemon is available.
        }

        try {
          return await reconstructProvision(persistence);
        } catch (error) {
          if (isDaemonUnavailable(error)) {
            throw new EndoPiLifecycleError(
              'ENDO_DAEMON_UNAVAILABLE',
              'The standard Endo daemon is unavailable after one autostart attempt.',
              'Start it with "endo start", then resume or reload this session.',
            );
          }
          throw error;
        }
      };

      /**
       * @param {EndoProvisionPersistence} persistence
       * @param {ExtensionContext} context
       * @returns {Promise<EndoProvisionResult>}
       */
      const connect = async (persistence, context) => {
        await null;
        try {
          return await connectWithDaemonRecovery(persistence);
        } catch (error) {
          if (
            error instanceof EndoCredentialUnavailableError &&
            context.hasUI &&
            rehydrateCredential !== undefined
          ) {
            await rehydrateCredential({
              error,
              persistence,
              hasUI: context.hasUI,
            });
            return connectWithDaemonRecovery(persistence);
          }
          throw error;
        }
      };

      pi.registerFlag(FLAG_NAME, {
        type: 'string',
        description:
          'Inert EndoProvisionSpec JSON for this Pi session (never credential material)',
      });

      pi.registerCommand('endo-code-mode', {
        description: 'Show daemon-backed Endo code-mode session status',
        handler: async (args, context) => {
          await null;
          if (args.trim() !== '') {
            context.ui.notify('/endo-code-mode takes no arguments.', 'warning');
          } else if (active !== undefined) {
            context.ui.notify('Endo code mode is connected.', 'info');
          } else if (problem !== undefined) {
            context.ui.notify(`${problem.message} ${problem.action}`, 'error');
          } else {
            context.ui.notify(
              'Endo code mode will connect when the session starts.',
              'info',
            );
          }
        },
      });

      pi.on('session_start', async (event, context) => {
        await cleanupActive();
        problem = undefined;
        pi.setActiveTools(NO_TOOL_NAMES);

        try {
          const sessionId = context.sessionManager.getSessionId();
          const storedData = findLatestPersistence(
            context.sessionManager.getBranch(),
          );
          const rawProvision = pi.getFlag(FLAG_NAME);
          const cliSpec = parseProvisionFlag(rawProvision);
          /** @type {EndoProvisionPersistence} */
          let desired;

          if (storedData === undefined) {
            try {
              desired = await normalizeProvision(cliSpec, {
                sessionId,
                cwd: context.cwd,
              });
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_INVALID',
                '--endo-provision is not a valid EndoProvisionSpec.',
                'Correct the inert policy JSON and start a new Pi session.',
              );
            }
          } else {
            let stored;
            try {
              stored = await validatePersistence(storedData);
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_SESSION_INVALID',
                'This session has invalid Endo code-mode persistence.',
                'Start a new session; do not copy or edit extension-owned session entries.',
              );
            }

            if (cliSpec !== undefined) {
              let requested;
              try {
                requested = await normalizeProvision(cliSpec, {
                  sessionId,
                  cwd: context.cwd,
                });
              } catch {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_INVALID',
                  '--endo-provision is not a valid EndoProvisionSpec.',
                  'Correct the inert policy JSON and start a new Pi session.',
                );
              }
              if (!hasSameAuthority(requested, stored)) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_CONFLICT',
                  "--endo-provision conflicts with this session's retained authority.",
                  'Start a new session for different authority, or fork this session without changing --endo-provision.',
                );
              }
            }

            let derived;
            try {
              derived = await normalizeProvision(persistenceToSpec(stored), {
                sessionId,
                cwd: stored.workspacePath,
              });
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_SESSION_INVALID',
                'This session authority cannot be reconstructed.',
                'Start a new session from a valid inert provision policy.',
              );
            }
            if (!hasSameAuthority(derived, stored)) {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_SESSION_INVALID',
                'This session authority does not normalize to its persisted policy.',
                'Start a new session; authority is never widened during recovery.',
              );
            }

            if (event.reason === 'fork') {
              desired = derived;
            } else {
              if (!samePlainData(derived, stored)) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_SESSION_MISMATCH',
                  'The retained guest belongs to a different Pi session.',
                  'Resume the original session, or use Pi fork to create a new retained guest namespace.',
                );
              }
              desired = stored;
            }
          }

          const connected = await connect(desired, context);
          if (!samePlainData(connected.persistence, desired)) {
            await connected.cleanup();
            throw new EndoPiLifecycleError(
              'ENDO_PROVISION_RECOVERY_MISMATCH',
              'The daemon returned different persistence for this session.',
              'Start a new session; authority is never widened during recovery.',
            );
          }
          active = connected;

          const evaluate = makeEvaluateTool(
            makeDaemonEvaluate(connected.powers),
            connected.globals,
          );
          pi.registerTool(
            toPiAgentTool(evaluate, {
              renderToolResult: toolResultToSmallcaps,
            }),
          );
          pi.setActiveTools(ACTIVE_TOOL_NAMES);
          pi.appendEntry(SESSION_ENTRY_TYPE, connected.persistence);
        } catch (error) {
          await cleanupActive();
          problem = makeProblem(error);
          if (context.hasUI) {
            context.ui.notify(`${problem.message} ${problem.action}`, 'error');
          } else {
            writeDiagnostic(problem);
            terminate(1);
          }
        }
      });

      pi.on('before_agent_start', () => {
        if (active !== undefined) {
          return harden({
            systemPrompt: makeCodeModeSystemPrompt(active.globals),
          });
        }
        return harden({
          systemPrompt:
            'Endo code mode is unavailable. No tools or authority are active; resolve the extension startup error before continuing.',
        });
      });

      pi.on('session_shutdown', async () => {
        pi.setActiveTools(NO_TOOL_NAMES);
        await cleanupActive();
      });
    },
  );
};
harden(makeEndoCodeModePiExtension);

const endoCodeModePiExtension = makeEndoCodeModePiExtension();

export default endoCodeModePiExtension;
