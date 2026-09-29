// @ts-check
//
// Subscription pooling across concurrent guests (§ Pooling subscriptions, DD5).
//
// The allocator maps onto the `ClaudeCredentials` caplet's ACTUAL interface —
// `issue(sessionTag)` / `revoke(sessionTag)` with a single-shot `materialise()` —
// not a nonexistent `release(issued)`. Two facts drive the shape:
//
//   - `sessionTag` is minted uniquely PER SPAWN (not per guest): two concurrent
//     `infer` calls against the same guest must carry distinct tags, or one
//     call's `revoke` in its `finally` would invalidate the other's live grant.
//   - return-to-pool is ALLOCATOR-OWNED occupancy bookkeeping freed in a
//     `finally` on every exit path. `revoke(sessionTag)` is only the
//     invalidate-on-FAILURE path: on the happy path `materialise()` has already
//     emptied the caplet's `outstanding`, so a later `revoke` is a no-op. The
//     slot is freed by the pool regardless of whether `revoke` had anything to
//     cancel.
//
// Admission is REJECT-WITH-A-TAG, not block-and-queue: an unbounded queue would
// strand pending prompts in harness memory. `acquire` failing to find a free slot
// resolves to `{ type: 'pool-exhausted' }`.

import { makeError, X, q } from '@endo/errors';

/** @import { AcquireResult, InternalSlot, Subscription } from './claude.types.js' */

/**
 * The default selection policy: least-recently-issued free, non-cooling
 * subscription, so utilization stays roughly level across accounts.
 *
 * @param {ReadonlyArray<InternalSlot>} slots
 * @param {number} nowMs
 * @returns {InternalSlot | undefined}
 */
const leastRecentlyUsed = (slots, nowMs) => {
  /** @type {InternalSlot | undefined} */
  let best;
  for (const slot of slots) {
    const available = !slot.busy && slot.coolingUntil <= nowMs;
    if (
      available &&
      (best === undefined || slot.lastIssuedAt < best.lastIssuedAt)
    ) {
      best = slot;
    }
  }
  return best;
};

/**
 * @param {object} params
 * @param {ReadonlyArray<Subscription>} params.subscriptions
 * @param {(slots: ReadonlyArray<InternalSlot>, nowMs: number) => (InternalSlot | undefined)} [params.selectSubscription]
 * @param {() => number} [params.now]
 */
export const makeCredentialsPool = ({
  subscriptions,
  selectSubscription = leastRecentlyUsed,
  now = () => Date.now(),
}) => {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    throw makeError(X`makeCredentialsPool: at least one subscription required`);
  }
  /** @type {InternalSlot[]} */
  const slots = [];
  const seen = new Set();
  for (const sub of subscriptions) {
    if (typeof sub.id !== 'string' || sub.id.length === 0) {
      throw makeError(X`subscription id must be a non-empty string`);
    }
    if (seen.has(sub.id)) {
      throw makeError(X`duplicate subscription id ${q(sub.id)}`);
    }
    seen.add(sub.id);
    slots.push({
      id: sub.id,
      credentials: sub.credentials,
      busy: false,
      coolingUntil: 0,
      lastIssuedAt: 0,
    });
  }

  const slotById = new Map(slots.map(s => [s.id, s]));

  /**
   * Acquire a credential for one spawn. `sessionTag` MUST be unique per spawn.
   *
   * @param {string} sessionTag
   * @returns {Promise<AcquireResult>}
   */
  const acquire = async sessionTag => {
    if (typeof sessionTag !== 'string' || sessionTag.length === 0) {
      throw makeError(X`acquire: sessionTag must be a non-empty string`);
    }
    const nowMs = now();
    // A shallow copy (not `harden`ed): `harden` is transitive and would freeze
    // the live slot objects the allocator mutates. The policy is harness-owned
    // and only reads these.
    const slot = selectSubscription([...slots], nowMs);
    if (slot === undefined) {
      // Reject-with-a-tag: compute a hint at when a cooling slot frees, if every
      // slot is merely cooling (as opposed to busy).
      let soonest = Infinity;
      let anyBusy = false;
      for (const s of slots) {
        if (s.busy) anyBusy = true;
        else if (s.coolingUntil > nowMs) {
          soonest = Math.min(soonest, s.coolingUntil - nowMs);
        }
      }
      return harden(
        anyBusy || soonest === Infinity
          ? { type: 'pool-exhausted' }
          : { type: 'pool-exhausted', retryAfterMs: soonest },
      );
    }

    // Reserve the slot BEFORE the eventual-send, so a concurrent acquire cannot
    // pick the same slot while `issue` is in flight.
    slot.busy = true;
    slot.lastIssuedAt = nowMs;

    let released = false;
    /** @type {(opts?: { failed?: boolean }) => Promise<void>} */
    const release = async () => {
      await null; // await-separator: keep the first await unnested.
      if (released) return;
      released = true;
      // Free the occupancy slot ALWAYS — this is the line that keeps a failed
      // inference from stranding a subscription.
      slot.busy = false;
      // Invalidate-on-failure: a no-op on the happy path (materialise already
      // emptied `outstanding`); best-effort, never throws out of `finally`.
      try {
        await slot.credentials.revoke(sessionTag);
      } catch {
        // A revoke that throws must not mask the real outcome or re-strand the
        // slot (already freed above).
      }
    };

    await null; // await-separator: keep the first (issue) await unnested.
    let issued;
    try {
      issued = await slot.credentials.issue(sessionTag);
    } catch (err) {
      // `issue` failed: free the slot and surface the error to the caller, which
      // maps it into the failure taxonomy.
      await release();
      throw err;
    }

    return harden({
      type: 'acquired',
      subscriptionId: slot.id,
      issued,
      release,
    });
  };

  /**
   * Mark a subscription cooling until `untilMs` (e.g. on a detected rate-limit
   * response), so the policy skips it until it resets.
   *
   * @param {string} id
   * @param {number} untilMs
   */
  const markCooling = (id, untilMs) => {
    const slot = slotById.get(id);
    if (slot === undefined) {
      throw makeError(X`markCooling: unknown subscription ${q(id)}`);
    }
    if (!Number.isFinite(untilMs)) {
      throw makeError(X`markCooling: untilMs must be finite`);
    }
    slot.coolingUntil = untilMs;
  };

  /**
   * Occupancy snapshot for assertions / observability.
   *
   * @returns {{ total: number, free: number, busy: number, cooling: number }}
   */
  const stats = () => {
    const nowMs = now();
    let free = 0;
    let busy = 0;
    let cooling = 0;
    for (const s of slots) {
      if (s.busy) busy += 1;
      else if (s.coolingUntil > nowMs) cooling += 1;
      else free += 1;
    }
    return harden({ total: slots.length, free, busy, cooling });
  };

  return harden({ acquire, markCooling, stats });
};
harden(makeCredentialsPool);

/**
 * Render the minimal `--settings` file whose SOLE key is an `apiKeyHelper` — the
 * one credential path `--bare` honors. The helper's argv is harness-fixed and
 * carries no prompt- or guest-derived bytes (§ The apiKeyHelper is an execution
 * grant, not a value).
 *
 * NOTE (DD7 residual): the pooled credential the helper emits lives INSIDE the
 * confinement boundary; `0600` on this file guards another local reader, not the
 * confined process itself. A harness-side egress proxy or per-guest credentials
 * is the named resolution — see the README and the design's Known Gaps.
 *
 * @param {string} apiKeyHelperCommand  Absolute path (plus fixed args, space-free
 *   or a single token) to the harness-owned helper that emits the credential.
 * @returns {Readonly<{ apiKeyHelper: string }>}
 */
export const renderApiKeyHelperSettings = apiKeyHelperCommand => {
  if (
    typeof apiKeyHelperCommand !== 'string' ||
    apiKeyHelperCommand.length === 0
  ) {
    throw makeError(
      X`renderApiKeyHelperSettings: helper command must be a non-empty string`,
    );
  }
  if (/[\r\n]/.test(apiKeyHelperCommand)) {
    throw makeError(
      X`renderApiKeyHelperSettings: helper command must be newline-free`,
    );
  }
  return harden({ apiKeyHelper: apiKeyHelperCommand });
};
harden(renderApiKeyHelperSettings);
