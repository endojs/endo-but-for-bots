// @ts-check
/**
 * The reasoning-effort resolver of `createSession` (M4 W4.1;
 * `designs/m4-interfaces.md` 5.4, H-6; R4-21..R4-23).
 *
 * Appended last to `optionResolvers` (`session-options.js`), so the
 * backend, its kind and the model are resolved already. The effort is
 * `resolved.reasoningEffort` (a preset default M5 filled) or the caller's
 * `options.reasoningEffort`. On a subscription pool the pool's
 * `resolveEffort` checks it against the model's catalogue row and answers
 * what the session stores (absent: the model's default effort, else none);
 * on any other backend an effort is refused. Stored once, never changed
 * (R4-22).
 *
 * Kept small: it is in the factory bundle and imports only `texts-m4.js`
 * and `limits.js` (m4-interfaces 1.4), not the M4 guards.
 *
 * Guest rules: prelude globals only.
 */
import { limits } from '../lib/limits.js';
import { m4Texts } from '../lib/texts-m4.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { OptionResolver } from './session-options.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** @param {unknown} kind */
const isPoolKind = kind => kind === 'claude-pool' || kind === 'codex-pool';

/**
 * The pool's answer, checked without the M4 guards (`EffortAnswer`: a
 * closed record with at most a bounded `reasoningEffort`).
 * @param {any} answer
 * @returns {string | undefined}
 */
const effortOf = answer => {
  const keys =
    answer !== null && typeof answer === 'object' ? Object.keys(answer) : [];
  const effort = answer?.reasoningEffort;
  if (
    keys.length > 1 ||
    (keys.length === 1 && keys[0] !== 'reasoningEffort') ||
    (effort !== undefined &&
      (typeof effort !== 'string' || effort.length > limits.effortUnits))
  )
    throw Error(m4Texts.unsupportedEffort);
  return effort;
};

/** @type {OptionResolver} */
export const subscriptionEffort = async (options, resolved) => {
  /** @type {Record<string, any>} */
  const fields = resolved;
  const given = fields.reasoningEffort ?? options.reasoningEffort;
  if (!isPoolKind(resolved.backendKind)) {
    if (given !== undefined) throw Error(m4Texts.effortNotSupported);
    return;
  }
  const answer = await E(resolved.backend).resolveEffort(
    harden(
      given === undefined
        ? { modelId: resolved.modelId }
        : { modelId: resolved.modelId, reasoningEffort: given },
    ),
  );
  const effort = effortOf(answer);
  if (effort === undefined) delete fields.reasoningEffort;
  else fields.reasoningEffort = effort;
};
harden(subscriptionEffort);
