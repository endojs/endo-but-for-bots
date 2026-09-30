# Provider-neutral inference for a confined guest, and its Claude backends: what the minion.town experiments established

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | kriscendobot (prompted) |
| **Updated** | 2026-09-29 (revised per [review 5348050214](https://github.com/endojs/endo-but-for-bots/pull/1357#pullrequestreview-5348050214)) |
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

**Revision of 2026-09-29.** The maintainer's
[review](https://github.com/endojs/endo-but-for-bots/pull/1357#pullrequestreview-5348050214)
answered the four open questions. This revision records those answers:

- The deployed root user runs on kriscendobot's subscription (Decision 5).
- Multiple subscriptions are a hard requirement: the garden holds several, and
  guests must be able to bring their own subscription or API key. Credentials
  are stored in and delivered from the daemon secret manager
  ([daemon-secret-manager](daemon-secret-manager.md)), and the OS slice is
  required for multi-principal use, for the reason given in Decision 9 (which is
  not Claude Code's on-disk credential store).
- The seam is a provider-neutral `@endo/inference`. "Claude" names only
  Anthropic's Claude Code and models in this document, never Codex or any other
  provider (Decisions 1 and 2).
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
rest of Decision 3's recipe (`--disable-slash-commands`,
`--permission-mode dontAsk`, and a `--mcp-config` naming one real server) was
not combined with a subscription token, and neither was a long-lived
`setup-token`; gate 6 covers both. Like every flag, this behavior needs
rechecking on each binary bump (Decision 4).

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
  motivated [endo-claude](endo-claude.md). Decision 5 uses it for the deployed
  root user.

So "which works better in practice" has no production answer yet. The
engineering answer is that **the choice does not constrain Endo**: Endo should
own the boundary both satisfy and ship both backends behind it, and the first
production canary decides the default.

## The inference seam (`@endo/inference`)

Four prototypes (Claude CLI, Claude Agent SDK, OpenAI Responses, Codex
subscription) implemented one seam without changing its core. Two providers
already sit behind it, so the seam belongs to no provider. It is the part of
these experiments ready to solidify in Endo, as a small package,
`@endo/inference`, that depends on no provider package.

`@endo/inference` offers three layers, and a provider may join at any of them:

1. **Interfaces an implementation must satisfy.** The guarded `InferenceBackend`
   interface below, its request and result shapes, and the usage-record shape
   (Decision 8). A provider that ships its own package is compatible by
   satisfying these guards; it need not import anything else from Endo.
2. **Provider plugins.** A plugin is a maker that returns an `InferenceBackend`
   for one provider and one credential source: `makeClaudeCliBackend` and
   `makeClaudeSdkBackend` in `@endo/claude`; a Codex maker in the Codex package;
   an OpenAI Responses maker wherever that provider's adapter lives.
   `@endo/inference` names no provider and ships no plugin.
3. **Enrichers over an abstract inference maker.** An enricher takes a backend
   and returns a backend that satisfies the same interface: broker-lease
   admission (Decision 7), the usage record (Decision 8), limit enforcement
   shared across providers, and a pinned failure-shape classifier table. They
   compose in any order a deployment chooses, so admission and telemetry are
   written once rather than once per provider.

`describe()` reports the provider (`anthropic`, `openai`, and so on) and the
backend kind (`claude-cli`, `claude-sdk`, `codex-app-server`) separately, so a
record never conflates the vendor with the harness.

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
during a turn, and never exposed on the `infer` method. Re-resolving it per tool
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
credential source (Decision 5) and the backend it returns uses only that one.
Choosing a subscription or key is therefore choosing which backend instance to
hold: the root user's agents hold a backend made over kriscendobot's
subscription; a guest that brings its own subscription or API key holds a
backend made over its own. Nothing in a request can name another principal's
credential, and a guest cannot widen its reach by guessing a credential
identifier, because there is none to guess. This also makes Decision 7's
admission unit exact: one inference slot per credential is one slot per backend
instance's credential source.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
| --- | --- | --- | --- | --- | --- |
| Endo daemon → projection | Daemon resolves the guest facet; the projection (`@endo/agent-tools` MCP adapter) wraps it | Which tools are pruned (code-eval names) | Daemon formulas | Daemon | A resolved facet and a pinned `tools/list` snapshot |
| Projection → backend | `buildMcpServer()` | None; the backend may not widen the catalog | None | Caller of `infer` | An `McpServer` and its pinned tool names |
| Provider plugin → provider process (for the Claude backends, the Claude Code binary) | CLI argv or SDK options; constructed env; pinned binary | Confinement recipe (Decision 3) | A per-turn scratch config dir and `HOME`, deleted after the turn | Backend (spawns, limits, kills) | Prompt on stdin; a lease-scoped endpoint or credential per Decision 5; nothing else |
| Secret manager → broker | `SecretBlob` read facet held by the broker (or by the backend host side in the interim delivery) | None in the store; the store does not interpret bytes | The credential bytes, generation, and audit trail ([daemon-secret-manager](daemon-secret-manager.md)) | Holder of the `SecretAdmin` (replace, revoke) | Credential bytes, read fresh per lease, never persisted elsewhere |
| Backend → deployment broker | Lease request / release | Admission: one inference slot per credential, budget | Lease ledger, usage records | Broker | A lease (loopback endpoint and lease token) and a usage record |
| Factory → backend | `infer(request)` | Which agent may infer, and how often; which credential's backend it holds | Retained-child ledger | Factory | An `InferRequest`; an `InferResult` back |

The four ownership questions:

- **Persistent state:** the daemon owns formulas; the daemon secret manager owns
  credential bytes; the deployment broker owns the lease ledger and usage; the
  factory owns the retained-child ledger; the backend owns nothing that outlives
  a turn.
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
  lifecycle concept, and nothing in `@endo/inference` is named for a provider.

## Design Decisions

1. **`@endo/inference` owns the seam; provider packages ship plugins; the
   deployment picks one.** `@endo/inference` holds the interfaces, guards, and
   enrichers of § The inference seam and names no provider. `@endo/claude`
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
   `@endo/inference` as an enricher. `@endo/claude-sandbox` composes
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
   live confinement canary (§ Verification gates). The subscription-under-`--bare`
   probe is part of that rerun, because the credential delivery below depends on
   it.

5. **Credentials live in the daemon secret manager and reach a turn through a
   broker lease; the deployed root user runs on kriscendobot's subscription.**
   Maintainer decision
   ([comment 4129919081](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4129919081)):
   the deployed root user uses kriscendobot's subscription credential, delivered
   under the `--bare` recipe. The earlier recommendation, to drop subscription
   use from confined inference and move minion.town to an API key, is withdrawn.
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
   - **Delivery, target.** The backend sets `ANTHROPIC_BASE_URL` to a loopback
     `@endo/hosted-agent` provider listener and puts only a lease token in
     `ANTHROPIC_AUTH_TOKEN`. The broker holds the `SecretBlob` read facet, reads
     it fresh per lease, and writes the credential only into the outgoing
     request's `authorization` header (bearer) for a subscription token or
     `x-api-key` for an API key. The confined process never holds the
     credential. This is the rule the Codex API-key track (#115) and the broker
     (#1224) already follow.
   - **Delivery, interim.** Until the broker path passes gate 6, the backend's
     host side reads the `SecretBlob` and places the credential in the
     constructed child environment as `ANTHROPIC_AUTH_TOKEN` (the path
     observed with a short-lived access token; the stored `setup-token` itself
     has not yet run through `--bare`). With built-ins removed the model cannot read it, but the binary
     holds it, so this is a documented residual, acceptable only for a
     single-principal deployment (Decision 9).
   - **Not `CLAUDE_CODE_OAUTH_TOKEN`.** `--bare` ignores it (observed,
     § Subscription credentials under `--bare`). `@endo/claude-sandbox`
     currently materializes exactly that variable in its slice under a
     time-boxed exception (its README, review date 2026-12-08), so its
     subscription mode cannot be combined with this recipe as it stands and
     must move to one of the two deliveries above.

   The target delivery needs one thing the broker does not yet do. It refuses a
   `subscription` mode on the ground that "a Claude Code gateway credential
   replaces the claude.ai login rather than carrying it." The 2026-09-28 probe
   shows a subscription token presented as a plain bearer does authenticate, so
   a broker that forwards the subscription token upstream, rather than
   substituting its own gateway credential, may satisfy the retirement condition
   of the `@endo/claude-sandbox` exception ("a way for a gateway to present a
   subscription credential upstream"). That is not yet observed through a
   loopback listener, and whether such a turn draws on the subscription's usage
   limits rather than per-token billing is not yet observed either. Gate 6
   settles both before the broker gains the mode.

6. **The facet is the authority; the formula identifier is a host-set label**
   (§ The facet is the authority).

7. **Admission is the broker's, and it is persisted.** Track B's Gap 2 found no
   per-principal serialization. #87 built the single inference-slot lease
   (atomic acquire, expiry as free, sweep). **Settled:** the backend asks the
   broker for a lease before spawning and releases it on every terminal result;
   a refused lease is `rate-limited`, `usage-exhausted`, or
   `limit-exceeded: budget` before any process starts. The slot is per
   credential, so several subscriptions run concurrently and one subscription
   never runs two turns at once unless its policy says so. An in-process mutex
   (Track B option B) is not acceptable beyond a single canary. Admission is an
   `@endo/inference` enricher, not a per-provider reimplementation.

8. **Telemetry is a usage record the broker persists, not a wider `InferResult`.**
   Track B's Gap 4 wanted comparison data. `ok` carries an optional `usage`
   (tokens, turns, duration). The comparison record (run id, provider, backend
   kind, CLI version, credential record identifier, latency, turns, bytes,
   failure tag, cost estimate, verified effect) is written by the deployment's
   broker or evaluation harness. `@endo/inference` defines the record's fields
   so every backend, of every provider, emits the same thing. The credential
   record identifier is the secret manager's `secretId`, never the bytes.

9. **OS containment is required for multi-principal inference; it is not
   required by Claude Code's credential store.** Multiple subscriptions are a
   hard requirement
   ([comment 4129930579](https://github.com/endojs/endo-but-for-bots/pull/1357#discussion_r4129930579)),
   and guests bringing their own subscription or API key makes a deployment
   multi-principal by definition. The maintainer asked whether the slice is
   optional given that Claude Code stores credentials in the user's home
   directory. The honest assessment has two halves.

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
   slice reaches only its own broker listener, supplies that. **Settled:**

   - Any turn driven by a principal other than the deployment's root, and any
     deployment that holds more than one principal's credential, runs in the
     slice with the target (broker) delivery. This keeps
     [endo-claude](endo-claude.md) Design Decision 6 as written for
     multi-principal use.
   - The root user's own turns over the root's own credentials, including
     several of the root's subscriptions, may run on flags without a slice, as
     a documented residual, with systemd hardening (`ProtectHome`, a dedicated
     user, no daemon socket in the unit's namespace) as the floor. This is the
     only relaxation, and it is the minion.town root-endowment phase.
   - Guest bring-your-own-credential is therefore gated on the slice (phase 6),
     not merely on the secret store.

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

## Verification gates

Nothing below has run yet. Each gate moves a "documented" row in
§ Observed versus documented to "observed". Gates 1–4 block recommending either
Claude backend as a production authority boundary; gates 6 and 7 block the
broker's subscription mode and guest bring-your-own-credential.

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
3. **Pinned failure shapes.** One deliberately invalid credential, one exhausted
   budget or subscription window, and one rate-limited response are captured per
   pinned CLI version and recorded as the #119 shape table. Until it exists,
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
   that subscription's limits rather than as per-token billing.
7. **Two credentials, two principals.** Two backends over two distinct
   `SecretBlob` credentials run concurrent turns; each turn's usage lands on its
   own credential, a refused lease on one does not block the other, and, in the
   slice, neither turn's process can read the other's environment, config
   directory, or listener.

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
be linked here once it exists. Pull request: *pending* (the probe job has not
opened it as of this revision).

## Dependencies

| Design | Relationship |
| --- | --- |
| [endo-claude](endo-claude.md) | Amended by this design: Decisions 1, 2, 3 (permission mode), 5, 7, 8, and the result taxonomy. Its Decision 6 (slice for guest-influenced prompts) stands for multi-principal use. Its measurements, argv-order analysis, allow-list validation, and pinned-catalog contract stand. |
| [daemon-secret-manager](daemon-secret-manager.md) | The only store for credentials (Decisions 5 and 11). Its single-principal limit and its future owning-principal column bound guest bring-your-own-credential. |
| [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) and `@endo/hosted-agent` ([#1224](https://github.com/endojs/endo-but-for-bots/pull/1224), merged) | The provider broker that reads a `SecretBlob` per lease and injects the credential; Decision 5's target delivery. Gains a subscription mode only after gate 6. |
| `@endo/claude-sandbox` README, "A deliberate, time-boxed exception" | Materializes `CLAUDE_CODE_OAUTH_TOKEN` in the slice, which `--bare` ignores; Decision 5 gives it a retirement path. |
| [#1120](https://github.com/endojs/endo-but-for-bots/pull/1120) (merged) | Moved the Floot provider token into the secret manager; the precedent Decision 5 follows. |
| [#1248](https://github.com/endojs/endo-but-for-bots/pull/1248) (open) | Sandbox unification and the `join` network profile that confines a slice to its broker listener (Decision 9). |
| [endo-guest-stdio-mcp](endo-guest-stdio-mcp.md) | The CLI backend's out-of-process projection delivery. The SDK backend does not need it. |
| [endo-agent-tools](endo-agent-tools.md) | Supplies the MCP-adapter projection every backend consumes. |
| endo-claude-agents-capability ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102)) | The factory that calls `infer` as its primitive. |
| [#1015](https://github.com/endojs/endo-but-for-bots/pull/1015) (`@endo/claude` confinement core) | The implementation Decision 2 reshapes into `@endo/inference`, a sandbox-free `@endo/claude`, and a sandbox composition. |

## Phased implementation

1. **Provider-neutral seam.** `@endo/inference` exports the `InferenceBackend`
   interface and its request, result, and usage-record shapes as guards, plus
   the provider-neutral enrichers: limit enforcement, pinned-table
   classification, lease admission, and the usage record. No provider package
   is a dependency.
2. **Claude core and two Claude backends.** `@endo/claude`, over
   `@endo/inference`, exports the options/argv builder, the constructed-env
   builder, the stream reducer, and the Claude Code shape table;
   `makeClaudeCliBackend` (stdio projection through endo-guest-stdio-mcp) and
   `makeClaudeSdkBackend` (in-process projection), each made over one credential
   source. Port from #105/#106 rather than from #1015 where they differ. The
   Codex plugins port to the same seam in their own package.
3. **Credentials on the secret store.** minion.town's credential store and
   `setup-token` capture move onto `@secrets`; the root user's backend runs on
   kriscendobot's subscription with the interim delivery.
4. **Evidence.** The probe job's build and deployment, then gates 1–4 on a
   canary, then gate 5, then pick the default Claude backend and update this
   document's Status with the measured comparison.
5. **Broker delivery.** Claude as an `@endo/hosted-agent` provider: a loopback
   listener injecting the credential per lease, API key first, then the
   subscription mode once gate 6 passes.
6. **Slice composition and guests' own credentials.** `@endo/claude-sandbox`
   wraps either Claude backend with the broker delivery; then the guest intake
   of Decision 11, after gate 7.

## Known Gaps and TODOs

- [ ] Every row marked "not observed" or "stub" in § Observed versus documented.
- [ ] #106's SDK pin (0.3.236 / 2.1.236) no longer matches the deployed binary
      (2.1.268); a revived SDK track must re-pin.
- [ ] The Claude Code 2.1.265–2.1.267 regression that failed every turn against a
      third-party `ANTHROPIC_BASE_URL` (fixed in 2.1.268 per its release notes)
      shows the broker delivery of Decision 5 is version-sensitive; the gate-2
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
      lease types `@endo/hosted-agent` already owns.
- [ ] A genuine API key under `--bare` is untested. The 2026-09-28 probe's
      `ANTHROPIC_API_KEY` row fed an OAuth token into the API-key slot and says
      nothing about real API-key behavior.
- [ ] The broker refuses a subscription mode today; gate 6 decides whether it
      gains one.
- [ ] The `@endo/claude-sandbox` exception is due for review on 2026-12-08; this
      design supplies the retirement path, and the review should cite gate 6.
- [ ] The secret manager's owning-principal column, needed before guests'
      credentials are partitioned from the operator's catalog.

## Resolved questions

The first draft's four open questions were answered in
[review 5348050214](https://github.com/endojs/endo-but-for-bots/pull/1357#pullrequestreview-5348050214).

1. **May a deployment keep using the owner's own subscription for the owner's own
   agents?** Yes: the deployed root user runs on kriscendobot's subscription,
   option (b) of the first draft, stored in the secret manager and delivered as
   `ANTHROPIC_AUTH_TOKEN` or injected by the broker under the `--bare` recipe.
   Decision 5.
2. **Is Decision 9's relaxation acceptable?** Reframed by the requirement for
   multiple subscriptions and guest-supplied credentials. Claude Code's on-disk
   credential store does not require the slice; multi-principal inference does.
   The slice is optional only for the root user's own turns. Decisions 9 and 11.
3. **Where does the provider-neutral seam live?** In a small `@endo/inference`,
   offering interfaces, provider plugins, and enrichers, with no provider named
   in it. § The inference seam, Decisions 1 and 2.
4. **Is "enough production evidence" met?** No. The document stays a draft, and
   the probe job gathers the evidence. § Evidence probe.

## Open questions

1. **Is the single-principal secret store acceptable for guests' credentials
   until the owning-principal column lands?** Decision 11 makes the operator
   trusted with every guest's credential, which is already true of the host
   that runs the process. The alternative gates guest bring-your-own-credential
   on the column as well as on the slice.

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
