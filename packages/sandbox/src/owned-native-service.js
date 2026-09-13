// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { makeResourceRegistry } from './resource-registry.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { PromiseKit } from '@endo/promise-kit' */

/**
 * @typedef {object} Owner
 * @property {{close(): Promise<void>}} kit
 * @property {boolean} closing
 * @property {() => void} forget
 * @property {Promise<void>} [closeFlight]
 */

/**
 * Retain a native operator kit across formula cancellation and reconstruction.
 * The synchronous constructor must return an inert kit before any effects;
 * its open() may acquire resources only after this owner retains close().
 * A module instance shares its registry across invocations. Other workers or
 * module instances still require the kit's independent native exclusion.
 * This retention does not survive process loss or prove native crash recovery.
 *
 * @template Input
 * @template {{ownerId: string}} Config
 * @template Service
 * @param {object} options
 * @param {(env: Record<string, string>) => Config} options.readConfig
 * @param {(config: Config, input: Input, env: Record<string, string>) => {open(): Promise<Service>, close(): Promise<void>}} options.makeKit
 * @param {(error: unknown) => void} [options.reportError]
 */
export const makeOwnedNativeService = ({
  readConfig,
  makeKit,
  reportError = error => console.error('Native service cleanup pending', error),
}) => {
  const ordering = makeResourceRegistry();
  /** @type {Map<string, Owner>} */
  const owners = new Map();
  /**
   * @param {string} ownerId
   * @param {Owner} owner
   */
  const closeOwner = (ownerId, owner) => {
    owner.closing = true;
    owner.closeFlight ??= (async () => {
      await owner.kit.close();
      if (owners.get(ownerId) === owner) owners.delete(ownerId);
      owner.forget();
    })().catch(error => {
      owner.closeFlight = undefined;
      throw error;
    });
    return owner.closeFlight;
  };

  /**
   * @param {ERef<Input>} inputP
   * @param {ERef<{whenCancelled(): Promise<never>}>} context
   * @param {{env?: Record<string, string>}} [options]
   */
  const make = async (inputP, context, { env = {} } = {}) => {
    const config = readConfig(env);
    const { ownerId } = config;
    /** @type {Owner | undefined} */
    let ownRecord;
    /** @type {Promise<void> | undefined} */
    let termination;
    /** @type {Error | undefined} */
    let lost;
    const cancelled = /** @type {PromiseKit<never>} */ (makePromiseKit());
    void cancelled.promise.catch(() => undefined);
    const assertLive = () => {
      if (lost) throw lost;
    };
    const stopThis = () => {
      if (ownRecord) termination ??= closeOwner(ownerId, ownRecord);
      return termination;
    };
    const ownerLost = () => {
      lost ??= makeError(X`Native service owner cancelled or unreachable`);
      cancelled.reject(lost);
      // Reach this exact owner's pending opening outside its queue. Refused
      // or old callers have no authority to close a successor's retained kit.
      void stopThis()?.catch(reportError);
    };
    // Observe before waiting for input. Rejection, disconnection, and unexpected
    // fulfillment all mean the original context can no longer be observed.
    void E(context).whenCancelled().then(ownerLost, ownerLost);

    return ordering.inOrder(ownerId, async () => {
      await null;
      assertLive();
      const previous = owners.get(ownerId);
      if (previous) {
        previous.closing || Fail`Native service owner is already live`;
        await closeOwner(ownerId, previous);
      }
      assertLive();
      const input = await Promise.race([
        Promise.resolve(inputP),
        cancelled.promise,
      ]);
      assertLive();
      const kit = makeKit(config, input, env);
      ownRecord = {
        kit,
        closing: false,
        forget: () => {
          ownRecord = undefined;
          termination = undefined;
        },
      };
      owners.set(ownerId, ownRecord);
      try {
        const service = await kit.open();
        assertLive();
        return service;
      } catch (error) {
        try {
          await stopThis();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Native service construction failed; cleanup pending',
            { cause: cleanupError },
          );
        }
        throw error;
      }
    });
  };
  return harden(make);
};
harden(makeOwnedNativeService);
