// @ts-check

import { makeInferenceAgentDriverMaker } from '@endo/exo-agent-factory';

import { makeClaudeCliBackend } from './cli-backend.js';
import { makeClaudeSdkBackend } from './sdk-backend.js';

/** @import { GuestToolProjection } from '@endo/inference/types.js' */
/** @import { ClaudeCliBackendOptions, ClaudeSdkBackendOptions } from './backends.types.js' */

/**
 * Thinly compose the landed Claude CLI backend with the generic inference
 * driver maker.
 *
 * @param {object} options
 * @param {ClaudeCliBackendOptions} options.backend
 * @param {(agent: any) => GuestToolProjection | Promise<GuestToolProjection>} options.makeGuestToolProjection
 * @param {string} [options.driverSpecifier]
 * @param {Record<string, string>} [options.environment]
 */
export const makeClaudeCliAgentDriverMaker = ({
  backend,
  makeGuestToolProjection,
  driverSpecifier,
  environment,
}) =>
  makeInferenceAgentDriverMaker({
    backend: makeClaudeCliBackend(backend),
    makeGuestToolProjection,
    ...(driverSpecifier ? { driverSpecifier } : {}),
    ...(environment ? { environment } : {}),
  });
harden(makeClaudeCliAgentDriverMaker);

/**
 * Thinly compose the landed Claude Agent SDK backend with the generic
 * inference driver maker.
 *
 * @param {object} options
 * @param {ClaudeSdkBackendOptions} options.backend
 * @param {(agent: any) => GuestToolProjection | Promise<GuestToolProjection>} options.makeGuestToolProjection
 * @param {string} [options.driverSpecifier]
 * @param {Record<string, string>} [options.environment]
 */
export const makeClaudeSdkAgentDriverMaker = ({
  backend,
  makeGuestToolProjection,
  driverSpecifier,
  environment,
}) =>
  makeInferenceAgentDriverMaker({
    backend: makeClaudeSdkBackend(backend),
    makeGuestToolProjection,
    ...(driverSpecifier ? { driverSpecifier } : {}),
    ...(environment ? { environment } : {}),
  });
harden(makeClaudeSdkAgentDriverMaker);
