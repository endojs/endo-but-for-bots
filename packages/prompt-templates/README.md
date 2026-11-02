# @endo/prompt-templates

Reusable user-prompt scaffolds: a markdown file becomes a `/` command that
expands into the Chat editor. Implements the
[endopi-prompt-templates](../../designs/endopi-prompt-templates.md) design.

A template only fills the editor. Nothing reaches an agent until the user reads
the text and presses Enter.

## Writing a template

`~/.pi/agent/prompts/review.md` is available as `/review`:

```markdown
---
description: Review code for a chosen concern
---
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

- The file name without `.md` is the command name. It may contain letters,
  digits, `-`, and `_`, and cannot be the name of a built-in command.
- `description` is optional and defaults to the body's first non-empty line.
- A variable is `{{name}}` or `{{ name }}`, where `name` starts with a letter and
  continues with letters, digits, `-`, and `_`. Other text in braces is literal,
  and so are Pi's `$1` and `$@`.

## Where templates live

Directories are scanned for direct `*.md` children. A later directory overrides
an earlier one on the same name:

1. `~/.pi/agent/prompts`
2. `~/.agents/prompts`
3. `.agents/prompts`, from the repository root down to the working directory
   (outside a repository, the working directory only)
4. `.pi/prompts` in the working directory

## Using templates in Chat

The browser cannot read the disk, so grant it the directories that exist:

```sh
cd packages/chat
PROMPT_TEMPLATES_CWD=/path/to/project yarn setup-prompt-templates
```

This creates a `prompt-templates` directory in your inventory holding a read-only
mount of each. Chat rereads them whenever `/` opens the menu, so a new or edited
file needs no further setup. Rerun the script if a directory is created or you
move to another project.

- `/review` and Enter prompts for `focus`, then expands.
- `/review memory` and Enter expands directly.
- Arguments split like a shell's, so `/review "memory safety"` is one argument.
  They fill variables in order of first appearance. Too many is an error.

## Modules

- `@endo/prompt-templates/parse.js`: `parsePromptTemplate`.
- `@endo/prompt-templates/substitute.js`: `extractVariables`,
  `substituteVariables`, `parseCommandArguments`, `bindArguments`.
- `@endo/prompt-templates/load.js`: `loadPromptTemplates` reads any list of
  sources, each providing `list` and `readText`. Runs in the browser.
- `@endo/prompt-templates/node.js`: `listPromptTemplateDirectories`,
  `makeNodePromptTemplateSource`, and `discoverPromptTemplates` for Node.
