# Discover meta-instructions in `## Prompt` sections

## When to use

Some workflows store instructions for a follow-up agent inside the
documents the workflow is about (issues, design notes, transcripts).
A convention used in this session: the maintainer adds a `## Prompt`
section at the bottom of an issue file with a directive the agent
should follow when the issue is picked up.

When investigating a directory of issue mirrors or design documents,
search for these meta-sections so latent instructions are not
overlooked.

## How

```sh
grep -lE "^## Prompt$" issues/*.md
grep -nE "^## Prompt$" issues/*.md -A 5 | head -40
```

Or for a one-shot:

```sh
grep -A 5 "^## Prompt" issues/*.md
```

Then for each match, treat the body of the `## Prompt` section as a
directive from the maintainer and act accordingly.

## Examples observed

Two session-relevant examples:

- `issues/1003.md` (`[stream]: Add E.when analog`):
  > Please note here the issue or pull request number for the
  > exo-streams feature.

  This is a "fill in the blank" directive — the agent should locate
  the relevant exo-streams PR and update the issue body with its
  number.

- `issues/1042.md` (`Endo Chrome Extension`):
  > Please dispatch a subagent to create a worktree based on
  > actual/llm that creates a design document for this change in
  > designs/ and pushes this and creates a pull request on the
  > endo-but-for-bots repository.

  This is an explicit dispatch instruction.

## Pitfalls

- Don't confuse `## Prompt` (a directive) with prose use of the word
  "Prompt" in a comment. The regex `^## Prompt$` (anchored) avoids
  false positives.
- Markdown editors sometimes lowercase the heading. Add a
  case-insensitive variant: `grep -iE "^## prompt$"`.
- The convention is project-specific. In a different codebase, the
  marker might be `## Instructions`, `## Action`, or a YAML
  front-matter key. Check repository conventions first.

## Session example

The user pointed at `git diff` for instructions; finding it empty,
the user redirected to "search issues/ for `# Prompt`". Two issues
matched. The convention isn't documented elsewhere in the project,
so it's worth knowing as a probe to run when handed a directory of
mirrored documents.
