// @ts-check
/**
 * `subscriptionEffort` (M4 W4.1; m4-interfaces 5.4, H-6; R4-21..R4-23): the
 * last `createSession` resolver. The optional session effort is checked by a pool's
 * `resolveEffort`, whose answer is stored (absent: none); any other backend
 * refuses an effort. Factory bundle: imports texts only (1.4).
 */
import { limits } from '../lib/limits.js';
import { subscriptionTexts } from '../lib/subscription-texts.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { OptionResolver } from './session-options.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** @type {OptionResolver} */
export const subscriptionEffort = async (options, resolved) => {
  /** @type {Record<string, any>} */
  const fields = resolved;
  const given = options.reasoningEffort;
  const kind = resolved.backendKind;
  if (kind !== 'claude-pool' && kind !== 'codex-pool') {
    if (given !== undefined) throw Error(subscriptionTexts.effortNotSupported);
    return;
  }
  const answer = await E(resolved.backend).resolveEffort(
    harden(
      given === undefined
        ? { modelId: resolved.modelId }
        : { modelId: resolved.modelId, reasoningEffort: given },
    ),
  );
  // `EffortAnswer`, checked without the M4 guards.
  const keys = Object.keys(answer ?? 0);
  const effort = answer?.reasoningEffort;
  if (
    typeof answer !== 'object' ||
    answer === null ||
    keys.length > 1 ||
    (keys.length === 1 && effort === undefined) ||
    (effort !== undefined &&
      (typeof effort !== 'string' || effort.length > limits.effortUnits))
  )
    throw Error(subscriptionTexts.unsupportedEffort);
  if (effort === undefined) delete fields.reasoningEffort;
  else fields.reasoningEffort = effort;
};
harden(subscriptionEffort);
