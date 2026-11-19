// @ts-check
/**
 * Part 6 of the system prompt for a session with a git workspace and,
 * when selected, a shell (R4-26 part 6; `designs/m6-interfaces.md` 3.9,
 * seam P-1). Appended to `prompt-sections.js` `promptSections`.
 *
 * The text is Fae's workspace section (`fae/session/system-prompt.js`
 * `workspaceSection` at `1315bef86`) adapted to this harness's objects:
 * the `Git` capability has no `worktree()` (open decision O-7), so files
 * are written by commands in the shell, where the working tree is
 * `/workspace`; a session without a shell reads files and records history
 * through the capability only, and the text says so. Fae's publishing
 * paragraph belongs to workspace publishing (M10) and is left out.
 *
 * Which variant applies is read from the creation's preset snapshot
 * (data: its `objects` kinds), so the text names exactly the objects the
 * session gets.
 *
 * Guest rules: prelude globals only; ASCII outside comments; texts built
 * once at module load.
 */

/** @import { PromptSection } from './prompt-sections.js' */

/** U+2014 EM DASH, as Fae writes it. */
const DASH = '\u2014';

/**
 * The object kinds a preset selects for an environment (the template
 * table's kinds, `guest/factory/preset-templates.js`).
 */
export const environmentKinds = harden({
  workspace: 'git-workspace',
  shell: 'development-environment',
});

const lookupLine = `Your petstore holds a writable, git-backed project workspace under the petname
"workspace", on branch \`main\`. Reach it in exec with
\`const workspace = await E(powers).lookup('workspace')\` ${DASH} it is a petname in
your petstore, not a variable, so every exec call that uses it starts with that
lookup.`;

const shellLines = `- The workspace's working tree is ALSO \`/workspace\`, the working directory of
  your shell. Create and edit files there with commands: the runCommand tool
  runs one allowlisted command with its \`args\` (no shell syntax unless the
  allowlist offers a shell), and inspectShell reports the allowlist, the
  default timeout and the output cap. In exec the same shell is the petname
  "shell": \`await E(shell).runCommand(command, args)\`.
- Your shell's home directory keeps installed tools across turns; the shell
  has no network. A command and the capability see one repository: what one
  commits, the other sees.
- Stage and commit through the capability rather than with \`git\` in the
  shell, which may have no author identity configured.`;

const readOnlyLines = `- This session has no shell: through the capability you read files and record
  history, but you cannot write files.`;

const commonLines = `- \`E(workspace).read({ path: ['src', 'main.js'] })\` reads lines of a file (the
  readSources tool does the same with petName "workspace"). A path is an array
  of segments; \`..\` and \`.git\` are refused.
- \`E(workspace).status()\` returns \`{ branch, entries, truncated }\`; each entry
  is copy data with \`path\`, \`index\`, and \`worktree\` fields, and \`truncated\`
  tells you whether the result was limited. \`E(workspace).diff()\` inspects
  changes and \`E(workspace).log()\` the history.
- To stage one desired row: \`const result = await E(workspace).status(); const row = result.entries.find(({ path }) => path === "src/main.js"); if (!row) throw new Error("row not found"); await E(workspace).add([row.path])\`.
  Then \`E(workspace).commit(message)\` records them. Branches: createBranch,
  switchBranch and merge; the workspace has no remote.
Build what the user asks for in the workspace, committing as you reach working
states. Summarize what you did briefly and plainly.`;

const withShell = [lookupLine, shellLines, commonLines].join('\n');
const withoutShell = [lookupLine, readOnlyLines, commonLines].join('\n');

/**
 * Whether the snapshot selects an object of `kind`.
 * @param {any} snapshot a `PresetSnapshot` or undefined
 * @param {string} kind
 */
export const selectsKind = (snapshot, kind) =>
  Array.isArray(snapshot?.objects) &&
  snapshot.objects.some((/** @type {any} */ object) => object?.kind === kind);
harden(selectsKind);

/**
 * The part 6 text for a snapshot: the shell variant when it selects a
 * shell, the read-only one for a workspace alone, else empty.
 * @param {any} snapshot
 */
export const environmentPromptText = snapshot => {
  if (selectsKind(snapshot, environmentKinds.shell)) return withShell;
  if (selectsKind(snapshot, environmentKinds.workspace)) return withoutShell;
  return '';
};
harden(environmentPromptText);

/**
 * Part 6 entries (`PromptSection`s; `prompt-sections.js` typedef).
 * @type {readonly PromptSection[]}
 */
export const environmentPromptSections = harden([
  harden({
    part: 6,
    name: 'workspace',
    applies: (/** @type {any} */ { snapshot }) =>
      environmentPromptText(snapshot) !== '',
    text: (/** @type {any} */ { snapshot }) => environmentPromptText(snapshot),
  }),
]);
