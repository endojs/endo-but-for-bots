> **Archived verbatim** from the 2026-06-16 design pass (workflow `wf_ffc46d65-0f8`).
> The CURATED, current plan is `../SELF-IMPROVEMENT-ROADMAP.md` (incl. §6 self-tuning). This file is the
> original deep design detail — concrete API sketches — preserved on request; treat the roadmap as
> authoritative where they differ.
>
> **STATUS: the SKILL layer is UNBUILT (as of 2026-07-02).** The `skills.mjs` module (`makeSkillLibrary`,
> §1/§5) was scaffolded but **never wired** into the agent loop — no `readSkill` verb was added, no
> `skillList()` block reached the `sys` array, no role cited a skill, and no `skills/<name>/SKILL.md`
> directory was ever created. Its only consumer was its own test. It was therefore **removed as dead code**
> in the 2026-07-01 audit (P6 DEAD-1) — do not expect `skills.mjs` in the tree. So treat the "smallest first
> increment" (§5) as **not yet done**: to revive this, re-create `skills.mjs` *and* land the three wiring
> steps (verb, `sys` index, role citation) together. NB the measurement rail this design leans on (§4, the
> eval-suite A/B loop) **does** exist now (`../eval/`) — only the skill *content + citation* layer is missing.

---

I now have all the load-bearing details: the `sys` array, the `manifest.map` tool listing, the spawn paths (`delegateTask`, `employ`, `spawnSpecialist`), `ROLE_CATALOG` with its prompt-free `roleList()` view, the existing `.claude/skills/<name>/SKILL.md` convention already in the repo, and the eval-suite seam (`callLLM`). I have enough to write a concrete, citable design.

# design:garden-skills — Importing garden's skills into Agent C and measuring success (vision #4)

## 0. The core finding (read this first)

Agent C has **caps** (`POWER_DESCRIPTIONS`, `toolboxFor`), **roles** (`ROLE_CATALOG`, 16 archetypes), and **specialists** — but it has **no SKILL layer**: no canonical, citable, version-controlled *procedure* document with frontmatter + a self-improvement write-back. That gap is real and is exactly what garden contributes.

But there is a crucial asymmetry to exploit: **a garden skill is prose a model reads; an Agent C power is a real cap the model can only invoke if granted.** Garden enforces "the steward may not edit CLAUDE.md" in *prose*; Agent C enforces it in *ocap*. So the import rule is:

> Port garden's **skill structure** (citable procedure docs) for the things that are genuinely *procedures* (how to form a PR, how to review, how to self-improve). For anything that is really an *authority* (terminate a subagent, read a folder, poll GitHub), do **not** import it as a skill — it is already a cap, or should become one. **A skill tells an agent how to use the caps it holds; it never grants authority.**

This keeps skills purely advisory (safe to load into context, safe to let an agent author one) while authority stays in the purse + cap graph.

## 1. The "skill" concept for Agent C — minimal addition

**Recommendation: add a `skills/<name>/SKILL.md` library, mirroring the convention already present in this very repo** (`voice-agent/.claude/skills/playwright-cli/SKILL.md`, `kazputer-phone/parent-skill/SKILL.md`). We are not inventing a format — we are generalizing one Agent C already uses.

Add **one directory** and **one tiny module**:

```
voice-agent/skills/<name>/SKILL.md          # the procedure (garden's schema, §2 of the garden digest)
voice-agent/skills.mjs                       # makeSkillLibrary(): list() / get(name) / textFor([names])
```

A skill is **data, not a cap**. `skills.mjs` reads the `skills/` dir at boot, hardens the result, and exposes:

- `skillList()` → `[{ name, purpose, roles }]` — the prompt-free index (exact analog of `roleList()` in `agent-roles.mjs:225`, which deliberately keeps prompts out of context).
- `skillText(name)` → the SKILL.md body, loaded **on demand only**.
- `skillsForRole(role)` → the names a role cites.

SKILL.md keeps garden's schema verbatim (YAML frontmatter `created/updated/author`; body = purpose / when-to-use / procedure / inputs / output / pitfalls / **Notes from the field** append-only log). One Agent-C-specific frontmatter field added: `requires_powers: [...]` — the caps a citing agent must already hold for the skill to apply (used only to *gate citation*, never to grant).

Why a library and not "just put it in the role prompt": garden's invariant — **skill content is canonical, cited by relative path, never copied into role prose** — is what makes skills measurable and editable in one place. Inlining them into `ROLE_CATALOG` prompts would re-create the drift garden's `model-selection` table explicitly avoids.

## 2. The import: as-is / adapt / skip

Classifying garden's 83 skills against Agent C's ocap world:

### Import AS-IS (pure procedure, no git-fork assumptions) — start here
- `self-improvement` — the mandatory end-of-engagement write-back. **The keystone import**; it is the engine behind dan's "test new theories, adopt what works."
- `em-dash-style`, `no-latin-shorthand`, `relative-paths` — the universal prose-style trio; cheap, already match house style.
- `adversarial-tests`, `saboteur-adversarial-review`, `rule-elision-test`, `regression-evidence`, `coverage-driven-testing` — review/test procedures; map cleanly onto the existing `critic`/`adversary`/`reviewer`/`securityAudit` roles (`agent-roles.mjs:87,150,168,174`).
- `panel-review`, `panel-hints` — the multi-juror review procedure; composes with `employ(critic) → employ(verifier)` chains.
- `context-library`, `library-lookup` — how to organize the home folder (vision #3 grants new users "empty home folder + Wikipedia"; this is the *procedure* for that folder).
- `autonomous-loop-pacing`, `scheduling`, `velocity-recalibration` — loop-control for the future autonomous/"Steward" path.

### ADAPT to ocap (port the posture; replace prose-bounds with cap+purse-bounds)
- `agent-termination` → **do not import as a skill**; it maps onto the **existing `revoke()`** in the node graph (`agent-caps.mjs` share/revoke). Write a *thin* SKILL.md (`subagent-budget-discipline`) that says: "a sub-agent is bounded by its purse and its granted powers; revoke when done; never grant `createSubAgent`-class powers without a funded purse." This is the literal antidote to the runaway-subagent trigger, expressed as procedure over the real caps.
- `model-selection` → adapt into a SKILL.md that *points at* `ROLE_CATALOG`'s `tier`/`localModelFor` (`agent-roles.mjs:201-211`) and (when vision #1 lands) the per-model price table, so a role's dispatch can show its cost. Garden's "adequate model, no waste" doctrine, grounded in Agent C's real tier→model resolution.
- `job-board` → adapt only the **context-firewall discipline** (the job's substance never enters the parent context). Agent C's analog is the confined sub-node: `delegateTask`/`employ` already isolate context (`agent-caps.mjs:640,683`). Skill documents *when* to isolate; the isolation itself stays in caps.
- `changeset-discipline`, `pre-push-gates`, `pre-pr-checklist`, `regression-evidence` → adapt to "Test like Joshua" gates; cited by the `executor`/`debugger`/`testRunner` code-roles which route to the Blacksmith (`via:'dev'`).

### SKIP (git-fork-bus specific; no analog in Agent C's single-vat model)
- The whole **journal/worktree/PR-stacking family**: `worktree-per-pr`, `stacked-pr-build`, `pr-dependency-topo-sort`, `rebase-hygiene-audit`, `yarn-lock-separate-commit`, `cherry-pick-followup`, `frozen-base-branch`, `pr-creation-state-machine`, `conflict-resolution`, `retcon`, `dispatch-worktree`, `journal-sync`, `journalism`, `inbox-drain`, `boatman`-style identity-switch ferry, the `monitor-*`/`*-poll` upstream watchers, `node-lts-window-watch`, Dependabot triage. These assume garden's orphan-branch message bus + multi-worktree dispatch root, which Agent C does not have and does not need (its agents run in one vat, not across forks).
- `garden-ab-evaluation` is the one exception worth *re-implementing* (not importing) — it IS vision #2 and belongs to the **eval-suite** design, not here. The garden-skills design just supplies it the SKILL.md inputs to A/B over.

**Net first-wave import: ~12 skills** (the AS-IS list + the 4 adapted procedure docs). The other ~70 are skipped or deferred.

## 3. How a skill is made available to an agent

Three layers, mirroring garden's "COMMON.md → role file → load skill on demand":

1. **Index in context, body on demand.** The agent's manifest already lists tools via `manifest.map(...)` in the `sys` array (`tool-bridge.mjs:157`). Add **one** new tool to the entry agent's bundle:
   - `readSkill(name)` — a **read-only, no-authority** verb (like `searchNotes`/`readNote`, `agent-caps.mjs:458`) returning `skillText(name)`. The prompt-free `skillList()` index goes into the `sys` array as one block (after `'Available tools:'`), so the agent *sees the menu* but not the bodies — exactly garden's "load skills on demand" and the same context-economy as `roleList()`.
2. **Roles cite skills.** Extend each `ROLE_CATALOG` entry (`agent-roles.mjs`) with a `skills: [...]` field (names only). When `employ(role,...)` spawns the sub-node (`agent-caps.mjs:683-697`), prepend the cited skills' bodies to the role's `persona`/system prompt — so a `critic` sub-agent is born already knowing `adversarial-tests` + `rule-elision-test`. This is the garden role→skill citation, realized at spawn time. No new authority: the sub-node's powers are still the lexical intersection ring (`agent-caps.mjs:680`).
3. **A universal "COMMON" preamble.** `self-improvement` + the prose-style trio apply to *every* role. Inject them once in the `sys`/`persona` assembly (`tool-bridge.mjs:144-161`) rather than per-role, matching garden's `COMMON.md`.

Critically: **a skill is never a cap.** `readSkill` returns text; it confers no authority. Authority remains the granted power-ring + (vision #1) the purse. A sub-agent with an empty purse and no spawn-class power literally cannot act on a skill that says "spawn a helper" — the skill is advice; the cap is the gate.

## 4. The measurement loop — does a skill help?

This rides the **eval-suite** design (vision #2), at the same meter (`callLLM`, `tool-bridge.mjs:64` — the single inference chokepoint that also becomes the toll-bridge seam). A skill is an **architecture variant**, A/B-tested exactly like a `runAgent`/role-policy change:

- **Two arms per eval case:** arm A = stock agent type *without* the skill cited; arm B = identical agent *with* the skill injected (layer 2/3 above). Same seed prompts (anonymized past conversations from the eval-suite design), same model, same powers.
- **Metric record** = the eval-suite schema verbatim: `{obstacle, runtime, endpoint, model, provider, rounds, input_tokens, output_tokens, cost_usd, wall_time_s, passed, note}`. The "skill helped" signal is a **per-skill delta**:
  - **Quality:** Δ pass-rate (and, for seeded cases, Δ mean human "How'd I do?" rating).
  - **Cost:** Δ `cost_usd` and Δ `rounds`. A skill that raises pass-rate *and* lowers rounds is a clear win; one that raises pass-rate at 3× cost is a dan decision.
- **Architecture-tree node:** each skill-on/skill-off run is a node in the vision-#2 performance tree (`suite-runs/<run-id>.json`, `architecture.parent` edge). "Citing `self-improvement` in the critic role" becomes `arch-NNNN` branched from its parent; promoted to root only if it **stably** beats the parent across N repeats (FINDINGS #10/#12: single runs flip under variance).
- **`rule-elision-test` as the native auditor:** garden's own skill for "drop a rule, see if behavior degrades" *is* the A/B loop — import it and use it on Agent C's own skills (including the prompt blocks in `runAgent`'s `sys`). It keeps the skill library lean: a skill that shows no Δ when elided gets pruned.

Tie-in: the eval-suite already plans to expose `suite-runs/` + `ratings/` to Agent C as a read-only "eval" endowment. Per-skill deltas live there; the maintainer agent answers "did citing this skill beat not citing it?" with data, not prose.

## 5. The smallest first increment (ship this, nothing more)

A vertical slice that proves the whole loop end-to-end with the least code:

1. **Add `skills.mjs`** (~40 lines): `makeSkillLibrary()` → `skillList()`, `skillText(name)`. Boot it in `agent-caps.mjs` next to the role catalog.
2. **Import exactly two skills** into `voice-agent/skills/`:
   - `self-improvement/SKILL.md` (verbatim from garden — the keystone).
   - `adversarial-tests/SKILL.md` (verbatim — small, maps onto the existing `critic`/`adversary` roles).
3. **Wire one citation:** add `skills: ['adversarial-tests']` to the `critic` role (`agent-roles.mjs:87`); at `employ('critic',...)` spawn (`agent-caps.mjs:683`), prepend `skillText('adversarial-tests')` to the role persona.
4. **Add `readSkill(name)`** as a read-only verb in the entry bundle + put `skillList()` in the `sys` block. (No new power; it joins the always-on read verbs.)
5. **Score ONE eval case both ways:** pick one seeded obstacle (or one hand-written ocap case from `ocap-obstacle-course/obstacles/`), run `employ('critic')` with skill OFF vs ON, record the two metric rows + (if seeded) the human rating. Write the delta to one `suite-runs/*.json`.

Done-condition: a committed `skills/` dir with 2 skills, one role citing one of them, a `readSkill` verb, and **one A/B metric pair on disk** showing the skill's Δpass/Δcost. That is the smallest thing that exercises import + citation + availability + measurement together.

Two facts that make this cheap: (a) the SKILL.md convention **already exists in this repo** (`.claude/skills/playwright-cli/SKILL.md`) — no format invention; (b) `roleList()`/`localModelFor` (`agent-roles.mjs:225,206`) are the exact template for `skillList()`/`skillText` (prompt-free index + on-demand body), so `skills.mjs` is a near-copy of a pattern already proven and hardened here.

## 6. Open decisions for dan

1. **Skill home:** `voice-agent/skills/` (app-local, where the agent loop lives) vs the existing `voice-agent/.claude/skills/` (Claude-Code convention) vs a shared `endo-bfb` top-level `skills/`? Recommend app-local `voice-agent/skills/` (the runtime agent, not the dev harness, is the consumer); the `.claude/skills/` dir stays for the Blacksmith's own Claude-Code skills.
2. **Provenance vs. drift:** garden skills carry a `Notes from the field` log with adoption commits. Do we vendor (copy + record `adopted from kriskowal/garden@<sha>`) or git-subtree `references/garden/`? Recommend vendor-with-provenance for the ~12 we want; a full subtree drags in the 70 fork-specific ones.
3. **Who may author/edit a skill?** Garden lets only Liaison/gardener touch skills. Agent C's equivalent: should `proposeSkillEdit` be a confirm-gated power (like `proposeSystemPrompt`, `agent-caps.mjs:543`), so the agent can self-improve its *procedures* but dan confirms? Recommend yes — keeps `self-improvement` real but human-gated.
4. **Skill citation in `requires_powers`:** should citing a skill an agent's ring can't support be a hard error, a silent skip, or a warning in the result envelope? Recommend silent skip + a note (a `critic` with no `web` power just doesn't get `citation`-style steps).
5. **Measurement gate before adoption:** what Δ and what N-repeat threshold promotes a skill from "imported" to "cited by default"? (Depends on eval-suite's variance findings; flag as a joint decision with the eval-suite designer.)
6. **Roles vs skills overlap:** Agent C's roles already encode posture *and* procedure in one prompt (`agent-roles.mjs`). Do we factor the procedural parts of existing role prompts *out* into cited skills (garden-style separation), or only add skills net-new? Recommend net-new first (low risk), refactor later once the measurement loop shows which procedures are load-bearing (`rule-elision-test` decides).

---

**Files cited (all real, absolute):** `/home/dan/endo-bfb/packages/chat/voice-agent/agent-roles.mjs` (ROLE_CATALOG :183, roleList :225, localModelFor :206, tiers :201-211), `/home/dan/endo-bfb/packages/chat/voice-agent/agent-caps.mjs` (POWER_DESCRIPTIONS ~:312-335, META_POWERS :442, read verbs :458, toolboxAndManifestFor :610, delegateTask :632-648, employ :662-708, spawn sub-node :683/:697, node.toolbox :1005, askSpecialist runAgent :1053, proposeSystemPrompt :543), `/home/dan/endo-bfb/packages/ocapn-noise/tool-bridge.mjs` (runAgent :143, sys array :144-161, manifest listing :157, callLLM chokepoint :64), `/home/dan/endo-bfb/packages/chat/voice-agent/.claude/skills/playwright-cli/SKILL.md` and `/home/dan/endo-bfb/packages/chat/kazputer-phone/parent-skill/SKILL.md` (the SKILL.md convention already in-repo). No local garden clone exists (`/home/dan/garden` absent) — schema/skill names taken from the garden ingest digest; vendoring will fetch from github.com/kriskowal/garden.