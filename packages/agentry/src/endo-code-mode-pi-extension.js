// @ts-check
/// <reference types="ses"/>

/** @import { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent' */
/** @import { EndoConnectionFailureContext, EndoConnectionFailureObserver, EndoProvisionPersistence, EndoProvisionResult, EndoProvisionSpec } from './code-mode-provisioning-types.js' */

import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { start } from '@endo/daemon';

import { exit, stderr } from 'node:process';

import { makeCodeModeSystemPrompt } from './code-mode.js';
import { makeEndoProvisionGlobals } from './code-mode-provision-globals.js';
import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from './code-mode-provision-policy.js';
import { reconstructEndoCodeMode } from './code-mode-provisioning.js';
import {
  renderEvaluateCall,
  renderEvaluateResult,
} from './pi-evaluate-render.js';

const FLAG_NAME = 'endo-provision';
const SESSION_ENTRY_TYPE = 'endo.pi-code-mode.provision';
const ACTIVE_TOOL_NAMES = harden(['evaluate']);
const NO_TOOL_NAMES = harden([]);

/**
 * @typedef {object} EndoCodeModePiProblem
 * @property {'endo_code_mode_error'} type
 * @property {string} code
 * @property {string} message
 * @property {string} action
 *
 * @typedef {object} ProvisionFailureRecoveryRequest
 * @property {unknown} error
 * @property {EndoProvisionPersistence} persistence
 * @property {boolean} hasUI
 *
 * @typedef {object} EndoCodeModePiExtensionOptions
 * @property {(spec: EndoProvisionSpec | undefined, options: { harness: string, sessionId: string, cwd: string }) => Promise<EndoProvisionPersistence>} [normalizeProvision]
 * @property {(persistence: unknown) => Promise<EndoProvisionPersistence>} [validatePersistence]
 * @property {(persistence: EndoProvisionPersistence, options: { onConnectionFailure: EndoConnectionFailureObserver, forkFrom?: EndoProvisionPersistence }) => Promise<EndoProvisionResult>} [reconstructProvision]
 * @property {() => Promise<void>} [startDaemon]
 * @property {(request: ProvisionFailureRecoveryRequest) => Promise<boolean>} [recoverProvisionFailure]
 * @property {(problem: EndoCodeModePiProblem) => void} [writeDiagnostic]
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
const hasSameRuntimeAuthority = (left, right) => samePlainData(left, right);

/** @param {EndoProvisionPersistence} value */
const withoutGuestIdentity = ({ guestName, ...rest }) => rest;

/**
 * Recreate inert input from validated persistence. This is used for forked
 * sessions so the new Pi session id selects a new retained guest namespace
 * while authority remains byte-for-byte equivalent after normalization.
 *
 * @param {EndoProvisionPersistence} persistence
 * @returns {EndoProvisionSpec}
 */
const persistenceToSpec = persistence => persistence.spec;

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
      'Pass a JSON EndoCodeModeProvisionSpec, for example --endo-provision=\'{"workspace":{"mode":"readOnly"}}\'.',
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
      'Pass a JSON EndoCodeModeProvisionSpec, for example --endo-provision=\'{"workspace":{"mode":"readOnly"}}\'.',
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
 * @returns {EndoCodeModePiProblem}
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
  return harden({
    type: /** @type {const} */ ('endo_code_mode_error'),
    code: 'ENDO_PI_STARTUP_FAILED',
    message: 'Endo code mode could not start.',
    action:
      'Check the provision policy and standard Endo daemon, then resume or reload this session.',
  });
};

/**
 * Keep connection diagnostics concise and free of peer-supplied error text.
 * The raw error remains available only to the host-owned observer boundary.
 *
 * @param {EndoConnectionFailureContext} context
 * @returns {EndoCodeModePiProblem}
 */
const makeConnectionProblem = context =>
  harden({
    type: /** @type {const} */ ('endo_code_mode_error'),
    code:
      context.kind === 'protocol'
        ? 'ENDO_DAEMON_PROTOCOL_FAILED'
        : 'ENDO_DAEMON_CONNECTION_FAILED',
    message:
      context.kind === 'protocol'
        ? 'The Endo daemon connection encountered a protocol error.'
        : 'The Endo daemon connection closed unexpectedly.',
    action: 'Restart Endo, then resume or reload this session.',
  });

/**
 * @param {EndoConnectionFailureContext} context
 * @returns {EndoPiLifecycleError}
 */
const makeConnectionFailureError = context => {
  const connectionProblem = makeConnectionProblem(context);
  return new EndoPiLifecycleError(
    connectionProblem.code,
    connectionProblem.message,
    connectionProblem.action,
  );
};

/**
 * Only an explicitly classified credential availability error may enter the
 * interactive retry hook. Policy, integrity, and programming failures stay
 * terminal and are never presented as a request for credentials.
 * @param {unknown} error
 */
const isRecoverableProvisionFailure = error =>
  typeof error === 'object' &&
  error !== null &&
  Object.hasOwn(error, 'code') &&
  /** @type {{ code?: unknown }} */ (error).code ===
    'ENDO_CREDENTIAL_UNAVAILABLE';
harden(isRecoverableProvisionFailure);

/**
 * Build a directly loadable Pi extension backed by the standard Endo daemon.
 * Dependency injection is limited to trusted host lifecycle seams so focused
 * tests and trusted TUI/RPC recovery hooks do not need ambient secrets.
 *
 * @param {EndoCodeModePiExtensionOptions} [options]
 * @returns {ExtensionFactory}
 */
export const makeEndoCodeModePiExtension = (options = {}) => {
  const {
    normalizeProvision = normalizeEndoProvisionSpec,
    validatePersistence = validateEndoProvisionPersistence,
    reconstructProvision = (persistence, { onConnectionFailure, forkFrom }) =>
      reconstructEndoCodeMode({
        persistence,
        forkFrom,
        onConnectionFailure,
      }),
    startDaemon = () => start(),
    recoverProvisionFailure,
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
      /** @type {EndoCodeModePiProblem | undefined} */
      let problem;
      let preservePiTools = false;
      /** @type {'idle' | 'starting' | 'active' | 'failed' | 'shuttingDown'} */
      let phase = 'idle';
      let lifecycle = 0;
      let connectionFailureReported = false;

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
       * @param {EndoConnectionFailureObserver} onConnectionFailure
       * @param {EndoProvisionPersistence | undefined} forkFrom
       * @returns {Promise<EndoProvisionResult>}
       */
      const connectWithDaemonRecovery = async (
        persistence,
        onConnectionFailure,
        forkFrom,
      ) => {
        await null;
        try {
          return await reconstructProvision(persistence, {
            onConnectionFailure,
            forkFrom,
          });
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
          return await reconstructProvision(persistence, {
            onConnectionFailure,
            forkFrom,
          });
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
       * @param {EndoConnectionFailureObserver} onConnectionFailure
       * @param {EndoProvisionPersistence | undefined} forkFrom
       * @returns {Promise<EndoProvisionResult>}
       */
      const connect = async (
        persistence,
        context,
        onConnectionFailure,
        forkFrom,
      ) => {
        await null;
        try {
          return await connectWithDaemonRecovery(
            persistence,
            onConnectionFailure,
            forkFrom,
          );
        } catch (error) {
          if (
            context.hasUI &&
            recoverProvisionFailure !== undefined &&
            isRecoverableProvisionFailure(error)
          ) {
            const recovered = await recoverProvisionFailure({
              error,
              persistence,
              hasUI: context.hasUI,
            });
            if (recovered) {
              return connectWithDaemonRecovery(
                persistence,
                onConnectionFailure,
                forkFrom,
              );
            }
          }
          throw error;
        }
      };

      pi.registerFlag(FLAG_NAME, {
        type: 'string',
        description:
          'Inert EndoCodeModeProvisionSpec JSON for this Pi session (never credential material)',
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
        lifecycle += 1;
        const sessionLifecycle = lifecycle;
        phase = 'starting';
        connectionFailureReported = false;
        /** @type {EndoConnectionFailureContext | undefined} */
        let startupConnectionFailure;

        /** @type {EndoConnectionFailureObserver} */
        const onConnectionFailure = (error, failureContext) => {
          // Raw connection errors are deliberately neither retained nor shown.
          // Only the trusted host callback receives them for correlation.
          void error;
          if (
            sessionLifecycle !== lifecycle ||
            phase === 'shuttingDown' ||
            phase === 'idle' ||
            phase === 'failed' ||
            connectionFailureReported
          ) {
            return;
          }
          if (phase === 'starting') {
            if (startupConnectionFailure === undefined) {
              startupConnectionFailure = failureContext;
            }
            return;
          }

          connectionFailureReported = true;
          phase = 'failed';
          problem = makeConnectionProblem(failureContext);
          const previous = active;
          active = undefined;
          pi.setActiveTools(NO_TOOL_NAMES);
          if (previous !== undefined) {
            void previous.cleanup().catch(() => {});
          }
          if (context.hasUI) {
            context.ui.notify(`${problem.message} ${problem.action}`, 'error');
          } else {
            writeDiagnostic(problem);
            terminate(1);
          }
        };

        await cleanupActive();
        problem = undefined;
        preservePiTools = false;
        const initialActiveTools = pi.getActiveTools();
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
          /** @type {EndoProvisionPersistence | undefined} */
          let forkFrom;
          /** @type {'preserve' | undefined} */
          let desiredPiTools;

          if (storedData === undefined) {
            try {
              desired = await normalizeProvision(cliSpec, {
                harness: 'pi',
                sessionId,
                cwd: context.cwd,
              });
              desiredPiTools = cliSpec?.piTools;
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_INVALID',
                '--endo-provision is not a valid EndoCodeModeProvisionSpec.',
                'Correct the inert policy JSON and start a new Pi session.',
              );
            }
          } else {
            let stored;
            let storedPiTools;
            try {
              const sessionRecord =
                /** @type {Record<string, any> | undefined} */ (
                  typeof storedData === 'object' && storedData !== null
                    ? storedData
                    : undefined
                );
              stored = await validatePersistence(
                sessionRecord?.persistence ?? storedData,
              );
              storedPiTools = sessionRecord?.piTools;
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_SESSION_INVALID',
                'This session has missing or invalid Endo code-mode authority; a previously granted workspace or Git directory is unavailable.',
                'Start a new session; no previous grant is silently dropped or changed during recovery.',
              );
            }

            if (cliSpec !== undefined) {
              let requested;
              try {
                requested = await normalizeProvision(cliSpec, {
                  harness: 'pi',
                  sessionId,
                  cwd: stored.internalGit?.path ?? context.cwd,
                });
              } catch {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_INVALID',
                  '--endo-provision is not a valid EndoCodeModeProvisionSpec.',
                  'Correct the inert policy JSON and start a new Pi session.',
                );
              }
              if (!hasSameRuntimeAuthority(requested, stored)) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_CONFLICT',
                  "--endo-provision conflicts with this session's retained authority.",
                  'Start a new session for different authority, or fork this session without changing --endo-provision.',
                );
              }
              if (cliSpec.piTools !== storedPiTools) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_CONTEXT_CONFLICT',
                  "--endo-provision conflicts with this session's retained prompt context.",
                  'Resume with the retained description and session settings, or fork this session to change them.',
                );
              }
            }

            let normalizedDerived;
            try {
              normalizedDerived = await normalizeProvision(
                persistenceToSpec(stored),
                {
                  harness: 'pi',
                  sessionId,
                  cwd: context.cwd,
                },
              );
            } catch {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_SESSION_INVALID',
                'This session authority cannot be reconstructed.',
                'Start a new session from a valid inert provision policy.',
              );
            }
            if (
              event.reason !== 'fork' &&
              !hasSameRuntimeAuthority(normalizedDerived, stored)
            ) {
              const identityOnlyMismatch = samePlainData(
                withoutGuestIdentity(normalizedDerived),
                withoutGuestIdentity(stored),
              );
              throw new EndoPiLifecycleError(
                identityOnlyMismatch
                  ? 'ENDO_PROVISION_SESSION_MISMATCH'
                  : 'ENDO_PROVISION_SESSION_INVALID',
                identityOnlyMismatch
                  ? 'The retained guest belongs to a different Pi session.'
                  : 'This session authority does not normalize to its persisted policy.',
                identityOnlyMismatch
                  ? 'Resume the original session, or use Pi fork to create a new retained guest namespace.'
                  : 'Start a new session; authority is never widened during recovery.',
              );
            }
            const derived = normalizedDerived;

            if (event.reason === 'fork') {
              forkFrom = stored;
              desired = derived;
              desiredPiTools = storedPiTools;
            } else {
              if (!samePlainData(derived, stored)) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_SESSION_MISMATCH',
                  'The retained guest belongs to a different Pi session.',
                  'Resume the original session, or use Pi fork to create a new retained guest namespace.',
                );
              }
              desired = stored;
              desiredPiTools = storedPiTools;
            }
          }

          preservePiTools = desiredPiTools === 'preserve';
          const connected = await connect(
            desired,
            context,
            onConnectionFailure,
            forkFrom,
          );
          if (startupConnectionFailure !== undefined) {
            await connected.cleanup();
            throw makeConnectionFailureError(startupConnectionFailure);
          }
          if (!hasSameRuntimeAuthority(connected.persistence, desired)) {
            await connected.cleanup();
            throw new EndoPiLifecycleError(
              'ENDO_PROVISION_RECOVERY_MISMATCH',
              'The daemon returned different runtime authority for this session.',
              'Start a new session; authority is never widened during recovery.',
            );
          }
          if (!samePlainData(connected.persistence, desired)) {
            await connected.cleanup();
            throw new EndoPiLifecycleError(
              'ENDO_PROVISION_RECOVERY_MISMATCH',
              'The daemon returned different session persistence for this session.',
              'Start a new session; retained session identity is never changed during recovery.',
            );
          }
          active = connected;
          phase = 'active';

          const evaluate = makeEvaluateTool(
            makeDaemonEvaluate(connected.guest),
            connected.globals,
          );
          pi.registerTool(
            toPiAgentTool(evaluate, {
              renderToolResult: toolResultToSmallcaps,
              renderCall: renderEvaluateCall,
              renderResult: renderEvaluateResult,
            }),
          );
          if (preservePiTools) {
            pi.setActiveTools([
              ...new Set([...initialActiveTools, ...ACTIVE_TOOL_NAMES]),
            ]);
          } else {
            pi.setActiveTools(ACTIVE_TOOL_NAMES);
          }
          pi.appendEntry(
            SESSION_ENTRY_TYPE,
            desiredPiTools === undefined
              ? connected.persistence
              : harden({
                  persistence: connected.persistence,
                  piTools: desiredPiTools,
                }),
          );
        } catch (error) {
          phase = 'failed';
          await cleanupActive();
          pi.setActiveTools(
            preservePiTools ? initialActiveTools : NO_TOOL_NAMES,
          );
          problem = makeProblem(
            startupConnectionFailure === undefined
              ? error
              : makeConnectionFailureError(startupConnectionFailure),
          );
          if (context.hasUI) {
            context.ui.notify(`${problem.message} ${problem.action}`, 'error');
          } else {
            writeDiagnostic(problem);
            terminate(1);
          }
        }
      });

      pi.on('before_agent_start', event => {
        if (active !== undefined) {
          const codeModePrompt = makeCodeModeSystemPrompt(
            makeEndoProvisionGlobals(active.persistence),
            {
              preserveTools: preservePiTools,
            },
          );
          return harden({
            systemPrompt: preservePiTools
              ? `${event.systemPrompt}\n\n${codeModePrompt}`
              : codeModePrompt,
          });
        }
        return harden({
          systemPrompt: preservePiTools
            ? `${event.systemPrompt}\n\nEndo code mode is unavailable. Standard Pi tools remain active; resolve the extension startup error before continuing.`
            : 'Endo code mode is unavailable. No tools or authority are active; resolve the extension startup error before continuing.',
        });
      });

      pi.on('session_shutdown', async () => {
        lifecycle += 1;
        phase = 'shuttingDown';
        if (!preservePiTools) {
          pi.setActiveTools(NO_TOOL_NAMES);
        }
        await cleanupActive();
        phase = 'idle';
      });
    },
  );
};
harden(makeEndoCodeModePiExtension);

const endoCodeModePiExtension = makeEndoCodeModePiExtension();

export default endoCodeModePiExtension;
