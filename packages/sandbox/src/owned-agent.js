// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { makeResourceRegistry } from './resource-registry.js';
import { readRuntimeConfig } from './runtime-config.js';
import { makeSandboxRuntime } from './runtime.js';

/** @import { SandboxPowers } from './types.js' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { PromiseKit } from '@endo/promise-kit' */
/** @typedef {ReturnType<typeof makeSandboxRuntime>} Runtime */
/** @typedef {{ runtime: Runtime, closing: boolean, forget(): void, closeFlight?: Promise<void> }} Owner */

/**
 * Build a daemon entrypoint with private cleanup retention. A native module
 * instance shares this registry across formula reconstructions; another worker
 * or module instance must still acquire the runtime's exclusive on-disk marker.
 * Failed shutdown stays owned until a subsequent construction retries it.
 * @template Result
 * @param {(runtime: Runtime) => Promise<Result>} openRuntime
 * @param {{ makeRuntime?: typeof makeSandboxRuntime, reportError?: (error: unknown) => void }} [powers]
 */
const makeOwnedEntrypoint = (
  openRuntime,
  {
    makeRuntime = makeSandboxRuntime,
    reportError = error =>
      console.error('Sandbox runtime cleanup pending', error),
  } = {},
) => {
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
      await owner.runtime.close();
      if (owners.get(ownerId) === owner) owners.delete(ownerId);
      owner.forget();
    })().catch(error => {
      owner.closeFlight = undefined;
      throw error;
    });
    return owner.closeFlight;
  };

  /**
   * @param {ERef<SandboxPowers>} scratchProvider
   * @param {ERef<{ whenCancelled(): Promise<never> }>} context
   * @param {{ env?: Record<string, string> }} [options]
   */
  const make = async (scratchProvider, context, { env = {} } = {}) => {
    const config = readRuntimeConfig(env);
    const { ownerId } = config;
    /** @type {Owner | undefined} */
    let ownRecord;
    /** @type {Promise<void> | undefined} */
    let termination;
    /** @type {Error | undefined} */
    let lost;
    const cancelled = /** @type {PromiseKit<never>} */ (makePromiseKit());
    // Cancellation can arrive before this call reaches the ordering queue.
    void cancelled.promise.catch(() => undefined);
    const assertLive = () => {
      if (lost) throw lost;
    };
    const stopThis = () => {
      if (ownRecord) termination ??= closeOwner(ownerId, ownRecord);
      return termination;
    };
    const ownerLost = () => {
      lost ??= makeError(X`Sandbox runtime owner cancelled or unreachable`);
      cancelled.reject(lost);
      // Never wait behind this invocation's own open. The exact record matters:
      // cancellation of an old or refused caller cannot stop its successor.
      void stopThis()?.catch(reportError);
    };
    // A daemon cancellation rejects. Missing methods, disconnection, and an
    // unexpected fulfillment all mean we cannot continue observing this owner.
    void E(context).whenCancelled().then(ownerLost, ownerLost);

    return ordering.inOrder(ownerId, async () => {
      await null;
      assertLive();
      const previous = owners.get(ownerId);
      if (previous) {
        previous.closing || Fail`Sandbox runtime owner is already live`;
        await closeOwner(ownerId, previous);
      }
      assertLive();
      // Waiting for daemon powers must not block a cancelled construction.
      const powers = await Promise.race([
        Promise.resolve(scratchProvider),
        cancelled.promise,
      ]);
      assertLive();
      const runtime = makeRuntime(
        { ...config, env },
        { scratchProvider: powers },
      );
      ownRecord = {
        runtime,
        closing: false,
        forget: () => {
          ownRecord = undefined;
          termination = undefined;
        },
      };
      owners.set(ownerId, ownRecord);
      try {
        const factory = await openRuntime(runtime);
        assertLive();
        return factory;
      } catch (error) {
        try {
          await stopThis();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Sandbox runtime construction failed; cleanup pending',
            { cause: cleanupError },
          );
        }
        throw error;
      }
    });
  };
  return harden(make);
};
/** @param {Parameters<typeof makeOwnedEntrypoint>[1]} [powers] */
export const makeOwnedSandboxAgent = powers =>
  makeOwnedEntrypoint(runtime => runtime.open(), powers);
harden(makeOwnedSandboxAgent);

/** Host-only entrypoint builder with the same retained operator lifetime. */
/** @param {Parameters<typeof makeOwnedEntrypoint>[1]} [powers] */
export const makeOwnedNativeSandboxAgent = powers =>
  makeOwnedEntrypoint(runtime => runtime.openNative(), powers);
harden(makeOwnedNativeSandboxAgent);

/** Host-only unconfined entrypoint; returns only the public sandbox factory. */
export const make = makeOwnedSandboxAgent();
harden(make);
