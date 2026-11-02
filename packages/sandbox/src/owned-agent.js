// @ts-check

import { makeNoHostScratch } from './no-host-scratch.js';
import { makeOwnedNativeService } from './owned-native-service.js';
import { readRuntimeConfig } from './runtime-config.js';
import { makeSandboxRuntime } from './runtime.js';

/** @import { SandboxPowers } from './types.js' */
/** @typedef {ReturnType<typeof makeSandboxRuntime>} Runtime */

/**
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
  /**
   * @param {ReturnType<typeof readRuntimeConfig>} config
   * @param {SandboxPowers | null} scratchProvider
   * @param {Record<string, string>} env
   */
  const makeKit = (config, scratchProvider, env) => {
    const runtime = makeRuntime(
      { ...config, env },
      {
        // An adapter minted with no powers grants no host scratch, which is
        // not the same as having no provider: `factory.make` requires one
        // before it builds anything, and a null closes the attested path
        // outright. Fill the slot with a capability that refuses, so the
        // runtime says "this grants nothing" rather than "this is broken".
        scratchProvider: scratchProvider ?? makeNoHostScratch(),
      },
    );
    return harden({ open: () => openRuntime(runtime), close: runtime.close });
  };
  return makeOwnedNativeService({
    readConfig: readRuntimeConfig,
    makeKit,
    reportError,
  });
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
