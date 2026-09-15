// @ts-check
import { Fail } from '@endo/errors';

const defaults = harden({
  workspaceBytes: 8n * 1024n ** 3n,
  stateBytes: 4n * 1024n ** 3n,
});

/** Operator-only reductions of the standard per-session disk limits.
 * @param {{workspaceBytes: bigint, stateBytes: bigint}} [limits]
 */
export const normalizeCodexVolumeLimits = (limits = defaults) => {
  Object.keys(limits).sort().join(',') === 'stateBytes,workspaceBytes' ||
    Fail`Unexpected Codex volume limits`;
  for (const key of /** @type {const} */ (['workspaceBytes', 'stateBytes'])) {
    (typeof limits[key] === 'bigint' &&
      limits[key] > 0n &&
      limits[key] % 1024n ** 2n === 0n &&
      limits[key] <= defaults[key]) ||
      Fail`Codex volume limits must be positive MiB-aligned reductions`;
  }
  return harden({
    workspaceBytes: limits.workspaceBytes,
    stateBytes: limits.stateBytes,
  });
};
harden(normalizeCodexVolumeLimits);
