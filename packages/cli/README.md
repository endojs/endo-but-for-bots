# Endo CLI

The Endo command line is a user interface for managing the Endo application
runner (daemon).
This includes managing the lifecycle of the daemon process.

## In-flight design work

The CLI's `store`-family verbs are being reshaped under the design
[`designs/cli-store-verb-text-modes.md`](../../designs/cli-store-verb-text-modes.md).
That design unifies the source/sink, representation, and
formula-vs-mount axes across `endo store` and a new `endo write` /
`endo read` pair for mount-path mutation.
The implementation lands on a `master`-base PR; this entry is a tracking
placeholder on the `llm` roadmap branch and will be removed when the
implementation lands.

## Bounded Git remotes

`endo git-remote provision` binds an existing daemon-minted `Git` capability,
credential capability, and fixed HTTPS endpoint into a named `GitRemote`.
The command previews the complete grant and asks for approval unless `--yes`
is given.
It offers two closed profiles:

- `fetch-only` fetches branches into the named remote-tracking namespace and
  grants no push target.
- `agent` adds push authority for `refs/heads/agent/*`, or for the narrower
  branch patterns given with repeatable `--branch` options.

Both profiles deny force pushes, tags, and deletion.
Credential material is never accepted on the command line; `--credential`
names an existing non-extractable credential capability.

```sh
endo git-remote provision repo-git origin \
  --url https://github.com/endojs/endo.git \
  --profile agent \
  --branch review/my-change \
  --credential github-token

endo git-remote inspect origin
endo git-remote inspect origin --json
```

Omit `--url` to enter the endpoint interactively.
Inspection reports the fixed endpoint, effective fetch and push refspecs,
revocation state, force/tag/delete policy, and credential health without
revealing credential material.
