// @ts-check
/// <reference types="ses"/>

/** @import { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent' */
/** @import { EndoConnectionFailureContext, EndoConnectionFailureObserver, EndoProvisionPersistence, EndoProvisionRequest, EndoProvisionResult, EndoProvisionSpec } from './code-mode-provisioning-types.js' */

import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { start } from '@endo/daemon';

import { exit, stderr } from 'node:process';

import { makeCodeModeSystemPrompt } from './code-mode.js';
import {
  makeEndoProvisionPersistence,
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from './code-mode-provision-policy.js';
import {
  provisionEndoCodeModeRequest,
  reconstructEndoCodeMode,
} from './code-mode-provisioning.js';
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
 * @property {(spec: EndoProvisionSpec | undefined, options: { harness: string, sessionId: string, cwd: string }) => Promise<EndoProvisionRequest>} [normalizeProvision]
 * @property {(persistence: unknown) => Promise<EndoProvisionPersistence>} [validatePersistence]
 * @property {(persistence: EndoProvisionPersistence, options: { onConnectionFailure: EndoConnectionFailureObserver, forkFrom?: EndoProvisionPersistence, request?: EndoProvisionRequest }) => Promise<EndoProvisionResult>} [reconstructProvision]
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
      'Pass a JSON EndoCodeModeProvisionSpec, for example --endo-provision=\'{"mount":{"workspace":{"path":".","mode":"readOnly"}}}\'.',
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
      'Pass a JSON EndoCodeModeProvisionSpec, for example --endo-provision=\'{"mount":{"workspace":{"path":".","mode":"readOnly"}}}\'.',
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
    reconstructProvision = (
      persistence,
      { onConnectionFailure, forkFrom, request },
    ) =>
      request === undefined
        ? reconstructEndoCodeMode({
            persistence,
            forkFrom,
            onConnectionFailure,
          })
        : provisionEndoCodeModeRequest(request, { onConnectionFailure }),
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
       * @param {EndoProvisionRequest | undefined} request
       * @returns {Promise<EndoProvisionResult>}
       */
      const connectWithDaemonRecovery = async (
        persistence,
        onConnectionFailure,
        forkFrom,
        request,
      ) => {
        await null;
        try {
          return await reconstructProvision(persistence, {
            onConnectionFailure,
            forkFrom,
            request,
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
            request,
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
       * @param {EndoProvisionRequest | undefined} request
       * @returns {Promise<EndoProvisionResult>}
       */
      const connect = async (
        persistence,
        context,
        onConnectionFailure,
        forkFrom,
        request,
      ) => {
        await null;
        try {
          return await connectWithDaemonRecovery(
            persistence,
            onConnectionFailure,
            forkFrom,
            request,
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
                request,
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
          /** @type {EndoProvisionRequest | undefined} */
          let request;
          /** @type {'preserve' | undefined} */
          let desiredPiTools;

          if (storedData === undefined) {
            try {
              request = await normalizeProvision(cliSpec, {
                harness: 'pi',
                sessionId,
                cwd: context.cwd,
              });
              desired = request.persistence;
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
                'This session has missing or invalid Endo code-mode identity.',
                'Start a new session; retained authority is reacquired from the daemon by opaque guest name.',
              );
            }
            const derived = makeEndoProvisionPersistence({
              harness: 'pi',
              sessionId,
            });
            if (event.reason === 'fork') {
              if (cliSpec !== undefined) {
                throw new EndoPiLifecycleError(
                  'ENDO_PROVISION_CONTEXT_CONFLICT',
                  'A fork inherits its retained Endo authority.',
                  'Omit --endo-provision when forking, or start a new session for different authority.',
                );
              }
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
              if (cliSpec !== undefined) {
                try {
                  request = await normalizeProvision(cliSpec, {
                    harness: 'pi',
                    sessionId,
                    cwd: context.cwd,
                  });
                } catch {
                  throw new EndoPiLifecycleError(
                    'ENDO_PROVISION_INVALID',
                    '--endo-provision is not a valid EndoCodeModeProvisionSpec.',
                    'Correct the inert policy JSON and start a new Pi session.',
                  );
                }
                if (cliSpec.piTools !== storedPiTools) {
                  throw new EndoPiLifecycleError(
                    'ENDO_PROVISION_CONTEXT_CONFLICT',
                    "--endo-provision conflicts with this session's retained prompt context.",
                    'Resume with the retained session settings, or start a new session to change them.',
                  );
                }
              }
            }
          }

          preservePiTools = desiredPiTools === 'preserve';
          let connected;
          try {
            connected = await connect(
              desired,
              context,
              onConnectionFailure,
              forkFrom,
              request,
            );
          } catch (error) {
            if (
              storedData !== undefined &&
              request !== undefined &&
              error instanceof Error &&
              error.message.includes(
                'cannot widen or change retained authority',
              )
            ) {
              throw new EndoPiLifecycleError(
                'ENDO_PROVISION_CONFLICT',
                "--endo-provision conflicts with this session's retained authority.",
                'Resume without the flag, or start a new session for different authority.',
              );
            }
            throw error;
          }
          if (startupConnectionFailure !== undefined) {
            await connected.cleanup();
            throw makeConnectionFailureError(startupConnectionFailure);
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
          const codeModePrompt = makeCodeModeSystemPrompt(active.globals, {
            preserveTools: preservePiTools,
          });
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
