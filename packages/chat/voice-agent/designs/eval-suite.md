> **Archived verbatim** from the 2026-06-16 design pass (workflow `wf_ffc46d65-0f8`).
> The CURATED, current plan is `../SELF-IMPROVEMENT-ROADMAP.md` (incl. §6 self-tuning). This file is the
> original deep design detail — concrete API sketches — preserved on request; treat the roadmap as
> authoritative where they differ.
>
> **SPINE BUILT (2026-07-02).** The eval harness described here is in the tree at `../eval/`:
> `harness.mjs`, `eval.mjs` (CLI), `tree.mjs`, `aggregate.mjs`, `anonymize.mjs` (+ `anonymize.test.mjs`),
> `score.mjs`, plus `obstacles/`, `candidates/`, and `results/`. The §6 self-tuning organs also landed —
> `harvest.mjs` (§6b), `orchestration.mjs` (§6c), `champions.mjs` (§6d). Naming diverged slightly from
> the sketch (the price table lives in the top-level `costModel.mjs` rather than an `eval/prices.mjs`;
> scoring is `score.mjs`). What remains is the *operational* loop driver (a timer/heartbeat to run
> propose→implement→eval→adopt continuously) and its human/eval-gated adoption policy — see the roadmap
> §7 E2/E3.

---

# design:eval-suite — Moving the eval harness into Agent C's repo (vision #2)

The eval suite is the **measurement organ** for the whole self-improvement initiative. It must run Agent C's *real* loop (`runAgent` driving `toolboxFor(powers)`), meter at the *same seam* the toll-bridge meters (`callLLM`), and emit data shaped like the architecture tree the maintainer agent reads. It is the test rig dan's "Test like Joshua" maxim demands: real loop, real caps, real git repo — not a foreign-runtime comparison.

## 0. North-star one-liner

> A JS-native eval harness, living **inside** the voice-agent package, that runs Agent C's own agent loop against (a) ported ocap obstacles and (b) anonymized past-chat seeds, scores each run with the **same metric record** the Python harness uses, tags every run with the **architecture** that produced it, and writes the scores into a **parented architecture tree** the maintainer agent reads to decide whether a proposed change wins.

---

## 1. WHERE it lives, and PORT vs SHELL-OUT

**Recommendation: PORT to JS. Do NOT shell out to the Python harness.** Confirmed against the digest and the live files.

**Proposed path:** `/home/dan/endo-bfb/packages/chat/voice-agent/eval/`

```
voice-agent/eval/
  obstacles/                 # ported, JS-native obstacles (NN-name/)
    07-capability-attenuation/{SPEC.md, grade.mjs, solution/, traps/}
    16-fs-attenuate/...
    seed-<hash>/{SPEC.md, grade.mjs, expected.json}   # conversation seeds (§2)
  harness.mjs                # runAgent driver (the in-vat equivalent of harness.py)
  meter.mjs                  # the shared cost/usage meter (also used by toll-bridge #1)
  prices.mjs                 # per-(provider,model) price table
  aggregate.mjs              # dedupe-latest + per-endpoint/arch rollup (port of aggregate.py)
  tree.mjs                   # architecture-tree read/write API (§4)
  anonymize.mjs              # gemma-pass PII stripper for chat seeds (§2)
  results/
    cells/<arch-id>/<obstacle>.json     # write-immediately resume cache
    suite-runs/<run-id>.json            # one per `eval --all`
    architectures/<arch-id>.json        # one per architecture node (tree)
    ratings/<chat-id>.json              # "How'd I do?" sidecar (§3)
  eval.mjs                   # CLI: `node eval.mjs --all --arch <id>`  (--resume/--fresh/--retry-failed)
  EVAL-DESIGN.md             # this doc, committed
```

**Why in `voice-agent/` and not a new top-level package:** the harness must `import` `runAgent` from `tool-bridge.mjs`, `makeFieldAgent`/`toolboxFor` from `agent-caps.mjs`, and the role catalog from `agent-roles.mjs`. Those are the unit under test. Co-location keeps the grader holding a **live reference** to the agent's caps (assert that an attenuated handle's `put` *actually throws*, that a revoked cap is *actually dead*) — strictly more capable than `grade-endo.sh` grepping stderr for "error". Don't make it a sibling package that has to reach across a workspace boundary into a service dir.

**Why NOT shell out to Python:** the Python harness's entire spine — `runtimes/<rt>.py` adapters, endo-CLI staging, the ocap-kernel/spritely/endo *cross-runtime* comparison, the `grade-endo.sh` daemon dance — exists to compare **foreign ocap runtimes**. Agent C needs none of it. Shelling out imports the endo+ocap-kernel+spritely submodule surface for zero benefit, and — fatally — a subprocess **cannot see the `callLLM` meter** (item #1's seam). The eval harness and the toll-bridge must share one meter; only an in-vat JS port can.

**What we PORT verbatim (keep field names identical so old data + cross-checks line up):**

1. **The metric record** — `{ obstacle, runtime, endpoint, model, provider, rounds, input_tokens, output_tokens, cost_usd, wall_time_s, passed, note }`. `runtime` is always `"agent-c"` for us (the column survives so `aggregate.mjs` is a straight port). `note` (not `grader_output`) — `.get`-tolerant either way.
2. **The cell-cache resume model** — `results/cells/<arch-id>/<obstacle>.json`, write-immediately; `--resume` skips PASSED, `--retry-failed` re-runs failures, `--fresh` wipes the arch's cells. Most operationally valuable behavior: long suites crash; never re-burn tokens.
3. **`aggregate.py`'s `dedupe_latest` + `summary`** — ~90 lines, direct port to `aggregate.mjs`. Recency = lexical max of run-id filename (`run-<unixtime>`); per-endpoint rollup of pass/total, tokens, cost, time. Extend the key with `arch-id` (we dedupe per `(obstacle, arch, endpoint)`, not `(obstacle, runtime, endpoint)`).

**What we do NOT port:** `runtimes/*.py`, the endo-env staging scripts, `grade-endo.sh`/`grade-spritely.sh`/`grade-ocap-kernel.test.ts`, the multi-role subprocess grader boundary. Agent C's grader is in-process.

**Obstacle seeding (one-time):** copy the runtime-agnostic obstacles whose `theme:` includes `ocap` or `fs-nav` and rewrite their `grade.py` → `grade.mjs` against the in-vat agent. Start with the ones the digest flagged as richest for our security story: `07-capability-attenuation` and `16-fs-attenuate` (attenuation is the exact invariant Agent C's `share`/`revoke`/META_POWERS model must uphold). The bash grader's inline attenuation assertion (`makeReadOnly().put()` must throw) — which the generic `grade.py` punts on — we *can* and *should* express directly in `grade.mjs` because there's no cross-language boundary.

---

## 2. Conversation-seeded prompts (the "AI-anonymized" step)

**Source.** Agent C chats are stored server-side, cap-keyed, at `chatStorePath(cap)` and surfaced via `appStore.listChats(cap)`/`readChat(cap, id)` (`server.mjs:364, 426`). The transcript the agent ran on is the client's `history` (`server.mjs:369`); the per-turn tool trace (`steps[]`, `server.mjs:402`) is persisted with each chat. So a "past chat" already carries: opening user turn(s), the tool calls made, and — once #1 lands — the per-turn usage.

**Pull.** A new root-only endpoint `POST /eval/seed-candidates` (alongside `/chats/load`, gated by `nodeFor(cap)?.isRoot` exactly like `boundApp` at `server.mjs:364`) lists chats eligible to become seeds: low "How'd I do?" rating (§3), or `consent_share:true`, or operator-flagged. The maintainer (Agent C / Blacksmith) calls it; raw chats never leave the root cap's reach.

**Anonymize (`anonymize.mjs`).** A gemma pass on tinix:8003 (the same multimodal model proven for local OCR, per memory) rewrites the opening user turn(s) into a runtime-agnostic goal, stripping: names, emails, file paths, petnames, contact data, vault contents. **Hard rule, enforced post-pass:** a regex/scan rejects any `#cap`, swissnum, or 64-hex-looking token before the SPEC is written (stack-wide "never render a cap"; `SPEC.md` is committed to git). If the scrubber finds one, the candidate is **dropped, not committed** — fail closed. Anonymization is itself confined: `anonymize.mjs` gets a read-only chat snapshot + the gemma `callLLM`, nothing else.

**The eval case.** Mirror the obstacle format with a seeded theme:

```
obstacles/seed-<hash>/
  SPEC.md      # frontmatter: theme:[seeded], source_chat:<opaque-id>, captured:<date>, anonymized:true
               # body: the scrubbed user goal
  grade.mjs    # export const grade = async ({ agent, transcript, meter }) => ({ ...bool dict })
  expected.json # OPTIONAL rubric: required_powers, forbidden_caps,
                #   max_subagents, target_rounds, cost_band, judge_goal
```

**Grading a seed is hybrid** (a seed goal is fuzzier than a unit obstacle):
- **Deterministic structural check** (cheap, no LLM): did the run call the required power? stay within `max_subagents`? respect attenuation (no cap used outside the granted set)? land in the `cost_band` (read from `meter`)? These are the named bool sub-tests — same contract as the Python grader's `{functional, restart_continuity}` dict.
- **LLM-judge** on transcript-vs-goal — same pattern as the dietician judge (which reproduces its verdicts, per memory). Judge call goes through the **metered** `callLLM`/`opusComplete` so the judge's own cost is accounted.

This is the live-usage→suite bridge: a low-rated chat (§3) becomes a candidate seed, so the suite grows from real failures, not only hand-written SPECs.

---

## 3. "How'd I do?" end-of-chat rating

**UI hook.** A small end-of-chat affordance in the chat client (thumbs / 1–5 + optional comment), rendered alongside the existing 🔔 feed + inline-feedback machinery. It posts once per chat; it does **not** append a turn (must never mutate the conversation).

**Endpoint.** `POST /eval/rate` next to `/chats/load` (`server.mjs:426`), gated by `nodeFor(cap)`. Body: `{ cap, chatId, score, comment, consentShare }`.

**Storage — a sidecar, never the transcript.** Follow the `0o600` per-config-file pattern (`agent-caps.mjs:56/424/441`):

```jsonc
// eval/results/ratings/<chat-id>.json   (chat-id = the load-bearing field-agent chat id — DO NOT rename)
{
  "chat_id": "<opaque>", "rated_at": "2026-06-16T...",
  "score": 4, "comment": "nailed it, didn't waste a subagent",
  "model": "<from the chat's last callLLM>",        // pulled from the meter (§1)
  "architecture": "arch-0007",                       // current harness tag (§4)
  "rounds": 7, "cost_usd": 0.04,                     // from the meter for that chat
  "consent_share": false                              // gates seed/usage-data contribution (§2)
}
```

**Tie to existing plumbing.** The rating *also* mirrors to the dashboard feed (`dashboard/feed.mjs`, `FEED_FILE`/`feed.json`) as a `kind:'rating'` entry — same path the capture-outcome feed and notification bell already reuse (per memory, the bell reuses `feed.json` as its data endowment). So a fresh rating shows up in dan's "Agent feed" with no new transport. `consent_share:true` is the **only** gate by which a chat becomes a §2 seed candidate or "AI-anonymized usage data" — default `false`.

**Two downstream uses:** (i) low score → candidate seed (§2); (ii) ratings are an outcome metric the architecture tree charts *alongside* grader pass-rate — so the synthetic suite gets validated against real human satisfaction, not just pass/fail.

---

## 4. The architecture-performance TREE over time

**An architecture = a config of the harness, content-addressed.** "Architecture" is the thing FINDINGS.md numbers test in prose: a `runAgent` variant, a role-catalog selection from `agent-roles.mjs`, a prompt topology, a model policy, a budget/META policy. It is captured as a config object whose `config_digest` is a sha256 — *not necessarily a git commit*, because two commits can share a harness config and one commit can host several candidate configs. (A commit ref can ride along as metadata.)

**Architecture node** (`results/architectures/<arch-id>.json`):

```jsonc
{
  "id": "arch-0007",
  "parent": "arch-0005",            // ← the tree edge; root = current best/deployed harness
  "label": "subagent-budget-in-context",
  "config_digest": "sha256:...",     // hash of {runAgent opts, roles selection, prompt topology, model policy}
  "config": { /* the actual knobs, so a run is reproducible */ },
  "commit": "cda0782e",              // optional provenance
  "proposed_by": "agent-c",
  "notes": "tests budget-awareness hypothesis (FINDINGS candidate #N)"
}
```

**Suite-run record** (`results/suite-runs/<run-id>.json`, one per `eval --all`):

```jsonc
{
  "run_id": "run-1776312957", "ran_at": "2026-06-16T...",
  "architecture": "arch-0007", "endpoint": "claude-opus", "model": "...",
  "repeat_index": 2,                 // ← which of the N repeats (variance, see gate below)
  "cells": [ /* metric records from §1, verbatim schema */ ],
  "summary": { "pass": 14, "total": 16, "tokens": 812345,
               "cost_usd": 1.91, "wall_time_s": 1043,
               "mean_human_rating": 4.2 }   // joined from ratings/ for seeded obstacles
}
```

**The graph data Agent C reads** (`tree.mjs` → exposed as a **read-only `eval` endowment**, mirroring how `boundApp` is the root-only app-state accessor at `server.mjs:364`):

```jsonc
// GET via the eval endowment: tree({ obstacleSet: "latest" })
{
  "nodes": [
    { "id":"arch-0007", "parent":"arch-0005", "label":"...",
      "summary": { "pass_rate":{"median":0.875,"runs":5,"stdev":0.04},
                   "cost_per_pass": 0.136, "mean_rating": 4.2 } },
    ...
  ]
}
```

Nodes = architecture versions, edges = `parent`. Each node carries its **latest aggregate over N repeats** (median pass-rate + variance), cost-per-pass, mean human rating. This is exactly a renderable performance tree over time — and structurally identical to the field agent's existing 3D conversation-trace / `pendant.js` fan-out (which already renders parent→child node trees via SSE), so the maintainer's UI **reuses that renderer** instead of building a new one.

**Adoption gate — "stably passes," not "passed once."** FINDINGS #10/#12 are explicit that single-run conclusions flip under sampling variance. So:
- A suite run records `repeat_index`; `eval --all` runs `--repeats N` (default 5).
- A node's `summary.pass_rate` is the **median across repeats** with `stdev`.
- A proposed arch is **promoted to root** only if its median pass-rate beats its parent's **and** doesn't regress cost-per-pass beyond a band, **across repeats** — not on a lucky single run. Bake `--repeats` into the record from day one.

---

## 5. The continuous loop (who drives each step)

```
        ┌─────────────────────── Agent C (maintainer, the orchestrator) ──────────────────────┐
        │ 1. MONITOR  agentic-harness research (WebSearch/WebFetch + FINDINGS.md history)       │
        │             → forms a hypothesis ("budget-in-context improves perf")                  │
        │ 2. PROPOSE  a new architecture node: arch-N with parent = current root,               │
        │             config = the knob change. Writes results/architectures/arch-N.json.       │
        └───────────────┬──────────────────────────────────────────────────────────────────────┘
                        │  (code change to runAgent/roles/prompt = a Blacksmith task)
                        ▼
        ┌──────── Blacksmith (the code session / dev-agent, via field-agent-chats skill) ───────┐
        │ 3. IMPLEMENT the config behind a flag so arch-N and its parent both runnable;          │
        │    runs `node eval.mjs --all --arch arch-N --repeats 5` (resume-safe).                 │
        │    Each cell metered through the SHARED meter; written immediately to results/cells/.   │
        └───────────────┬──────────────────────────────────────────────────────────────────────┘
                        ▼
        ┌──────────────────────── Agent C reads the tree endowment ────────────────────────────┐
        │ 4. EVALUATE  tree({obstacleSet:"latest"}): did arch-N beat arch-(parent)               │
        │              on median pass-rate across repeats, within cost band, w/o rating regress? │
        │ 5. ADOPT     if win → promote arch-N to root (deploy the flag on) + append a FINDINGS   │
        │              entry (the prose scoreboard stays, now data-backed). If lose → keep node   │
        │              in the tree as a recorded dead-end (negative results are data too).        │
        └───────────────────────────────────────────────────────────────────────────────────────┘
```

- **MONITOR** = Agent C, using `WebSearch`/`WebFetch` on agentic-harness design + reading the accumulated FINDINGS history. Human gate stays: dan approves adoption (promotion to root = a deploy).
- **PROPOSE/EVALUATE/ADOPT** = Agent C (it owns the architecture tree + the read-only `eval` endowment).
- **IMPLEMENT/RUN** = the Blacksmith (a `claude` code session registered via the `field-agent-chats` skill) — the write-side dev agent. Agent C routes the "make arch-N runnable + run the suite" task to it. This matches the existing role split: read/orchestration on Agent C, single-threaded code-writing on the Blacksmith.

The loop is dan's "test new theories on our own harness, adopt what works" — now closed with **data** (the tree) instead of prose, and gated by **stability across repeats** instead of one green run.

---

## 6. THE SMALLEST FIRST INCREMENT

Ship a vertical slice that proves the spine end-to-end, scored against **today's** Agent C, with the result written to the tree. No toll-bridge dependency for the first pass *except* the one-line meter fix (which #1 needs anyway and is the cheapest possible change).

**Step 0 (prerequisite, ~1 line each):** stop discarding `usage`. In `callLLM` (`tool-bridge.mjs:80-81`) keep `j.usage`; in `delegate.mjs:69/113` keep `data.usage`. Add `meter.mjs` + `prices.mjs` (a per-(provider,model) table; cost = tokens × price). Verified live: gemma returns `usage.{prompt,completion,total}_tokens`; Anthropic returns `usage.{input,output}_tokens`. No tokenizer needed.

**Step 1 — one ported obstacle.** Port `07-capability-attenuation` to `eval/obstacles/07-capability-attenuation/grade.mjs`, grading the **real** in-vat caps: mint an attenuated handle via the agent's `share`, assert the read-only handle's mutating method **throws**, assert a `revoke`'d handle is dead. Run it through `harness.mjs` driving `runAgent` against today's deployed config = **`arch-0000` ("current")**, the tree root.

**Step 2 — one conversation-seeded case.** Pick one real low-rated (or operator-flagged) chat, run it through `anonymize.mjs` (gemma + the hard swissnum scrub), commit `eval/obstacles/seed-0001/`. Grade hybrid: structural (right power called, within `max_subagents`, cost band) + a metered LLM-judge on transcript-vs-goal.

**Step 3 — write the tree.** `node eval.mjs --all --arch arch-0000 --repeats 3` produces `results/cells/arch-0000/*.json`, one `suite-runs/run-<ts>.json`, and the root `architectures/arch-0000.json`. `aggregate.mjs` rolls it up. `tree.mjs` serves the node. **Done = a maintainer can call the `eval` endowment and read arch-0000's pass-rate (across 3 repeats) on 2 obstacles.**

That is the whole loop in miniature: real loop, real caps, one real-chat seed, metered, scored, written to the tree the maintainer reads — and it establishes the baseline node every future proposal branches from. Defer the toll-bridge, the rating UI, and the research-monitor automation to follow-on increments; they all plug into seams this slice creates (`meter.mjs`, `ratings/`, `tree.mjs`).

---

## 7. Open decisions for dan

1. **Architecture identity: config-digest vs git commit.** I propose `config_digest` (sha256 of the harness knobs) as the node id, with `commit` as optional provenance — because a flag-gated A/B both live at one commit. OK, or do you want arch-id ≡ git commit (simpler lineage, but forces a commit per candidate and can't A/B within a commit)?
2. **Repeat count vs cost.** Default `--repeats 5` for the stability gate (FINDINGS #10/#12). 5× the token spend per suite run. Lower default (3) to save tokens, raise only for promotion decisions? Or fixed 5 always?
3. **Where the LLM-judge runs.** Seed grading + judge calls cost tokens. Local gemma (cheap, weaker judge) vs Opus `opusComplete` (strong, like the dietician judge, but $$ and itself needs the toll-bridge to stay bounded)? I lean gemma for structural-adjacent judging, Opus only for the promotion-decision suite.
4. **Consent default for seeds.** I set `consent_share:false` by default; a chat becomes a seed/usage-data only on explicit opt-in. Confirm that's the right default (it matches the explicit-exposure standing rule), or do *your own* chats auto-qualify as seeds since you own them?
5. **Does the old OCC Python harness stay alive?** It still uniquely does cross-runtime (endo/ocap-kernel/spritely) comparison — out of scope for Agent C but possibly still wanted for the broader ocap story. Keep it as-is in `~/ocap-obstacle-course` (no migration of *its* role), and only lift the obstacle *content* + schema into the JS port? That's my assumption.
6. **Tree renderer reuse.** I propose reusing `pendant.js`/3D-trace for the architecture tree viz (same parent→child shape). Fine, or do you want a separate flat scoreboard view (closer to `aggregate.py`'s table / FINDINGS.md) as the primary, with the 3D tree secondary?

**Files grounding this design (all absolute):** `/home/dan/endo-bfb/packages/ocapn-noise/tool-bridge.mjs` (`callLLM:64-82`, `runAgent` sys/call-sites), `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs` (`/chat:351-415`, `boundApp:364`, `chatStorePath`/`appStore`, `/chats/load:426`), `/home/dan/endo-bfb/packages/chat/voice-agent/agent-caps.mjs` (config-file `0o600` pattern :56/424/441, `appStore` accessors), `/home/dan/endo-bfb/packages/chat/voice-agent/delegate.mjs` (`:69/113` usage), `/home/dan/endo-bfb/packages/chat/voice-agent/agent-roles.mjs` (stock arch knobs), `/home/dan/endo-bfb/packages/chat/dashboard/feed.mjs` (`FEED_FILE`/`feed.json` for the rating mirror), `/home/dan/ocap-obstacle-course/obstacle-course/agent-harness/aggregate.py` (`dedupe_latest`/`summary` to port), `/home/dan/ocap-obstacle-course/obstacle-course/obstacles/07-capability-attenuation/` (first port target). Proposed new home: `/home/dan/endo-bfb/packages/chat/voice-agent/eval/`.