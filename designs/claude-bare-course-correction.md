# Course correction after `claude --bare` rejected subscription credentials

| | |
|---|---|
| **Created** | 2026-10-23 |
| **Status** | Proposed |
| **Companion** | [API-key inference providers and pinned guest agents](api-key-inference-providers-and-pinned-agents.md) |
| **Grounded against** | `endojs/endo-but-for-bots` `llm` at `d5ac41980a`; `kriscendobot/minion.town` `main` at `68c3960bbe` |

## Summary

The subscription-backed guest path must be retired. Claude Code 2.1.296 says
that `--bare` uses only `ANTHROPIC_API_KEY` or `apiKeyHelper` and never reads
OAuth. A clean-home run with only a deliberately invalid
`CLAUDE_CODE_OAUTH_TOKEN` produced `Not logged in`; the same behavior is also
reported in the upstream Claude Code repository
([#82566](https://github.com/anthropics/claude-code/issues/82566)). This is a
mode contract, not a transient minion.town wiring bug.

The replacement is the companion design's two-step path: first import a user's
API key as a reusable inference provider, then create a Lal- or Fae-derived
guest agent that uses that provider and wakes on mail. Ship that path beside the
current Claude path, migrate durable guest state, and only then remove the
subscription-specific CLI, harness image, and guest stdio MCP server.

This design does not change ferry or identity switching.

## Evidence

On 2026-10-23, from minion.town `main`, the repository-pinned binary was
installed from `tools/claude-harness/package.json` and run directly:

```text
$ claude --version
2.1.296 (Claude Code)

$ claude --help
--bare ... Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper ...

$ env -i HOME=<empty> PATH=/usr/bin:/bin \
    CLAUDE_CODE_OAUTH_TOKEN=not-a-real-token \
    claude --bare -p 'reply ok' --max-turns 1
Not logged in · Please run /login
```

This run is negative evidence only. `Not logged in` shows that the invalid
token did not authenticate; it is equally consistent with bare mode ignoring
`CLAUDE_CODE_OAUTH_TOKEN` and with bare mode reading and rejecting it, so it
does not by itself show which credential sources bare mode consults. The
retirement rests instead on the positive contract in the help text, the
upstream report, and the residual below. No real credential or paid request
was used.

That residual is already recorded in
[`packages/claude/README.md`](../packages/claude/README.md): a subscription
token presented through `apiKeyHelper` is treated as an API key and rejected.
The older [`endo-claude.md`](endo-claude.md) design left two gates open before
the subscription route could ship. The *entitlement* gate asked whether Claude
subscription terms permit pooling one plan across many concurrent guests
(§ Pooling subscriptions across concurrent guests). The *positive-canary* gate
required a live run in which a real subscription token presented through
`apiKeyHelper` authenticates. The documented mode contract means the canary
gate cannot pass, so the route is closed and the entitlement question no
longer needs an answer for it.

## Inventory and disposition

### Endo `llm`

| Surface | Evidence and consumers | Disposition |
|---|---|---|
| `@endo/claude` root harness and `endo-claude-turn` | `packages/claude/index.js`, `src/harness.js`, `src/confined-turn.js`, `src/launch.js`, `src/spawn-files.js`, and `bin/endo-claude-turn.js`; added as the confined CLI path in [#1371](https://github.com/endojs/endo-but-for-bots/pull/1371). On `llm`, only its own bin, tests, and documentation import the root surface. minion.town vendors this surface under `vendor/endo-claude/`. | **Remove after minion.town switches.** The CLI wrapper can be removed. Its one deployment consumer is minion.town's vendored copy; there is no other `llm` importer. |
| `@endo/claude` CLI backend | `packages/claude/src/cli-backend.js` and CLI-only confinement, argv, scratch, response-shape, and stream modules from [#1412](https://github.com/endojs/endo-but-for-bots/pull/1412). No package outside `@endo/claude` imports it. | **Remove.** It exists to run Claude Code, including the rejected subscription route. |
| `@endo/claude` Agent SDK backend | `packages/claude/src/sdk-backend.js`, also from #1412, accepts a `CredentialSource` environment and can carry an API key. It still drives a pinned Claude Code executable and shares CLI support modules. | **Keep provisionally, detached from the root CLI wrapper.** It remains a valid API-key `@endo/inference` plugin, but is not the new minion.town default and needs an API-key live canary. Decide in review whether it stays in a smaller `@endo/claude` or moves to a provider plugin package. |
| `@endo/inference` | `packages/inference/`: provider-neutral request/result guards, credential admission, limits, classification, prompt-origin gate, and usage recorder. | **Keep.** It is independent of subscription acquisition and is the seam the replacement provider broker should satisfy. |
| Claude/hosted confinement core | `packages/claude-sandbox/`, `packages/hosted-agent/`, and `packages/sandbox/` own slices, provider brokers, transcript/session lifecycle, and tool projections. | **Keep and retarget.** The generic slice, broker, limits, and transcript machinery serve API-key or other hosted backends. Delete only Claude-subscription setup, renewal, and CLI-native-controller pieces proven unused after the migration. |
| Guest stdio MCP | `packages/agent-mcp-stdio/`, introduced in [#1336](https://github.com/endojs/endo-but-for-bots/pull/1336) and confined in #1371. Its only code consumer is `@endo/claude`; `parseClaudeStreamJson`, broker, relay, and the `endo-mcp-stdio` bin all serve that CLI path. | **Deprecate, then remove with the CLI.** Preserve the transport-neutral MCP adapter in `packages/agent-tools/src/adapters/mcp.js`; HTTP gateway MCP and other adapters do not depend on the stdio package. |
| Lal and Fae | `packages/lal/` has direct provider adapters; `packages/fae/` composes them and already resolves `SecretBlob` credentials per turn. | **Keep and use.** These are the first two agent harnesses for the replacement. |
| Floot, Jaine, and Agentry | `packages/floot/` is a durable streaming/session harness; `packages/jaine/` is channel-oriented; `packages/agentry/` is shared harness substrate. `@endo/genie` was removed by `42bc7d5161`. | **Keep, not first launch choices.** Retarget shared provider/secret work so these can opt in later; do not advertise them in the first UI until their guest-power and wake-on-mail profiles are specified. |

### minion.town `main`

| Surface | Evidence | Disposition |
|---|---|---|
| Claude CLI provider | `src/endo/claude/cli-{deployment,launch,provider}.ts`, `credentials.ts`, `credential-vault.ts`, `src/auth/claude-account-endpoint.ts`, and `src/endo/claude/wiring.ts`; production wiring landed in [#148](https://github.com/kriscendobot/minion.town/pull/148) and was enabled by [#150](https://github.com/kriscendobot/minion.town/pull/150). | **Remove after cutover.** Stop accepting `claude setup-token` first; remove the endpoint, credential state, CLI launch/provider, and Claude-specific root tools last. |
| Vendored `@endo/claude` and harness image | `vendor/endo-claude/`, `tools/vendor-endo-claude.sh`, Dockerfile/deploy wiring, and `tools/claude-harness/`; signed manifest/tarball verification landed in [#122](https://github.com/kriscendobot/minion.town/pull/122). | **Remove with the CLI provider.** Security verification is correct but has no remaining artifact to verify. Retain the general signed-artifact pattern in history, not its live build stages. |
| Claude Code dependency bumps | `.github/dependabot.yml` watches `/tools/claude-harness`; package scripts run `claude-harness:*`. | **Remove after the harness directory.** No replacement dependency hook is required for a user-supplied API key. |
| Agent factory and delegations | `src/endo/claude/agents.ts`, `guards.ts`, `delegation-store.ts`, `mail-attach.ts`, and related tests, landed across [#120](https://github.com/kriscendobot/minion.town/pull/120) and [#140](https://github.com/kriscendobot/minion.town/pull/140). | **Retarget and rename.** Keep durable child names, revocable sub-factories, mail attachment, and teardown; replace the shared subscription context with a provider reference plus per-provider budgets. Existing subscription-spend delegations are revoked, not silently rebound. |
| Pinned mailbox responders | `inbox-responder-*`, `agent-proxy-caplet.ts`, and `inbox-watch.ts`, landed in [#165](https://github.com/kriscendobot/minion.town/pull/165). | **Keep and generalize.** This is the wake-on-message starting point. A responder is reattached to the chosen provider/harness and remains pinned in its guest's `@pins`. |
| Claude account UI | `/account/claude`, setup-token forms, root-only Claude tools, deployment flags, and their probes. | **Replace.** The UI becomes the provider-and-agent flow in the companion design. |
| OAuth/MCP guest gateway | `/mcp`, `/account`, guest web, and `src/endo/root-host-socket.ts`. | **Keep.** These are transport/admission paths, not the guest stdio MCP server. |

### Garden

The garden has three similarly named but separate concerns:

- `scripts/jobs/handlers/monk-claude.sh` runs ordinary Claude Code workers and
  may continue using the fleet's own subscription outside `--bare`.
- `scripts/jobs/minion-mcp-lib.sh` and its bridge let garden workers call the
  deployed minion.town **HTTP MCP** service. This is not
  `@endo/agent-mcp-stdio` and remains unchanged.
- `scripts/jobs/dependabot-migration.sh`, `dependabot-watcher.sh`, their tests,
  `roles/botanist/AGENT.md`, `designs/claude-harness-provisioning.md`, and the
  Claude-on-minion completion report know about the minion.town CLI harness.
  Retire or retarget these only after the corresponding minion.town files are
  gone. The generic MCP skills and production probes remain.

This correction removes the hoped-for subsidized inference source for confined
guest agents. It does not change how current garden workers obtain inference.
Whether the garden later uses user-funded API-key agents, keeps direct worker
subscriptions, or funds a separate provider is an explicit open question.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Browser -> minion.town app | Password input and two explicit POST operations | App admits the signed-in guest and fixed request sizes | No credential state in the browser or app logs | App commits only after daemon/provider creation succeeds | Secret bytes on provider creation; provider id and agent options thereafter |
| minion.town app -> Endo root | Root-host capability calls | Root decides which guest may create/use a provider | Endo secret manager and provider registry | Endo commits, retires, restarts, and replays | Object-designating provider/admin capabilities, not identity authority |
| Provider broker -> harness | Provider-neutral inference call | Broker enforces model, spend, rate, and concurrency limits | Usage ledger and secret generation | Broker admits/releases each call | Prompt, tool projection, tagged result; never secret bytes to the agent |
| Guest -> pinned responder | Endo mail subscription | Guest owner chooses wake-on-message and agent lifecycle | Guest formula, inbox cursor, effect/dedup records | Guest owner dismisses; daemon restarts/replays | One message and the guest's attenuated powers facet |

The daemon secret manager owns credential durability. The provider registry
owns active/retired provider state. The usage ledger owns usage and is its
single source of truth; the registry keeps no usage copy (companion
§ Ownership map). The agent factory owns agent creation, wake, and dismissal
operations. The user-held admin facet owns retirement; the broker owns per-call admit/discard. Endo owns restart and
formula replay. The harness classifies model execution; the broker decides what
that result permits next. Inner APIs use `inference`, `turn`, and `result`, not
outer lifecycle words such as `commit`, `replay`, or `rollback`.

## Independently shippable sequence

1. **Record the negative gate and freeze new subscription onboarding.** Add a
   `legacyClaudeSubscription` flag, default-on only for existing production,
   mark `/account/claude` and Claude-agent creation deprecated, and add the
   2.1.296 help/repro probe. Do not remove a running responder.
2. **Build the companion provider substrate behind
   `apiKeyGuestAgents`.** This is additive and ships dark. Keep the old path as
   rollback.
3. **Ship the two-step UI and Lal/Fae factories dark.** Exercise creation with
   a fake provider and browser tests; no production navigation points at it.
4. **Canary one API-key provider and two pinned agents.** Verify Lal and Fae
   independently, including restart, mail wake, cancellation, usage, and secret
   non-disclosure. Then expose the UI while retaining the legacy path.
5. **Stop new legacy creation.** Existing Claude children and delegations keep
   their names and stored mail but show `provider migration required`. The user
   attaches a selected API-key provider and harness; the migration creates a new
   driver behind the old pet name only after its responder is ready. A failed
   migration leaves the legacy record intact.
6. **Retire legacy authority.** Revoke subscription credentials and delegation
   grants, stop CLI processes, and remove the account/setup-token UI. Preserve
   audit records and unprocessed mail. Rollback can re-enable the legacy flag
   only before credential revocation.
7. **Delete minion.town CLI machinery.** Remove `src/endo/claude/cli-*`, the
   vendored package, harness image and dependency pin, Claude-specific probes,
   flags, and Dependabot entry. Keep generalized agents, delegation, responders,
   and the HTTP MCP gateway.
8. **Deprecate then delete Endo surfaces.** First mark the root CLI surface,
   CLI backend, bin, and `@endo/agent-mcp-stdio` deprecated for the duration of one `llm` pin interval.
   After minion.town pins past the migration and repository search shows no
   importers, delete them and their changesets/tests. Keep `@endo/inference`,
   the Agent SDK API-key plugin if review retains it, `@endo/agent-tools`' MCP
   adapter, the secret manager, and generic confinement.
9. **Retire garden-only maintenance.** Remove the Claude-harness Dependabot
   migration hook and obsolete completion-report selectors. Leave
   `monk-claude.sh`, `minion-mcp-lib.sh`, and MCP browser/login skills alone.

Each step is deployable alone. Steps 1-5 only add or gate behavior. Deletions
start after a successful production canary and a pin containing the replacement.

## Rollout, rollback, and probes

- Roll out flags in this order: substrate -> UI hidden -> canary allowlist ->
  all guests -> legacy creation off -> credential revocation -> deletion.
- Before revocation, rollback means hide the new UI and re-enable legacy
  creation. After revocation, rollback means restore the previous build for
  reading/migration only; it must not resurrect revoked subscription material.
- Replace `claude-harness:check`, image-start, setup-token, CLI-version,
  `subscription-busy`, and live `claude -p` probes with provider import,
  provider reuse, Lal/Fae fake-gateway, pinned-responder restart, usage-limit,
  and secret-canary probes.
- Keep HTTP MCP route/auth, guest isolation, and garden bridge canaries because
  those surfaces survive.
- A repository gate fails deletion while any non-test importer of the removed
  Endo exports, minion vendor path, harness manifest, or deploy variable remains.

## Open questions

1. **Agent SDK retention?** Should the API-key-compatible Agent SDK backend stay
   as the smaller `@endo/claude`, or move to a separately named provider plugin
   while `@endo/claude` is retired wholesale?
2. **Legacy migration window?** How long may existing Claude child names and
   unread mail remain parked before operators revoke the subscription and
   remove the CLI deployment?
3. **Existing delegations?** Is preserving their child topology and requiring
   each owner to select a provider sufficient, or must the UI offer a bulk
   provider attachment for a whole delegated subtree?
4. **Garden inference sourcing?** After the subsidized guest route is removed,
   should the garden keep direct worker subscriptions, obtain a separately
   budgeted API provider, or deliberately leave guest-backed fleet inference
   unavailable?
5. **Deprecation release boundary?** Is one minion.town Endo-pin interval enough
   before deleting `@endo/agent-mcp-stdio` and the CLI exports, or is a longer
   compatibility interval required?
