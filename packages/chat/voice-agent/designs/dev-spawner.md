# E1 — the dev-spawner power (DESIGN, awaiting dan's sign-off)

Status: **design / decision** (2026-06-16). The crux of self-hosting (roadmap §7). Nothing built;
this exists so dan can sign off on the **autonomy / host-access bounds** before the risky part is built.

## What it is

A new Agent C power, `buildComponent(spec)`: Agent C (the orchestrator) spawns a **capable (Opus)
coding sub-agent** that does real host-coupled engineering work and returns a **PR**, with every step
**streamed into the chat trace** (E6). One `buildComponent` call ≈ "spin up one Claude-Code-like dev
agent on its own branch." Agent C can fan out several in parallel (each its own branch) and you watch
them in the full-width trace.

```
buildComponent({ title, spec, paths?, branch?, payment }) →
  { branch, prUrl, summary, steps }     // PR opened, never merged
```

## Why it's the crux

Agent C's only code path today is the **confined Blacksmith** (`bwrap claude -p`), which (a) can't do
host-coupled work — it can't even `import` `agent-caps.mjs` (host-absolute paths like
`/home/dan/gpu-img/gen.mjs`), as the eval spine proved — and (b) is an opaque black box. Without E1,
"tell Agent C to continue" routes to something that physically can't build these components. E1 is the
capability that makes the rest (E2 timers, E3/E4 the loop) actually *do* anything.

## Design

1. **Isolation = a git worktree on its own branch.** Per call: `git worktree add <state>/worktrees/<id>
   -b devspawn/<id> <base>`, under `/home/dan` so host-absolute imports resolve (the bwrap slice's
   fatal limitation goes away). The sub-agent edits only that worktree. Parallel spawns = parallel
   worktrees (serial billing via the purse; bounded concurrency).
2. **Capable runner, host-level.** A `claude` (Opus) run with `--cwd <worktree>` (or the Agent SDK).
   Host-level enough to import the cap model + run `eval/eval.mjs` — but see the **dial** for what it
   may otherwise touch.
3. **Streamed to the trace (E6).** Run with `--output-format stream-json`; the runner forwards each
   `tool_use`/`tool_result` event to `/chat/steps` (the same SSE the pendant + the new trace strip
   read), nested under this spawn's node. **No black box** — you see every step live.
4. **PR-only, never merge.** On completion the runner commits the worktree branch + opens a **PR**
   (reuse the proven `blacksmith-runner` `http.extraheader` token flow → `blacksmith/blacksmith-work`
   or a per-component repo). Agent C **cannot merge** — promotion is human + eval gated.
5. **Budgeted.** `payment` is a sub-purse minted from the chat's purse (toll-bridge Inc 1 → Inc 5). The
   sub-agent's inference is metered against it; a fan-out **cannot exceed the parent allowance** — the
   structural answer to "don't let it run away on a timer."
6. **Eval-gated.** A `buildComponent` PR that claims to improve the harness must show a green/improved
   run from `eval/` in its PR body; nothing is adopted without a stable-across-repeats win.

## THE DIAL — RESOLVED (dan, 2026-06-16): A (worktree floor) + whatever powers its parent passes

**Decision:** the floor is **A (worktree-only — no prompt)**; beyond that, the coder gets **whatever
powers its parent passes** (a subset of the parent's; attenuation). Authority flows by delegation — a
coder can be passed onward to a **tester**, through **adversarial challenger** agents, or handed
**services it needs**. The approval checkpoint is the **endowment moment, not per-action**:
- worktree-only (writes local, no external effect) → spawn **freely, no prompt**.
- granting an **auto-approved** tool that can cause an **external/side effect** — **any write tool, and
  web requests** (web counts: a request can cause an external write) → a **user-approval proposal BEFORE
  the spawn**. *"A coder will need these services to continue"* = this moment.
- per-use **propose** mode is its own gate → no endowment approval needed; only **auto-approved
  side-effecting authority** needs the up-front grant approval.

Stack-wide rule (memory `endowment-moment-approval`); it also refines `delegate` / `employ` /
`spawnSpecialist`. The A/B/C options below are kept for reference — we took **A + delegated powers**.

The sub-agent is capable + host-level. What can it *touch* beyond its worktree?

- **A · Worktree-only (recommended floor).** Reads/writes only its worktree + can run `node`/tests
  *inside* it; **no** access to live services, `~/.config` secrets, `sudo`, or the network beyond what a
  build needs. It can import the repo's code (incl. agent-caps) because the worktree is under `/home/dan`,
  but it cannot read the live chat store or restart anything. Safest; covers most "build component X".
- **B · A + read-only host context.** Also read the live chat store / `eval/results` / running state for
  *context* (e.g. to write a harvest test), still no writes outside the worktree, no service control.
- **C · Broader.** Run things against live services (e.g. drive the running agent for an LLM-graded
  obstacle). Most capable, biggest blast radius.

Plus the constants (non-negotiable in all options): **no auto-merge, no deploy/restart of live services,
no public binds, budget-capped, fully traced.** And: parallelism cap (how many concurrent spawns), and
the default model/budget per spawn.

## Relationship to the Blacksmith

This is the Blacksmith **evolved**: from *confined + opaque + can't-host-couple* → *worktree-isolated +
streamed + host-capable + budgeted*. We can either (i) add a second "host-level" mode to
`blacksmith-runner.mjs` (reuse its slice/queue/PR machinery, swap bwrap for a worktree + stream-json),
or (ii) build `buildComponent` fresh as an Agent C power calling a small host runner. Recommend (i) —
reuse the proven PR/token/worktree flow; add a `mode: 'worktree-host'` path.

## Open decisions for dan

1. ~~The dial~~ — **RESOLVED**: A (worktree floor) + parent-passed powers, gated at the endowment moment (above).
2. **Parallelism cap** + default **budget per spawn** (e.g. $0.50 Opus) + **model**.
3. **PR target** — `blacksmith/blacksmith-work` (shared) or a per-component repo / the endo-bfb fork.
4. **Who may call `buildComponent`** — root only at first? (matches the invite/META-power posture.)
5. Build path (i) extend the Blacksmith runner vs (ii) fresh power — recommend (i).

Once you pick the dial + caps, E1 is a bounded build (reuses the runner's PR/token/worktree machinery +
the E6 trace stream + the toll-bridge purse). Then E2 (heartbeat timers) + E5 (budget) make "continue"
real.
