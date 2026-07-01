# Harness parity — the field agent as a top-level task distributor

Source: dan's standing instruction (voice note, 2026-07-01): voice notes processed through the
field agent often come back **BLOCKED**, forcing a fallback to Claude Code in a tmux session on
the host. Every such gap is to be surfaced, proposed as a harness change, and implemented
incrementally, until the field agent is as capable as Claude Code at decomposing work into
sub-agents that run in parallel, each near its own context limit — a **top-level task
distributor**.
Status: **DESIGN / proposal** (2026-07-01). Nothing built; increments below are sized for one
commit each by a future worker.

## Problem statement

The field agent's confinement story is *ahead* of Claude Code's (lexical CodeMode scope, powers
as caps, endowment-moment approval). Its **orchestration** story is behind. Concretely, the very
session that produced this document is the evidence: dan's request was routed to Claude Code on
the host, which ran **two background agents editing `app.js` and `server.mjs` concurrently**
while a third lane wrote this doc — fire-and-forget spawns, completion notifications re-invoking
the orchestrator, a durable dependency-ordered task list surviving context compaction, and only
final reports (never transcripts) entering the orchestrator's context. When the same work is
handed to Agent C it ends in `blocked(...)`, because the harness lacks those six mechanics — not
because the cap model forbids them. The cap model is *ready* for them; the verbs don't exist.

The goal is NOT to clone Claude Code. It is to close each gap with an **ocap-shaped** equivalent:
every new mechanic is a capability with a class in `AUTHORITY-MODEL.md`, enforced by
`endowments.test.mjs`, respecting dan's endowment-moment rule (approve at the moment authority is
granted, never per-action — memory `endowment_moment_approval`).

## Gap analysis

| Claude Code capability | Field-agent nearest equivalent | What's missing |
| --- | --- | --- |
| **Background sub-agents** — fire-and-forget spawn; completion notification **re-invokes the orchestrator** with the result | `askSpecialist` / `employ` are **synchronous** — the CodeMode program `await`s them, the turn blocks until the child finishes (`agent-caps.mjs` ~2656). `scheduleSpecialist`/nudges run detached, but the result files into a **separate seed-chat** + a bell push (`server.mjs` ~537–559) — it never re-enters the spawning chat, and the spawner is never woken with it | A `background: true` spawn whose completion **appends into the spawning chat** and **re-invokes the orchestrator** so it can compose/continue |
| **Durable task queue** — dependency-ordered todo list that survives context compaction; the agent owns it, reorders it, checks items off | Feed cards (`pushFeed` — human-facing, no deps, no status machine); `improvement-backlog.mjs` (self-improve-specific); task state otherwise lives **only in the chat transcript** | An agent-ownable **task object**: create/claim/complete/block-on, queryable, persisted outside the transcript, shareable as a cap |
| **Scheduled self-wakeups** — the orchestrator paces long work by re-waking itself | `scheduleWakeup` **pings dan** (a reminder, not a run); `scheduleTask` runs a *fresh* scheduled agent with no chat continuity (SOUL.md is its only memory); nudges wake a *specialist*, not the chat's own agent | Self-continuation: "wake **me**, in **this chat**, at T, with the task state" |
| **Parallel scout fan-out** — N read-only searchers launched at once, structured results composed by the orchestrator | CodeMode endows tools as plain async fns, so a program *can* `Promise.all([employ(...), employ(...)])` — but nothing teaches, bounds, or structures it: no concurrency cap, results are prose `answer` strings, and a weak model writes serial awaits | A first-class `scout()` fan-out verb: bounded parallelism, read-roles only, a structured per-scout report contract |
| **Host-layer execution** — parallel edits in worktrees, git commits, `systemctl`, real builds | The **Blacksmith** (`blacksmith-runner`): confined `claude -p`, **single-threaded**, holds **no Endo caps**, can't import host-absolute paths; `hostExec` is root-only `coarse`. The dev-spawner (E1, `designs/dev-spawner.md`) resolves the design — **still unbuilt** | Parallel worktree dev lanes at the E1 "A floor" (worktree-only, PR-only, budget-capped), spawned in the background with callbacks |
| **Context-limit management** — sub-agent transcripts stay OUT of the orchestrator's context; compaction summarizes and continues | Partially the *strong* suit: `employ`/`askSpecialist` return only the distilled `{answer, toolsUsed}` envelope; transcripts don't leak up. But the orchestrator's own transcript has **no compaction** — a long chat just degrades, and everything the agent "knows" about in-flight work dies with the context | A checkpoint move: distill in-flight state **into task grains**, reseed the transcript, continue |

Two honest notes on the current code, so a worker doesn't design against stale docs:

- **`NEVER_AUTO` has moved.** It is now `{home-assistant, accept-invite}` (`agent-caps.mjs`
  ~847): spawning a confined specialist no longer proposes at all, because a spawn **⊆ the
  spawner's powers** is structurally within bounds — the endowment-moment rule made per-spawn
  confirmation redundant. The increments below keep that invariant: backgrounding a spawn adds
  **no authority**, so it needs no new confirmation; only the *callback facet* is new, and it is
  additive-only.
- **Fan-out is latently possible today** (async fns in a Compartment compose with `Promise.all`).
  The gap is a *harness* gap — contract, bounding, prompting, trace rendering — not a confinement
  gap.

## Design principles (apply to every increment)

1. **The cap is the boundary.** Each new verb gets a class in `AUTHORITY-MODEL.md` and a `POLICY`
   entry in `endowments.test.mjs` (the suite fails otherwise — that's the point).
2. **Endowment-moment approval.** A background/parallel/scheduled run of authority the agent
   *already holds* is pre-approved by construction. New side-effecting authority handed to a
   child still gates at the grant (E1 dial: worktree-only = free; auto-approved external writes =
   a user proposal BEFORE the spawn).
3. **Purse-bounded, never count-bounded.** Background and fan-out spend meters against the
   spawning chat's purse (toll-bridge); a detached run must not become an invisible leak —
   exactly as `runScheduledAgent` already does with its per-run metered LLM.
4. **No transcript leaks upward.** Children return the distilled envelope only. That property
   already holds — every increment must preserve it.
5. **Joshua verification.** Each increment ships with a staging test against the real `:8778`
   service (the `*.staging.test.cjs` pattern, playwright-core + system chromium), not just units.

## Increments (dependency order, one commit each)

### Inc 1 — background specialist with completion-callback into the spawning chat

*The keystone; Incs 4 and 6 build on it.*

**What:** `askSpecialist({ name, request, background: true })` (and the same flag on `employ`)
returns immediately with `{ ok, running: true, runId }`. The child runs detached (the
`AGENT_RUNNER` call moved off the turn's critical path). On completion the harness (a) appends
the distilled report to the **spawning chat** as an agent-authored message attributed to the
child, and (b) **re-invokes the orchestrator** on that chat with the report as the incoming turn
(`[background run "<nickname>" completed] …report…`), so it can compose, chain, or just
acknowledge. A durable `background-runs.json` registry (mirroring `specialist-nudges.mjs`'s
store shape) survives a service restart; orphaned runs surface as a failed report, never
silence.

**Files:** `agent-caps.mjs` (the `background` option on `askSpecialist`/`employ`; mint the
report-back facet), new `background-runs.mjs` (durable registry + completion dispatch — model it
on `specialist-nudges.mjs`), `server.mjs` (completion → append message + re-invoke runner; reuse
the nudge-fire pattern at ~537–559 but target the spawning chat, not a seed-chat). Client: none
in v1 — the message arrives via the existing chat persistence + bell; live SSE polish comes
later (avoids colliding with in-flight `app.js` work).

**Ocap shape:** the spawn itself is unchanged (`delegate` class, ⊆ spawner, pre-approved). The
one **new** cap is the child's report-back facet: a write-only, single-use `reportBack(text)`
scoped to the one spawning chat — `add` class (additive-only; worst case is clutter in your own
chat). It is NOT a general chat-write and NOT reachable by name; the harness closes over it. The
re-invoked orchestrator turn runs with the chat's own powers and purse — no escalation. Spawn
confirmation stays exactly where `NEVER_AUTO` (as-built) puts it today.

**Verification:** `background-callback.staging.test.cjs` — real service: ask the root agent to
"scout X in the background and tell me when done"; assert the turn returns fast, the child's
report appears in the same chat, the orchestrator's follow-up turn references it, and the
purse debited the child's spend. Restart the service mid-run; assert the orphan surfaces as a
failure report.

### Inc 2 — durable task grains (the agent-ownable queue)

**What:** a `tasks` power whose store is **grains** (`grain-store.mjs`), keyed per chat/project:
`createTask({ title, detail, blockedBy: [taskId…] })`, `updateTask({ id, status, note })`,
`listTasks({ status })`. Status machine: `todo → doing → done | blocked | dropped`; `append`-merge
history on each task (a task never forgets — provenance for free, per the propagator design in
`preact-component-trie.md`). Because grains are already subscribable, a live task-list widget
(via `live-cells.mjs`) falls out later with no new authority. Tasks are what survive
compaction — the transcript can die; the queue can't.

**Files:** new `task-grains.mjs` (thin facet over `makeGrainStore`), `agent-caps.mjs` (the
`tasks` power + verbs + manifest), `endowments.test.mjs` (POLICY entries),
`AUTHORITY-MODEL.md` (one row).

**Ocap shape:** `scoped-write` — writes confined to the agent's own task store (its chat/project
key), like `fileWrite`. `listTasks` is `read`. A task list is shareable through the existing
`share` class as a **read-only facet** (a delegate can see the queue; only the owner-ring
mutates) — designation by the grain facet, never by a store-path string.

**Verification:** `node --test task-grains.test.mjs` (merge semantics, dependency blocking,
restart survival) + a staging run: seed a 4-task plan in one turn, kill/restart the service,
next turn asks "what's left?" and the agent answers from the grains, not the transcript.

### Inc 3 — `scout()` fan-out verb in the CodeMode toolbox

**What:** `scout({ tasks: [{ id, ask }...], role = 'retriever', maxParallel = 4, nickname })` —
launches N **read-only** role sub-agents (must be `writes: false` in `agent-roles.mjs`;
`employ`'s existing ring-intersection applies), bounded `Promise.all`, and returns
`[{ id, ok, report, toolsUsed }...]` — a structured array the program composes, not prose to
re-parse. Each scout emits nested trace steps (the `pendant-subagents` rendering already handles
children). Add one system-prompt line teaching the pattern: *"for N independent look-ups, call
`scout` once — do not chain N serial employs."*

**Files:** `agent-caps.mjs` only (the verb wraps `employ` internals; no `codemode.mjs` change —
the toolbox is assembled here and endowed generically). `endowments.test.mjs` POLICY entry.

**Ocap shape:** `delegate` class, strictly weaker than `employ` (read-roles only, so *zero*
external side effects — safe to run free and parallel; the purse bounds cost). Requesting a
`writes: true` role returns `{ ok: false }` — the write rule (single-threaded writes via the
Blacksmith) is not relaxed here.

**Verification:** extend `pendant-subagents.staging.test.cjs` (or a new
`scout-fanout.staging.test.cjs`): a real turn fans out 4 scouts, the trace shows 4 concurrent
child nodes, wall-time is ~max(child) not Σ(children), and the composed answer cites all four
reports.

### Inc 4 — self-continuation wakeups (pacing long work) *(needs Inc 1 + 2)*

**What:** `continueLater({ afterMs | atIso, note })` — a once-nudge whose target is **the chat's
own agent**: at T the harness re-invokes the orchestrator in the same chat with
`[self-scheduled continuation] <note>` + a pointer to the task grains. Rides Inc 1's
re-invocation path (a self-callback is just a background run with a timer in front) and Inc 2's
grains (the note designates task ids, not transcript excerpts). This converts "I'll do the rest
tomorrow" from a lie into a mechanism — and is what lets one agent pace work across many
near-context-limit sittings.

**Files:** `specialist-nudges.mjs` (allow `target: 'self'` → the chat's agent instead of a
specialist id; result path = Inc 1's chat re-entry, not a seed-chat), `agent-caps.mjs` (the
verb), `endowments.test.mjs`.

**Ocap shape:** `notify` class (same as `scheduleWakeup` — low blast radius, scheduling only);
each fired run is purse-metered like any scheduled run. No new authority at fire time: the
continuation runs with the chat's standing powers.

**Verification:** staging: one turn creates tasks + `continueLater({ afterMs: 90_000 })`,
answers, and ends; assert the chat gains an autonomous continuation turn that completes a task
grain and reports — with dan idle the whole time.

### Inc 5 — checkpoint/compaction into grains *(needs Inc 2)*

**What:** the context-limit move. A `checkpoint()` turn-ender-adjacent verb: distill in-flight
state (open questions, decisions taken, task-grain ids) into a compact grain-backed checkpoint,
then mark the transcript reseedable — the next turn assembles `system + checkpoint + recent
tail` instead of the full history (the `resumeMessages` seam in `codemode.mjs` ~169 is already
the right entry point). The orchestrator is *told* its context budget (a line like the existing
`budgetLine`) so it checkpoints deliberately, the way Claude Code compaction does implicitly.

**Files:** `agent-caps.mjs` (verb + checkpoint grain), `server.mjs` (turn assembly honors a
checkpoint; pass a context-budget line), `endowments.test.mjs`.

**Ocap shape:** `scoped-write` (its own chat's checkpoint grain). No sharing in v1.

**Verification:** unit: a 60-message synthetic history + checkpoint reseeds to < N tokens with
task ids intact. Staging: a long multi-turn task crosses a forced-small context budget and
still completes correctly after the reseed.

### Inc 6 — parallel worktree dev lanes (the E1 floor, backgrounded) *(needs Inc 1; design already signed off in `dev-spawner.md`)*

**What:** build E1's **A floor** exactly as resolved (2026-06-16): `buildComponent(spec)` →
`git worktree add … -b devspawn/<id>` under `/home/dan` (host-absolute imports resolve — the
Blacksmith's fatal limitation), a capable runner streaming `tool_use` events into the trace,
**PR-only** (reuse the proven `blacksmith-runner` token flow), purse-budgeted — and run it
through Inc 1's background+callback machinery so Agent C fans out **several lanes in parallel**
and is re-woken as each PR opens. This is the increment that retires "fall back to tmux" for
code work; the Blacksmith remains the single-threaded *live-tree* writer, while worktree lanes
parallelize safely (each lane's writes are isolated by construction).

**Files:** new `dev-spawner.mjs` (worktree lifecycle + runner + PR open), `agent-caps.mjs` (the
verb; endowment gate), `server.mjs` (trace forwarding), `endowments.test.mjs`,
`AUTHORITY-MODEL.md`.

**Ocap shape:** per the resolved E1 dial — worktree-only spawn = **free** (no prompt: writes are
local to the worktree, effects require a human-merged PR). Passing the lane any auto-approved
side-effecting power (web, live-service writes) = a **user-approval proposal BEFORE the spawn**
(the endowment moment). Constants: no auto-merge, no deploy/restart, no public binds, budget ≤
parent allowance, fully traced.

**Verification:** staging (the Joshua top layer): a real prompt spawns **two** concurrent lanes
against a real git repo; both worktrees build, both PRs open on gitea, trace shows both lanes
live, purse shows both debits, and neither touched the live tree or each other.

## Sequencing note

Incs 1–3 are the priority triad (dan's (a)/(b)/(c)) and are independent enough to land in any
order, though 1-then-2-then-3 reads best. Inc 4 is small once 1+2 exist. Inc 5 is the deepest
cut into the turn loop — do it once grains have proven themselves. Inc 6 is the largest and the
only host-coupled one; its design debt is already paid in `dev-spawner.md`, so it is gated on
Incs 1's callback rails plus dan's go.

## Open decisions (for dan)

1. **Re-invocation autonomy (Inc 1):** when a background report lands, does the orchestrator
   *always* get an autonomous composing turn (costs a metered LLM call per completion), or only
   when the spawn asked for one (`background: 'notify' | 'continue'`)? Proposal: default
   `'continue'`, it's the whole point — but it must be visible in the trace.
2. **Task-grain scope (Inc 2):** per-chat, per-project, or one agent-wide queue with
   project keys? Proposal: per-project (matches the shared home-folder seam).
3. **Inc 6 runner:** the Agent SDK vs `claude -p --output-format stream-json` — E1 left both
   open; pick at build time based on what the blacksmith-runner already proved.
