// @ts-check
/**
 * Mid-session model switching for the Lal worker: the `/model` inbox command.
 *
 * A switch replaces `piAgent.state.model` between rounds and leaves
 * `piAgent.state.messages` alone, so the transcript carries forward. pi-ai
 * adapts the prior turns for the new model at request time (thinking blocks,
 * tool call ids, unsupported images).
 *
 * The selection lasts as long as the worker's in-memory transcript; neither
 * survives a restart.
 */

import { getEnvApiKey } from '@earendil-works/pi-ai/compat';

import { makeWorkerGetApiKey, resolveModel } from './model-resolution.js';

/** @import { Agent as PiAgent } from '@earendil-works/pi-agent-core' */
/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { Credentials } from '@endo/agentry/harness' */

const USAGE = 'Usage: `/model` or `/model <provider>/<model-id>`.';

/**
 * Recognize a `/model` command in an inbound message. A message with an edge
 * name or any other text is ordinary mail for the LLM.
 *
 * @param {{ type?: string, strings?: string[] }} message
 * @returns {{ argument: string | undefined } | undefined}
 */
export const parseModelCommand = ({ type, strings }) => {
  if ((type !== undefined && type !== 'package') || strings?.length !== 1) {
    return undefined;
  }
  const match = /^\s*\/model(?:\s+(.*\S))?\s*$/s.exec(strings[0]);
  return match ? harden({ argument: match[1] }) : undefined;
};
harden(parseModelCommand);

/**
 * @param {Model<string>} model
 * @returns {boolean}
 */
const isOllamaModel = model => !!model.name?.startsWith('ollama/');

/**
 * @param {Model<string>} model
 * @returns {string}
 */
const formatModel = model =>
  isOllamaModel(model) ? model.name : `${model.provider}/${model.id}`;

/**
 * Build the resolver from a model to the API key it may use. The worker's
 * `authToken` was issued for the endpoint it was configured with, so only a
 * model at that same provider and base URL receives it. Any other model relies
 * on a credential the operator configured for its own provider.
 *
 * @param {Credentials} credentials
 * @param {string | undefined} authToken The worker's LAL_AUTH_TOKEN, if any.
 * @param {Model<string>} configuredModel The model the worker was spawned with.
 * @returns {(model: Model<string>) => string | undefined}
 */
export const makeModelKeyResolver = (
  credentials,
  authToken,
  configuredModel,
) => {
  return model => {
    const sameEndpoint =
      model.provider === configuredModel.provider &&
      model.baseUrl === configuredModel.baseUrl;
    const getApiKey = makeWorkerGetApiKey(
      credentials,
      sameEndpoint ? authToken : undefined,
      isOllamaModel(model),
    );
    return /** @type {string | undefined} */ (getApiKey(model.provider));
  };
};
harden(makeModelKeyResolver);

/**
 * Build the handler that applies a parsed `/model` command to a PiAgent and
 * returns the reply text. A rejected switch leaves the current model in place.
 *
 * @param {object} args
 * @param {PiAgent} args.piAgent
 * @param {(model: Model<string>) => string | undefined} args.keyForModel
 * @param {(modelString: string) => Promise<Model<string> | undefined>} [args.resolve]
 * @param {(provider: string) => boolean} [args.hasAmbientKey] Whether pi-ai's
 *   own environment lookup has a credential for the provider.
 * @returns {(command: { argument: string | undefined }) => Promise<string>}
 */
export const makeModelCommandHandler = ({
  piAgent,
  keyForModel,
  resolve = resolveModel,
  hasAmbientKey = provider => getEnvApiKey(provider) !== undefined,
}) => {
  return async ({ argument }) => {
    if (argument === undefined) {
      return `Using ${formatModel(piAgent.state.model)}. ${USAGE}`;
    }
    if (!/^[^/\s]+\/\S+$/.test(argument)) {
      return USAGE;
    }
    const model = await resolve(argument);
    if (!model) {
      return `Unknown model ${argument}; still using ${formatModel(piAgent.state.model)}.`;
    }
    if (!keyForModel(model) && !hasAmbientKey(model.provider)) {
      return (
        `No credential for ${model.provider}; still using ` +
        `${formatModel(piAgent.state.model)}. Configure one in the daemon's ` +
        'environment, such as ' +
        `${model.provider.toUpperCase().replaceAll('-', '_')}_API_KEY.`
      );
    }
    piAgent.state.model = model;
    piAgent.state.thinkingLevel = model.reasoning ? 'medium' : 'off';
    return `Now using ${formatModel(model)}. The conversation carries forward.`;
  };
};
harden(makeModelCommandHandler);
