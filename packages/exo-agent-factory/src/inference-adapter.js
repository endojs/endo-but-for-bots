// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { InferLimitsShape, InferResultShape } from '@endo/inference/guards.js';
import { M } from '@endo/patterns';

import { AgentDriverMakerInterface } from './interfaces.js';

/** @import { GuestToolProjection, InferenceBackend, InferLimits, InferResult } from '@endo/inference/types.js' */

const DriverInferRequestShape = M.splitRecord(
  {
    prompt: M.string(),
    limits: InferLimitsShape,
    cancelled: M.promise(),
  },
  { promptOrigin: M.string(), model: M.string() },
  {},
);

const ChildInferenceInterface = M.interface('ChildInference', {
  infer: M.callWhen(DriverInferRequestShape).returns(InferResultShape),
});

/**
 * Make an `AgentDriverMaker` for an `@endo/inference` backend.
 *
 * The driver receives a narrower `ChildInference` capability, not the backend
 * or its credential source. Each call derives a fresh projection from the
 * child capability before invoking the backend. This pins catalog membership
 * for one turn while keeping credentials wholly inside the backend boundary.
 *
 * @param {object} options
 * @param {InferenceBackend} options.backend
 * @param {(agent: any) => GuestToolProjection | Promise<GuestToolProjection>} options.makeGuestToolProjection
 * @param {string} [options.driverSpecifier]
 * @param {Record<string, string>} [options.environment]
 */
export const makeInferenceAgentDriverMaker = ({
  backend,
  makeGuestToolProjection,
  driverSpecifier = new URL('./inference-driver.js', import.meta.url).href,
  environment = {},
}) =>
  makeExo('InferenceAgentDriverMaker', AgentDriverMakerInterface, {
    /** @param {{ agent: any, driverGuest: any }} context */
    async installDriver({ agent, driverGuest }) {
      const childInference = makeExo(
        'ChildInference',
        ChildInferenceInterface,
        {
          /**
           * @param {{ prompt: string, limits: InferLimits, cancelled: PromiseLike<unknown>, promptOrigin?: string, model?: string }} request
           * @returns {Promise<InferResult>}
           */
          async infer(request) {
            const guest = await makeGuestToolProjection(agent);
            return E(backend).infer(harden({ ...request, guest }));
          },
        },
      );
      await E(driverGuest).storeValue(agent, 'agent');
      await E(driverGuest).storeValue(childInference, 'inference');
      return harden({
        specifier: driverSpecifier,
        ...(Object.keys(environment).length > 0
          ? { env: harden({ ...environment }) }
          : {}),
      });
    },
  });
harden(makeInferenceAgentDriverMaker);
