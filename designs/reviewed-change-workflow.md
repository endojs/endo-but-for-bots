# Reviewed-Change Workflow

| | |
|---|---|
| **Created** | 2026-09-02 |
| **Updated** | 2026-09-02 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

The chart layer is complete: three reviewed-change charts, the two deploy
charts used by the gated variants, and their simulator suites
(`packages/floot/test/review-charts.test.js`, 16 tests, and
`packages/floot/test/deploy-charts.test.js`, 16 tests).
Nothing is wired into a live host yet, and — see § "What blocks a live
run" — a Fae agent **cannot answer a workflow ask today**, so the loop is
currently exercisable only by the simulator and by humans answering from
`endo inbox`.
The chart implementation in this change is complete; phases 2 and 3 are
separate live-integration follow-ups because their hosted-management packages
are not present on the `llm` base.

## The ask

A user requests a change to a project identified by a git object.
A developer agent works until it submits its work as done.
A panel of reviewers then reviews in parallel; each either approves or
requests changes.
If any reviewer requests changes, the report goes back to the developer
agent and the cycle repeats — until the change passes review, or a review
cycle limit is reached.
The limit is set by the initiator at start and adjustable afterwards.
A preview-CI step is wanted later.

Then: the Endo host should use this when asked for changes to the Familiar
Chat UI or the NixOS config, and must not propose a workflow to the user
until the reviews have finished.

## What already existed

[endo-workflow](endo-workflow.md) names this exact scenario as its
motivating use case, and `packages/workflow/test/feature-change.test.js`
encodes it as a *test fixture*: an implementer ask, two reviewer regions
joined on `counts`, a changes-requested loop-back, a CI invoke, an
operator approval, a merge.
The source branch also carried the hazardous half of a deployment as the
`endo-release` and `nixos-config-change` charts.
Those capability-free chart definitions and their simulator tests are included
in this port because the reviewed gated variants embed them literally; their
host-specific `NixosAdmin` performer and provisioning remain live-integration
work.

So the gap was never the engine.
It was three things the fixture does not have: a **bounded** loop, a
**combined** report, and a **structural** gate between review and
proposal.

## Three constraints the kernel imposes

These are not preferences; they are what `packages/workflow/src/machine.js`
permits, and each one shapes the chart.

### 1. A guard cannot read context

`tryCandidates` matches a transition's `when` against the **event envelope
and nothing else** (`machine.js:734`).
Context and params are not in a guard's scope, `when` patterns are never
substituted, and `@endo/patterns` has no relational matcher
(`patternMatchers.js:2080-2088`).
So `round >= limit` — one context value against another — is not
expressible, at any level of cleverness.

What *is* expressible is a context value against a **literal**, once that
context value has been lifted into an envelope.
An `emit` effect's event body **is** substituted from the post-assign
context (`machine.js:522-524`, `machine.js:621-623`).
That gives the chart its budget mechanism:

- `remaining` burns **down** by `{ $inc: -1 }` on every transition that
  costs a round;
- a dedicated `gate` state emits it —
  `{ kind: 'emit', event: { type: 'budget', value: { remaining: { $ctx: 'remaining' } } } }`;
- the guard reads `M.lte(0)` off that envelope.

A count-up `round` against a `limit` would have needed a kernel change; a
burn-down against zero needs none.
`round` is still kept in context, but only for the audit trail and the
ask text.

### 2. `{ $inc: { $event: ... } }` fails the run

`applyAssign` requires `$inc` to be a literal number and throws otherwise
(`template.js:319-322`), and a kernel throw fails the whole run
(`service.js:629-641`).
So "grant three more rounds" cannot be expressed as a relative increment.
Every adjustment is an **absolute** assign of the new remainder —
`{ remaining: { $event: 'value.remaining' } }` — and the operator form and
the `set-remaining` event are both worded as "rounds still available"
rather than "rounds to add".

### 3. An internal transition is the only non-disruptive assign

A transition with no `target` assigns context and returns the
configuration **unchanged** — no exit, no re-entry, no re-run of entry
effects (`machine.js:755-761`).
That is what lets the initiator raise the budget while the implementer is
mid-task: the pending ask and its deadline survive untouched.
A transition targeting its own state is *not* internal and would re-send
the ask.

There is no chart-level `on`, so a machine-wide handler needs either a
wrapping compound root or the handler repeated on the states that matter.
The chart takes the second option — `set-remaining` is handled on
`implement`, `review`, and `exhausted` — because a compound root would
force every terminal transition through `state-done` plumbing for no gain.
A signal arriving in any other state falls through, which is journaled and
harmless (external signals are explicitly exempt from the fail-loud
policy, `service.js:605`).

## The chart

`makeReviewedChangeChart` builds three charts from one definition, because
`spawn.chart` is not templatable — it must be a literal chart or an
installed key, so a per-target variant is the only way to name a per-target
deploy child.

```
boot ──seed──▶ implement ──submitted(head)──▶ review ──all approved──▶ ready
                    ▲                            │                       │
                    │                     any dissent                    │
                    │                    (panel settled)          previewCi?
                    │                            ▼                  │      │
                    └────remaining > 0──────── gate ◀───CI red───────┘      │
                                                 │                          │
                                          remaining ≤ 0                     │
                                                 ▼                          ▼
                                            exhausted ──0──▶ abandoned   proposing
                                                 │                       (spawn deploy)
                                                 └──more rounds──▶ implement
```

Notable choices:

**Wait for all, not first dissent.**
Both `regions-settled` branches carry `pending: M.eq(0)`.
The existing fixture's changes-requested branch does not, so it turns the
loop on the *first* dissenting reviewer, exits the parallel state, prunes
the other reviewers' pending asks (`journal.js:208-217`), and hands the
implementer a partial report.
That contradicts the ask, so both branches here wait for the whole panel.

**Panel-size-agnostic quorum.**
`makeJoinEvent` zero-seeds `counts` with every top-level final state name
of the region chart (`machine.js:581-591`), so "everyone approved" is
`{ changesRequested: M.eq(0), pending: M.eq(0) }` — no `M.gte(2)`, no
panel-size literal to drift out of sync with `params.reviewers`.
The public params pattern nevertheless requires at least one reviewer and caps
the panel at 32 seats, preventing both a vacuous unanimous result and unbounded
fan-out from one run.

**The budget is bounded at the public boundary.**
An initial run requires one through `2**32 - 1` review rounds; later absolute
adjustments admit zero through the same upper bound.
This is a deliberate four-byte profile for a human review-loop quantity, keeps
the chart's number-valued `$inc` arithmetic exact, and rejects negative,
non-finite, and oversized inputs before a run starts or a port signal lands.
`base` is required because every implementer and reviewer ask names it.

**A silent reviewer cannot wedge the run.**
Waiting for all seats costs a full panel round per dissent, so each seat
carries its own `after` deadline that settles it as a changes-requested
verdict.
Reviewer failure (`verdict-failed`) settles the same way.
A withheld approval is never a silent one.

**`exhausted` is not final.**
A final state is terminal and cannot be resumed from, so a run that spent
its budget parks in a *waiting* state that asks the operator for more
rounds and also accepts an out-of-band `set-remaining`.
Only an explicit 0 (or a week's silence) reaches `abandoned`.

**Every ask answer has a total handler.**
The engine fails a run whose settlement fires no transition
(`service.js:605`), so a malformed submission, an unreachable developer,
and a developer deadline each have an explicit candidate.
All three cost a round, which is what bounds a developer that cannot
produce a well-formed submission — the budget does double duty as a
liveness bound.
A reviewer answer must carry both a boolean `approve` and string `feedback`;
an incomplete or malformed answer becomes an explicit changes-requested
verdict instead of failing the run during feedback assignment.

**Preview CI is a slot, not a stage.**
`params.previewCi` gates it through the same emit trick as the budget, so
a deployment with no CI performer never names one, and enabling CI later
is a params change rather than a chart change.
Red CI costs a round and returns the report to the implementer, exactly
like a dissent.

## Gating the proposal, structurally

The requirement is that the host not propose a workflow until the reviews
have finished.
Enforcing that in host code would make it a convention — one refactor away
from being wrong.

Instead the gated variants `spawn` their deploy chart from `proposing`,
and `proposing` is reachable only along `review ─▶ ready ─▶ (preview ─▶)
proposing`.
The deploy chart's own `await-approval` — the operator form that **is**
the proposal — therefore cannot be raised before the panel has settled.
The test asserts this from the rendered graph rather than from a walk:
`ready` has exactly one inbound edge and it is the unanimous-approval
join; `preview` has exactly one and it is from `ready`; nothing reaches
`proposing` from `implement`, `review`, `gate`, or `exhausted`.

A spawn passes only the endowments it names (`service.js:1062` — omitting
the list passes *none*, not all), so the panel's reviewer endowments
deliberately do not cross into the deploy child.
The child gets `performer` and `operator` and nothing else.

## What blocks a live run

**A Fae agent cannot answer a workflow ask.**
This is the blocking gap for the whole system, and it is two defects:

1. The message loop reconstructs text only for `type === 'package'`;
   every other type becomes the literal string `` `(${type} message)` ``
   (`packages/fae/agent.js:511-521`).
   A workflow ask arrives as a `request` or a `form`, so its
   `description` — the entire task — is discarded before the model sees
   it, and the user node it builds then says `Use reply(messageNumber: N,
   ...)`, which is the wrong verb.
2. `reply()` posts a **new package message** to the sender; it does not
   settle the request's resolver (`packages/daemon/src/mail.js:921` vs
   `:799`).
   The workflow's ask promise never settles and the run waits forever with
   no error.

Fae's built-in tool set has no `resolve`, `reject`, or `submit` — only the
general-purpose `exec` escape hatch, through which an agent *could* call
`E(powers).resolve(n, name)` today, but unreliably.

The fix is Phase 2: branch the loop on `request` / `form`, put the
description (and form fields) into the user node, and add first-class
`resolveRequest` / `rejectRequest` / `submitForm` tools.
A **typed** verdict matters — the panel guards require `approve: boolean` and
`feedback: string`, and prose-parsing a verdict is the failure mode to avoid.

**`space-endo-mgmt` is not on the `llm` base.**
The source PR's version is not an invoke target either: its guards are
exact-arity (`M.call().optional(M.string())`) while the engine appends a
run-qualified `${runId}:${effectId}` key as the final argument
(`service.js:1038`), and its fire-and-forget methods would re-submit after an
at-least-once recovery dispatch.
A live integration needs a settlement-shaped, key-deduped performer rather
than carrying the hosted-management package into this chart-only port.

## Phases

- **Phase 1 (done).** The reviewed-change and prerequisite deploy charts,
  boundary hardening, structural-gate assertions, and simulator suites.
- **Phase 2.** Fae ask-answering: request/form rendering and the
  `resolveRequest` / `rejectRequest` / `submitForm` tools.
  Without this nothing but a human can close the loop.
- **Phase 3.** Host gating: reshape `space-endo-mgmt` into a
  settlement-shaped performer, mint the gated factories alongside the
  existing deploy factories in `floot-factory-setup.js`, and surface the
  live run (and its budget) in the Hosted Endo space.

## Open questions

- **Who may raise the budget.** `E(service).control(runId)` has no
  authorization check (`service.js:2138`), so holding the service is
  holding control over every run.
  A factory grants proposal-only start authority but cannot mint the
  `initiator` port, because `port(role)` hangs off `WorkflowControl`
  (`interfaces.js:64`).
  Whoever should be able to adjust a live limit needs one of the two, and
  the choice is not yet made.
- **The panel roster is fixed at start.** `$eachParam` selects the region
  list from params, and params are immutable after `started`
  (`journal.js:234`), so adding a reviewer mid-run means a new run.
- **Per-run workspaces.** Nothing today mints a git worktree per run,
  wraps it as a tool, and mails it to the developer agent.
  `EndoGuest` has no `provideMount` / `provideGitClone`, and Fae's fs
  tools are rooted at a frozen `FAE_CWD`.
- **Reviewer independence.** A Fae agent's transcript is a conversation
  tree chained across every inbox message for its whole life
  (`agent.js:172`), so a reused reviewer carries prior runs into its next
  verdict.
  Throwaway per-run agents are cheap, but `FaeFactory` has no
  `destroyAgent` and nothing reaps them.
- **A generic CI performer.** The slot exists; no capability fills it.
  `space-nixos-admin.prebuildRev` is the closest thing and is already
  inside `endo-release` v2.
- **Journal growth.** A review loop is far larger than a deploy run — asks
  and settlements per reviewer per round, plus feedback text in context —
  and terminal-run retention is still undefined.
