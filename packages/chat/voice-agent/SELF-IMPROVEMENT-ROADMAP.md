# Agent C — Self-Improvement Roadmap

Prepaid inference economy · self-improving eval suite · invitations/social-collateral · garden skills.

Origin: dan's vision (2026-06-16) triggered by the Bluesky post about recursive sub-agents
"farting subagents everywhere" → runaway API cost. The ocap answer: **a prepaid budget cap is
the credential — an agent can't spawn what it can't pay for.** Synthesized from a 10-agent
understand→design pass (workflow `wf_ffc46d65-0f8`), grounded in the existing fleet code.

Status: **decisions D1–D5 locked (2026-06-16); much of the spine now SHIPPED** (re-audited 2026-07-02).
Landed in code: Increments 0–1 (meter + bounded purse + visible budget), **Increment 2 eval spine**
(`eval/` — `harness`/`tree`/`score`/`aggregate`/`anonymize`), the **Increment 5 primitive**
`makeBoundedSubPurse` (`purse.mjs`, tested `purse-subpurse.test.mjs`), **Increment 7 invitations**
(`createInvite` wired into the toolbox in `agent-caps.mjs`; `invite-allowance.mjs`/`purse-store.mjs` —
NB shipped on the field's own purse substrate, not agora `makeBank`, which stays deferred to Inc 6 per
D1), and the **§6 self-tuning organs** (`eval/orchestration.mjs`, `eval/harvest.mjs`,
`eval/champions.mjs`). Next: real-rate metering (Inc 4) + prepaid `createSubAgent` end-to-end (Inc 5)
+ operational wiring of the §6/§7 loop. See the "Shipped" note after §2 and the flipped markers in §6/§7.

---

## 1. The spine

Two primitives carry all four visions; everything else is built on, or measured by, them.

**Primitive A — the metered seam** (`meter.mjs` + `costModel.mjs`). There is exactly one inference
chokepoint: `callLLM(messages, model)` (`tool-bridge.mjs:64`) plus the two Anthropic paths in
`delegate.mjs:44,102`. All three currently **discard `usage` off the wire** (`tool-bridge.mjs:80-81`,
`delegate.mjs:69,113`). The single highest-leverage change in the whole initiative: *stop dropping
usage, and put a meter at that seam.* That one change is the debit point for the toll-bridge (#1), the
cost/round recorder for the eval suite (#2), the per-query drawdown for invitations (#3), and the Δcost
signal for garden-skill A/B (#4). Build it once; everyone imports it.

**Primitive B — the bounded purse** (`purse.mjs` + `makeBoundedSubPurse`). A CapTP-purse facade whose
`mintSubPurse(amount)` enforces **monotonic attenuation across allowances** (`Σ children ≤ parent`, by
arithmetic). This is the exact fix for the bsky runaway-subagent problem: a spawn storm can only drain
its purse, then `INFERENCE_BUDGET_EXHAUSTED` halts it — it cannot escape into the operator's API bill.
The same primitive is the social-collateral edge (#3, a funded invite = a sub-purse drawn from the
inviter) and the `payment` arg for `createSubAgent` (#1 and #3).

**Dependency order:** the metered seam is the foundation. On top: #1 toll-bridge (purse, refuse,
in-context budget) and #2 eval suite (records cost/rounds at the *same* seam). #3 invites/collateral
share the purse primitive with #1 (#3 = #1's `mintSubPurse`, where the mint act is an invitation). #4
garden skills are the first *content* fed to the measurement organ — only worth importing once #2 can
tell us "did citing this skill beat not citing it?" **#2 is the validator for everything after it:** no
architecture change is promoted to deployed without a stable-across-repeats win on the suite.

> The spine in one sentence: **meter the one seam → wrap it in a bounded purse → that purse bounds
> recursion (the bsky fix) and funds invitations → and the eval suite, riding the same meter, is the
> gate that decides which of these (and which garden skills) we keep.**

---

## 2. Sequenced increments

Each ships independently and is provable on the **real running `field-agent`** (Joshua test), not unit-green.

| # | Increment | Size | Proves |
|---|---|---|---|
| **0** | **Stop dropping usage** (keystone one-liner) | ~½d | real gemma + Anthropic `usage` readable in-process |
| **1** | **Visible budget that decreases** (toll-bridge core, gemma-only) | ~2d | per-chat budget strictly decreases on free inference; tiny allowance → `INFERENCE_BUDGET_EXHAUSTED`. **The bsky fix, on real agent, zero Anthropic spend.** |
| **2** | **Eval spine**: one ported obstacle + one anonymized seed → written to the arch tree | ~3d | `eval --all --arch arch-0000 --repeats 3` writes the baseline node; maintainer reads pass-rate |
| **3** | **"How'd I do?"** rating + dashboard mirror | ~1d | a real rating lands in the feed; `consent_share` gates seed candidacy |
| **4** | **Real cost table** + Anthropic path metered | ~1d | a metered Opus delegate call debits correct µUSD off real `usage` |
| **5** | **Prepaid `createSubAgent`** (the recursion bound, with money) | ~3d | spawn tree on finite root purse: `Σ ≤ root`, over-grant throws, storm drains-then-halts |
| **6** | **Per-chat allowance override + default setting + persistence** | ~2d | allowance survives restart; per-chat override takes effect next turn |
| **7** | **Invitations = mint cap + fund sub-purse** (social-collateral spine) | ~4d | invite moves inviter balance by N, invitee draws own purse to 0 then refuses without touching dan's root; revoke kills + refunds |
| **8** | **Garden skills**: library + one cited skill + one A/B | ~2d | `employ('critic')` skill-OFF vs skill-ON → Δpass/Δcost recorded to the tree |

**Increment 0 detail** — `callLLM` (gemma + openrouter branches) returns `{text, usage}`;
`delegate.mjs` keeps `data.usage`; backward-compat via a `…WithUsage` shim. **Load-bearing:** audit
`delegate.mjs`/`opusComplete` for `temperature`/`top_p`/`top_k`/`budget_tokens` in the Anthropic body —
on `claude-opus-4-8` these **400**, so a metered call would throw before usage is read; switch to
`thinking:{type:"adaptive"}`.

**Increment 1 detail (THE first real, measurable, de-risking slice)** — `meter.mjs`
(`makeMeteredProvider`), `purse.mjs` (clone the `paid-capability-prove.mjs:18-34` stub ledger),
`costModel.mjs` (with a **fake non-zero gemma test rate** `[1n,4n]` so the budget visibly moves on free
local inference). Thread the metered `callLLM` into `runAgent` (`server.mjs:380`); add the `BUDGET:`
line to `sys[]` (`tool-bridge.mjs:~151`) and `{remaining, usage, perProvider}` to the `/chat` response
(`server.mjs:414`). Proof: 3 real turns on the live agent; `remaining` strictly decreases =
`defaultAllowance − Σ costModel(real_usage)`; tiny allowance → next turn refuses. Quote→call→debit→
refuse + in-context readout, end-to-end, spending **zero Anthropic money.**

### Shipped — Increments 0 + 1 (2026-06-16)

New files: `costModel.mjs` (µUSD rate table; gemma has a **fake `[1,4]` test rate** so the budget visibly
moves on free local inference — flip to `[0,0]` at Inc 4), `purse.mjs` (in-memory stub ledger; **balances
reset on restart** until Inc 6 → agora), `meter.mjs` (`makeMeteredLLM` refuses *before* the call when
empty → deterministic `exhausted`, no model spend). Edited: `tool-bridge.mjs` (`callLLM` → `{text,usage}`,
exported; `runAgent` takes an injectable metered `llm` + `budgetLine`), `delegate.mjs` (accumulates
`data.usage`), `server.mjs` (per-(cap,chat) purse; `/chat` returns `{remaining,allowance,spent,
perProvider}` or `{exhausted:true}`; `/budget`,`/budget/topup`,`/budget/set`,`/budget/default`[root-only]),
client (header 🪙 budget chip + deterministic **[Top up]/[Abandon]** exhaustion card — exhaustion is never
routed through the model, per D3). Default `$1.00`/chat (`DEFAULT_ALLOWANCE_UUSD`). **Proven** via real
`/chat`: `remaining = allowance − Σ real_usage`; zeroed allowance → `exhausted` with no model call; top-up
recovers. **Not yet real-money-gating** — gemma is free (fake rate) and the Opus delegate path isn't
metered into the purse yet; real-$ protection lands at Inc 4 (real rates) + Inc 5 (prepaid createSubAgent).

**After Inc 8** the continuous loop is live: Agent C monitors harness research (WebSearch/WebFetch +
FINDINGS history) → proposes an arch node → Blacksmith implements behind a flag + runs
`eval --all --repeats 5` → Agent C reads the tree → promote to root only on a stable-across-repeats win,
dan gates the deploy.

---

## 3. Reuse map

| Vision piece | Reuse | New code |
|---|---|---|
| #1 metered seam | `callLLM` `tool-bridge.mjs:64-82`; `delegate.mjs:44,69,102,113`; deliver-then-charge `paid-capability.mjs:63-64` | `meter.mjs`; `…WithUsage` shims; `costModel.mjs` (no $/token model exists yet) |
| #1 purse/refuse/in-ctx budget | `makeGatorAuthority` `paid-capability.mjs:26`; stub ledger `paid-capability-prove.mjs:18-34`; `sys[]` `tool-bridge.mjs:144-161`; `/chat` `server.mjs:352,380,414` | `purse.mjs`; `BUDGET:` line; `{remaining,usage,perProvider}` |
| #1/#3 bounded recursion | GpuLease `used`/`maxGens` + controller/inventory `gpu-lease.mjs:65,71,98,162-183`; subsidy `paid-capability.mjs:105`; spawn paths `agent-caps.mjs:632,662,1021` | `makeBoundedSubPurse` (the single new primitive); `payment` threaded through 3 spawn paths |
| #1 persistence/settings | `chatStorePath(cap)` `server.mjs:126`; 0o600 idiom `agent-caps.mjs:56/424/441` | `allowance.json`; `GET/POST /allowance`; per-chat rehydrate-on-boot |
| #2 harness/grader | `runAgent`+`toolboxFor`/`makeFieldAgent`/`agent-roles`; live in-vat caps (share/revoke); `aggregate.py` `dedupe_latest`+`summary` | `harness.mjs`, per-obstacle `grade.mjs`, `aggregate.mjs`, `tree.mjs` |
| #2 seeds/anonymize | `appStore.listChats`/`readChat`; `steps[]` trace; gemma `callLLM` | `anonymize.mjs` (gemma + **fail-closed** swissnum/`#cap`/64-hex scrub); root-only `/eval/seed-candidates` |
| #2 rating | `dashboard/feed.mjs` `FEED_FILE`; `nodeFor(cap)` | end-of-chat affordance; `POST /eval/rate`; `ratings/<chat-id>.json` sidecar |
| #2 tree viz | `pendant.js` / 3D trace renderer | `tree.mjs` read-only `eval` endowment |
| #3 ledger | agora `bank.js` (`enroll:207`, `balanceOf:245`, `withdraw` throws `:78`, escrow `:161-198`); `economy.load` replay | in-server bank wiring; `CollateralEdge` join record |
| #3 invite/default-bundle/UI | `node.share/revoke/listShares` `agent-caps.mjs:962-995`; `describe().canMint`; `POWERS` home/reference/delegate/roles; intersection rule `:680`; proposal+🔔 bell | `createInvite`/`topUpEdge` behind an `invite` power; "Invite a person" UI; copy/QR hand-off |
| #4 skills | in-repo SKILL.md convention (`.claude/skills/...`); `roleList()`/`localModelFor` `agent-roles.mjs:225,206`; read verbs; `employ` spawn `:683` | `skills.mjs` (`skillList`/`skillText`); `readSkill` verb; `skills:[...]` on roles; vendored ~12 garden skills |
| #4 measurement | the entire #2 suite + tree + meter | arm-A/arm-B runner producing per-skill Δ nodes |

---

## 4. Risks / sharp edges

1. **Anthropic request-surface 400s break metering silently.** On `claude-opus-4-8`,
   `temperature`/`top_p`/`top_k` and `thinking:{type:"enabled",budget_tokens}` all 400. If
   `delegate.mjs` sends any, the metered call throws *before* usage is read → looks like a meter bug, is
   a request-shape bug. Fix in Inc 0; use adaptive thinking. Also keep `RATES` covering `fable-5`
   (`[10n,50n]`) and `opus-4-6` (`[5n,25n]`) or those expensive calls bill as free via the `[0n,0n]`
   fallthrough.
2. **Token-cost accuracy is approximate; cache tokens are the wrinkle.** Gemma is on-box and free, so
   real-money exposure is only Anthropic/OpenRouter. Cache reads bill ~0.1×, writes ~1.25×/2× input. v1
   "charge cache at input rate" is safe (only over-bills); refine `cache_read_input_tokens` at 0.1×
   later. For OpenRouter prefer authoritative `usage.cost` over a slug table.
3. **Anonymization fidelity = security-critical.** A seed is committed to git; one missed
   swissnum/`#cap`/64-hex is a permanent cap leak. gemma is a fallible scrubber → the **deterministic
   post-scan is the gate and must fail-closed.** Treat `anonymize.mjs` as confined (read-only snapshot +
   gemma, nothing else).
4. **Collateral abuse / griefing.** A funded invitee can burn the inviter's escrow fast or fan out
   sub-edges. The design makes it *visible* (hot subtree in the delegation graph) and *bounded* (escrow
   up front; `Σ children ≤ parent`) but doesn't prevent waste. Keep `invite` root-only in v1; exhaustion
   = hard refuse + top-up proposal (human gate), never silent fall-back; revoke = kill-switch + refund.
5. **Recursion/budget under concurrency.** `GatorAuthority.charge` and the GpuLease run are
   single-flight; parallel sub-agents under one purse serialize on the mutex (correct billing, capped
   concurrency). A sub-purse that debits parent *and* a local counter has two writes that must stay
   consistent. Make local-cap-then-parent-charge atomic (assert-then-charge, parent last); Inc 5's
   Joshua test must include a spawn-storm-to-zero asserting `Σ ≤ root`.
6. **Persistence vs. in-memory ledgers.** Stub ledger + GpuLease maps are in-memory; a restart resets
   balances → a bounce silently refills every chat's allowance, defeating the bound. Treat per-chat
   persistence (Inc 6) as **required before the toll-bridge is trusted in production**, not polish.

---

## 5. Decisions for dan

Each has a recommendation; only **D1–D3, D5** gate the near-term increments. D4/D6 can be confirmed when
we reach Inc 7 / Inc 2.

**D1 — Purse substrate:** `paid-capability` stub ledger vs. agora `makeBank` vs. both.
*Rec: one substrate, agora `makeBank`, staged* — stub for Inc 1 (fastest path to visible-budget proof),
migrate to agora `bank.js` at Inc 6 (conserved, journaled, restart-safe; the journal *is* the collateral
draw history). Don't maintain two ledgers.

**D2 — First increment:** toll-bridge visible-budget (Inc 1) vs. eval spine (Inc 2).
*Rec: toll-bridge first, eval immediately after* — Inc 1 is the literal answer to the trigger, provable
on free gemma with zero Anthropic spend; Inc 2 needs only the Inc-0 one-liner and then becomes the gate
for Inc 3+.

**D3 — Enforcement on exhaustion:** hard-refuse. **DECIDED (dan, 2026-06-16):** hard-refuse, and the
exhaustion is handled **deterministically with NO model call** — the server checks the purse *before*
inference; if it can't afford the turn it returns a structured `{ok:false, reason:'allowance_exhausted',
remaining, needed}` and the **client** renders a static card offering **[Top up] / [Abandon thread]**.
The agent is NOT asked to explain being out of budget — routing the exhaustion through the model would
spend inference to announce that inference is exhausted, defeating the purpose. Top-up is a human action
on a deterministic UI, not an agent proposal.

**D4 — Who may invite:** root-only vs. one-level vs. anyone-with-a-purse.
*Rec: root-only in v1*, open to one-level once Inc 5's bounded sub-purse is proven; deeper only by a
deploy decision. Arithmetic makes depth safe; the trust implications are a policy call.

**D5 — Rails:** on-chain (x402/ERC-7710 via `paid-lease-real.mjs`, per `TODO/12`) now vs. pure-Endo `tix`.
*Rec: pure-Endo `tix` now, indefinitely for internal use; on-chain only when a real cross-trust paid
edge appears.* The `makeGatorAuthority`/`charge({amount,payee})` contract is identical whether the
adapter is the agora bank or the real gator adapter — a backend swap behind one interface, deferrable at
zero architectural cost (and the gator adapter is still blocked on testnet creds).

**D6 — Architecture identity in the eval tree:** config-digest vs. git commit.
*Rec: `config_digest` (sha256 of harness knobs) as node id, `commit` as optional provenance* — one commit
can host several candidate configs and a flag-gated A/B lives at one commit; git-commit-as-id can't
express either. (`--repeats 5` for the promotion gate, `--repeats 3` routine.)

---

## 6 — Self-tuning orchestration (extends #2; dan, 2026-06-16)

The eval suite isn't just a gate for hand-authored changes — it's the **fitness function for a
continuously self-tuning harness**. Four moving parts, on top of EXISTING substrate (the
`role-test-refine` skill + `repl-harness/.../role-tests/<role>/*.json` + `run-role-tests.py`, which
already does per-role, per-model grading; and `agent-roles.mjs`'s "role = config" catalog):

**6a — Role ↔ powers is explicit (and many-to-many).** A role IS a named **power-ring** (+ prompt,
model tier, context policy, I/O contract). A tool/skill belongs to **many roles by many names**
(judge→critic, SAST→securityAudit). So the harness has a *configuration space*, not a fixed shape:
(i) which **roles** an agent may delegate to, (ii) which **tool-ring** each agent holds, (iii) which
**prompt variant** each role uses. These are parameters, and the right values are empirical.

**6b — Prompt harvest → experiments (grow the suite from real usage).** A pipeline that continuously
scrapes new note/chat prompts (capture stream + chat store), detects **novel** ones (not yet covered),
**anonymizes** them (gemma + fail-closed swissnum/#cap/64-hex scrub — same discipline as #2's seeds),
and adds each as (i) a reference test and (ii) an **experiment** (ocap-obstacle-course sense: a tracked
config+hypothesis run). The benchmark grows toward what we're actually asked to do — or we just **fuzz**
the orchestration to probe it.

**6c — Orchestration search.** Treat 6a's config space as a search problem: vary {roles-available,
tool-rings, prompt-variants}, run against the growing suite, keep what raises pass-probability at least
cost (the toll-bridge #1 supplies the cost axis). Extends `role-test-refine` from
tune-one-role-by-hand to search-the-whole-shape.

**6d — Per-model champion ("fairest of them all").** The best harness for gemma ≠ the best for Opus. So
**per model**, record the best (agent-graph + prompt-variant); the build pipeline re-runs the suite
against each model's reigning champion **and** challengers, and adopts a new champion when one wins. The
live harness then **shapes itself to whatever model a chat selects** (composes with `swap-model` + the
model menu). The arch tree (#2) becomes per-model lineages, each with a current champion in a
`champions.json` (model → {bestConfig, score, lineage}).

**Reuse, don't rebuild:** `role-test-refine` + `repl-harness` role-tests + `run-role-tests.py`;
`agent-roles.mjs`; the #2 harness/tree; the #1 meter (cost). **New:** the harvest/novelty/anonymize
pipeline, the config-space search runner, and the per-model `champions.json`.

> **SHIPPED (2026-07-02):** the three "New" organs above now exist in `eval/`:
> `harvest.mjs` (§6b — scan chat store + capture inbox, novelty-filter, anonymize → candidates),
> `orchestration.mjs` + `score.mjs` (§6a/§6c — the orchestration-config search space + its inner
> scoring step), and `champions.mjs` (§6d — the per-model champion store). What remains is *operational*
> wiring (a timer/heartbeat to run the search continuously — see §7 E2) and auto-adoption policy (below,
> still human/eval-gated).

**Open question (dan):** how aggressive is auto-adoption? Default rec — the search + harvest run
continuously and **propose** champions; **promotion to the live default stays eval-gated + human-gated**
(stable-across-repeats win, no cost regression), never silent.

---

## 7 — Self-hosting: Agent C drives its own improvement (dan, 2026-06-16)

The capstone: hand Agent C the roadmap, say *"continue"*, and it spawns capable, branch-isolated dev
sub-agents that fill in components in parallel — visible live in the chat's trace — and sets its own
recurring timers to pull Garden, research agentic flows, and run the variation→eval→champion (genetic)
loop, all from inside Agent C. **Today this can't run**: the work is being done from **Claude Code** (a
host-level capable agent); Agent C (gemma + the *confined* Blacksmith) can't yet. The gap is these
enabling capabilities:

**E1 — Host-level, capable, traced, branch-isolated dev-spawner power (the crux).** Agent C's only code
path is the bwrap `claude -p` **Blacksmith**, which (a) can't do host-coupled work (it can't even import
`agent-caps.mjs` — host-absolute paths) and (b) is an opaque black box. Need a `buildComponent(spec)`
power that spawns a capable (Opus) coder in a **git worktree on its own branch**, host-level enough to
import the cap model + run the eval (Inc 2, SHIPPED), **streaming every step into the chat trace**
(`/chat/steps`), opening a **PR** (never merging — human/eval gate), and **budgeted** by the toll-bridge
purse. Essentially Agent C spawning Claude-Code-like dev agents, traced. **Dial RESOLVED (dan):**
worktree-only floor = no prompt; powers flow from the parent (attenuated); granting an *auto-approved*
write/web tool is a user-approval **endowment moment** (memory `endowment-moment-approval`;
`designs/dev-spawner.md`). **SHIPPED (2026-07-02):** the worktree-isolated, bwrap-confined dev-spawner
substrate is in code — `self-improver.mjs`, `component-git.mjs`, `render-check.mjs`, with
`worktree.test.mjs` + `bwrap-confinement.test.mjs` (bwrap confinement proven — see
`designs/worktree-isolation.md`). Remaining: full trace-streaming polish (E6) + the timer heartbeat (E2).

**E2 — Timers that fire an AGENT TURN** (not just a notification). `timers` is notify-only today
(`{type:command}` deliberately unexposed). Extend `timer-runner` to POST a chat turn so Agent C has a
heartbeat: periodically pull Garden (§6b/#4), research agentic flows (web/browser), run the loop (§6c/d).

**E3 — The variation→eval→champion (genetic) loop runners** (§6c/d). Mutate arch configs
(roles/tool-rings/prompt-variants) → score on the suite → select + record per-model champions. The
"genetic evolution." **SHIPPED (2026-07-02):** `eval/orchestration.mjs` (search space) + `eval/score.mjs`
(inner scoring step) + `eval/champions.mjs` (per-model champion store) are in code. Remaining: the
periodic *driver* that runs the loop (needs E2's timer heartbeat) and the auto-adoption policy.

**E4 — Garden pull + agentic-flows research** (§6b, #4). The harvest/import pipeline + a periodic
research-and-propose-variations step. **SHIPPED (2026-07-02):** the harvest/novelty/anonymize pipeline
is `eval/harvest.mjs` + `eval/anonymize.mjs`. Remaining: the periodic research-and-propose step (also
gated on E2's heartbeat).

**E5 — Toll-bridge Inc 4/5** (real rates + prepaid `createSubAgent`). Required so the autonomous dev/eval
fan-out is **budget-bounded** — you can't put it on a timer without the purse binding it.

**E6 — Trace as the primary surface (UI).** Full-width trace + a persistent trace **above each agent
response** (not only the live pendant under the latest prompt), so a parallel fan-out of dev sub-agents
on branches is viewable right there.

**Safety frame (non-negotiable):** autonomous, timer-driven, host-level self-modification is real blast
radius. Safe only behind: **budget caps** (E5), **branch+PR isolation with no auto-merge** (human gate),
the **eval gate** (adopt only stable-across-repeats wins — §2/§6), and **full observability** (E6).
Promotion to the live default is always human/eval-gated, never silent.

**Sequence:** E6 (visible, cheap) → E1 (the crux, behind a budget + your sign-off on its host-access
bounds) → E5 (budget) → E2 (heartbeat) → E3/E4 (loop content). After E1+E2+E5, "tell Agent C to
continue" works. (Inc 2 eval spine is SHIPPED — `eval/`; it's the fitness function E3 needs.)
