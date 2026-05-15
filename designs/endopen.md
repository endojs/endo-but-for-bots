# EndOpen: Feature Parity and Contrast with OpenCode

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Author**  | kriscendobot (prompted by kriskowal)         |
| **Status**  | Not Started                                  |
| **Source**  | journal entry [`044500Z-dispatch-liaison-f47931.md`](../../journal/entries/2026/05/15/044500Z-dispatch-liaison-f47931.md) |

## Background

OpenCode is a free and open-source AI coding agent built by Anomaly Co
(the creators of [terminal.shop](https://terminal.shop)), released under
the MIT license. The canonical repository is
[`github.com/anomalyco/opencode`](https://github.com/anomalyco/opencode);
the alternate `github.com/sst/opencode` is unrelated. OpenCode is
distributed via `npm i -g opencode-ai`, `brew install opencode`,
`scoop install opencode`, and a single-binary `curl | bash` installer.

OpenCode positions itself as Claude Code's open-source counterpart:
provider-agnostic LLM routing, an opinionated TUI built on Bubble Tea
(Go) wrapping a TypeScript core (Bun runtime), built-in LSP, and a
client/server architecture that lets the same daemon power the local
TUI, a remote ACP client, or a future mobile shell.

The clone walked for this document is at
[`external/opencode/`](../../external/opencode/) (HEAD
`d59d9966`, captured 2026-05-15) in the dispatch root. The
monorepo carries 21 packages under `packages/`; the
load-bearing one is `packages/opencode/` (the TypeScript core
running on Bun). The Go-based TUI lives under
`packages/opencode/src/cli/cmd/tui/`.

This document enumerates OpenCode's features and integrations and
maps each to the Endo equivalent: already exists, designed, or
would require new work. It mirrors the shape of
[`endoclaw.md`](endoclaw.md), the prior OpenClaw comparative analysis.

## Architecture Comparison

| Aspect               | OpenCode                                                                     | Endo                                                                              |
|----------------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| **Runtime**          | Bun (TypeScript core) + Go (TUI), single-binary install                      | Node.js daemon, Electron Familiar shell, browser Chat UI                          |
| **Control plane**    | HTTP/WebSocket server (Effect HttpApi); session is the unit                  | WebSocket gateway (`ws://127.0.0.1:8920`); guest+formula is the unit              |
| **Agent model**      | Named agents (`build`, `plan`, `general`, `explore`) with permission rules   | Per-guest formula isolation, capability-graph delegation                          |
| **Capability model** | Ambient OS authority + permission rules (`allow`/`ask`/`deny` by tool name)  | Object-capability: guest holds only the references it has been granted            |
| **Persistence**      | SQLite (Drizzle ORM) at `~/.local/share/opencode/`; rows keyed by session    | Formula store, typed durable graph, content-addressed blobs                       |
| **Extensibility**    | NPM-distributed plugins (server hooks), `SKILL.md` skills, MCP servers       | Guest plugins (confined JS modules), pet-name directory, no skill registry        |
| **LLM routing**      | Vercel AI SDK + ~20 provider packages bundled (OpenRouter native)            | Lal providers (Anthropic / Gemini / Ollama / llama.cpp); no router-aware path     |
| **Concurrent agents**| `task` tool spawns one subagent at a time; experimental `background: true`   | Each guest is its own vat; concurrent agents are the default                      |
| **External protocol**| ACP (Agent Client Protocol) server, MCP client                               | OCapN (over WebSocket; Noise transport in flight), CapTP                          |
| **TUI**              | Bubble Tea (Go) rich TUI, the marquee surface                                | Familiar (Electron) + browser Chat UI; no native TUI yet (`endor-tui` in M6)      |
| **Installation**     | `curl | bash`, `brew`, `scoop`, `npm`                                        | Familiar (Electron) or `npx corepack yarn` from source                            |
| **Security**         | Permission allowlist enforced at tool dispatch; ambient process authority    | SES lockdown, unforgeable capabilities, structural confinement, caretaker revoke  |

The fundamental architectural difference is the **capability model**.
OpenCode's agents run as a single OS process with ambient authority;
the `Permission` service evaluates each tool call against a ruleset
([`packages/opencode/src/permission/index.ts`](../../external/opencode/packages/opencode/src/permission/index.ts)
lines 128 through 263) and either allows, asks, or denies. The agent
itself is unconfined: if the ruleset misses a case, the process can
read `~/.ssh/id_rsa` directly. Endo's object-capability model means
each guest is structurally unable to name what it has not been
granted; the permission story is "you only hold what you were given",
not "you are running in a sandbox that filters your system calls".

The second fundamental difference is **the unit of isolation**.
OpenCode isolates *sessions* (rows in SQLite, parent-child links via
the `parent_id` column,
[`packages/opencode/src/session/session.ts`](../../external/opencode/packages/opencode/src/session/session.ts)
lines 1 through 1011); all sessions share one OS process and one
permission service. Endo isolates *guests* (formula-typed entities
in a durable graph,
[`packages/daemon/src/formula-type.js`](../packages/daemon/src/formula-type.js)
lines 6 through 35); each guest can hold a different capability
set, and the daemon's worker model puts the guest in its own SES
compartment within its own XS or Node worker. Concurrent execution
is the default in Endo and the exception in OpenCode (the
`background: true` flag is gated behind
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`,
[`packages/opencode/src/tool/task.ts`](../../external/opencode/packages/opencode/src/tool/task.ts)
lines 113 through 117).

## Feature-by-Feature Mapping

### LLM Provider Surface

| OpenCode Provider              | Endo Equivalent (today)            | Status                                            |
|--------------------------------|------------------------------------|---------------------------------------------------|
| Anthropic                      | `lal/providers/anthropic.js`       | **Available**                                     |
| OpenAI                         | (planned via OpenAI-compat path)   | Partial                                           |
| Google (Gemini / Vertex)       | `lal/providers/gemini.js`          | **Available**                                     |
| OpenAI-compatible              | `lal/providers/llamacpp.js`        | **Available**                                     |
| Ollama (local)                 | `lal/providers/ollama.js`          | **Available**                                     |
| **OpenRouter**                 | —                                  | **Not designed** ([endopen-openrouter](endopen-openrouter.md)) |
| Bedrock, xAI, Mistral, Groq    | —                                  | Not designed (OpenAI-compat reach covers most)    |
| GitHub Copilot, Codex, Vercel  | —                                  | Not designed                                      |
| Cloudflare AI Gateway          | —                                  | Not designed                                      |
| LLM Gateway (router)           | —                                  | Not designed                                      |

OpenCode bundles a router-aware provider table at
[`packages/opencode/src/provider/provider.ts`](../../external/opencode/packages/opencode/src/provider/provider.ts)
lines 88 through 119 (the `BUNDLED_PROVIDERS` map; each entry is a
lazy import of an `@ai-sdk/<vendor>` package) and adds vendor-specific
header injection at lines 410 through 459 (the `customLoaders`
dictionary; OpenRouter's `HTTP-Referer` and `X-Title` headers are at
line 420). The Vercel AI SDK is the common shape; vendor-specific
quirks live in 15-line loader closures, not in scattered conditionals.

Endo's Lal has one provider per file with a single `chat(messages, tools)`
shape ([`packages/lal/providers/index.js`](../packages/lal/providers/index.js)
lines 33 through 65). The shape is consistent but the dispatch is by
host URL string-match, not by an explicit provider registry. Adding a
router-aware provider (OpenRouter) requires either a new branch in
`createProvider` or a registry refactor; see
[endopen-openrouter](endopen-openrouter.md) for the design.

### Tools

| OpenCode Tool     | Endo Equivalent                                       | Status                                             |
|-------------------|-------------------------------------------------------|----------------------------------------------------|
| `bash` / shell    | `Shell` capability ([daemon-agent-tools](daemon-agent-tools.md)) | Designed                              |
| `edit`            | `Mount` + write ops ([daemon-mount](daemon-mount.md))            | In progress                           |
| `read` / `write`  | `Dir` / `File` ([daemon-capability-filesystem](daemon-capability-filesystem.md)) | Designed                |
| `glob`            | `Dir.list` (recursive)                                           | Designed                              |
| `grep`            | (would compose `Shell` + `ripgrep` capability)                   | Not designed                          |
| `webfetch`        | `HttpClient` ([endoclaw-network-fetch](endoclaw-network-fetch.md)) | Not started                         |
| `websearch`       | (would be a network-allowlisted plugin)                          | Not designed                          |
| `lsp`             | —                                                                | Not designed                          |
| `apply_patch`     | `endo edit` ([cli-edit-verb](cli-edit-verb.md))                  | Proposed                              |
| `mcp_*`           | —                                                                | Not designed                          |
| `repo_clone`      | —                                                                | Not designed                          |
| `repo_overview`   | —                                                                | Not designed                          |
| `task`            | (would be a `provideGuest` + form submit pattern)                | Not designed                          |
| `task_status`     | (would be a `followMessages` on a child guest)                   | Not designed                          |
| `todowrite`       | —                                                                | Not designed                          |
| `skill`           | (would be a `pet-name` resolution)                               | Not designed                          |
| `question`        | `daemon-form-request` interactive form                           | **Complete**                          |
| `plan`            | (would be an agent-mode flag, prompt-only)                       | Not designed                          |

OpenCode's tool registry is centralized at
[`packages/opencode/src/tool/registry.ts`](../../external/opencode/packages/opencode/src/tool/registry.ts);
each tool ships as a `<name>.ts` + `<name>.txt` pair (executable +
description prompt). The shell tool
([`packages/opencode/src/tool/shell.ts`](../../external/opencode/packages/opencode/src/tool/shell.ts))
parses commands, classifies them by side effect (read-only / mutating /
cwd-changing, lines 27 through 65), and routes through the permission
service for ask/deny decisions.

The Endo analog of OpenCode's tool registry would be a guest's
capability bundle plus its agent's tool-arming layer. There is no
single registry; each agent module receives `powers` and elects
which capabilities to expose to its LLM client. The two-layer pattern
(capability + tool wrapper that calls the capability) is documented
in [`daemon-agent-tools`](daemon-agent-tools.md).

### Subagents and Concurrent Execution

| OpenCode Feature                                         | Endo Equivalent                                  | Status                                          |
|----------------------------------------------------------|--------------------------------------------------|-------------------------------------------------|
| `task` tool (synchronous subagent)                       | Guest-to-guest send / request                    | **Available** (manual pattern)                  |
| `background: true` (experimental)                        | Default: every guest is concurrent               | Endo advantage                                  |
| Named subagent types (`general`, `explore`)              | Per-guest agent modules                          | **Available** (no first-class registry)         |
| Subagent permission narrowing                            | Capability-graph delegation                      | **Available** (structural, not list-based)      |
| `task_status` polling                                    | Inbox / `followMessages`                         | **Available**                                   |
| Concurrent panel review (the maintainer's framing)       | Concurrent guest execution                       | Endo advantage; see [endopen-concurrent-subagents](endopen-concurrent-subagents.md) |

OpenCode's subagent story is in the `task` tool
([`packages/opencode/src/tool/task.ts`](../../external/opencode/packages/opencode/src/tool/task.ts)
lines 95 through 326) and the agent registry
([`packages/opencode/src/agent/agent.ts`](../../external/opencode/packages/opencode/src/agent/agent.ts)
lines 79 through 461). The maintainer's framing is right: OpenCode
synchronously launches one subagent at a time, returns its final text
to the parent, and only experimental flags unlock fire-and-forget
parallelism. The `BackgroundJob` service
([`packages/opencode/src/background/job.ts`](../../external/opencode/packages/opencode/src/background/job.ts))
is the supporting plumbing; the gate is one boolean in
[`task.ts`](../../external/opencode/packages/opencode/src/tool/task.ts)
line 113.

Endo's concurrency story is structurally different. Each guest is a
vat in the OCapN sense: its own SES compartment, its own message
loop, addressable by formula ID. A guest spawning another guest is a
regular `formulateGuest` + `send` interaction, not a special tool;
several guests are in flight simultaneously by default. The
*hard* problem in OpenCode (concurrent subagents) is the *trivial*
fall-out in Endo. See [endopen-concurrent-subagents](endopen-concurrent-subagents.md)
for the UX surface that exposes this advantage.

### UX Surface: The TUI Question

| OpenCode Surface                | Endo Equivalent                          | Status                                        |
|---------------------------------|------------------------------------------|-----------------------------------------------|
| Bubble Tea TUI (terminal)       | —                                        | Not designed for Endo-style usage             |
| `endor-tui` (planned Rust TUI)  | Future Rust daemon                       | Planned (M6, not started)                     |
| Browser Chat UI                 | Chat (packages/chat)                     | **Complete**                                  |
| Electron desktop                | Familiar (packages/familiar)             | **Complete**                                  |
| Desktop app (Tauri-like)        | Familiar (Electron variant)              | **Complete**                                  |
| Remote-driven from mobile       | Chat UI in mobile browser (via gateway)  | Designed (gateway-bearer-token-auth)          |

The maintainer's framing is that a "space more like opencode UX
might be helpful". The Endo answer is **not** to replace Chat or
Familiar with a TUI; both ship and both work. Instead, this is an
opportunity for a *new space kind* (in the Chat sense) whose layout
borrows OpenCode's idioms: keyboard-first command palette, file-tree
sidebar, an inline diff viewer, a "todo list" pane fed by the
agent's plan, a status bar showing model + tokens + cost. The
endor-tui design (M6) is the Rust terminal incarnation; this design
proposes a complementary browser-side opencode-shaped space that
ships before the Rust port. See
[endopen-tui-shell](endopen-tui-shell.md) for the surface.

### Plugin / Skill / MCP Ecosystem

| OpenCode Feature                  | Endo Equivalent                                   | Status                                       |
|-----------------------------------|---------------------------------------------------|----------------------------------------------|
| NPM-distributed server plugins    | Guest plugins (`endo install`)                    | **Available**                                |
| `SKILL.md` skill files            | (would be a `pet-name` resolution scheme)         | Not designed                                 |
| Plugin trigger hooks              | (would be a `daemon-commands-as-messages` shape)  | Designed (related)                           |
| MCP client (call MCP servers)     | —                                                 | Not designed                                 |
| MCP server (expose tools as MCP)  | —                                                 | Not designed                                 |
| ACP server (be an ACP backend)    | —                                                 | Not designed ([endopen-acp-server](endopen-acp-server.md)) |
| Skill registry / index            | —                                                 | Not designed ([endoclaw-skill-registry](endoclaw-skill-registry.md)) |

OpenCode's plugin module
([`packages/opencode/src/plugin/index.ts`](../../external/opencode/packages/opencode/src/plugin/index.ts)
lines 56 through 100) keeps a list of built-in `INTERNAL_PLUGINS`
plus user-installed NPM modules. The skill subsystem
([`packages/opencode/src/skill/index.ts`](../../external/opencode/packages/opencode/src/skill/index.ts)
lines 1 through 60) treats `SKILL.md` files as a content-addressed
playbook: each skill has a `name` and a `description`; the agent's
prompt enumerates the skill names, and the agent invokes one via a
`skill` tool call (resolution: filesystem-walk for `**/SKILL.md`
files). MCP integration
([`packages/opencode/src/mcp/index.ts`](../../external/opencode/packages/opencode/src/mcp/index.ts)
lines 1 through 80) is bidirectional: OpenCode is an MCP client
(calling out to MCP servers configured in `opencode.json`), and the
ACP server ([`packages/opencode/src/acp/agent.ts`](../../external/opencode/packages/opencode/src/acp/agent.ts))
makes OpenCode an ACP-protocol backend for any ACP client (Zed
integrates this way).

Endo's plugin model is structurally stricter (a plugin is a guest
module receiving capabilities) but does not interoperate with the
broader agent ecosystem. The ACP server gap is the most concrete
adoption-relevant gap: writing an ACP adapter for the daemon would
let Zed (and other ACP clients) drive Endo as if it were OpenCode,
without losing Endo's capability story. See
[endopen-acp-server](endopen-acp-server.md).

### Permission Model

OpenCode's permission model is a flat ruleset of triples
(`permission name`, `pattern`, `action`) where `action` is one of
`allow` / `ask` / `deny`, evaluated in source order
([`packages/opencode/src/permission/index.ts`](../../external/opencode/packages/opencode/src/permission/index.ts)
lines 128 through 175). Defaults are set per-agent in
[`agent.ts`](../../external/opencode/packages/opencode/src/agent/agent.ts)
lines 103 through 122; user overrides come from `opencode.json`'s
`permission` field. The subagent-spawning case derives a stricter
ruleset for the child from the parent's
([`packages/opencode/src/agent/subagent-permissions.ts`](../../external/opencode/packages/opencode/src/agent/subagent-permissions.ts)).

This is an *ambient-deny* model with `ask` as the user-in-the-loop
escape. It works because the agent runs in one process with full OS
authority; the only thing standing between the agent and the user's
shell is the ruleset.

Endo's capability model is *structural*: an agent that does not hold
a `Shell` capability cannot invoke a shell, full stop, no ruleset
consultation. The user's act of *granting* the capability is the
permission. The two models are not interchangeable, but they can be
*translated* at the surface: a future Endo "permission view" in Chat
could render which capabilities a given guest holds, with revoke
buttons that disincarnate the capability via the caretaker pattern
already designed in [daemon-capability-filesystem](daemon-capability-filesystem.md).

### Persistence and Session Model

OpenCode's session model is row-oriented SQLite:
- Session table with `id`, `parent_id`, `agent`, `model`, `tokens_*`, `cost`, timestamps ([`packages/opencode/src/session/session.sql.ts`](../../external/opencode/packages/opencode/src/session/session.sql.ts) and `fromRow` at [`session.ts`](../../external/opencode/packages/opencode/src/session/session.ts) lines 55 through 95).
- Part table for message parts (text / tool-call / tool-result blocks).
- Permission approvals table (`PermissionTable`, ruleset persisted per project).
- Background jobs ephemeral in-memory ([`background/job.ts`](../../external/opencode/packages/opencode/src/background/job.ts)).

This is a familiar shape: rows, foreign keys, joins. The session is
the unit; messages compose into it.

Endo's persistence is the formula store: a typed durable graph of
formulae of the types enumerated in
[`formula-type.js`](../packages/daemon/src/formula-type.js) lines 6
through 35 (33 formula types as of HEAD `68246ad9`). Each entry is
content-addressed by its formula ID (256-bit, as of
[daemon-256-bit-identifiers](daemon-256-bit-identifiers.md)) and the
daemon reconstitutes its objects on demand. Where OpenCode says
"resume session X from row 47", Endo says "look up formula
`abcd1234...` and incarnate it". The two models are not in conflict
(Endo has inbox-history per guest which is the analogue of a
session); the difference is whether persistence is a database or a
graph of formulae.

### Client/Server and Protocol Surfaces

OpenCode has three external protocol surfaces:

- **HTTP/WebSocket** ([`server/routes/instance/httpapi/public.ts`](../../external/opencode/packages/opencode/src/server/routes/instance/httpapi/public.ts), 507 lines): OpenAPI-described, used by the TUI, the SDK clients, and the desktop shell.
- **ACP** ([`acp/agent.ts`](../../external/opencode/packages/opencode/src/acp/agent.ts) and [`acp/README.md`](../../external/opencode/packages/opencode/src/acp/README.md)): JSON-RPC over stdio, conforming to the Agent Client Protocol spec; Zed integrates this way.
- **MCP** ([`mcp/index.ts`](../../external/opencode/packages/opencode/src/mcp/index.ts)): bidirectional; OpenCode is an MCP client and can be an MCP server.

Endo has one external protocol surface (OCapN over WebSocket;
Noise transport in flight via the M2 design family) and uses
CapTP / E() / makeExo internally. The protocol surfaces do not
overlap; Endo's strength is the capability story OCapN preserves,
OpenCode's strength is interoperability with the existing agent
tooling ecosystem (Zed, MCP servers, etc.). See
[endopen-acp-server](endopen-acp-server.md) for the adapter that
would close the interop gap without losing the capability story.

## Major Gaps (Sibling Designs)

This document is a roadmap; each of the four spin-outs lives as its
own implementable design.

### Gap 1: A first-class concurrent-subagent UX in Endo

OpenCode lacks first-class concurrent subagents; Endo gets them for
free, but the *UX surface* in Chat does not yet show it. Today a
user who spawns guest A and guest B sees two adjacent spaces; the
hand-off and result-aggregation patterns are manual.

The opportunity is to model OpenCode's `task` tool shape *as a guest
operation*: a primary guest can "delegate" to a panel of sub-guests
(each its own formula, hence its own SES compartment, hence safely
concurrent), and the Chat UI renders the panel as a single
collapsible widget with per-sub-guest progress and final
aggregation. The maintainer's framing: "concurrent subagent
execution which would fall out of endo more trivially given its
formula isolation + capability model".

See **[endopen-concurrent-subagents](endopen-concurrent-subagents.md)**
for the design.

### Gap 2: OpenRouter integration

OpenCode works well with OpenRouter; Endo does not have an
OpenRouter adapter at all. OpenRouter is a meta-provider that routes
requests across upstream providers (Anthropic / OpenAI / Google /
many local model hosts) with one OpenAI-compatible endpoint, one
API key, and per-model pricing transparency. It is the de-facto
"one key, all models" provider for indie developers.

The integration is small (one new `lal/providers/openrouter.js` file
plus header injection per OpenCode's
[`provider.ts`](../../external/opencode/packages/opencode/src/provider/provider.ts)
line 420 pattern) but it deserves its own design because the
header-injection ergonomics raise the broader question of *whether
Lal's provider table should mirror OpenCode's loader-closure
pattern*. The design proposes a registry refactor as the path.

See **[endopen-openrouter](endopen-openrouter.md)** for the design.

### Gap 3: An opencode-like UX surface for Endo

The maintainer's framing: "a space more like opencode UX might be
helpful". The Endo answer is not to replace Chat or Familiar; both
ship and both work. Instead, a new *space kind* (in the
`packages/chat` sense) whose layout borrows OpenCode's idioms:
- keyboard-first command palette,
- file-tree sidebar with `Mount`-backed contents,
- inline diff viewer,
- agent todo / plan pane,
- status bar with model + tokens + cost.

This is a Chat layer feature, not a daemon layer feature. The
`endor-tui` design (M6) is the Rust terminal incarnation; this is
the browser-side complement that ships earlier.

See **[endopen-tui-shell](endopen-tui-shell.md)** for the design.

### Gap 4: ACP server adapter (interop with Zed and the ACP ecosystem)

OpenCode is an ACP backend; that is how Zed integrates with it.
Endo has no ACP surface. Adding one is a *daemon-side adapter*: an
optional process that exposes the JSON-RPC ACP spec over stdio and
maps each ACP method onto an Endo guest interaction. This lets
ACP-aware editors drive an Endo guest without learning OCapN.

The capability story is preserved: each ACP session maps to a guest;
the guest's capabilities are what the user granted, not what the
ACP client asks for; permission requests get answered by Endo's
existing form-request machinery
([daemon-form-request](daemon-form-request.md)) rather than
auto-approve (which is what OpenCode's ACP server does today, per
[`acp/README.md`](../../external/opencode/packages/opencode/src/acp/README.md)
*Current Limitations*).

See **[endopen-acp-server](endopen-acp-server.md)** for the design.

## Major Contrasts (No Spin-out Needed)

### Capability model: structural vs. ruleset

Covered above. The contrast is not a gap to close: Endo's structural
confinement is the differentiating story. The takeaway is that any
ported feature must respect it: when adopting an OpenCode idiom,
the design's permission story must compile to "the guest holds the
capability or it does not", not "we consult a ruleset".

### Persistence: row store vs. formula graph

Covered above. Not a gap; the formula store is the persistence
substrate Endo wants. The takeaway is that any imported OpenCode
data model (sessions, parts, todos) lands as new formula types or
as fields on existing types; SQLite is not adopted.

### Extensibility: NPM plugins vs. confined guests

Covered above. The Endo plugin model is structurally stricter but
catalog-poorer. The bridge is a skill / plugin registry analogous
to OpenCode's, but capability-aware; this is already on the roadmap
as [endoclaw-skill-registry](endoclaw-skill-registry.md).

### Security: process-level ambient vs. compartment-level structural

Covered above. The contrast is the design's headline contribution.
No spin-out needed.

## Citation Index

OpenCode source files cited above (HEAD `d59d9966`, captured
2026-05-15 at [`external/opencode/`](../../external/opencode/) in the
dispatch root):

| File                                                                                     | Lines        | Why cited                                       |
|------------------------------------------------------------------------------------------|--------------|-------------------------------------------------|
| `packages/opencode/src/agent/agent.ts`                                                   | 79–461       | Agent registry, default agents, generation      |
| `packages/opencode/src/agent/subagent-permissions.ts`                                    | full         | Subagent permission derivation                  |
| `packages/opencode/src/permission/index.ts`                                              | 128–263      | Permission service: ask / allow / deny model    |
| `packages/opencode/src/session/session.ts`                                               | 1–1011       | Session row model, persistence                  |
| `packages/opencode/src/session/session.sql.ts`                                           | full         | SQLite schema                                   |
| `packages/opencode/src/provider/provider.ts`                                             | 88–119, 410–459 | Bundled provider table, OpenRouter header inject |
| `packages/opencode/src/tool/task.ts`                                                     | 95–326       | `task` tool, subagent dispatch, background flag |
| `packages/opencode/src/tool/shell.ts`                                                    | 27–80        | Shell tool command classification               |
| `packages/opencode/src/tool/registry.ts`                                                 | full         | Tool registry shape                             |
| `packages/opencode/src/background/job.ts`                                                | 1–200        | BackgroundJob service                           |
| `packages/opencode/src/plugin/index.ts`                                                  | 56–100       | Plugin loading, INTERNAL_PLUGINS list           |
| `packages/opencode/src/skill/index.ts`                                                   | 1–60         | Skill registry, SKILL.md schema                 |
| `packages/opencode/src/mcp/index.ts`                                                     | 1–80         | MCP client integration                          |
| `packages/opencode/src/acp/agent.ts`                                                     | full         | ACP server implementation                       |
| `packages/opencode/src/acp/README.md`                                                    | full         | ACP design notes and limitations                |
| `packages/opencode/src/server/server.ts`                                                 | 1–80         | HTTP/WebSocket server entry                     |
| `packages/opencode/src/server/routes/instance/httpapi/public.ts`                         | full         | Public HTTP API surface (507 lines)             |
| `packages/opencode/src/cli/cmd/tui/` (directory)                                         | full         | TUI structure, dialog components, routes        |
| `packages/llm/`                                                                          | full         | Standalone LLM router package                   |

Total: 19 OpenCode source files cited.

## Summary: Coverage and Gaps

### Endo-specific advantages (no OpenCode equivalent)

- **Object-capability confinement** at the structural level; OpenCode is process-ambient.
- **Concurrent subagents by default** (every guest is a vat); OpenCode gates background subagents behind an experimental flag.
- **Caretaker revocation** of capabilities; OpenCode has no such mechanism.
- **OCapN protocol** for capability-preserving inter-daemon communication; no analogue in OpenCode.
- **SES lockdown** (frozen primordials); OpenCode's tools run with full V8 / Bun semantics.
- **Formula-based persistence**; OpenCode is row-oriented SQLite.

### Already covered or designed in Endo

- Multi-agent isolation (guests vs. agents).
- Inter-agent messaging (`send` vs. `task`).
- Chat UI (the browser-side primary surface).
- Familiar desktop app.
- LLM model support (Anthropic, Gemini, Ollama, llama.cpp).
- Plugin installation (`endo install`).
- Filesystem capabilities (designed via [daemon-capability-filesystem](daemon-capability-filesystem.md)).
- Shell capabilities (designed via [daemon-agent-tools](daemon-agent-tools.md)).
- Network capabilities (designed via [endoclaw-network-fetch](endoclaw-network-fetch.md)).
- Form-based questioning (designed and shipped via [daemon-form-request](daemon-form-request.md)).
- HTTP gateway with bearer-token auth ([gateway-bearer-token-auth](gateway-bearer-token-auth.md)).

### Gaps closed by this design's spin-outs

- Concurrent-subagent UX surface → [endopen-concurrent-subagents](endopen-concurrent-subagents.md).
- OpenRouter LLM provider → [endopen-openrouter](endopen-openrouter.md).
- Opencode-like UX layout → [endopen-tui-shell](endopen-tui-shell.md).
- ACP server adapter → [endopen-acp-server](endopen-acp-server.md).

### Gaps surfaced but not closed by a spin-out

| Gap                                       | Priority | Notes                                                            |
|-------------------------------------------|----------|------------------------------------------------------------------|
| MCP client integration                    | Medium   | Would let Endo agents consume MCP servers; trust-on-first-bind ergonomics carry over from [trust-on-first-bind](trust-on-first-bind.md). |
| MCP server adapter                        | Medium   | Exposes Endo's tools to MCP-aware clients (Claude Desktop, etc.). Companion to the ACP adapter. |
| LSP integration                           | Low      | Useful for code-editing agents, but the value depends on the editor surface. Defer until the opencode-shaped space lands. |
| Plan / build agent modes                  | Low      | Easy to add as a guest-level prompt switch; mostly a UX choice. |
| Todo list as agent state                  | Low      | The `todowrite` tool is convenient for agent self-tracking; would be a small inbox-shaped formula. |
| Cost / token usage display                | Low      | OpenCode's status bar surfaces model + tokens + cost per turn; Endo has the data via the Lal provider but does not display it. |

## Related Designs

- [endoclaw](endoclaw.md) — the OpenClaw precedent this document mirrors.
- [endopen-concurrent-subagents](endopen-concurrent-subagents.md) — gap 1 sibling.
- [endopen-openrouter](endopen-openrouter.md) — gap 2 sibling.
- [endopen-tui-shell](endopen-tui-shell.md) — gap 3 sibling.
- [endopen-acp-server](endopen-acp-server.md) — gap 4 sibling.
- [daemon-agent-tools](daemon-agent-tools.md) — Endo's tool-arming story.
- [daemon-capability-filesystem](daemon-capability-filesystem.md) — Endo's filesystem confinement.
- [endoclaw-network-fetch](endoclaw-network-fetch.md) — Endo's HTTP fetch story.
- [endoclaw-skill-registry](endoclaw-skill-registry.md) — the skill / plugin index parallel.
- [endor-tui](endor-tui.md) — the Rust TUI roadmap (M6); complement of `endopen-tui-shell`.

## Prompt

> Please dispatch an analyst and designer to clone the opencode tool
> and compare and contrast it to endo familiar with the daemon and
> its designed features, to identify gaps or contrasting approaches,
> isolating chunks of code that might translate well to close
> feature gaps between these projects. This should result in a
> design for a raft of missing features citing sources that might be
> applicable. We have noted that opencode has a good interface and
> can work well with openrouter, but lacks concurrent subagent
> execution, which would fall out of endo more trivially. However,
> a space that is more like opencode UX might be helpful. This is
> a similar engagement to our earlier analysis of openclaw, which
> produced a similar bank of design documents.
>
> kriskowal, 2026-05-15
