// @ts-check
/**
 * The fixed parts of a session's system prompt (M2 W2.6; R4-26 parts 1, 2
 * and 7, R4-27, R4-28; `designs/m2-interfaces.md` 10).
 *
 * Ported from Fae `session/system-prompt.js` and Floot
 * `src/voice-prompt.js` at 1315bef86, word for word, with one exception:
 *
 * - Part 1, the introduction: Floot's spoken introduction (voice rules) for
 *   a session created spoken, else the plain Floot introduction
 *   (`flootIntroduction`).
 * - Part 2, the guest section (`guestSection`). Its exec paragraph ("A
 *   petname is a name in your petstore ...") is rewritten for the
 *   persistent scope (architecture 6, D-11): Fae's exec ran each call as a
 *   fresh function body; the harness keeps one Compartment per session whose
 *   `globalThis` persists across calls, turns and restarts, while top-level
 *   `const`/`let` and the endowments stay per call (a deviation, journaled).
 * - Parts 3 to 6 are not in M2: the environment section is empty on every
 *   live session (provider environment), and the tools section, the widget
 *   protocol and the preset's object-kind sections arrive with the tools
 *   and presets they describe (M5 and later; `guest/session/prompt.js`
 *   moves to M5).
 * - Part 7, the preset's free-text instructions, appended below a blank
 *   line when set (Fae `session-factory.js` 3955-3965: `[presetPrompt,
 *   instructions].filter(Boolean).join('\n\n')`). M2's `chat-only` preset
 *   has none.
 *
 * The composed text is ASCII except for the em dashes Fae writes, kept here
 * as `\u2014` escapes (guest rule: ASCII outside comments).
 *
 * Guest rules: prelude globals only; the parts are built once per call by
 * joining an array (no string growth in a loop).
 */

/** U+2014 EM DASH, as Fae writes it. */
const DASH = '\u2014';

/**
 * Floot's introduction (`floot/src/voice-prompt.js`): spoken sessions get
 * the voice rules.
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
 * The exec paragraph, rewritten for the harness's persistent scope (the one
 * part of the guest section that is not Fae's text).
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
 * Part 2, the guest section (Fae `guestSection()`), with the persistent
 * scope's exec paragraph. Starts and ends with a line break, as Fae's.
 */
export const guestSection = `
You live inside the Endo daemon as a guest with your own petstore ${DASH} a private
namespace of named capabilities (objects you can call). You have tools to work
with it. Report what you did and what came of it plainly; quote code or tool
output only when the reader needs to see it.

How the environment works: everything around you is an object capability. A
capability is a live remote object, not data ${DASH} you act by CALLING its methods,
not by reading its fields. In exec, reach a capability through \`powers\` (your
guest interface) or by looking one up, and call methods with eventual-send:
\`const x = await E(ref).someMethod(args)\`. Always \`await\` and always go
through \`E(...)\` for capability calls.

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
`;

/**
 * The composed system prompt (R4-26): introduction, a line break, the guest
 * section, trailing white space removed (Fae `composePresetPrompt`); then
 * the preset's free text below a blank line when it has any (part 7).
 *
 * @param {object} options
 * @param {boolean} options.spoken the session was created spoken (R4-27)
 * @param {string} [options.presetText] the preset's free-text instructions
 * @returns {string}
 */
export const composeSystemPrompt = ({ spoken, presetText }) => {
  const base = [flootIntroduction(spoken === true), '\n', guestSection]
    .join('')
    .trimEnd();
  return [base, presetText].filter(Boolean).join('\n\n');
};
harden(composeSystemPrompt);
