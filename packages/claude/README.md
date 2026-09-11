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
(measured on Claude Code **2.1.232**):

| Flag | What it closes |
| --- | --- |
| `--bare` | `CLAUDE.md`, hooks, LSP, plugin sync, auto-memory, keychain — and narrows Anthropic auth to `ANTHROPIC_API_KEY` / an `apiKeyHelper`. Does **not** close MCP auto-discovery or settings layers. |
| `--strict-mcp-config` | MCP auto-discovery (`.mcp.json`, `~/.claude/`). |
| `--setting-sources ""` | the discovered user/project/local `settings.json` layers. |
| `--tools ""` | the built-in tool set — deny **by construction**, so a future built-in is denied without a harness edit. |
| `--disable-slash-commands` | the `/skill-name` surface `--bare` leaves resolving and `--tools ""` cannot reach. |
| never `--resume` / `--continue` | both restore the full prior transcript across the confinement boundary. |

The harness **refuses to spawn** unless all five presence flags appear, `--tools`
and `--setting-sources` each carry exactly the empty string (a non-empty value
re-opens the surface — the `"alg":"none"` shape), and `claude --version` equals
the pinned version (an upgraded CLI may have changed the flag semantics the
confinement rests on).

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
  // ...rate-limited, bridge-down, facet-threw, nonzero-exit, parse-error, cancelled
}
```

`make` returns a **host-only, non-passable** provider: it resolves *any* formula
id against ambient powers, so it must never be handed to a guest — only the
per-guest `infer` exo it mints crosses to a guest. `infer` **throws** only for
grant/spawn-refusal errors (a bad formula id, an empty catalog, a version
mismatch, an out-of-set model); every per-call outcome — including admission
failure and cancellation — resolves to a hardened, passable tagged record and
never rejects.

## Two transports

- **Preferred (v1): a claude-spawned stdio adapter reaching a separate,
  harness-owned facet broker.** No listening port, no bearer on a wire; the
  broker holds the attenuated CapTP fd (never inherited into the claude tree) and
  the adapter reaches it over a harness-private channel. The
  [`endo-claude-shim`](./src/shim.js) `bin` is the **opt-in v1 stopgap** for this
  path (gated on `ENDO_CLAUDE_SHIM_OPT_IN=1`), to be deleted once the
  `@endo/agent-tools` MCP adapter lands.
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

- **The `@endo/agent-tools` MCP adapter** (today a declared stub) — the real
  facet-to-MCP projection. Until it lands, the opt-in stopgap shim covers the
  local path.
- **A live negative-and-positive confinement test** against a real `claude -p`:
  no built-in runs, no `/skill-name` resolves, no other MCP server is reachable,
  an unanchored `mcp__*` grants nothing — *and* the guest's tools do invoke, an
  anchored `mcp__endo__read*` glob is honored, a planted `settings.json` has no
  effect, and the pooled `apiKeyHelper` is the consumed credential. The DI unit
  tests cannot catch a wrong-flag gap; this is version-specific and re-run on any
  CLI bump.
- **The credential path under `--bare`**: whether a Max/Pro *subscription* can be
  presented through an `apiKeyHelper` at all (the load-bearing DD5 residual). The
  `@endo/claude-sandbox` `subscription` credential kind this build adds is the
  minting side; whether the value materialises as an `apiKeyHelper`-consumable
  secret is unverified.
- **The DD7 credential-attenuation residual**: the pooled credential lives
  *inside* the confinement boundary, and `0600` is the wrong adversary's defense.
  A harness-side egress proxy or per-guest credentials is the named resolution.
- **The entitlement question**: whether the subscription terms permit pooling one
  plan across a fleet of confined guests at all.
- **Managed (enterprise-policy) settings**: whether `--setting-sources ""` can
  suppress them is undocumented; keep `@endo/claude` hosts free of managed
  settings that grant tools until verified.
