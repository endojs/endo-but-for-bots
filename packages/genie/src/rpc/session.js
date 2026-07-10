// @ts-check

/**
 * A {@link Session} backed by a live genie `PiAgent`.
 *
 * This adapts the raw `pi-agent-core` `Agent` (as constructed by
 * `makePiAgent`) to the narrow seam the RPC bridge drives: it forwards
 * `subscribe` / `prompt` / `abort` / `steer` straight through, and answers
 * `list_models` / `set_model` / status queries against the `pi-ai` model
 * registry. The bridge itself never imports the model libraries — keeping
 * that coupling here is what lets the dispatcher be tested against a fake.
 */

import harden from '@endo/harden';

import { getModels, getProviders } from '@earendil-works/pi-ai';

import { resolveModel } from '../agent/index.js';

/** @import { Agent as PiAgent } from '@earendil-works/pi-agent-core' */
/** @import { ModelInfo, Session } from './types.js' */

/**
 * @param {object} options
 * @param {PiAgent} options.piAgent
 * @returns {Session}
 */
export const makeGenieRpcSession = ({ piAgent }) => {
  return harden({
    subscribe: listener => piAgent.subscribe(listener),
    prompt: message => piAgent.prompt(message),
    abort: () => piAgent.abort(),
    steer: message => piAgent.steer({ role: 'user', content: message }),
    describeModel: () => {
      const model = piAgent.state.model;
      return model?.name ?? model?.id ?? 'unknown';
    },
    listModels: () => {
      const providers = getProviders();
      /** @type {ModelInfo[]} */
      const models = [];
      for (const provider of providers) {
        try {
          for (const model of getModels(provider)) {
            models.push({ provider, id: model.id, name: model.name });
          }
        } catch {
          // A provider whose model set cannot be enumerated is reported by
          // name only; skip its models rather than failing the whole query.
        }
      }
      return { providers: [...providers], models };
    },
    setModel: async ({ provider, model }) => {
      const resolved = await resolveModel(`${provider}/${model}`);
      piAgent.state.model = resolved;
    },
  });
};
harden(makeGenieRpcSession);
