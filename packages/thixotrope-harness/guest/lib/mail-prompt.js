// @ts-check
/**
 * The system prompt's mail and delegation sections (R4-26 parts 2 and 4;
 * `designs/m9-interfaces.md` seam F7), appended to the section table in
 * `prompt-sections.js`.
 *
 * Texts ported from Fae `session/system-prompt.js` `toolsSection()` at
 * 1315bef86:
 * - part 2, `mailTools`: Fae's "Mail tools" list with the harness's mail
 *   and request tools (`dismiss`, `resolveRequest`, `rejectRequest`,
 *   `submitForm`) and the recipient `user` (the operator) added, and without Fae's
 *   raw-mailbox paragraph, which describes Endo mailbox promises
 *   (`dismissed`, `settled`, `done`) the harness never exposes. Its last
 *   two sentences, which describe the runner's own reply and dismissal,
 *   stay word for word;
 * - part 4, `delegation`: Fae's "Delegation" paragraph word for word except
 *   "These Endo tools" -> "These tools". It speaks only "when
 *   spawnSubagent, askSubagent, and stopSubagent are listed among your
 *   tools", so it applies to every session, as in Fae; a session at the
 *   depth limit is offered none of them (R4-69).
 *
 * The texts are ASCII except Fae's em dash, written as `\u2014`.
 *
 * Guest rules: prelude globals only; texts are built once at module load.
 */

/** U+2014 EM DASH, as Fae writes it. */
const DASH = '\u2014';

/** Part 2 after the guest section: the mail and request tools. */
export const mailToolsSection = `Mail tools ${DASH} other agents and people can send you messages, optionally with
objects attached:
- listMessages ${DASH} read your inbox. Each message has a number, sender, text, and
  the edge names of any attached objects.
- adopt ${DASH} take an attached object into your petstore by giving the message
  number and the object's edge name, plus a petname to file it under.
- send ${DASH} send a message (and optionally objects) to another party; send to
  \`user\` to reach the person who operates this harness.
- reply ${DASH} respond to a message by its number.
- dismiss ${DASH} remove a message you have finished with.
- resolveRequest, rejectRequest and submitForm ${DASH} answer a request or a form
  you were sent, by its message number.
The session runner replies to your incoming task
and dismisses it after you finish: do not wait for or dismiss that task yourself.
Early dismissal removes the entry needed by reply(number).`;

/** Part 4: delegation to subagents (Fae's words). */
export const delegationSection = `Delegation ${DASH} when spawnSubagent, askSubagent, and stopSubagent are listed among
your tools, you may hand a self-contained piece of work to a helper agent:
- spawnSubagent ${DASH} create one, giving it standing instructions for its role.
- askSubagent ${DASH} mail it a task and wait for its reply. It cannot see this
  conversation, so put everything it needs in the task.
- stopSubagent ${DASH} release it once its work is done.
These tools are the delegation mechanism. Do not use a harness-native
spawn_agent, agent, or task tool to create helpers; those helpers do not have
Endo-managed sessions, capability grants, or recovery records.
Use this only for distinct, bounded tasks that materially advance the answer.
Do work you can simply do yourself. A helper has no additional tools, web access,
source code, or evidence unless explicitly supplied. Do not delegate to compensate
for missing capabilities, or spawn chains of fact checkers repeating the same
question. State what you cannot verify instead. Give each helper a narrower scope
and a concrete stopping condition; reuse it for follow-ups. All descendants share
a finite tree budget. If a limit is reached, finish with available results rather
than cycling through replacement agents. Synthesize the replies and release your
helpers when finished.`;

/**
 * A subagent's role (D-M9-26): the session program adds it to every round's
 * system text of a session whose `SessionConfig.userInitiated` is false
 * (every subagent, R4-69), so a child knows it is one however its brief is
 * worded: the mail body it receives carries no sign of its sender. Not a
 * composed section: the factory composes a subagent's stored prompt, so a
 * section there would reach only a freshly provisioned state; the round's
 * system text is the session program's and arrives with a program load.
 * It reconciles the Delegation section's "Do work you can simply do
 * yourself" with a preset that delegates everything: a subagent does its
 * task itself. Its heading is what preset texts key on
 * (`scripts/project-preset.mjs` `subagentRoleHeading`).
 */
export const subagentRoleSection = `Subagent role ${DASH} you are a subagent: a parent session created you with
spawnSubagent, and every task you receive comes from it through askSubagent,
which answers it with your reply. Do the task yourself; your instructions'
advice to delegate is for the parent, not for you. Spawn subagents of your own
only when the brief asks for it. Your reply is what the parent receives: give it
what it needs to check your work, and say plainly what you could not do.`;

/**
 * The two entries (`prompt-sections.js` `PromptSection`): every session
 * holds a mailbox (`SessionServices.mail`), and the delegation text names
 * its own condition.
 */
export const mailPromptSections = harden([
  harden({
    part: 2,
    name: 'mailTools',
    applies: () => true,
    text: () => mailToolsSection,
  }),
  harden({
    part: 4,
    name: 'delegation',
    applies: () => true,
    text: () => delegationSection,
  }),
]);
