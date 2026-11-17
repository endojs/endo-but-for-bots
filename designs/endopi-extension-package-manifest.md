# EndoPi: Extension Package Manifest

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-11-17 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Parent** | [endopi](endopi.md) |

## Motivation

Pi's package model bundles four resource kinds (extensions, skills,
prompt templates, themes) under one `pi` keyword in `package.json`. A
single `pi install npm:@foo/bar` resolves them all. Authors do not
manage four parallel distribution channels; consumers do not run four
install commands.

Endo's `endo install` is single-purpose: it installs one guest plugin.
Skills, prompt templates, and themes (once
[endopi-skills-markdown-format](endopi-skills-markdown-format.md) and
[endopi-prompt-templates](endopi-prompt-templates.md) land) have no
distribution channel. The gap is not the daemon-side substrate (which
is already strong) but the *packaging convention* that lets one author
ship a coordinated set of resources.

## Design

### Manifest

```json
{
  "name": "my-endo-package",
  "keywords": ["endo-package", "endo-skill"],
  "endo": {
    "guests": ["./guests"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "providers": ["./providers"]
  }
}
```

The `endo` key in `package.json` declares which resource directories the
package ships. Auto-discovery fills in defaults if the key is absent
(directories named `guests/`, `skills/`, `prompts/`, `providers/`).

`themes` and other resource kinds are added as new types emerge; the
manifest is extensible without breaking older readers.

### Install

```sh
endo install npm:@foo/bar
endo install npm:@foo/bar@1.2.3
endo install git:github.com/user/repo
endo install git:github.com/user/repo@v1
endo install --project npm:@foo/bar     # project-local
```

The installer resolves the source (npm, git, local path), reads the
manifest, and:

1. Drops `guests/` contents into the daemon's guest-plugin store. (The
   existing `endo install` path.)
2. Drops `skills/` contents into the user's `~/.agents/skills/` (or
   project-local `.agents/skills/`). (The
   [endopi-skills-markdown-format](endopi-skills-markdown-format.md)
   discovery walker picks them up.)
3. Drops `prompts/` contents alongside (per
   [endopi-prompt-templates](endopi-prompt-templates.md)).
4. Registers `providers/` contents with the LLM provider registry (per
   [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md)).

### Security posture

This is the sharpest contrast with Pi. Pi packages run with full system
authority on first run; Pi's response is "review the source before
installing".

Endo's response: each resource kind has its own confinement.

- **Guests** run under SES with only the capabilities the user grants
  at provisioning time. Package authors do not get to ask for new
  capabilities silently.
- **Skills** are markdown files. Their power is to *instruct* the
  agent, not to *do* anything directly; the agent's own capabilities
  bound what skill instructions can effect.
- **Prompts** are pure text expansion. No capability surface at all.
- **Providers** ship code that talks to an LLM endpoint. The provider
  module runs confined; its network access is gated by the daemon's
  outbound HTTP capability per
  [endoclaw-network-fetch](endoclaw-network-fetch.md).

A package install is therefore *safer than `endo install` is today*
because the new resource kinds (skill, prompt) carry no execution
authority, and the existing one (guest) is unchanged.

### Listing and removal

```sh
endo list packages
endo remove npm:@foo/bar
```

Plus `endo config` to enable/disable installed packages without
uninstalling, mirroring Pi's `pi config`.

## Prerequisite reconciliation (2026-11-17)

Before this design is built, this section checks the three sibling designs it
depends on or builds beside against what has shipped on `llm`, and against
the two open PRs that would finish them. It records the gaps that
this design must not assume are closed.

### State of the siblings

| Design | On `llm` | Open PR | Remaining gap |
|--------|----------|---------|---------------|
| [endopi-edit-tool](endopi-edit-tool.md) | `@endo/agentry/edit-text` (`applyEdits`, unique-match, no-overlap, line-ending and BOM preservation, unified diff); wired into the Fae tool makers and Lal `fs` tools | #1501 (draft): Floot renders unified diffs in tool results; flips the design to **Complete** | Only the Chat UI diff preview, which #1501 delivers. Promoting `edit` onto a dedicated `File` capability is conditional on `Dir.lookup(name) → File` and is not a gap for this design. |
| [endopi-stdio-rpc-bridge](endopi-stdio-rpc-bridge.md) | Nothing | #667: `@endo/agentry/rpc` (framing, event translation, `steer` / `abort` / `set_model`, `serveRpc`) for phases 1–4; design to **In Progress** | The `endo agent rpc` CLI entry point and phase 5 (multiplexing) are unbuilt. The 2026-07-13 CHANGES_REQUESTED review ("move these facilities into agentry or agent-tools") appears satisfied by the move to `packages/agentry/src/rpc/`, but it is still on record and needs a re-review. |
| [endopi-skills-markdown-format](endopi-skills-markdown-format.md) | Nothing: no `SKILL.md` parser, no discovery walker, no system-prompt injection | None | Every phase. Its daemon-side counterpart, [endoclaw-skill-registry](endoclaw-skill-registry.md), is **Not Started**. |

Both open PRs also carry unrelated files: action-pin workflow edits and
`hardened262` `sesNode/module` baseline changes. Those need to be dropped or
landed separately before either PR merges.

### Gaps this design was silently assuming were closed

1. **`endo install` does not exist.** § Install says the guest step is "the
   existing `endo install` path". On `llm`, `install` appears only in the
   CLI help grouping (`packages/cli/src/endo.js`, the *Execution* section).
   No `.command('install …')` is registered, and the daemon has no
   guest-plugin store. Guests are provisioned today through `endo make` /
   `endo run` and pet names. Phase 1 therefore starts by **creating** the
   `install` verb: resolving the source (npm, git, local path) and reading
   the manifest. It is not an extension of an existing verb. Uninstall
   (§ Listing and removal) needs an install record to read back. This design
   must define that record, because no existing record can be reused.
2. **There is no consumer for `skills/`.** Phase 1 of this design ("manifest
   read + skill installs") drops files into `~/.agents/skills/`. Nothing on
   `llm` reads that path. So the first deliverable could be built but would
   do nothing. Either reorder this design's phases so it follows
   endopi-skills-markdown-format phases 1–2 (parser, discovery, and prompt
   injection), or make phase 1 the guest kind instead.
3. **No consumer for `prompts/`.** [endopi-prompt-templates](endopi-prompt-templates.md)
   is **Proposed** with no code. The ordering problem is the same as for skills.
4. **`providers/` targets a registry that is only partly built.**
   [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md)
   is *Proposed (partially satisfied)*. Before this design names an install
   target for provider modules, it has to name the registration API those
   modules land in. The confinement claim in § Security posture also depends
   on [endoclaw-network-fetch](endoclaw-network-fetch.md) gating provider
   egress.
5. **The edit tool and stdio bridge do not block this design.** Neither is a
   consumer of any manifest key. They matter only because the rest of the
   endopi set is converging on `@endo/agentry` as its home: the edit tool
   is already there, and #667 puts the bridge there. If this design needs a
   library half (the manifest reader and resource-kind walkers), it should
   live there too rather than in `packages/cli`. The CLI keeps only the verbs.

### Settled foundation for building

- **Buildable now:** the manifest reader (a pure `package.json` → resource-kind
  map with auto-discovery defaults and unknown-key tolerance), source
  resolution, and an `endo install` verb that handles the `guests` kind
  through the existing `make` path.
- **Buildable once endopi-skills-markdown-format phases 1–2 land:** the `skills`
  kind.
- **Blocked on designs that are still only proposals:** the `prompts` and `providers` kinds,
  `endo config` enable/disable, and `endo update`.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [endopi-skills-markdown-format](endopi-skills-markdown-format.md) | Consumer of `skills/` |
| [endopi-prompt-templates](endopi-prompt-templates.md) | Consumer of `prompts/` |
| [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md) | Consumer of `providers/` |
| [endoclaw-skill-registry](endoclaw-skill-registry.md) | Daemon-side counterpart for skills |

## Phased implementation

1. **Manifest read + skill installs.** `endo install` recognizes
   `endo.skills`, drops content into the discovery path.
2. **Prompt + provider kinds.** Same shape, more directories.
3. **`endo list packages` + `endo remove`.** Lifecycle.
4. **`endo config` for enable/disable.** Disable a package without
   uninstalling.
5. **Pinning + updates.** `endo install npm:@foo/bar@1.2.3`
   semantics, `endo update`.

## Out of scope

- **Centralized registry.** Pi browses npm with a keyword search. Endo
  follows the same npm convention (`keywords: ["endo-package"]`); a
  registry is unnecessary and would add a moderation surface Endo does
  not want to operate.
- **Backwards-incompatible manifest changes.** The manifest is
  forward-compatible by design (unknown keys are ignored), so we never
  need a v2 manifest.

## Citation

- [`packages/coding-agent/docs/packages.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/package-manager.ts)

## Prompt

> Extracted from [endopi](endopi.md) § *Extension model*. The ergonomic
> piece of Pi's plug-in model worth importing without giving up Endo's
> confinement. One `package.json` keyword, one install command,
> multiple resource kinds.
