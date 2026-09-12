# @endo/opencode-sandbox — design

Status: **proposed (2026-09-11, revised through adversarial review)** — the
backend source is not written yet; the `oci/` build seed and the patched fork
exist. Target lineage: the hosted-backend seam from PR #1248
(`codex/claude-provisioning-fixes` @ `4b9fe52c0`).

**Lineage dependencies that must land first.** The OpenCode backend needs the
hosted-backend seam (`@endo/hosted-agent`, present in PR #1248) **and** a
credential cap backed by the Endo secrets manager. The latter is the Tokyo
commit `f13c7cbd9` (`packages/claude-sandbox/src/managed-credentials*.js`,
`provideManagedCredentials`), which is **not** in PR #1248; the PR branch's own
`claude-credentials-factory.js` is a sidecar-file cap with no SecretBlob and no
`@secrets`. The OpenRouter secret convention is also Tokyo-side: `be6c5ceb4`
defaults the name to `${FLOOT_DIR}-openrouter-auth`, and `openrouter-auth`
applies only when `FLOOT_AUTH_SECRET_NAME=openrouter-auth`. This design assumes
the SecretBlob path (the stated requirement is "the OpenRouter API key stored in
the Endo secrets manager"), so `f13c7cbd9` must be rebased/ported onto the
working branch before milestone 2. The direct OpenRouter API provider in
`be6c5ceb4` (`packages/lal/providers/openrouter.js`) is a different path and is
not part of this design.

## Goal

Run the [opencode](https://opencode.ai) CLI inside an `@endo/sandbox` rootless
**podman slice** — the same substrate as `@endo/claude-sandbox` and
`@endo/codex-sandbox` — and expose it to Floot as a hosted backend, with its
OpenRouter credential supplied by the Endo **secrets manager** and
**auto-compaction on**.

Parity with the existing CLI backends (as-built, not aspirational):

| Concern | claude-sandbox | codex-sandbox | opencode-sandbox (this) |
|---|---|---|---|
| Runtime substrate | rootless podman slice | rootless podman slice | rootless podman slice |
| Workspace | 9P mount from an Endo `Filesystem` cap (raw host bind) | quota'd named volumes under a broker policy | 9P mount |
| Session state | dedicated config `Filesystem` (9P) | quota'd named volumes | **host-backed volume; not 9P** (see State) |
| Endo tools | per-session MCP socket bridge | app-server dynamic tools | per-session MCP socket bridge |
| Transport | `claude -p --output-format stream-json` per turn | long-lived `codex app-server` over stdio JSONL | **long-lived in-slice `opencode serve` + stdio bridge** |
| Continuity | CLI transcript (`transcript`) | app-server thread (`opaque-reconciled`) | opencode session store (`transcript`) |
| Credential | env-injected (`ANTHROPIC_API_KEY` / OAuth token) | broker/lease, nothing in slice (`credentialInjection: 'broker-only'`) | env-injected `OPENROUTER_API_KEY` (phase 1) |

## Why opencode

- **Automatic context compaction — and two transports that can carry it.** The
  runtime compacts on context overflow. On the stock `run --format json`
  surface the summary is emitted as ordinary `text` with no discriminator, so
  Floot would commit it as answer text (verified live on 2026-09-11 — see
  Review record). Two fixes exist: the HTTP server surface tags it (the bridge
  drops `info.summary === true` messages), and the pinned fork build filters
  the summary and its synthetic continuation in `run` itself. The server
  surface remains primary because it also streams tool-call starts and has an
  interrupt.
- **True streaming and tool-call starts.** The server event stream also
  provides `message.part.delta` (`{partID, messageID, field:'text', delta}`)
  and tool parts with `state.status` transitions — better than the `run`
  surface, which emits text only when a part completes and tool calls only on
  completion.
- **OpenRouter is first-class.** models.dev declares provider `openrouter` with
  env `OPENROUTER_API_KEY` (361 models). The CLI reads that env at startup, so
  no `auth.json` seeding is required; an `auth.json` key would override the env,
  and config `provider.options.apiKey` beats both — the design neutralizes both
  (see Security).
- **No published ports needed.** The server listens on slice loopback; a
  long-lived stdio bridge that runs beside it is the carrier to the host, and
  the sandbox `slice` exposes only `spawn` (`podman exec -i`).
- **MCP client.** Local stdio MCP servers are supported and load automatically,
  so the existing Endo MCP bridge carries over with a new config generator.
- **Pinnable artifact.** The CLI is a compiled Bun binary, so the published
  npm installer cannot carry patches; production builds the fork at a pinned
  commit with `bun@1.3.14` (see Image). The platform binary needs only glibc
  ≤ 2.30, so `node:22-bookworm-slim` (2.36) is fine.

## Architecture

```
Floot factory (agent.js)
  └─ discovers pet name `floot/controller-profile/opencode-backend`
      └─ HostedBackendFactory (describe/listModels/create/destroy)
          ├─ OpencodeSessionProvisioner ── per-session formula
          │     ├─ 9P mounter:   Filesystem cap → host mount → slice /workspace
          │     ├─ state volume: host-backed rw mount → /opencode-state
          │     │                (XDG_DATA_HOME; SQLite sessions/projects)
          │     ├─ credentials:  secrets/<name> → OPENROUTER_API_KEY
          │     │                (slice env at make(); see containment notes)
          │     └─ MCP bridge:   Endo HostedToolSet → unix socket → stdio relay
          │                      → host-generated `mcp.endo` config
          └─ OpencodeClient ── long-lived stdio bridge in the slice
                ├─ child: `opencode serve --hostname 127.0.0.1 --port N`
                ├─ SSE:   GET /event (message.part.delta, message.updated,
                │         message.part.updated, session.status, session.error)
                └─ commands: prompt_async / abort / shutdown
                   normalized events: phase | text-delta | commentary-delta |
                   tool-call | tool-result | usage | end | abort
```

The backend is one turn executor. Floot keeps the conversation tree, usage
totals, presets, session registry, and recovery journal; opencode keeps only
its native session/transcript (declared through `continuity`).

## Conformance to `@endo/hosted-agent`

`packages/hosted-agent/src/hosted-backend.js` is the contract:

- `describe()` → exactly
  `{ id: 'opencode', title: 'OpenCode', kind: 'hosted',
  continuity: 'transcript', toolOwnership: 'endo',
  supportedNetworkPolicies: ['off', 'public-internet'] }`.
  **Both policies are required**: Floot initializes every session's policy to
  `off` and refuses a turn when the descriptor's supported set does not include
  the current policy (`packages/floot/src/network-policy.js:29,161-172`;
  `agent.js:3387` runs before `create`). Declaring only `public-internet`
  wedges every session.
- `listModels()` → normalized DTOs with exactly
  `id, title, description, default, reasoningEfforts, defaultReasoningEffort`.
  Ids are full opencode refs (`openrouter/<vendor>/<model>`), catalog bounded
  and sorted; `reasoningEfforts` starts empty and `defaultReasoningEffort:
  null` unless `--variant` mapping is proven.
- `create(spec, toolSet)` → `{ run, admin }`.
  `run = { send, models, interrupt, acknowledge, status, help }`,
  `admin = { terminate, help }`.
  The session's model comes from the **create spec** (validated against
  `listModels`), not from `send`; `send(prompt, { systemPrompt })` carries the
  persona (see limitation below).
- `destroy({ sessionId })` → idempotent stop + durable-state removal; never
  under a running turn, and never while an Endo tool call is unsettled.
- `interrupt()` is a terminal barrier; `acknowledge()` is a no-op under
  `transcript` (Floot only calls it when the terminal carries a checkpoint).

**Network policy is two-step, and phase 1 says so.** Fresh sessions start at
`off`. Under `off` the slice is provisioned with the sandbox `none` profile and
the backend refuses `send` with a clear error before spawn. To run a turn the
operator sets the session to `public-internet` through the existing
NetworkPolicyPanel (`space-floot/src/NetworkPolicyPanel.js:146`,
`chat/floot-network.js:168`); milestone 3 documents and tests that exact step.
A zero-click deployment requires a Floot-side per-backend **default network
policy at session creation** — a real Floot change listed in Edits outside the
package, not assumed.

**System prompt.** Floot supplies `systemPrompt` at create and again per turn,
but for a given agent incarnation the value is constant
(`agent.js:977,1396,3430-3431,3571,3617`). The backend defines a host-generated
opencode agent whose `prompt` is the create-time `spec.systemPrompt`, sets
`disable: false`, `mode: 'primary'`, and pinned `model`, and uses that agent for
every message; it refuses a `send` whose `systemPrompt` differs, because
opencode's config agent prompt is fixed at config load. A config agent's
`prompt` **replaces** opencode's provider-specific base prompt
(`llm/request.ts:57-63`), so the persona must be self-contained. If the
requested agent is missing, the server falls back to the default; the bridge
detects the mismatch from the message metadata (`info.agent`) and fails the
turn. The per-message `system` field on the HTTP API is an option if per-turn
personas are ever needed.

**Continuity.** Starts at `transcript`: opencode persists its own session and
the normalized stream mirrors what it emitted before a stop/failure. Do not
advertise `opaque-reconciled` in phase 1: it requires a write-ahead
pre-dispatch marker, idempotent reconcile, and rollback on the backend side
(`BACKEND-DESIGN.md:171-187`); `POST /session/:id/revert` is available on the
server surface, so it can be revisited deliberately.

## Transport

### Phase 1 — in-slice `opencode serve` + stdio bridge (primary)

One long-lived process per session incarnation, spawned via `slice.spawn`
(`podman exec -i`), running a small bundled Node bridge. The bridge starts the
server as a child (`opencode serve --hostname 127.0.0.1 --port <N>`), waits for
the `opencode server listening on http://…` line, subscribes to `GET /event`,
and relays an nd-JSON protocol over stdin/stdout to the host-side client.

Event mapping, pinned by source review and live capture on 2026-09-11:

| server event | payload | normalized hosted event |
|---|---|---|
| `message.part.delta` | `{partID, messageID, field:'text', delta}` — `field` is never `'reasoning'`; the part's type comes from its `message.part.updated` | `text-delta`, or `commentary-delta` when the `partID` is registered as a reasoning part; only for assistant, non-summary messages |
| `message.part.updated` | start (empty) and end (full) snapshots of text/reasoning parts; tool parts with `callID` and `state.status` (`pending`/`running`/`completed`/`error`) | `tool-call` on `running`, `tool-result` on `completed`/`error`; end-snapshot text is idempotent (deltas are the stream), and only for assistant, non-summary messages |
| `step-finish` part | per-model-call `tokens` and `cost` | `usage` (sum `tokens.input`/`tokens.output`, matching Floot) |
| `message.updated` | `info` registry (`role`, `summary`, `agent`, `time`) | message registry only; **never** usage (it fires per step, cost is cumulative, tokens are last-step) |
| `session.status` | `{status:{type:'busy'\|'idle'}}` | `phase`; `idle` after the prompt completes is the **turn terminal** (per-prompt, not per-step); accept the deprecated `session.idle` idempotently |
| `permission.asked` | `{id, sessionID, permission, patterns, …}` | auto-reply `{response:'once'}` via the permissions API; without it a `doom_loop` ask hangs the turn |
| `session.error` | named error | pending-error marker (see below) |
| `session.compacted` | `{sessionID}`, only on successful compaction | optional `phase` marker (not required; summary filter does the work) |

Rules the bridge must implement:

- **Summary filtering.** Track `messageID → {role, summary}` from
  `message.updated`, and suppress deltas **and part snapshots** whose parent is
  `role === 'assistant' && summary === true` (user prompt and synthetic
  continuation text parts are on the bus too). The summary `message.updated`
  arrives before its parts, so registration wins the race. Note the exact
  comparison: a user message also carries a `summary` field, but as an object
  (`{diffs: []}`), so only the boolean `true` on an assistant message matches;
  `session.updated` also has a summary object — only the message registry is
  keyed on it.
- **Permissions.** `opencode serve` has no `--auto` flag. The host config sets
  only `permission: { doom_loop: "allow" }` — enough to keep the generic
  build/plan agent loop from stalling — and the bridge answers every
  `permission.asked` with `{response:'once'}` via
  `POST /session/:sessionID/permissions/:permissionID`. Do **not** use a
  `"*": "allow"` wildcard: it overrides the built-in `ask`/`deny` rules
  (`external_directory`, `.env` reads, plan denies, doom_loop) and makes the
  answer path dead; the slice is the boundary, but the in-CLI rails stay on.
- **Stream lifecycle.** Every request, including `GET /event`, carries the
  directory (`?directory=/workspace` or `x-opencode-directory`) or the server
  uses its own cwd and the bridge sees nothing. The SSE stream has no replay
  and ends on `server.instance.disposed`; a child exit aborts the in-flight
  turn and triggers a resync (`GET /session/:id/message`) or a fresh
  incarnation. Explicit ports can conflict — choose a free port and handle
  startup failure. Ignore unknown event types.
- **Synthetic continuations.** Auto-compaction injects a synthetic user message
  ("Continue if you have next steps…", `metadata.compaction_continue: true` in
  the `run` stream). On this surface it is a user message: filtering by role
  drops its text. A single Floot `send` may therefore span several model steps
  (summary → synthetic continue → final answer); the turn ends only at `idle`.
- **Terminal.** `end` when the session returns to `idle` after the prompt with
  no pending error; `abort` when a pending error is unresolved, or on
  bridge/child exit, abort, or parse failure. The synchronous
  `POST /session/:id/message` resolution is the validation fallback if idle
  proves ambiguous (spike pins this; `run`'s own loop breaks on idle, which is
  evidence it is per-prompt, not per-step).
- **Interruption.** `interrupt()` asks the bridge to `POST /session/:id/abort`
  and enforces a terminal barrier; the client also kills the bridge process on
  teardown. An abort must not be replayed.
- **Bounds.** A turn gets a wall-clock and step/token budget; the observed
  compaction-continue cycle can loop under a pathologically small context
  (live-captured), so the bridge stops emitting and reports abort when the
  budget is hit.

Session handoff: the bridge records the opencode `sessionID`; on reincarnation
it lists sessions (`GET /session`) and resumes the recorded ID. A missing
session fails closed rather than silently starting a new history.

`src/opencode-protocol.js` owns SSE/nd-JSON framing and the normalization
above; the spike's captured transcript becomes its fixture.

### Fallback — `opencode run --format json`

Kept for environments where a long-lived server is impossible. Two flavors:

- **Stock binary.** Strictly weaker: no token deltas, tool calls only on
  completion, and no summary discriminator, so auto-compaction must be
  disabled (`OPENCODE_DISABLE_AUTOCOMPACT=1`) and overflow is a failed turn.
- **Patched fork build** (`kumavis/opencode` branch
  `build/v1.18.30-opencode-patched`: `part_delta` forwarding plus the #42316
  compaction/synthetic filter). Validated live in a Tokyo podman slice on
  2026-09-11: token deltas stream and compaction internals do not leak. It
  still lacks tool-call-start and cannot stop the post-compaction continuation
  loop — the spike's turn kept going until an external 240 s kill — so the
  client must enforce a step/time budget and reap the process.

The pending error marker still applies: `run`'s `error` record is not terminal
by itself (clearable by later step progress), and a fatal error exits with the
marker armed => `abort`, while a clean loop exit => `end` regardless of exit
code (a sticky error sets exit 1). Promoting the stock surface to parity needs
upstream message-metadata emission; the fork build instead filters summaries in
place, so the fallback is usable with the fork but still lacks tool-call starts
and an interrupt, which keeps the server bridge primary.

### Optional — ACP

`opencode acp` speaks nd-JSON over stdio using the published
`@agentclientprotocol/sdk`, owns sessions/prompts, and emits `usage_update`.
An alternative stdio-native surface; evaluate only if the bridge proves
burdensome.

## Tool bridge

Reuse the claude-sandbox **protocol core and stdio relay**
(`packages/claude-sandbox/src/mcp-bridge.js`, `mcp-stdio-bridge.mjs`); do not
reuse its config generator — that emits Claude's `mcpServers`/`type: 'stdio'`
`mcp.json`, while opencode needs:

```json
{ "mcp": { "endo": { "type": "local", "command": ["node", "/…/relay.mjs"],
                     "enabled": true } } }
```

- The socket server binds a per-session unix socket; the directory is
  bind-mounted read-only into the slice, and only JSON crosses.
- opencode tool names are sanitized `endo_<tool>`; the bridge's pinned catalog
  (`mcp-bridge.js:180-199`) still refuses unknown tools.
- The default `build` agent's permission rules begin `"*": "allow"`, but
  `doom_loop` defaults to `ask` and `serve` has no `--auto` flag. The host
  config sets `permission: { doom_loop: "allow" }` and the bridge answers any
  `permission.asked` with `{response:'once'}`; a `"*": "allow"` wildcard would
  override the built-in `ask`/`deny` rules and is deliberately not used. The
  outer slice is the enforcement boundary, matching the codex stance.
- **Unsettled-call barrier:** `terminate()`/`destroy()` must refuse while
  `bridge.pendingCalls() > 0`, with the exact message substring
  `unsettled Endo tool call` that Floot retries on
  (`agent.js:2932-2950`; precedent `claude-backend-factory.js:238-241,252,274`).
- The socket has no explicit mode and no peer-uid check today; any in-slice
  process can drive the pinned `HostedToolSet`. A follow-up, not a security
  claim.

## Credential path

`secrets/<name>` (a `SecretBlob`) → the `f13c7cbd9` managed-credentials cap
(which delegates only the blob read via `host.copy(['secrets', name],
[temporary])`, validates the name, and seeds the secret with `createBase64`
**only when the catalog has no entry`) → materialize **once per provision**
(formulas reincarnate) → `OPENROUTER_API_KEY` in the slice `env` at
`sandboxFactory.make()`.

- The secret name is configuration (`ENDO_OPENCODE_CREDS_NAME`, default
  `openrouter-auth`), not a hardcode, and it is deliberately **not** derived
  from Floot's provider variables: `FLOOT_AUTH_SECRET_NAME` can name a
  provider credential of another kind (e.g. an Anthropic key), which must never
  be wrapped and injected as `OPENROUTER_API_KEY`. The deployment points this
  variable at the same secret Floot's OpenRouter provider uses. Only
  `ENDO_`-prefixed names are read: the daemon strips bare variables, so a bare
  `FLOOT_AUTH_SECRET_NAME`/`OPENCODE_*` is ignored rather than half-honored.
  The seed value comes from `ENDO_OPENROUTER_API_KEY` (never a bare
  `OPENROUTER_API_KEY`). An existing SecretBlob is never overwritten by a
  stale environment variable, and a name already bound to a non-managed object
  is refused rather than destroyed.
- Setup inputs must be `ENDO_`-prefixed to survive the daemon's `allowEnvPass`
  filter (`packages/daemon/index.js:88-102`); a bare `OPENROUTER_API_KEY` in
  `secrets.env` would never reach a setup.
- The cap is bound at `<name>`; any daemon caplet that can resolve that name
  can mint a grant. Grants are single-shot and capped (128 outstanding), and
  revocation prevents later materializations but not bytes already delivered.
  Phase 1 accepts this host-side exposure; broker-only egress removes it.
- Setup must additionally assert that the module specifier it minted resolves
  through `<stateDir>/current/` (not `releases/<id>/`), or a pruned release
  breaks revival. The assert runs before the first mint so a failure cannot
  leave a half-bound profile; `setup-hosted.js` mints the replacement backend
  under `opencode-sandbox/backend-next` and only then swaps it over the live
  name, so a failed mint leaves the previous backend (and Floot's binding to
  it) working.
- The state root and the credential name are validated before any mint:
  `ENDO_OPENCODE_STATE_DIR` must be absolute, normalized, not `/`, and not a
  symlink (and the provider re-checks `.owners/` and the ownership marker with
  `lstat`/`realpath` before writing, so a planted link cannot redirect
  `chmod`/`writeFile` at a host path outside the tree). Per-session MCP sockets
  default under `$HOME/opencode-mcp`, never a shared world-writable tmp.
- **Containment, stated honestly.** Phase 1 uses the Claude trust model, and it
  is weaker than "the key stays out of everything":
  - the token is rendered into `podman create -e`, so it appears in
    `podman inspect` and same-uid `ps`, readable by any same-uid process —
    including other caplets sharing the daemon worker;
  - the CLI and anything it spawns can read it; an auto-approved shell tool can
    print it, and that output can reach the transcript, `/workspace`, MCP tool
    arguments, host-side `HostedToolSet` results, and the persisted
    `/opencode-state` SQLite/transcript;
  - manager revocation is not retroactive, and a token captured into persisted
    state can be replayed by a later incarnation after rotation.
  Controls: keep slices short-lived, never log the token, and run **negative**
  tests that plant workspace config/instructions and assert they have no
  effect, plus token scans over the event stream, stderr, workspace, state
  volume, and MCP arguments. **Real containment is broker-only egress (phase
  5)** — codex's model, where the slice holds no credential and a host-side
  loopback proxy injects auth (`credentialInjection: 'broker-only'`,
  `backend-factory.js:37`).

## Security-hardening of the runtime

- **Project config and instructions are untrusted and must be disabled.**
  `OPENCODE_CONFIG_CONTENT` is a final *deep merge*, not a replacement: a
  workspace `opencode.json`, `.opencode/`, `AGENTS.md`, or `CLAUDE.md` still
  loads unless `OPENCODE_DISABLE_PROJECT_CONFIG=1` is set. A planted
  `provider.openrouter.options.baseURL` could redirect the key, or
  `provider.options.apiKey` override it. Every spawn sets
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_PURE=1` (external plugins)
  and `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` (internal), and bakes a full
  `provider`/`model` block (including `baseURL`) and the agent into
  `OPENCODE_CONFIG_CONTENT`. `OPENCODE_CONFIG_DIR` points at a read-only bind,
  never the workspace. **Fork requirement:** stock v1.18.30 still resolves
  nested `AGENTS.md`/`CLAUDE.md` on file reads even with the flag set
  (`instruction.ts` `find`/`resolve` were ungated); the pinned fork gates
  `find` on the flag. Deployments must use the fork build.
- **`auth.json` is neutralized.** `XDG_DATA_HOME=/opencode-state`; set
  `OPENCODE_AUTH_CONTENT='{}'` (or otherwise guarantee the path is absent) so
  an auth file written by a previous or compromised incarnation cannot override
  the injected env. Test that a planted `auth.json` has no effect.
- **`OPENCODE_PURE` scope.** It only skips external plugins;
  `OPENCODE_DISABLE_DEFAULT_PLUGINS` is needed too, and project `.opencode/`
  plugin behavior is verified in the spike.
- **Build supply chain.** The CLI is built from the pinned fork commit with
  `bun@1.3.14` (the repo's `packageManager`), never installed from the
  published npm installer, which cannot carry patches. `oci/build-reproducible.sh`
  records the binary digest; set `OPENCODE_BINARY_SHA256` to turn that record
  into a hard verification. Base-image digests are not pinned yet (open
  question), and the source build embeds a build-time models.dev snapshot that
  we do not rely on (the provider list is hard-coded; see Image).
- **Server exposure.** The server binds slice loopback only. The bridge is the
  sole client; set `OPENCODE_SERVER_PASSWORD` anyway and pass it to the bridge
  so no in-slice process can drive the server through a guessed port (the
  listening port is parsed and passed to the bridge).

## Network policy

- Descriptor declares both `off` and `public-internet` (see Conformance).
  `off` provisions the sandbox `none` profile; a model turn under `off` fails
  fast with a clear error before spawn. The operator step to `public-internet`
  is documented in Conformance.
- **The sandbox `private` profile maps to `slirp4netns`/`pasta` NAT and does
  not filter egress** — in-netns filtering is explicitly the operator's
  responsibility (`drivers/podman.js:232-246`, `packages/sandbox/README.md`).
  So `public-internet` here means "unfiltered NAT outbound unless the host
  configures a filter", not "openrouter.ai only". Phase 1 must not claim more;
  an allowlist or the codex broker is the hardening.

## State, isolation, and teardown

- Workspace: 9P-projected `Filesystem` cap at `/workspace`; Floot owns it.
- **State substrate (phase-1 prerequisite, not a hardening afterthought).**
  opencode forces SQLite WAL (`journal_mode=WAL`, `synchronous=NORMAL`,
  `core/src/database/database.ts:27-31`), and SQLite WAL requires same-host
  shared memory — it does not work over a network/FUSE filesystem
  (sqlite.org/wal.html). The claude-style provisioner only projects 9P mounts,
  so `src/opencode-state-provider.js` creates one 0700 host directory per
  session under a configured root and mints a **daemon mount** for it via
  `host.provideMount(absolutePath, petName)`. That matters: the sandbox factory
  resolves every Mount cap through `@agent.provideHostPath`, which rejects any
  cap the daemon did not mint (`daemon/src/host.js:700-741`), so a wrapper
  provider cannot substitute. `removeSession` unmounts and deletes the
  directory on destroy only. This avoids codex's XFS quota stack; the design's
  phase 1 has no quota or `nosuid,nodev` (see below), and the NixOS host edits
  only need a state root directory.
- **No quota or `nosuid,nodev` in the plain slice path.** The non-policy bind
  path supports neither; until the volume/policy path is adopted, state is
  unbounded and binds carry only `readonly` where applicable. The design says
  so; it does not claim otherwise.
- `auth.json` is never written and `OPENCODE_AUTH_CONTENT='{}'` makes a planted
  one inert. The only credential is the injected env.
- **State replay is a threat.** Continuity is the persisted opencode session,
  deliberately kept across `terminate`. A compromised turn can plant
  instructions, tool results, or a captured token in the SQLite/transcript that
  later incarnations replay, including after rotation. Milestone 4 adds resume
  bounds, a ledger/provenance check or scrub on resume, and DB growth limits;
  the token scan covers the state volume in milestone 1/2.
- `interrupt()` aborts the turn through the bridge and kills the bridge process
  as a backstop; `admin.terminate()` disposes the slice and mounts but keeps
  state + workspace; `destroy()` deletes them. `context.whenCancelled()`
  (formula cancellation / daemon shutdown) runs the same teardown, so the
  in-flight turn and the server child are reaped on shutdown.
- **`containerMounts` are refused in phase 1.** `assertContainerMounts`
  (`codex-sandbox/src/backend-factory.js:204-255`) is shape validation only,
  and a phase-1 slice has no policy attestation. Refusal is the only available
  capability mode, but it is not immediate: Floot fires the mount recreate and
  reports attach success, with the refusal surfacing as a `pendingReport` on
  the next `send` (`agent.js:3048-3064,2960-3024`). State that in operator
  docs rather than promising an immediate error.

## Image

`packages/opencode-sandbox/oci/` follows `packages/codex-sandbox/oci/`
(codex additionally pins base digests and ships a reproducibility verifier;
that is still open here):

- **Fork build; two image variants.** The CLI is a compiled Bun binary, so the
  published npm installer cannot carry patches. Both variants build the fork
  commit; the source variant pins Bun `1.3.14` (the repo's `packageManager`;
  1.4.2 produced a binary that failed in `SystemPrompt.environment` with
  `UnknownError`) and the prebuilt variant records the CLI digest, with
  `OPENCODE_BINARY_SHA256` turning that record into a hard check.
  - `Containerfile` — the deployment path, validated in a Tokyo slice on
    2026-09-11: cross-build the binary
    (`packages/opencode/script/build.ts`), then COPY it into the runtime
    image. Tokyo's 49 GB disk cannot host the source build's scratch layers.
  - `Containerfile.source` — in-image build for hosts with ~10–15 GB of
    headroom; `bun install --frozen-lockfile`.
- **Build entry point.** `oci/build-reproducible.sh` defaults to the prebuilt
  path and selects the source path with `--source`. Once the bridge lands it
  is baked at `/opt/opencode-bridge/` so it ships with the same build.
- **The image runs as root inside the slice.** Privilege separation is the
  sandbox driver's responsibility (as with claude-sandbox, which relies on
  root-in-userns); the read-only rootfs, `--cap-drop ALL`, and
  no-new-privileges flags are applied by the driver, not the image. Do not
  claim non-root until the driver manages ids.
- **Isolated homes need a non-Zen `small_model`.** With only OpenRouter auth
  and no Zen credentials, the default title/summary model call fails and `run`
  exits with `UnknownError`; the session config must set `model` and
  `small_model`.
- **Install `git` and `ripgrep` explicitly.** `node:22-bookworm-slim` carries
  neither; opencode shells out to git for VCS discovery/snapshots and to `rg`
  for search, and otherwise re-downloads ripgrep into the ephemeral cache on
  every container. (If git is intentionally excluded, set `snapshot: false`
  and expect the global-project fallback.)
- **Hard-coded model list for the OpenRouter endpoint.** The provider block in
  the host config (`OPENCODE_CONFIG_CONTENT`) pins
  `provider.openrouter.npm = @openrouter/ai-sdk-provider`,
  `env = [OPENROUTER_API_KEY]`,
  `options.baseURL = https://openrouter.ai/api/v1`, and an explicit `models`
  map whose keys are canonical provider-scoped ids; `whitelist` is built from
  that catalog, so the effective list is exactly what we write — not what the
  OpenCode catalog (`models.opencode.ai`) or the binary's embedded models.dev
  snapshot happen to list. Those lists can differ from what OpenRouter serves;
  stealth aliases with a leading `~` are accepted.
  `OPENCODE_DISABLE_MODELS_FETCH=1` stops any runtime fetch. Refresh entries
  from `https://openrouter.ai/api/v1/models` when a model changes. Pinning the
  build-time models.dev snapshot is not required for this path and stays on
  the open list as a general reproducibility item.
  Caveat: a deep merge means the block cannot remove an `options.apiKey`,
  `options.headers`, or alternate SDK package added by a lower config layer,
  so the session must also run with project config disabled, a read-only
  `OPENCODE_CONFIG_DIR`, and `OPENCODE_AUTH_CONTENT='{}'` (see Security).
- Runtime env: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_PURE=1`,
  `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_AUTH_CONTENT='{}'`,
  `OPENCODE_DISABLE_AUTOUPDATE=1` (inert for `run` but harmless),
  `OPENCODE_DISABLE_MODELS_FETCH=1`, and `OPENCODE_SERVER_PASSWORD` (per
  session, shared with the bridge). **Auto-compaction stays enabled.**

## Package layout

New package `packages/opencode-sandbox/`.

| File | Responsibility | Model on |
|---|---|---|
| `package.json` | `@endo/opencode-sandbox`; setup + client module exports; dependency on `@endo/codex-sandbox` if its volume provider is reused, or a copied helper | `packages/claude-sandbox/package.json` |
| `setup-host.js` | Mint `opencode-sandbox/sandbox-factory` and `opencode-sandbox/fs-mounter` | **claude-sandbox** `setup-host.js` (codex has none) |
| `setup-hosted.js` | Session dirs, credential provisioning, mint `opencode-sandbox/backend`, bind at `floot/controller-profile/opencode-backend` | `claude-sandbox/setup-hosted.js:223-256`; Tokyo `provideManagedCredentials` |
| `src/opencode-backend-factory.js` | `HostedBackendFactoryInterface`; lifecycle ordering, live ownership, teardown barriers | `claude-backend-factory.js` |
| `src/opencode-backend-module.js` | Caplet entry; resolves env config; wires provisioner + tool bridge | `claude-backend-module.js` |
| `src/opencode-session-provisioner.js` | Per-session exo: `provision`, `lookup`, `cancel`, `remove`; provides the state-volume power | `claude-session-provisioner.js:27-36` |
| `src/opencode-state-provider.js` | Per-session 0700 host directory + daemon mount via `host.provideMount`; destroy-only `removeSession` | daemon `host.js:685-741` |
| `src/container-mount-bridge.js` | `provideContainerMountBridge`/`release…` (refused in phase 1) | `claude-sandbox/src/container-mount-bridge.js` |
| `src/provision-opencode-session.js` | Bounded session powers + client formula creation | `provision-claude-session.js` |
| `src/opencode-client-module.js` | Credentials → slice env; workspace mount; state volume; MCP mount; server child + bridge process | `claude-client-module.js` + `codex-sandbox/src/app-server-transport.js` |
| `src/opencode-client.js` | Spawn/command the bridge; session-id handoff; pending-call count; terminal barrier | `codex-client.js` + `claude-client.js` |
| `src/opencode-bridge.mjs` | In-slice: start `opencode serve`, parse listening line, subscribe SSE, nd-JSON commands/events, summary filtering, terminal derivation, turn bounds | new; baked into the image |
| `src/opencode-protocol.js` | SSE + nd-JSON framing, event normalization, message registry | `codex-protocol.js` |
| `src/opencode-hosted-events.js` | Translation to hosted vocabulary, ordering guarantees | `claude-hosted-events.js` |
| `src/mcp-bridge.js`, `src/mcp-stdio-bridge.mjs`, `src/mcp-socket-server.js` | Reuse protocol core + relay; new opencode config generator | claude-sandbox |
| `src/managed-credentials*.js` | SecretBlob-backed cap; **ported from `f13c7cbd9`** | `f13c7cbd9:…/managed-credentials.js` |
| `src/opencode-agent-config.js` | Host-side `OPENCODE_CONFIG_CONTENT` builder: hard-coded `provider.openrouter` block (baseURL, `models`, `whitelist`), agent `prompt`/`disable:false`/`mode`, MCP, permissions | new |
| `src/parse-rootfs.js`, `src/current-specifier.js`, `src/container-mounts.js` (`assertContainerMounts`) | small shared helpers | claude/codex-sandbox |
| `oci/Containerfile`, `oci/Containerfile.source`, `oci/build-reproducible.sh`, `oci/spike/` | Prebuilt and in-image fork builds (Bun 1.3.14, pinned commit + recorded digest); Tokyo slice spike harness | codex-sandbox `oci/` |
| `test/*.test.js` | see Testing | claude/codex tests |

### Edits outside the package

1. `packages/floot/agent.js` discovery (`:2695-2702`): add `opencode-backend`
   to `configuredBackendNames`. The env route is **not** sufficient alone:
   `FLOOT_BACKEND_FACTORIES` is read by the caplet but not forwarded by
   `floot-factory-setup.js:249-258` (only `FLOOT_SYSTEM_PROMPT`,
   `FLOOT_CODE_PATH`, `FLOOT_MAX_TOOL_ROUNDS`, `FLOOT_MAX_SUBAGENT_DEPTH` are),
   and bare `FLOOT_*` not prefixed `ENDO_FLOOT_` is stripped by the daemon. Use
   the code edit, or change the factory setup too.
2. Network policy (optional, for zero-click): a Floot-side per-backend default
   policy at session creation. Without it, the operator step in Conformance is
   required. Add a test that a fresh `off` session reaches `create` and refuses
   `send` cleanly, and that `public-internet` lets a turn run.
3. NixOS host config (separate repo): `ENDO_EXTRA` order
   `opencode-sandbox/setup-host.js` → `floot-factory-setup.js` →
   `opencode-sandbox/setup-hosted.js`; `ENDO_OPENCODE_*` env (image, dirs,
   credential name); build the image on the host; and, if the state-volume
   provider is adopted, the XFS `volumeRoot`/project-quota + sudo prerequisites
   (mirroring `modules/codex-storage.nix` on Tokyo). Every name must be
   `ENDO_`-prefixed.

## Security summary

- The slice is the enforcement boundary (read-only rootfs, cap-drop,
  no-new-privileges, no host networking), as in claude.
- Phase 1 has **no slice attestation**, **no `containerMounts` support** (and
  its refusal is next-turn), **no quota**, and **no `nosuid,nodev`** on binds.
  Do not present it as equivalent to codex's attested policy profile.
- Credential-in-slice is a conscious phase-1 trade; broker-only egress is the
  containment milestone.
- Egress is unfiltered NAT unless the operator filters it.
- Workspace config, instructions, and state are untrusted; config is
  host-generated with project config disabled, and `auth.json` is neutralized.
- **Bridge stdout is untrusted UI text, not attestation.** In-slice processes
  share the root-in-userns boundary and can forge bridge events or kill the
  bridge; the host validates shapes but does not authenticate content. Never
  base a recovery or authorization decision on bridge output alone.
- MCP socket access control (mode, peer uid, connection bound) is a follow-up.

## Testing

- Bridge fixtures from the live capture: `message.part.delta` → deltas with
  reasoning parts routed by their registered part type; tool `state.status`
  transitions → tool-call/tool-result with stable `callID`; `step-finish`
  parts → usage; `session.status idle` terminal; `session.error` pending
  marker; `permission.asked` auto-reply (including `doom_loop`); abort.
- Summary filtering fixture: an assistant message with `summary: true` (and
  its registered messageID) must produce **no** `text-delta` or `usage`; a
  user message carrying `summary: {diffs: []}` must not be treated as a
  summary. Synthetic user continuation text must be dropped by role.
- Turn bounds: a compaction-continue loop (artificially tiny context) must
  terminate with `abort` at the step/time budget, not hang.
- Ordering tests: `tool-call` precedes its `tool-result`; unique nonempty ids;
  a turn cannot `end` with unresolved calls; EOF/parse failure is an abort.
- Terminal classification fixtures: fatal error => `abort` with a bounded
  message; clean idle => `end`; streamed text then fatal error => `abort` with
  partial text retained by Floot.
- Fake-slice lifecycle tests modeled on
  `claude-sandbox/test/claude-backend-factory.test.js` and
  `codex-sandbox/test/backend-factory.test.js`: live-session ownership,
  idempotent destroy, pending-call refusal with the exact message substring.
- Negative security tests: plant `opencode.json`, `.opencode/`, `AGENTS.md`,
  `CLAUDE.md`, and `auth.json` in the workspace; assert none affect the provider
  target, agent prompt, or credential.
- Credential tests: assert the token is present in the slice `create` env and
  that `podman inspect`/same-uid `ps` exposure is the documented trade; scan the
  normalized events, stderr, workspace, state volume, and MCP arguments for the
  token; assert a rotated/planted state token cannot be replayed.
- Offline provider test: with no egress and no catalog file, the hard-coded
  provider block still resolves `openrouter/deepseek/deepseek-v4.1-flash`, and
  workspace config cannot redirect the base URL or add providers.
- Live on Tokyo: image build; one multi-turn session on
  `openrouter/deepseek/deepseek-v4.1-flash` after setting the session policy;
  MCP tool round-trip; interrupt + reincarnation keeps the transcript; SQLite
  state survives a container recreate on the host-backed volume; a forced
  compaction produces a filtered summary and a normal answer.

## Milestones

1. **Spike (no repo code).** Validate against OpenRouter on a workstation:
   server startup + password + directory routing, SSE deltas/tool states/usage
   (`step-finish`), summary filtering (boolean on assistant, object on user),
   synthetic-continuation filtering, reasoning-part routing,
   `permission.asked` auto-reply (including `doom_loop`), idle terminal, abort,
   session resume across a bridge restart, MCP relay, and turn bounds under a
   forced compaction loop.
2. **Package scaffold.** Files above, bridge + protocol fixtures from the
   spike, fake-slice tests; port the managed-credentials cap; implement/mount
   the state substrate; land the Floot discovery edit; no host wiring.
3. **Live backend on Tokyo.** Setup scripts + NixOS env; operator sets the
   session policy; one real Floot session with compaction exercised.
4. **Hardening.** State replay bounds/scrub, MCP socket access control,
   daemon-shutdown reaping, crash/teardown tests; quota and bind flags only if
   the policy/volume path is adopted.
5. **Optional.** Broker-only egress; ACP transport evaluation; upstream the
   `run --format json` message-metadata emission if the stock surface ever
   needs to be used without the fork.

## Open questions

1. Resume integrity across a bridge restart: the session store must survive,
   and `GET /session/:id/message` resync must be coherent after
   `server.instance.disposed`.
2. `--variant` to reasoning-effort mapping; otherwise the catalog declares no
   efforts.
3. Whether to extract the MCP bridge and managed-credentials into a shared
   package instead of a third copy.
4. Zero-click network default: adopt a Floot per-backend creation default, or
   keep the documented operator step.
5. Broker-only egress design (host-side OpenRouter proxy, codex lease style).
6. Reproducibility: pin base-image digests and add a codex-style double-build
   digest comparison. The build's embedded models.dev snapshot does not affect
   the hard-coded OpenRouter path but is still an unpinned input to the source
   build.
7. `run` delta robustness: buffer deltas whose `message.part.updated` was not
   seen (reconnect/mid-part subscription) and prune the `partTypes` /
   `compactionMessages` maps on `message.part.removed`.
8. A product-level turn budget for the compaction-continue loop. The harness
   now reaps timed-out containers, but the backend still needs an explicit
   step/time cap rather than an external kill.
9. Bridge queue dispatch after a `halt` idle can swallow a pipelined send
   (bounded by the turn timer). The host client queues one turn at a time, so
   this is outside the current contract; revisit with server-side turn
   identity if pipelining is ever allowed. The bridge's UTF-16 SSE buffer cap
   is also imprecise (a byte counter after frame extraction would be exact).

## Review record

- 2026-09-11 — adversarial round 1 (seam/wiring, security, CLI facts).
  Blockers fixed: network-policy default wedge; ineffective
  `FLOOT_BACKEND_FACTORIES` route; credential lineage absent from PR #1248;
  `run --format json` cannot deliver deltas/call-start/end; empty catalog under
  `DISABLE_MODELS_FETCH` + ephemeral HOME; compaction not observable via `run`.
- 2026-09-11 — adversarial round 2. Blockers fixed: non-terminal `error` and
  exit-code-1 terminal mapping; workspace project config/instructions/auth.json
  not neutralized; `off`-policy startup made an explicit operator step plus a
  Floot-default option; state substrate named as a host-backed volume and
  scheduled in milestone 2; quota/`nosuid,nodev` claims withdrawn.
- 2026-09-11 — adversarial round 3. Blocker fixed: a fatal error exiting after
  a sticky exit code must not normalize to `end` (which Floot commits as
  success); terminal derived from a pending-error marker.
- 2026-09-11 — adversarial round 4. Blocker fixed: the `run` stream emits the
  auto-compaction summary as ordinary answer text. Interim resolution was
  disabling autocompaction in phase 1 and deferring compaction to an HTTP
  milestone.
- 2026-09-11 — adversarial round 5 (verification against pinned source). No
  blockers; confirmed autocompaction-off makes overflow terminal with no
  summary, and that `message.updated` carries `summary` on the server surface.
- 2026-09-11 — **round 6: live spike against OpenRouter** (opencode 1.18.30,
  `openrouter/deepseek/deepseek-v4.1-flash`, isolated XDG home, forced
  compaction via a small context override). Findings:
  (a) `run --format json` with auto-compaction emits the summary as ordinary
  `text` with no discriminator, and a single invocation can loop through
  summary → synthetic continue → step indefinitely; the surface is unusable
  for compaction.
  (b) `opencode serve` + `GET /event` provides `message.part.delta` text
  deltas, tool `state.status` transitions, per-call usage on `step-finish`
  parts, and `info.summary === true` on the assistant summary message — while
  user messages carry `summary: {diffs: []}`, so the filter must compare the
  boolean exactly.
  (c) Consequence: the design was reversed — the server + stdio bridge is now
  the primary transport, compaction is enabled in phase 1, and `run` is a
  fallback that requires autocompaction to be disabled.
- 2026-09-11 — adversarial round 7 (server-bridge verification against pinned
  source). No blockers. Majors fixed: `--auto` does not exist on `serve`
  (permission config + `permission.asked` auto-reply, `doom_loop` included);
  usage comes from `step-finish` parts, not the per-step `message.updated`;
  `message.part.delta.field` is always `text`, so reasoning must be classified
  by registered part type; part-snapshot text needs the same role/summary
  filter as deltas. Minors fixed: directory routing on every request including
  SSE, no-replay resync policy, port-conflict handling, deprecated
  `session.idle`, child reaping, tolerant unknown-event handling.
- 2026-09-11 — **round 8: fork build + Tokyo podman slice spike.** Built the
  patched CLI from `v1.18.30` on branch `build/v1.18.30-opencode-patched`
  (`part_delta` + #42316-style compaction filter) with Bun 1.3.14 and
  cross-compiled `opencode-linux-x64`. On Tokyo, built
  `localhost/opencode:spike-20260911` in the Endo user's rootless podman
  storage (the build needs the daemon's `CONTAINERS_CONF`), sourced the key by
  reading `secrets/openrouter-auth` inside an `endo run --UNCONFINED --powers
  @agent` script and passing it to podman by environment inheritance (never
  printed), and ran a slice against OpenRouter. Results: token deltas streamed
  (`tok/yo/-s/lice/-/ok`), the completed text event followed, and a
  forced-compaction run reported no summary or synthetic-continuation leak.
  The compaction run also showed the continuation loop running until an
  external 240 s kill, confirming that `run` needs explicit bounds and that
  the server+bridge remains the primary transport. The seeded in-image source
  build was then exercised on Tokyo and failed on disk (the `bun install`
  layer needs more scratch than the ~6 GB free), so the seed ships both
  `Containerfile` (prebuilt binary — the validated deployment path) and
  `Containerfile.source` (multi-stage, for hosts with headroom); the spike
  harness lives in `packages/opencode-sandbox/oci/spike/`.
- 2026-09-11 — **round 9: adversarial review of the fork patches, the oci
  seed, and this record.** Fixes: the compaction filter now keys on
  `summary === true` only (`mode` is the agent name and collides with the
  built-in `compaction` agent), the synthetic drop requires
  `metadata.compaction_continue`, non-text deltas are ignored, the predicates
  are extracted with unit tests, and nested instruction discovery is gated on
  `OPENCODE_DISABLE_PROJECT_CONFIG` (fork commits `79b0d1a784`,
  `959c3887b3`). The seed supports `OPENCODE_BINARY_SHA256`, fetches nothing at
  runtime, reaps timed-out containers, caps output at 64 MiB, and validates its
  podman resolution; `bun install --frozen-lockfile` is used in the source
  build. The runtime catalog was then dropped entirely: a pinned download was
  unsatisfiable (upstream changed the file) and the model list must describe
  the OpenRouter endpoint anyway, so the session config now hard-codes the
  `provider.openrouter` block (baseURL, `models`, `whitelist`) and the images
  set `OPENCODE_DISABLE_MODELS_FETCH=1`. This record's npm-installer story,
  non-root claim, and round-8 validation wording were corrected. Remaining open
  items were added to Open questions (base digests, embedded models.dev
  snapshot, delta buffering/pruning, a product-level turn budget).
  Revalidated after the fixes: built `localhost/opencode-sandbox:959c3887b3`
  (image `54af1d5cad7e`, binary `25006d85…`) through the seed's digest checks;
  normal mode streamed deltas, compact mode again reported no leak while
  timing out at 240 s, and the harness reaped the container. After dropping the
  runtime catalog, `localhost/opencode-sandbox:hardcoded-959c3887b3` (image
  `4504983b8ab7`, same binary) ran normal mode with exit 0 and streamed deltas
  and compact mode with no leak and a reaped container, proving the hard-coded
  OpenRouter provider block works with no catalog file present.
