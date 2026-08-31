# Ironhorse: Panic-on-Reference-Error, and Its Relationship to Unhandled/Unwatched Rejection Handling

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Author** | endolinbot (prompted) |
| **Status** | Proposed |

Ironhorse is the Rust reimplementation of the XS JavaScript engine (the xsnap
lineage that Endo's guests run on); `ironhorse-vm` is its interpreter crate. This
is a rationale/analysis document, not an implementation spec. It argues why an
Ironhorse option to **panic on a reference error** (freeze the world at the fault
site so a heap snapshot can be taken with the program counter still there) is
worth building, and it situates that option against the other tools that claim to
catch *silently dropped* failures, chiefly Node.js's escalate-on-unhandled-rejection
behavior. It ends in a concrete recommendation for a future design or build job to
act on.

It is a sibling to **`design-ironhorse-panic`**, the design of the panic
mechanism itself. That document is not yet on the `llm` branch as of this
writing; the panic option it proposes is summarized here from its brief (*an
Ironhorse option under which a reference error panics instead of throwing, so a
heap snapshot can be taken with the program counter still at the fault site*).
This document takes that mechanism as given and reasons about **why** it matters
and **how** it changes the calculus for rejection handling. Whoever lands
`design-ironhorse-panic` should add the reverse cross-link into its
Dependencies/related-designs table (see § 4 and § 5).

## 1. Why panic-on-reference-error matters

A reference error (reading an undefined variable, or touching a
still-uninitialized temporal-dead-zone (TDZ) binding) is a **bug in the
program**, not an expected control-flow event. In Ironhorse these are
engine-raised errors: `ironhorse-vm`'s `XS_CODE_GET_VARIABLE |
XS_CODE_GET_THIS_VARIABLE` ("undefined variable") and `XS_CODE_GET_LOCAL_1 |
XS_CODE_GET_LOCAL_2` ("get: not initialized yet") build a
`Halt::Throw(...)` today (the literal match-arm identifiers in
`rust/engine/ironhorse-vm/src/interp.rs`; the `|` here is Rust's *or-pattern*
("either of these two opcodes"), not a bitwise-OR of them) (see [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
§ Prerequisite). (`Halt` is `ironhorse-vm`'s Rust enum of interpreter stop
outcomes: the ways a running program can halt, whether an ordinary catchable
throw, a non-recoverable resource abort, or an unsupported-operation bail.)
Because they are ordinary catchable throws, the surrounding program (deliberately,
or far more often by accident) can swallow them:

```js
try { doWork(timeuot /* typo: bare variable */); } catch (e) { retry(); }
```

Here the mistyped **bare variable** `timeuot` raises a `ReferenceError`
(precisely the engine-raised error panic-on-reference-error intercepts), and the
`catch` silently turns it into a retry loop. (A mistyped *property* access,
`config.tiemout`, is a **different** bug this design does *not* address: it reads
as `undefined` and raises nothing at all, so no mechanism here (panic or tracker)
catches it. That is an acknowledged, unaddressed gap, revisited in § 2's
synchronous-swallow caveat; the example above is deliberately the bare-variable
case, the one the mechanism actually resolves.) By the time anyone notices (minutes, or many messages, later)
the interpreter has unwound through the `catch`, the activation that raised the
error is gone, and the heap has moved on. **Unwinding through a `catch` (or a
promise rejection handler) before anyone inspects the failure destroys the single
most useful piece of evidence: the exact program counter and heap state at the
moment of the fault.** A post-hoc log line or a re-thrown wrapper is a photograph
of the scene after the body has been moved.

Panicking on the reference error instead **freezes the world at the fault
site**. The program counter still points at the faulting opcode; the activation
record (the interpreter's per-function-call frame: its locals and bookkeeping),
the operand stack (the working stack the bytecode pushes and pops intermediate
values on), and the live handler chain are all intact; the heap
is exactly as the bug left it. A snapshot taken here (Ironhorse snapshots are
nearly structural over the index-arena heap, see
[ironhorse-engine](ironhorse-engine.md) § Value and heap model) captures a
debuggable image of the defect *in situ*, and it does so **even when a `catch`
or rejection handler exists and would otherwise have intercepted the throw**.
That last clause is the whole point: the option is valuable precisely in the
case where normal catchable semantics would have hidden the bug.

**Contrast with the halts that already have this property.**
`Halt::StackOverflow` and `Halt::MeterAbort` are already non-recoverable by
construction: `ironhorse-vm` models both as an *abort to the host*, not a
catchable `RangeError`. That is a deliberate, documented choice in the
xsnap lineage (`interp.rs`, the `Halt::StackOverflow` doc comment: *"an abort to
the host, not a catchable `RangeError`"*; and see
[ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
§ The classifier). Stack exhaustion and meter exhaustion therefore already
freeze at the fault site for free: no `catch` can intercept them, so a snapshot
is always taken with the program counter where the resource ran out.

A reference error is **the odd one out today**: same "the program is broken and
should not continue" character, but ordinarily recoverable, so it leaks past the
snapshot boundary the other two enjoy. The panic option is exactly what lets a
reference error be *treated the same way* (non-recoverably, frozen for
diagnosis) **on demand**, without making every `ReferenceError` in every
program fatal by default. It brings the odd one out into line with
`StackOverflow`/`MeterAbort` for the class of run where catching the bug at its
source matters more than limping forward.

The option is deliberately opt-in: production guest code legitimately relies on
`ReferenceError` being catchable (feature-detection shims, optional-global
probes). Panic-on-reference-error is a **diagnostic mode** a supervisor arms for
a suspect worker or a reproduction run, not a language change.

## 2. Interaction with unhandled and unwatched rejection

The reference-error panic is one answer to a general question: *how do you
surface a failure that the program never usefully observed?* The other prominent
answer in the ecosystem is the **unhandled-rejection heuristic**: flag (or
escalate on) a promise that rejected and that "nobody handled." The two are not
competitors on equal footing; understanding why requires being precise about
what a promise rejection actually guarantees.

### A promise can always be handled later

Every promise (whether it is *already* rejected or will *eventually* reject)
can still be validly handled by a `.then`/`.catch` (or an `await`) subscribed
**after the fact**. "Not handled yet" is a statement about the present moment;
"will never be handled" is a claim about the entire future. Any policy that
treats the two as equivalent is **making a timing guess, not observing a fact**.
The only fact available at any instant is "no handler is attached *right now*";
promoting that to "this rejection is abandoned" is inference, and the inference
is routinely wrong for perfectly ordinary code that attaches its handler a turn
or a tick later.

Call a rejection **unwatched** while no handler is yet subscribed to it. Unwatched
is a live, transient status. It should *end* the moment a handler attaches, not
harden into a verdict.

A note on vocabulary, since this document sits among siblings that spell the
concept differently. Node, the XS oracle functions
(`fxAddUnhandledRejection`/`fxCheckUnhandledRejections`), and the project's
existing designs
([ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md),
[unhandled-rejection-display](unhandled-rejection-display.md)) all say
**unhandled**. This document deliberately says **unwatched** instead: the same
promise, the same phenomenon, renamed to foreground that "no handler *yet*" is a
live, retractable status rather than a settled verdict (the whole thesis of § 2).
Read the two as synonyms for one concept: wherever a sibling document or the XS
substrate says "unhandled rejection," this document (and any tracker it
recommends, see § 5 Open Question 1) says "unwatched rejection." The rename is
intentional and is carried through even to the terminal report surface; the XS
oracle names are kept only because they are the literal C symbols being mirrored.

### This is especially sharp over CapTP

Ironhorse runs guests that speak `@endo/eventual-send` and CapTP (the
capability-transfer protocol Endo guests use to send messages between isolated
object graphs; each such graph is a **vat**, a single-threaded event-loop
container of objects, and the peer graph on the other end of a CapTP connection
is the **far side**). There, a
promise is frequently **handed off**: returned from an eventual-send (`E(x).m()`),
passed as an argument, or resolved into another vat's reference graph. Under
**promise pipelining**, messages are sent to a promise *before it resolves*, and
the promise's eventual settlement is commonly owned by the **far side**, because
the promise returned by `E(x).m()` stands in for a *result the far side has yet to
compute*, so it is the far side's delivery of that result (or its failure to) that
ultimately settles the promise, not any local turn. The
whole point of the handoff is that *someone else now holds the obligation to
observe and settle it*. A local "nobody subscribed here yet" check cannot see
across the CapTP boundary. It has no way to distinguish (a) a promise
**legitimately handed off** to a peer that owns its resolution from (b) a promise
**genuinely dropped** on the floor locally.

Both look identical to a local observer: no local handler is attached. Treating
the first as an error would flag the *normal, intended* shape of distributed
object-capability code. (Ironhorse's own promise-reaction throw path is not even
implemented yet: it self-names `Halt::Unsupported("promise:handler-throw")`;
see [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
§ Ironhorse Decisions item 3. So any rejection accounting that Ironhorse grows must
be designed with the CapTP handoff case as a first-class citizen, not bolted on.)

### Node.js's escalation is exactly this heuristic, and gets both cases wrong

Node.js's `unhandledRejection` -> `--unhandled-rejections=throw` behavior *is* the
"nobody subscribed yet, so abandoned" timing guess, wired to process death. It is
wrong in both directions:

- **False positive on deferred handling.** A rejection that is `await`ed or
  `.catch`ed a tick later can crash the process in the window before the handler
  attaches. The program was correct; the heuristic killed it.
- **No concept of handoff at all.** Node has no notion of "handed off to a peer,
  not ours to observe." Over CapTP that is not an edge case (it is the common
  case), and Node's model simply cannot represent it.

State it plainly: **escalate-on-unhandled-rejection is bad practice as a general
default.** It converts a timing guess into a fatal action, and it has no vocabulary
for the object-capability handoff that Endo/Ironhorse guests depend on.

### But it is defensible in the *absence* of a precise mechanism

The heuristic is not stupid; it is *blunt*. In an engine that has **no precise
way** to catch a real class of bugs at their source, an unhandled-rejection
timeout is the **only available tool** for surfacing *some* silently-dropped
failures. It is a smoke detector that also goes off when you make toast: hated,
but in a house with no other alarm, occasionally the thing that saves you. Its
false-positive cost (killing processes over legitimately-deferred or
legitimately-handed-off promises) is a price people have paid because nothing
sharper existed.

**A clarification the rest of this section depends on: there is no
escalate-on-unhandled-rejection mechanism live in Ironhorse today to "retire."**
The always-on *escalator* discussed here is **Node's** (`--unhandled-rejections=throw`),
not something this codebase runs. Ironhorse's own promise-reaction path is not
even implemented (`Halt::Unsupported("promise:handler-throw")`, cited above), and a
tree-wide search finds no `--unhandled-rejections=throw` anywhere. What the project
*does* already run for rejections is **report-only**, in two independent places:
SES's `makeRejectionHandlers` (`packages/ses/src/error/unhandled-rejection.js`),
wired into `lockdown()` as `unhandledRejectionTrapping: 'report'` (the default) and
therefore likely already running above every SES-shimmed Ironhorse guest; and
`packages/daemon/src/worker.js`'s own `process.on('unhandledRejection', ...)`
handler, which records a trace and never escalates. So when this document says
"retire the timeout," it means **preventively**: *do not* adopt Node's escalation
into Ironhorse in the first place, and *do not* let a stopgap escalate-on-a-timer
ship before an always-on reporter exists: a design-time guardrail for whoever
builds an engine-level tracker, **not** the removal of a timeout Ironhorse
currently has. The "always-on" swap below is a swap of *Node's* always-on escalator
(were it ever inherited) for an always-on reporter of the shape the project already
favors.

The reference-error panic, together with the existing
`StackOverflow`/`MeterAbort` aborts, changes that calculus. Once a real class of
bug (reference errors, stack exhaustion, meter exhaustion) is caught **precisely,
at its exact source, with the heap frozen for inspection**, the coarse
rejection-timeout heuristic is no longer the only alarm in the house for that
class. It stops pulling its weight, and its false-positive cost stops being worth
paying.

One caveat must be stated plainly here, not left implicit in an appendix, and it
must not be overstated. Panic-on-reference-error is **opt-in and diagnostic**: a
supervisor arms it for a suspect worker or a reproduction run. Node's
unhandled-rejection timeout (the always-on escalator this document argues against
inheriting) is **always-on**. The two therefore do
*not* have the same default coverage. `StackOverflow` and `MeterAbort` genuinely
are always-on and do close their part of the gap by default.

Be precise about *what* the always-on timeout ever covered, because it is easy to
over-claim here. The unhandled-rejection timeout fires only on **promise
rejections**; it has never observed a reference error swallowed by a *synchronous*
`try`/`catch` at all. § 1's lead example is exactly that synchronous case
(`try { doWork(config.tiemout); } catch (e) { retry(); }`, with no promise
anywhere). That bug has **no** always-on net today and never did: Node's timeout could not
see it (no promise is created), and the report-at-terminal-boundary tracker
recommended below (Recommendation 3) likewise accounts only for *rejections*, so
it cannot see it either. For the synchronous-swallow class, the **armed panic is
the only tool**, exactly as it is today; retiring the rejection timeout takes
nothing away from it, because the timeout never covered it. This document does not
claim otherwise, and a reader must not read § 2 as promising always-on coverage
for synchronously-caught reference errors: there is none, and the recommendation
does not create one.

Where the always-on story *does* hold is the **rejection** manifestation of a
dropped failure. There, retiring the timeout is a swap of one always-on mechanism
for another: an always-on *reporter* (a report-at-terminal-boundary tracker,
Recommendation 3 below) replaces the always-on *escalator*, keeping visibility of
genuinely-abandoned rejections while dropping the fatal false-positive. This
document therefore recommends retiring the always-on timeout only in favor of that
always-on reporter, not in favor of an on-demand diagnostic alone. A follow-on
design or build job reading this section should scope that tracker (Open
Question 1) as load-bearing, not optional; the residual *rejection* coverage the
recommendation promises depends on it. The synchronous-swallow class remains,
honestly, covered only when the panic is armed.

### Recommendation

**Endo/Ironhorse should not adopt Node's escalate-on-unhandled-rejection
behavior**, and should treat *not* carrying it forward as a concrete goal to
reach once the panic mechanism lands, rather than inheriting Node's heuristic by
default and then trying to tune its false-positive rate. Concretely:

1. **Never escalate an unwatched rejection to a fatal abort on a timer.**
   A rejection with no handler *yet* is not an error condition; over CapTP it is
   frequently the intended shape. Ironhorse must not kill a worker (or a crank: a
   single turn of a vat's event loop, processing one delivered message)
   because a promise has not been observed within some window. This is a
   *preventive* stance, not a migration: no escalate-on-a-timer runs in Ironhorse
   today (§ 2's clarification), so the caution is against ever *adding* one, and
   in particular against shipping a stopgap escalate-on-a-timer as a placeholder
   ahead of Recommendation 3's always-on reporter. Were such a stopgap ever
   prototyped, sequencing would matter: removing it *before* the always-on
   reporter exists would leave an unattended worker with neither alarm for
   genuinely-abandoned rejections, strictly worse; build the reporter first. The
   simplest way to honor that ordering is to never build the stopgap at all.

2. **Do surface reference errors (and exhaustion) via the precise mechanisms.**
   Panic-on-reference-error catches the accidental-swallow bug at its source;
   `StackOverflow`/`MeterAbort` already catch exhaustion. This is where the
   diagnostic budget should go.

3. **For genuinely-abandoned rejections, prefer *visibility* over *escalation*.**
   There is still real value in knowing that a rejection reached end-of-turn (or
   drain, or worker exit) with no handler ever attached and no outstanding
   handoff. That is the closest an engine can honestly get to "abandoned."

   Be honest that this *is* still an inference, not a fact, of the same shape § 2
   warns against: absence-of-handler-at-a-checkpoint promoted to a verdict. A
   promise handed off to a peer that later drops it would still read as "no
   outstanding handoff visible locally" at local drain or exit. The difference
   from Node's timer is one of degree and of consequence, not of kind.

   Report-at-terminal-boundary is defensible where escalate-on-a-timer is not,
   because of an asymmetry on two axes. First, a terminal boundary is the
   **most-deferred** checkpoint available (the promise has had every earlier turn
   to acquire a handler), so it is the least-wrong moment to look. Second, and
   crucially, the recommended response is to **report**, never to kill, so a
   residual false positive costs a spurious diagnostic line rather than a dead
   worker.

   The right response is to **report** it, the way XS (the C engine Ironhorse
   reimplements) accumulates unhandled rejections in a weak list and reports them
   at drain/exit (`fxAddUnhandledRejection` / `fxCheckUnhandledRejections`; see
   [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
   § Ironhorse Decisions item 3), **not** to abort. Note that "report" covers two
   distinct surfaces with different temporal shapes: a one-shot **batch** report
   at the terminal boundary (the XS weak-list-at-drain/exit shape, the always-on
   production diagnostic scoped by Open Question 1), and the **live, reactive**
   debugger panel of § 3 (continuously updated, retracting an entry the instant a
   handler attaches, scoped by Open Question 2). They serve different audiences
   (an unattended production worker versus an interactive debugging session), and
   the follow-on work splits them accordingly; satisfying one does not satisfy the
   other. The distinction the recommendation draws is: *stop flagging* deferred
   and handed-off rejections as errors, and *keep reporting*, never escalating, the
   residue that truly reaches a terminal boundary unobserved. Rendering of such a
   reason should reuse the project's diagnostic discipline (`passableAsJustin` /
   the `renderRejection` helper from
   [unhandled-rejection-display](unhandled-rejection-display.md)), so an `Error`
   reason is legible rather than `{}`.

The throughline: **reference-error panic gives the developer precise, timely
information at the fault site; the unhandled-rejection timeout gives a coarse
guess minutes later.** Where the precise tool exists, prefer it; where only the
residue at a terminal boundary is left, report it without pretending "unobserved
so far" means "abandoned forever."

## 3. Debugger note: reactive visualization panels

For the Ironhorse worker debugger's web UI (the same surface as the
[ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
work), carry two **reactive** panels that make promise state legible and live.
These are the debugger-side answer to the same problem the reference-error panic
answers for engine-raised errors: give the developer precise, timely information
instead of a coarse timeout guess.

- **Pending promises**, attributed to the **line and column where each was
  created**: a "where did this promise come from?" view. The attribution point
  is creation site, so a promise stuck pending has a source location, not just an
  opaque identity.
- **As-yet-unhandled ("unwatched") rejections**, shown **live, until each is
  handled**, and attributed (like the pending-promises panel) to the **line and
  column where the rejected promise was created**, so "where did this go wrong?"
  gets the same precise creation-site answer from both panels. Critically, this
  panel is *reactive*: a rejection that later gets a handler attached must
  **visibly leave the panel** rather than stay flagged. That behavior is exactly
  the "can still be handled later" property § 2 argues Node's heuristic ignores,
  encoded as UI. The panel shows current unwatched status as a fact, and retracts
  it the instant the fact changes, instead of freezing a timing guess into a
  persistent accusation. For that per-entry retraction to be well-defined, a panel
  **entry is keyed by the rejected promise's own identity**, with the creation-site
  line/column carried as a **label** only, not the key. The distinction is
  load-bearing: a loop that creates many promises at one call site produces many
  distinct entries that happen to share a label, and attaching a handler to one of
  them must retract exactly that one, not the whole label group. Keying on
  creation-site instead would collapse siblings into one row and make single-entry
  retraction impossible to express. (How the feed supplies a stable per-promise
  identity, and whether the label should aggregate or list same-site siblings, is
  handed to Open Question 2.) Over CapTP, a rejection whose obligation was handed off
  *must* be distinguishable from one that is genuinely local-and-unobserved, so
  that the panel does not cry wolf over the normal distributed shape. This is a
  **requirement on the panel, not yet a solved property of it**: how the panel
  observes a handoff (and whether that is even observable from `ironhorse-vm`
  alone) is an open question (§ 5 Open Question 4), and an implementer inherits
  it as unresolved rather than as done.

Making this state visible and live is the debugger's contribution to the same
goal: precise, timely information over a coarse timeout.

## 4. Dependencies

| Design | Relationship |
|---|---|
| **`design-ironhorse-panic`** (sibling; *not yet landed*, expected at `ironhorse-panic.md`) | Designs the panic mechanism this document argues *for* and reasons *about*. This document takes that mechanism as given. Whoever lands it should add the reverse cross-link here. |
| [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md) | Establishes that promise-rejection tracking is **separate from** throw-time uncaught classification (§ Ironhorse Decisions item 3), that engine-raised reference errors currently build `Halt::Throw`, and that the promise-reaction throw path is unimplemented (`Halt::Unsupported("promise:handler-throw")`). The debugger panels here live alongside that design's web UI. |
| [ironhorse-engine](ironhorse-engine.md) | Supplies the `Halt` vocabulary (`StackOverflow`, `MeterAbort`, `Throw`), the abort-to-host semantics the panic option mirrors, and the index-arena heap that makes a fault-site snapshot nearly structural. |
| [unhandled-rejection-display](unhandled-rejection-display.md) | The diagnostic-rendering discipline (`renderRejection` / `passableAsJustin`) any rejection *report* should reuse. |
| `packages/ses/src/error/unhandled-rejection.js` (`makeRejectionHandlers`) | **Existing prior art** for the track-retract-report-at-terminal-boundary shape Open Question 1 recommends, already wired into `lockdown()` (`unhandledRejectionTrapping: 'report'`). A follow-on tracker must reconcile with or supersede it, not treat the mechanism as unbuilt. |
| `packages/daemon/src/worker.js` (`process.on('unhandledRejection', ...)`) | A **second, live report-only instance** in the actual host process that supervises Endo workers: it records a trace and never escalates. Strengthens § 2's claim that the project already leans report-over-escalate; the follow-on tracker's prior-art survey should cite it alongside `makeRejectionHandlers`. |
| `@endo/eventual-send`, `@endo/captp` | Establish the `E()` / promise-pipelining / handoff vocabulary § 2 relies on; a local "unhandled" check cannot see across the CapTP boundary. |

## 5. Open questions

Concrete follow-on work this analysis implies is named here rather than left
implicit; each needs its own design or build job.

1. **A rejection tracker for Ironhorse: what is its terminal boundary and its
   handoff-awareness?** This document recommends *reporting, never escalating*,
   genuinely-abandoned rejections, but Ironhorse has no rejection accounting today
   (the promise-reaction path is `Halt::Unsupported("promise:handler-throw")`). A
   follow-on **design job** (`design-ironhorse-rejection-tracker`, to be posted)
   should specify the weak-list-at-drain/exit mechanism (XS oracle:
   `fxAddUnhandledRejection`/`fxCheckUnhandledRejections`), and crucially how it
   distinguishes a CapTP **handoff** (obligation owned by a peer) from a genuinely
   local-and-abandoned rejection so it does not report the normal distributed
   shape. Is the terminal boundary end-of-crank, drain, or worker exit? Its own
   report and API surface should name this status **unwatched**, not
   **unhandled**, to carry forward the transient-status framing this document
   argues for (§ 2), even though the XS implementation substrate spells the oracle
   functions `fxAddUnhandledRejection`/`fxCheckUnhandledRejections`.

   **Prior art to reconcile with, not start blank from.** SES already ships a
   mechanism of exactly this shape one layer above Ironhorse:
   `makeRejectionHandlers` in `packages/ses/src/error/unhandled-rejection.js`
   tracks a rejection with no synchronous handler, **retracts** the tracking the
   instant a handler attaches later (`rejectionHandledHandler`, the same "can
   still be handled later" property § 2 argues for), and **reports, never
   escalates**, at a terminal boundary (dropped-promise GC finalization, or
   `processTerminationHandler` at agent-cluster termination). It is wired into
   `lockdown()` today via `unhandledRejectionTrapping: 'report'` (the default; see
   `packages/ses/src/error/tame-console.js`). Because Ironhorse's guests are
   SES-shimmed, this always-on reporter may already be running above Ironhorse.
   The follow-on `design-ironhorse-rejection-tracker` must therefore **reconcile
   with or explicitly supersede** the SES layer, deciding what an engine-level
   tracker adds over `makeRejectionHandlers` (e.g. creation-site attribution,
   CapTP-handoff awareness the SES layer lacks), rather than re-deriving the
   terminal-boundary and retraction questions as if they were unsolved. The
   residual-gap framing in § 2 is correspondingly narrower for *rejections* than a
   first read suggests: for the SES-shimmed rejection path, an always-on reporter
   may already exist.

   **Resolve the naming split, not just the mechanism.** This document renames the
   concept to **unwatched** for any new report/API surface (§ 2), but the
   already-shipped SES knob a developer actually types is spelled `unhandled`:
   `unhandledRejectionTrapping`. If the Ironhorse tracker's reports say "unwatched"
   while the config option that arms the SES-layer reporter stays
   `unhandledRejectionTrapping`, the *same concept* is spelled two ways depending
   on which layer you look at. The follow-on `design-ironhorse-rejection-tracker`
   must therefore decide the naming explicitly (rename the SES option, alias it,
   or justify keeping `unhandled` as the shipped public term with `unwatched` as
   internal/doc framing only) as part of the reconciliation, not just reconcile
   the tracking mechanics.

2. **How do the two debugger panels get their live feed from `ironhorse-vm`?**
   The pending-promises and
   unwatched-rejections panels need a live feed from `ironhorse-vm` to the web UI:
   promise creation events (with creation-site line/column), handler-attach
   events (to retract an entry), and settlement events. This is a **build job**
   that extends the `DebugHook` / `DebugCtx` seam from
   [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
   Part 1, and must hold that design's equal-computron-when-disarmed acceptance
   bar (a *computron* is Ironhorse's unit of metered execution cost; "equal
   computrons when disarmed" means the instrumentation must cost the metered
   program nothing when the debugger feed is off). Does the creation-site attribution require a new hook point, or can it
   ride the existing `line`-opcode seam?

3. **Should panic-on-reference-error be scoped narrower than all engine-raised
   `ReferenceError`s?** TDZ reads, undefined-global reads, and
   `delete`-of-unresolvable differ in how often they are *deliberately* provoked
   by feature-detection code. Resolving this belongs to `design-ironhorse-panic`,
   but it is flagged here because a too-broad panic scope would make the
   diagnostic mode unusable on real guest code. (Deferred to the panic design.)

4. **How does a handed-off rejection get marked as such for the debugger panel?**
   The unwatched-rejections panel should not flag a rejection whose obligation was
   handed off over CapTP. That requires the panel's data feed to observe the
   handoff (an eventual-send return, an argument pass, a cross-vat resolve). Is
   that observable from `ironhorse-vm` alone, or does it need a signal from the
   CapTP layer above? (Ties into Open Question 1.)

## 6. Prompt

> Discuss: why panic-on-reference-error matters, and how it interacts with
> unhandled/unwatched rejection handling. Argue that unwinding through a `catch`
> or rejection handler before anyone inspects the failure destroys the program
> counter and heap state at the fault site; that a promise can always be handled
> later (especially over CapTP, where a handed-off promise is not ours to
> observe); that Node's escalate-on-unhandled-rejection is exactly the
> nobody-subscribed-yet heuristic and gets both the deferred and the handed-off
> case wrong; that it is nonetheless defensible only in the absence of a precise
> mechanism; and recommend that Endo/Ironhorse not adopt it once the panic
> mechanism lands. Close with a debugger note for reactive pending-promise and
> unwatched-rejection panels. Sibling to `design-ironhorse-panic`; land as a
> draft PR against `llm`.

(endolinbot, prompted, 2026-08-17)
