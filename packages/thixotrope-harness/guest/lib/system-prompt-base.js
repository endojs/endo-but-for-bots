// @ts-check
/**
 * The composed system prompt of a new session (M5 W5.2; R4-26, R4-27,
 * R4-28, R5-52; `designs/m5-interfaces.md` 2.3.1). M2 W2.6 built the fixed
 * parts here; M5 composes them from the section table
 * `guest/lib/prompt-sections.js`, which later milestones append to.
 *
 * `composeSystemPrompt(context)` takes every entry of `promptSections`
 * whose `applies(context)` is true, in part order (entries of one part in
 * table order), drops empty texts, joins the rest with one blank line and
 * removes trailing white space. For the M2 inputs the text is M2's
 * composition with M5's guest section (introduction, a blank line, the
 * guest section; the preset's text below a blank line).
 *
 * The prompt is composed once, in the factory vat at creation
 * (`guest/session/prompt.js`), stored in `SessionConfig.systemPrompt` and
 * never recomposed (R4-28).
 *
 * Guest rules: prelude globals only; one `join`, no string growth in a
 * loop.
 */
import { promptSections } from './prompt-sections.js';

export {
  capabilityParagraph,
  execParagraph,
  flootIntroduction,
  guestSection,
  objectToolsSection,
} from './prompt-sections.js';

/**
 * @import { PromptContext, PromptSection } from './prompt-sections.js'
 */

/**
 * The entries that apply, in part order; ties keep table order.
 * @param {PromptContext} context
 * @param {readonly PromptSection[]} sections
 */
const applying = (context, sections) =>
  sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.applies(context))
    .sort((a, b) => a.section.part - b.section.part || a.index - b.index)
    .map(({ section }) => section);

/**
 * The composed system prompt (R4-26).
 *
 * @param {object} options
 * @param {boolean} [options.spoken] the spoken introduction (R5-52). Since
 *   M11 (m11-interfaces.md 9.1) no creation passes `true` (sessions get
 *   the plain prompt, the voice rules travel with each spoken-mode
 *   message); the spoken path is kept, reached from tests only, as the
 *   word-for-word mirror of Floot's voice prompt the turn notes follow.
 * @param {any} [options.snapshot] the creation's `PresetSnapshot`; its
 *   `instructions` are part 7
 * @param {boolean} [options.userInitiated]
 * @param {string} [options.presetText] M2's form: the preset's free text,
 *   used when no `snapshot` is given
 * @param {readonly PromptSection[]} [sections] the table (tests)
 * @returns {string}
 */
export const composeSystemPrompt = (
  { spoken, snapshot, userInitiated, presetText },
  sections = promptSections,
) => {
  /** @type {PromptContext} */
  const context = harden({
    spoken: spoken === true,
    snapshot:
      snapshot ??
      (typeof presetText === 'string' && presetText !== ''
        ? { instructions: presetText }
        : undefined),
    userInitiated: userInitiated !== false,
  });
  return applying(context, sections)
    .map(section => section.text(context))
    .filter(text => text !== '')
    .join('\n\n')
    .trimEnd();
};
harden(composeSystemPrompt);
