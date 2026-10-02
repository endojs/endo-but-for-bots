# @endo/claude

Confined `claude -p` inference for an Endo guest, from a Claude **subscription**.

An Endo guest needs to *think*. `@endo/claude` gives it Claude as its inference
engine: a `claude -p` process running inside a hermetic sandbox whose **only**
capability surface is the Model Context Protocol projection of one specified
guest formula's granted facet, and nothing else. This is *"the guest thinks with
Claude,"* the inverse of the minion.town designs where an external Claude drives
a guest from outside — here the guest facet is the entire world the Claude
process can touch, and Claude is the thing that must be confined.

See [`designs/endo-claude.md`](../../designs/endo-claude.md) for the full design.

> **Status: first increment.** This package implements the dependency-injected
> **confinement core** with property tests (no live `claude`, no daemon). Several
> load-bearing pieces are named prerequisites, not yet built — see
> [Known gaps](#known-gaps-prerequisites). Treat it as a confinement contract and
> a tested harness spine, not a turn-key deployment.

## Why confinement takes a *combination* of flags

Naively, "run `claude -p` with `--allowedTools` naming the guest's tools" is
**not** a sandbox. The tool-permission flags do not suppress the parts of Claude
Code startup that load *before and outside* the tool-permission system:
`CLAUDE.md` memory, hooks, `settings.json` layers, and MCP auto-discovery.
Closing every surface takes a combination, asserted before **every** spawn
(designed against Claude Code **2.1.232**; the pin is **2.1.280**, re-checked
live as described under [Known gaps](#known-gaps-prerequisites)):

| Confinement mechanism | What it closes |
| --- | --- |
| `--bare` | `CLAUDE.md`, hooks, LSP, plugin sync, auto-memory, keychain — and narrows Anthropic auth to `ANTHROPIC_API_KEY` / an `apiKeyHelper`. Does **not** close MCP auto-discovery or settings layers. |
| `--strict-mcp-config` | MCP auto-discovery (`.mcp.json`, `~/.claude/`). |
| `--setting-sources ""` | the discovered user/project/local `settings.json` layers. |
| `--tools ""` | the built-in tool set — deny **by construction**, so a future built-in is denied without a harness edit. |
| `--disable-slash-commands` | the `/skill-name` surface `--bare` leaves resolving and `--tools ""` cannot reach. |
| `--permission-mode dontAsk` | sets the permission mode to `dontAsk`, which denies any tool not on the allow-list, so a tool that leaks past the other layers is refused. Without it, 2.1.280's `init` reports `permissionMode: "default"`. |
| `--permission-prompts none` | prompting: anything that would ask is denied (new in 2.1.280). |
| `enabledPlugins` in `--settings` | the builtin plugins `agents-md` and `telemetry`, which `init` lists even under `--bare`. |
| never `--resume` / `--continue` | both restore the full prior transcript across the confinement boundary. |

The harness **refuses to spawn** unless all six presence flags appear
(`--bare`, `--strict-mcp-config`, `--setting-sources`, `--settings`, `--tools`,
`--disable-slash-commands`), `--tools` and `--setting-sources` each carry exactly the empty string (a non-empty value
re-opens the surface — the `"alg":"none"` shape), `--permission-mode` and
`--permission-prompts` carry their pinned values, each of these four appears
exactly once (a later occurrence would override the pinned one), `--settings`
and `--mcp-config` each appear at most once (a later occurrence would
substitute another file), and
`claude --version` equals the pinned version (an upgraded CLI may have changed
the flag semantics the confinement rests on).

## The allow-list is generated, pruned, and pinned

`mcp__*` does **not** work as an allow-rule wildcard — it is silently skipped and
grants nothing. So the allow-list is generated per guest from that guest's actual
`tools/list` catalog. At grant time the harness takes **one** snapshot, prunes it
once (removing `__`-bearing, dunder/reserved, code-eval, and charset-violating
names) **before pinning**, and pins the pruned result as a `harden`ed
null-prototype record (never a `Map` — `harden(new Map())` freezes the object but
not the slots `set`/`delete` reach). Both the client-side `--allowedTools` list
and the server-side dispatch check derive from that one pinned value, so a
withheld or code-eval name is absent at the **boundary**, not merely omitted from
the belt. An empty post-prune catalog is a hard error, never a silent pass.

## Usage

```js
import { make } from '@endo/claude';

const provider = make(
  { connectBroker, pool }, // powers: resolve a formula id to a facet broker; the subscription pool
  context,                 // daemon cancellation context
  {
    pinnedModels: ['claude-opus-4-8', 'claude-sonnet-4-5'],
    getClaudeVersion,      // () => Promise<string>  — reads `claude --version`
    mintSessionTag,        // () => string           — UNIQUE per spawn
    prepareSpawnFiles,     // renders the 0600 per-spawn --settings / --mcp-config files
    launch,                // spawns claude, applies the three bounds, parses stream-json
  },
);

// Grant time (once per guest): validates the 64-hex id, resolves + pins the catalog.
const infer = await provider.makeGuestInference(guestFormulaId);

// Call time: the exo closes over one facet; `infer` carries NO designator.
const result = await infer.infer('summarise my inbox', { model: 'claude-opus-4-8', cancelled });
switch (result.type) {
  case 'ok': /* result.text, result.usage */ break;
  case 'pool-exhausted': /* transient — retry after result.retryAfterMs */ break;
  case 'limit-exceeded': /* result.which: wall-clock | output-bytes | max-turns */ break;
  // ...rate-limited, bridge-down, facet-threw, nonzero-exit, parse-error,
  // auth-failed, cancelled
}
```

`make` returns a **host-only, non-passable** provider: it resolves *any* formula
id against ambient powers, so it must never be handed to a guest — only the
per-guest `infer` exo it mints crosses to a guest. `infer` **throws** only for
grant/spawn-refusal errors (a bad formula id, an empty catalog, a version
mismatch, an out-of-set model); every per-call outcome — including admission
failure and cancellation — resolves to a hardened, passable tagged record and
never rejects.

## One confined turn

```js
import { runConfinedTurn } from '@endo/claude';

const result = await runConfinedTurn({
  formulaId,            // the guest's 64-hex formula number
  credential,           // presented through the apiKeyHelper only
  prompt,               // delivered on stdin
  model: 'claude-sonnet-4-5',
  claudePath: '/usr/local/bin/claude', // the pinned binary, or a sandbox wrapper
});
```

The `endo-claude-turn` bin does the same thing. It takes `--formula-id`,
`--model`, `--claude`, and `--credential-file`, reads the prompt from stdin,
and writes the tagged result as JSON.

`runConfinedTurn` opens the ordinary daemon client in the harness process and
starts `@endo/agent-mcp-stdio`'s `startGuestBroker` for the one guest. It then
runs `make(...)` with concrete seams: `makeSpawnFilesPreparer` writes the `0600`
`--mcp-config` / `--settings` / credential files, whose `apiKeyHelper` is
`/bin/cat` of the credential file, and `makeLaunch` spawns `claude` directly
with the constructed environment, the three bounds, and the process group. The
launch seam parses `--output-format stream-json --verbose` with
`parseClaudeStreamJson`. A turn succeeds only on exactly one terminal
`result`. A `result` from a background task does not count. A truncated or
malformed stream is a `parse-error`, or a `nonzero-exit` if the process failed.
`error_max_turns` maps to `limit-exceeded: max-turns`, and a rate-limit result
maps to `rate-limited`, with `retryAfterMs` taken from the last
`rate_limit_event`. Every exit path closes the broker, the daemon session, and
the files.

## Two transports

- **Preferred (v1): a claude-spawned stdio adapter reaching a separate,
  harness-owned facet broker.** No listening port, no bearer on a wire; the
  broker holds the attenuated CapTP fd (never inherited into the claude tree) and
  the adapter reaches it over a harness-private channel. The MCP projection has
  landed in `@endo/agent-tools`, with hosting seams in `@endo/agent-mcp-stdio`;
  the injected broker transport must keep its daemon connection outside the
  confined process tree.
- **Alternative (v2): a `127.0.0.1` loopback HTTP listener** carrying
  `Authorization: Bearer <64-hex formula id>`, one endpoint discriminated by
  bearer. Gated on the `@endo/sandbox` `network: private` egress profile landing.

## The boundary is the slice, not an env scrub

Scrubbing `ENDO_SOCK` is **defense-in-depth only**: `whereEndoSock` re-derives the
default socket path from an empty env, so unsetting the variable makes the path
the *default*, not absent. The structural boundary is the
[`@endo/claude-sandbox`](../claude-sandbox/README.md) slice's
filesystem-namespace isolation, which is **required** for any prompt a guest can
influence — and "influence" includes any facet-method result that returns
externally authored bytes, since that result re-enters the model's context. The
child is spawned with a constructed env allowlist (not inherited-minus-one), so
an inherited `ANTHROPIC_API_KEY` cannot silently bypass the pool.

## Known gaps (prerequisites)

This increment is honest about what it does **not** yet do:

- **Kernel-level confinement of the `claude` tree.** `runConfinedTurn` (below)
  builds the harness side of the confined shape: the daemon connection, its
  socket path, and the formula id stay in the harness, and the confined tree
  gets only a guest-pinned broker socket and an empty-environment relay. Making
  the daemon socket *structurally* unreachable is still the job of the
  `@endo/claude-sandbox` / `@endo/sandbox` slice that wraps `claudePath`. That
  slice must bind the broker and per-spawn directories and supply a scratch
  home, because the constructed environment carries no `HOME`.
- **Config through `/dev/fd`.** The design prefers a pipe- or `memfd`-backed
  `--mcp-config` path. The spawn files are `0600` files in a `0700` directory,
  removed on every exit path, until a live check shows that the pinned CLI reads
  `--settings` only once.
- **A scripted live negative-and-positive confinement test** against a real
  `claude -p`: no built-in runs, no `/skill-name` resolves, no other MCP server
  is reachable, an unanchored `mcp__*` grants nothing — *and* the guest's tools
  do invoke, an anchored `mcp__endo__read*` glob is honored, a planted
  `settings.json` has no effect, and the pooled `apiKeyHelper` is the consumed
  credential. The DI unit tests cannot catch a wrong-flag gap; this is
  version-specific and re-run on any CLI bump. The 2.1.280 pin rests on a
  manual re-run against a scratch daemon, which verified the `init` surface,
  the process environments and sockets, refusal of a smuggled id and a pruned
  tool, and the positive path. The evidence is in
  [#1406](https://github.com/endojs/endo-but-for-bots/pull/1406).
- **The written `settings.json` is not checked at spawn.** `assertConfinedArgv`
  checks the argv before every spawn, but nothing re-reads the generated
  `--settings` file to confirm `enabledPlugins` and the other keys.
- **The credential path under `--bare`** (the DD5 residual), answered by a
  live turn on Claude Code 2.1.280: a subscription OAuth access token
  (`sk-ant-oat...`) is **not** accepted through an `apiKeyHelper` (`claude`
  presents it as an API key and gets `401`). The spawn files therefore present
  such a token as `ANTHROPIC_AUTH_TOKEN` in the `--settings` file's `env` key,
  never in the spawn environment. `claude` still holds it in memory, the same
  DD7 residual as the helper path. A rejected credential stops the child after
  two `401`/`403` API retries with `auth-failed`, rather than retrying until
  the wall clock (endojs/endo-but-for-bots#1369 gap 11).
- **The DD7 credential-attenuation residual**: the pooled credential lives
  *inside* the confinement boundary, and `0600` is the wrong adversary's defense.
  A harness-side egress proxy or per-guest credentials is the named resolution.
- **The entitlement question**: whether the subscription terms permit pooling one
  plan across a fleet of confined guests at all.
- **Managed (enterprise-policy) settings**: whether `--setting-sources ""` can
  suppress them is undocumented; keep `@endo/claude` hosts free of managed
  settings that grant tools until verified.
