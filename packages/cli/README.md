# Endo CLI

The Endo command line is a user interface for managing the Endo application
runner (daemon).
This includes managing the lifecycle of the daemon process.

## Bounded Git remotes

`endo git-remote provision` binds an existing daemon-minted `Git` capability,
credential capability, and fixed HTTPS endpoint into a named `GitRemote`.
The command previews the complete grant and asks for approval unless `--yes`
is given.
The grant model is described in
[`designs/daemon-git-remotes.md`](../../designs/daemon-git-remotes.md).
It offers two closed profiles:

- `fetch-only` fetches branches into the named remote-tracking namespace and
  grants no push target.
- `agent` adds push authority for `refs/heads/agent/*`, or for the narrower
  branch patterns given with repeatable `--branch` options.

Both profiles deny force pushes, tags, and deletion.
The endpoint must be an `https:` URL without embedded credentials.
Each `--branch` must name a branch or a `refs/heads/<parent>/*` namespace;
selectors under other ref namespaces, a bare `*` that would grant every
branch, and names `git check-ref-format` refuses are rejected.
The endpoint, credential name, and branch selectors may not contain control
or Unicode bidirectional-control characters, which could rewrite the approval
preview on a terminal.
The preview's push targets are derived by the same `@endo/exo-git` policy
normalizer the minted remote enforces.
The approval preview names the credential but cannot vouch for its health;
the inspection printed after provisioning reports it.
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

Omit `--url` to enter the endpoint interactively; `--yes` requires `--url`.
The preview and prompts are written to stderr, so `--json` output on stdout
is a single JSON document.
Inspection reports the fixed endpoint, effective fetch and push refspecs,
default pull ref, revocation state, force/tag/delete and local-file transport
policy, and credential health without revealing credential material.
Text output escapes any control characters the daemon reports, so a remote or
credential minted elsewhere cannot forge inspection lines.
A revoked remote no longer answers credential health, so its inspection
reports the policy alone, including when revocation lands while inspection is
in progress.

## In-flight design work

The CLI's `store`-family verbs are being reshaped under the design
[`designs/cli-store-verb-text-modes.md`](../../designs/cli-store-verb-text-modes.md).
That design unifies the source/sink, representation, and
formula-vs-mount axes across `endo store` and a new `endo write` /
`endo read` pair for mount-path mutation.
The implementation lands on a `master`-base PR; this entry is a tracking
placeholder on the `llm` roadmap branch and will be removed when the
implementation lands.
