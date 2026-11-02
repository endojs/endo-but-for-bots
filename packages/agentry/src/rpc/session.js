// @ts-check
/// <reference types="ses"/>

/**
 * A {@link Session} backed by a live `PiAgent`.
 *
 * This adapts the raw `pi-agent-core` `Agent` (as constructed by the
 * harness `makePiAgent`) to the narrow seam the RPC bridge drives. The
 * session is an exo whose interface guard admits only that seam's shapes, so
 * the bridge (and the less-trusted wire host behind it) never holds the live
 * agent itself. The bridge itself never imports the model libraries —
 * keeping that coupling here is what lets the dispatcher be tested against a
 * fake.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';

import { resolveModel } from '../harness/model.js';

/** @import { Agent as PiAgent } from '@earendil-works/pi-agent-core' */
/** @import { ModelInfo, Session } from './types.js' */

/**
 * @param {object} options
 * @param {PiAgent} options.piAgent
 * @returns {Session}
 */
const RpcSessionI = M.interface('RpcSession', {
  // The listener is a host-local closure, not a passable, so it and the
  // returned unsubscribe function cross the guard raw.
  subscribe: M.call(M.raw()).returns(M.raw()),
  prompt: M.callWhen(M.string()).returns(M.undefined()),
  abort: M.call().returns(M.undefined()),
  steer: M.call(M.string()).returns(M.undefined()),
  describeModel: M.call().returns(M.string()),
  listModels: M.call().returns(M.record()),
  setModel: M.callWhen(
    M.splitRecord({ provider: M.string(), model: M.string() }),
  ).returns(M.undefined()),
});

/**
 * @param {object} options
 * @param {PiAgent} options.piAgent
 * @returns {Session}
 */
export const makeRpcSession = ({ piAgent }) => {
  return makeExo('RpcSession', RpcSessionI, {
    subscribe(listener) {
      return piAgent.subscribe(listener);
    },
    async prompt(message) {
      await piAgent.prompt(message);
    },
    abort() {
      piAgent.abort();
    },
    steer(message) {
      piAgent.steer({ role: 'user', content: message, timestamp: Date.now() });
    },
    describeModel() {
      const model = piAgent.state.model;
      return model?.name ?? model?.id ?? 'unknown';
    },
    listModels() {
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
      return harden({ providers: [...providers], models });
    },
    async setModel({ provider, model }) {
      const resolved = await resolveModel(`${provider}/${model}`);
      // The harness's `resolveModel` yields `undefined` for an unknown
      // provider or model rather than throwing; refuse it so a typo cannot
      // clear the live agent's model and leave the next round without one.
      if (resolved === undefined) {
        throw Error(`unknown model: ${provider}/${model}`);
      }
      piAgent.state.model = resolved;
    },
  });
};
harden(makeRpcSession);
