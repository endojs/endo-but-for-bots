# Ironhorse Panic: Uncatchable Termination and the Message Embargo

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Updated** | 2026-08-29 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

Name, formalize, and extend the **panic**: an uncatchable, unrecoverable
termination of a vat/worker that no JavaScript `try`/`catch`, promise handler,
or engine recovery path can intercept. Ironhorse substantially has this already.
`Halt::StackOverflow` and `Halt::MeterAbort`
([ironhorse-engine](ironhorse-engine.md) § Interpreter, the `Halt` enum in
`rust/engine/ironhorse-vm/src/interp.rs`) are each documented today as "an abort
to the host, not a catchable `RangeError`", and both descend from XS/xsnap's
`fxAbort` longjmp. This design gives the pattern one name, generalizes it over
every uncatchable-termination source, states its relationship to the daemon's
message-delivery model, and adds an opt-in mode (the Coda) that turns selected
reference errors into panics for post-mortem debugging.

## What is the Problem Being Solved?

A **crank** is the processing of one inbound delivery plus all resulting promise
jobs until quiescence ([daemon-xs-worker-metering](daemon-xs-worker-metering.md)
§ Crank lifecycle). A crank that aborts partway through, after it has already
sent some outbound messages but before it finishes, risks **hangover
inconsistency**: the classic partial-failure hazard (the E-language and KeyKOS
lineage, where a vat is the unit of partial failure) in which a crank's intended
effects are split, some observed by the outside world and some never applied,
leaving peers with a view the vat never actually reached.

The clean answer is a two-part contract:

1. A **panic** terminates the vat uncatchably: no in-vat code can catch it,
   suppress it, or continue past it, so the vat cannot half-run to a state a
   handler papered over.
2. A **message embargo** holds a crank's outbound messages until the crank
   commits, so a panic can **discard** them rather than releasing a partial set.
   Together these guarantee the vat dies with **no side effect escaping**, which
   makes the crank safely **retryable**: restore the worker from its last
   snapshot, replay the transcript up to but not including the panicking
   delivery, and re-run the (now fixed) delivery.

Ironhorse already terminates uncatchably for two of the three natural cases
(stack overflow, meter refusal). What is missing is (a) one formal concept that
unifies them and the net-new cases, (b) a per-worker write-ahead transcript that
makes embargo, restart, and replay one durability contract, (c) treatment of
host calls and their restart-sensitive handles as transcript messages, and (d)
the debugger's treatment of a panic versus an ordinary uncaught throw. This
design supplies all four, then adds the reference-error Coda.

## Scope: What Is Already a Panic (the required first step)

Surveying the `Halt` enum (`interp.rs`) against the panic definition yields
three buckets. This is the design's starting inventory, not an invention from
nothing.

| `Halt` variant | Uncatchable abort-to-host today? | Panic classification |
|---|---|---|
| `StackOverflow(usize)` | **Yes**: its doc says "an abort to the host, not a catchable `RangeError`, a deterministic, consensus-relevant limit". XS's `fxOverflow` -> `fxAbort(XS_JAVASCRIPT_STACK_OVERFLOW_EXIT)`. | **Already a panic.** Reclassify under the formal concept; no behavior change. |
| `MeterAbort` | **Yes**: the meter host refused more computation; XS's `XS_TOO_MUCH_COMPUTATION_EXIT` via `longjmp`. The metering design already destroys the worker on this. | **Already a panic.** Reclassify; no behavior change. |
| `Throw(String)` | No: this is the JS-level throw. Empty `jumps` means it escapes every JS handler and reaches the host, but it is *catchable in principle* (a `catch` above it intercepts it). | **Not a panic.** It is the ordinary (possibly uncaught) throw. Kept distinct; see § Debugger interaction. |
| `Decode(String)` | Yes: truncated/invalid bytecode; the loader must not continue. | **Panic-adjacent.** A corrupt-input abort; group it with panics for the "terminate, do not commit" decision, though its provenance (a bad snapshot or buggy compiler) is a supervisor-level fault, not guest behavior. |
| `StepLimit(u64)` | Yes, but only on the un-metered fuzz path (never on `Interp::run`). | **Panic-adjacent (harness only).** Not reachable in production; grouped for completeness. |
| `Yield`/`Await`/`Return` | No: normal control-flow suspension/completion. | **Not panics.** |

Net-new panic sources (no existing `Halt` variant, added by this design):

- **Rust-level logic-bug panic.** A wrong index reaching a kind-checked arena
  accessor `panic!`s the machine thread. [ironhorse-engine](ironhorse-engine.md)
  § Minimizing `unsafe` already states the intended treatment: "a panic is a
  crashed crank, not a compromised daemon", which the supervisor "already treats
  as worker death". This is mechanically different from a `Halt` value (it
  unwinds the Rust thread rather than returning) but is the *same concept* at the
  supervisor boundary. See § Formal category for the seam that unifies them.
- **Reference-error panic (opt-in).** The Coda's configuration, off by default.

**Conclusion of the scope step:** the mechanism exists for two of three natural
cases and needs *naming and generalizing*, not building. The genuinely new
engineering is the formal category (small), the per-worker write-ahead
transcript and embargo, transcript-aware host calls, and the Coda.

## The Formal `Panic` Category

The requirement is one concept that answers a single supervisor question at the
crank boundary: *did this delivery terminate the vat uncatchably, so its effects
must be discarded rather than committed?* Three shapes were considered (see
§ Alternatives). The recommendation keeps the rich diagnostic `Halt` variants
and adds classification, rather than collapsing them:

1. **Keep the informative variants.** `StackOverflow(usize)` carries the slot
   overshoot; `MeterAbort` marks meter refusal; `Decode(String)` names the
   corruption. Collapsing them into one opaque `Panic` would destroy the
   diagnostics the supervisor and debugger need.
2. **Add a grouping predicate** on `Halt`:
   `fn is_panic(&self) -> bool`, true for `StackOverflow | MeterAbort |
   Panic(_)` (and, on their respective paths, `Decode | StepLimit`). This is the
   one place the "terminate, do not commit" set is defined.
3. **Add one `Halt::Panic(PanicKind)` variant** for net-new sources that have no
   existing variant: `PanicKind::Host` (a caught Rust panic, converted into this
   `Halt` at the thread/FFI boundary so the supervisor sees a value rather than a
   process abort) and `PanicKind::ReferenceError` (the Coda). Extensible.
4. **Surface a three-way `CrankOutcome` at the `Machine` seam.** The interpreter
   keeps returning `RunOutcome { halt, .. }`; the `Machine`/supervisor seam
   ([ironhorse-engine](ironhorse-engine.md) § Endor integration) classifies each
   `halt` into `Committed` | `Uncaught(throw)` | `Panicked(reason)`. The commit
   decision reads only this three-way value; the `reason` carries the underlying
   `Halt` for reporting.

```mermaid
graph TD
    RUN["Interp::run -> RunOutcome { halt }"]
    RUN --> RET["Halt::Return"]
    RUN --> THR["Halt::Throw (jumps empty)"]
    RUN --> SO["Halt::StackOverflow"]
    RUN --> MA["Halt::MeterAbort"]
    RUN --> DEC["Halt::Decode"]
    RUN --> PAN["Halt::Panic(kind)"]
    RUST["Rust panic!"] -->|catch at thread/FFI boundary| PAN
    RET --> C["CrankOutcome::Committed"]
    THR --> U["CrankOutcome::Uncaught"]
    SO --> P["CrankOutcome::Panicked(reason)"]
    MA --> P
    DEC --> P
    PAN --> P
    C -->|release embargoed messages| COMMIT["commit crank"]
    U -->|escaped throw: report, then terminate| U2["worker death (still no partial commit)"]
    P -->|discard embargoed messages| DISCARD["worker death, crank retryable"]
```

Note the seam that surfaces `CrankOutcome` is **prospective**: today
`ironhorse-vm`'s `Halt` is consumed by the oracle/fuzz harnesses and by direct
`Machine::evaluate`/`eval` callers (rendered by `describe_halt` into
`EvalOutcome` in `rust/endo/src/ironhorse_engine.rs`), while the production daemon
still runs C-XS through the `xsnap` crate. The panic-to-supervisor surfacing rides
on the not-yet-complete `-e ironhorse` engine-selection integration
([ironhorse-engine](ironhorse-engine.md) § Endor integration, roadmap stages
8/9). The interpreter-side classification (items 1-3) is landable now; the
`Machine`-boundary `CrankOutcome` (item 4) lands with that integration, and it is
the point where an Ironhorse `Halt::Panic` and the XS `"terminated"` meter report
(two separate mechanisms today) become one supervisor-visible worker death.

## The Message Embargo Contract

This is the part that must be grounded in the daemon's *real* current behavior,
because the daemon deliberately chose a mechanism the naive reading of "embargo"
would reinvent.

### What the daemon does today: admission control, not embargo

[daemon-xs-worker-metering](daemon-xs-worker-metering.md) (status **Complete**)
§ "Admission Control Eliminates Embargo" records an explicit maintainer decision.
An earlier revision proposed embargoing outbound messages per crank and
discarding them on abort; it was **rejected as too complex** (buffering in the
bridge layer, crank-boundary delimiters, reasoning about partial effects). The
shipped model instead **pre-pays the worst case**: the supervisor delivers a
message only when the worker's remaining budget exceeds the full per-crank hard
limit, so any crank that completes normally was already fully paid for and never
needs rollback. The design states the consequence in one line: **"No embargo, no
rollback, no buffering of outbound messages."** The single partial-effect case
it acknowledges is hard-limit `MeterAbort` termination, and its answer is that
this "destroys the worker anyway".

So the literal "message embargo" of this design's premise is, for the
**meter-exhaustion** case, *already handled* by a different and simpler
mechanism. A design that asserted a fresh per-crank embargo-and-discard buffer
would re-introduce exactly what the maintainer removed.

### Where admission control does not reach, and what the survey found

Admission control eliminates the *meter-exhaustion* partial-effect case, and
only that case, because pre-payment is about **budget**. It does nothing for a
panic that aborts a well-budgeted crank partway through:

- `StackOverflow` fires on a crank with ample budget.
- A Rust logic-bug panic fires regardless of budget.
- The Coda's reference-error panic fires regardless of budget.

For these, the hangover question turns entirely on **whether outbound messages
have already left the vat when the panic fires.** A survey of the live crank
path (the XS worker in `rust/endo/xsnap/src/lib.rs`, whose main loop carries
literal `// ---- Crank start ----` / `// ---- Crank end ----` markers) settles
it, and the answer is the *unfavorable* one:

- **There is no per-crank commit point.** The only thing that crosses the
  crank-end boundary is `send_meter_report`; nothing snapshots, journals, or
  commits per delivery.
- **Outbound messages leave immediately, mid-crank.** When guest JS sends out,
  it calls the host functions `host_send_frame` (`sendFrame`),
  `host_issue_command` (`issueCommand`), or `host_send_raw_frame`
  (`sendRawFrame`) in `worker_io.rs`, each of which calls
  `WorkerTransport::send_frame`/`send_raw_frame` **synchronously, writing straight
  to the pipe/channel**. There is no queue and no hold-until-crank-end. Only
  *debug* output is batched (`flush_debug_outbound`), not message traffic.
- **A meter-aborted or crashed worker just dies and is unregistered.** The abort
  path (`metering_callback` -> `XS_TOO_MUCH_COMPUTATION_EXIT`, caught in
  `run_promise_jobs_metered`, reported as `send_meter_report(steps,
  "terminated")`) leads the supervisor's `process_meter_report` to `unregister`
  the worker. **Its already-sent messages stay sent.** There is no rollback and
  no auto-restart.

So the premise's "implicit embargo" does **not** exist today. Even `MeterAbort`,
which the metering design calls the one partial-effect case, leaks its
already-sent messages; the metering design tolerates that only because it treats
a hard-limit abort as a non-retryable runaway (an infinite loop) whose
consistency nobody cares about. The moment a panic is meant to be **fixed and
retried**, those escaped messages become exactly the hangover inconsistency the
embargo exists to prevent, and admission control gives nothing here.

### Per-worker write-ahead transcript

The absence of a transcript makes panic recovery unsound, so the transcript is
part of this design rather than a follow-on. Each endor worker owns
`<endo-dir>/workers/<handle>/transcript.sqlite`, opened in WAL mode. A database
per worker avoids a global writer lock between vats and confines corruption and
recovery to one vat. The database contains four logical records (the physical
schema may normalize payloads into side tables):

| Record | Durable content |
|---|---|
| `snapshot` | Snapshot identity, engine/callback-table signature, and the last committed transcript sequence represented by the snapshot. |
| `crank` | Monotonic crank id, inbound-delivery sequence, starting snapshot epoch, and `started` / `committed` / `aborted` state. |
| `event` | Ordered inbound messages, outbound messages, host-call requests, and host-call replies. Every event has a crank id and sequence number; outbound and host-effect events also have a stable idempotency key. |
| `host_handle` | Logical handle id, the host-call event that created it, a durable reconstruction descriptor, and open/closed state. The guest heap stores the logical id, never an OS file descriptor or native pointer. |

The worker supervisor is the only writer. Its crank protocol is:

1. In one short transaction, append the inbound delivery and a `started` crank
   row, then sync the WAL before entering the guest. The inbound message is
   therefore recoverable even if the worker process dies immediately.
2. Route `sendFrame`, `issueCommand`, and `sendRawFrame` into pending `event`
   rows instead of the transport. Route transcript-aware host functions through
   the same event writer, durably recording a request before invoking its host
   adapter and its reply afterward. Nothing outside the vat observes pending
   outbound rows.
3. On `CrankOutcome::Committed`, mark every pending event and the crank committed
   in one transaction. Only after that transaction is durable may the supervisor
   release outbound messages, in sequence order. Each released frame carries its
   stable event sequence so the receiver can discard a duplicate if the
   supervisor crashes after send but before recording the acknowledgement.
4. On `CrankOutcome::Panicked` or `CrankOutcome::Uncaught`, discard the staged
   outbound payloads, close tentative native handles, and mark every event and
   the crank aborted. The original inbound row remains available for diagnosis
   and an explicit retry, but none of the crank's outbound effects become
   releasable.

The synchronous `send_frame` methods in `worker_io.rs` are the existing
chokepoint to replace with step 2. The literal crank-start/crank-end markers in
the XS main loop supply the scope. For Ironhorse's store-backed machines,
`HeapStore::commit` and the transcript crank commit share the worker's SQLite
transaction; a committed heap epoch can never name an uncommitted transcript
suffix or vice versa. A CAS snapshot uses the same rule indirectly: commit its
CAS identity and transcript watermark together, then compact events at or below
that watermark. WAL checkpointing is lifecycle maintenance, not the logical
crank commit.

This contract supersedes admission control only where admission control is
insufficient. Pre-payment remains the quota gate. The transcript and embargo
cover stack overflow, host failure, Rust panic, reference-error panic, and
restart, none of which pre-payment makes atomic.

### Host functions are messages too

An XS snapshot preserves callback-table positions but not the native resources
behind callbacks: file descriptors, directory streams, sockets, timers, and
database cursors die with the worker incarnation. Consequently every host
function that reads nondeterministic state, performs an effect, or returns an
open handle participates in the transcript exactly like a vat message:

- Before invocation, append its canonical request, crank id, call sequence, and
  idempotency key. A read-only or tentative-local adapter may run during the
  crank; append its canonical reply or failure before returning to the guest.
  Replay checks the request byte-for-byte and returns the recorded reply instead
  of invoking the adapter again.
- A handle-producing reply returns a logical `host_handle` id. Its durable
  descriptor records enough authority and position to reconstruct the native
  resource (for example, a file capability plus offset and open flags). On
  restart the host re-seats that logical id before replay reaches its first use.
  Every subsequent operation on the handle is another request/reply event, so
  reads, writes, seeks, close, and errors replay in the original order.
- A transactional local effect joins the worker SQLite crank commit. A
  non-transactional external effect cannot run synchronously inside the crank:
  the host records it as an outbound message and invokes it only after commit,
  using the event id as the provider's idempotency key. Any reply returns as a
  later inbound message and therefore starts another crank. Idempotency closes
  the crash-after-commit/send-before-ack window; it does not make an effect from
  an aborted crank acceptable.
- A non-transactional provider without idempotency is not admissible to a
  retryable vat. Its adapter must first gain an idempotency protocol or declare
  a snapshot barrier and make panic recovery stop for operator intervention.
- A resource with no reconstruction descriptor (an unresumable live socket is
  the canonical example) cannot masquerade as restored. Its handle is re-seated
  as broken, and replay/retry remains stopped until the adapter supplies a
  replacement under the same logical id or the application handles a new
  delivery that reports the loss.

Pure host functions need no events. The callback registry marks each function
`pure`, `transcripted-read`, `transactional`, `outbound`, or `barrier`; startup
rejects an unclassified callback for a retryable worker. This makes the restart
rule auditable instead of relying on each callback author to remember that
native handles do not survive a vat restart.

## Termination and Retry

Retry composes the existing suspend-to-snapshot / resume-from-snapshot machinery
of [daemon-debug-worker-restart](daemon-debug-worker-restart.md) with the new
per-worker transcript. Snapshot restore supplies the checkpoint; transcript
replay supplies every committed crank after it.

Sequence from panic to recovery:

```mermaid
sequenceDiagram
    participant Sup as Supervisor
    participant W as Worker Ironhorse
    Sup->>W: deliver message N, admission gate passed
    W->>W: crank runs, buffers outbound
    W-->>Sup: PANIC from StackOverflow, MeterAbort, Rust panic, or ref-error
    Note over Sup: CrankOutcome is Panicked, so discard N outbound, no side effect escaped
    Sup->>Sup: mark worker dead, do NOT commit crank N
    Note over Sup: fix lands as code, config, or external condition change
    Sup->>W: resume fresh machine from last snapshot, pre-N
    W->>W: replay committed transcript through delivery N-1
    W->>W: re-seat logical host handles from durable descriptors
    Sup->>W: re-deliver message N, now succeeds
```

During replay, the supervisor delivers only committed inbound events after the
snapshot watermark. Outbound sends and host calls must match the next recorded
event; the supervisor suppresses recorded outbound sends and returns recorded
host replies. A kind, payload, order, or handle-id mismatch is a deterministic
replay fault and stops recovery. When replay reaches the end of the committed
suffix, the machine is at the state immediately before the aborted delivery.
The supervisor then exits replay mode and may retry that pending delivery after
the named fix is present.

The current daemon has only coarse snapshot suspend/resume: `handle_suspend` ->
`Machine::suspend_to_cas` and `handle_resume` -> `resume_shared` /
`resume_process`. Implementing the transcript adds the required suffix-replay
loop and periodic snapshot policy to that path. A successful snapshot records
its committed-event watermark before older events are compacted. Events for open
logical handles remain reachable through `host_handle` reconstruction records
even when the crank events that created them fall below the snapshot watermark.

A second gap the survey surfaced: today the XS `XS_TOO_MUCH_COMPUTATION_EXIT`
path and `ironhorse-vm`'s `Halt::MeterAbort` are **two separate, unjoined
mechanisms**. `ironhorse-vm`'s `Halt` values reach only direct
`Machine::evaluate`/`eval` callers (rendered by `describe_halt` into
`EvalOutcome` in `rust/endo/src/ironhorse_engine.rs`); they do not reach the
supervisor, because `ironhorse_engine` is not on the delivery path. The
`CrankOutcome` seam (§ Formal category) is where the two are joined: it is the
point at which an Ironhorse `Halt::Panic` becomes the same supervisor-visible
worker-death that the XS `"terminated"` meter report is today.

### What "fixed" means in practice

"Fix and retry" is not one thing; the panic source determines it:

| Panic source | What "fixed" is | Can the same snapshot be retried unmodified? |
|---|---|---|
| Reference error / application logic bug | A **code change** to the guest bundle, producing a new snapshot/build. | No. The same bundle deterministically re-panics. |
| Rust engine logic-bug panic | An **engine fix** (new Ironhorse build). | No. Same engine deterministically re-panics until fixed. |
| `MeterAbort` (hard limit) | Usually a **config change** (raise the quota) or a code change (the crank was genuinely too expensive / looping). | **Yes, if config**: after a quota raise, re-delivering N against the same snapshot can succeed. The metering design treats hard-limit abort as a probable infinite loop, so this is the rarer path. |
| `StackOverflow` | A **code change** (bound the recursion), new snapshot. Or, if the depth was input-driven, an **external-condition change** (different input on re-drive). | **Sometimes**: unmodified retry helps only when the triggering input differs on re-delivery; identical input re-overflows deterministically. |

So the three modes the premise anticipates all occur: new-snapshot fixes
(application/engine bugs), config-change retries of the same snapshot
(`MeterAbort` after a quota raise), and external-condition retries of the same
snapshot (input-dependent overflow). The panic contract is the same in every
case; only the fix differs.

## Debugger Interaction

A panic must be **distinguishable from an ordinary uncaught throw** in the
debugger's model, so the recovery-and-uncaught classifier
([ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md))
is not left to guess.

### Panic is not an uncaught throw

The two are categorically different, and Ironhorse already encodes the
difference structurally:

- An **uncaught throw** is `Halt::Throw` with `self.jumps.is_empty()` (the
  recovery-and-uncaught design's exact predicate). It is uncaught *by
  circumstance* (no `catch` happened to be above it); had a `catch` been present,
  it would have been caught. The debugger reports it as an **exception**, and the
  `uncaughtExceptions` pseudo-breakpoint with the `caught="0"` classification
  (that design's § Protocol) is precisely about it.
- A **panic** is uncatchable *by category*. It never consults `jumps` at all;
  even a `catch` directly enclosing the panic site cannot intercept it. It is not
  a throw and must not flow through the exception-break classifier.

Therefore a panic needs its **own break reason and wire message**, distinct from
`<break ... caught="...">`. Recommendation: a distinct
`<panic kind="stack-overflow|meter-abort|reference-error|host" .../>` echo (or a
`reason="panic"` attribute on `<break>`), reported on the always-fatal path and
never gated by `setExceptionBreakMode`. The exception-break modes (`none`,
`uncaught`, `all`) govern **throws**; they say nothing about panics, and a panic
must surface even under `setExceptionBreakMode('none')`.

### Should a panic be debuggable? Yes: stop the world at the panic site

When a debugger is attached, a panic should **stop the world at the panic site**
rather than tearing the worker down immediately. This is the whole diagnostic
value: the machine is frozen with the program counter pointing at the fault,
before the worker-death teardown discards it. The interaction with
`setExceptionBreakMode` is: **orthogonal**. Panic-break is its own control, not a
fourth exception mode. Concretely:

- **No debugger attached:** a panic tears the worker down immediately per
  § Termination and retry (discard, die, retry).
- **Debugger attached:** the panic hook stops the machine at the panic site and
  emits the `<panic>` wire message; the developer can inspect frames and take a
  snapshot (a snapshot here captures the machine *at the fault*, which is exactly
  what the Coda exploits). Releasing the debugger then proceeds to the normal
  teardown; the crank is still discarded, never committed.
- This reuses the same single dormant branch the stepping and throw hooks already
  established (the recovery-and-uncaught design's § Cost when disarmed); a panic
  is far rarer than a `line` opcode, so the disarmed cost is nil and the armed
  cost is one hook call on the dying path.

## Coda: An Option to Panic on Reference Errors

Propose an Ironhorse **configuration option, off by default**, under which an
engine-raised **reference error** panics instead of throwing. Concretely the two
`interp.rs` sites:

- `XS_CODE_GET_LOCAL_1`/`_2`: `Halt::Throw("get: not initialized yet")` (a
  read of a `let`/`const` binding in its temporal dead zone).
- `XS_CODE_GET_VARIABLE`/`XS_CODE_GET_THIS_VARIABLE`:
  `Halt::Throw("get <name>: undefined variable")` (an unresolved name).

Under the option these become `Halt::Panic(PanicKind::ReferenceError)` at the
same sites.

**Motivation.** A heap snapshot taken at the panic captures the machine with the
program counter pointing **directly at the error**, before any unwind, `catch`,
or promise-rejection handler has run to obscure the fault site, even when a
`catch` or rejection handler *would* otherwise have intercepted the error and
continued past it. That is the diagnostic trade: normal catchable-`ReferenceError`
semantics are given up in exchange for the ability to freeze and inspect the
exact moment of failure. It is a debugging build/config, never the default.

### Interaction with the debugger design's engine-raise-unwind prerequisite

[ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md)
§ Prerequisite requires the **opposite** direction for these same sites: to make
break-on-uncaught work, engine-raised errors (including "undefined variable")
must start **unwinding through the jump chain as catchable throws**, via a single
`raise(&mut self, msg) -> Halt` helper that routes through `unwind_to_jump`,
replacing the inline `return Halt::Throw(...)`. The Coda points the same sites at
a panic instead of a throw. These are not in conflict; they are **two settings of
one switch** at the raise seam:

- **Normal build/config (default):** the reference-error sites call `raise(..)`,
  which unwinds through `jumps` and is catchable. This satisfies the debugger
  design's uncaught-mode prerequisite unchanged.
- **panic-on-reference-error (opt-in):** the reference-error sites return
  `Halt::Panic(PanicKind::ReferenceError)` and never consult `jumps`. The error
  never becomes a throw at all, so the uncaught classifier never sees it (it is
  not in the throw population), and no `catch` can intercept it.

Because the switch lives **at the raise helper**, adding the Coda does not
perturb emitted bytecode and so does not threaten the port's byte-identity
acceptance bar (the same reason the debugger design preferred a target-opcode
peek over a `flag == 2` compiler change).

### Where the switch lives, and both-active behavior

- **Location: a `Machine` construction option** (a field set at machine
  create/resume), not a build feature and not a per-call flag. Rationale: a build
  feature is too coarse (it would flip the whole fleet, and the reference-error
  panic is a per-worker diagnostic choice), while a per-worker construction
  option mirrors how debug is enabled per worker
  ([daemon-debug-worker-restart](daemon-debug-worker-restart.md)'s `debug-flag`
  set before resume). A `raise` seam reads the option once per raise.
- **Both an attached debugger and panic-on-reference-error active at once:** the
  reference-error site takes the panic path (it is not a throw), so it stops the
  world at the fault site via the panic hook (§ Debugger interaction), *not* via
  the exception-break classifier. This is strictly the intended behavior: the
  developer wanted to freeze at the exact reference-error PC before any unwind,
  and the panic path delivers exactly that. The `uncaughtExceptions`
  pseudo-breakpoint is inert for these errors while the option is on, because
  they are no longer throws. Turn the option off and the same errors revert to
  catchable throws that the uncaught classifier sees normally.

## Alternatives Considered

- **A single opaque `Halt::Panic` replacing `StackOverflow`/`MeterAbort`.**
  Rejected: destroys the per-source diagnostics (overshoot count, meter refusal,
  decode message) the supervisor and debugger need. Classification over retained
  variants is strictly more informative at negligible cost.
- **Admission control without a transcript or embargo.** Rejected: pre-paying
  the meter prevents quota exhaustion in an admitted crank but does not make a
  stack overflow, Rust panic, reference-error panic, or host effect atomic.
- **One global transcript database.** Rejected: unrelated vats would contend on
  SQLite's writer lock and share one recovery/corruption domain. One database per
  worker keeps the commit order local to the vat.
- **A plain append-only log per worker.** Viable, but rejected for the first
  implementation. SQLite WAL supplies transactions across crank state, event
  rows, snapshot watermarks, and handle descriptors, plus indexed replay and
  compaction without a second recovery protocol.
- **A mode *attribute* on the exception breakpoint for panics.** Rejected for the
  same reason the debugger design rejected a mode attribute: the xsbug parser
  discards unknown attributes byte by byte, so it degrades to silent no-op. A
  distinct `<panic>` element (or a new pseudo-path) degrades safely instead.
- **A build feature for panic-on-reference-error.** Rejected: too coarse for a
  per-worker diagnostic; a `Machine` construction option is per-worker and
  composes with debug-enable.

## Open Questions

- Should `Decode` and the harness-only `StepLimit` be inside `is_panic()`, or
  kept out because their provenance is supervisor/harness rather than guest
  behavior? Leaning: inside for the commit decision (both must terminate without
  commit), but reported with their own reason so a corrupt-snapshot decode is not
  read as a guest fault.
- Should a `MeterAbort` that is genuinely a quota-exhaustion (not an infinite
  loop) be a **pause-and-refill** rather than a panic, given admission control
  already prevents mid-crank budget exhaustion for normally-admitted cranks? The
  metering design's answer is "terminate"; this design does not reopen it, but
  the `CrankOutcome` seam leaves room for a future pause outcome distinct from
  `Panicked`.
- The `Machine`-boundary `CrankOutcome` surfacing depends on the `-e ironhorse`
  engine-selection integration, which is roadmap stage 8/9. Landing the
  interpreter-side classification earlier is fine, but the supervisor cannot act
  on a panic until that seam exists. To be filed as a dependency note on the
  integration work rather than blocking this design.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Supplies the `Halt` enum, the `StackOverflow`/`MeterAbort` abort-to-host precedent, the "a panic is a crashed crank" framing (§ Minimizing `unsafe`), and the `Machine` / `-e ironhorse` integration seam that surfaces `CrankOutcome`. This design names and generalizes what that design left as scattered `Halt` variants. |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | **Load-bearing.** Its admission-control decision already handles the meter-exhaustion partial-effect case and explicitly rejected a per-crank embargo; this design reconciles the panic contract with that decision rather than reinventing embargo. |
| [daemon-debug-worker-restart](daemon-debug-worker-restart.md) | The suspend-to-snapshot / resume-from-snapshot machinery the retry path composes; the per-worker `debug-flag`-before-resume shape the Coda's construction option mirrors. |
| [ironhorse-debugger-recovery-and-uncaught](ironhorse-debugger-recovery-and-uncaught.md) | Supplies the throw/uncaught classifier (`jumps.is_empty()`), the `raise` engine-unwind prerequisite the Coda toggles against, and the break/report model a panic must be distinguished within. The Coda's switch lives at that design's `raise` seam. |
| [daemon-xs-worker-debugger](daemon-xs-worker-debugger.md) | The consumer contract (`<break>`/`<panic>` wire messages, `DebugSession`, `setExceptionBreakMode`) the panic break reason extends. |
| [ironhorse-snapshot-store-seam](ironhorse-snapshot-store-seam.md) | Supplies the per-worker SQLite `HeapStore::commit` / `CheckpointBatch` durability primitive. A store-backed worker commits its heap epoch and transcript crank in the same SQLite transaction. |
| [ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) | Supplies the landed snapshot-plus-journal-suffix, stable frame sequence, duplicate-suppression, and replay-window precedent. This design applies that recovery envelope to endor vats and extends it to host-call messages and logical handles. |

## Prompt

> Design a panic mechanism for the Ironhorse engine (endojs/endo-but-for-bots,
> roadmap branch `llm`). A panic is an uncatchable, unrecoverable termination of
> a vat/worker that no JS `try`/`catch`, promise handler, or engine recovery can
> intercept. Paired with a message embargo (outbound messages held until the
> crank commits; a panic discards them) it mitigates hangover inconsistency, so a
> panicking crank can be fixed and retried by restoring from the last snapshot and
> replaying the transcript up to but not including the panicking delivery.
> `Halt::StackOverflow` and `Halt::MeterAbort` already behave this way, built on
> XS's `fxAbort`. Confirm and scope which existing paths are already a panic, then
> name/generalize/extend the concept rather than bolting on a parallel mechanism.
> Specify: a formal `Panic` category; the message-embargo contract grounded in the
> daemon's real crank/commit machinery (cite the real commit point, do not assume
> one); termination and retry building on `debugWorker`, including what "fixed"
> means; the debugger interaction (how a panic differs from an uncaught throw, and
> whether a panic is itself debuggable, with the `setExceptionBreakMode`
> interaction). Coda: propose an off-by-default option under which a reference
> error (the `XS_CODE_GET_LOCAL` and variable-lookup `Halt::Throw` sites) panics
> instead of throwing, so a snapshot captures the PC at the fault before any
> unwind; name its interaction with the debugger design's engine-raise-unwind
> prerequisite, where the switch lives, and what happens if both a debugger and
> panic-on-reference-error are active. Where the embargo/crank-commit mechanics
> need their own follow-on design once the daemon's actual behavior is surveyed,
> say so in Open Questions rather than asserting an unverified mechanism.
