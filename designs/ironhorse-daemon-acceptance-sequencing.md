# IronHorse: sequencing the deferred daemon acceptance scope

| | |
|---|---|
| **Created** | 2026-09-14 |
| **Updated** | 2026-09-14 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | Architecture review (`rust/engine/architecture-review/2026-09-06/ARCHITECTURE-REVIEW.md`), read against the scope fence in `rust/engine/PR-1263-TODO.md` |

## Status

Nothing here is implemented; this document is an ordering proposal, not a
record of work.

PR #1263 landed the Realm extraction, host-callable registration and an
explicit restore session, then fenced off what it had *not* established:
full daemon SES and worker-protocol acceptance.
This document reads that fence against the architecture review's 191
findings, names the fifteen that sit inside it, and puts them in the only
order their own dependencies allow.

**Read the statuses here, not the review's.**
The review's status columns stop at `1b130df7` (2026-09-08); PR #1263
landed on 2026-09-13.
Every finding below was re-verified against tree
[`65902a8f`](https://github.com/endojs/endo-but-for-bots/commit/65902a8f)
(2026-09-14) by reading the tree, not by carrying a status forward.
Where a re-verification contradicts the review, or contradicts this
document's own first draft, the row says so and shows its evidence.

## What is the Problem Being Solved?

The scope fence is written in three places, with slightly different wording
each time, and no single place says what it would take to clear it.

- `rust/engine/PR-1263-TODO.md` — "Multiple Realms, cross-machine messaging,
  and JsMachine (F068/F157) remain deferred. Full daemon SES acceptance is a
  separate acceptance bar, not implied by freezing."
- `designs/ironhorse-w6-decisions.md` §1 — "Full daemon SES acceptance and
  arbitrary host-function registration remain separate."
- `designs/ironhorse-engine.md:903`, the `daemon-endo-rust-sqlite`
  reconciliation row — "Daemon-specific powers still require service
  adapters and explicit restore policy."

The engine already states the same fence in code.
`run_worker` (`rust/endo/src/ironhorse_engine.rs:1503`) refuses by name and
scopes the gap precisely:

> what remains is exactly the deliver-payload side: the host-function
> surface … and the SES boot bundle (roadmap stage 4, Hardened JavaScript,
> whose acceptance bar is those bundles running identically on both engines
> — concretely the side-table ledger's HardenState/Modules/Functions rows).
> The transport loop itself … is mechanical once payloads can be
> interpreted; a private eval-shaped dialect would fake the protocol, so
> this stays a named gap.

What is missing is the ordering: which of the review's findings gate which,
and what may run in parallel.

## Findings in scope

Fifteen findings.
Three are open at HEAD, five partial, seven closed or landed — five of
those seven closed since this document's first draft read them as open work.

| Finding | Sev | § | State at `65902a8f` | Phase |
|---|---|---|---|---|
| F157 | medium | 3.13 | open — `Store(String)` survives verbatim | 0 |
| F068 | medium | 3.13 | open — no engine trait exists | 1 |
| F069 | medium | 3.13 | partial — VM half fixed, trait half cannot close before F068 | 1 |
| F159 | low | 3.13 | partial — `Realm` exists, rename outstanding | 1 |
| F056 | high | 3.14 | **closed** — zero bypass calls; locked by a source gate | 2 |
| F061 | high | 3.7 | **closed** — membrane equivalence asserted for 20 shapes | 2 |
| F062 | high | 3.7 | partial — compact notation still silently wrong | 2 |
| F054 (host leg) | medium | 3.14 | landed in #1263 | 3 |
| F144 | low | 3.7 | landed — `set_intrinsic_permit` | 3 |
| F155 | medium | 3.13 | **closed** — the review itself resolved it at `1b130df7` | 3 |
| F054 (SES leg) | medium | 3.14 | open — the leg that stays open | 4 |
| F059 | high | 3.7 | partial — the seam is built, the assertion is not | 4 |
| F127 | low | 3.9 | partial — `FromAsync*` residue only | 5 |
| F033 | high | 3.11 | **closed** — the verbatim-API claim is gone from the design | 6 |
| F156 | medium | 3.13 | **closed** — `ironhorse-snapshot/src/versions.rs` is the document | 6 |

F072 is listed under *Already clear* below rather than given a phase: the
"explicit restore policy" clause of the fence is the one part of it that
PR #1263 discharged outright.

### What the re-verification changed

Five rows moved, and one of the five moves the shape of the whole plan.

**F056 and F061 are closed, so Phase 2 is discharged.**
`designs/ironhorse-2a-property-mop-completion.md` — which names F056 and
F061 in its first line — landed the property/MOP seam completion.
At HEAD the four bypass helpers the review counted have no calls at all:
`instance_get`, `instance_has`, `instance_put` and `resolve_get` survive
only as eight prose mentions in comments
(`interp/dispatch/property_read.rs:223`,
`interp/dispatch/environment.rs:104` and `:184`, `interp/function.rs:428`,
`interp/link.rs:328`, `interp/persist.rs:295`, `interp/dispatch.rs:475`,
`interp/dispatch/environment.rs:140`), and no definitions remain.
The seam is now a three-tier lattice — `boot_chain_get` for boot and
restore (`interp/property/ordinary.rs:790`), `ordinary_get`/`ordinary_set`
private to the property module, `mop_*` for everything guest-reachable —
and it is mechanically locked, not merely conventional:
`raw_property_reads_are_confined_to_boot_restore_and_mop`
(`ironhorse-vm/tests/property_mop_seam.rs:139`) token-scans every `.rs`
file under `ironhorse-vm/src` and fails the build if any of the four names
reappears, if `ordinary_*` escapes `interp/property{,/}`, or if
`boot_chain_get` is called outside its four-file allowlist.
F061's recommended membrane test exists too:
`transparent_membranes_preserve_property_operations` (`:100`) compares
`ownKeys`, `getOwnPropertyDescriptor`, `get`, `has`, `set` and `delete`
between `x` and `new Proxy(x, {})` across the twenty representative shapes
the finding asked for.

The consequence is stated plainly because the first draft of this document
staked Phase 4's honesty on it: the sentence "`harden()` works, forty-seven
sites route around it" is **no longer true of this tree**.
Phase 2 is not a track, it is a residue.

**F155 was never partial.** The review's own last status line reads
"**RESOLVED** since the previous revision. This finding no longer describes
the tree; do not act on it", and Appendix A's `1b130df7` column reads
`fixed`.
This document's first draft carried the `c14706d3` reading by mistake.
HEAD confirms the resolution: `HeapStoreCommit` (`store.rs:1650`) provides
a non-overridable `commit` through a blanket
`impl<S: HeapStore + ?Sized>` (`:1679`), `commit_verified` is the required
method (`:1737`), and all three production backends plus the sqlite backend
implement only the medium-specific write
(`store.rs:3267`, `store_file.rs:570`,
`rust/endo/ironhorse-store-sqlite/src/lib.rs:991`).

**F062 is the only survivor of its phase, and it is not a confinement
finding.** `notation: 'compact'` is still admitted
(`interp/natives/intl.rs:1191`, mapped at `:1336`) while
`compute_notation_exponent` (`intl_number.rs:937`) folds
`Notation::Compact` into `Notation::Standard`'s zero exponent,
`PartType::Compact` (`:175`) is declared and never constructed anywhere in
the crate, and `Grouping::Min2` requires `Notation::Standard` (`:841`).
`Intl.NumberFormat('en',{notation:'compact'}).format(12345)` therefore
renders an ungrouped `12345` where the spec wants `12K`.
That is a guest-visible wrong value at an oracle-blind surface — XS ships
no Intl — but nothing in the confinement boundary now depends on it.

**F156 has its compatibility document, so Phase 6 loses half its content.**
The finding's own words are "no compatibility document and no `versions.rs`".
`rust/engine/ironhorse-snapshot/src/versions.rs` exists at HEAD, is a public
module (`lib.rs:34`), and is exactly the document asked for: it names each
identifier's owner, what it gates, and its bump rule — `COST_TABLE_VERSION`
and the appended `releases::PINNED` procedure, `IRONHORSE_FORMAT_VERSION`
and its `_MIN_READ` range, `STORE_SCHEMA_VERSION` and `migrate_store`,
`ROW_SCHEMA_VERSION` and its release ledger, `INTL_DATA_VERSION` and its
generated ICU binding — plus a closing "Upgrade consequence" section stating
outright that old-meter heaps cannot resume by migrating schema alone.
It also disposes of the finding's count: `PARSE_METER_RELEASE` is recorded
there as "an alias of `COST_TABLE_VERSION`, not an independent counter"
(and the tree agrees, `ironhorse-compile/src/meter.rs:5`), while
`ROW_SCHEMA_VERSION` (`ironhorse-vm/src/snapshot_api.rs:11`) has since been
added, so the population is five again but enumerated rather than scattered.
Two of the bump rules are CI-enforced, not merely written:
`scripts/check-row-schema.py` and `scripts/intl-profile.py` both run in
`.github/workflows/ci.yml` (`:710`, `:711`, `:718`).

**F033's documentary half closed in #1263 itself.**
The finding's evidence is `designs/ironhorse-engine.md` asserting that the
seven-method `Machine` metering API is "preserved verbatim … without
supervisor changes", and the reconciliation row declaring
`daemon-xs-worker-metering`'s metering API "unchanged".
Neither survives: the strings "preserved verbatim", "without supervisor
changes", `begin_metering`, `set_crank_limit` and `current_computrons` no
longer occur anywhere in the design, and `17fe3122` rewrote the
reconciliation row, which now reads
"Ironhorse owns `Meter`, `MeterBounds` and per-crank reports … these are
separate Rust entry points, **not the XS metering API**" (`:900`).
That is the amendment F033's Fix asked for, applied.
What is left at `:903` is not F033's defect but Phase 6's forward
obligation: the `daemon-endo-rust-sqlite` row still says daemon powers
"require service adapters and explicit restore policy", which Phase 3 makes
false.

## Phased implementation

The fifteen were two tracks when this document was drafted.
They are one track now.
Track B — `interp.rs` property paths — is discharged except for F062, which
gates nothing, so the critical path runs straight through `rust/endo`:

```
┌───────────┐   ┌──────────────┐   ┌───────────────┐   ┌─────────────┐
│ 0. Type   ├──►│ 1. Engine    ├──►│ 3. Host       ├──►│ 4. SES bar  │
│    errors │   │    trait     │   │    adapters   │   └──────┬──────┘
└───────────┘   └──────────────┘   └───────────────┘          │
                                                              ▼
              ┌──────────────┐                         ┌─────────────┐
  (no gate) ─►│ 2. Intl      │  (gates nothing)        │ 5. Envelope │
              │    residue   │                         └──────┬──────┘
              └──────────────┘                                ▼
                                                       ┌─────────────┐
                                                       │ 6. Reconcile│
                                                       └─────────────┘
```

The SES bar is still the long pole, but for a different reason than the
first draft gave.
It is no longer waiting on a second track to converge; it is simply the
largest single phase, and it now sits behind three sequential predecessors
with nothing able to run beside them.

### Phase 0 — Type the error channel

**Gate:** none. This is the coupling everything else attaches to.
**Size:** M — 2-3 developer days.

- **F157** [medium, high] §3.13, open at HEAD; every coordinate below was
  re-read, and the two the first draft cited are still exact.
  `MachineError::Store(String)` (`ironhorse_engine.rs:58`) and
  `format!("{e:?}")` (`:854`) flatten the `StoreError` taxonomy into one
  opaque string, at seven construction sites (`:854`, `:1108`, `:1254`,
  `:1318`, `:1368`, `:1372`, `:1455`).
  Transient I/O (retry), deterministic refusal (never retry) and a poisoned
  session (tear down) are indistinguishable at the only boundary that can act
  on them.
  Named by ID in the #1263 deferral.

  Two details have drifted from the review and neither weakens the finding.
  `StoreError` now carries **fourteen** variants
  (`ironhorse-snapshot/src/store.rs:114-178`), not the sixteen the review
  counted, and it still derives only `Debug, PartialEq, Eq` — there is no
  `Display` and no `std::error::Error` impl anywhere in either workspace, so
  `{e:?}` is the only rendering available to the seam.
  Separately, `MachineError::Unavailable(String)` (`:54`) already exists,
  which is the variant Phase 1's trait needs; the work is to make `Store`
  its equal, not to invent the vocabulary.

**Why first.** F068's trait signature has to carry this error type.
Extract `JsMachine` over a stringly-typed channel and the review's own
prescription for the trait — "leaving the verbs it cannot yet serve as
explicit `Err(Unavailable)` so the gap stays named and typed" — becomes
untypeable.
Doing it afterwards is a breaking change to a trait that by then has two
implementors.

**Cost.** Contained and mechanical: `Display` + `Error` on `StoreError`, a
`StoreFailure { Transient, Refused, Poisoned }` classifier beside the
variants, `Store { kind, source }` in place of `Store(String)`, and a
distinct `MachineError::Poisoned { during, source }` for the rewind sites.
The one non-mechanical cost is the tests that match on the flattened string:
`ironhorse_engine.rs:1556` asserts
`Err(MachineError::Store(message)) if message.contains(…)` and has to become
a match on the classifier.

**Clears:** nothing on its own. It is the coupling, not a car.

### Phase 1 — Extract the engine seam

**Gate:** Phase 0 — the trait's error type must already exist.
**Size:** L — 1-1.5 developer weeks.

- **F068** [medium, high] §3.13, open at HEAD.
  Verified: the only traits in `rust/endo/src` are `HttpClient`
  (`fetch.rs:153`) and `GitCas` (`git_cas.rs:105`).
  `xsnap::Machine` exposes twenty-nine public methods
  (`rust/endo/xsnap/src/lib.rs`, three `impl Machine` blocks);
  `PersistentMachine` exposes nine (`open`, `meter_bounds`, `eval`,
  `collect`, `failed_collections`, `epoch`, `heap_store_path`, `flush`,
  `close`).
  `-e ironhorse` is still a string match with no trait behind it
  (`rust/endo/src/bin/endor.rs:84` and `:144`).
  The review's impact line is the whole argument for this phase: "The
  supervisor cannot spawn, meter, admission-gate, suspend or resume an
  Ironhorse worker at all."
  Named by ID in the #1263 deferral.
- **F069** [medium, high] §3.13, residue.
  The VM half is fixed — `pub fn has_pending_jobs` (`interp.rs:2368`) and
  `pub fn run_promise_jobs` (`:2381`) are public again after having been
  deleted rather than exposed.
  What survives is only the clause that cannot close before F068: neither
  verb sits on a trait, because there is no trait.
- **F159** [low, high] §3.13, fold in.
  `Realm` now exists at `interp/realm.rs:6` and `Machine` owns exactly one
  (`compartment.rs:51`), so the reconciliation the finding asks for is a
  rename plus a trait impl on the type that owns an `Interp`, not a
  redesign.
  `ironhorse_vm::Machine` (`compartment.rs:807`) still occupies the design's
  `Machine` name.

**Order within the phase.** `xsnap::Machine` first — the review is explicit
that this half is "mechanical and changes no behaviour" and is "what
actually caps the retrofit cost".
`PersistentMachine` second, with typed `Err(Unavailable)` for every verb it
cannot yet serve, so the gap stays an honest named skip rather than an
absence.
The twenty-nine-against-nine spread is the size estimate: the trait is
whatever subset the supervisor actually calls, and the review's own framing
("six methods against thirty") is a warning against copying the XS surface
wholesale.

**The W6 deferral expires here by its own terms.**
W6 decision 2 deferred this trait with three stated re-opening triggers.
One is "the worker protocol landing (it is the seam where the two types
would first have to answer the same calls)."
Sequencing the worker protocol fires that trigger, so this is not a reversal
of the decision — it is the decision executing.

**Clears:** the engine-side precondition for worker-protocol acceptance.

### Phase 2 — The Intl residue

**Gate:** none. Gates nothing. May be taken at any time, or dropped.
**Size:** S — 1 developer day to refuse; M if the CLDR patterns are
implemented instead.

This phase was the confinement track.
F056 and F061 closed it; see *What the re-verification changed* above for
the evidence and the source-level gate that keeps it closed.
What remains is one finding that shares the phase only by history.

- **F062** [high, high] §3.7, partial.
  Compact notation is admitted and silently ignored, as set out above.
  A confinement seam that returns a plausible wrong answer is worse than one
  that halts, and the project's own ethic already says so — but this
  particular seam is Intl formatting, not confinement, and the review's
  severity was assigned when it still travelled with the other two.

**The decision this phase needs.** Either refuse `notation: 'compact'` at
the option reader — a named skip, consistent with the doctrine, and the
reason this is sized S — or implement the CLDR compact patterns, which needs
locale data the crate does not carry and is therefore M at best.
Refusing is the recommendation: it converts a silent wrong value into a
loud one, which is the whole content of the finding, and it does not commit
the engine to shipping compact-pattern data it has no other use for.

**What it no longer clears.** The first draft of this document claimed this
phase was "the honesty precondition for any SES acceptance claim."
That is now false, and the correction matters more than the claim did: the
precondition was already met before this document was written.
Phase 4 may be measured without waiting for F062.

### Phase 3 — Daemon powers as service adapters

**Gate:** Phase 1 (verbs need a trait to sit on) and Phase 0 (adapters report
typed failures).
**Size:** L — 1-1.5 developer weeks.

- **F054 host-functions leg** [medium, high] §3.14, landed in #1263.
  `HostCallableId` (`interp/host.rs:8`), the `HostCallable` trait (`:75`)
  and `Machine::register_host_callable` (`compartment.rs:995`) — a
  Machine-owned registry keyed by stable name/ABI identity, with rooted
  captures and explicit restore policy, refusing a duplicate service by name
  (`host:duplicate-service`).
  At `1b130df7` the review still read "still no registration surface, no
  `HostCallable` trait and no host table".
  What the fence defers is the layer *above* it: sqlite, filesystem and
  network as adapters onto that registry.
- **F144** [low, high] §3.7, landed.
  `set_intrinsic_permit` (`interp.rs:2177`) is in the tree, exactly as
  prescribed.
  It stops being a separate fix and becomes the per-adapter policy surface:
  which powers a given compartment gets.
- **F155** [medium, high] §3.13, **closed — no work item here.**
  The finding was resolved before this document was drafted; the first draft
  scheduled it in error.
  The obligation it worried about is now a provided method the fourth
  backend cannot skip: a new adapter implements `commit_verified` and
  receives an already-verified batch, so the succession and geometry gate
  runs whether or not its author remembers it.
  It is retained in this phase's list because a daemon service adapter *is*
  the fourth backend the finding predicted, and the reader should know why
  that is no longer a hazard.

**Why L.** The XS side is the measuring stick: `rust/endo/xsnap/src/powers/`
is 2,640 lines across six modules (`fs.rs` 1,108, `sqlite.rs` 683,
`crypto.rs` 297, `debug.rs` 220, `process.rs` 146, `modules.rs` 125), and
the Ironhorse adapters have to cover the same ground over a different
registration surface.
That is squarely the README's L bucket (1,500-3,000 lines).

**Clears:** the "service adapters" half of the `daemon-endo-rust-sqlite`
reconciliation row.

### Phase 4 — Meet the SES bundle bar

**Gate:** Phase 3, and the bundle itself says so.
`host_aliases.js`'s header states that it "runs after host-power registration
and before the SES boot", and the names it aliases are the host powers
themselves — `hostReadFile` → `readFileText` from `powers/fs.rs`,
`hostSendRawFrame` → `sendRawFrame` from `worker_io.rs`.
The middle bundle of the three cannot run until Phase 3 has registered what
it aliases.
**Size:** XL — 2-3 developer weeks, research-heavy.

- **F054 SES leg** [medium, high] §3.14 — the leg that stays open.
  At `1b130df7` `Intrinsics` held a `BootTemplate` cache; the review's words
  are "a per-machine PRISTINE TEMPLATE CACHE, not a shared frozen primordial
  graph."
  At HEAD `locked_down` (`compartment.rs:36`) has a reader again
  (`is_locked_down`, `:41`) and `Realm` exists.
  The *state* is there. The *bar* is not.
- **F059** [high, high] §3.7, partial — and partial for a narrower reason
  than the review recorded.
  Requirement 5's per-compartment-globals-over-shared-frozen-intrinsics seam
  is **built** at HEAD: `MachineState` holds one `RefCell<Interp>` and one
  `Rc<Realm>` (`compartment.rs:48-53`), `Compartment::execute` borrows that
  single interpreter (`:673`) and activates the compartment's own
  environment inside it, and `Compartment::intrinsics` is documented as "the
  machine's shared frozen intrinsic graph" (`:458`).
  Intrinsic objects are therefore shared by identity, and globals are not.
  What is missing is the *assertion*, which is exactly what this phase is
  for.
  `nested_compartment_chains_shared_intrinsics_fresh_globals`
  (`compartment.rs:1739`) asserts the globals half by value and identity but
  asserts the intrinsics half only by `Rc::ptr_eq` on the `Intrinsics`
  marker — a struct of `roots: Vec<SlotIndex>` and `locked_down: bool` —
  never by guest-observable object identity.

  One artifact of the older arrangement is still in the tree and should be
  corrected as part of this phase, because it is the seam's own
  documentation contradicting the seam:
  `ironhorse-262/src/lib.rs:847-850` describes `shared_intrinsics` as
  "Marker identity only … each evaluation links the intrinsics into a fresh
  `Interp`, so no intrinsic *object* is shared", which has not been true
  since the Realm extraction.

**The bar, unchanged from roadmap stage 4.**
`polyfills.js` → `host_aliases.js` → `ses_boot.js` running identically on
both engines.
`designs/ironhorse-engine.md:37` still reads "4. Hardened JavaScript |
Partial — bar not met".
`run_worker`'s refusal names the measurable form: "concretely the side-table
ledger's HardenState/Modules/Functions rows."
That is the acceptance evidence to produce — not a green suite, those three
rows.

**Clears:** "full daemon SES acceptance," the clause the fence says freezing
does not imply.

### Phase 5 — Ship the worker envelope

**Gate:** Phases 1, 3 and 4. All three; no partial entry.
**Size:** L — 1-1.5 developer weeks.

- **F127** [low, high] §3.9, residue.
  Its Fix is not a code change but an ordering directive, and it is the one
  the review stated outright: land the async carries "before the worker
  envelope, or the envelope ships onto a seam that refuses its own workload."
  Mostly discharged, and further than the first draft of this document read
  it: `AsyncAwait` **and all three `AsyncGenerator*` kinds** are now on the
  persist-gate whitelist (`interp/persist.rs:562-573`), and the separate
  "any non-free `async_generators` owner" refusal is gone, so the daemon's
  central pattern — a vat suspended awaiting a host response — checkpoints,
  and so do async generators.
  Three refusals survive: `FromAsync*` (the four `Array.fromAsync` reaction
  kinds), a module graph that is active or heap-backed and not
  snapshot-admitted (`:509-518`), and any machine carrying the test262 `$262`
  host (`:539-541`).

**The `FromAsync*` decision: document the refusal, do not carry the rows.**
The first draft left this open. It is decided here.

`Array.fromAsync` in-flight state is a satellite: the gate's own comment
(`interp/persist.rs:542-552`) records that every in-flight accumulation is
anchored by exactly one `FromAsync*` reaction on a live promise and that an
unanchored entry is unreachable and compacted away, which is why refusing by
kind is the whole gate for it.
Carrying it means a new serialized side table, a new atom, a format bump, a
store-schema bump, a migration and its golden corpora — the cost the
`async_instances` carry actually incurred — for a builtin no daemon vat
pattern needs.
The reason the async carries were worth that price was named in F127's own
impact clause: a vat awaiting a host response is *the* daemon pattern.
A vat suspended inside `Array.fromAsync` is not.

So: state the limitation where an embedder meets it.
`PersistentMachine`'s doc comment (`ironhorse_engine.rs:745-778`) currently
describes cadence, relinking and the close contract and says nothing about
what a checkpoint refuses.
It should name all three surviving refusals — `Array.fromAsync` in flight,
a non-admitted host module graph, a `$262` machine — and say that each is a
fail-closed refusal by row name, not a silent partial save.
That is the half of F127's Fix that is not gated on anything, so it may land
before this phase; the phase only requires that it has landed by the time the
envelope ships.

**The work itself is already scoped, by the engine.**
`run_worker`'s refusal is precise about what remains: the CBOR envelope
transport loop, "mechanical once payloads can be interpreted; a private
eval-shaped dialect would fake the protocol, so this stays a named gap."
That last clause is the acceptance constraint — an eval-shaped shortcut
would clear the phase without clearing the bar.
The refusal's own text will need a pass here too: it says the host-function
surface "has [not] landed", which was true at `1b130df7` and is now true
only of the adapter layer Phase 3 builds, not of the registry beneath it.

**Clears:** "worker-protocol acceptance."

### Phase 6 — Reconcile the record

**Gate:** everything above. This phase may only *end* the sequence.
**Size:** S — 1-2 developer days.

Both findings that filed this phase are closed at HEAD; see *What the
re-verification changed* above.
The phase survives them because the obligation is not one-shot: the
reconciliation table is true of this tree and will stop being true the
moment Phases 1, 3 and 4 land.

- **F033** [high, high] §3.11, **closed.**
  The operational half was fixed at `2df18132` (the meter is armed on every
  production path).
  The reconciliation row was rewritten by `17fe3122`
  ("refactor(ironhorse)!: version the snapshot row boundary and reconcile the
  engine surface", 2026-09-13), which is PR #1263's item 7; the design-body
  claim is simply absent at HEAD, and this shallow clone cannot attribute its
  removal to a commit.
  Retained here only as the reason the table needs a scheduled pass rather
  than an ad-hoc one: F033 records what happens when a reconciliation is
  written ahead of its seams, and Phases 1-5 are precisely the seams this
  table describes.
- **F156** [medium, high] §3.13, **closed.**
  `ironhorse-snapshot/src/versions.rs` is the compatibility document, and
  two of its bump rules are enforced in CI.
  Retained here because Phase 4 and Phase 5 both bump identifiers it
  governs — a boot-fingerprint change from the SES bundle, and whatever the
  envelope's payloads cost the container format — and the document's
  procedure ("append a release, never replace a historical pin") is the
  thing to follow rather than rediscover.

**The work.** Three edits, all of them consequences of earlier phases and
none of them possible before those phases land:

1. `designs/ironhorse-engine.md:890` — "No shared trait makes the XS and
   Ironhorse supervisor APIs interchangeable" becomes false when Phase 1
   lands. So does `:898`'s "the full worker protocol and common engine
   abstraction are not wired".
2. `designs/ironhorse-engine.md:903` — the `daemon-endo-rust-sqlite` row's
   "Daemon-specific powers still require service adapters and explicit
   restore policy" becomes false when Phase 3 lands.
   This is the line this document's own source wording comes from.
3. `designs/ironhorse-engine.md:37` — stage 4's "Partial — bar not met"
   becomes the acceptance record when Phase 4 produces the
   HardenState/Modules/Functions rows, and the `ses-xs-parity` tag gated on
   stage 4 (`:839`) unblocks with it.
   Append the release entries `versions.rs` requires for any identifier
   Phases 4 and 5 move.

**Why last, specifically.** The review's complaint about F033 was not that the
table was badly written — it was that the table *asserted seams that did not
exist*.
Rewriting it before the seams exist reproduces the defect with fresher prose.
The table becomes true by Phases 1-5 landing, and then the edit is
bookkeeping.

**Clears:** the drift between the design cluster and the tree — prospectively,
not retrospectively.

### Sizing summary

Sizes use `designs/README.md` § Size and Time Estimates.
The review's own W-stream sizes do not map onto these phase boundaries, so
these are derived from the work each phase names, not carried over.

| Phase | Size | Estimate | Basis |
|---|---|---|---|
| 0. Type the error channel | M | 2-3 days | 14 `StoreError` variants gain `Display`/`Error`; one classifier; 7 construction sites; the string-matching tests |
| 1. Extract the engine seam | L | 1-1.5 weeks | A trait over two implementors; 29 `xsnap::Machine` methods against 9 on `PersistentMachine` and 8 on `ironhorse_engine::Machine`; an `Engine::Ironhorse` variant; typed `Unavailable` for the unserved verbs; the `Realm`/`Machine` rename |
| 2. The Intl residue | S | 1 day | One refusal at the option reader (M if the CLDR compact patterns are implemented instead) |
| 3. Daemon powers as service adapters | L | 1-1.5 weeks | sqlite, filesystem and network adapters onto an existing registry, each with its permit row and restore policy; `xsnap/src/powers/` is 2,640 lines over the same ground |
| 4. Meet the SES bundle bar | XL | 2-3 weeks | Roadmap stage 4; three bundles running identically on both engines, evidenced by the HardenState/Modules/Functions ledger rows; research-heavy |
| 5. Ship the worker envelope | L | 1-1.5 weeks | The CBOR envelope transport loop against an existing shape — `xsnap`'s `worker_io.rs` (1,559 lines) plus `envelope.rs` (402) — and the `PersistentMachine` refusal docs |
| 6. Reconcile the record | S | 1-2 days | Three lines of the engine design's status ledger and reconciliation table, plus the `versions.rs` release entries Phases 4 and 5 require |

Critical path — Phases 0, 1, 3, 4, 5, 6 in series, with Phase 2 anywhere —
is **5.5 to 8.5 developer weeks** (28 to 42.5 developer days at five days a
week), dominated by Phase 4, which is a third of it.

This adds no scope to M11.
Phase 4 is `ironhorse-engine`'s roadmap stage 4, already Approved and
already counted; Phase 3 is the `daemon-endo-rust-sqlite` host-powers row,
already named in that design's reconciliation table.
No milestone total or timeline change is assigned.

## Design Decisions

1. **F157 before F068.** The trait signature has to carry the error type.
   Extracting `JsMachine` over `Store(String)` freezes the wrong shape across
   two engines and makes the review's own `Err(Unavailable)` prescription
   untypeable; fixing it after is a breaking change to a trait with two
   implementors.

2. **Phase 2 is a residue, not a track.** This reverses the first draft's
   second decision, which read "Phase 2 has no gate and should start
   immediately … starting it late is the single easiest way to make the SES
   bar the schedule's long pole."
   That was written against a tree where forty-seven sites bypassed the
   property seam.
   They do not, and a source-level gate now fails the build if they come
   back, so the confinement precondition for Phase 4 is already met.
   The SES bar is still the long pole — it is simply the largest phase, not
   a convergence point.

3. **F033 goes last, not first.** The defect it records is a reconciliation
   written ahead of its seams. Writing a new one ahead of the same seams
   reproduces it.

4. **`FromAsync*` is documented, not carried.** Set out in full under Phase 5.
   The short form: the carry costs a side table, an atom, a format bump, a
   store-schema bump and a migration, and buys persistence for a builtin no
   daemon vat pattern uses — where the `async_instances` carry bought the
   daemon's central pattern.
   F127's Fix offers the alternative itself, and it is the right half to
   take.

5. **The governing principle is F054's own Fix line: "Land the seams before
   the features."** Phases 0, 1 and 3 are seams — a typed error channel, an
   engine trait, a service-adapter surface.
   Phases 4-5 are the features that ride them. Phase 6 is the record catching
   up. Two things can move without disturbing anything else and nothing else
   can: Phase 2 may be taken at any time or dropped, and Phase 6 may finish
   at any time after Phase 5.

6. **Re-verify, do not carry forward.** Five of the fifteen rows moved on
   re-reading the tree: two inverted a phase (F056, F061), two emptied
   another (F156, F033), and one removed a work item from a third (F155).
   A status column is a reading of a commit, not a property of a finding;
   this document's own first draft demonstrated the cost of treating them as
   the same thing, in both directions — it carried a review status that was
   already stale (F155, which the review had itself marked resolved), and it
   carried four more that had gone stale since (F056, F061, F156, F033).

## Already clear

Thirteen items inside or immediately adjacent to this scope closed between
`1b130df7` and HEAD.
They are recorded because the review's own status columns still show several
of them open, and a reader working from the review alone will re-do them.

- **F072** — the restore seam. "21 public, inconsistently-validating mutators
  on `Interp`" under two failure disciplines is gone: `RestoreSession` exists
  (`interp/restore.rs:45`), `impl Interp` retains only `begin_restore`
  (`:52-62`), and the twenty-three `pub fn restore_*` verbs live on the
  session (`:64`), each returning `Result` and admitting its own row.
  Locked by `public_restore_verbs_are_confined_to_the_owned_session`
  (`tests/property_mop_seam.rs:232`).
  This is what #1263 item 11 means by "explicit restore policy," and it is
  the one clause of the fence already discharged.
- **F056** — the property seam. Zero calls to the four bypass helpers;
  a three-tier lattice; a source-level gate that fails the build on
  regression.
- **F061** — the membrane. Twenty shapes times six operations, asserted.
- **F155** — the commit gauntlet. `HeapStoreCommit`'s provided `commit` over
  a blanket impl; every backend implements only `commit_verified`.
- **F156** — the compatibility document.
  `ironhorse-snapshot/src/versions.rs`, with two bump rules enforced in CI.
- **F033** — the reconciliation table. Both halves closed: the meter is armed
  on every production path, and the "preserved verbatim … without supervisor
  changes" claim is gone from `designs/ironhorse-engine.md`.
- **F160** — the compiler seam is wired in production. `set_source_compiler`
  is called from `rust/endo` at three sites
  (`ironhorse_engine.rs:523`, `:578`, `:915`), so guest `eval` on the daemon
  path compiles instead of halting `eval:no-compiler`.
- **F144** — `set_intrinsic_permit` landed, exactly as prescribed.
- **F054 (host-functions leg)** — the `HostCallable` registry landed with
  rooted captures and stable persisted identities.
- **F069 (VM half)** — `has_pending_jobs` is public again after having been
  deleted rather than exposed; `run_promise_jobs` with it.
- **F127 (async half)** — `AsyncAwait` and all three `AsyncGenerator*`
  reactions now resume, and the blanket async-generator refusal is gone;
  the vat-awaiting-a-host-response pattern checkpoints.
- **F015 / F057 / F058** — the freezing primitives themselves. These *are*
  the "shared-intrinsic freezing" the fence correctly says is not sufficient
  on its own.
- **F143 / F184** — the `$262` host is out of production machines and
  intrinsic globals are no longer enumerable.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Owns the roadmap stage 4 bar (`:37`, `:940`) and the requirement-8 reconciliation table. Phase 6 edits `:37`, `:890`, `:898` and `:903`; Phase 4 is measured against stage 4. |
| [ironhorse-w6-decisions](ironhorse-w6-decisions.md) | Decision of record for Realm (§1), engine trait (§2, deferred with the trigger Phase 1 fires) and the integrity model (§3, whose F056/F061 residue Phase 2 no longer carries). |
| [ironhorse-2a-property-mop-completion](ironhorse-2a-property-mop-completion.md) | Closed F056 and F061, and with them Phase 2's confinement content. Its numerical recount is the method this document's re-count reproduces. |
| [ironhorse-snapshot-store-seam](ironhorse-snapshot-store-seam.md) | Carries the side-table ledger whose HardenState/Modules/Functions rows are Phase 4's acceptance evidence, and the Pending rows behind F127. `ironhorse-snapshot/src/versions.rs` states the bump rules Phases 4 and 6 must follow. |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | The reconciliation row that names "service adapters and explicit restore policy"; Phase 3 clears its first half. |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Names the engine-agnostic supervisor that F068 has no place to attach to. |

## Known Gaps and TODOs

- [ ] Assign an owner and a start date. The sequence is fixed; the schedule
      is not.
- [ ] Choose between refusing and implementing compact notation in Phase 2.
      The recommendation is to refuse; the phase is sized both ways.
- [ ] Confirm that Phase 1's trait subset is the supervisor's actual call
      set rather than a copy of `xsnap::Machine`'s twenty-nine methods.
      The size estimate assumes the former.
- [ ] Correct `designs/ironhorse-w6-decisions.md` §3, which is Active and
      still reads "**F056 and F061 record 47 call sites that still bypass
      it** … they belong to whoever picks up the property/MOP seam work"
      (`:119-122`).
      That work was picked up and finished; the decision record is the last
      place in `designs/` still carrying the 47 figure.
      Not gated on any phase here — it is false now, not false later.
- [ ] Index `designs/ironhorse-2a-property-mop-completion.md`.
      It is the design that closed F056 and F061, this document's
      Dependencies table points at it, and it is in no row of
      `designs/README.md`.
      It also has no metadata table, so indexing it means choosing its
      Created/Updated/Status first; that is a call for its author, not for
      this document.

## Prompt

> a previous IronHorse refactor workload eschew some scope stating
> > Full daemon SES/worker-protocol acceptance remains separate. Daemon-specific
> > host powers still need their service adapters and explicit restore policy;
> > shared-intrinsic freezing alone does not establish that acceptance.
> use the IronHorse Architecture review doc to identify the relevant findings

Followed by: "write as a new artifact with an established sequencing for
fixes", then "just a markdown document please, dont publish", and then
"Address the outstanding issues, committing incrementally and running a
precommit adversarial subagent review loop", under which the five open
checklist items of the first draft were discharged: the README
synchronization, the F056 re-count, the F061/F062/F155 re-verification, the
`FromAsync*` decision, and the per-phase sizing.

The quoted scope in the prompt is a composite of the three fence statements
listed under *What is the Problem Being Solved?*; no single source carries it
verbatim.
