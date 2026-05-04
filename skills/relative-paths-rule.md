# Relative paths and links

## The rule

Every link, every cross-reference, and every path in a documentation
file must be **relative**, never absolute.

This covers:

- Markdown links: `[text](./skills/foo.md)`, not
  `[text](/home/kris/triage/skills/foo.md)`.
- Inline code references in prose: `` `./packages/foo/src/bar.js` ``
  or `` `packages/foo/src/bar.js` ``, not
  `` `/home/kris/triage/packages/foo/src/bar.js` ``.
- Sample commands shown in skill files: `ls changes/*.md`, not
  `ls /home/kris/triage/changes/*.md`.
- Session examples that cite a path: `process/UNLINKED-TODOS.md`,
  not `/home/kris/triage/process/UNLINKED-TODOS.md`.

External URLs (`https://github.com/...`, RFC links, package
registry URLs) are not affected; they are always absolute by
nature.

## Why

Absolute paths bake in the developer's working-directory layout.
A document that says `/home/kris/triage/changes/3056.md` is wrong
on every machine but one. The same path written as
`changes/3056.md` works wherever the document is read, including
from a fork, a clone, a tarball, or a GitHub web view.

For markdown links, the relative form also lets GitHub's web
renderer resolve cross-document links into navigable links rather
than 404s.

## How to write paths

Inside a `.md` file at `<root>/<dir>/<file>.md`, write:

- `./sibling.md` for a same-directory file.
- `../other-dir/foo.md` for a sibling directory.
- `../../some-package/README.md` to reach up two levels.
- `packages/foo/src/bar.js` (no leading `./`) when the path is
  inline-code prose, not a markdown link target. Both forms
  are fine for prose; pick one and stick with it within a file.

## Pitfalls

- **Sample commands.** Tutorials sometimes paste `cd
  /home/kris/triage` because the agent ran the command from there.
  Rewrite as `cd <repo-root>` or omit the `cd` entirely.
- **Tool output.** Pasted output from `find`, `grep -rn`, or a
  `git status` listing often includes absolute paths. Strip the
  prefix before pasting.
- **Cross-repo references.** When a file legitimately needs to
  point at a sibling repo (`../endo`, `../endo-but-for-bots`),
  use a relative path with `..` rather than an absolute machine
  path.
- **Symlink resolution.** If a directory you cite is a symlink,
  the relative path still works as long as the linked target
  exists; absolute paths into the symlink's target leak the
  developer's filesystem layout.

## When absolute *is* fine

- External HTTPS URLs.
- Git refs (`refs/heads/foo`).
- Filesystem paths inside generated tooling output that the
  document is showing verbatim (clearly marked as such).

In all three cases, the path is part of the content being shown,
not a navigation aid the reader follows.
