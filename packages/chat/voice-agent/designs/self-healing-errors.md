# Self-healing errors — patch the code, keep the promise

**Principle (dan, 2026-06-23).** When we *catch* an error, the default should not be to bubble it to the
user. It should be to **hand the error to an agent equipped to fix it** — one that can **patch the relevant
code and still resolve the outstanding promise before that promise is ever broken.** The caller awaits one
promise; it should get a *value*, not a rejection, because in the gap between "throw" and "report" a fixer
repaired the thing and re-ran it.

This only works where the failing code is **runtime-mutable** enough to swap and re-run in place. So the
larger goal is a ladder: adopt promise-preserving recovery everywhere we *can* today, and steadily make more
of the system mutable until **anything an agent can do is runtime-patchable and error-recoverable.**

This is the natural complement to the ocap spine: a confined cap can be *repaired* without ever widening its
authority, because the fixer rewrites behaviour inside the same sandbox. Self-healing ≠ self-escalating.

## The shape of a self-heal

```
result = await heal({
  attempt,            // () => run the thing (reads the CURRENT source each try)
  source,             // the runtime-mutable code behind it
  apply(patched),     // make `patched` the live source (recompile / re-instantiate)
  fix({source,error}),// an AGENT: returns { source, summary } or null (give up)
})
// → { ok:true, value, healed:[patches] }  — the caller's promise RESOLVES with the repaired value
// → { ok:false, error }                   — bounded attempts exhausted; graceful, never thrown
```

Invariants:
- **Bounded.** A fixer gets N tries (default 2). No infinite repair loops.
- **Confined.** `apply` swaps *behaviour* only; it cannot grant authority the code didn't already hold
  (SES + ocap). A self-heal can make a tool *work*, never make it *reach further*.
- **Reviewed.** A patch is new agent-authored code, so it clears the **same adversarial review panel every
  proposed tool faces** (`runReviewPanel`) before it's allowed to go live; a critically-flawed patch is
  *refused* rather than applied (`makeReviewedFixer`). Self-heal doesn't get to bypass the gates.
- **Well-informed.** The fixer is handed the **same documents the failing tool's agent had** — the canonical
  authoring contract (`TOOL_AUTHORING_GUIDE`) + that tool's own admission review history — so it repairs by the
  rules the author knew, not from a cold prompt.
- **Audited.** Every auto-patch is logged on the artifact (what broke, what changed, the patch's review
  verdict) so a human can review a repair after the fact — recovery first, review later, never
  review-blocks-recovery.
- **Idempotent-friendly.** A heal re-runs the attempt; attempts that already committed a side effect before
  throwing should be written to tolerate a retry (this is itself a mutability requirement we surface, not hide).

## The mutability ladder (where we are)

| Layer | Runtime-mutable? | Self-heal status |
| --- | --- | --- |
| **Custom tools** (`custom-tools.mjs`) — agent-authored source, SES-compiled, `setSource` swaps + drops the cached instance | **Yes, fully** | ✅ **adopted** — `call()` heals on throw: fixer rewrites source → `setSource` → re-run → resolve, patch persisted + logged on the tool |
| **Confined components** (`preact-container`, exo-git source as git objects; `forkComponent`/`setSource`) | Yes (source-swappable) | ⏳ next — a render/throw hands to a fixer that edits the component source + re-renders the same grain |
| **CodeMode programs** (`ocapn-noise/codemode.mjs` `runProgram`) — the agent's per-turn JS over the toolbox | Partly (re-evaluable; already retried) | ⏳ a `tool-error`/program throw can hand to a fixer that rewrites the *step* and re-evaluates, instead of returning `{ok:false}` to the model |
| **Specialist instructions / personas** | Yes (text, hot) | ⏳ a specialist that fails a task can have its instructions patched + retried |
| **Core server routes / the harness itself** (`server.mjs`) | **No** (process code) | 🎯 aspiration — the experiment is how much of this we can move behind mutable seams (hot-reloadable modules, capability-vended handlers) so even harness errors become recoverable |

The arrow of the work points down that table: each row we move from ⏳/🎯 to ✅ is an experiment, gated by a
test that proves "broke → fixer patched → promise resolved with the repaired value," plus its negative
("unfixable → graceful, bounded, never thrown").

## How we experiment (test-driven, careful)

1. **Deterministic first.** Every seam is proven with an *injected* fixer (a pure function that returns a
   known-good patch) before any LLM fixer is wired. The mechanism is tested without a model in the loop —
   see `self-heal.test.mjs`.
2. **Then a real fixer, guarded.** The production fixer is an LLM given `{source, error, context}`; it's
   bounded, logged, and confined. It is opt-in per layer (injected), so a layer with no fixer keeps today's
   behaviour exactly.
3. **Negative tests are mandatory.** Prove the bound (exhaustion → graceful), prove confinement (a patch
   can't widen authority), prove non-mutable artifacts are skipped (no source → no heal, plain error).
4. **One layer at a time.** Land a row of the ladder with its tests, dogfood it, then climb. Don't big-bang.

## Generative healing — the magic wand (missing *referents*)

Self-healing has a generative twin (vault: `magic wand.md`, from the ocap obstacle course): a *reference*
to a name that **doesn't exist yet** — a tool / specialist / sub-agent / task — is not an error to bubble,
it's a *signal of intent*. Hand it to a filler agent that **materializes the intended referent** (within the
caller's bounds — the cap graph still bounds it), then resolve the call. Same shape as repair-healing, but the
"fix" is *creation*, not patching. It keeps the caller's reasoning context clean instead of making it manage
its own naming slip — and it's reconciled with the obstacle-course "babying" critique because it heals a
*sub-agent's* clear intent **out-of-band + logged**, never widening authority.

**Adopted: missing specialists.** `agent-caps.mjs` `fillMissingSpecialist({ name, request, caller })` —
`askSpecialist("name-that-doesn't-exist")` no longer returns "no such specialist"; an injected `fillSpecialist`
infers the intended `{domain, powers, instructions}`, the powers are **enforced ⊆ the caller** (`caller.powers`
∩ requested − non-delegable — a greedy filler is clamped, never escalates), it's spawned (`spawnedFrom: wand:…`),
and the call proceeds; the answer carries `autoCreated` for audit. Server wires an LLM filler; `SELF_HEAL=0`
or no filler → today's graceful miss. Proven in `magic-wand.test.mjs` (materialize + clamp greedy filler ⊆
caller + no-filler graceful + filler-declines). **Ladder next:** unknown custom-tool call → build it
(the obstacle-course blacksmith); unknown role/task target → configure it.

## Adopted now

- `self-heal.mjs` — the generic `makeSelfHealer({ fix }).heal(...)` seam above.
- `custom-tools.mjs` `call()` — wraps the tool invocation in `heal`; on a throw (init or method), the injected
  fixer rewrites the tool's source, `setSource` swaps it, the call re-runs, and the **caller's promise resolves
  with the repaired result** — the agent/user never sees the error. Each repair is appended to the tool's
  `healLog`. Tools with no editable source (imported bundles) and tools with no fixer wired fall back to
  today's plain `{ok:false,error}`.
- `server.mjs` wires an LLM-backed fixer (bounded, confined to a source rewrite), primed with the agent's
  documents (`TOOL_AUTHORING_GUIDE` + the tool's `review`/`reviseLog`, handed in via `ctx`), and wrapped in
  `makeReviewedFixer` so each patch passes `runReviewPanel` (critical → refused) before it goes live.
- `self-heal.mjs` `makeReviewedFixer({ fix, review, reject })` — composes any raw fixer with a review gate.

## Open questions (for the climb)

- **Review-after-repair UX.** Auto-patches need to surface in the dashboard (like proposals, but
  "already applied — confirm/keep/revert") so humans stay in the loop without blocking recovery.
- **Side-effecting attempts.** A clean retry needs the attempt to be replayable; how much do we demand that
  vs. detect-and-skip already-committed effects?
- **Moving the harness behind mutable seams** — the big one. Relates to [[ocap-designate-by-reference]]
  (handlers as vended caps you can swap) and the self-improvement roadmap.

See also: `SELF-IMPROVEMENT-ROADMAP.md`, `~/TODO/ocap-designate-by-reference.md`.
