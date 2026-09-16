// @ts-check
import { Fail } from '@endo/errors';

const defaults = harden({
  stateBytes: 4n * 1024n ** 3n,
});

/**
 * Operator-only reductions of the standard per-session disk limits.
 *
 * Only the CLI's own home is a quota-backed volume. The workspace is the 9P
 * projection of a tree the session already has — its git worktree — so its
 * bytes are bounded wherever that tree lives, and a quota here would be a
 * ceiling on a volume nothing writes to
 * (`designs/hosted-agent-sandbox-unification.md`).
 *
 * @param {{stateBytes: bigint}} [limits]
 */
export const normalizeCodexVolumeLimits = (limits = defaults) => {
  Object.keys(limits).sort().join(',') === 'stateBytes' ||
    Fail`Unexpected Codex volume limits`;
  for (const key of /** @type {const} */ (['stateBytes'])) {
    (typeof limits[key] === 'bigint' &&
      limits[key] > 0n &&
      limits[key] % 1024n ** 2n === 0n &&
      limits[key] <= defaults[key]) ||
      Fail`Codex volume limits must be positive MiB-aligned reductions`;
  }
  return harden({ stateBytes: limits.stateBytes });
};
harden(normalizeCodexVolumeLimits);
