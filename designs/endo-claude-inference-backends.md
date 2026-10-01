# Provider-neutral inference for a confined guest, and its Claude backends: what the minion.town experiments established

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | kriscendobot (prompted) |
| **Updated** | 2026-09-30 (revised per [review 5348050214](https://github.com/endojs/endo-but-for-bots/pull/1357#pullrequestreview-5348050214) and the design-panel rounds on PR #1357; Decision 11 settled per [review comment 4149077338](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4149077338)) |
| **Status** | Draft, awaiting production evidence |
| **Source** | Back-filled from the minion.town Claude CLI and Agent SDK experiments (kriscendobot/minion.town#105, kriscendobot/minion.town#106) and the production observations listed in § Evidence |

## Status

Design only; nothing in this repository changes. This document amends
[endo-claude](endo-claude.md) where the experiments contradicted or settled it,
and leaves that design standing for the parts the experiments did not reach. It
does not revive the closed amendment in
[#1228](https://github.com/endojs/endo-but-for-bots/pull/1228) and does not
treat that amendment's contract as valid.

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

**Terms used before they are defined.** `--bare` is the Claude Code flag that
starts a turn with none of the user's ambient state: it skips the stored login
(`~/.claude/.credentials.json`) and the keychain, and it loads no project or user
memory, hooks, skills, or plugins. It is the basis of every confinement recipe
below. MCP is the Model Context Protocol, the tool-call protocol through which a
Claude process reaches the guest's tools. `SecretBlob` and `SecretAdmin` are the
read facet and the replace-or-revoke facet of one credential record in the
[daemon secret manager](daemon-secret-manager.md). Numbered decisions ("Decision
5") are in § Design Decisions; each early citation carries a short gloss.

**Revision of 2026-09-29.** The maintainer's
[review](https://github.com/endojs/endo-but-for-bots/pull/1357#pullrequestreview-5348050214)
answered the first draft's four open questions. This revision records those
answers, and the decisions cited below carry the reasoning:

- The deployed root user runs on kriscendobot's subscription
  ([Decision 5](#design-decisions), on where credentials live and how they
  reach a turn).
- Multiple subscriptions are a hard requirement: the garden holds several, and
  guests must be able to bring their own subscription or API key. Credentials
  are stored in and delivered from the daemon secret manager
  ([daemon-secret-manager](daemon-secret-manager.md)). The OS slice is
  required for multi-principal use and for any guest-influenced prompt. The
  reason is cross-principal containment, given in
  [Decision 9](#design-decisions) (on OS containment); Claude Code's on-disk
  credential store is not the reason.
- The seam is a provider-neutral `@endo/inference`. "Claude" names only
  Anthropic's Claude Code and models in this document, never Codex or any other
  provider ([Decisions 1 and 2](#design-decisions), on package layout).
- The document stays a draft until real evidence exists. A speculative build and
  deployment runs as the sibling probe job `ebfb-pr1357-inference-probe-20260929`
  (§ Evidence probe).

The file keeps its original name so the review threads stay anchored; its scope
is now the provider-neutral seam plus the Claude backends that were measured.

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
| Subscription-under-`--bare` probe (2026-09-28, Claude Code 2.1.280, a Max-subscription login on a garden host) | Whether a subscription OAuth token can authenticate a `--bare -p` turn, answering review on #1357. Results in § Subscription credentials under `--bare`. |

This document calls the CLI experiment (#105) **Track A** and the Agent SDK
experiment (#106) **Track B**, after their design files; each track's numbered
"findings" and "gaps" are the ones in those files. Bare "Decision N", "gate N",
and "phase N" refer to § Design Decisions, § Verification Gates, and
§ Phased Implementation below.

### Subscription credentials under `--bare`

Empirical probe, 2026-09-28, Claude Code 2.1.280, on a host signed in to a
claude.ai Max subscription (no API key anywhere in the environment). Each row
ran `claude --bare -p "Reply with exactly: ok" --max-turns 1`. The token is that
login's short-lived `sk-ant-oat01-` access token, the same token class
`claude setup-token` mints with a longer lifetime. No fresh `setup-token` was
minted for the probe.

| Credential delivery | Result |
| --- | --- |
| Stored login only (`~/.claude/.credentials.json`) | Fails: `Not logged in · Please run /login`. |
| `CLAUDE_CODE_OAUTH_TOKEN=<token>` | Fails: `Not logged in · Please run /login`. |
| `ANTHROPIC_AUTH_TOKEN=<token>` | **Succeeds** (`ok`). It also succeeded with an empty `HOME` and `CLAUDE_CONFIG_DIR`, plus `--setting-sources "" --strict-mcp-config --tools ""`. `init` reported `apiKeySource: none`. |
| `ANTHROPIC_API_KEY=<token>`, or an `apiKeyHelper` printing it | Invalid input, not evidence about API-key behavior: the probe placed the OAuth access token in the API-key slot. The process was still running when a 120 s timeout killed it. How a genuine API key behaves under `--bare` remains untested. |
| Control: `claude -p` without `--bare`, stored login | Succeeds. |

So `--help`'s "OAuth and keychain are never read" is accurate but narrower than
the conclusion #105 drew from it. `--bare` skips the stored OAuth login and
`CLAUDE_CODE_OAUTH_TOKEN`, but it still sends whatever bearer token
`ANTHROPIC_AUTH_TOKEN` holds, and the API accepts a subscription token there. A
subscription therefore does not force an unconfined configuration, at least
for the flags this probe exercised (`--bare`, `--setting-sources ""`,
`--strict-mcp-config`, `--tools ""`, empty `HOME` and `CLAUDE_CONFIG_DIR`). The
rest of Decision 3's confinement recipe (`--disable-slash-commands`,
`--permission-mode dontAsk`, and a `--mcp-config` naming one real server) was
not combined with a subscription token, and neither was a long-lived
`setup-token`; gate 6 (subscription through the broker) covers both. Like
every flag, this behavior needs rechecking on each binary bump (Decision 4).

### Production observations (2026-09-28)

Read-only inspection of the minion.town host over SSM Run Command, by this job:

- `minion-mcp.service` is active, started 2026-09-27 13:56Z. Its environment and
  both environment files carry **no** `ENDO_CLAUDE_*`, `ANTHROPIC_*`, or
  `CLAUDE_*` variable. The Claude capability is therefore off.
- `dist/endo/claude/` holds the merged modules from #87 and #119 (`account`,
  `agents`, `classify`, `credentials`, `quota`, `reauth`, `wiring`, and others) and no
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
| A real model reaches the guest's projected tools with every built-in denied | **Not observed.** Stub only: a fake binary read the generated `--mcp-config`, presented the nonce, and wrote through the guest surface. | **Observed once**: a real SDK query with built-ins denied called `writeText` then `readText` on an in-memory guest (`memory:g-abf1...-agent`), stored `sdk-live-value`, finished in three turns. Development host, claude.ai login, not the production credential or a real daemon guest. |
| A real model reaches **nothing but** the guest's tools | Not observed (documented). | Not observed: no negative probe ran. |
| Project and user memory, hooks, skills, and ambient MCP servers are excluded | Documented (`--bare`, `--setting-sources ""`, `--strict-mcp-config`). The 2.1.232 measurements in [endo-claude](endo-claude.md) remain the latest live check. | Documented. No live probe has measured these items for the SDK. |
| Credential authenticates headless | Not observed in #105: no credential in the build environment. A subscription OAuth access token authenticating a `--bare -p` turn with a subset of the confinement flags was observed on 2026-09-28 (§ Subscription credentials under `--bare`). | Observed with a claude.ai login on a development host only; the API-key path it targets is unobserved. |
| The `needs-auth` wire signal | Stub: a substring heuristic. The live shape is unknown. | Stub: missing credential mapped before any query. |
| Wall-clock, output-byte, and turn limits terminate a turn | Stub: each axis killed a fake spawn (process-group kill). | Stub: each axis mapped to `limit-exceeded` through the SDK abort controller. |
| The confined process does not inherit the host environment | Stub: `process.env` secrets absent from the constructed child env. | Stub: SDK `env` built from an allowlist. |
| Pinned, integrity-checked binary deploys and rolls back | Observed in production (#99, #103; see above). | Shared: Track B points the SDK at the same pinned executable and prunes the SDK's bundled copy. |

The table's honest reading: **the one positive live result belongs to the SDK
track, no negative result (a probe showing the model reaches nothing beyond the
guest's tools) exists for either track, and neither
credential path has run in production.**

## CLI versus Agent SDK

| Axis | Claude CLI | Claude Agent SDK |
| --- | --- | --- |
| What runs | `claude -p` spawned per turn. | The SDK **also spawns the Claude Code binary** (`pathToClaudeCodeExecutable`) and drives it over a control channel. It is not in-process inference. |
| Configuration surface | Argv plus a settings file plus an MCP config file. Order and quoting matter ([endo-claude](endo-claude.md) § *Argv order is a confinement boundary*). | Typed options object. No argv to get wrong, but each option still becomes a CLI flag underneath, so flag semantics are the same. |
| Guest projection delivery | Out of process: a loopback HTTP endpoint gated by a per-turn nonce (#105), or a claude-spawned stdio server ([endo-guest-stdio-mcp](endo-guest-stdio-mcp.md)). | In process: an `McpServer` handed to the SDK (`mcpServers`) with no socket or nonce. The host holds the facet; the binary reaches it only through the SDK's channel. |
| Credential kinds it can use | Under `--bare`: an API key in `ANTHROPIC_API_KEY` or from `apiKeyHelper` (documented; no genuine key has been tried), **or** a subscription OAuth token delivered as `ANTHROPIC_AUTH_TOKEN` (observed on 2.1.280 with an access token). `--bare` ignores the stored login and `CLAUDE_CODE_OAUTH_TOKEN`, which is what `--help`'s "OAuth and keychain are never read" describes. | API key. Track B read Anthropic's third-party guidance as making this a paid-API backend; the one live run used a developer's claude.ai login, which is not a deployable credential. |
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
- **Credential.** Under `--bare`, the CLI accepts an API key, `apiKeyHelper`,
  or a bearer token in `ANTHROPIC_AUTH_TOKEN`, and a subscription OAuth token
  works in that last slot. `--bare` does not rule out the subscription path that
  motivated [endo-claude](endo-claude.md). Decision 5 (credentials) uses it for
  the deployed root user.

So "which works better in practice" has no production answer yet. The
engineering answer is that **the choice does not constrain Endo**: Endo should
own the boundary that both backends satisfy and ship both of them behind it, and the first
production canary decides the default.

## The Inference Seam (`@endo/inference`)

Four prototypes (Claude CLI, Claude Agent SDK, OpenAI Responses, and Codex
subscription) implemented one seam without changing its core. Two providers
already sit behind it, so the seam belongs to no provider. It is the part of
these experiments ready to solidify in Endo, as a small package,
`@endo/inference`, that depends on no provider package.

`@endo/inference` offers four layers, and a provider may join at any of them:

1. **Interfaces an implementation must satisfy.** An implementation satisfies
   the guarded `InferenceBackend` interface below, its request and result
   shapes, the `CredentialSource` shape, and the usage-record shape (Decision 8,
   telemetry). A provider that ships its own package is compatible by
   satisfying these guards; it need not import anything else from Endo.
2. **Provider plugins.** A plugin is a maker that returns an `InferenceBackend`
   for one provider over one `CredentialSource`: `makeClaudeCliBackend` and
   `makeClaudeSdkBackend` in `@endo/claude`; a Codex maker in the Codex package;
   an OpenAI Responses maker wherever that provider's adapter lives.
   `@endo/inference` names no provider and ships no plugin.
3. **Mechanism libraries a plugin calls.** Pure helpers that need the raw
   provider shape or the running process, and so run inside the plugin: the
   limit enforcer (wall clock, output bytes, turn count, process-group kill) and
   the pinned-table classifier, which maps a raw provider response to an
   `InferResult` tag through a table the plugin supplies. Neither is an
   enricher, because an enricher sees only the already-classified
   `InferResult`.
4. **Enrichers over an abstract inference maker.** An enricher takes a backend
   and returns a backend that satisfies the same interface, acting only on the
   request and the classified result. There are two: the prompt-origin gate
   (Decision 9, on OS containment), which refuses a guest-influenced request
   with `needs-containment` before it reaches an unsliced backend (one whose
   turns run on flags without the `@endo/claude-sandbox` OS slice), and the
   usage recorder (Decision 8),
   which turns each result into one usage record and hands it to the
   deployment's usage sink. Admission is not an enricher; it belongs to the
   credential source (Decision 7).

Each job has one owner. Admission policy (may this turn run?) is the broker's
and reaches the plugin as a refused `acquire()` carrying an admission reason,
not a finished `InferResult`. Credential delivery (what bytes the process sees)
is the `CredentialSource`'s. Outcome classification is split by where the
outcome arises, and each tag has exactly one writer. The prompt-origin gate
writes `needs-containment` and nothing else, and it writes it before the plugin
is called. Every other tag is the plugin's: it maps an admission refusal to an
`InferResult` tag, and a raw provider response through the classifier library.
The durable usage record is the sink's.

`describe()` reports the provider (`anthropic`, `openai`, and so on) and the
backend kind (`claude-cli`, `claude-sdk`, or `codex-app-server`) separately, so a
record never conflates the vendor with the harness.

```ts
interface InferenceBackend {
  describe(): { provider: string; kind: string; version?: string };
  infer(request: InferRequest): Promise<InferResult>; // never rejects
}

interface InferRequest {
  prompt: string;
  // Set by the caller (Decision 9). The exo guard admits it as an optional
  // open string (M.opt(M.string())), deliberately, so a missing or unknown
  // value reaches the prompt-origin gate and becomes needs-containment rather
  // than a guard rejection; infer never rejects.
  promptOrigin?: 'root-authored' | 'guest-influenced' | string;
  guest: GuestToolProjection;
  limits: InferLimits;
  model?: string;
  cancelled: Promise<never>;
}

interface CredentialSource {
  // One acquire per turn. Refusal is admission; a grant is delivery.
  acquire(): Promise<
    | { type: 'granted'; env: Record<string, string>; release(): void }
    | { type: 'refused'; admission: AdmissionRefusal }
  >;
}

interface AdmissionRefusal {
  // Policy: why this turn may not run. The plugin maps it to an InferResult.
  reason: 'rate-limited' | 'usage-exhausted' | 'budget-exhausted';
  retryAfterMs?: number;
}

interface GuestToolProjection {
  buildMcpServer(): McpServer;       // over ONE resolved facet; the authority
  toolNames: readonly string[];      // pinned, pruned catalog
  formulaIdentifier: string;         // audit and join label only
}

interface InferLimits {
  maxWallClockMs: number;
  maxOutputBytes: number;
  maxTurns: number;
}

type InferResult =
  | { type: 'ok'; text: string; usage?: InferUsage }
  | { type: 'needs-auth' }
  | { type: 'usage-exhausted'; retryAfterMs?: number }
  | { type: 'rate-limited'; retryAfterMs?: number }
  | { type: 'budget-exhausted'; retryAfterMs?: number }
  | { type: 'limit-exceeded'; which: 'wall-clock' | 'output-bytes' | 'max-turns' }
  | { type: 'cancelled' }
  | { type: 'needs-containment' }
  | { type: 'unavailable'; detail: string };
```

The shape above is TypeScript for brevity; the Endo package expresses it as a
guarded exo per the root `AGENTS.md` conventions.

What changed from [endo-claude](endo-claude.md) Design Decision 8's taxonomy, and
why:

- `bridge-down`, `facet-threw`, `nonzero-exit`, and `parse-error` collapse into
  `unavailable` with a free-text `detail`. None of the four prototypes emitted
  them separately; each reports these faults as `unavailable` with a message,
  and no caller needed to branch on the difference. The field is `detail`, not
  `reason`, because `reason` on `AdmissionRefusal` is a closed enum a caller
  may switch on, and `detail` is display text only.
- `needs-auth` and `usage-exhausted` are separate tags because #96/#119 showed the
  distinction drives different human escalations (reauthenticate versus wait or
  pay).
- `needs-auth` is emitted **only** from a response shape pinned to the running CLI
  version (#119's `classifyProviderResponse`), by the plugin's call into the
  classifier library while the raw response is still in hand. No enricher
  parses `unavailable.detail`. An unrecognized failure is
  `unavailable`, never `needs-auth`, so a CLI upgrade that changes the error wire
  cannot trigger a false reauthentication storm.
- `budget-exhausted` comes from the Codex API-key track (#115), where a broker
  refuses a lease before any request. The broker does not write that tag: it
  refuses with an `AdmissionRefusal` whose reason is `budget-exhausted`, and
  the plugin passes the three admission reasons, `rate-limited`,
  `usage-exhausted`, and `budget-exhausted`, through unchanged as the
  top-level tags of the same names, each carrying the refusal's
  `retryAfterMs`. It is not a
  `limit-exceeded` arm, because `limit-exceeded` reports a per-turn
  `InferLimits` ceiling reached while the turn ran, and a budget refusal
  happens before any process starts. The plugin stays the only classifier of
  admission refusals and provider responses.
- `needs-containment` is a policy refusal, not a fault, and the one tag the
  plugin does not write: the prompt-origin gate (Decision 9) returns it for a
  guest-influenced, unlabeled, or unknown-origin request that reached an
  unsliced backend. Under Decision 9's routing that request should never have
  reached one, so the tag reports a factory defect; it is a separate tag so the
  defect is visible and not buried in `unavailable.detail`.
- Every "come back later" tag spells its timing the same way: an optional
  `retryAfterMs`, relative to classification time. `rate-limited`,
  `usage-exhausted`, and `budget-exhausted` carry it when the broker or
  provider knows the refill, and omit it otherwise.
- `needs-auth` means the backend's credential source failed to authenticate,
  whichever provider it is. It says nothing about which credential: a
  deployment with several credentials maps it back to one through the backend
  instance that returned it (§ One backend instance per credential).
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
during a turn, and never forwarded to the provider. It is reachable from
`infer`'s parameter (on `request.guest`) for one purpose, so that the usage
recorder can write it; the plugin must not put it in the provider request. Re-resolving it per tool
call (Track B option B) buys nothing capability-safe and costs a daemon round
trip per call.

### `infer` is the primitive the agent factory calls

Track A's finding 6 asked whether `infer` is separate from the `@claude-agents`
recursive factory. **Settled:** it is the primitive. (`@claude-agents` is
minion.town's name for a factory that today runs only Claude; a factory that
creates agents over any provider's backend should carry a provider-neutral name
when it moves into Endo.) A child agent created by the
factory ([endo-claude-agents-capability](https://github.com/endojs/endo-but-for-bots/pull/1102),
minion.town `claude-agents-capability.md`) runs its turns by calling
`InferenceBackend.infer` over its own facet's projection. The factory owns
naming, quota, delegation, and lifecycle. The backend owns one confined turn.

### One backend instance per credential

A credential is not an argument to `infer`. A plugin maker receives one
`CredentialSource` (Decision 5, credentials) and the backend it returns uses
only that one.
Choosing a subscription or key is therefore choosing which backend instance to
hold: the root user's agents hold a backend made over kriscendobot's
subscription; a guest that brings its own subscription or API key holds a
backend made over its own. Nothing in a request can name another principal's
credential, and a guest cannot widen its reach by guessing a credential
identifier, because there is none to guess.

The admission unit is the `CredentialSource`, not the backend instance.
Several backend instances may be made over one credential (Decision 9 holds a
sliced and an unsliced backend over the root's), and when they are, the
deployment makes them over **one shared** `CredentialSource` object, never
two sources over the same secret. Every such backend then serializes through
the same `acquire()`/`release()`, so Decision 7's one inference slot per
credential holds across all of them, and gate 7 checks it. The rule in the
other direction is unchanged: a backend never holds more than one
`CredentialSource`.

## Ownership Map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
| --- | --- | --- | --- | --- | --- |
| Endo daemon -> projection | Daemon resolves the guest facet; the projection (`@endo/agent-tools` MCP adapter) wraps it | Which tools are pruned (code-eval names) | Daemon formulas | Daemon | A resolved facet and a pinned `tools/list` snapshot |
| Projection -> backend | `buildMcpServer()` | None; the backend may not widen the catalog | None | Caller of `infer` | An `McpServer` and its pinned tool names |
| Provider plugin -> provider process (for the Claude backends, the Claude Code binary) | CLI argv or SDK options; constructed env; pinned binary; limit enforcer and classifier libraries | Confinement recipe (Decision 3) | A per-turn scratch config dir and `HOME`, deleted after the turn | Plugin (spawns, limits, kills, classifies) | Prompt on stdin; the `env` a granted `acquire()` returned; nothing else |
| Secret manager -> credential source | `SecretBlob` read facet held by the broker (or by the local credential source in the interim delivery) | None in the store; the store does not interpret bytes | The credential bytes, generation, and audit trail ([daemon-secret-manager](daemon-secret-manager.md)) | Holder of the `SecretAdmin` (replace, revoke) | Credential bytes, read fresh per lease, never persisted elsewhere |
| Plugin -> credential source (broker, or local source in the interim) | `acquire()` / `release()` | Admission: one inference slot per credential, budget | Lease ledger | Broker (or #87's slot lease in the interim) | A grant (an `env`: lease token and loopback endpoint, or the interim credential) or an `AdmissionRefusal` (reason and optional retry time) |
| Usage recorder -> usage sink | Enricher hands each result's record to the sink; the deployment configures each recorder, at construction, with its backend's credential record identifier | None | Usage records | The sink: the broker's ledger in production, the evaluation harness's store in a comparison run | One usage record per turn |
| Factory -> backend | `infer(request)` | Which agent may infer, and how often; which credential's backend each path holds, and whether it is the sliced or unsliced one (Decision 9) | Retained-child ledger | Factory | An `InferRequest`; an `InferResult` back |

The four ownership questions, per the repository's ownership-map convention
for designs that span several owners:

- **Persistent state:** the daemon owns formulas; the daemon secret manager owns
  credential bytes; the deployment broker owns the lease ledger; the one usage
  sink a deployment configures owns usage records; the
  factory owns the retained-child ledger; the backend owns nothing that outlives
  a turn.
- **Commit or discard:** the effects a turn causes are ordinary facet calls,
  committed by the daemon as they happen. The backend commits nothing; a killed
  turn leaves whatever facet calls already completed, which is why the
  evaluation design verifies effects independently.
- **Restart and replay:** no turn is replayed. A crashed turn surfaces as
  `unavailable`; the caller decides whether to issue a new `infer`. The broker
  expires an orphaned lease.
- **Execution classification:** each `InferResult` tag has one writer. The
  prompt-origin gate writes `needs-containment`, before the plugin is called;
  the plugin writes every other tag, mapping an admission refusal itself and
  calling the classifier library on the raw provider response. The broker
  answers only the admission question and writes no tag. The backend returns an *inference* result, not a crank or agent-step
  result. Naming check: nothing in the backend is named for a factory or daemon
  lifecycle concept, and nothing in `@endo/inference` is named for a provider.

## Design Decisions

1. **`@endo/inference` owns the seam; provider packages ship plugins; the
   deployment picks one.** `@endo/inference` holds the interfaces, guards, and
   mechanism libraries, and enrichers of § The Inference Seam and names no
   provider. `@endo/claude`
   provides `makeClaudeCliBackend` and `makeClaudeSdkBackend` over it. The two
   Claude paths share an engine, a flag set, and a result shape; the choice
   between them turns on projection delivery and dependency weight, and no
   production data ranks them, so the first production canary sets the default.
   Codex and OpenAI backends are separate plugins in their own packages and are
   never described as Claude backends.

2. **A thin Claude core minion.town can depend on, separate from the OS slice.**
   Track A could not consume `@endo/claude-sandbox`: it is heavy (rootless
   podman, 9P, `@endo/sandbox`, `@endo/hosted-agent`, `@endo/floot`) and #1015 is
   unmerged. So minion.town reimplemented the confinement. **Settled:** the
   Claude-specific pure parts (the argv/options builder, the constructed-env
   builder, the stream reducer, and the Claude Code response-shape table) live in
   a small `@endo/claude` that depends on `@endo/inference` and on no sandbox
   package. Anything provider-neutral among them (the limit enforcer, the
   classifier mechanism that reads a pinned table) moves down into
   `@endo/inference` as a mechanism library the plugin calls, not an enricher;
   the Claude Code table itself stays in `@endo/claude`. `@endo/claude-sandbox` composes
   `@endo/claude` and adds OS containment. Per-consumer reimplementation is the
   outcome to avoid: minion.town already carries two diverging copies (#105 and
   #106).

3. **Confinement recipe, identical in both Claude front ends.** Built-ins removed
   (`--tools ""` / `tools: []`) and additionally denied; setting sources empty;
   strict MCP config naming exactly one server; skills and slash commands off;
   no session persistence; a fresh per-turn `CLAUDE_CONFIG_DIR` and `HOME`; a
   constructed environment; the prompt on stdin; the allow-list is exactly the
   pinned catalog's `mcp__<server>__<tool>` names. **Permission mode is
   `dontAsk`**, not `bypassPermissions`. Track A used `bypassPermissions` scoped
   by the allow-list; Track B used `dontAsk`. `dontAsk` denies anything not
   pre-allowed (documented behavior, not yet observed), so a tool that leaks past
   the other layers is refused rather than run. On CLI versions that have it,
   add `--permission-prompts none` (documented on 2.1.280). Per-tool human
   approval, when wanted, is modeled in Endo as a facet that asks, not in
   Claude's prompter.

4. **The flag set is re-verified on every binary bump.** Both tracks relied on
   `--help` for existence, and the flag surface moves: 2.1.280 documents
   `--restricted`, `--permission-prompts`, and `--safe-mode`, none present when
   [endo-claude](endo-claude.md) was measured. The Codex subscription track (#116,
   Gap 1) showed the failure mode when confinement is a deny-list that an upgrade
   can widen. The harness refresh that bumps the pinned binary also diffs its
   `--help` against a reviewed baseline and fails on any change, and reruns the
   live confinement canary (§ Verification Gates). The subscription-under-`--bare`
   probe is part of that rerun, because the credential delivery below depends on
   it.

5. **Credentials live in the daemon secret manager and reach a turn through a
   broker lease; the deployed root user runs on kriscendobot's subscription.**
   Maintainer decision
   ([comment 4129919081](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4129919081)):
   the deployed root user uses kriscendobot's subscription credential, delivered
   under the `--bare` recipe. The earlier recommendation, to drop subscription
   use from confined inference and move minion.town to an API key, is withdrawn.
   The evidence for this path is narrow: the one `--bare` run that
   authenticated used a short-lived OAuth access token, and the long-lived
   `setup-token` this decision stores has not yet run through `--bare` (gate 1
   checks it before production use; Phase 3).
   The mechanism is the same for every credential kind, so a subscription and an
   API key differ only in the bytes stored and the header they travel in:

   - **Storage.** Every credential is one `SecretBlob` in the daemon secret
     manager ([daemon-secret-manager](daemon-secret-manager.md)): durable,
     envelope-encrypted, replaceable without re-delegation, revocable, and
     audited. A subscription credential is the long-lived `setup-token` (an
     `sk-ant-oat01-` token); an API key is stored the same way. No backend,
     broker, or deployment keeps a credential in a pet store, an environment
     file, or a file of its own. minion.town's #87 credential store and its
     root-only `setup-token` capture move onto the secret manager; the capture
     flow becomes the intake that calls `@secrets/create`. This matches what
     #1120 already did for the Floot provider token.
   - **Kind.** Whether a record is a subscription token or an API key is
     recorded with the record, as the credential-kind metadata the intake
     writes when it calls `@secrets/create`, never guessed from the token
     prefix. The broker reads the kind to choose the header.
   - **Delivery, target.** The plugin's `CredentialSource` is the broker. A
     granted `acquire()` returns an `env` that sets `ANTHROPIC_BASE_URL` to a
     loopback `@endo/hosted-agent` provider listener and puts only a lease token
     in `ANTHROPIC_AUTH_TOKEN`. The broker holds the `SecretBlob` read facet, reads
     it fresh per lease, and writes the credential only into the outgoing
     request's `authorization` header (bearer) for a subscription token or
     `x-api-key` for an API key. The confined process never holds the
     credential. This is the rule the Codex API-key track (#115) and the broker
     (#1224) already follow.
   - **Delivery, interim.** Until the broker path passes gate 6, the
     `CredentialSource` is a local one: it takes #87's per-credential slot
     lease (so admission is unchanged), reads the `SecretBlob`, and returns the
     credential in the grant's `env` as `ANTHROPIC_AUTH_TOKEN` (the path
     observed with a short-lived access token; the stored `setup-token` itself
     has not yet run through `--bare`). With built-ins removed the model
     cannot read it, but the binary holds it. This is a documented residual,
     acceptable only for a single-principal deployment (Decision 9).
   - **Not `CLAUDE_CODE_OAUTH_TOKEN`.** `--bare` ignores it (observed,
     § Subscription credentials under `--bare`). `@endo/claude-sandbox`
     currently materializes exactly that variable in its slice under a
     time-boxed exception (its README, review date 2026-12-08), so its
     subscription mode cannot be combined with this recipe as it stands and
     must move to one of the two deliveries above.

   **Reconciling with [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md).**
   That design, which this one depends on, already examined the shape of the
   target delivery for a Claude subscription and closed it. Its conclusion,
   § *Claude Code with a Claude.ai subscription: still blocked for a
   third-party broker*, rests on two documented points and one gate:

   - Anthropic's gateway documentation says that "while a gateway credential
     variable or `apiKeyHelper` is active, a developer's claude.ai subscription
     isn't used ... and the subscription's usage limits don't apply", with the
     traffic "billed per token to whoever owns the credential the gateway
     forwards" ([Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)).
     The same section scopes the trigger to the credential variable and
     separately to the base URL: "`ANTHROPIC_BASE_URL` is the variable that
     points Claude Code at the gateway. Setting only that variable, without a
     gateway credential, doesn't replace the subscription." The connection
     guide names `ANTHROPIC_AUTH_TOKEN` as a gateway credential variable and
     says "a gateway credential variable takes precedence over a saved
     claude.ai login ... With `ANTHROPIC_AUTH_TOKEN`, the variable takes
     precedence immediately"
     ([Connect to a gateway](https://code.claude.com/docs/en/llm-gateway-connect#conflicts-with-an-existing-login)).
     So the caveat turns on the credential variable being set, and the base
     URL alone does not trigger it. The 2026-09-28 probe populated exactly that
     variable (`ANTHROPIC_AUTH_TOKEN`) with a subscription token, so it is
     inside the documented case, not outside it. What the text does not
     address is the probe's exact combination, a subscription token in the
     variable with the default Anthropic base URL; the billing sentence names
     "the credential the gateway forwards" and no gateway was in the path.
     That combination is therefore undocumented rather than documented either
     way, which is why gate 1 measures where the usage lands instead of
     assuming it.
   - "Nothing documents a gateway holding [a `setup-token`] and presenting it
     upstream on a user's behalf." A broker that did so relies on undocumented
     behavior.
   - `SUBSCRIPTION-AUTH.md`'s gate admits a subscription mode only through "an
     officially supported proxy/gateway configuration."

   The probe does not overturn any of the three. It shows that the API
   *accepts* a subscription token as a bearer; that design already said its
   finding "is a statement about what is documented, not a claim that the
   bytes would be rejected." It says nothing about which account's limits the
   turn draws on, and the vendor text above, read plainly, predicts per-token
   billing or undocumented accounting rather than subscription usage.
   Consequences for this design:

   - **The broker's subscription mode stays closed.** Gate 6 is evidence, not
     authorization: even a passing gate 6 leaves the mode closed under
     `SUBSCRIPTION-AUTH.md` until Anthropic documents a proxy-holds-the-
     subscription configuration or the maintainer amends that gate in
     [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) itself. This
     design does not amend it. The target delivery above is therefore the
     target for **API keys** now, and for subscriptions only if that gate
     opens.
   - **The interim delivery has the same open accounting question.** It too
     puts a subscription token in `ANTHROPIC_AUTH_TOKEN`, so the root user's
     turns may already fall outside the subscription's usage limits. The
     maintainer's decision to run the root user on kriscendobot's subscription
     stands, but gate 1's canary must check where its usage lands, not only
     gate 6.
   - **Terms, not only mechanics.** Whether automated, multi-principal
     inference over a personal Pro or Max subscription is permitted by
     Anthropic's subscription terms, as distinct from the commercial API terms,
     is a dependency this design does not resolve and cannot resolve by
     probing. It is listed in § Known Gaps and TODOs and is a precondition,
     alongside gate 6 and the `SUBSCRIPTION-AUTH.md` gate, for any
     subscription credential a guest brings.
   - **Fallback if the subscription path stays closed.** The root user keeps
     the interim delivery as a single-principal residual (Decision 9), and
     guest bring-your-own-credential (Decision 11) admits **API keys only**,
     through the broker. That is a narrower product, not a different
     architecture: the seam, the secret store, the one-backend-per-credential
     rule, and the slice are unchanged, and only the set of credential kinds
     the intake accepts shrinks. The interim delivery never becomes the
     multi-principal policy.

6. **The facet is the authority; the formula identifier is a host-set label**
   (§ The facet is the authority).

7. **Admission is the credential source's, and it is persisted.** Track B's
   Gap 2 found no per-principal serialization. #87 built the single
   inference-slot lease (atomic acquire, expiry as free, sweep). **Settled:**
   the plugin calls its `CredentialSource.acquire()` before spawning and
   releases the grant on every terminal result. A refusal is an
   `AdmissionRefusal` (`rate-limited`, `usage-exhausted`, or `budget-exhausted`) delivered
   before any process starts, and the plugin maps it to the matching
   `InferResult` tag. The policy lives in the broker (or in
   #87's slot lease during the interim delivery), so it is written once, not
   once per provider; the plugin only calls `acquire()`. The slot is per
   credential, so several subscriptions run concurrently and one subscription
   never runs two turns at once unless its policy says so. An in-process mutex
   (Track B option B) is not acceptable after the first canary deployment.
   Admission is not an enricher: an enricher around `infer` could refuse a
   turn but could not hand the grant's `env` inward, and splitting the two
   would give the lease two owners.

8. **Telemetry is a usage record the deployment's one usage sink persists, not
   a wider `InferResult`.** Track B's Gap 4 wanted comparison data. `ok` carries
   an optional `usage` (tokens, turns, and duration). `@endo/inference` defines
   the record's fields so every backend, of every provider, emits the same
   thing, and each field has one producer:

   - **The usage-recorder enricher**, from what it sees: provider, backend
     kind, and CLI version (from the wrapped backend's `describe()`); prompt
     origin and formula identifier (from the request); latency (timed around
     `infer`); and turns, bytes, and failure tag (from the classified result).
   - **The deployment, at construction.** The credential record identifier is
     the secret manager's `secretId`, never the bytes. The recorder cannot see
     inside the `CredentialSource`, so the deployment, which makes one backend
     per credential (§ One backend instance per credential), passes that
     backend's `secretId` to the recorder that wraps it. No runtime channel
     from the credential source to the recorder exists.
   - **The sink**, when it writes the record: the run id and the cost estimate.
   - **The evaluation harness**, in a comparison run only: the verified effect,
     from its independent reader, joined onto the record by run id.

   Exactly one sink is configured per deployment: the broker's ledger in
   production, or the evaluation harness's store in a comparison run. Nothing
   else writes the record, and the broker and the harness never both hold the
   sink for one deployment.

9. **OS containment is required for multi-principal inference and for any
   guest-influenced prompt; Claude Code's credential store does not require
   it.** Multiple subscriptions are a
   hard requirement
   ([comment 4129930579](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4129930579)),
   and guests bringing their own subscription or API key makes a deployment
   multi-principal by definition. The maintainer asked whether the slice is
   optional given that Claude Code stores credentials in the user's home
   directory. The honest assessment has three parts.

   *The on-disk credential store does not force the slice.* Under `--bare` the
   binary never reads the stored login (`~/.claude/.credentials.json`) or the
   keychain, and a turn authenticated with `ANTHROPIC_AUTH_TOKEN` alone and an
   empty `HOME` and `CLAUDE_CONFIG_DIR` (observed). Decision 3 already gives
   each turn a fresh, empty `HOME` and `CLAUDE_CONFIG_DIR`. So no turn reads or
   writes a shared credential file, and several subscriptions on one host need
   neither several Unix users nor several home directories to keep their
   credentials apart. The credentials are kept apart by the secret manager and
   by Decision 5's one-backend-per-credential rule.

   *The slice is still required for multi-principal use, for a different
   reason.* Once two principals' turns share a host, a residual defect in the
   binary (or a future flag whose semantics widen) is no longer contained to one
   principal's own credential and facet. Without OS isolation, turns run as one
   Unix user, so one turn's process can read another's `/proc/<pid>/environ`,
   its per-turn config directory, and any loopback listener on the host. Under
   the interim delivery that exposes another principal's raw credential; under
   the target delivery it exposes another principal's lease token and listener.
   The broker narrows what leaks from a credential to a bounded, revocable
   lease; only filesystem, process, and network isolation stop the leak. The
   `@endo/claude-sandbox` slice, with the `join` network profile of #1248 so the
   slice reaches only its own broker listener, supplies that. (That egress
   property is #1248's to verify; this design's gate 7 checks only that two
   slices cannot read each other.)

   *The slice is also required for any guest-influenced prompt, whoever pays.*
   [endo-claude](endo-claude.md) Design Decision 6 reads: the slice is
   "required, not merely recommended, for any guest-influenced prompt." That
   condition is about the prompt, not the credential, and this design keeps it
   in full. A root-credentialed turn whose prompt carries text from a guest
   (for example, an inbox message that the inbox-watch driver of
   kriscendobot/minion.town#120 turns into a prompt, or a request that a guest
   delegated to the factory) is guest-influenced, and the root's credential paying for it does not change
   that. **Settled:**

   - Any turn driven by a principal other than the deployment's root, any turn
     whose prompt is guest-influenced, and every turn in a deployment that
     holds more than one principal's credential, runs in the slice with the
     target (broker) delivery. This keeps [endo-claude](endo-claude.md) Design
     Decision 6 as written and adds the multi-principal condition beside it.
   - The relaxation needs **both** conditions: the turn runs over the root's
     own credential (including several of the root's subscriptions, all owned
     by the one root principal; a subscription any other principal owns is
     that principal's credential and does not qualify), **and** its prompt is
     root-authored. Such a turn may run on flags without a slice, as a
     documented residual, with systemd hardening (`ProtectHome`, a dedicated
     user, no daemon socket in the unit's namespace) as the floor. This is the
     only relaxation, and it is the minion.town root-endowment phase.
   - **Containment is chosen by which backend a call path holds.** This is
     the rule § One backend instance per credential already uses for
     credentials. The factory holds two backends over the root's credential:
     an unsliced root backend, reachable only from the root operator's
     direct-prompt path, and a sliced backend for every other path (a
     delegated request, an inbox message, a guest argument, a tool result).
     Both are made over the one `CredentialSource` for the root's credential
     (§ One backend instance per credential), so a root-authored turn and a
     delegated turn contend for the same admission slot rather than running
     at once on one subscription.
     Until phase 6 supplies the sliced backend, those other paths hold none
     and cannot infer. A path that includes guest text therefore never holds
     the unsliced backend, whatever it would label its request.
   - **The label is a backstop.** The caller still sets
     `InferRequest.promptOrigin`: `root-authored` only for text the root
     operator wrote or a root-owned program generated from no guest input,
     and `guest-influenced` for anything that includes a guest's message,
     argument, or tool result. The unsliced backend is always wrapped in the
     prompt-origin gate enricher, which returns `needs-containment` for a
     `guest-influenced`, missing, or unknown origin. Under correct routing the
     gate never fires; when it does, it has caught a factory defect, fails
     closed, and the factory surfaces the defect rather than retrying on
     another backend.
   - **Which path holds the unsliced backend is a gated premise.** No
     structural mechanism, such as taint tracking, checks that the root
     operator's direct-prompt path carries no guest-derived text; a path that
     wrongly holds the unsliced backend and also mislabels its request runs a
     guest's text with no slice and full host network reach. Gate 8 bounds
     that premise by exercising the real factory code paths end to end: which
     backend each path is given, and how it labels its requests. Until gate 8
     passes, the unsliced root backend serves only the root operator's own
     direct prompts. § Known Gaps and TODOs tracks the absence of a structural
     check.
   - Guest bring-your-own-credential, and any guest-influenced prompt, are
     therefore gated on the slice (phase 6), not merely on the secret store.

10. **Fresh process per turn; continuity is Endo's.** Unchanged from
    [endo-claude](endo-claude.md) Decision 3, and both tracks independently
    arrived at it.

11. **Guests bring their own credential through an intake onto the secret
    store.** The secret manager is single-principal: only the root host carries
    `@secrets`, and `@secrets/create` is root-side. A guest's credential
    therefore enters through an intake the deployment operates on the guest's
    behalf. The intake creates the `SecretBlob`, hands the guest the
    `SecretAdmin` for that record (so the guest can replace or revoke its own
    credential), and makes the guest's backend over it (§ One backend instance
    per credential). The guest does not need to hold the `SecretBlob` read facet
    at all. The operator's `@secrets/catalog` still lists every record's admin
    facet, and the operator's host runs the process, so the deployment operator
    is trusted with guests' credentials; the intake must say so to the guest.
    Per-principal ownership in the store waits on the owning-principal column
    that [daemon-secret-manager](daemon-secret-manager.md) names as future work.
    The single-principal store is acceptable for guests' credentials until that
    column lands: guest bring-your-own-credential is gated on the slice
    (Decision 9), not additionally on the column (settled by the maintainer in
    [review comment 4149077338](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4149077338)).

## Verification Gates

Nothing below has run yet. Each gate moves a "documented" row in
§ Observed versus documented to "observed". Gates 1–4 block recommending either
Claude backend as a production authority boundary, and gate 1's accounting check
blocks the root user's subscription deployment (Phase 3); gates 6 and 7 block the
broker's subscription mode and guest bring-your-own-credential; gate 8 blocks
serving any prompt other than the root operator's direct prompts on the
unsliced root backend (Decision 9).

1. **Live positive, real daemon guest.** With the production credential kind, one
   turn on each backend causes a write through an allowlisted live daemon guest,
   verified by an independent reader (minion.town
   `claude-on-minion-town-evaluation.md`), never by model prose. When the
   credential is a subscription token (the interim delivery of Decision 5), the
   canary also records whether the turn's usage appears against the
   subscription's usage limits or as per-token billing.
2. **Live negative.** On each backend, in the same turn shape: a `CLAUDE.md` in
   `cwd` and its parent, a `.claude/skills/` entry, a `.claude/settings.json`
   hook, a `.mcp.json` server, and a user-level `~/.claude.json` MCP server are
   all planted, and none reaches the model or fires. A sibling guest's tool name
   and another principal's formula identifier, named in the prompt, are
   unreachable. A `guest-influenced` request, or one with no `promptOrigin`,
   sent to an unsliced backend is refused by the prompt-origin gate with
   `needs-containment` before any process starts.
3. **Pinned failure shapes.** One deliberately invalid credential, one exhausted
   budget or subscription window, one rate-limited response, and one turn that
   produces no response at all are captured per pinned CLI version and recorded
   as the #119 shape table. The fourth shape is already known to occur: the
   2026-09-28 probe's malformed `ANTHROPIC_API_KEY` row hung until an external
   120 s timeout killed it rather than failing fast. The canary confirms that
   the backend's own wall-clock limit, not a probe script's timeout, ends such a
   turn as `limit-exceeded: wall-clock`. A fifth shape exercises the faults
   folded into `unavailable` (§ The Inference Seam): one turn each whose
   process is killed mid-stream, exits nonzero, and emits malformed
   stream-json output, each observed to classify as `unavailable` with a
   `detail`, never as `needs-auth` or a silent `ok`. Until the table exists,
   `needs-auth` is never inferred.
4. **Environment residual.** The confined process's `/proc/<pid>/environ` holds
   no credential, only a lease token, when the target delivery of Decision 5 is
   used.
5. **Comparison run.** Both Claude backends run the same scenario N times
   against the same guest; the Decision 8 record is compared. This is the
   production evidence the maintainer's review asked for; it chooses
   Decision 1's default.
6. **Subscription through the broker.** A `--bare` turn whose
   `ANTHROPIC_AUTH_TOKEN` is a lease token and whose `ANTHROPIC_BASE_URL` is the
   loopback listener succeeds when the broker forwards a subscription
   `setup-token` read from a `SecretBlob`, and the turn's usage appears against
   that subscription's limits rather than as per-token billing. Passing gate 6
   is necessary, not sufficient: the broker's subscription mode also needs the
   `SUBSCRIPTION-AUTH.md` gate opened, as Decision 5 explains.
7. **Two credentials, two principals.** Two backends over two distinct
   `SecretBlob` credentials run concurrent turns; each turn's usage lands on its
   own credential, a refused lease on one does not block the other, and, in the
   slice, neither turn's process can read the other's environment, config
   directory, or listener. On one credential, a second concurrent `acquire()`
   while the first grant is held is refused (Decision 7's one slot per
   credential), and succeeds once the first grant is released. The same holds
   across backend instances: with the unsliced and sliced root backends of
   Decision 9 made over the one shared `CredentialSource`, a turn on each
   issued concurrently is admitted one at a time, never both at once.
8. **Containment routing, end to end.** Negative: a real guest-influenced
   input (an inbox message through the inbox-watch driver, a guest's delegated
   request, a guest-supplied argument, and a tool result carrying guest text)
   is threaded through the factory, and each such path is observed to hold the
   sliced backend or none, never the unsliced one, and to label its request
   `guest-influenced`. Positive: a genuine root-authored prompt on the root
   operator's direct-prompt path, with no guest-derived text on the same call
   path, is observed to arrive at `infer` on the unsliced backend labeled
   `root-authored` and to complete there without `needs-containment`. Gate 2
   tests only the gate enricher; this gate tests the factory code that picks
   the backend and sets the label.

### Evidence probe

The maintainer asked for real evidence
([comment 4129942772](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4129942772)).
This document stays a draft until it exists. A speculative build and deployment
runs ahead of acceptance as the sibling job
`ebfb-pr1357-inference-probe-20260929`: a minimal `@endo/inference` seam and a
Claude backend running confined `--bare` turns with credentials from the secret
store, at least two distinct credentials, deployed to minion.town or an
equivalent live host, recording turn counts, timings, failures, CLI version, and
which gates above pass. Its draft pull request carries the gap report and will
be linked here once it exists. Pull request:
[#1369](https://github.com/endojs/endo-but-for-bots/pull/1369) (draft).

## Dependencies

| Design | Relationship |
| --- | --- |
| [endo-claude](endo-claude.md) | Amended by this design: Decisions 1, 2, 3 (permission mode), 5, 7, 8, and the result taxonomy. Its Decision 6 ("required, not merely recommended, for any guest-influenced prompt") stands in full, whichever credential pays; Decision 9 here adds a second, multi-principal condition beside it. Its measurements, argv-order analysis, allow-list validation, and pinned-catalog contract stand. |
| [daemon-secret-manager](daemon-secret-manager.md) | The only store for credentials (Decisions 5 and 11). Its single-principal limit and its future owning-principal column bound guest bring-your-own-credential. |
| [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) and `@endo/hosted-agent` ([#1224](https://github.com/endojs/endo-but-for-bots/pull/1224), merged) | The provider broker that reads a `SecretBlob` per lease and injects the credential; Decision 5's target delivery. Its finding that Claude Code has no documented path for a third-party broker to carry a subscription stands; Decision 5 reconciles with it, and the broker gains a subscription mode only after gate 6 and an opened `SUBSCRIPTION-AUTH.md` gate. |
| `@endo/claude-sandbox` README, "A deliberate, time-boxed exception" | Materializes `CLAUDE_CODE_OAUTH_TOKEN` in the slice, which `--bare` ignores; Decision 5 gives it a retirement path. |
| [#1120](https://github.com/endojs/endo-but-for-bots/pull/1120) (merged) | Moved the Floot provider token into the secret manager; the precedent Decision 5 follows. |
| [#1248](https://github.com/endojs/endo-but-for-bots/pull/1248) (open) | Sandbox unification and the `join` network profile that confines a slice to its broker listener (Decision 9). |
| [endo-guest-stdio-mcp](endo-guest-stdio-mcp.md) | The CLI backend's out-of-process projection delivery. The SDK backend does not need it. |
| [endo-agent-tools](endo-agent-tools.md) | Supplies the MCP-adapter projection every backend consumes. |
| endo-claude-agents-capability ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102)) | The factory that calls `infer` as its primitive. |
| [#1015](https://github.com/endojs/endo-but-for-bots/pull/1015) (`@endo/claude` confinement core) | The implementation Decision 2 reshapes into `@endo/inference`, a sandbox-free `@endo/claude`, and a sandbox composition. |

## Phased Implementation

1. **Provider-neutral seam.** `@endo/inference` exports the `InferenceBackend`
   interface and its request, result, and usage-record shapes as guards, plus
   the `CredentialSource` and usage-record shapes; the mechanism libraries (limit
   enforcement, pinned-table classification); and the two enrichers
   (prompt-origin gate, usage recorder). No provider package is a
   dependency.
2. **Claude core and two Claude backends.** `@endo/claude`, over
   `@endo/inference`, exports the options/argv builder, the constructed-env
   builder, the stream reducer, and the Claude Code shape table;
   `makeClaudeCliBackend` (stdio projection through endo-guest-stdio-mcp) and
   `makeClaudeSdkBackend` (in-process projection), each made over one credential
   source. Port from #105/#106 rather than from #1015 where they differ. The
   Codex plugins port to the same seam in their own package.
3. **Credentials on the secret store, and the root canary.** minion.town's
   credential store and `setup-token` capture move onto `@secrets`. The root
   user's backend first runs on kriscendobot's subscription with the interim
   delivery only as a canary, wrapped in the prompt-origin gate so it serves
   root-authored prompts only, and gate 1 runs on it, including the check of
   whether the stored `setup-token`'s usage lands against the subscription's
   limits or as per-token billing. The root backend serves production traffic
   only after gate 1 passes; if usage lands as per-token billing, the
   deployment stops and the maintainer decides before it proceeds.
4. **Evidence.** The probe job's build and deployment, then gates 2–4 and
   gate 8 on the canary, then gate 5, then pick the default Claude backend and
   update this document's Status with the measured comparison. Gate 8 needs the
   factory ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102),
   still open). If #1102 is not ready, gates 2–5 proceed without it and gate 8
   runs once it lands; until then the root backend keeps Decision 9's
   restriction to the root operator's direct prompts.
5. **Broker delivery.** Claude as an `@endo/hosted-agent` provider: a loopback
   listener injecting the credential per lease, API key first, then the
   subscription mode only once gate 6 passes and the `SUBSCRIPTION-AUTH.md`
   gate opens (Decision 5).
6. **Slice composition and guests' own credentials.** `@endo/claude-sandbox`
   wraps either Claude backend with the broker delivery; then the guest intake
   of Decision 11, after gate 7.

## Known Gaps and TODOs

- [ ] Every row marked "not observed" or "stub" in § Observed versus documented.
- [ ] #106's SDK pin (0.3.236 / 2.1.236) no longer matches the deployed binary
      (2.1.268); a revived SDK track must re-pin.
- [ ] The Claude Code 2.1.265–2.1.267 regression that failed every turn against a
      third-party `ANTHROPIC_BASE_URL` (fixed in 2.1.268 per its release notes)
      shows the broker delivery of Decision 5 is version-sensitive; the gate 2
      canary must include the listener.
- [ ] Managed (policy) settings: `--safe-mode`'s help text says policy settings
      "still apply"; whether `--setting-sources ""` drops them remains unverified,
      as [endo-claude](endo-claude.md) already notes.
- [ ] `@endo/hosted-agent` already defines provider-neutral session facets
      (`HostedTurnBackend`, `HostedBackendFactory`) for Floot. Those are
      multi-turn sessions with continuity modes; `InferenceBackend` is one
      stateless confined turn. Whether a hosted session backend should be an
      enricher over `InferenceBackend`, or the two stay separate contracts, is
      unsettled; `@endo/inference` must at least not redefine the broker or
      lease types `@endo/hosted-agent` already owns. `buildMcpServer()` also
      fixes one transport (MCP) into the neutral seam; every prototype uses
      MCP, so this stands until a provider needs another.
- [ ] Two existing provider concepts sit beside `@endo/inference` and are not
      replaced by it. `packages/fae/llm-provider-factory.js` is a caplet that
      stores provider configuration (host, model, secret name) for Fae's own
      chat loop, and
      [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md)
      proposes a registry of chat-completion providers for Lal and Genie. Both
      describe how an unconfined agent loop reaches a model API. The
      `InferenceBackend` is one confined turn over a guest facet, with its
      credential behind a `CredentialSource`. A later design may let a registry
      entry make a `CredentialSource`, so one stored credential serves both;
      until then they stay separate.
- [ ] A genuine API key under `--bare` is untested. The 2026-09-28 probe's
      `ANTHROPIC_API_KEY` row fed an OAuth token into the API-key slot and says
      nothing about real API-key behavior.
- [ ] The broker refuses a subscription mode today, and
      [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) closes it on
      documentation grounds. Gate 6 supplies evidence; opening the mode also
      needs vendor documentation of a proxy-holds-the-subscription
      configuration or a maintainer amendment of the `SUBSCRIPTION-AUTH.md`
      gate (Decision 5).
- [ ] Subscription terms. Whether Anthropic's subscription terms permit
      automated, multi-principal inference over a personal Pro or Max
      subscription, as distinct from the commercial API, is unresolved. The
      maintainer's decision covers the root user's own subscription; a guest
      subscription is gated on this as well as on gate 6.
- [ ] The `@endo/claude-sandbox` exception is due for review on 2026-12-08; this
      design supplies the retirement path, and the review should cite gate 6.
- [ ] Which factory call path holds the unsliced root backend, and the
      `promptOrigin` backstop label, have no structural check (no taint
      tracking). Gate 8 tests the factory's existing call paths, but a new call
      path is unverified until gate 8 is extended to it (Decision 9).
- [ ] The secret manager's owning-principal column, needed before guests'
      credentials are partitioned from the operator's catalog. Guest
      bring-your-own-credential does not wait on it (Decision 11).

## Open Questions

None.

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
