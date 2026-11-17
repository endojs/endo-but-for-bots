---
'@endo/prompt-templates': minor
'@endo/spaces-util': minor
'@endo/chat': minor
---

Add reusable prompt templates to the Chat command bar, implementing the `endopi-prompt-templates` design. A markdown file in a prompt directory (`~/.pi/agent/prompts`, `~/.agents/prompts`, `.agents/prompts`, or `.pi/prompts`) appears in the `/` menu under its file name. Selecting one expands its text into the editor without sending anything. Placeholders follow Pi's grammar (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`) and take arguments split by Pi's quoting rules from the slash line; an `argument-hint` frontmatter key labels the arguments, and the command form prompts for any required one left unfilled. The new `@endo/prompt-templates` package holds the parser, substitution, and discovery; run `yarn setup-prompt-templates` in `packages/chat` to grant Chat read-only access to the directories.
