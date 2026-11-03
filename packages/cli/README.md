# Endo CLI

The Endo command line is a user interface for managing the Endo application
runner (daemon).
This includes managing the lifecycle of the daemon process.

## Packages

A package bundles agent resources under one `package.json` key, and
`endo install` places them all with one command.
The verbs in this section touch only files, so they do not start the daemon.

```json
{
  "name": "my-endo-package",
  "keywords": ["endo-package"],
  "endo": {
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

Without an `endo` key, a directory named `skills`, `prompts`, `guests`, or
`providers` at the package root is a resource directory.
Unknown keys are ignored.

```sh
endo install npm:@foo/bar
endo install npm:@foo/bar@1.2.3
endo install git:github.com/user/repo
endo install git:github.com/user/repo@v1
endo install ./my-package
endo install --project npm:@foo/bar

endo list packages
endo config disable npm:@foo/bar
endo config enable npm:@foo/bar
endo update
endo remove npm:@foo/bar
```

A skill directory `skills/<name>/` with a `SKILL.md` lands in
`~/.agents/skills/<name>/`, and a prompt `prompts/<name>.md` lands in
`~/.agents/prompts/<name>.md`.
With `--project`, the `.agents` directory of the current directory is used
instead.
The ledger of installs is `.agents/endo-packages/packages.json`.

`guests` and `providers` directories are reported but not installed, because
the CLI has no guest-plugin store or provider registry to place them in.

Installing does not run package code: npm lifecycle scripts stay off, and a
package containing a symbolic link is refused.
Installing also refuses to overwrite a resource that another package or the
user put in place, and a refused package changes nothing.
A disabled package's resources move to `.agents/endo-packages/disabled/`, out
of the paths that discovery reads.
`endo update` fetches every unpinned install again.
An exact npm version or any git reference pins an install; installing the same
package with another version moves the pin.

## In-flight design work

The CLI's `store`-family verbs are being reshaped under the design
[`designs/cli-store-verb-text-modes.md`](../../designs/cli-store-verb-text-modes.md).
That design unifies the source/sink, representation, and
formula-vs-mount axes across `endo store` and a new `endo write` /
`endo read` pair for mount-path mutation.
The implementation lands on a `master`-base PR; this entry is a tracking
placeholder on the `llm` roadmap branch and will be removed when the
implementation lands.
