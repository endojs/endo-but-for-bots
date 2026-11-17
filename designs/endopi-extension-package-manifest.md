# EndoPi: Extension Package Manifest

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-11-17 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Parent** | [endopi](endopi.md) |

## Status

A first build is open as draft
[#1639](https://github.com/endojs/endo-but-for-bots/pull/1639).
It implements skills and prompts, but it predates the concrete capability
boundaries in the sibling skills and prompt-template designs.
This revision defines the package schema, lifecycle, failure behavior, and the
boundary between installing files and granting them to an agent.
It also records the changes the draft build needs in § *Delta for #1639*.

## Motivation

Pi packages bundle extension code, skills, prompt templates, and themes under
one key in `package.json`.
A single install command resolves the package and makes all supported resource
kinds available.
Authors do not publish through parallel channels, and users do not track a
separate install for every kind.

Endo now has concrete on-disk formats for
[skills](endopi-skills-markdown-format.md) and
[prompt templates](endopi-prompt-templates.md), but no common distribution
record.
The provider registry design also anticipates provider plug-ins.
The missing piece is a package convention and lifecycle that can grow as those
consumers land without turning package installation into code execution or an
implicit capability grant.

## Design

### Manifest

An extension package is an ordinary npm package with an optional `endo` object:

```json
{
  "name": "@example/review-agent",
  "version": "1.2.3",
  "keywords": ["endo-package", "endo-skill"],
  "endo": {
    "guests": ["./guests"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "providers": ["./providers"]
  }
}
```

Each value is an array of package-relative resource-root directories.
Absolute paths, paths that lexically leave the package, and paths whose real
location leaves the unpacked package are errors.
Each root must be a directory containing only regular files and directories;
symbolic links and special files refuse the whole install.

If the `endo` object is absent, existing top-level directories named
`guests`, `skills`, `prompts`, and `providers` are the defaults.
If the object is present, an omitted kind means none, which lets a package
override convention explicitly.
Unknown keys produce a warning and are otherwise ignored, so an older installer
can preserve a package that declares a resource kind it does not understand.

The resource roots contain the shapes owned by their consumer designs:

- A `skills` root contains direct child directories, each with a required
  `SKILL.md`, as specified by
  [endopi-skills-markdown-format](endopi-skills-markdown-format.md).
- A `prompts` root contains direct `*.md` children, as specified by
  [endopi-prompt-templates](endopi-prompt-templates.md).
- `guests` and `providers` are reserved roots.
  Their inner entry shape belongs to the guest and provider consumers, not this
  manifest parser.

Two roots of one kind may not contribute the same resource name.
Package resource names must also pass the owning consumer's validator before
any file becomes visible in a discovery directory.

`keywords` support npm search but carry no behavior.
The `endo` object is the authoritative declaration.

### Existing paths and the authority boundary

This design reuses the paths the sibling designs already establish.
It does not add a second discovery system.

An enabled skill is copied to `.agents/skills/<name>/` in the selected scope.
An enabled prompt is copied to `.agents/prompts/<name>.md`.
The skills and prompt-template setup commands may already have mounted those
parent directories read-only under an agent's `agent-skills` or
`prompt-templates` pet name.
If so, their documented reload rules make newly installed resources visible.
If not, installation grants the agent nothing.
The user still runs the setup command to choose the agent and project whose
files become readable capabilities.

There is no current guest plug-in store.
The old weblet-era `endo install` path was removed before this design, and the
current executable-code path is `endo archive` followed by `endo make` or
`endo run` with an explicit powers argument.
This package command does not revive the removed store and never calls those
execution commands.
It records `guests` as pending until a guest design specifies how an installed
entry becomes a source-only archive and how the user supplies its powers.

The provider registry in
[endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md) has
not settled a plug-in destination.
The installer likewise records `providers` as pending and never imports them.
A later provider phase must grant each provider its network and credential
capabilities structurally; a manifest cannot request or name ambient powers.

### Scopes and durable record

There are two install scopes:

- User scope uses `$HOME/.agents/`.
- Project scope uses `<project>/.agents/`, where `--project` selects the current
  working directory as `<project>`.

Each scope has one manager-owned directory,
`.agents/endo-packages/`, containing:

- `packages.json`, a versioned ledger;
- `content/<sha256>/`, the validated unpacked package tree;
- `disabled/skills/` and `disabled/prompts/` for installed but inactive
  resources; and
- `transactions/` for recovery of an interrupted mutation.

The ledger is keyed by the package's `name`; one scope cannot contain two
sources claiming the same package name.
Each record contains the canonical source, requested selector, resolved npm
version or Git commit, content digest, enabled flag, installed resource names
and digests, and pending resource roots.
`endo package list --json` exposes this record without exposing file contents.

The content copy makes an install stable after a registry tag or Git branch
moves and gives future guest and provider consumers the same validated input.
It is package-manager state, not an execution root.

### Sources and pinning

The source forms are:

```sh
endo install npm:@foo/bar
endo install npm:@foo/bar@1.2.3
endo install git:github.com/user/repo
endo install git:github.com/user/repo@v1
endo install file:../review-agent
endo install --project npm:@foo/bar
```

`npm:` accepts an npm package name plus an optional version, range, or tag.
The fetch uses `npm pack --ignore-scripts`; no lifecycle script runs.
An exact version is pinned.

`git:` accepts a host path plus an optional branch, tag, or commit.
The installer uses HTTPS with prompts, hooks, and submodules disabled, then
records the resolved commit.
Any explicit Git reference is pinned.

`file:` accepts a local directory and is unpinned.
The package is copied and validated just like a remote source, so subsequent
changes to the source directory do not mutate the install silently.

An unpinned install is eligible for `update`.
An update refetches, validates, and stages the whole package before replacing
the active version.
Pinned installs change only through another explicit `install` selecting a new
version or reference.

### Commands and lifecycle

`endo install` is the short spelling for `endo package install`.
The remaining lifecycle stays under one command group so it does not shadow a
daemon pet name such as `packages` or reinterpret `endo remove` arguments:

```sh
endo package install <source> [--project]
endo package list [--project] [--json]
endo package update [<package-name>...] [--project]
endo package disable <package-name> [--project]
endo package enable <package-name> [--project]
endo package remove <package-name> [--project]
```

Install is enabled by default because the command itself is the user's choice
to place text in that scope's discovery paths.
Disable moves manager-owned skills and prompts into the disabled area without
discarding the content or ledger record.
Enable validates ownership and moves them back.

Remove deletes only resources still byte-identical to the digests in the
ledger.
Update has the same protection before replacing an active resource.
If a user or another tool modified a managed file, the command refuses and
names the drift; `--force` is required to discard it.
The manager never overwrites a resource owned by another package or an
unmanaged file already present at the destination.

Every mutating command takes an exclusive lock for its scope.
It validates and copies into a same-filesystem staging directory, writes a
transaction record, moves resources, atomically replaces the ledger, and then
removes the transaction.
On the next package command, an unfinished transaction is rolled back before
new work begins.
A reported failure therefore leaves the previous install active, and a process
crash has a deterministic recovery path.

### Security

An extension package is an untrusted tree.
Install performs no module import, package script, Git hook, submodule checkout,
guest evaluation, provider registration, or network call beyond fetching the
named source.
Archive size, entry count, individual file size, and total expanded size are
bounded before content enters the package store.
Path containment is checked both before and after filesystem resolution.

Skills and prompts are not harmless merely because they are text.
They are model input and may attempt prompt injection.
The defenses are explicit installation, no overwrite of unmanaged files,
read-only delivery by the sibling setup paths, and the fact that text grants no
authority the receiving agent does not already hold.
Prompt expansion still requires the user to press Enter, as the prompt-template
design specifies.

Guests and providers are executable code, so installation alone never enables
them.
Their future consumers must require held capabilities for every protected
operation and must not translate a manifest name into authority.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Source -> package manager | npm, HTTPS Git, or local copy | Source grammar, bounds, and manifest validation | Content tree and ledger in `.agents/endo-packages` | Package manager owns transaction commit, rollback, update, and removal | Validated package tree plus resolved source identity |
| Package manager -> discovery paths | Copy or move of owned resources | Package enabled flag, name conflicts, and drift checks | Managed files in `.agents/skills` and `.agents/prompts` | Package manager commits file placement; user chooses install, enable, or disable | Skill directories and prompt files |
| Discovery paths -> daemon profile | Existing setup commands and read-only mounts | User chooses the agent and project to grant | Daemon-owned mount formulas | User creates or removes grants; daemon reconstructs them on restart | Read-only filesystem capabilities |
| Daemon profile -> Lal or Chat | Existing skill and template loaders | Consumer precedence, validation, and reload rules | Consumer snapshot or transcript, as owned by the sibling design | Lal owns round setup; Chat user owns the send decision | Skill descriptors or expanded prompt text |

The package manager owns package content, the ledger, and transaction recovery.
The daemon owns durable mount formulas, while the user owns the decision to
create or remove them.
The agent owns transcript persistence and replay; the package manager never
writes a transcript.
The package manager classifies fetch, validation, and transaction outcomes.
Future guest and provider runtimes classify execution outcomes and decide their
own restart behavior.

Inner names use package vocabulary (`PackageRecord`, `PackageTransaction`,
`ResourceRoot`) and do not claim outer agent-lifecycle concepts such as a round,
session, or transcript commit.

## Dependencies

| Design | Relationship |
|---|---|
| [endopi-skills-markdown-format](endopi-skills-markdown-format.md) | Owns skill validation, discovery paths, and read-only delivery |
| [endopi-prompt-templates](endopi-prompt-templates.md) | Owns prompt validation, discovery paths, and editor expansion |
| [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md) | Must supply the provider activation destination and capability contract |
| [endopi](endopi.md) | Parent comparison and source of the one-package ergonomic goal |

## Phased implementation

1. **Manifest, fetch, and store.** Parse the four roots, fetch npm, Git, and
   local sources without executing code, validate the tree, and write the
   locked, recoverable ledger and content store.
2. **Skills and prompts.** Place enabled resources in the sibling designs'
   conventional directories; implement conflicts, drift checks, lifecycle
   commands, and project scope.
3. **Guest activation.** Once a guest-entry design lands, adapt a selected
   installed entry to the existing source-only archive and explicit-powers
   path. Installation itself remains inert.
4. **Provider activation.** Once the provider registry settles its capability
   boundary, register selected installed providers through that surface.
5. **Additional resource kinds.** Add consumers such as themes by defining a
   new manifest key and activation boundary; older readers warn and preserve
   the package.

## Test plan

- Manifest table tests cover explicit and conventional roots, missing kinds,
  unknown keys, duplicates, lexical and realpath escapes, links, and special
  files.
- Fetch tests prove npm scripts, Git hooks, prompts, and submodules do not run;
  archive bounds fail before installation.
- Consumer-contract tests pass installed skills and prompts through the owning
  parser and validator rather than duplicating their grammar.
- Lifecycle tests cover user and project scopes, name collisions, enable and
  disable, pinned and unpinned update, modified-file refusal, forced removal,
  and pending-only packages.
- Fault-injection tests stop after every transaction step and prove the next
  package command restores the old version before proceeding.
- Concurrency tests prove two package mutations in one scope serialize.
- A scratch-daemon integration test mounts the conventional directories,
  installs a package, and observes the skill or prompt through the sibling
  consumer without granting guest or provider authority.
- CLI tests prove `endo list packages` still addresses an ordinary daemon
  directory and `endo remove npm:foo` remains an ordinary pet-name removal;
  package lifecycle is reachable only through `endo package` and the install
  alias.

## Delta for #1639

The draft build keeps its manifest parser, bounded npm and Git fetches,
ordinary-tree validation, resource ownership checks, and skill and prompt
placement.
It needs these changes before it implements this revision:

1. Put lifecycle commands under `endo package`; retain `endo install` only as
   the install alias.
2. Store the validated package tree, resolved identity, and digests; accept a
   package that contains only pending kinds without pretending they activated.
3. Add per-scope locking and durable interrupted-transaction recovery.
4. Refuse update or removal of locally modified managed resources unless the
   user supplies `--force`.
5. Treat skill and prompt placement as file installation only.
   Do not create a new grant path beside the sibling designs' read-only mounts.
6. Keep guests and providers inert until their owning designs supply activation
   contracts.

## Out of scope

- **A centralized registry.** npm keywords are sufficient for discovery.
  Endo does not need to operate a catalog or moderation surface.
- **Dependency installation for guest code.** The existing source-only archive
  machinery owns module capture.
- **Capability requests in the manifest.** Authority comes from capabilities a
  user grants at activation, never from package metadata.
- **Automatic activation on daemon startup.** The ledger records installation;
  the owning consumer decides activation and restart behavior.

## Citation

- [`packages/coding-agent/docs/packages.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/package-manager.ts)

## Prompt

> Extracted from [endopi](endopi.md) § *Extension model*. The ergonomic
> piece of Pi's plug-in model worth importing without giving up Endo's
> confinement. One `package.json` key, one install command, multiple
> resource kinds.
