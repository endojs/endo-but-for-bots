// @ts-check
/**
 * The section table of a session's system prompt (M5 W5.2; R4-26 parts 1
 * to 7, R5-52; `designs/m5-interfaces.md` 2.3.1 and 11). Hook table:
 * append-only for later milestones.
 *
 * Each entry is `{ part, name, applies(context), text(context) }` with
 * `context = { spoken, snapshot, userInitiated }` (`snapshot` is the
 * creation's `PresetSnapshot`, data only, or undefined). The composer
 * (`system-prompt-base.js` `composeSystemPrompt`) takes the entries whose
 * `applies` is true, in part order (entries of one part in table order),
 * drops empty texts and joins the rest with one blank line, then removes
 * trailing white space (Fae `composePresetPrompt`). An entry's text starts
 * with its first word and ends without a blank line, so the join alone
 * separates parts; the introduction keeps Fae's own trailing line break
 * (the spoken one has it), word for word.
 *
 * M5's entries: part 1 `introduction` (Floot's plain or spoken
 * introduction), part 2 `guestSection` (Fae's guest section, rewritten for
 * the persistent exec scope and M5's per-call `powers`, with the object
 * tools M5 offers), part 3 `environment` (empty on every live session:
 * every backend is the provider API's environment, R4-26) and part 7
 * `instructions` (the preset snapshot's free text, when set). Parts 4
 * (delegation, M9), 5 (widget protocol, M12) and 6 (object-kind sections,
 * M6) are appended by the milestones that build what they describe.
 *
 * Texts ported from Fae `session/system-prompt.js` and Floot
 * `src/voice-prompt.js` at 1315bef86. Not Fae's words: the capability
 * paragraph (`capabilityParagraph`), the exec paragraph (`execParagraph`,
 * M2) and the object-tools list (`objectToolsSection`, after Fae's
 * "Petstore tools:" list), each journaled (J-0472, J-0740).
 *
 * The composed text is ASCII except for the em dashes Fae writes, kept
 * here as `\u2014` escapes (guest rule: ASCII outside comments).
 *
 * Guest rules: prelude globals only; texts are built once at module load.
 */
import { environmentPromptSections } from './environment-prompt.js';

/** U+2014 EM DASH, as Fae writes it. */
const DASH = '\u2014';

/**
 * Floot's introduction (`floot/src/voice-prompt.js`): spoken sessions get
 * the voice rules (R5-52).
 * @param {boolean} spoken
 */
export const flootIntroduction = spoken =>
  spoken
    ? `You are Floot, a warm, concise voice assistant living inside the Endo daemon.
Your replies are spoken aloud, so:
- Keep responses short and conversational ${DASH} usually one to three sentences.
- Avoid markdown, code blocks, bullet lists, and emoji; write as you would speak.
- Answer directly. Speak plain summaries; never read code, secrets, or raw tool output aloud.
`
    : 'You are Floot, a warm, concise assistant living inside the Endo daemon.';
harden(flootIntroduction);

/**
 * The capability paragraph, rewritten for M5's per-call `powers` (Fae's
 * said only "reach a capability through `powers` (your guest interface) or
 * by looking one up"): `powers` is the call's view of the session's label
 * map, with exactly `lookup`, `list`, `store` and `remove`.
 */
export const capabilityParagraph = `How the environment works: everything around you is an object capability. A
capability is a live remote object, not data ${DASH} you act by CALLING its methods,
not by reading its fields. In exec, \`powers\` is that call's view of your
petstore: \`await E(powers).lookup(petName)\` gives the object (or the stored
data) held under a petname, \`E(powers).list()\` the petnames,
\`E(powers).store(petName, value)\` keeps an object or plain data under a new
petname (remove a petname before reusing it), and \`E(powers).remove(petName)\`
forgets one. Call methods with eventual-send:
\`const x = await E(ref).someMethod(args)\`. Always \`await\` and always go
through \`E(...)\` for capability calls.
`;

/**
 * The exec paragraph, rewritten for the harness's persistent scope (M2
 * W2.6, J-0472): Fae's exec ran each call as a fresh function body.
 */
export const execParagraph = `A petname is a name in your petstore, not a variable in exec. Every exec call
runs as the body of an async function in one scope that persists: top-level
\`const\` and \`let\` belong to the call that declares them, but a value you assign
to \`globalThis\` (\`globalThis.notes = ...\`) is still there in later calls, across
turns and restarts. Only \`powers\`, \`E\`, \`harden\`, \`console\` and \`sleep\` are
passed to each call, and they belong to that call: keep values on \`globalThis\`,
not these. So each call looks up the capabilities it uses first ${DASH}
\`const thing = await E(powers).lookup('thing')\`. A name you never declared does
not throw; it reads as undefined, and the error you then get is
\`Cannot deliver "someMethod" to target; typeof target is "undefined"\`. exec has
no \`import\` or \`require\` and no Node built-ins: whatever is outside comes
through a capability.
`;

/**
 * The object tools as M5 offers them (after Fae's "Petstore tools:" list
 * in its tools section, whose rest is part 4). `describeCapability` and
 * `readSources` exist only with an exec vat, `adopt` and `adoptTool` only
 * matter while a message's package is open, so the list says the tool list
 * decides.
 */
export const objectToolsSection = `Petstore tools (use the ones in your tool list):
- list ${DASH} see the petnames currently in your petstore.
- lookup ${DASH} show what a petname holds: stored data as its value, an object as
  its callable methods (nothing is called).
- store ${DASH} save a JSON value under a new petname for later; keep an object
  with \`E(powers).store\` in exec.
- remove ${DASH} forget a petname. The object itself is not revoked.
- describeCapability ${DASH} read an object's methods and documentation before
  calling it; readSources ${DASH} read source text from an object that offers it.
- adopt and adoptTool ${DASH} when a message attaches objects, keep one under a
  petname or make one a tool you can call, during that turn.
- exec ${DASH} run JavaScript with your guest powers in scope as \`powers\`. This is
  your most general power: call any daemon capability, do math, transform data.
  Reach for it whenever no other tool fits.
`;

/**
 * Part 2, the guest section (Fae `guestSection()`): Fae's text with the
 * capability and exec paragraphs rewritten, then the object tools. Starts
 * and ends with a line break, as Fae's.
 */
export const guestSection = `
You live inside the Endo daemon as a guest with your own petstore ${DASH} a private
namespace of named capabilities (objects you can call). You have tools to work
with it. Report what you did and what came of it plainly; quote code or tool
output only when the reader needs to see it.

${capabilityParagraph}
${execParagraph}
For visual pages, scenes, and interfaces, verify the rendered result before claiming
it works. Discover an available browser capability or use Playwright/Chromium through
your granted shell. Render at desktop and mobile sizes, collect console/page errors,
save screenshots to a readable Endo workspace or mount, and use viewImage to inspect
them. Fix visible defects and render again. A syntax check does not verify rendering.
If browser access, shell execution, or image input is unavailable, say what could not
be verified; do not claim you saw the result. Do not publish merely to obtain a
screenshot unless publishing is part of the user's request.

When a tool result is itself a capability it shows as
\`[remote capability] callable methods: [...]\` listing the methods you can call
${DASH} that is a usable object, not an empty result. To work with it, look it up (or
store it) and call one of those methods via exec. Plain data (strings, numbers,
JSON) shows as its value.

${objectToolsSection}`;

/**
 * Leading line breaks and trailing white space removed.
 * @param {string} text
 */
const trimmed = text => text.replace(/^\n+/, '').trimEnd();

const guestText = trimmed(guestSection);

/**
 * @typedef {object} PromptContext
 * @property {boolean} spoken the session was created spoken (R5-52)
 * @property {any} [snapshot] the creation's `PresetSnapshot` (data only)
 * @property {boolean} [userInitiated] a session the operator created (M9
 *   sets false for subagents; no M5 entry reads it)
 */

/**
 * @typedef {object} PromptSection
 * @property {number} part R4-26's part number (1..7)
 * @property {string} name
 * @property {(context: PromptContext) => boolean} applies
 * @property {(context: PromptContext) => string} text
 */

/** @type {PromptSection} */
const introduction = harden({
  part: 1,
  name: 'introduction',
  applies: () => true,
  text: ({ spoken }) => flootIntroduction(spoken === true),
});

/** @type {PromptSection} */
const guest = harden({
  part: 2,
  name: 'guestSection',
  applies: () => true,
  text: () => guestText,
});

/**
 * Part 3: Fae's environment section speaks only to a backend that renames
 * Endo's tools or runs its own (a sandbox); every harness backend is the
 * provider API's environment, so it is empty on every session (R4-26).
 * @type {PromptSection}
 */
const environment = harden({
  part: 3,
  name: 'environment',
  applies: () => false,
  text: () => '',
});

/**
 * Part 7: the preset's free text, as the operator typed it (Fae
 * `[presetPrompt, instructions].filter(Boolean)`).
 * @param {PromptContext} context
 */
const instructionsOf = ({ snapshot }) => {
  const text = snapshot?.instructions;
  return typeof text === 'string' ? text : '';
};

/** @type {PromptSection} */
const instructions = harden({
  part: 7,
  name: 'instructions',
  applies: context => instructionsOf(context) !== '',
  text: instructionsOf,
});

/** Hook table (append-only): parts 4, 5 and 6 come from M9, M12 and M6. */
export const promptSections = harden([
  introduction,
  guest,
  environment,
  instructions,
  // Part 6: the git workspace and shell (`environment-prompt.js`).
  ...environmentPromptSections,
]);
