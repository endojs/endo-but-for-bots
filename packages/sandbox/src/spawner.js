// @ts-check

/**
 * The slice-to-`Spawner` adapter used by `@endo/exo-shell`.  The one
 * implementation lives in `@endo/host-spawner`, beside the host engine it
 * stands in for; this module re-exports it so existing importers keep their
 * specifier.
 */
export {
  DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT,
  makeSandboxSpawner,
} from '@endo/host-spawner/src/sandbox-spawner.js';
