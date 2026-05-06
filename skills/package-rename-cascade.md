# Package rename cascade

## Trigger

A reviewer or design decision asks to rename a workspace
package: `@endo/old-name` -> `@endo/new-name`, or
`packages/old/` -> `packages/new/`.

## Why

A package rename touches a surprising number of surfaces
beyond `package.json:name` and the source identifiers. Missing
any of them leaves the workspace in a half-renamed state where
imports still resolve under the old name, error messages refer
to the wrong identity, the changeset entry registers under the
wrong key, or the AVA test file's name diverges from the
package.

## Sweep checklist

- **Package directory** under `packages/`: `git mv packages/<old> packages/<new>`.
- **`package.json`** fields:
  - `name`
  - `homepage`
  - `repository.directory`
- **AVA test file**: `test/<old>.test.js` -> `test/<new>.test.js` so
  the file name still matches the package.
- **Changeset file**: `.changeset/<old>-*.md`. Rename and update the
  package name on the YAML front-matter line.
- **Error-message text** that names the package (e.g.
  `Invalid <pkg> length prefix`). These are between identifier
  and prose and easy to miss with an `*Reader` / `*Writer`
  grep.
- **Companion design document** under `designs/`, if the
  rename flows from a name decision recorded there.
- **`yarn.lock`**: regenerate after the package.json rename.
  Lockfile commit ships separately per
  [`yarn-lock-separate-commit.md`](./yarn-lock-separate-commit.md).
- **Cross-package consumers**: `grep -rln '@endo/<old-name>' packages/`
  before pushing.

## Verification

After the sweep:

```sh
grep -rn '<old-name>' packages/ designs/ .changeset/ yarn.lock
```

should return only intentional historical references (e.g. an
"originally named X" line in a design's candidates table or
the verbatim `## Prompt` block). Anything else is a missed
rename.

## Session example

PR 29 renamed `@endo/syrup-frame` to `@endo/syrups`. The cascade
was 5 atomic commits + the lockfile commit:
package directory move, identifier rename
(`makeSyrupFrame{Reader,Writer,Iterator}` ->
`makeSyrups{...}`), README/CHANGELOG/changeset rename + em-dash
sweep, design doc rename, `chore: Update yarn.lock`. No
cross-package consumer changes (the package had no consumers
yet); on a renamed package with consumers, the consumer-import
sweep would be a sixth commit.
