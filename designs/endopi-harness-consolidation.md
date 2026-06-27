# EndoPi: Should Endo's Agent Harness Absorb the Pi Harness? — Consolidation Path

| | |
|---|---|
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

This design turns the comparative analysis in [endopi.md](endopi.md) into an
**absorb-or-coordinate recommendation** and a staged **consolidation path**.
[endopi.md](endopi.md) maps Endo's agent surfaces against Pi feature-by-feature
and is **Reference** status; read it first. This document does not re-do that
comparison. It asks the narrower engineering question the maintainer posed:

> Does it make sense for Endo's agent harness to **absorb some layers** of the
> Pi agent harness, and what path **reduces the duplication and coordination**
> between these layers?

The short answer, defended below per layer: **do not absorb (vendor /
reimplement) the Pi agent-core or provider layers** — keep depending on
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. The duplication
that actually hurts today is **Endo-internal**: three overlapping agent surfaces
(`lal`, `fae`, `genie`) each wrap Pi differently, and a legacy provider layer
(`lal/providers`) is maintained alongside Pi's registry. The path is to
**finish the consolidation Endo already started** onto the two shared seams
that now exist — `@endo/agentry` (harness) and `@endo/agent-tools` (tool
catalog) — and retire the duplicate wrappers. The verb is **UNIFY internally +
KEEP DEPENDING on Pi**, not **ABSORB Pi**.

## What changed since endopi.md was written

[endopi.md](endopi.md) (last extended 2026-06-25) describes `lal` and `fae` as
Pi-free Endo-native reimplementations and `genie` as the lone surface embedding
Pi (then under the `@mariozechner/*` npm scope). The tree has moved:

1. **The Pi packages were renamed to the `@earendil-works/*` scope.** Per
   [agentry-agent-builder.md](agentry-agent-builder.md), the project "was
   renamed from `@mariozechner/pi-ai` to `@earendil-works/pi-ai` plus
   `@earendil-works/pi-agent-core`." Both genie and lal now pin
   `@earendil-works/pi-agent-core ^0.79.0` and `@earendil-works/pi-ai ^0.79.0`.
2. **`lal` now embeds Pi too.** `@endo/lal`'s own description reads "AI agent
   plugin for Endo, built on the `@earendil-works/pi-agent-core` pi-based
   harness." Its agent loop is `makePiAgent` from `@endo/agentry/harness`
   (`packages/lal/agent.js:10,113`), and its provider resolution goes through
   pi-ai's registry. So **two** of the three surfaces (lal, genie) are now Pi
   embeddings, not just genie.
3. **A shared harness seam exists: `@endo/agentry`.** "Shared infrastructure
   for building agentic harnesses across endo packages" — it wraps
   `@earendil-works/pi-agent-core`, and exports `makePiAgent`, `resolveModel` /
   `resolveModelString`, an env-credentials seam, SmallCaps marshalling, and
   `makeCodeModeAgent` presets (`./harness`, `./define-agent`, `./execute`,
   `./eval`). See [agentry-agent-builder.md](agentry-agent-builder.md). `lal`
   consumes it; **genie does not** (it reimplements the same logic).
4. **A shared tool seam exists: `@endo/agent-tools`.** "Provider-independent
   agent tool catalog for Endo, including capability-scoped filesystem tools
   backed by an `@endo/platform/fs/extended` Filesystem." It carries the Pi
   harness contract (`pi.d.ts`), the canonical `ToolRecord` shape, git-tool
   tiers, and mount-fs tools. See [endo-agent-tools.md](endo-agent-tools.md)
   (shipped via PR #523 / #524), which supersedes
   [agent-tools-mount-fs-tools.md](agent-tools-mount-fs-tools.md).
5. **genie now wires `@endo/sandbox`.** The confinement story endopi.md's third
   pass called "not yet present in main" is present on this branch:
   `packages/genie/src/sandbox/{slice,local-powers}.js` and
   `src/tools/sandbox-spawner.js` mint a sandbox slice and route the `command`
   and `vfs` tools through it.

The upshot: Endo has **already begun coordinating** (agentry + agent-tools), but
the coordination is **half-finished** — genie sits outside both seams, fae sits
outside both seams, and a legacy provider layer survives. The consolidation work
is to finish what is started, not to begin something new.

## 1. Layer map

The two harnesses decompose into the same seven layers. Endo's surfaces are
placed against Pi's, with the shared seams (`@endo/agentry`,
`@endo/agent-tools`) called out where they already absorb a layer.

| Layer | Pi (`@earendil-works/*` + pi-mono) | Endo: shared seam | Endo: `lal` | Endo: `fae` | Endo: `genie` |
|---|---|---|---|---|---|
| **Provider / model adaptor** | `pi-ai`: unified registry, 30+ providers, OAuth (`ai/src/api-registry.ts`, `oauth.ts`) | `@endo/agentry` `resolveModel` over pi-ai registry | pi-ai via agentry **+** legacy `lal/providers/*` (6 hand-rolled modules, deprecated) | **legacy `lal/providers`** (`createProvider`), no pi-ai | pi-ai **direct** + own `buildOllamaModel` (reimplements agentry's ollama path) |
| **Agent loop / turn driver** | `pi-agent-core` `Agent` / agent-loop (`packages/agent/src/`) | `@endo/agentry` `makePiAgent` wraps `Agent` | `makePiAgent` via agentry; `runAgentRound` event bridge **vendored** into `agent-round.js` | **own** XML tool-call chat loop, no pi-agent-core | `Agent` **direct**; `runAgentRound` + event types **reimplemented** (`src/agent/index.js`, `src/loop/run.js`) |
| **Tool definition + dispatch** | `AgentTool` shape; built-ins read/write/edit/bash (`coding-agent/src/core/tools/`) | `@endo/agent-tools` `ToolRecord` + `pi.d.ts` contract; git/mount-fs tiers | `LalToolDef` + `@endo/patterns`, own `toAgentTool` adapter | `FaeTool` `M.interface`, petname-discovered, own dispatch | own tool factories + `tool-gate.js`, builds `AgentTool` directly |
| **Transcript / persistence** | JSONL session files; `id`/`parentId` tree (`session-manager.ts`) | — (gap: [endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md)) | PiAgent in-memory history, **ephemeral by design** | `@endo/conversation-tree` over petstore, **durable** | markdown workspace (`SOUL/HEARTBEAT/memory/*.md`) + `better-sqlite3` FTS5 |
| **Skills + prompt-template format** | `SKILL.md` (agentskills.io); `{{var}}` templates | — (gaps: [endopi-skills-markdown-format](endopi-skills-markdown-format.md), [endopi-prompt-templates](endopi-prompt-templates.md)) | system prompt in `prompts/system.js` | `endo-skill.js` | `skillsPrompt` option; Claw-style `buildSystemPrompt` |
| **Sandbox / filesystem mount** | ambient + opt-in container | `@endo/agent-tools` mount-fs (capability-scoped); `@endo/sandbox` (podman/bwrap) | none (unconfined guest caplet) | none (guest-scoped) | `@endo/sandbox` slice under `command`/`vfs` |
| **Subagent orchestration** | non-feature (pushed to extensions) | — | none | none | observer + reflector + heartbeat + interval, each a separate `Agent` |

`packages/agentry` itself depends on **both** `@earendil-works/pi-agent-core`
and `@endo/agent-tools`, so the two seams are already stacked: agentry is the
loop/model seam, agent-tools is the tool seam beneath it. The story Endo is
converging toward is visible in the table — it just is not finished.

## 2. Duplication and coordination cost

### 2a. Three agent loops on one `pi-agent-core`

- `lal` drives `pi-agent-core`'s `Agent` through `@endo/agentry`'s `makePiAgent`.
- `genie` drives the **same** `Agent` class **directly**, and **reimplements**
  what agentry already provides: `resolveModel` (including the ollama
  openai-compat adaptor), the `runAgentRound` event pump, and the
  `pi-agent-core`-event → `ChatEvent` translation. agentry was built to own
  exactly these; genie predates / bypasses it.
- `fae` is the odd one out: it owns a **custom** chat loop that never touches
  `pi-agent-core` at all, parsing tool calls out of message content
  (`extractToolCallsFromContent`) instead of using the harness's tool dispatch.

`lal/agent-round.js` even carries a comment that its event bridge is "vendored …
copied here verbatim" — the same code lives in genie. That is one event-pump
algorithm maintained in (at least) two places, plus a third, divergent
hand-rolled loop in fae.

### 2b. A provider layer maintained twice (really, thrice)

The provider/model adaptor is the worst offender:

1. **pi-ai's registry** — the real, 30+-provider, OAuth-capable surface, reached
   through agentry (lal) or directly (genie).
2. **`lal/providers/*`** — six hand-rolled modules (anthropic, gemini, llamacpp,
   ollama, openai-compatible, mock). lal's own README marks them "no longer used
   by lal's own agent loop." Yet they are not dead: **`fae`, `jaine`, and lal's
   test surface all still import `@endo/lal/providers`.** Retiring the layer is
   blocked on migrating those consumers.
3. **genie's `buildOllamaModel`** — a third implementation of the
   ollama-as-openai-completions adaptor that agentry's `resolveModel` already
   contains.

So the same "make a model talk" capability exists in three Endo spellings on top
of the one upstream Pi registry — a registry that itself is the thing best left
to Pi.

### 2c. Three tool schemas, one canonical seam ignored

`lal` (`LalToolDef` + `@endo/patterns` + a `toAgentTool` adapter), `fae`
(`FaeTool` `M.interface`, runtime petname discovery), and `genie` (own factories
+ `tool-gate.js`) are three incompatible tool-definition schemas. Each
re-derives "validate args, then present as a `pi-agent-core` `AgentTool`."
Meanwhile `@endo/agent-tools` now ships the **canonical** `ToolRecord` and the
`pi.d.ts` harness contract precisely to be that single shape — and none of the
three surfaces has fully moved onto it.

### 2d. Coordination seams that must move in lockstep

- **Pin lockstep.** Five package manifests pin `@earendil-works/pi-agent-core
  ^0.79.0` / `pi-ai ^0.79.0` (lal, genie, agentry, and two more). A Pi minor
  bump is a five-file, multi-surface coordination event, and the surfaces do not
  share a single dependency choke point (agentry would be that choke point if
  genie and fae went through it).
- **Format compatibility.** Three persistence shapes (lal ephemeral, fae
  conversation-tree, genie markdown+FTS5) and no shared transcript substrate
  means the [endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md)
  projection would have to be implemented three times to cover all surfaces.
- **Tool-protocol versioning.** Because each surface owns its own
  `AgentTool` boundary, a change in `pi-agent-core`'s tool contract is three
  edits, not one.
- **The ollama adaptor outside pi-ai.** Both agentry and genie carry the
  ollama-as-openai-completions shim because pi-ai has no native ollama entry.
  That shim is duplicated and must track pi-ai's `Model` shape in two places.

## 3. Absorb-or-coordinate recommendation, per layer

For each layer: **ABSORB** (Endo vendors / reimplements the Pi layer, collapsing
the dependency), **KEEP DEPENDING** (Pi stays upstream; Endo adapts through one
seam), or **UNIFY** (collapse Endo's *internal* duplicates onto a shared seam).

| Layer | Recommendation | Why |
|---|---|---|
| **Provider / model adaptor** | **KEEP DEPENDING** on pi-ai; **UNIFY** Endo onto agentry's `resolveModel` | pi-ai is 30+ providers + OAuth that Endo gains nothing by re-owning; tracking it is cheap relative to maintaining a parallel registry. The win is retiring `lal/providers` and genie's `buildOllamaModel` onto agentry. |
| **Agent loop / turn driver** | **KEEP DEPENDING** on `pi-agent-core`; **UNIFY** onto agentry's `makePiAgent` + one `runAgentRound` | The loop is LLM-plumbing where Endo's capability model adds no leverage. Reimplementing it (genie) or forking it (fae's XML loop) is pure cost. One event pump in agentry, consumed by all. |
| **Tool definition + dispatch** | **UNIFY** onto `@endo/agent-tools` `ToolRecord`; **KEEP DEPENDING** on `pi-agent-core`'s `AgentTool` as the boundary | This is where Endo's capabilities **do** add leverage (capability-scoped fs, git tiers, attenuation). agent-tools is the right Endo-owned layer; the three bespoke schemas should collapse onto it, presenting a single `toAgentTool` boundary. |
| **Transcript / persistence** | **ABSORB** the *format* (Endo-owned substrate) but make it a **pi-compatible projection** | CapTP/formula-store/petnames have no Pi analog; the substrate must be Endo's. Adopt Pi's JSONL *shape* as an export projection per [endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md). Converge the three Endo persistence shapes onto one substrate (fae's `@endo/conversation-tree` is the most structurally apt seed). |
| **Skills + prompt-template format** | **ABSORB** the on-disk format (agentskills.io-compatible), Endo-owned | Per [endopi-skills-markdown-format](endopi-skills-markdown-format.md) / [endopi-prompt-templates](endopi-prompt-templates.md): a markdown/frontmatter format is low-risk, cross-harness, and not something to depend on a Pi package for. Shared across surfaces, not per-surface. |
| **Sandbox / filesystem mount** | **KEEP** Endo-native (`@endo/agent-tools` mount-fs + `@endo/sandbox`); no Pi analog to absorb | Pi is ambient-authority; this is Endo's headline advantage. Genie's wiring is the reference; generalize it under agent-tools rather than leaving it genie-private. |
| **Subagent orchestration** | **KEEP** genie-native; optionally **UNIFY** into a shared module if lal/fae want it | Pi declines subagents on purpose. Genie's observer/reflector/heartbeat is an Endo addition with no Pi counterpart; nothing to absorb. Keep it genie-local until a second consumer appears. |

**Why not ABSORB pi-agent-core / pi-ai wholesale.** Three reasons. (1) **Capability
fit:** the layers worth Endo owning are the tool/capability/transcript layers,
where CapTP, locators, petnames, and SES confinement have no Pi analog — and
Endo *already owns* those via agent-tools and the daemon. The agent-loop and
provider-registry layers are exactly the parts where Endo's differentiators add
nothing, so re-owning them is cost without capability gain. (2) **Maintenance
cost:** a vendored `pi-agent-core` is a parallel agent loop to keep current with
model-API churn (streaming, tool-call formats, new providers) — the highest-churn
code in the stack. (3) **Upgrade risk is *lower* under coordination, not
higher:** the way to de-risk tracking `@earendil-works/*` releases is to route
every surface through **one** dependency choke point (agentry), so a Pi bump is a
single coordinated change — not to fork.

## 4. Consolidation path

Staged so each step is independently landable on the fork. Each phase reduces
duplication or coordination surface on its own; none requires the next to ship.

### Phase 0 — Pin discipline (coordination, no behaviour change)
Make `@endo/agentry` the single declared dependency on `@earendil-works/pi-*` for
the daemon agent surfaces. lal already routes through agentry; have genie and any
new surface depend on agentry's re-export rather than pinning pi-* directly.
Outcome: a Pi version bump becomes (ideally) a one-package change. (fae carries no
pi-* pin yet, so it is unaffected until Phase 2.)

### Phase 1 — genie adopts `@endo/agentry` (largest single dedup)
Replace genie's reimplemented `resolveModel` / `buildOllamaModel`, `runAgentRound`,
and `pi-agent-core`-event translation with agentry's `harness` exports. genie
keeps everything that is genuinely its own (sandbox slice, observer/reflector/
heartbeat, FTS5 memory, interval scheduler); it loses only the duplicated harness
plumbing. Outcome: one agent loop and one model resolver shared by lal and genie;
the "vendored verbatim" event pump exists once.

### Phase 2 — retire `lal/providers`; migrate its consumers
`fae`, `jaine`, and lal's tests are the remaining importers of the legacy
provider layer. Migrate each to agentry/pi-ai (`createProvider` → agentry model
resolution). Two sub-decisions for the maintainer (see §5): whether `fae`'s
custom XML loop is **refactored** onto agentry/pi-agent-core or **retired** in
favour of lal+genie, and the same question for `jaine`. Outcome: the
three-implementations-of-one-registry problem in §2b collapses to one.

### Phase 3 — converge tool schemas onto `@endo/agent-tools`
Move lal's `LalToolDef`, fae's `FaeTool`, and genie's tool factories onto the
canonical `ToolRecord` from `@endo/agent-tools`, with a **single** `toAgentTool`
boundary (the adapter agentry/agent-tools already implies). Capability-scoped fs
and git-tier tools come from agent-tools rather than three private
implementations. Outcome: one tool-definition schema; a `pi-agent-core` tool-
contract change is one edit.

### Phase 4 — one transcript substrate + pi-compatible projection
Pick one durable transcript substrate (fae's `@endo/conversation-tree` over the
petstore is the structurally aptest seed; lal is ephemeral, genie is markdown+
FTS5) and route all surfaces through it. Implement the
[endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md) projection
**once**, on that substrate, so every surface gets pi-compatible JSONL export for
free. genie's markdown memory becomes a *view*/projection rather than a parallel
store. Outcome: one persistence shape; the JSONL gap is closed once, not thrice.

### Phase 5 — shared format + optional shared subagents
Land the [endopi-skills-markdown-format](endopi-skills-markdown-format.md) and
[endopi-prompt-templates](endopi-prompt-templates.md) formats as shared,
surface-independent modules. If a second consumer of observer/reflector/heartbeat
appears, lift genie's subagent orchestration into a shared optional module;
otherwise leave it genie-local.

### What the surfaces become
- **`@endo/agentry`** — the one harness seam: loop + model + credentials + event
  pump over `@earendil-works/pi-*`. The sole pi-* choke point.
- **`@endo/agent-tools`** — the one tool seam: capability-scoped `ToolRecord`
  catalog + the `pi.d.ts` boundary.
- **`lal`** — the thin daemon-integrated single-agent loop over agentry +
  agent-tools (what it nearly is already).
- **`genie`** — the Claw-like autonomous **superset** (sandbox + observer/
  reflector/heartbeat + memory) over the *same* agentry + agent-tools base, no
  longer carrying its own harness plumbing.
- **`fae` / `jaine`** — either refactored onto the same base (contributing their
  conversation-tree persistence as the shared substrate) or retired once lal +
  genie subsume their role. A maintainer call (§5).

## 5. Risks and open questions

1. **Losing Pi upstream improvements.** The recommendation is **KEEP DEPENDING**
   precisely to avoid this — absorbing pi-agent-core/pi-ai would strand Endo off
   Pi's provider and model-API updates. The residual risk is the inverse: a Pi
   release breaks the agentry seam. Mitigated by the Phase 0/1 single choke
   point, where the break is caught and fixed in one place.
2. **Should the absorbed/projected layers stay API-compatible with `pi-*` for
   interop?** The JSONL transcript projection is deliberately pi-compatible (an
   operator can `jq` an Endo session like a Pi one, per endopi.md § Persistence).
   Open: how far that compatibility goes for skills/prompt formats, and whether
   Endo wants Pi extensions to load unmodified (probably not — Pi extensions are
   ambient-authority; Endo guest plugins are confined).
3. **Retire vs refactor `fae` and `jaine`.** fae's independent XML-parsing loop
   and conversation-tree persistence predate agentry. Whether to fold fae onto
   the shared base or retire it (and same for jaine) is the load-bearing
   maintainer decision in Phase 2; it determines whether conversation-tree
   becomes the shared substrate (Phase 4) or is dropped.
4. **Canonical transcript substrate.** conversation-tree (fae) vs markdown+FTS5
   (genie) vs a new shared store. genie's FTS5 memory serves its observer/
   reflector loop specifically; collapsing it into a graph substrate must
   preserve the search/compaction affordances the subagents depend on.
5. **Sandbox-driver coupling** (carried from endopi.md's third pass). genie's
   `@endo/sandbox` wiring (podman primary, bwrap present, macOS/Windows
   anticipated) and the open **vfs-endo backend vs 9p-server** question for the
   filesystem half are upstream of generalizing sandbox confinement under
   agent-tools. Resolve before Phase 3's tool convergence assumes a single fs
   tool path.
6. **The ollama adaptor.** It lives outside pi-ai (agentry + genie both carry the
   openai-completions shim). Phase 1 collapses it to one copy in agentry;
   upstreaming a native ollama entry into `pi-ai` would remove it entirely and is
   worth raising with the Pi maintainer (an interop contribution, not a fork).
7. **Coordination with the open gap designs.** This path assumes the
   [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md)
   "Lal vs Genie consolidation" open question resolves toward option (a)/(c)
   (one shared registry surface) rather than (b) (coexist). This document is the
   argument for that resolution; if the maintainer prefers (b), Phases 1–2 narrow
   to dedup-only and the choke-point benefit is lost.

## Related designs

- [endopi.md](endopi.md) — the comparative analysis this path builds on
  (Reference). Reviewer context for the genie + sandbox passes is on PR #265
  (jcorbin).
- [agentry-agent-builder.md](agentry-agent-builder.md) — `@endo/agentry`, the
  harness seam this path consolidates onto.
- [endo-agent-tools.md](endo-agent-tools.md) — `@endo/agent-tools`, the tool
  seam; supersedes [agent-tools-mount-fs-tools.md](agent-tools-mount-fs-tools.md).
- [daemon-agent-tools.md](daemon-agent-tools.md) — capability-scoped agent tools.
- [daemon-agent-network-identity.md](daemon-agent-network-identity.md) — per-agent
  network identity (orthogonal to harness choice).
- [endopi-provider-registry-and-oauth.md](endopi-provider-registry-and-oauth.md)
  — the open Lal-vs-Genie registry question this path takes a position on.
- [endopi-jsonl-transcript-format.md](endopi-jsonl-transcript-format.md) — the
  pi-compatible transcript projection (Phase 4).
- [endopi-skills-markdown-format.md](endopi-skills-markdown-format.md),
  [endopi-prompt-templates.md](endopi-prompt-templates.md) — shared formats
  (Phase 5).
- [endopi-iterative-compaction.md](endopi-iterative-compaction.md) — harmonizes
  with genie's observer/reflector pair.
- [endopi-edit-tool.md](endopi-edit-tool.md),
  [endopi-stdio-rpc-bridge.md](endopi-stdio-rpc-bridge.md),
  [endopi-extension-package-manifest.md](endopi-extension-package-manifest.md) —
  sibling gap spinouts of endopi.md.

## Prompt

> Investigate whether Endo's agent harness should absorb layers of the Pi agent
> harness, building on `endopi.md`'s comparison rather than redoing it. Map each
> harness into layers, identify duplication and coordination cost across
> `lal` / `fae` / `genie` / `daemon`, recommend ABSORB / KEEP-DEPENDING / UNIFY
> per layer, and propose a staged consolidation path with risks and open
> questions for the maintainer.
