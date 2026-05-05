# Em-dash prose rule

## The rule

Avoid em-dashes (`—`, U+2014) in prose. Prefer separate sentences,
parentheses, or colons. In technical documentation, em-dashes
obscure the rhythm of the prose and almost always read better as
their own sentence.

The rule covers prose only. Em-dashes inside code formatting
(quoting the character itself, regex literals, ASCII art) are fine.
En-dashes (`–`, U+2013) for numeric ranges (`80–100`) are also fine.
Table-cell sentinels are also fine: rows like `| ~~name~~ | — | — |
... | Done |` use `—` as a "not applicable" placeholder for size and
duration columns in `designs/README.md`, and that is the existing
repo convention. Do not sweep them; only sweep prose your PR adds or
modifies.

## Where it lives

Repo-side: `AGENTS.md` "Prose style" section on `endojs/endo` master
captures the rule for upstream contributors.

Local-side: `CLAUDE.md` "Code Style" section captures the same rule
for agents operating in `endojs/endo-but-for-bots` and downstream.

## How to sweep

When addressing an em-dash review note, sweep the new prose:

```sh
grep -nE "—" packages/<changed-files>
```

Replace each instance with one of:

- A period: `Foo bar — baz qux.` → `Foo bar. Baz qux.`
- Parentheses: `Foo bar — baz qux — quux.` → `Foo bar (baz qux)
  quux.`
- A colon: `Foo bar — baz qux.` → `Foo bar: baz qux.`

Pick by reading; mechanical substitution often reads worse than the
original.

## Pitfalls

- Many existing files in older parts of the codebase use em-dashes
  freely. Do **not** sweep them in a passing PR; only sweep the
  prose your PR actually adds or modifies. Sweeping the rest is its
  own PR.
- The rule does not apply to prose written by other contributors in
  reviewed-but-not-yet-merged commits. Sweep your own commits, not
  upstream's.
- Editors/markdown renderers occasionally substitute three-hyphen
  sequences with em-dashes via "smart punctuation". Disable smart
  quotes in your editor if you find phantom em-dashes appearing in
  diffs.

## Session origin

Introduced in kriskowal's review on PR 68: "Generally avoid
em-dashes. Please integrate that feedback into CLAUDE.md in the
style guide." The rule shipped to `AGENTS.md` on the bots-repo PR
68 branch (commit `cb8d6286ab`) and to local `CLAUDE.md` (the
triage branch). Subsequent agent prompts cite the rule in their
"project conventions" section.
