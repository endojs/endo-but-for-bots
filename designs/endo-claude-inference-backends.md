# Claude inference backends for a confined guest: what the minion.town experiments established

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Source** | Back-filled from the minion.town Claude CLI and Agent SDK experiments (kriscendobot/minion.town#105, kriscendobot/minion.town#106) and the production observations listed in § Evidence |

## Status

Design only; nothing in this repository changes. This document amends
[endo-claude](endo-claude.md) where the experiments contradicted or settled it,
and leaves that design standing for the parts they did not reach. It does not
revive the closed amendment in
[#1228](https://github.com/endojs/endo-but-for-bots/pull/1228) and does not treat
that amendment's contract as valid.

**Read this first: the production evidence is thin.** On 2026-09-28 the deployed
minion.town host had run **zero** Claude inference turns through either backend.
The confined-inference prototypes are both unmerged drafts, `ENDO_CLAUDE_ENABLED`
is unset in production, and the Agent SDK track is on hold until an Anthropic API
key exists (maintainer decision relayed on kriscendobot/minion.town#106,
2026-09-23). What the experiments did produce is a working backend boundary
exercised by four implementations, one live Agent SDK turn on a development host,
a deployed and integrity-pinned Claude Code binary, and a clear list of what is
still only documented. This design settles what that evidence supports and names
what it does not.

## What is the Problem Being Solved?

[endo-claude](endo-claude.md) specified, from `claude --help` and short local
spawns, how to run Claude as the inference engine of one Endo guest whose granted
facet is Claude's entire world. On 2026-09-22 the maintainer declined an expensive
review loop on that design and asked instead
([review on #1228](https://github.com/endojs/endo-but-for-bots/pull/1228#pullrequestreview-5273103141)):

> implement this tentatively within minion.town and revise this design when we
> have a better understanding of what works in that environment. My preferred
> approach at this time is to just use the Claude CLI or Claude Agent SDK (let's
> explore both concurrently) and see what works better in practice through use in
> production, then back-fill this design and solidify in Endo later.

Both tracks were built. This document is the back-fill. It has four jobs:

1. Compare the Claude CLI path and the Claude Agent SDK path on the evidence
   gathered.
2. Record, for each confinement and credential claim, whether it was **observed**
   (a run showed it) or only **documented** (vendor help text or docs say so).
3. Settle the backend boundary: what Endo owns, what a deployment owns, and the
   shape of the value that crosses between them.
4. Settle the confinement residuals the experiments can settle, and carry the
   rest forward as explicit gates.

## Evidence

### Sources

| Source | What it contributes |
| --- | --- |
| kriscendobot/minion.town#105 (draft, `claude-cli-inference-track-a`, `399418a`) and its `designs/claude-cli-inference-track-a.md` | The CLI backend, the shared `InferenceBackend` seam, a pure argv/env builder, a stream-json reducer, a nonce-gated loopback MCP endpoint; six back-fill findings. |
| kriscendobot/minion.town#106 (draft, `claude-agent-sdk-inference`) and its `designs/claude-agent-sdk-inference-track-b.md` | The Agent SDK backend on the same seam; one live SDK turn; five gaps. Held on 2026-09-23 pending an API key. |
| kriscendobot/minion.town#115 and #116 (drafts) | Codex API-key and Codex subscription backends built on the same seam after the Claude tracks paused. They are not Claude evidence, but they test whether the seam is provider-neutral. |
| kriscendobot/minion.town#87 (merged 2026-09-22) | The `@claude-agents` factory, `@claude-account` concierge, credential store, retained-child quota, and single inference-slot lease, all behind the flag and wired to an unavailable provider. |
| kriscendobot/minion.town#99, #103, #122 | The pinned, signature-verified Claude Code binary in every minion.town artifact (2.1.236, bumped to 2.1.268 on 2026-09-27). |
| kriscendobot/minion.town#96, #119 (merged) | Credential-expiry detection and root-user reauthentication; a fail-closed classifier that maps a provider response to `needs-auth` only through a table pinned to one CLI version. |
| kriscendobot/minion.town#120 (draft) | Root-only `delegate()` for the factory, and the inbox-watch driver. |
| [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) (this repository) | The sourced finding that no vendor exposes a third-party broker role for an individual Claude subscription. |

### Production observations (2026-09-28)

Read-only inspection of the minion.town host over SSM Run Command, by this job:

- `minion-mcp.service` is active, started 2026-09-27 13:56Z. Its environment and
  both environment files carry **no** `ENDO_CLAUDE_*`, `ANTHROPIC_*`, or
  `CLAUDE_*` variable. The Claude capability is therefore off.
- `dist/endo/claude/` holds the merged modules from #87 and #119 (`account`,
  `agents`, `classify`, `credentials`, `quota`, `reauth`, `wiring`, …) and no
  inference backend. Neither prototype is deployed.
- `/opt/minion-town/bin/claude --version` reports `2.1.268 (Claude Code)`.
  The `.old` tree and a `.failed` tree from an earlier deploy attempt hold
  `2.1.236`. The pinned-harness deploy and upgrade path works in production.
- The service journal since 2026-09-18 has **no** line mentioning `claude` or
  `infer`.

### Observed versus documented

"Observed" means a run in these experiments showed the behavior. "Documented"
means only `--help`, SDK typings, or vendor docs say so. "Stub" means a test
with a fake `claude` binary or an in-memory guest.

| Claim | CLI (#105) | Agent SDK (#106) |
| --- | --- | --- |
| The confinement options exist on the pinned version | Observed: `--bare`, `--strict-mcp-config`, `--setting-sources`, `--tools`, `--disable-slash-commands`, `--mcp-config`, `--settings`, `--permission-mode`, `--max-turns`, `--output-format stream-json` all present on 2.1.251. | Observed: `tools: []`, `settingSources: []`, `skills: []`, `strictMcpConfig`, `persistSession: false`, `permissionMode: "dontAsk"` accepted by SDK 0.3.236. |
| A real model reaches the guest's projected tools with every built-in denied | **Not observed.** Stub only: a fake binary read the generated `--mcp-config`, presented the nonce, and wrote through the guest surface. | **Observed once**: a real SDK query with built-ins denied called `writeText` then `readText` on an in-memory guest (`memory:g-abf1…-agent`), stored `sdk-live-value`, finished in three turns. Development host, claude.ai login, not the production credential or a real daemon guest. |
| A real model reaches **nothing but** the guest's tools | Not observed (documented). | Not observed: no negative probe ran. |
| Project and user memory, hooks, skills, and ambient MCP servers are excluded | Documented (`--bare`, `--setting-sources ""`, `--strict-mcp-config`). The 2.1.232 measurements in [endo-claude](endo-claude.md) remain the latest live check. | Documented. No live probe has measured these items for the SDK. |
| Credential authenticates headless | Not observed: no credential in the build environment. | Observed with a claude.ai login on a development host only; the API-key path it targets is unobserved. |
| The `needs-auth` wire signal | Stub: a substring heuristic. The live shape is unknown. | Stub: missing credential mapped before any query. |
| Wall-clock, output-byte, and turn limits terminate a turn | Stub: each axis killed a fake spawn (process-group kill). | Stub: each axis mapped to `limit-exceeded` through the SDK abort controller. |
| The confined process does not inherit the host environment | Stub: `process.env` secrets absent from the constructed child env. | Stub: SDK `env` built from an allowlist. |
| Pinned, integrity-checked binary deploys and rolls back | Observed in production (#99, #103; see above). | Shared: Track B points the SDK at the same pinned executable and prunes the SDK's bundled copy. |

The table's honest reading: **the one positive live result belongs to the SDK
track, no negative (closure) result exists for either track, and neither
credential path has run in production.**

## CLI versus Agent SDK

| Axis | Claude CLI | Claude Agent SDK |
| --- | --- | --- |
| What runs | `claude -p` spawned per turn. | The SDK **also spawns the Claude Code binary** (`pathToClaudeCodeExecutable`) and drives it over a control channel. It is not in-process inference. |
| Configuration surface | Argv plus a settings file plus an MCP config file. Order and quoting matter ([endo-claude](endo-claude.md) § *Argv order is a confinement boundary*). | Typed options object. No argv to get wrong, but each option still becomes a CLI flag underneath, so flag semantics are the same. |
| Guest projection delivery | Out of process: a loopback HTTP endpoint gated by a per-turn nonce (#105), or a claude-spawned stdio server ([endo-guest-stdio-mcp](endo-guest-stdio-mcp.md)). | In process: an `McpServer` handed to the SDK (`mcpServers`) with no socket or nonce. The host holds the facet; the binary reaches it only through the SDK's channel. |
| Credential kinds it can use | API key via `ANTHROPIC_API_KEY` or `apiKeyHelper` under `--bare`. A subscription `setup-token` is **not** admissible under `--bare` (documented: "OAuth and keychain are never read"). | API key. Track B read Anthropic's third-party guidance as making this a paid-API backend; the one live run used a developer's claude.ai login, which is not a deployable credential. |
| Dependency weight | The pinned binary only (~320 MiB). No npm dependency. | The SDK npm package pinned to the same Claude Code version, plus the binary. |
| Upgrade coupling | Flags can appear between versions (2.1.280 adds `--restricted` and `--permission-prompts`). A pinned-version `--help` diff is needed on every bump. | SDK version must match the pinned binary; #106 pinned 0.3.236 to 2.1.236 and #103's bump to 2.1.268 now leaves that draft mismatched. |
| Continuity between turns | None by construction (fresh process, no `--resume`). | None (`persistSession: false`). |
| Failure observability | stream-json `result` event subtypes; auth failure shape unknown. | SDK message stream; typed result, but auth failure shape equally unknown. |

**Conclusion.** The two paths are one engine with two configuration front ends.
Confinement fidelity is identical by construction, because both end up as the
same binary with the same flags. They differ in two ways that matter:

- **Projection delivery.** The SDK's in-process MCP server removes the loopback
  endpoint and its nonce entirely. That is a smaller attack surface and the only
  positive live result.
- **Credential.** Under `--bare`, the CLI accepts only an API key or
  `apiKeyHelper`, the same credential class the SDK uses. The subscription path
  that motivated [endo-claude](endo-claude.md) is not available to either
  confined backend (Decision 5).

So "which works better in practice" has no production answer yet. The
engineering answer is that **the choice is not load-bearing for Endo**: Endo
should own the boundary both satisfy and ship both backends behind it, and the
first production canary decides the default.

## The backend boundary

Four prototypes (Claude CLI, Claude SDK, OpenAI Responses, Codex subscription)
implemented one seam without changing its core. That seam is the part of these
experiments ready to solidify in Endo.

```ts
interface InferenceBackend {
  describe(): { kind: string; provider: string; version?: string };
  infer(request: InferRequest): Promise<InferResult>; // never rejects
}

interface InferRequest {
  prompt: string;
  guest: GuestToolProjection;
  limits: InferLimits;
  model?: string;
  cancelled: Promise<never>;
}

interface GuestToolProjection {
  buildMcpServer(): McpServer;       // over ONE resolved facet; the authority
  toolNames: readonly string[];      // pinned, pruned catalog
  formulaIdentifier: string;         // audit and join label only
}

interface InferLimits {
  wallClockMs: number;
  outputBytes: number;
  maxTurns: number;
}

type InferResult =
  | { type: 'ok'; text: string; usage?: InferUsage }
  | { type: 'needs-auth' }
  | { type: 'usage-exhausted'; resetAt?: number }
  | { type: 'rate-limited'; retryAfterMs?: number }
  | { type: 'limit-exceeded'; which: 'wall-clock' | 'output-bytes' | 'max-turns' | 'budget' }
  | { type: 'cancelled' }
  | { type: 'unavailable'; reason: string };
```

The shape above is TypeScript for brevity; the Endo package expresses it as a
guarded exo per the root `AGENTS.md` conventions.

What changed from [endo-claude](endo-claude.md) Design Decision 8's taxonomy, and
why:

- `bridge-down`, `facet-threw`, `nonzero-exit`, and `parse-error` collapse into
  `unavailable` with a `reason`. None of the four prototypes emitted them
  separately; each reports these faults as `unavailable` with a reason, and no
  caller needed to branch on the difference.
- `needs-auth` and `usage-exhausted` are separate tags because #96/#119 showed the
  distinction drives different human escalations (reauthenticate versus wait or
  pay).
- `needs-auth` is emitted **only** from a response shape pinned to the running CLI
  version (#119's `classifyProviderResponse`). An unrecognized failure is
  `unavailable`, never `needs-auth`, so a CLI upgrade that changes the error wire
  cannot trigger a false reauthentication storm.
- `budget` joins `limit-exceeded` from the Codex API-key track (#115), where a
  broker refuses a lease before any request.
- `cancelled` stays a tag. Cancellation arrives as the `cancelled`
  `Promise<never>` argument, not an imperative method, per the daemon's standard
  shape.

### The facet is the authority; the formula identifier is a label

Track B's Gap 3 found the production experiment carrying a formula identifier on
the projection while [endo-claude](endo-claude.md) says the `infer` exo carries
none. Both are right about different things. **Settled:** the projection closes
over one already-resolved facet, and that closure is the only authority. The
formula identifier rides along as an audit and telemetry join key that the host
sets. It is never accepted from the prompt, never used to look anything up
during a turn, and never exposed on the `infer` method. Re-resolving it per tool
call (Track B option B) buys nothing capability-safe and costs a daemon round
trip per call.

### `infer` is the primitive the agent factory calls

Track A's finding 6 asked whether `infer` is separate from the `@claude-agents`
recursive factory. **Settled:** it is the primitive. A child agent created by the
factory ([endo-claude-agents-capability](https://github.com/endojs/endo-but-for-bots/pull/1102),
minion.town `claude-agents-capability.md`) runs its turns by calling
`InferenceBackend.infer` over its own facet's projection. The factory owns
naming, quota, delegation, and lifecycle. The backend owns one confined turn.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
| --- | --- | --- | --- | --- | --- |
| Endo daemon → projection | Daemon resolves the guest facet; the projection (`@endo/agent-tools` MCP adapter) wraps it | Which tools are pruned (code-eval names) | Daemon formulas | Daemon | A resolved facet and a pinned `tools/list` snapshot |
| Projection → backend | `buildMcpServer()` | None; the backend may not widen the catalog | None | Caller of `infer` | An `McpServer` and its pinned tool names |
| Backend → Claude Code process | CLI argv or SDK options; constructed env; pinned binary | Confinement recipe (Decision 3) | A per-turn scratch config dir, deleted after the turn | Backend (spawns, limits, kills) | Prompt on stdin; credential per Decision 5; nothing else |
| Backend → deployment broker | Lease request / release | Admission: one inference slot per credential, budget | Lease ledger, usage records, credential | Broker | A lease (credential handle or gateway token) and a usage record |
| Factory → backend | `infer(request)` | Which agent may infer, and how often | Retained-child ledger | Factory | An `InferRequest`; an `InferResult` back |

The four ownership questions:

- **Persistent state:** the daemon owns formulas; the deployment broker owns
  credentials, the lease ledger, and usage; the backend owns nothing that
  outlives a turn.
- **Commit or discard:** the effects a turn causes are ordinary facet calls,
  committed by the daemon as they happen. The backend commits nothing; a killed
  turn leaves whatever facet calls already completed, which is why the
  evaluation design verifies effects independently.
- **Restart and replay:** no turn is replayed. A crashed turn surfaces as
  `unavailable`; the caller decides whether to issue a new `infer`. The broker
  expires an orphaned lease.
- **Execution classification:** the backend classifies a turn's outcome into
  `InferResult`. It returns an *inference* result, not a crank or agent-step
  result. Naming check: nothing in the backend is named for a factory or daemon
  lifecycle concept.

## Design Decisions

1. **Endo ships the seam and both Claude backends; the deployment picks one.**
   The CLI and SDK paths share an engine, a flag set, and a result shape. The
   choice turns on projection delivery and dependency weight, and no production
   data ranks them. `@endo/claude` provides `makeClaudeCliBackend` and
   `makeClaudeSdkBackend`; the first production canary sets the default.

2. **A thin core minion.town can depend on, separate from the OS slice.** Track A
   could not consume `@endo/claude-sandbox`: it is heavy (rootless podman, 9P,
   `@endo/sandbox`, `@endo/hosted-agent`, `@endo/floot`) and #1015 is unmerged.
   So minion.town reimplemented the confinement. **Settled:** the pure parts —
   the argv/options builder, the constructed-env builder, the stream reducer, the
   limit enforcer, and the pinned response-shape classifier — live in a small
   `@endo/claude` with no sandbox dependency. `@endo/claude-sandbox` composes it
   and adds OS containment. Per-consumer reimplementation is the outcome to avoid:
   minion.town already carries two diverging copies (#105 and #106).

3. **Confinement recipe, identical in both front ends.** Built-ins removed
   (`--tools ""` / `tools: []`) and additionally denied; setting sources empty;
   strict MCP config naming exactly one server; skills and slash commands off;
   no session persistence; a fresh per-turn `CLAUDE_CONFIG_DIR` and `HOME`; a
   constructed environment; the prompt on stdin; the allow-list is exactly the
   pinned catalog's `mcp__<server>__<tool>` names. **Permission mode is
   `dontAsk`**, not `bypassPermissions`. Track A used `bypassPermissions` scoped
   by the allow-list; Track B used `dontAsk`. `dontAsk` denies anything not
   pre-allowed (documented behavior, not yet observed), so a tool that leaks past
   the other layers is refused rather than run. On CLI versions that have it, add `--permission-prompts none`
   (documented on 2.1.280). Per-tool human approval, when wanted, is modeled in
   Endo as a facet that asks, not in Claude's prompter.

4. **The flag set is re-verified on every binary bump.** Both tracks relied on
   `--help` for existence, and the flag surface moves: 2.1.280 documents
   `--restricted`, `--permission-prompts`, and `--safe-mode`, none present when
   [endo-claude](endo-claude.md) was measured. The Codex subscription track (#116,
   Gap 1) showed the failure mode when confinement is a deny-list that an upgrade
   can widen. The harness refresh that bumps the pinned binary also diffs its
   `--help` against a reviewed baseline and fails on any change, and reruns the
   live confinement canary (§ Verification gates).

5. **Confined backends use an API-key credential delivered through a broker;
   subscription credentials are outside the Endo contract.** Three findings
   converge. `--bare` never reads OAuth, so a `setup-token` cannot authenticate a
   confined CLI turn. The Agent SDK serves the paid API tier. And
   [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) found no documented
   third-party broker role for an individual Claude subscription. The maintainer's
   2026-09-23 note on #106 points the same way: offering Claude to end users
   outside a subscription needs the API-keyed path. **Settled for Endo:** the
   backend accepts a credential *capability* from a deployment broker, and the
   preferred delivery keeps the key out of the confined process: the backend
   sets `ANTHROPIC_BASE_URL` to a loopback `@endo/hosted-agent` provider listener
   that injects the key per request under a lease. `@endo/hosted-agent`'s
   provider broker already accepts Anthropic-format requests, and the Codex
   API-key track (#115) follows the same rule: the broker lease writes the key
   only into the outgoing request's authorization header. Both Claude prototypes instead put the key in the child
   environment; with built-ins removed the model cannot read it, but the binary
   holds it, so that is a documented residual, not the target. Whether
   minion.town's root-only `setup-token` capture (#87) may continue as a
   deployment-side, owner-only arrangement is Open question 1; the Endo package
   does not depend on the answer.

6. **The facet is the authority; the formula identifier is a host-set label**
   (§ The facet is the authority).

7. **Admission is the broker's, and it is persisted.** Track B's Gap 2 found no
   per-principal serialization. #87 built the single inference-slot lease
   (atomic acquire, expiry as free, sweep). **Settled:** the backend asks the broker for a lease
   before spawning and releases it on every terminal result; a refused lease is
   `rate-limited`, `usage-exhausted`, or `limit-exceeded: budget` before any
   process starts. An in-process mutex (Track B option B) is not acceptable
   beyond a single canary.

8. **Telemetry is a usage record the broker persists, not a wider `InferResult`.**
   Track B's Gap 4 wanted comparison data. `ok` carries an optional `usage`
   (tokens, turns, duration). The comparison record (run id, backend kind, CLI
   version, latency, turns, bytes, failure tag, cost estimate, verified effect)
   is written by the deployment's broker or evaluation harness. Endo defines the
   record's fields so both backends emit the same thing.

9. **OS containment: required for guest-influenced prompts from multiple
   principals, a named residual for single-operator deployments.** Track A
   confined with flags, a constructed env, and a root-owned read-only binary, and
   no filesystem or network isolation. With every built-in removed, the model has
   no tool that reads files or opens sockets, so the remaining risk is a defect in
   the binary itself or in a future flag's semantics. [endo-claude](endo-claude.md)
   Design Decision 6 makes the `@endo/claude-sandbox` slice mandatory for any
   guest-influenced prompt; that stands for multi-tenant use. For a deployment
   where only the root principal drives inference over its own credential (the
   minion.town root-endowment amendment), flags without a slice are acceptable as
   a documented residual, with systemd hardening (`ProtectHome`, a dedicated
   user, no daemon socket in the unit's namespace) as the floor. This follows
   from the evidence, but it relaxes an earlier decision, so it is also Open
   question 2.

10. **Fresh process per turn; continuity is Endo's.** Unchanged from
    [endo-claude](endo-claude.md) Decision 3, and both tracks independently
    arrived at it.

## Verification gates

Nothing below has run. Each gate moves a "documented" row in § Observed versus
documented to "observed". Gates 1–4 block recommending either backend as a
production authority boundary.

1. **Live positive, real daemon guest.** With the production credential kind, one
   turn on each backend causes a write through an allowlisted live daemon guest,
   verified by an independent reader (minion.town
   `claude-on-minion-town-evaluation.md`), never by model prose.
2. **Live negative.** On each backend, in the same turn shape: a `CLAUDE.md` in
   `cwd` and its parent, a `.claude/skills/` entry, a `.claude/settings.json`
   hook, a `.mcp.json` server, and a user-level `~/.claude.json` MCP server are
   all planted, and none reaches the model or fires. A sibling guest's tool name
   and another principal's formula identifier, named in the prompt, are
   unreachable.
3. **Pinned failure shapes.** One deliberately invalid key, one exhausted budget,
   and one rate-limited response are captured per pinned CLI version and recorded
   as the #119 shape table. Until it exists, `needs-auth` is never inferred.
4. **Environment residual.** The confined process's `/proc/<pid>/environ` holds
   no key when the gateway delivery of Decision 5 is used.
5. **Comparison run.** Both backends run the same scenario N times against the
   same guest; the Decision 8 record is compared. This is the production
   evidence the maintainer's review asked for; it chooses Decision 1's default.

## Dependencies

| Design | Relationship |
| --- | --- |
| [endo-claude](endo-claude.md) | Amended by this design: Decisions 1, 2, 3 (permission mode), 5, 7, 8, 9, and the result taxonomy. Its measurements, argv-order analysis, allow-list validation, and pinned-catalog contract stand. |
| [endo-guest-stdio-mcp](endo-guest-stdio-mcp.md) | The CLI backend's out-of-process projection delivery. The SDK backend does not need it. |
| [endo-agent-tools](endo-agent-tools.md) | Supplies the MCP-adapter projection both backends consume. |
| [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) | Source of the subscription finding behind Decision 5; its provider broker is the preferred credential delivery. |
| endo-claude-agents-capability ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102)) | The factory that calls `infer` as its primitive. |
| [#1015](https://github.com/endojs/endo-but-for-bots/pull/1015) (`@endo/claude` confinement core) | The implementation Decision 2 reshapes into a sandbox-free core plus a sandbox composition. |

## Phased implementation

1. **Seam and pure core.** `@endo/claude` exports the seam types as guards, the
   options/argv builder, the constructed-env builder, the stream reducer, the
   limit enforcer, and the pinned-shape classifier, with no sandbox dependency.
   Port from #105/#106 rather than from #1015 where they differ.
2. **Two backends.** `makeClaudeCliBackend` (stdio projection via
   endo-guest-stdio-mcp) and `makeClaudeSdkBackend` (in-process projection), both
   taking a broker lease capability.
3. **Broker delivery.** Claude as an `@endo/hosted-agent` provider: loopback
   listener injecting the API key per lease.
4. **Gates 1–4** on a canary, then **gate 5**, then pick the default backend and
   update this document's Status with the measured comparison.
5. **Slice composition.** `@endo/claude-sandbox` wraps either backend for
   multi-tenant use.

## Known Gaps and TODOs

- [ ] Every row marked "not observed" or "stub" in § Observed versus documented.
- [ ] #106's SDK pin (0.3.236 / 2.1.236) no longer matches the deployed binary
      (2.1.268); a revived SDK track must re-pin.
- [ ] The Claude Code 2.1.265–2.1.267 regression that failed every turn against a
      third-party `ANTHROPIC_BASE_URL` (fixed in 2.1.268 per its release notes)
      shows the gateway delivery of Decision 5 is version-sensitive; the gate-2
      canary must include the gateway.
- [ ] Managed (policy) settings: `--safe-mode`'s help text says policy settings
      "still apply"; whether `--setting-sources ""` drops them remains unverified,
      as [endo-claude](endo-claude.md) already notes.

## Open questions

1. **May a deployment keep using the owner's own subscription for the owner's own
   agents?** minion.town #87 captures a `setup-token` per `iss+sub`, and the
   maintainer's root-endowment amendment limits the factory to the root account.
   That token cannot authenticate a `--bare` turn (Decision 5), so it only works
   through an unconfined or non-`--bare` configuration, which this design does not
   specify. Options: (a) drop subscription use from confined inference entirely
   and move minion.town to the API-key broker; (b) permit a documented,
   owner-only, non-`--bare` configuration outside the Endo contract; (c) wait for
   a vendor-sanctioned broker role. Recommendation: (a), since the #106 note
   already names the API-key path as the end-user path.
2. **Is Decision 9's relaxation acceptable?** It lets a single-operator deployment
   run a confined backend without the OS slice. The alternative keeps
   [endo-claude](endo-claude.md) Decision 6 as written and blocks minion.town's
   production path on a podman-capable host.
3. **Where does the provider-neutral seam live?** The Codex tracks (#115, #116)
   already moved it to `src/endo/inference/` in minion.town. Options: inside
   `@endo/claude` (Claude-first, Codex imports it), a small `@endo/inference`
   package both provider packages depend on, or `@endo/hosted-agent`.
   Recommendation: a small `@endo/inference`, because a second provider already
   exists.
4. **Is "enough production evidence" met?** This back-fill ran with zero
   production inference turns. If the maintainer wants the design to wait for
   gate 5, this document should stay a draft until then; the seam and core
   (phase 1) do not depend on that answer.

## Prompt

> Back-fill the Endo Claude inference design from minion.town production
> evidence. Repos: `kriscendobot/minion.town` (evidence source) and
> `endojs/endo-but-for-bots` (design target, base `llm`). Originating decision:
> https://github.com/endojs/endo-but-for-bots/pull/1228#pullrequestreview-5273103141.
>
> Read the terminal report for `minion-town-claude-inference-exploration-20260922`,
> its two child reports, both draft PRs, and the subsequent production
> observations. Back-fill and solidify the Endo design from what actually worked.
> Compare the Claude CLI and Claude Agent SDK paths, record observed versus merely
> documented behavior, settle the backend boundary and confinement residuals, and
> open a fresh draft design PR against `llm`. Do not revive PR #1228 or assume its
> speculative contract remains valid.
