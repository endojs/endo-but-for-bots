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

## Method

PR #1263's work is in this tree — the Realm extraction, host-callable
registration and an explicit restore session, verified as ancestors of HEAD;
its own TODO says merging was not requested (`PR-1263-TODO.md:26`), so
"landed" here means present in the tree, not merged.
It fenced off what it had *not* established:
full daemon SES and worker-protocol acceptance.
This document reads that fence against the architecture review's 191
findings, names the fourteen that sit inside it, and orders them.

**Read the statuses here, not the review's.**
The review's status columns stop at `1b130df7` (2026-09-08); PR #1263
landed on 2026-09-13.
Every finding below was re-verified against tree
[`65902a8f`](https://github.com/endojs/endo-but-for-bots/commit/65902a8f)
(2026-09-14) by reading the tree, not by carrying a status forward.
Where a re-verification contradicts the review, or contradicts this
document's own first draft, the row says so and shows its evidence.

**On "order".** Two of the transitions below are hard gates — one phase
cannot start until another has landed, and the document says which fact
makes that true.
The rest are orderings of preference: cheaper and more constraining work
before work that would otherwise have to be redone.
An earlier draft of this document claimed a single dependency order for all
six phases; that claim did not survive its own re-verification, and where a
gate turned out not to exist the phase now says so rather than keeping the
stronger word.

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

Fourteen findings over fifteen rows: F054's host-functions leg and its SES
leg are tracked separately because they landed in different phases.
Three rows are open at HEAD, four partial, eight closed or landed.
Six of the eight were already closed when this document's first draft read
them as open work — nothing landed between drafts; the drafts simply carried
statuses they had not checked.

| Finding | Sev | § | State at `65902a8f` | Phase |
|---|---|---|---|---|
| F157 | medium | 3.13 | open — `Store(String)` survives verbatim | 0 |
| F068 | medium | 3.13 | open — no engine trait exists | 1 |
| F069 | medium | 3.13 | partial — VM half fixed, trait half cannot close before F068 | 1 |
| F159 | low | 3.13 | partial — `Realm` exists, rename outstanding | 1 |
| F056 | high | 3.14 | **closed** — zero bypass calls; one Fix clause outstanding | 2 |
| F061 | high | 3.7 | **closed** — membrane equivalence asserted for 20 shapes | 2 |
| F062 | high | 3.7 | partial — compact notation still silently wrong | 2 |
| F054 (host leg) | medium | 3.14 | landed in #1263 | 3 |
| F144 | low | 3.7 | landed — `set_intrinsic_permit` | 3 |
| F155 | medium | 3.13 | **closed** — the review itself resolved it at `1b130df7` | 3 |
| F054 (SES leg) | medium | 3.14 | open — the leg that stays open | 4 |
| F059 | high | 3.7 | **closed** — seam built and asserted by guest object identity | 4 |
| F127 | low | 3.9 | partial — `FromAsync*` residue only | 5 |
| F033 | high | 3.11 | **closed** — the verbatim-API claim is gone from the design | 6 |
| F156 | medium | 3.13 | **closed** — `ironhorse-snapshot/src/versions.rs` is the document | 6 |

F072 is listed under *Already clear* below rather than given a phase.
It is discharged, by `ironhorse-2a-property-mop-completion`; it is not, as an
earlier draft of this document claimed, the fence's "explicit restore policy"
clause, which is about daemon powers and belongs to Phase 3.

### What the re-verification changed

Six rows moved against the first draft, and one pair of them moves the shape
of the whole plan.
None moved because the tree moved: every draft read `65902a8f`.
Two adversarial reviews of the first draft are the reason five of the six are
here at all — the pattern in every case was a claim checked against one file
and generalised to the tree.

**F056 and F061 are closed, so Phase 2 is discharged.**
`designs/ironhorse-2a-property-mop-completion.md` — whose opening line
(`:3`) names F056, F061, F060, F072, F085 and F102 — landed the property/MOP
seam completion.
At HEAD the four bypass helpers the review counted have no calls at all:
`instance_get`, `instance_has`, `instance_put` and `resolve_get` survive
only as eight prose mentions in comments
(`interp/dispatch/property_read.rs:223`,
`interp/dispatch/environment.rs:104` and `:184`, `interp/function.rs:428`,
`interp/link.rs:328`, `interp/persist.rs:295`, `interp/dispatch.rs:475`,
`interp/dispatch/environment.rs:140`), and no definitions remain.
The seam is now a three-tier lattice — `boot_chain_get` for boot and
restore (`interp/property/ordinary.rs:790`), `ordinary_get`/`ordinary_set`
private to the property module, `mop_*` for everything guest-reachable — and
the four dead names are mechanically locked, not merely conventional:
`raw_property_reads_are_confined_to_boot_restore_and_mop`
(`ironhorse-vm/tests/property_mop_seam.rs:139`) token-scans every `.rs` file
under `ironhorse-vm/src` and fails the suite if any of the four reappears, if
`ordinary_get` or `ordinary_set` is named outside `interp/property{,/}`, or
if `boot_chain_get` is called outside its four-file allowlist.

**What the gate does not cover, stated because an earlier draft of this
document claimed it did.** The arm is the two exact tokens `"ordinary_get" |
"ordinary_set"`, not an `ordinary_*` prefix, and other `ordinary_*` helpers
are `pub(in crate::interp)` and do leave the property module:
`ordinary_get_own_descriptor` (`interp/property/ordinary.rs:142`) is called
from `interp/natives/array.rs`, `natives/dispatch.rs`, `natives/intl.rs`,
`natives/regexp.rs`, `persist.rs` and `restore.rs`;
`ordinary_define_own_property` (`ordinary.rs:212`) from `interp.rs:2198` and
`interp/dispatch/property_write.rs`.
A raw own-property *writer* also survives under a name the sweep does not
match: `instance_put_raw` (`interp/function.rs:431`) splices the slot linked
list directly and is called seven times from `interp/natives/regexp.rs`
(`:1099`, `:1105`, `:1137`, `:1141`, `:1151`, `:1233`, `:1237`).
F056's Fix asked for exactly the check that would have caught this — "a
source-level check that no file under a future `interp/natives/` names a
`raw_*` helper" — and that clause is not implemented.
This document does not claim a guest-visible trap bypass: the surviving
sites are engine-owned arrays and exec results, and establishing whether any
is reachable through a user-overridden `RegExp.prototype.exec` needs
spec-level analysis nobody has done here.
It claims only that the lattice is enforced for four names, not for a tier,
and that F056's own locking clause is outstanding.
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
"RESOLVED since the previous revision. This finding no longer describes the
tree; do not act on it", and Appendix A's `1b130df7` column reads `fixed`.
This document's first draft carried the `c14706d3` reading by mistake.
HEAD confirms the resolution: `HeapStoreCommit` (`store.rs:1650`) provides a
non-overridable `commit` (`:1654`) through a blanket
`impl<S: HeapStore + ?Sized>` (`:1680`), `commit_verified` is the required
method (`:1737`), and each of the three production backends — `MemoryStore`
(`store.rs:3267`), `FileStore` (`store_file.rs:570`) and `SqliteHeapStore`
(`rust/endo/ironhorse-store-sqlite/src/lib.rs:991`) — implements only the
medium-specific write, as do the seven test backends the review's resolution
note records.

**F062 is the only survivor of its phase, and it is not a confinement
finding.** `notation: 'compact'` is still admitted
(`interp/natives/intl.rs:1191`, mapped at `:1336`) while
`compute_notation_exponent` (`intl_number.rs:935`, folding at `:937`) sends
`Notation::Compact` to `Notation::Standard`'s zero exponent,
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
`rust/engine/scripts/intl-profile.py` and its test
(`.github/workflows/ci.yml:710-711`) and
`rust/engine/scripts/check-row-schema.py` (`:718`) all run in CI.

**F059's assertion exists, so Phase 4 loses its second work item.**
The first draft said the shared-intrinsics seam was built but asserted only
by `Rc::ptr_eq` on a marker, "never by guest-observable object identity".
That was a conclusion drawn from the unit tests inside `compartment.rs`
without looking at the crate's integration tests.
`ironhorse-vm/tests/realms.rs:16-42` asserts exactly what the review's Verify
clause asked for, by object identity and at the guest level; the section on
Phase 4 sets out what it does.
What survives is two pieces of documentation that contradict the seam, one of
which is a test whose own comment says "MUST BE REVISITED AT THE REALM
SPLIT".

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
That is the first of F033's Fix's two documentary clauses, applied.
The second — "enumerate the supervisor changes it will require" — is not
done by that row and is not done anywhere, which is part of why Phase 6
still has work even with the finding closed.
What is left at `:903` is not F033's defect but Phase 6's forward
obligation: the `daemon-endo-rust-sqlite` row still says daemon powers
"require service adapters and explicit restore policy", which Phase 3 makes
false.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Owns the roadmap stage 4 bar (`:37`, `:940`) and the requirement-8 reconciliation table. Phase 6 edits `:37`, `:890`, `:898` and `:903`; Phase 4 is measured against stage 4. |
| [ironhorse-w6-decisions](ironhorse-w6-decisions.md) | Decision of record for Realm (§1), engine trait (§2, deferred with the trigger Phase 1 fires) and the integrity model (§3, whose F056/F061 residue Phase 2 no longer carries). |
| [ironhorse-2a-property-mop-completion](ironhorse-2a-property-mop-completion.md) | Closed F056 and F061, and with them Phase 2's confinement content. Its numerical recount is the method this document's re-count reproduces. |
| [ironhorse-snapshot-store-seam](ironhorse-snapshot-store-seam.md) | Carries the side-table ledger Phase 4's acceptance evidence has to be written against — 34 `Serialized`, 4 `EmptyAtBoundary`, 2 `RebuiltAtRestore`, 1 `InArena` and no `Pending` rows at HEAD, which is why `run_worker`'s HardenState/Modules/Functions criterion no longer names anything. `ironhorse-snapshot/src/versions.rs` states the bump rules Phases 4 and 6 must follow. |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | The reconciliation row that names "service adapters and explicit restore policy"; Phase 3 clears its first half. |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Names the engine-agnostic supervisor that F068 has no place to attach to. |

## Phased implementation

The fifteen rows were two tracks when this document was drafted.
Track B — `interp.rs` property paths — is discharged except for F062, which
gates nothing.
What is left is not a second track but a short chain with more slack in it
than the first draft admitted: only two transitions are hard gates.

```
  0. Type errors ╌╌╌► 1. Engine trait ═══► 3. Host adapters ═══► 5. Envelope
                                                                      ╎
                          4. SES bar  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
                          (no gate in)

  2. Intl residue        no gate in, no gate out
  6. Reconcile           three edits, each riding its own phase (1, 3, 4+5)

  ═══►  hard gate                ╌╌╌►  ordering preference
```

| Transition | Kind | Because |
|---|---|---|
| 1 → 3 | **hard gate** | An adapter's verbs need a trait to sit on |
| 3 → 5 | **hard gate** | The envelope is delivered through the `worker_io.rs` host powers Phase 3 registers |
| 0 → 1 | preference | Cheap constraining work before expensive structural work; `Unavailable` is already typeable |
| 4 → 5 | preference | Keeps the envelope off a worker that cannot boot; not a dependency |
| 1 → 6, 3 → 6, 4+5 → 6 | preference | Each reconciliation edit becomes possible when its own phase lands |
| — → 2, 2 → — | none | Neither gated nor gating |
| — → 4 | none | Retracted; see Phase 4 |

**The two hard gates.**
Phase 1 → Phase 3, because an adapter's verbs need a trait to sit on.
Phase 3 → Phase 5, because the envelope is delivered through the
`worker_io.rs` host powers Phase 3 registers; a transport loop with nothing
to send frames through is the eval-shaped dialect `run_worker` refuses.

**Everything else is preference.**
Phase 0 before Phase 1 is cheap constraining work before expensive
structural work.
Phase 4 before Phase 5 keeps the envelope from shipping onto a worker that
cannot boot, which is a good idea and not a dependency.
Phase 2 may be taken at any time or dropped.
Phase 6's three edits ride their own phases.

The SES bar is still the long pole — a third of the estimate — but it is a
long pole because it is large, not because anything converges on it.
It is not gated on Phase 3 at all; see Phase 4, where the first draft's
claim that it was is retracted with the evidence that refutes it.

### Phase 0 — Type the error channel

**Gate:** none, and it gates nothing either — this is an ordering
preference, not a dependency. See *Why first* below, which an earlier draft
of this document overstated.
**Size:** M — 2-3 developer days.

- **F157** [medium, high] §3.13, open at HEAD; every coordinate below was
  re-read, and the two the first draft cited are still exact.
  `MachineError::Store(String)` (`ironhorse_engine.rs:58`) and
  `format!("{e:?}")` (`:854`) flatten the `StoreError` taxonomy into one
  opaque string.
  Transient I/O (retry), deterministic refusal (never retry) and a poisoned
  session (tear down) are indistinguishable at the only boundary that can act
  on them.
  Named by ID in the #1263 deferral.

  Three details have drifted from the review and none weakens the finding.
  `StoreError` now carries **fourteen** variants
  (`ironhorse-snapshot/src/store.rs:114-178`), not the sixteen the review
  counted, and it still derives only `Debug, PartialEq, Eq`: there is no
  `Display` and no `std::error::Error` impl for **`StoreError`** in either
  workspace, so `{e:?}` is the only rendering available to the seam.
  (`MachineError` itself has both — `Display` at `:84`, `Error` at `:105` —
  which is the shape `StoreError` needs and does not have.)
  `MachineError::Unavailable(String)` (`:54`) already exists, which is the
  variant Phase 1's trait needs; the work is to make `Store` its equal, not
  to invent the vocabulary.
  And the change surface is **nineteen** `MachineError::Store(`
  construction sites, not the seven `format!`-shaped ones an earlier draft of
  this document counted: the other twelve build `Store` from string literals
  (`:878`, `:895`, `:1138`, `:1189`, `:1199`, `:1207`, `:1214`, `:1348`,
  `:1351`, `:1438`, `:1441`, `:1487`), and a variant reshaped from
  `Store(String)` to `Store { kind, source }` touches every one.
  Three of the seven `format!` sites do not flatten a `StoreError` at all —
  `:1368` stringifies a panic payload — so the classifier has to decide what
  those become, which is the phase's only judgement call.

**Why first, and why that is weaker than the first draft claimed.**
That draft argued the review's `Err(Unavailable)` prescription — "leaving the
verbs it cannot yet serve as explicit `Err(Unavailable)` so the gap stays
named and typed" — "becomes untypeable" without this phase.
It does not, and this document's own Phase 0 evidence says why:
`MachineError::Unavailable(String)` already exists at `:54`.
The trait is typeable today.

What survives is an ordering preference, and it is a real one.
Every trait method returns `Result<T, MachineError>` either way, so doing
Phase 0 second does not change a single method signature — but it does
change the payload of a variant that the trait's two implementors and their
callers will by then be matching on, and the match sites are the whole cost
of the phase (see the twenty-two construction sites below).
Cheap, contained, mechanical work that constrains a later structural change
is worth doing before the structural change, not after.
That is a scheduling argument, not a dependency, and it is stated as one.

**Cost.** Contained and mechanical, but across nineteen construction sites
plus the `Display` arm at `:97`: `Display` + `Error` on `StoreError`, a
`StoreFailure { Transient, Refused, Poisoned }` classifier beside the
variants, `Store { kind, source }` in place of `Store(String)`, and a
distinct `MachineError::Poisoned { during, source }` for the rewind sites.
The one non-mechanical cost is the four tests that match on the flattened
string — `ironhorse_engine.rs:1556` and `:1596`, and
`rust/endo/tests/ironhorse_store_worker.rs:184` and `:651`, each asserting
`Err(MachineError::Store(message)) if message.contains(…)` — which have to
become matches on the classifier.
M is the right bucket for nineteen mechanical sites and four test predicates;
it would not be if the classifier turned out to need per-variant judgement
the `StoreError` taxonomy does not already encode.

**Clears:** nothing on its own. It is the coupling, not a car.

### Phase 1 — Extract the engine seam

**Gate:** none. Phase 0 first is a preference, for the reason that phase
gives; the trait is typeable over today's `MachineError`.
**Gates:** Phase 3, hard — an adapter's verbs need somewhere to sit.
**Size:** L — 1-1.5 developer weeks.

- **F068** [medium, high] §3.13, open at HEAD.
  Verified: the only traits in `rust/endo/src` are `HttpClient`
  (`fetch.rs:153`) and `GitCas` (`git_cas.rs:105`).
  `xsnap::Machine` exposes thirty public methods
  (`rust/endo/xsnap/src/lib.rs`, three `impl Machine` blocks — twenty-nine
  `pub fn` plus `pub unsafe fn context<T>` at `:126`, which a naive scan for
  `pub fn` misses and an earlier draft of this document duly missed);
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
that this half is "mechanical and changes no behaviour" and that "doing the
xsnap half now is the cheap part and is what caps the retrofit cost"
(`ARCHITECTURE-REVIEW.md:10653-10658`).
The decision of record disagrees about the word, and its disagreement is
carried here rather than quoted selectively: W6 §2's *Accepted cost of
waiting* records that `PersistentMachine` gained `meter_bounds()` and a
compile-then-execute budget sequence with no xsnap analogue, that
`ironhorse_engine.rs` grew 331 lines in the `1b130df7` window alone, and
that "if the trigger fires, expect the extraction to be larger than the
review's 'mechanical' estimate."
That is the reason this phase is sized L rather than M, and the reason its
first task is to establish the trait's call set rather than to start
transcribing methods.
`PersistentMachine` second, with typed `Err(Unavailable)` for every verb it
cannot yet serve, so the gap stays an honest named skip rather than an
absence.
The thirty-against-nine spread is the size estimate: the trait is whatever
subset the supervisor actually calls, and the review's own framing — six
methods against thirty (`ARCHITECTURE-REVIEW.md:10646-10647`) — is a warning
against copying the XS surface wholesale.

**The W6 deferral expires here by its own terms.**
W6 decision 2 deferred this trait with three stated re-opening triggers.
One is "the worker protocol landing (it is the seam where the two types
would first have to answer the same calls)."
Sequencing the worker protocol fires that trigger, so this is not a reversal
of the decision — it is the decision executing.

**Clears:** the engine-side precondition for worker-protocol acceptance.

### Phase 2 — The Intl residue

**Gate:** none. Gates nothing. May be taken at any time.
The F056 residue below should not be dropped; F062 may be.
**Size:** S — a day for each of the two items; M if the CLDR compact
patterns are implemented rather than refused.

This phase was the confinement track.
F056 and F061 closed it; see *What the re-verification changed* above for
the evidence and the source-level gate that keeps it closed.
What remains is one clause of F056's own Fix, and one finding that shares the
phase only by history.

- **F056 residue** [high, high] §3.14 — one Fix clause, not a reopening.
  The counted bypasses are gone and locked; what is missing is the source
  check F056 asked for over `raw_*`-shaped helpers under `interp/natives/`,
  and the one such helper the absence of that check permits
  (`instance_put_raw`, seven calls from `natives/regexp.rs`).
  Extending `property_mop_seam.rs`'s existing token sweep is the same shape
  of work as the sweep already there.
  Sized inside this phase's S because it is a match arm and an allowlist,
  not a refactor — unless the sweep turns up a site that has to move onto
  `mop_*`, which is the thing worth finding out.
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
That is false: the precondition was already met before this document was
written.
Phase 4 may be measured without waiting for F062.

### Phase 3 — Daemon powers as service adapters

**Gate:** Phase 1, hard — the adapters' verbs need a trait to sit on.
Phase 0 first is a preference again: the adapters are the sites that most
want a typed store failure, but nothing stops them being written against
`Store(String)` and re-matched later.
**Gates:** Phase 5, hard — see that phase.
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
is 2,640 lines across seven files — six power modules totalling 2,579
(`fs.rs` 1,108, `sqlite.rs` 683, `crypto.rs` 297, `debug.rs` 220,
`process.rs` 146, `modules.rs` 125) plus `mod.rs` at 61 — and
the Ironhorse adapters have to cover the same ground over a different
registration surface.
That is squarely the README's L bucket (1,500-3,000 lines).

**Clears:** the "service adapters" half of the `daemon-endo-rust-sqlite`
reconciliation row.

### Phase 4 — Meet the SES bundle bar

**Gate:** none from Phase 3, and an earlier draft of this document was wrong
to claim one.
It argued that `host_aliases.js` "needs host powers" because its header says
it "runs after host-power registration and before the SES boot".
The body says otherwise: the shim is a `globalThis` IIFE whose whole loop is
`var target = globalThis[aliases[key]]; if (typeof target === 'function')`
(`host_aliases.js:71-76`), so it aliases only powers that already exist and
is a no-op for the rest.
The engine states the consequence outright — "`host_aliases.js` is a
self-contained `globalThis` IIFE that aliases only host functions that exist,
so with no host powers registered it completes to `undefined` — safe to
dual-run in the engine" (`ironhorse-262/src/lib.rs:705-707`) — and
`daemon_boot_bundle_sources` (`:708-725`) already dual-runs `polyfills.js`,
`host_aliases.js` and the combined prefix today, with no service adapter
registered at all.
Two of the three bundles are therefore already at the bar.
**Size:** XL — 2-3 developer weeks, and the uncertainty is a scoping
decision, not research. See *The obstacle* below.

- **F054 SES leg** [medium, high] §3.14 — the leg that stays open.
  At `1b130df7` `Intrinsics` held a `BootTemplate` cache; the review's words
  are "a per-machine PRISTINE TEMPLATE CACHE, not a shared frozen primordial
  graph."
  At HEAD `locked_down` (`compartment.rs:36`) has a reader again
  (`is_locked_down`, `:41`) and `Realm` exists.
  The *state* is there. The *bar* is not.
- **F059** [high, high] §3.7, **closed** — and this document said otherwise
  twice before checking the whole tree.
  The seam is built: `MachineState` holds one `RefCell<Interp>` and one
  `Rc<Realm>` (`compartment.rs:48-53`), `Compartment::execute` borrows that
  single interpreter (`:672`) and activates the compartment's own environment
  inside it, and `Compartment::intrinsics` is documented as "the machine's
  shared frozen intrinsic graph" (`:458`).
  The assertion exists too, which an earlier draft denied on the strength of
  reading only the in-file unit tests in `compartment.rs`.
  `primordial_identity_is_shared_and_globals_persist_independently`
  (`ironhorse-vm/tests/realms.rs:16-42`) evaluates `var saved =
  Object.prototype` in two compartments of one `Machine`, asserts the two
  `global_object_identity("saved")` values are equal — the same heap object,
  since `ObjectIdentity` is the canonical per-object lease keyed by
  `SlotIndex` (`interp/realm.rs:376-388`) — asserts the guest-level `saved ===
  Object.prototype` after an intervening evaluation, and asserts the two
  `globalThis` identities differ.
  That is the review's Verify clause for F059 word for word: "strengthen
  `compartments_share_intrinsics_but_not_globals` to assert the intrinsics
  half by object identity across two evaluations."
  The file's own module doc says so: "Realm identity, persistent globals, and
  shared frozen intrinsic objects" (`realms.rs:1`).

  **Two stale artifacts remain, and they are this phase's actual F059 work.**
  Neither is a defect in the seam; both are documentation that contradicts
  it.
  `ironhorse-262/src/lib.rs:847-850` still describes `shared_intrinsics` as
  "Marker identity only: each evaluation links the intrinsics into a fresh
  `Interp`, so no intrinsic *object* is shared."
  Worse, `ironhorse-vm/tests/hardened_js_boundary.rs:279-294` carries a test
  named `two_compartment_evaluations_do_not_share_a_heap` under the header
  "F059: compartments cannot observe each other", whose comment says it
  "pins the ABSENCE of requirement 5, not its presence", that "each
  `evaluate*` builds a fresh `Interp`", and — in capitals — "MUST BE
  REVISITED AT THE REALM SPLIT."
  The realm split landed in #1263.
  The test was written to survive that landing without weakening, which is
  good engineering; revisiting it as its own comment instructs is the work.

**The bar, and the measurable form `run_worker` names for it is stale.**
Stage 4 (`designs/ironhorse-engine.md:37`) still reads "Partial — bar not
met", and its acceptance column (`:940`) asks for "the endor daemon boot
bundles (`polyfills.js`, `ses_boot.js`, HandledPromise) running identically
on both engines".
The three-file chain `polyfills.js` → `host_aliases.js` → `ses_boot.js`
comes from `run_worker`'s doc comment (`ironhorse_engine.rs:1500`) rather
than from stage 4 itself, and matches what `daemon_boot_bundle_sources`
actually evaluates.

`run_worker`'s refusal then offers a sharper-sounding criterion —
"concretely the side-table ledger's HardenState/Modules/Functions rows" —
and an earlier draft of this document adopted it verbatim as the phase's
deliverable.
**It is not producible as written**, and the ledger says why.
Counting every `#[snapshot_table(...)]` under `ironhorse-vm/src/interp/`:
34 `Serialized`, 4 `EmptyAtBoundary`, 2 `RebuiltAtRestore`, 1 `InArena`, and
**zero `Pending`**.
`HardenState` is the `InArena` one — `#[snapshot_table(HardenState, 40, 40,
InArena, "harden slot flags (no side table)")]` (`interp/state.rs:331`), a
reclassification `designs/ironhorse-snapshot-store-seam.md:2746-2748` records
in its own words: hardened-ness is slot flags riding the HEAP atom, and no
side table exists.
`Functions` is already `Serialized` (`state.rs:513`).
There is no `Modules` row in the ledger at all.

So the phase needs an acceptance criterion someone writes, rather than one it
inherits.
The honest form of the same intent: the three bundles evaluate to the same
completion on both engines, a machine that has run them checkpoints and
resumes with `lockdown()`'s effects intact, and `is_locked_down()` survives
the round trip — evidenced against the rows that do exist rather than three
that do not.
Fixing `run_worker`'s refusal text is Phase 5's job (it is stale about the
host-function surface too); choosing what replaces this clause is Phase 4's
first deliverable after the bundling decision.

**The obstacle, which is not the one the first draft implied.**
Two of the three bundles already dual-run.
The third is not in the tree: `rust/endo/xsnap/src/ses_boot.js` does not
exist in a checkout.
The engine records exactly why, and has ledgered it:

> The third boot step — **`ses_boot.js`** (SES `lockdown()` + the
> HandledPromise shim) — is **not committed**: it is a ~1 MB build artifact
> the daemon bundler (`rollup` over `@endo/*`) generates into
> `src/ses_boot.js` before the `include_str!`, absent in a fresh checkout.
> Bundling the full SES distribution is out of this engine workspace's
> scope, so `ses_boot.js` is a **named, ledgered boot-bundle gap**
> (`boot:ses-lockdown-bundle`), not dual-run here.

(`ironhorse-262/src/lib.rs:699-707`; the ledger row is
`rust/engine/CHANGELOG.md:900`.)
`rust/endo/xsnap/src/lib.rs:944` still `include_str!`s it, and the repo
generates it with `yarn bundle:xs`
(`packages/daemon/scripts/bundle-bus-worker-xs-ses-boot.mjs`, per
`rust/endo/README.md:22`).

So the first question of this phase is not a VM question at all.
It is: **does the engine workspace take a JavaScript-toolchain dependency,
commit a ~1 MB generated bundle, or generate it in CI?**
Whoever picks the phase up decides that before writing engine code, because
the answer decides whether the bar can be run in `ironhorse-262` at all, and
the current answer on record is "out of this engine workspace's scope".
The XL size assumes that decision is made and the bundle is reachable; it
does not price a cross-workspace build change.

**If the bundles do not agree.** The bar is result agreement on three
programs, and a divergence in `ses_boot.js` is the expected outcome of a
first run, not a project failure.
The partial-acceptance definition already exists in the shape of the
evidence: the side-table ledger's HardenState, Modules and Functions rows
are three separable claims, and a phase that lands two of them has a
reportable result.
Descoping to "`polyfills.js` and `host_aliases.js` at the bar, `ses_boot.js`
named as a ledgered gap" is the tree's *current* state, so it is a floor
rather than an outcome — but it is the honest thing to publish if the
bundling decision goes the other way, and Phase 5 would then ship against a
named SES gap exactly as `run_worker` already describes.

**Clears:** "full daemon SES acceptance," the clause the fence says freezing
does not imply.

### Phase 5 — Ship the worker envelope

**Gate:** Phase 3, genuinely — this is where the host-powers gate the first
draft put on Phase 4 actually belongs.
The envelope is delivered through host functions, not around them:
`host_aliases.js` groups its `worker_io.rs` powers first —
`hostGetDaemonHandle`, `hostSendRawFrame`, `hostRecvFrame`, `hostSendFrame`,
`hostIssueCommand`, `hostImportArchive`, `hostTrace` (`:18-25`) — and those
are the transport verbs, not the `powers/fs.rs` or `powers/sqlite.rs` ones
below them.
A CBOR envelope loop with nothing to send frames through is the eval-shaped
dialect `run_worker` refuses by name.
Phase 1 as well, since the supervisor drives the loop through the trait.
Phase 4 is an ordering preference rather than a gate: F127's directive is
that the async carries land before the envelope, and they have, so an
envelope shipped ahead of the SES bar would work — it would just ship onto a
worker that cannot boot `ses_boot.js`, which is the state `run_worker`
already refuses in prose.
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
  Four refusal row names survive across five returns in
  `stored_unpersistable_row_inner` (`:505-625`): a module graph that is
  active or heap-backed and not snapshot-admitted (`:517`), the test262
  `$262` host (`:540`), a promise reaction naming a non-persisted async frame
  — which at HEAD means exactly the four `FromAsync*` kinds (`:576`) — and a
  stored reference to a non-persisted native function, returned from two
  sites (`:620`, `:624`).
  An earlier draft of this document said three and would have had
  `PersistentMachine` document three, leaving the fourth silent, which is the
  opposite of what F127 asks for.

**The `FromAsync*` decision: document the refusal, do not carry the rows.**
The first draft left this open. It is decided here.

`Array.fromAsync` in-flight state is a satellite: the gate's own comment
(`interp/persist.rs:542-552`) records that every in-flight accumulation is
anchored by exactly one `FromAsync*` reaction on a live promise and that an
unanchored entry is unreachable and compacted away, which is why refusing by
kind is the whole gate for it.
Carrying it means the shape the `async_instances` carry took: a row
graduated from `Pending` to `Serialized`, its own atom, a format bump and a
store-schema bump, and the golden corpora that go with them.
The review records that shape for `async_instances` — "`async_instances`
graduated to `Serialized` (sidetable.rs:575) with its own `ASYN` atom
(format.rs:128, image.rs:2335 `encode_async_instances`, store schema 24)" —
and this document asserts by analogy that `from_async` would cost the same
kind of work, not that anyone has priced it.
Treat the estimate as a shape, not a number; whoever takes Phase 5 should
price it before reversing this decision.

What the decision does rest on is a narrower claim than the first draft
made.
Not that no daemon vat pattern *needs* `Array.fromAsync` — guest code in a
locked-down vat may call it, because SES permits it
(`packages/ses/src/permits.js:1176`, `fromAsync: fn`) — but that no daemon
vat pattern *currently* suspends inside it, where F127's own impact clause
names a vat awaiting a host response as *the* daemon pattern, and that
pattern now checkpoints.
That is a statement about today's workload, and it is the reason the
documentation half below is load-bearing rather than cosmetic: the refusal
is reachable from a permitted builtin and surfaces only at checkpoint
time.

**What F127's Fix actually asks, which is better for this decision than the
paraphrase an earlier draft used.** That draft said "F127's Fix offers the
alternative itself", as though documenting were offered in place of carrying.
It is not — the Fix conjoins them ("land the `async_instances` and
`async_generators` carries … *before* the worker envelope … **and** state the
limitation in the `PersistentMachine` docs").
But the carries it names are `async_instances` and `async_generators`, and
**both have landed**: `AsyncInstances` and `AsyncGenerators` are `Serialized`
ledger rows and all four kinds are whitelisted.
`from_async` was never on the Fix's list.
So the Fix's carry clause is discharged in full, and what this document
decides is not a substitution for it but the disposition of a satellite the
Fix did not ask anyone to carry.
Its documentation clause is the half still open.

So: state the limitation where an embedder meets it.
`PersistentMachine`'s doc comment (`ironhorse_engine.rs:746-777`) currently
describes cadence, relinking and the close contract and says nothing about
what a checkpoint refuses.
It should name all four surviving refusals — `Array.fromAsync` in flight, a
non-admitted host module graph, a `$262` machine, and a stored reference to a
non-persisted native function — and say that each is a fail-closed refusal by
row name, not a silent partial save.
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

**Gate:** per edit, not per phase.
The three edits below are severally gated — the first on Phase 1, the second
on Phase 3, the third on Phases 4 and 5 — and nothing requires batching them.
An earlier draft of this document said the phase "may only *end* the
sequence"; the argument behind that (do not write a reconciliation ahead of
its seams) permits reconciling each line as its own seam lands just as well
as it permits one terminal pass.
Listed as a phase because the edits share a file and an intent, not because
they share a gate.
**Size:** S — 1-2 developer days, whether taken together or three times
apart.

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

**The work.** Three independent edits, each a consequence of one earlier
phase and each impossible before that phase lands:

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
The letters are used as the README's own per-design table uses them — as
shape labels whose durations are stated per row, not as strict LOC brackets.
`ironhorse-quiescent-gc` is S at "2–4 developer days" against an S bucket
defined as one day, and `gateway-package` is XL at "6-10 weeks" against an
XL defined as two to three; the rows below take the same liberty and say
their durations explicitly.

| Phase | Size | Estimate | Basis |
|---|---|---|---|
| 0. Type the error channel | M | 2-3 days | 14 `StoreError` variants gain `Display`/`Error`; one classifier; 19 `MachineError::Store(` construction sites plus the `Display` arm; four string-matching test predicates |
| 1. Extract the engine seam | L | 1-1.5 weeks | A trait over two implementors; 30 `xsnap::Machine` methods against 9 on `PersistentMachine` and 8 on `ironhorse_engine::Machine`; an `Engine::Ironhorse` variant; typed `Unavailable` for the unserved verbs; the `Realm`/`Machine` rename |
| 2. The Intl residue | S | 1 day | One refusal at the option reader (M if the CLDR compact patterns are implemented instead) |
| 3. Daemon powers as service adapters | L | 1-1.5 weeks | sqlite, filesystem and network adapters onto an existing registry, each with its permit row and restore policy; `xsnap/src/powers/` is 2,640 lines over the same ground |
| 4. Meet the SES bundle bar | XL | 2-3 weeks | Roadmap stage 4; two of the three bundles already dual-run, the third (`ses_boot.js`) is an uncommitted ~1 MB rollup artifact and a ledgered gap. Assumes the bundling decision is made; does not price a cross-workspace build change. Includes writing an acceptance criterion, since `run_worker`'s named one no longer matches the ledger, and retiring two stale F059 artifacts |
| 5. Ship the worker envelope | L | 1-1.5 weeks | The CBOR envelope transport loop against an existing shape — `xsnap`'s `worker_io.rs` (1,559 lines) plus `envelope.rs` (402) — and the `PersistentMachine` refusal docs |
| 6. Reconcile the record | S | 1-2 days | Three lines of the engine design's status ledger and reconciliation table, plus the `versions.rs` release entries Phases 4 and 5 require |

Two figures, because `designs/README.md` carries a calibration convention
and the raw sum is not it.

The raw sum of the buckets above, over Phases 0, 1, 3, 4, 5 and 6 at five
days a week, is 28 to 42.5 developer days — **5.5 to 8.5 weeks**.
Applying the README's per-size multipliers (S 0.7, M 1.2, L 1.3, XL 1.3,
carried forward unchanged since the 2026-05-14 round, `README.md:1501` and
`:1832`) gives 35.6 to 53.75 days — **7 to 10.75 weeks**.

**The calibrated figure is the planning number**, because those multipliers
are the house convention and every other XL row in the README's estimate
table is quoted after the bump.
Phase 4 is a third of it either way.
Phase 2 adds a day wherever it is taken and is excluded from both.

This adds no scope to M11.
Phase 4 is `ironhorse-engine`'s roadmap stage 4, already Approved and
already counted; Phase 3 is the `daemon-endo-rust-sqlite` host-powers row,
already named in that design's reconciliation table.
No milestone total or timeline change is assigned.

## Design Decisions

1. **F157 before F068, as a preference and not as a gate.** The first draft
   filed this as a dependency, arguing that the review's `Err(Unavailable)`
   prescription is untypeable over a stringly-typed channel.
   It is not: `MachineError::Unavailable(String)` already exists.
   What is true is narrower and still decides the order — every trait method
   returns `Result<T, MachineError>` either way, so Phase 0 changes no method
   signature, but it reshapes a variant that the trait's two implementors and
   their callers will be matching on across twenty-two construction sites.
   Cheap constraining work first, so it is not redone.

2. **Phase 2 is a residue, not a track.** This reverses the first draft's
   second decision, which read "Phase 2 has no gate and should start
   immediately … starting it late is the single easiest way to make the SES
   bar the schedule's long pole."
   That was written against a tree where forty-seven sites bypassed the
   property seam.
   They do not, and a source-level gate now fails the build if they come
   back, so the confinement precondition for Phase 4 was already met before
   this document existed.
   The SES bar is still the long pole because it is the largest phase, not
   because anything converges on it.

3. **Phase 4 is not gated on Phase 3.** The first draft said it was, on the
   strength of a comment in `host_aliases.js`; the file's body and the
   engine's own dual-run harness both say otherwise, and Phase 4 carries the
   retraction with its evidence.
   The host-powers gate is real, but it belongs to Phase 5, where the
   envelope is delivered through `worker_io.rs`'s registered verbs.
   Moving a gate is worth more than deleting one: the schedule now has two
   phases (2 and 4) that can start on day one, where the first draft had one.

4. **`FromAsync*` is documented, not carried.** Set out in full under Phase 5.
   The short form: the carry costs what the `async_instances` carry cost — a
   row graduated to `Serialized`, its atom, a format bump, a store-schema
   bump and the goldens — and buys checkpointing for a builtin no daemon vat
   pattern currently suspends inside, where the `async_instances` carry
   bought the daemon's central pattern.
   F127's Fix offers the alternative itself, and it is the right half to
   take.
   The cost is a shape argued by analogy, not a measured figure, and the
   need is a claim about today's workload rather than about the pattern
   space; both are stated that way in the phase, and both are what to check
   before reversing this.

5. **Reconciliation rides its phases; it is not a terminal pass.** The first
   draft made Phase 6 gate on everything, reasoning from F033 that a
   reconciliation written ahead of its seams reproduces the defect.
   The reasoning is right and the conclusion was too strong: it forbids
   writing ahead of a seam, which permits writing *with* each seam.
   Phase 6's three edits are therefore severally gated, on Phases 1, 3 and
   4+5.

6. **The governing principle is F054's own Fix line: "Land the seams before
   the features."** Phases 0, 1 and 3 are seams — a typed error channel, an
   engine trait, a service-adapter surface.
   Phases 4 and 5 are the features that ride them; Phase 6 is the record
   keeping up.
   The chain that actually constrains the schedule is short: 1 → 3 → 5.
   Everything else is preference, and the document says which is which
   rather than presenting six phases as one forced order.

## Already clear

Fourteen items inside or immediately adjacent to this scope are closed at
HEAD.
Not all closed recently: F015, F057 and F058 read `fixed` in every one of the
review's status columns, F143 and F184 from the second onward, and F155 in
the `1b130df7` column — an earlier draft of this document dated the whole
list to the window after `1b130df7`, which was wrong for six of them.
They are recorded because the review's own *summary* still shows several open
and a reader working from it alone will re-do them.

- **F072** — the restore seam. "21 public, inconsistently-validating mutators
  on `Interp`" under two failure disciplines is gone: `RestoreSession` exists
  (`interp/restore.rs:45`), `impl Interp` retains only `begin_restore`
  (`:52-62`), and the twenty-three `pub fn restore_*` verbs live on the
  session (`:64`), each returning `Result` and admitting its own row.
  Locked by `public_restore_verbs_are_confined_to_the_owned_session`
  (`tests/property_mop_seam.rs:232`).
  An earlier draft of this document credited this to "#1263 item 11" and to
  the fence's "explicit restore policy" clause.
  Both attributions were wrong: item 11 (`PR-1263-TODO.md:39-40`) is F054
  host-callable registration with "explicit reattachment", and the fence's
  "explicit restore policy" is `ironhorse-engine.md:903`, about daemon
  powers — the clause Phase 3 clears, not this one.
  F072 is discharged; it is simply not the clause of the fence that claim
  named.
  `designs/ironhorse-2a-property-mop-completion.md:3` is where it landed,
  alongside F056, F061, F060, F085 and F102.
- **F056** — the property seam. Zero calls to the four bypass helpers; a
  three-tier lattice; a source-level gate over those four names.
  Its Fix's `raw_*` source-check clause is outstanding — see Phase 2.
- **F061** — the membrane. Twenty shapes times six operations, asserted.
- **F059** — the shared-intrinsics seam, built *and* asserted.
  `primordial_identity_is_shared_and_globals_persist_independently`
  (`ironhorse-vm/tests/realms.rs:16-42`) is the review's own Verify clause.
  Two stale artifacts about it remain; see Phase 4.
- **F155** — the commit gauntlet. `HeapStoreCommit`'s provided `commit` over
  a blanket impl (`store.rs:1680`); the three production backends plus the
  seven test backends implement only `commit_verified`.
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

## Known Gaps and TODOs

- [ ] Assign an owner and a start date. The two hard gates are fixed; the
      rest of the order, and the whole schedule, are not.
- [ ] Choose between refusing and implementing compact notation in Phase 2.
      The recommendation is to refuse; the phase is sized both ways.
- [ ] Confirm that Phase 1's trait subset is the supervisor's actual call
      set rather than a copy of `xsnap::Machine`'s thirty methods.
      The size estimate assumes the former.
- [ ] Correct `designs/ironhorse-w6-decisions.md` §3, which is Active and
      still reads "**F056 and F061 record 47 call sites that still bypass
      it** … they belong to whoever picks up the property/MOP seam work"
      (`:119-122`).
      That work was picked up and finished; the decision record is the last
      place in `designs/` still carrying the 47 figure.
      Not gated on any phase here — it is false now, not false later.
- [ ] **Decide `ses_boot.js`'s provenance before Phase 4 starts.** The bundle
      is not in the tree, is a ~1 MB rollup artifact over `@endo/*`, and is
      on the record as "out of this engine workspace's scope" and ledgered
      as `boot:ses-lockdown-bundle`.
      Take the JS-toolchain dependency in the engine workspace, commit the
      generated bundle, or generate it in CI — the answer decides whether
      stage 4's bar can be run in `ironhorse-262` at all, and it is a
      cross-workspace call, not an engine one.
      This is the largest genuine unknown in this document, and the XL size
      on Phase 4 does not price it.
- [ ] **Own the `FromAsync*` documentation half.** Stating the three
      checkpoint refusals on `PersistentMachine` is gated on nothing and
      could land this week; Phase 5 only requires that it has landed by the
      time the envelope ships.
      Until someone takes it, it is an obligation with no owner.
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
