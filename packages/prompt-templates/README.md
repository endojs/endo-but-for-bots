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
description: Review staged changes for one concern
argument-hint: <focus> [scope]
---
Review the ${2:-staged} changes for bugs, focusing on $1.
Extra notes from the user: ${@:3}
```

The format and placeholder grammar are Pi's, so a template written for Pi
expands the same way here.

- The file name without `.md` is the command name. It may contain letters,
  digits, `.`, `-`, and `_`, and cannot be the name of a built-in command.
- `description` is optional and defaults to the body's first non-empty line.
- `argument-hint` is optional. It is shown after the name in the `/` menu and
  labels the form fields: `<name>` is required, `[name]` is optional, and the
  *n*th token labels `$n`.
- Other frontmatter keys (for example `model:`) are ignored.

| Placeholder | Expands to |
|---|---|
| `$1`, `$2`, ... | The *n*th argument, or empty |
| `$@`, `$ARGUMENTS` | All arguments joined with one space |
| `${1:-default}` | The first argument, or `default` if absent or empty |
| `${@:-default}` | All arguments, or `default` if there are none |
| `${@:N}` | Arguments from position *N* (1-based) |
| `${@:N:L}` | *L* arguments from position *N* |

Substitution is a single pass, so an argument containing `$1` stays literal.
Other `$` text (`$PATH`, `$0`, a lone `$`) is kept as written; there is no
escape syntax.

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

- `/review` and Enter opens a form for the required `focus` (prefilled with
  any arguments already typed), then expands.
- `/review memory` and Enter expands directly; `scope` takes its default.
- A template without `argument-hint` expands directly when given arguments,
  and opens a form of optional `$1`...`$n` fields when given none.
- Whitespace separates arguments. A `'` or `"` at the start of an argument
  quotes it, so `/review "memory safety"` is one argument, while the
  apostrophe in `don't` is text. An unmatched quote is literal and a backslash
  never escapes.
- More arguments than the highest `$n` is an error, unless the template uses
  `$@`, `$ARGUMENTS`, or `${@...}` to take the rest.

## Modules

- `@endo/prompt-templates/parse.js`: `parsePromptTemplate`.
- `@endo/prompt-templates/substitute.js`: `analyzePlaceholders`,
  `substituteArguments`, `parseArgumentHint`, `parseCommandArguments`.
- `@endo/prompt-templates/load.js`: `loadPromptTemplates` reads any list of
  sources, each providing `list` and `readText`. Runs in the browser.
- `@endo/prompt-templates/node.js`: `listConventionalDirectories` (the
  home / repository / working-directory walker shared with `@endo/skills`),
  `listPromptTemplateDirectories`,
  `makeNodePromptTemplateSource`, and `discoverPromptTemplates` for Node.
