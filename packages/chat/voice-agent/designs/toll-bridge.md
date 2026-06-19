> **Archived verbatim** from the 2026-06-16 design pass (workflow `wf_ffc46d65-0f8`).
> The CURATED, current plan is `../SELF-IMPROVEMENT-ROADMAP.md` (incl. §6 self-tuning). This file is the
> original deep design detail — concrete API sketches — preserved on request; treat the roadmap as
> authoritative where they differ.

---

I have everything needed. The default Anthropic delegate model is `claude-opus-4-8` ($5/$25 per the skill). Here is the design doc.

---

# DESIGN: Prepaid Inference Toll-Bridge (Vision #1)

**Status:** design • **Author:** design:toll-bridge • **For:** Agent C maintainer + implementor
**One-liner:** Put a CapTP-purse-backed meter in front of every inference call so each chat has a finite ALLOWANCE; `createSubAgent` is funded by minting a *sub-purse* from the parent's purse, so recursion is bounded by money, not by a hardcoded depth wall. **That finite-purse drawdown IS the answer to the runaway-recursive-subagent problem** — an agent (or a storm of nested agents) can only spend what its purse holds; when it hits zero, inference refuses.

---

## 0. Architecture in one diagram

```
                          ┌──────────────────────────────────────────────┐
  per-chat Purse  ───────▶│  makeMeteredProvider({ purse, callLLM,        │
  (allowance handle)      │      runOpusDelegate, opusComplete, costModel})│
                          │   wraps ALL THREE inference paths:             │
                          │   • callLLM(messages, model)   gemma/openrouter│
                          │   • runOpusDelegate(...)        anthropic loop │
                          │   • opusComplete(...)           anthropic 1-shot│
                          └───────────────┬──────────────────────────────┘
                                          │ each call: quote → call → debit ACTUAL
                                          ▼
                          ┌──────────────────────────────────────────────┐
   meterAdapter (in-mem)  │  GatorAuthority.charge({amount, payee})       │
   payee = provider id    │   payee ∈ {gemma-tinix, openrouter:<slug>,    │
   (per-provider ledger)  │            anthropic:claude-opus-4-8}         │
                          └──────────────────────────────────────────────┘
        createSubAgent(prompt, powers, payment=parentPurse.mintSubPurse(n))
                          │  child's provider is bound to the SUB-purse
                          ▼  child spends ≤ n, parent's remaining drops by ≤ n
```

The **policy/settlement split** from `paid-capability.mjs:14-19` is preserved exactly: SES holds metering policy (the provider wrapper + cost model), the injected `meterAdapter` holds balances. No chain needed for v1; the real gator adapter (`paid-lease-real.mjs:20-27`) plugs into the identical contract later.

---

## 1. The provider-compatible object

Today there is **no provider object** — `callLLM` (`tool-bridge.mjs:64`) IS the provider, hard-wired to `fetch`, and `runOpusDelegate`/`opusComplete` (`delegate.mjs:44,102`) bypass it via the Anthropic API. The toll-bridge inverts this: a single object that wraps all three, debits a purse, and refuses when empty. New file: `packages/chat/voice-agent/meter.mjs`.

```js
// meter.mjs  (SES/Endo, harden() the export)
export const makeMeteredProvider = ({
  purse,                 // a Purse (§2) — the per-chat allowance handle
  callLLM,               // the existing tool-bridge callLLM (default impl)
  runOpusDelegate,       // delegate.mjs (default impl)
  opusComplete,          // delegate.mjs (default impl)
  costModel,             // §6 — ({ provider, model, usage }) -> bigint (micro-USD)
  onSpend = () => {},    // hook: feed budget readout + telemetry (§2 feed, §5)
}) => {
  // shared meter: quote (estimate from prompt) -> call -> debit ACTUAL post-call
  const meter = async ({ provider, model, run, estPromptTokens }) => {
    // (iv) REFUSE when empty: pre-flight on a cheap floor estimate.
    const est = costModel({ provider, model, usage: { in: estPromptTokens, out: 0 } });
    const remaining = await purse.balance();
    if (remaining <= 0n)
      throw harden(Error(`INFERENCE_BUDGET_EXHAUSTED: purse empty (model ${model})`));
    // We do NOT hard-block on est < remaining (completion tokens unknown up front);
    // we block only on truly-empty, then debit the MEASURED amount after the call.
    const { text, usage } = await run();                  // (ii) read real usage
    const amount = costModel({ provider, model, usage }); // (i) $/token lookup
    const receipt = await purse.debit(amount, provider);  // (iii) draw the purse
    onSpend({ provider, model, usage, amount, remaining: receipt.remaining });
    return { text, usage, amount, remaining: receipt.remaining };
  };

  return harden({
    // Same SHAPE as today's callLLM — returns the string — but metered.
    callLLM: async (messages, model = 'default') => {
      const provider = String(model).startsWith('openrouter:')
        ? String(model) : 'gemma-tinix';
      const { text } = await meter({
        provider, model,
        estPromptTokens: estimateTokens(messages),       // rough; only gates "empty"
        run: async () => callLLMWithUsage(callLLM, messages, model),
      });
      return text;
    },
    runOpusDelegate: async args =>
      meter({ provider: `anthropic:${args.model || 'claude-opus-4-8'}`,
              model: args.model || 'claude-opus-4-8',
              estPromptTokens: estimateTokens(args.messages || []),
              run: () => runOpusDelegateWithUsage(runOpusDelegate, args) }),
    opusComplete: async args =>
      meter({ provider: `anthropic:${args.model || 'claude-opus-4-8'}`,
              model: args.model || 'claude-opus-4-8',
              estPromptTokens: estimateTokens(args.messages || []),
              run: () => opusCompleteWithUsage(opusComplete, args) }),
    purse, // expose for the budget readout (§4) and sub-purse minting (§3)
  });
};
```

**The one genuinely missing extraction step (digest gap e):** the providers already return `usage` on the wire but the code discards it. To debit the *measured* amount, the three default impls must stop dropping `j.usage` / `data.usage`:

- `tool-bridge.mjs:80-81` (gemma) and `:74-75` (openrouter) — verified live to return `usage.{prompt,completion,total}_tokens`. **OpenRouter also returns spend** when you add `usage:{include:true}` to the body — prefer that as the authoritative cost when present, falling back to `costModel` only if absent.
- `delegate.mjs:69` / `:113` (Anthropic) — `data.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.

Minimal surgery: have each return `{ text, usage }` instead of just the content string (the `…WithUsage` shims above do this without touching the public callers if you keep a content-only default for backward compat). This is the **quote → call → charge-actual reconcile** the digest flags as new code — `makePaidCapability`'s deliver-then-charge ordering (`paid-capability.mjs:63-64`) is the precedent: charge after the work, with the real number.

---

## 2. The Purse / Allowance API

Reuse `makeGatorAuthority` (`paid-capability.mjs:26`) as the engine and clone the stub ledger adapter (`paid-capability-prove.mjs:18-34`) as the in-memory `meterAdapter`. The Purse is a thin, ERTP-flavored facade over a `GatorAuthority` so dan's "accepts CapTP purse currency" reads naturally and so `mintSubPurse` can enforce a *bounded* sub-allowance (digest gap d.3 — the heart of vision #3).

```js
// purse.mjs
export const makeMeterAdapter = () => {                 // clone of the stub ledger
  const allowances = new Map();                          // id -> { cap, spent }
  const ledger = new Map();                              // payee(provider) -> total
  let n = 0;
  return harden({
    grant: ({ cap }) => { const id = `al${(n += 1)}`; allowances.set(id, { cap, spent: 0n }); return id; },
    remaining: async id => { const a = allowances.get(id); return a.cap - a.spent; },
    charge: async (id, { amount, payee }) => {
      const a = allowances.get(id);
      if (a.spent + amount > a.cap) throw Error('OVER_ALLOWANCE'); // cap enforced HERE
      a.spent += amount;
      ledger.set(payee, (ledger.get(payee) || 0n) + amount);
      return { ref: `tx${a.spent}`, amount, payee };
    },
    paid: payee => ledger.get(payee) || 0n,              // per-PROVIDER cost tracking, free
    perProvider: () => Object.fromEntries(ledger),       // the whole ledger snapshot
  });
};

export const makePurse = ({ adapter, allowanceId, token = 'µUSD' }) => {
  const authority = makeGatorAuthority({ adapter, allowance: allowanceId, token });
  return harden({
    balance: () => authority.remaining(),                 // bigint µUSD
    describe: () => authority.describe(),                 // { token, remaining }
    debit: async (amount, payee) => {
      const r = await authority.charge({ amount, payee });
      return { ...r, remaining: await authority.remaining() };
    },
    // BOUNDED sub-allowance — monotonic attenuation ACROSS purses (new code, digest d.3):
    // child draws from the PARENT allowance but cannot exceed `amount`, even though
    // the parent still has headroom. Models Σ children ≤ parent by construction.
    mintSubPurse: async amount => {
      const have = await authority.remaining();
      if (amount > have) throw Error('SUBPURSE_EXCEEDS_PARENT'); // can't grant what you lack
      // A sub-purse is a SECOND allowance whose every charge ALSO debits the parent,
      // capped locally at `amount`. Compose GpuLease's used-counter idea over the parent.
      return makeBoundedSubPurse({ parent: authority, cap: amount, token });
    },
  });
};
```

`makeBoundedSubPurse` is the single new primitive (≈25 lines): a local `spent`/`cap` counter (the `makeGpuLease` `used`/`maxGens` pattern, `gpu-lease.mjs:65,71,98`) that on each `debit` (a) asserts `spent + amount ≤ cap` locally, then (b) charges the *parent* authority. (a) gives the child a budget it cannot exceed; (b) reserves against the parent so siblings can't double-spend the same dollars. This is exactly the ocap invariant — *a share re-shares only what it holds* — made true across allowances, which `addCommission` (sibling routing on one allowance) does **not** give you (digest b).

| Method | Returns | Use |
|---|---|---|
| `balance()` | `bigint` µUSD | in-context budget readout (§4); refuse-when-empty (§1) |
| `describe()` | `{token, remaining}` | UI / `/chat` response |
| `debit(amount, payee)` | `{ref, amount, payee, remaining}` | the post-call drawdown |
| `mintSubPurse(amount)` | child `Purse` | **prepaid `createSubAgent`** (§3) |
| (adapter) `perProvider()` | `{provider: total}` | per-provider cost panel + telemetry seed (§5) |

`token` is `'µUSD'` (micro-USD, integer) so amounts stay `bigint` end-to-end — no float drift, matches the existing `bigint amount` convention in `paid-capability.mjs`.

---

## 3. `createSubAgent(prompt, powers, payment)` — and why it bounds recursion

There is no method literally named `createSubAgent`; it maps onto the three existing spawn paths in `agent-caps.mjs`, all of which thread `(prompt/task, powers)` but **no payment** today:

| spawn path | signature today | add payment at |
|---|---|---|
| `delegateTask` (Opus) | `run: async ({ prompt, powers })` — `agent-caps.mjs:632` | `run: async ({ prompt, powers, payment })` → pass purse to `runOpusDelegate` (`:643`) |
| `employ(role,…)` | `run: async ({ role, task, powers, model })` — `:662` | add `payment` (`:663`) → flows to `runOpusDelegate` (`:693`) / `runAgent` (`:697`) |
| `spawnSpecialist` | persisted `spec` record — `:1021` | standing sub-purse on the `spec` object (`:1026`); each `askSpecialist` (`:1053`) draws it |

**Funding model (the subsidy pattern, `paid-capability.mjs:105`, proven `:68-80`):** the parent funds the child by minting a sub-purse and attaching it to the child node at mint time (`makeAgentNode`, `agent-caps.mjs:640/917/938/955/1015`) — the exact place powers and the c-list already live:

```js
// inside delegateTask.run, after computing granted powers (agent-caps.mjs:634)
const childPurse = payment            // explicit bounded slice the caller chose…
  || await ctx.purse.mintSubPurse(ctx.defaultSubBudget); // …or a default slice of the chat's purse
const childProvider = makeMeteredProvider({ purse: childPurse, ...providerDefaults });
const sub = makeAgentNode({ /* …granted, parent, */ provider: childProvider });
return runOpusDelegate({ prompt, toolbox: sub.toolbox(...), provider: childProvider, ... });
```

**This is the bsky fix, stated plainly.** The post describes *"models farting subagents everywhere"* → unbounded API cost. Three structural facts make that impossible here:

1. **Every sub-agent runs on a finite sub-purse.** Its inference (all three paths) goes through the metered provider bound to that purse. When `balance() <= 0`, the next `callLLM`/`runOpusDelegate`/`opusComplete` **throws `INFERENCE_BUDGET_EXHAUSTED`** (§1). The agent literally cannot spend money it doesn't have.
2. **Spawning a sub-sub-agent costs the spawner's own purse.** A child funds its grandchild only via `mintSubPurse`, which `throw`s `SUBPURSE_EXCEEDS_PARENT` if it tries to grant more than it holds. So `Σ` of the entire spawn *tree's* spend ≤ the root chat allowance. Depth and fan-out are both capped by one number: the chat's purse. A spawn storm drains the purse and then halts — it cannot escape into the operator's API bill.
3. **Kill-switch on top (GpuLease controller/inventory split, `gpu-lease.mjs:162-183`):** every purse is minted through a controller; dan's `inventory.revokeAll()` flips one revoked flag that `assertLive`-style checks read, stopping all in-flight inference under a chat instantly — the manual override for when budgeting isn't fast enough.

This converts the existing `META_POWERS` recursion wall (`agent-caps.mjs:442`, which blocks delegate/subagent/specialist one level deep) from a *hard* wall into a *budgeted* allowance: a sub-agent **can** now spawn if given a sub-purse, but only spends what it was funded — strictly better than a flat ban, and safe.

---

## 4. In-context budget readout

The model is shown its remaining budget + the per-token cost of its current model, in the system prompt. One `.filter(Boolean)` line in the `sys` array (`tool-bridge.mjs:144-161`), mirrored in the Opus `system` array (`delegate.mjs:48-53`). Both already receive `model`; thread `purse` (or a pre-read `{remaining, token}`) into `runAgent`/`runOpusDelegate`.

```js
// inside the sys[] assembly (tool-bridge.mjs ~:151, before 'Available tools:')
budget && `BUDGET: you have ${fmtUSD(budget.remaining)} ${budget.token} left for this chat. ` +
  `Your current model (${model}) costs ${fmtRate(costModel, model)} per 1K tokens ` +
  `(${fmtUSD(budget.lastTurnCost)} on your last turn). Spend it where it matters; ` +
  `delegating to a sub-agent draws from this same budget.`,
```

Because `sys` is built once per `runAgent` call, this is a per-turn snapshot — fresh each user turn. To refresh mid-loop (after each of the ≤12 steps, `tool-bridge.mjs:167`), re-inject as a synthetic `RESULT:`-style user message using the same mechanism at `:182`. (Hypothesis under test in vision #2: budget-awareness improves performance — the eval suite measures this directly.)

---

## 5. Per-chat allowance override + default-allowance setting

Rides the **exact** existing `model` path through the server.

| Touch | Change |
|---|---|
| `server.mjs:352` | destructure `allowance` from the `/chat` body (per-chat override) |
| `server.mjs:380` | resolve the chat's purse, build `makeMeteredProvider`, pass into `runAgent` |
| `server.mjs:365` | put `purse` into `node.toolbox({chatId, emit, app, purse})` ctx so `delegateTask`/`employ` read it (they already read `ctx`, injected at `agent-caps.mjs:621`) → sub-agent spawns inherit/fund from the chat allowance |
| `server.mjs:414` | add `{ usage, remaining, perProvider }` to the `/chat` response JSON so the UI renders spend/remaining |

**State** — follow the `mode:0o600` config-file idiom (`agent-caps.mjs:56/424/441`):

```jsonc
// ~/.config/field-agent/allowance.json
{ "defaultAllowance": 500000,          // µUSD = $0.50 per new chat (tunable)
  "perChat": { "<chatId>": 2000000 },  // overrides
  "balances": { "<chatId>": { "allowanceId": "al7", "spent": 12345 } } }
```

New endpoints alongside the existing app-state ones (`server.mjs:426` `/chats/load`):
- `GET /allowance` → `{ defaultAllowance, perChat }`
- `POST /allowance` → set `defaultAllowance` and/or a per-chat override
- per-chat balance lives on the per-chat record in the cap-keyed store (`chatStorePath(cap)`, `server.mjs:126`) so it's swissnum-scoped, not global.

**UI:** a settings field for default allowance; a per-chat allowance field (prefilled from default); a budget chip in the chat header reading `remaining` from the `/chat` response. **Do not rename** the load-bearing ids — `field-agent` agent id, the voice-agent dir/service, `field-agent-*` localStorage keys (constraint).

**Persistence note (digest gap):** the stub ledger and GpuLease maps are in-memory. The per-chat allowance needs durability across restarts — persist `{allowanceId, spent}` into the per-chat record on each debit (cheap; it's already JSON state). On boot, rehydrate the `meterAdapter` from those records.

---

## 6. Cost model table

New code (digest gap e — none of the existing files have a $/token model). `costModel({ provider, model, usage }) -> bigint µUSD`. Prices below are **per 1M tokens, USD**; multiply tokens by rate, scale to integer µUSD. Anthropic rates from the live model catalog; local gemma is on-box GPU = free; OpenRouter is pass-through at the slug's published rate (read the slug's price once and cache, or trust OpenRouter's returned `usage.cost` when `usage:{include:true}` is set — preferred, since it's authoritative and avoids a stale table).

| provider / payee | model id | $/1M in | $/1M out | source |
|---|---|---|---|---|
| `gemma-tinix` (local `LLM`, tinix:8003) | `default` / gemma | **$0.00** | **$0.00** | on-box GPU, no API meter — set `µUSD = 0` |
| `anthropic:claude-opus-4-8` (delegate default, `delegate.mjs:13`) | `claude-opus-4-8` | $5.00 | $25.00 | catalog |
| `anthropic:claude-opus-4-7` | `claude-opus-4-7` | $5.00 | $25.00 | catalog |
| `anthropic:claude-sonnet-4-6` | `claude-sonnet-4-6` | $3.00 | $15.00 | catalog |
| `anthropic:claude-haiku-4-5` | `claude-haiku-4-5` | $1.00 | $5.00 | catalog |
| `openrouter:<slug>` | e.g. `openrouter:google/gemini-2.5-pro` | per-slug | per-slug | **read from OpenRouter** (`usage.cost` or `/api/v1/models` price table) — do NOT hardcode; slugs/prices drift |

```js
// costModel.mjs — rates in µUSD per token (1 USD = 1e6 µUSD; per-token = $/1M)
const RATES = {                          // [in_µ_per_tok, out_µ_per_tok]
  'gemma-tinix':                 [0n, 0n],
  'anthropic:claude-opus-4-8':   [5n, 25n],
  'anthropic:claude-opus-4-7':   [5n, 25n],
  'anthropic:claude-sonnet-4-6': [3n, 15n],
  'anthropic:claude-haiku-4-5':  [1n, 5n],
};
export const makeCostModel = ({ openrouterPrice }) =>
  ({ provider, model, usage }) => {
    if (usage?.cost != null) return BigInt(Math.ceil(usage.cost * 1e6)); // OR authoritative
    const r = RATES[provider] || (provider.startsWith('openrouter:') ? openrouterPrice(provider) : [0n, 0n]);
    const inTok = BigInt(usage?.in ?? usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
    const outTok = BigInt(usage?.out ?? usage?.completion_tokens ?? usage?.output_tokens ?? 0);
    return inTok * r[0] + outTok * r[1];
  };
```

(Anthropic also bills cache read/write at ~0.1×/1.25× — fold `cache_read_input_tokens` and `cache_creation_input_tokens` in later if it matters; v1 can charge them at the input rate, slightly over-charging on cache reads, which is conservative/safe.)

---

## 7. Smallest first increment (Joshua test)

**Goal:** one real chat on the live `field-agent`, gemma-only, where the system prompt shows a remaining budget that *visibly decreases turn over turn*, computed from REAL token usage off the wire — proven with a real run, not a unit test.

Steps, in order:
1. **Stop dropping usage** in `callLLM` (gemma branch only, `tool-bridge.mjs:78-81`): return `{ text, usage }`. (gemma usage verified live to be present.)
2. **`makeMeterAdapter` + `makePurse`** (clone the stub ledger; ~40 lines) with a per-chat allowance from a hardcoded `defaultAllowance` (skip the config file for increment 1).
3. **`makeCostModel`** with gemma=0 plus a **fake non-zero gemma rate for the test only** (e.g. `[1n, 4n]`) so the budget actually moves on local inference — otherwise free gemma never decrements and the demo proves nothing. (Real gemma=0 ships in increment 2; the test rate is how you *measure* the mechanism cheaply without spending Anthropic money.)
4. **`makeMeteredProvider.callLLM`** wrapping the gemma path; thread it into `runAgent` at `server.mjs:380`.
5. **Budget line** in `sys[]` (§4) + `{remaining, usage}` in the `/chat` response (`server.mjs:414`).

**Measurable acceptance (real-run evidence):** open voice.chu / the field-agent chat, send 3 turns. Assert from the live `/chat` responses that `remaining` strictly decreases, equals `defaultAllowance − Σ costModel(real_usage)`, and that `perProvider['gemma-tinix']` sums to the spend. Then set the chat allowance to a tiny value and confirm the next turn returns `INFERENCE_BUDGET_EXHAUSTED` (the refuse path). That single run exercises (i)–(iv) of §1 + §4 + §5-response on the real Agent C. Sub-purse/`createSubAgent` funding (§3) and the cost table for paid providers come in increment 2, once the metering core is proven on free local inference.

This mirrors the canonical pattern (`archua-deploy` staging-system test): real service, real wire, real user scenario — not unit-green.

---

## 8. Open decisions for dan

1. **Allowance unit & default size.** µUSD proposed (integer, no float drift). What's the default-allowance for a new chat — $0.50? $5? And is the unit literally USD, or should it be agora **tix** (then the adapter's `charge` does `tixPurse.withdraw(amount)` — clean per the contract, but couples the toll-bridge to the agora economy now vs. later)?
2. **Default sub-agent budget split.** When `createSubAgent` is called *without* an explicit `payment`, what fraction of the parent purse does it get — fixed µUSD, a percentage, or **must** the caller always pass `payment` (no implicit funding, safest against runaway)?
3. **Empty-purse behavior: hard-refuse vs. degrade.** On `INFERENCE_BUDGET_EXHAUSTED`, throw (agent loop dies) — or auto-downgrade the model to gemma=free and continue (graceful, but defeats budgeting if free models are unlimited)? My default: hard-refuse, surfaced as a chat message + a dashboard "needs your input" to top up.
4. **Anthropic cache-token accounting.** Charge `cache_read`/`cache_creation` precisely (0.1×/1.25×) or approximate at input rate for v1?
5. **Concurrency.** Both `GatorAuthority.charge` and the GpuLease run are single-flight (`paid-capability.mjs:38`, `gpu-lease.mjs:89`). If you want parallel sub-agent inference under one purse, the mutex serializes them — accept serialized billing for v1, or redesign for concurrent charge accounting?
6. **OpenRouter pricing source.** Trust OpenRouter's returned `usage.cost` (authoritative, requires `usage:{include:true}` in the body — a one-line add at `tool-bridge.mjs:73`) vs. maintain a slug→price table (drifts)? Recommend the former.
7. **Persistence backend.** Per-chat balance in the cap-keyed chat store (swissnum-scoped, my recommendation) vs. the global `~/.config/field-agent/allowance.json` vs. an agora-backed ledger?