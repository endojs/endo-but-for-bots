<!--
  Provenance: this is an external document, not an Endo design.

  It is a reverse-engineering report of Paseo's provider layer, written from
  outside that codebase, and it is vendored here because Paseo instruments the
  same three CLIs this repo's hosted-agent work does — Claude Code, Codex and
  OpenCode — while making the opposite bet about who owns the transcript. It is
  kept verbatim so the comparison in
  `hosted-agent-sandbox-unification.md#what-paseo-does-differently` cites a
  stable text. Nothing here describes Endo behaviour, and its file paths and
  line counts refer to the Paseo repository.
-->

# How Paseo instruments coding-agent harnesses

A reverse-engineering report of Paseo's provider layer, written to be sufficient for
implementing a comparable meta-harness. Focus on Claude Code, Codex, and OpenCode.

All paths are relative to the Paseo repo root. Read this alongside
[`docs/providers.md`](docs/providers.md), [`docs/agent-lifecycle.md`](docs/agent-lifecycle.md),
and [`docs/timeline-sync.md`](docs/timeline-sync.md), which are the in-repo sources of truth.

---

## 0. Answers up front

**Can it restore a conversation after the harness has been closed?**
Yes, and this is the central design commitment. Paseo never owns the transcript. Each
provider's own session store is the durable authority; Paseo persists only a small
`AgentPersistenceHandle` (provider id + native session id + a config snapshot) in a JSON
file per agent. Resuming means asking the harness to reopen its own native session and
then re-reading its history back into Paseo's normalized timeline. This works across
daemon restarts, machine reboots, and sessions started outside Paseo entirely (the
"import" path). It is also the *only* restore path — there is no Paseo-side transcript
database in production.

**Can it migrate a conversation to a new harness?**
Not natively, and deliberately so. A Paseo agent is bound to one provider for life: the
provider id is part of the persistence handle, the stored record, and the agent identity.
What Paseo offers instead is **Fork** (`agent.fork_context.request`), which renders the
current timeline into a curated plain-text `<chat-history-summary>` block, attaches it to
a **new draft agent**, and lets the user pick any provider/model for that draft. So the
*context* migrates; the *session* does not. Model state (KV cache, provider-side
compaction state, file checkpoints, background shells, todo state) is lost by
construction. Inside a single provider there is a second, lossless mechanism — rewind /
`thread/fork` / `forkSession` — but it never crosses provider boundaries.

**How does it instrument the harnesses?**
Three transport families behind one interface pair (`AgentClient` / `AgentSession`):

| Family | Providers | Transport |
|---|---|---|
| Vendor SDK, in-process | Claude | `@anthropic-ai/claude-agent-sdk` `query()` driving a spawned `claude` child process |
| Vendor JSON-RPC over stdio | Codex, Pi, OMP | `codex app-server`, `pi --mode rpc`, `omp --mode rpc-ui` |
| HTTP + SSE server | OpenCode | long-lived `opencode serve` process, REST calls + one global event stream |
| ACP (Agent Client Protocol) | Copilot, Cursor, Kimi, Kiro, Trae, generic | stdio JSON-RPC with a standardized schema |

---

## 1. The meta-harness contract

Everything lives in `packages/server/src/server/agent/agent-sdk-types.ts` (803 lines).
Two interfaces, and the whole rest of the daemon programs against them.

### 1.1 `AgentClient` — the provider, process-level

```ts
interface AgentClient {
  readonly provider: AgentProvider;          // type AgentProvider = string
  readonly capabilities: AgentCapabilityFlags;

  createSession(config, launchContext?, options?): Promise<AgentSession>;
  resumeSession(handle, overrides?, launchContext?, options?): Promise<AgentSession>;

  fetchCatalog(options, context?): Promise<ProviderCatalog>;   // models + modes, one call
  getCatalogCacheKey?(options): Promise<string | undefined>;   // equivalence for caching
  isAvailable(signal?, options?): Promise<boolean>;

  listImportableSessions?(options?): Promise<ImportableProviderSession[]>;
  importSession?(input, context): Promise<ImportedProviderSession>;

  archiveNativeSession?(handle): Promise<void>;
  unarchiveNativeSession?(handle): Promise<void>;

  listCommands?(config): Promise<AgentSlashCommand[]>;
  listFeatures?(config): Promise<AgentFeature[]>;
  resolveDefaultModeId?(input): Promise<string | undefined>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  shutdown?(): Promise<void>;
}
```

Design notes worth copying:

- **`AgentProvider` is `string`, validated at runtime against a manifest**, not a union
  type. Plugins and user-defined custom providers can therefore register new ids without
  touching the core types.
- **`fetchCatalog` is the single discovery API.** Callers outside the provider never get
  separate "list models" and "list modes" probes. Internally a provider may spawn one
  process for both (Codex spawns an app-server, asks `model/list` + reads config, and
  disposes it).
- **`getCatalogCacheKey` separates storage identity from execution target.** Claude and
  Codex both return the constant `"host"` because their catalogs are host-global; OpenCode
  keys per directory. `force` must never change the key.
- **Draft/metadata lookups must not create sessions.** `listCommands` and `listFeatures`
  are on the *client*, not the session, precisely so that opening a model picker does not
  leave an empty session in the provider's own history UI.

### 1.2 `AgentSession` — one live conversation

```ts
interface AgentSession {
  readonly id: string | null;                 // native session id once known
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];

  startTurn(prompt, options?): Promise<{ turnId: string }>;
  run(prompt, options?): Promise<AgentRunResult>;             // convenience over startTurn
  steerActiveTurn?(prompt, options): Promise<SteerResult>;
  interrupt(): Promise<void>;

  subscribe(cb: (e: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;          // replay, drained once

  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(id): Promise<void | AgentProviderNotice>;
  setModel?(id): Promise<void>;
  setThinkingOption?(id): Promise<void | AgentProviderNotice>;
  setFeature?(id, value): Promise<void>;

  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId, response): Promise<AgentPermissionResult | void>;

  describePersistence(): AgentPersistenceHandle | null;        // ← the restore key
  close(): Promise<void>;                                      // release runtime, keep transcript

  revertConversation?/revertFiles?/revertBoth?({ messageId }): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  tryHandleOutOfBand?(prompt): { run(ctx) } | null;
}
```

The `close()` / delete distinction is load-bearing: **`close()` releases the runtime but
must never destroy the native transcript.** Archival is a separate, explicit
`archiveNativeSession()` hook on the client.

### 1.3 The normalized vocabulary

Everything a harness emits is flattened into one union, `AgentStreamEvent`:

```
thread_started | turn_started | turn_completed | turn_failed | turn_canceled
usage_updated | mode_changed | model_changed | thinking_option_changed
timeline { item: AgentTimelineItem }
permission_requested | permission_resolved
attention_required | provider_subagent
```

and `AgentTimelineItem`:

```
user_message | assistant_message | reasoning | tool_call | todo
error | notification | compaction | plugin
```

`tool_call` carries a **normalized `ToolCallDetail`** discriminated union — `shell`,
`read`, `edit`, `write`, `search`, `fetch`, `worktree_setup`, `sub_agent`, `plan`,
`plain_text`, `unknown`. Every provider ships a `tool-call-mapper.ts` +
`tool-call-detail-parser.ts` pair that maps its native tool vocabulary onto this.
`unknown` is the escape hatch that keeps unmapped tools renderable.

**This is the single highest-leverage decision in the whole design.** Because the UI only
ever sees `ToolCallDetail`, a Claude `Edit`, a Codex `patch_apply`, and an OpenCode
`edit` all render as the same diff card, and one renderer serves every harness.

### 1.4 Capability flags

```ts
interface AgentCapabilityFlags {
  supportsStreaming, supportsSessionPersistence, supportsSessionListing?,
  supportsDynamicModes, supportsMcpServers, supportsNativePaseoTools?,
  supportsReasoningStream, supportsToolInvocations,
  supportsRewindConversation?, supportsRewindFiles?, supportsRewindBoth?,
  [k: string]: boolean | undefined;
}
```

Current values:

| Provider | persistence | listing | dynamic modes | MCP | rewind conv / files / both |
|---|---|---|---|---|---|
| claude | ✓ | ✓ | ✓ | ✓ | ✓ / ✓ / ✓ |
| codex | ✓ | ✓ | ✗ | ✓ | ✓ / ✗ / ✗ |
| opencode | ✓ | ✓ | ✓ | ✓ | ✗ / ✗ / ✓ |
| ACP (copilot/cursor/…) | ✓ | ✓ | ✓ | ✓ | ✗ / ✗ / ✗ |
| pi / omp | ✓ | ✓ | ✓ | ✗ (pi: via adapter) | ✓ / ✗ / ✗ |

Capabilities gate *UI affordances*, not fallbacks. The project rule
([`docs/protocol-compatibility.md`](docs/protocol-compatibility.md)) is: gate the feature
once, then either run it or tell the user — never write a defensive fallback path.

---

## 2. Per-harness instrumentation

### 2.1 Claude Code — `providers/claude/agent.ts` (6,386 lines)

**Transport.** In-process use of `@anthropic-ai/claude-agent-sdk`'s `query()`. Paseo hands
it an async-iterable input queue and consumes `SDKMessage`s from the returned `Query`
object, which also exposes a control plane (`setPermissionMode`, `setModel`,
`supportedCommands`, `applyFlagSettings`, `interrupt`, `rewindFiles`).

`providers/claude/query.ts` wraps the SDK's `spawnClaudeCodeProcess` hook so Paseo — not
the SDK — owns the spawn. That wrapper:

- substitutes `process.execPath` when the SDK asks for a bare `node`/`bun` (PATH lookups
  fail inside the packaged daemon),
- applies user command overrides (`replace` / `append` modes),
- hands the `ChildProcess` back via `onChildProcess` so the session can `tree-kill` the
  whole process group on close — the SDK only kills its direct child, and MCP grandchildren
  would otherwise leak.

**Session identity.** `claudeSessionId` is a UUID owned by Claude. It is read out of
`SDKSystemMessage(subtype: "init")` and from any message's `session_id`. Critically, **it
can change mid-stream** (a hook can restart Claude). The adapter accepts the new id,
emits a `thread_started` plus a user-visible "session changed" notice, and re-reads
history rather than failing the turn (`captureSessionIdFromMessage`,
`handleSystemMessage`, lines ~4488–4575).

**Continuation.** `buildOptions()` sets exactly one of:
- `sessionId: <fresh uuid>` when starting a brand-new conversation with a pre-chosen id,
- `resume: <claudeSessionId>` in every other case.

The SDK query is torn down and rebuilt whenever `queryRestartNeeded` is set (model change,
thinking change, rewind). `ensureQuery()` nulls `this.query` *before* awaiting the old
iterator's return so the old pump recognizes it is orphaned and does not fail the active
turn, then tree-kills the retired process. `resume` makes the replacement continue the
same conversation.

**History.** Claude's transcript is a JSONL file. Paseo reads it **directly off disk**, not
through the SDK:

```
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl
  └── <session-id>/subagents/**.jsonl     ← sidechain transcripts + meta sidecars
  └── <session-id>/workflows/*.json       ← workflow run summaries
```

`providers/claude/project-dir.ts` is a **verbatim port of the SDK's private
project-directory encoding** (replace every non-alphanumeric with `-`, cap at 200 chars,
then append a `hashCode`-style base-36 suffix; canonicalize with `realpath`; NFC-normalize
on darwin). The file header comments even name the minified SDK functions to grep for
(`Ar`, `So`, `wn`, `Dy`, `Ni=200`). **This is a hard dependency on an undocumented
implementation detail** and is the single most fragile part of the Claude integration.

`resolveHistoryPath()` tries the configured `cwd` and its `realpath` before falling back,
because symlinked worktrees otherwise miss.

`loadPersistedHistory()` runs *synchronously in the constructor* when resuming, builds
`persistedHistory: PersistedTimelineEntry[]`, and sets `historyPending`. `streamHistory()`
then drains that buffer exactly once and clears it.

**Subagents.** The most elaborate part. Claude announces subagent lifecycle on the SDK
stream (`task_started` / `task_updated` / `task_notification` / `task_progress`). Paseo
translates both the live stream (`subagents/live-source.ts`) and the on-disk replay
(`subagents/replay-source.ts`) into **one observation vocabulary**
(`subagents/observation.ts`) folded by one function. The non-obvious rules — all
documented in [`docs/agent-lifecycle.md`](docs/agent-lifecycle.md#claude-provider-subagents-the-task-protocol):

- Filter on announced kind: `local_agent` and `local_workflow` belong in the track;
  `local_bash` (backgrounded shell) and `skip_transcript` do not — but they share the
  `tool_use_id` shape, so attributing them produces nameless rows that never finish.
- Task ids are **session-scoped, not turn-scoped**. Cancelling a turn must not clear the
  routing table, or a backgrounded child that settles later loses its descriptor.
- A resumed task is re-announced with a *new* `tool_use_id`; the first id stays canonical
  and later ids are routing aliases.
- Backgrounded subagents emit **no** frames carrying `parent_tool_use_id` at all.
- On replay, resolve the tree one proven generation at a time via `toolUseId`;
  `spawnDepth` orders candidates but does not establish ownership.
- Replay `totalTokens` is Claude's *last* assistant message usage (a context-size
  reading), not a sum — summing per-entry usage over-reports by the turn count.

**Permissions.** `canUseTool` callback → `AgentPermissionRequest` → client → user →
`respondToPermission`. Plan approval is special-cased: denying a plan still leaves the plan
in the timeline because the pending card was the only other copy of its text.

**Rewind.** `providers/claude/rewind.ts` uses the SDK's `forkSession(sessionId, {
upToMessageId })` for conversation rewind and `query.rewindFiles(messageId)` for file
checkpoints (which requires `enableFileCheckpointing: true` at launch). Fork returns a
*new* session id; `rebindConversationSession()` swaps it in, clears the derived caches,
reloads history from the new file, and emits a notice + `thread_started`.

**Runtime death.** Claude is the only provider that reports an *unexpected process exit
between turns* as a turn failure (`handleRuntimeExit`). This matters because background
shells, `Monitor` watches, and workflows all live inside the CLI process; without this the
agent would sit at `idle` looking healthy while its parked work is gone.

**Ephemeral sessions.** `persistSession: false` is silently dropped by Claude Code outside
`--print` mode, so `close()` deletes the transcript file itself for internal agents
(metadata/branch-name generators) so they do not pollute the import picker.

**Import discovery.** Scan `~/.claude/projects/**/*.jsonl` (or one project dir when `cwd`
is known), stat-sort by mtime, then line-filter each candidate with cheap regexes
(`"type":"(user|custom-title|ai-title)"`, `"sessionId":`, `"cwd":`) before JSON-parsing.
Title precedence: `custom-title` → `ai-title` → first user prompt → `Claude session <8
chars>`.

### 2.2 Codex — `providers/codex-app-server-agent.ts` (7,430 lines)

**Transport.** Spawns `codex app-server` (plus `--enable goals` when the binary is
≥ 0.128.0) and speaks newline-delimited JSON-RPC over stdio
(`providers/codex/app-server-transport.ts`). Handshake is `initialize` request →
`initialized` notification.

**Methods Paseo calls:**

```
initialize, initialized
thread/start, thread/resume, thread/read, thread/list
thread/loaded/list, thread/archive, thread/unarchive
thread/fork, thread/rollback, thread/compact/start
thread/goal/set, thread/goal/clear
turn/start, turn/steer, turn/interrupt
model/list, config/read, getUserSavedConfig
collaborationMode/list, skills/list
```

**Handlers Paseo registers** (server→client requests):

```
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/tool/requestUserInput
tool/requestUserInput
mcpServer/elicitation/request
```

**Session identity.** A Codex `threadId`. `describePersistence()` stores it as both
`sessionId` and `nativeHandle`, plus a metadata blob containing cwd, title, modeId, model,
thinkingOptionId, providerOptions, toolPolicy, systemPrompt, mcpServers, and a serialized
snapshot of in-flight async questions.

**The exclusive-writer constraint.** A persisted Codex thread can have only one writer,
even when idle. `ensureThreadLoaded()` therefore first asks `thread/loaded/list` and skips
`thread/resume` if the thread is already loaded in this app-server. `AgentManager` reload
closes the old session *before* resuming (`agent-manager.ts:1525`) for the same reason.

**Archived-thread repair.** If `thread/resume` fails with an archived-thread error, the
adapter calls `thread/unarchive` and retries once, tolerating an
"already unarchived" race. This is how a session archived outside Paseo gets repaired when
its Paseo agent is still active.

**History.** `thread/read { threadId, includeTurns: true }` returns `thread.turns[].items[]`,
which `loadCodexThreadHistoryTimeline()` folds into `PersistedTimelineEntry[]`. Sub-agent
child threads are discovered inside those items (`agentThreadId`), then read recursively —
breadth-first, capped at 100 visited threads — and re-emitted as `provider_subagent`
timelines.

**Read-only history mode.** Codex is the only provider with a distinct
`AgentResumeSessionOptions.purpose: "history"`. `establishConnection()` branches: for
`history`, `readArchivedHistory()` spawns a *temporary* app-server, initializes, reads the
thread, and disposes the process before returning. It never loads, resumes, or unarchives
the native thread. This is what lets Paseo show an archived agent's transcript without
resurrecting it in Codex's own UI.

**Terminal-event hygiene.** Codex may omit the completed `contextCompaction` item when a
turn ends during compaction, so the adapter closes any pending root compaction before
forwarding `turn_completed` / `turn_failed` / `turn_canceled`. General rule in
[`docs/providers.md`](docs/providers.md): *no terminal turn may leave a client rendering an
operation as still loading.*

**Rewind.** Two paths depending on `thread.historyMode`:
- `paginated`: `thread/fork { beforeTurnId }` — one call.
- `legacy`: `thread/fork` (full copy) then `thread/rollback { numTurns }`.

Fork is non-destructive: the original thread file survives and is still recoverable with
`codex resume <old-uuid>`. Rollback is chat-only; file edits stay on disk.

**Steering.** `turn/steer` with the native expected turn id and the Paseo client
user-message id. Codex clears pending input when it aborts a turn, so its adapter does not
need the manual queue-discard that Claude's does.

**Import discovery.** `thread/list { limit, cwd? }` returns cheap `{ id, cwd, name,
preview, updatedAt, createdAt }` rows. Paseo over-fetches (≥ 50) when filtering by cwd and
applies a realpath-aware local filter for symlinked worktrees.

### 2.3 OpenCode — `providers/opencode-agent.ts` (5,332 lines)

**Transport.** A long-lived HTTP server, not a per-session process.
`providers/opencode/server-manager.ts` is a ref-counted singleton that spawns
`opencode serve` on a free port, tracks generations (`current` + `retired`), and exposes:

```ts
acquireCurrent(signal?)   // shared server, ref-counted
acquireNew(signal?)       // force a fresh generation (catalog refresh)
acquireDedicated(env)     // isolated server for custom env / custom MCP
acquireExisting(url)      // attach to a specific known generation
```

Server home is `$PASEO_HOME/opencode-home`, keeping OpenCode's state out of `~/.config`.

Events arrive on **one global SSE stream** per server generation
(`providers/opencode/event-consumer.ts`), consumed by `OpenCodeEventConsumer` with a
30 s watchdog, exponential backoff capped at 5 s, and a `server-exited` sentinel. Sessions
filter the global stream by `sessionId`. (History: this replaced a per-directory `/event`
stream — see [`docs/opencode-global-event-baseline.md`](docs/opencode-global-event-baseline.md).)

Events consumed: `session.created/updated/deleted/idle/error/compacted/status`,
`message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked`,
`question.asked`, `todo.updated`.

SDK surface used: `session.create/get/update/delete/messages/promptAsync/abort/children/status`,
`app.agents`, `command.list`.

**Isolation rule.** OpenCode 1 keeps MCP config and process environment *outside* the
session boundary. So an agent with custom env vars or user-configured MCP servers gets a
**dedicated server** (`requiresDedicatedOpenCodeServer()`). Keep that until OpenCode
exposes those as session-owned config.

**The bridge.** To give ordinary agents per-session environment and the caller-scoped
Paseo tool catalog *without* a dedicated server, Paseo installs a daemon-owned OpenCode
plugin via `OPENCODE_CONFIG_CONTENT` (`providers/opencode/bridge.ts` +
`bridge-plugin.mjs`). The plugin calls back to a private loopback HTTP server
(`127.0.0.1:<random>`, bearer-token authenticated) to fetch the exact env and tool catalog
for each OpenCode session id. Bridge context lives only in daemon memory and is dropped
when the Paseo session closes; the content-addressed plugin artifact contains no session
data or secrets. This is why OpenCode sets `supportsNativePaseoTools: true`.

**Session identity.** OpenCode's session id. `describePersistence()` deliberately stores a
*minimal* metadata blob — `{ cwd, modeId?, model? }` — unlike Claude's full config spread.

**Message-id ownership.** OpenCode owns user message ids. Paseo must **not** pass its own
ids to prompt APIs; it lets OpenCode mint `msg*` ids and records the canonical user row
from the `message.updated` event.

**History.** `session.get` + `session.messages`, then
`filterOpenCodeRevertedMessages(messages, session.revert)` drops reverted messages, then
`buildOpenCodeReplayTimelineEvents()` per message. Compaction is reconstructed by looking
for a `compaction` part on a user message and suppressing the following assistant message.

**Live/replay dedup.** Because the global event stream and the replay path can both
deliver the same message, translation state carries
`hydratedMessageFingerprints` / `hydratedPartFingerprints` (`JSON.stringify` of the
hydrated value) so a replayed row is not re-emitted when the identical live event arrives.

**Gap recovery.** `reconcileAfterGap(revision, refresh, delay)` re-reads
`session.messages` and re-reconciles blocking permission/question requests when the SSE
stream reports a revision gap.

**Cancellation is session-scoped, not turn-scoped.** `session.abort` cancels the whole
session. [`docs/providers.md`](docs/providers.md) devotes a whole gotcha section to this;
the contract the adapter implements:

- model the stop as an explicit `stopping` turn-state variant carrying the canceled run's
  terminal and the cancellation still owed;
- **scope the cancel settlement the way the provider scopes the cancel** — track every
  issued abort on the *session*, let it outlive the stop that issued it, and let only the
  newest hold the gate;
- gate daemon-issued operations (prompt, slash command, summarize) on both terminal and
  cancel settlement, but keep permission/question responses *outside* the gate or an
  auto-approve deadlocks the stop;
- fail closed: a cancel that never succeeded never proved the run stopped;
- suppress the canceled run's residue only until its authoritative terminal — anything
  after that is a new run (autonomous/plugin wake) and must take the live path.

**Archive.** OpenCode has no archive verb; Paseo writes `session.update { time: { archived:
<ms> } }`, using `0` as the active sentinel for unarchive.

**Steering.** `session/prompt_async` with an OpenCode-generated message id; the server
queues it while busy and the next LLM call in the same Paseo turn picks it up.

**Provider-managed children.** `session.children` / `session.created` events register child
session ids against the owning server URL
(`registerOpenCodeChildSessionServerUrl`), so a later `resumeSession` for that child can
`acquireExisting(url)` instead of guessing.

### 2.4 ACP — `providers/acp-agent.ts` (3,928 lines)

The generic base class. Copilot, Cursor, Kimi, Kiro, Trae and all user-defined
`extends: "acp"` providers are thin subclasses supplying `defaultCommand`, modes,
capabilities, and an `isAvailable()` override.

Resume negotiates on advertised capability: `loadSession` (which *replays* the session as
notifications, so the adapter sets `replayingHistory = true` and captures them into
`persistedHistory`) or `unstable_resumeSession` (state only, no replay).

> Never drop `cwd` or `mcpServers` from `session/load` or `unstable_resumeSession` even
> when capabilities suggest they are optional — some agents (Devin CLI) return
> "Invalid params". An empty `mcpServers: []` is required, not omittable.

Import listing uses `session/list` with cursor pagination, and — when `loadSession` is
available — actually loads each candidate under a **global time budget**
(`ACP_IMPORT_HISTORY_BUDGET_MS`) with a per-session timeout, caching previews keyed on
`updatedAt`, and closing each loaded session afterwards. A load failure keeps the session
visible rather than hiding it.

Mode ids may be full URIs (`https://agentclientprotocol.com/protocol/session-modes#agent`).
Permission options are returned by exact `optionId`, which lets agents encode a
single-choice question as several options of the same allow kind; auto-accept never
resolves those.

### 2.5 Pi / OMP — `providers/pi/`, `providers/omp/`

Child-process JSONL RPC (`jsonl-rpc-process.ts` + `jsonl-frame-decoder.ts` are shared).
Interesting for the meta-harness question because **`nativeHandle` is a file path**, not an
id: `describePersistence()` returns `{ sessionId, nativeHandle: this.state.sessionFile }`,
and resume passes that file to the runtime. Import discovery reads Pi's JSONL session
directory directly (bounded 64 KiB head + 256 KiB tail scan) because Pi's RPC exposes no
recent-session listing.

---

## 3. Restoring a conversation after the harness closed

### 3.1 What Paseo persists

One JSON file per agent, atomically written:

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the filesystem `cwd` (Windows drive roots and UNC
paths are sanitized), **not** from the workspace id — agent storage stays cwd-keyed while
workspace identity is an opaque id.

Schema: `packages/server/src/server/agent/agent-storage.ts`.

```jsonc
{
  "id": "…", "provider": "claude", "cwd": "/repo",
  "workspaceId": "…", "createdAt": "…", "updatedAt": "…",
  "lastActivityAt": "…", "lastUserMessageAt": "…",
  "title": "…", "labels": { "paseo.parent-agent-id": "…" },
  "lastStatus": "closed",            // initializing|idle|running|error|closed
  "config": {                        // SERIALIZABLE subset only
    "modeId", "model", "thinkingOptionId", "featureValues",
    "providerOptions", "toolPolicy", "systemPrompt", "mcpServers"
  },
  "runtimeInfo": { … },
  "features": [ … ],
  "persistence": {                   // ← the restore key
    "provider": "claude",
    "sessionId": "<native id>",
    "nativeHandle": "<native id or file path>",
    "metadata": { …provider-private config snapshot… }
  },
  "archivedAt": null, "internal": false, "owner": { … }
}
```

**No timeline rows.** `AgentManager` holds an `InMemoryAgentTimelineStore`; the
`durableTimelineStore` slot exists in the constructor options but is **not wired in
`bootstrap.ts`**. That is deliberate:

> Provider history is the durable transcript authority and rebuilds the projection when an
> agent resumes. — [`docs/timeline-sync.md`](docs/timeline-sync.md)

Two things are deliberately *not* persisted into the config:
`daemonAppendSystemPrompt` (so daemon setting changes apply cleanly on next resume) and
`launchContext.paseoTools` (runtime-only). The injected Paseo MCP server is stripped on
the way in and re-injected at launch (`runtime-mcp-config.ts`), so rotating the MCP base
URL or auth token does not corrupt stored records.

### 3.2 The restore path

`agent-loading.ts::ensureAgentLoaded(agentId)` — lazy, called from every entry point that
needs a live agent (open the agent, prompt it, fork it, run a schedule, an MCP tool):

1. `await waitForAgentClose(agentId)` — barrier against an in-flight close.
2. Return the live agent if `AgentManager` already has it.
3. Second `waitForAgentClose` barrier (a close may have started between step 1 and 2).
4. De-dupe concurrent initializations through a module-level
   `pendingAgentInitializations` map, OR-ing the `broadcastTimeline` intent.
5. Read the record. Refuse if the provider is no longer registered.
6. If `record.persistence` exists → `AgentManager.resumeAgentFromPersistence(handle,
   buildConfigOverrides(record), agentId, timestamps, archived ? {purpose:"history"} : undefined)`.
   Otherwise → `createAgent(buildSessionConfig(record))`.
7. `hydrateTimelineFromProvider(agentId)`.

`resumeAgentFromPersistence` then:

- re-reads the durable record *inside the lifecycle lane* to decide the resume purpose
  (a queued archive/restore may have landed since the loader read it),
- checks `client.isAvailable()` and fails loudly if the CLI is gone,
- rebuilds the launch context (env, Paseo tool policy, MCP injection),
- calls `client.resumeSession(handle, overrides, launchContext, { purpose })`,
- registers the session.

`hydrateTimelineFromProvider` drains `session.streamHistory()`, bounds each item's content
(64 KiB shell output cap, same as live), filters out system-injected envelopes, appends to
the in-memory store, and optionally broadcasts. `force: true` deletes the timeline first
so a new epoch is minted — used by rewind and by the user-facing "Reload agent" action
(`reloadAgentSession({ rehydrateFromDisk: true })`).

### 3.3 Per-provider restore mechanics, side by side

| | Claude | Codex | OpenCode |
|---|---|---|---|
| Handle | session UUID | threadId | session id |
| `nativeHandle` | same UUID | same threadId | same session id |
| Metadata blob | full `ClaudeAgentConfig` | cwd/title/mode/model/thinking/options/policy/prompt/mcp/questions | `{ cwd, modeId?, model? }` |
| Continuation mechanism | SDK `resume: <id>` | `thread/resume` (skipped if `thread/loaded/list` has it) | attach to server + session id |
| History source | read `<cwd>/<id>.jsonl` off disk | `thread/read { includeTurns: true }` | `session.messages` + `session.revert` filter |
| Read-only history mode | no (reads disk anyway) | **yes** (`purpose: "history"`, temp app-server) | no |
| Native archive/unarchive | none | `thread/archive` / `thread/unarchive` | `session.update { time.archived }` |
| Single-writer constraint | process-level | **yes**, thread-level | server-level (ref-counted) |
| Id mutates on rewind | **yes** (`forkSession`) | **yes** (`thread/fork`) | no (in-place `session.revert`) |

### 3.4 Restore gotchas worth stealing

1. **Close before resume.** An idle provider process can still own an exclusive writer. A
   failed close must retain the runtime for cleanup and *block* the replacement; only once
   closure succeeds may a failed resume leave the agent closed-and-retryable.
2. **Connection owns every process it spawns until registration.** If init, resume, or the
   initial hydration throws, `connect()` must dispose the child before rethrowing —
   `AgentManager` cannot clean up a session it never received.
3. **The native id is not stable.** Rewind/fork mint new ids in both Claude and Codex.
   `describePersistence()` must be re-read after any operation that can rebind, and
   `AgentManager.refreshSessionPersistence()` does exactly that.
4. **cwd must survive into the handle.** `attachPersistenceCwd()` stamps the agent's cwd
   into `handle.metadata` on every refresh, because Claude and OpenCode both refuse to
   resume without the original working directory, and the path encoding depends on it.
5. **Realpath everything.** Symlinked worktrees are the standard failure: Claude's project
   dir encoding, the import cwd filter, and the archived-import cwd check all use
   realpath-aware matchers.
6. **History load must never be fatal.** Claude's `loadPersistedHistory` swallows all
   errors; Codex's child-history loader logs and continues. A corrupt transcript should
   produce a short timeline, not an unopenable agent.
7. **Bound the replay the same way you bound the live stream.** Otherwise reopening an
   agent restores an oversized tool payload that the live path would have truncated.

### 3.5 Importing sessions the harness started on its own

This is restore-from-nothing: no Paseo record exists at all.

Discovery — `AgentManager.listImportableSessions()` fans out to every client with
`supportsSessionListing && listImportableSessions`, each under a timeout, collecting
per-provider errors rather than failing the whole listing. Rows are deliberately thin:

```ts
interface ImportableProviderSession {
  providerHandleId: string; cwd: string; title: string | null;
  firstPromptPreview: string | null; lastPromptPreview: string | null;
  lastActivityAt: Date;
}
```

`import-sessions.ts` then filters out (a) sessions whose cwd does not realpath-match the
request, (b) sessions older than `since`, (c) Paseo's own internal metadata-generation
sessions (detected by prompt prefix), and (d) anything already imported — matching on
*both* `sessionId` and `nativeHandle`.

Import — `importProviderSession()` serializes per handle (a `WeakMap` of mutation queues),
provisions/〈re〉uses a workspace, then either:

- **re-activates an archived record** for the same handle (unarchive → `ensureAgentLoaded`
  → on failure, roll back to archived), or
- calls `AgentManager.importProviderSession()`, which calls the provider's
  `importSession()`.

Almost every provider implements `importSession` via the shared
`provider-session-import.ts::importSessionFromPersistence()`, which is just:
*synthesize a persistence handle from the row → `resumeSession` → drain `streamHistory()`
into `ImportedTimelineEntry[]`*. OpenCode adds one pre-step: it reads the session to
recover its title, mode and model before resuming, because those are not in the handle.

The manager seeds the daemon timeline from the imported rows and publishes the agent only
once it is ready (`publishWhenReady: true`, `historyPrimed: true`), then replays the
provider-subagent events.

**The listing contract is strict: the picker calls `listImportableSessions` and gets rows
only; `importSession` must not call listing again.**

---

## 4. Migrating a conversation to a new harness

### 4.1 What exists: Fork (cross-provider, lossy)

Wire: `agent.fork_context.request` → `agent.fork_context.response`, gated on the
`agentForkContext` host feature (and `agentForkContextCursor` for the cursor form).

Server: `session.ts::handleAgentForkContextRequest` → `activity-curator.ts::buildAgentForkContextAttachment`.

1. Load the agent (`ensureAgentLoaded` — forking an unloaded agent resumes it first).
2. Fetch the entire projected timeline (`direction: "tail", limit: 0`).
3. `selectForkContextRows()` picks the prefix:
   - no boundary → the whole timeline *including a partially streamed in-flight turn*
     (this is what makes mid-run forking work);
   - `boundaryCursor { epoch, seq }` → validate the epoch, find the projected row whose
     `seqEnd === seq`;
   - `boundaryMessageId` → last `assistant_message` with that id.
   - **Refuse** if any projected row spans the boundary and changed afterwards:
     *"This checkpoint changed after it was created. Fork from a later completed response
     instead."* Discarded historical payloads cannot be reconstructed from sequence metadata.
4. Curate into text with `curateProjectedActivityEntries`, restricted to
   `["user_message", "assistant_message", "tool_call"]`, with
   `labelAssistantMessages: true` and `includeExternalToolInput: false`. Reasoning, todos,
   errors and compaction markers are dropped. Tool calls become
   `[<DisplayName>] <summary ≤200 chars>`.
5. Wrap:

```
<chat-history-summary>
Chat history from a previous Paseo agent.
Source agent: <title>
Source directory: <cwd>

[User] …
[Assistant] …
[Bash] npm test
…
</chat-history-summary>
```

6. Return it as a `TextAttachment` with `contextKind: "chat_history"`.

Client (`packages/app/src/hooks/use-fork-agent.ts`):

1. Mint a `draftId`, request the fork context, store the attachment under that draft's
   workspace-attachment scope.
2. Build a `WorkspaceDraftTabSetup` from the *source* agent —
   `{ provider, cwd, modeId, model, thinkingOptionId, featureValues }` — as the draft's
   **initial** selection.
3. Open either a new tab in the same workspace or the new-workspace flow.

**The migration hinge:** that setup only seeds the composer. The composer's agent controls
(`packages/app/src/composer/agent-controls/`) expose a provider selector
(`onSelectProvider`, `onSelectProviderAndModel`), so the user changes the draft to Codex or
OpenCode and submits. The new agent is created from scratch in the target harness with the
chat-history attachment as the first content block.

`prompt-attachments.ts::buildAgentPrompt` guarantees the placement: **chat-history
attachments are hoisted to the front of the content block array**, before the user's text,
before images, before every other attachment.

What is lost: reasoning traces, tool inputs/outputs beyond a 200-char summary, todo state,
file checkpoints, provider-side compaction state, background shells, subagent trees, MCP
approvals, and the provider's KV cache. What survives: the user/assistant conversation
shape and a one-line trace of every tool call.

### 4.2 What exists: intra-provider fork (lossless, same harness)

Rewind (`AgentManager.rewind(agentId, messageId, mode)`, modes `conversation | files |
both`) is really "fork the native session at a point":

- **Claude** — `forkSession(sessionId, { upToMessageId })` → new session id, rebind,
  re-read history. `query.rewindFiles()` for the file half (needs
  `enableFileCheckpointing: true`).
- **Codex** — `thread/fork` (+ `thread/rollback` on legacy history mode) → new thread id.
  Non-destructive; the original remains at `codex resume <old-uuid>`.
- **OpenCode** — `session.revert({ messageID })`, in place, both chat and files. Unrevert
  stays available only until the next prompt triggers cleanup, so Paseo exposes revert only.

Rewind requires the **provider** message id. A Paseo-submitted prompt cannot be rewound
until the provider's echo supplies that identity — `AgentManager` refuses with
*"Cannot rewind before the provider acknowledges the submitted prompt"*.

### 4.3 What does not exist

There is no path that takes a Claude session and continues it as a Codex thread with full
fidelity. Structurally this is blocked by:

- `AgentPersistenceHandle.provider` being part of the record and the routing key;
- `handle.metadata` being provider-private (a `ClaudeAgentConfig` means nothing to
  `CodexAppServerAgentClient`, and each client `assertConfig`s on `config.provider`);
- `providerOptions` being explicitly declared non-portable in
  [`docs/providers.md`](docs/providers.md);
- tool-call *inputs* being normalized only for display, not round-trippable — `ToolCallDetail`
  is lossy by design (`summary`, `unifiedDiff`, truncated `output`), so you cannot
  reconstruct a faithful provider-native transcript from it.

A meta-harness that *does* want lossless cross-harness migration has to make a different
bet at the timeline layer: keep a durable, lossless, provider-neutral transcript
(the `durableTimelineStore` slot Paseo left unwired), and give every provider an
`importTimeline(rows)` that can seed a fresh native session from it. Both halves are real
work — most harnesses have no "prefill this conversation" API, so seeding degrades to
prompt-injection anyway, which is exactly what Fork already does, only with more bytes.

---

## 5. Supporting machinery worth copying

### 5.1 Tool injection: catalog first, MCP as fallback

Paseo's own tools (`create_agent`, `send_agent_prompt`, `wait_for_agent`, browser tools, …)
live in a shared catalog at `agent/tools/`. **MCP is only the adapter.**

- Provider sets `supportsNativePaseoTools: true` → receives the already-filtered
  `launchContext.paseoTools` and registers them natively. `AgentManager` then *strips* the
  internal Paseo MCP server from the launch config so the tools are not delivered twice.
  (OpenCode via the bridge; OMP directly.)
- Otherwise the daemon injects an HTTP MCP server at
  `<base>/mcp/agents?callerAgentId=<id>` with a bearer capability token
  (`runtime-mcp-config.ts`).

Filtering is enforced **at catalog registration** in both paths. The policy belongs to the
caller, and is *not* inherited: when an agent calls `create_agent`, the child gets the
policy for the child's provider id.

### 5.2 Process hygiene

- `createProviderEnvSpec()` strips `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SSE_PORT`, `CLAUDE_AGENT_SDK_VERSION` from every child env. Without this, a
  daemon launched *from inside* a Claude Code session poisons every child with
  "cannot be launched inside another session".
- `terminateWithTreeKill` everywhere, with graceful → force timeouts. Vendor SDKs kill only
  their direct child; MCP grandchildren survive as orphans otherwise.
- Long-lived helper processes (the OpenCode server) are recorded in a **managed-process
  registry** with pid + launch command + platform process identity. Daemon bootstrap
  reconciles that ledger in the background: dead pids deleted, identity mismatches deleted
  *without killing*, only positively-matched Paseo-owned leftovers terminated, and
  un-inspectable records left for the next pass. No broad process-name sweepers.
- **Own the process from `spawn`, not from readiness.** A helper kept only inside a
  readiness promise is a live process outside the manager/reaper contract.

### 5.3 Catalog discovery and caching

`ProviderSnapshotManager` owns one refresh deadline per provider, covering the availability
check *and* the full catalog probe (not per-request). Providers name their active
operations via `ProviderRefreshContext.runActivity(name, fn)` so a timeout error can say
which upstream call was still pending. Results are cached by `getCatalogCacheKey`, and
saved provider/model choices are treated as **user intent** — a catalog failure must never
erase them or silently substitute another model.

### 5.4 Timeline projection and delivery

Two delivery paths, deliberately: a live `agent_stream` (may carry lifecycle deltas) and an
authoritative `fetch_agent_timeline_request` (always full projected items). Projection
merges assistant/reasoning chunks and collapses a tool-call lifecycle into one item, so
page limits count *projected* items while `seqStart` / `seqEnd` / `sourceSeqRanges` /
`collapsed` let clients advance their cursors. Gap recovery pages forward until
`hasNewer: false`. Timestamps are daemon-owned; providers may supply original replay
timestamps.

The one permitted in-place mutation is enriching a manager-owned submitted user row with
its provider message id — preserving seq, content, and timestamp. That id is what makes
rewind and fork addressable.

---

## 6. Implementation blueprint

If I were building this from zero, in this order:

**Phase 1 — the contract.**
Define `AgentStreamEvent`, `AgentTimelineItem`, and especially `ToolCallDetail` *first*.
Write the Claude adapter and the Codex adapter against them simultaneously; a normalization
layer designed against one harness will be wrong. Keep `AgentProvider = string`.

**Phase 2 — one provider end to end.**
Claude, because its SDK gives you streaming, permissions, modes and rewind without a
protocol design of your own. Ship: spawn → `startTurn` → `subscribe` → normalized timeline
→ permission round-trip → `close()`.

**Phase 3 — persistence and restore.**
Add `describePersistence()` / `resumeSession()` / `streamHistory()`. Persist the handle to
a per-agent JSON file. Make loading lazy and de-duplicated. Resist adding a durable
transcript store; make provider history the authority and prove that a daemon restart
restores every agent.

Non-negotiables to build in now, not later: the close-before-resume barrier, connection
owning its process until registration, re-reading `describePersistence()` after any
rebinding operation, and stamping `cwd` into the handle metadata.

**Phase 4 — second and third harnesses.**
Codex (stdio JSON-RPC) and OpenCode (HTTP + SSE) are the two shapes that stress the
abstraction differently: Codex forces the single-writer and read-only-history questions;
OpenCode forces the shared-server, session-scoped-cancel, and live/replay-dedup questions.
Everything that survives those three is probably right.

**Phase 5 — import.**
`listImportableSessions` + `importSession`, with the shared
`importSessionFromPersistence` helper. Cheap rows only; strict "don't list twice" contract;
realpath-aware cwd matching; filter already-imported by both id fields.

**Phase 6 — ACP.**
One base class buys you every ACP agent at once. Treat it as the default path for new
providers and keep bespoke adapters for the three or four harnesses that justify them.

**Phase 7 — migration.**
Fork-as-attachment. Build the boundary-cursor validation from the start
(epoch + `seqEnd`, refuse when a spanning item changed); retrofitting it onto rendered
item indices is not possible because projection merges rows.

---

## 7. Gotcha compendium

Ranked by how much time each would cost to rediscover.

1. **Claude's project-dir encoding is undocumented and ported verbatim.** Non-alphanumerics
   → `-`, 200-char cap, base-36 `hashCode` suffix, realpath, NFC on darwin. Re-derive it
   from the SDK bundle on every SDK upgrade.
2. **Codex threads have exactly one writer, even when idle.** Check `thread/loaded/list`
   before `thread/resume`; close the old session before reloading.
3. **OpenCode's abort is session-scoped.** A cancel still in flight will kill the
   *replacement* run. Track settlement on the session, not the stop.
4. **Native session ids mutate.** Claude `forkSession` and Codex `thread/fork` both return
   new ids; Claude's id can also change mid-stream when a hook restarts the process.
5. **Don't mint user message ids for OpenCode.** Let it create `msg*` and record the row
   from `message.updated`.
6. **`persistSession: false` is a lie in Claude outside `--print`.** Delete the transcript
   yourself for ephemeral/internal agents.
7. **Steering owes an interrupt contract.** Stopping a turn must discard steers the provider
   has not read, or one of them resumes the turn the user just stopped. Codex clears its own
   queue; Claude does not (the adapter cancels the SDK messages it queued before
   `query.interrupt()`); Pi needs `clear_queue` before `abort`.
8. **Terminalize every transient row before the turn's terminal event.** A terminal turn
   must never leave a client rendering an operation as loading.
9. **Claude task ids are session-scoped, not turn-scoped**, and backgrounded subagents emit
   no `parent_tool_use_id` frames at all — they exist only because the task protocol
   announces them.
10. **Replay `totalTokens` ≠ cumulative spend** for Claude subagents. It's the last
    assistant message's usage block.
11. **Strip parent-session env vars** (`CLAUDECODE`, …) or a daemon launched from inside
    Claude Code breaks every child.
12. **Tree-kill, always.** MCP grandchildren outlive SDK cleanup.
13. **Realpath-aware path matching everywhere.** Worktrees and symlinked repos are the
    common case, not the edge case.
14. **Provider snapshots must not erase user intent.** A failed catalog probe keeps the
    saved model selection.
15. **A provider runtime can die between turns and nothing is watching.** Report the exit as
    a turn failure so the agent lands in `error` rather than sitting at `idle` with its
    background work silently dead. Only Claude does this today.
16. **Fork boundaries need an epoch, not an index.** Projection merges rows, so rendered
    indices are not durable anchors.

---

## 8. File index

| Concern | File |
|---|---|
| Contract | `packages/server/src/server/agent/agent-sdk-types.ts` |
| Lifecycle, timeline, hydration | `packages/server/src/server/agent/agent-manager.ts` (5,289) |
| Lazy restore | `packages/server/src/server/agent/agent-loading.ts` |
| Record schema + atomic writes | `packages/server/src/server/agent/agent-storage.ts` |
| Record ⇄ config mapping | `packages/server/src/server/persistence-hooks.ts` |
| Import orchestration | `packages/server/src/server/agent/import-sessions.ts` |
| Shared import helper | `packages/server/src/server/agent/provider-session-import.ts` |
| Fork context builder | `packages/server/src/server/agent/activity-curator.ts` |
| Fork client driver | `packages/app/src/hooks/use-fork-agent.ts` |
| Attachment placement | `packages/server/src/server/agent/prompt-attachments.ts` |
| Timeline projection | `packages/server/src/server/agent/timeline-projection.ts` |
| MCP injection | `packages/server/src/server/agent/runtime-mcp-config.ts` |
| Launch/env resolution | `packages/server/src/server/agent/provider-launch-config.ts` |
| Catalog cache | `packages/server/src/server/agent/provider-snapshot-manager.ts` |
| Claude adapter | `packages/server/src/server/agent/providers/claude/agent.ts` (6,386) |
| Claude project dir port | `packages/server/src/server/agent/providers/claude/project-dir.ts` |
| Claude spawn wrapper | `packages/server/src/server/agent/providers/claude/query.ts` |
| Claude rewind | `packages/server/src/server/agent/providers/claude/rewind.ts` |
| Claude subagents | `packages/server/src/server/agent/providers/claude/subagents/` |
| Codex adapter | `packages/server/src/server/agent/providers/codex-app-server-agent.ts` (7,430) |
| Codex transport | `packages/server/src/server/agent/providers/codex/app-server-transport.ts` |
| Codex rewind | `packages/server/src/server/agent/providers/codex/rewind.ts` |
| OpenCode adapter | `packages/server/src/server/agent/providers/opencode-agent.ts` (5,332) |
| OpenCode server manager | `packages/server/src/server/agent/providers/opencode/server-manager.ts` |
| OpenCode bridge + plugin | `packages/server/src/server/agent/providers/opencode/bridge.ts`, `bridge-plugin.mjs` |
| OpenCode SSE consumer | `packages/server/src/server/agent/providers/opencode/event-consumer.ts` |
| ACP base class | `packages/server/src/server/agent/providers/acp-agent.ts` (3,928) |
| Pi session discovery | `packages/server/src/server/agent/providers/pi/session-descriptor.ts` |
