// @ts-check
/**
 * The session's system prompt at creation (M2 W2.6, owned by M5 W5.2 since
 * the presets; R4-26, R4-27, R4-28; `designs/m2-interfaces.md` 10,
 * `designs/m5-interfaces.md` 2.3.1). Runs in the factory bundle.
 *
 * `promptResolver` is the W2.6 entry of `guest/factory/session-options.js`
 * `optionResolvers`; it runs in the factory vat after the preset snapshot
 * is resolved and fills `resolved.systemPrompt`:
 *
 * - `systemPrompt` given: it replaces the composed prompt entirely (R4-27);
 *   a blank one (empty or white space only) fails creation with
 *   `texts.blankSystemPrompt`, before any row or vat is made (R4-6).
 * - otherwise the composition of `guest/lib/system-prompt-base.js` over the
 *   section table `guest/lib/prompt-sections.js` from the resolved preset
 *   snapshot (part 7 is its `instructions`), spoken when `spoken: true` was
 *   given.
 * - a prompt over `inlineBytes` is staged through
 *   `E(context.admin).writersFor()` (no session yet: the session holds the
 *   StagedText from its first use, M1b 17.3), in pieces of at most
 *   `blobPieceBytes` (each within frameBytes), one answered append each.
 *   The factory passes `admin` in the resolver context (W2.7's factory
 *   line); without it such a prompt fails with `textOf.notBuilt`.
 *
 * The session stores the result in `SessionConfig.systemPrompt` (the
 * factory copies it, W2.7) and sends it with every round (seam 1 of
 * m2-interfaces.md 2.4, W2.5); edits reach only new sessions (R4-28).
 *
 * Guest rules: prelude globals only.
 */
import { texts, textOf } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import { chunkText, utf8Bytes } from '../lib/bounded.js';
import { composeSystemPrompt } from '../lib/system-prompt-base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Stage `text` as a Blob for no session yet (the factory's prompt).
 * @param {any} admin AgentHostAdmin
 * @param {string} text
 * @returns {Promise<any>} a StagedText
 */
export const stagePrompt = async (admin, text) => {
  const writers = await E(admin).writersFor();
  const writer = await E(writers).open();
  try {
    for (const piece of chunkText(text, limits.blobPieceBytes)) {
      // One answered piece at a time: no message over frameBytes, no burst.
      // eslint-disable-next-line no-await-in-loop
      await E(writer).append(piece);
    }
    return await E(writer).close();
  } catch (error) {
    E.sendOnly(writer).abort();
    throw error;
  }
};
harden(stagePrompt);

/**
 * The prompt text a creation asks for (R4-26, R4-27): the given one, or the
 * fixed composition.
 * @param {Record<string, any>} options the guarded CreateOptions
 * @param {{ presetSnapshot?: any }} resolved
 * @returns {string}
 */
export const promptTextFor = (options, resolved) => {
  if (options.systemPrompt !== undefined) {
    const given = options.systemPrompt;
    if (typeof given !== 'string' || given.trim() === '') {
      throw Error(texts.blankSystemPrompt);
    }
    return given;
  }
  return composeSystemPrompt({
    spoken: options.spoken === true,
    snapshot: resolved.presetSnapshot,
  });
};
harden(promptTextFor);

/**
 * The W2.6 option resolver (hook-table entry).
 * @param {Record<string, any>} options
 * @param {Record<string, any>} resolved filled in place: `systemPrompt`
 * @param {{ admin?: any }} context
 */
export const promptResolver = async (options, resolved, context) => {
  const text = promptTextFor(options, resolved);
  if (utf8Bytes(text) <= limits.inlineBytes) {
    resolved.systemPrompt = text;
    return;
  }
  if (context.admin === undefined) {
    throw Error(textOf.notBuilt('createSession systemPrompt over inlineBytes'));
  }
  resolved.systemPrompt = await stagePrompt(context.admin, text);
};
harden(promptResolver);
