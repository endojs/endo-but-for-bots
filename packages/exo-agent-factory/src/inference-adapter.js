// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { InferLimitsShape, InferResultShape } from '@endo/inference/guards.js';
import { M, getInterfaceGuardPayload } from '@endo/patterns';

import {
  INFERENCE_SOURCE_NAME,
  INSTRUCTIONS_NAME,
} from './inference-driver.js';
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

const InferenceAgentDriverMakerInterface = M.interface(
  'InferenceAgentDriverMaker',
  {
    ...getInterfaceGuardPayload(AgentDriverMakerInterface).methodGuards,
    childInference: M.call(M.remotable()).returns(M.remotable()),
  },
);

/**
 * Make an `AgentDriverMaker` for an `@endo/inference` backend.
 *
 * The driver receives a narrower `ChildInference` capability, not the backend
 * or its credential source, and the child's instructions, which the driver
 * prefixes to each turn's prompt. Each call derives a fresh projection from the
 * child capability before invoking the backend. This pins catalog membership
 * for one turn while keeping credentials wholly inside the backend boundary.
 *
 * A daemon stores only values it can name by formula, so the driver guest
 * cannot retain a `ChildInference` minted here. It retains the maker itself,
 * which is the deployer's durable caplet, and each runner incarnation asks it
 * for its child's grant with `childInference`. That method confers nothing
 * `installDriver` does not already: either one, given a guest, yields a grant
 * scoped to that guest.
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
}) => {
  /** @param {any} agent */
  const childInference = agent =>
    makeExo('ChildInference', ChildInferenceInterface, {
      /**
       * @param {{ prompt: string, limits: InferLimits, cancelled: PromiseLike<unknown>, promptOrigin?: string, model?: string }} request
       * @returns {Promise<InferResult>}
       */
      async infer(request) {
        const guest = await makeGuestToolProjection(agent);
        return E(backend).infer(harden({ ...request, guest }));
      },
    });

  const maker = makeExo(
    'InferenceAgentDriverMaker',
    InferenceAgentDriverMakerInterface,
    {
      /** @param {{ agent: any, driverGuest: any, instructions?: string }} context */
      async installDriver({ agent, driverGuest, instructions }) {
        await E(driverGuest).storeValue(agent, 'agent');
        await E(driverGuest).storeValue(maker, INFERENCE_SOURCE_NAME);
        if (instructions !== undefined) {
          await E(driverGuest).storeValue(instructions, INSTRUCTIONS_NAME);
        }
        return harden({
          specifier: driverSpecifier,
          ...(Object.keys(environment).length > 0
            ? { env: harden({ ...environment }) }
            : {}),
        });
      },
      /** @param {any} agent */
      childInference(agent) {
        return childInference(agent);
      },
    },
  );
  return maker;
};
harden(makeInferenceAgentDriverMaker);
