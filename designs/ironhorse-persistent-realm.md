# The Ironhorse Persistent Realm: Machine-Interned Symbols

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | Extracted from review of [thixotrope-ironhorse-engine](thixotrope-ironhorse-engine.md) (its finding 1) |

A formal statement of an architectural difference between XS and
Ironhorse that no existing document names: **where the compiler lives
relative to the machine, and therefore how identifiers become IDs.**
The difference makes one execution shape currently inexpressible on
Ironhorse — a machine that evaluates program after separately-compiled
program against one accreting heap (a **persistent realm**) — and that
shape is required by runtime `eval`/`Compartment.evaluate`, by the
endor daemon's sequential boot, by `@endo/thixotrope` workers, and by
snapshots of any heap such a machine builds.
This document states the difference against the code, enumerates the
consumers it blocks, and specifies the closure plan and its acceptance
bars.
It is a sibling design in the [ironhorse-engine](ironhorse-engine.md)
family, in the pattern of
[ironhorse-test262-convergence](ironhorse-test262-convergence.md);
implementation belongs to that program's lane (PR #600).

## What Is the Problem Being Solved?

### The difference, stated formally

**In XS, the compiler is a component of the machine.**
`fxParseScript` runs inside a live machine, and every identifier a
parse encounters is interned into the machine-wide key table at parse
time; a `txID` is a machine-scoped 16-bit name, not a program-scoped
one.
Consequently any number of sequential evaluations — `machine.eval`
after `machine.eval`, a `Compartment.evaluate` at runtime, xsnap crank
after crank — share one ID space *by construction*; the ID fields
stamped into heap slots are machine-global; and the snapshot's
`KEYS`/`NAME`/`SYMB` atoms serialize the machine's accreted tables
(ironhorse-engine § Ground Truth, § Snapshots).

**In Ironhorse, the compiler is a separate crate outside any
machine.**
`ironhorse-compile`'s `compile_atoms_with(source)` returns
`(bytecode, symbols)` where the IDs in the bytecode are
**program-local ordinals** and the symbols atom is that one program's
id→name table.
Everything downstream is built on the one-program case:

| Property | XS | Ironhorse today |
|---|---|---|
| Compiler location | in-machine (`fxParseScript`) | out-of-machine (`ironhorse-compile`) |
| ID scope | machine-wide, interned at parse | program-local ordinals in the symbols atom |
| Machine name table | accretes across parses (key/name/symbol tables) | exactly one `symbol_names: Vec<String>` (`interp.rs:2853`), bound per program by `link_intrinsics` (`interp.rs:4362`) |
| Globals index | keyed by machine-wide `txID` | `global_props: HashMap<u16, SlotIndex>` keyed by program-local id (`interp.rs:2690`; `define_global_id(id: u16, …)` `interp.rs:4493`) |
| Sequential programs, one machine | native (`eval` after `eval`) | none: `run_program_with_symbols` builds a fresh `Interp` per program (`lib.rs:73`); `Compartment::evaluate{,_with_symbols}` build a fresh throwaway `Interp` per call, seed `globals_by_id`, and write nothing back (`compartment.rs`); the only multi-crank path, `Interp::run`, takes bare bytecode with **no** symbol rebinding (`interp.rs:4875`) |
| Snapshot name tables | `KEYS`/`NAME`/`SYMB` carry the machine's accreted tables | single program's names as `NAME`; `KEYS`/`SYMB` travel empty (`ironhorse-snapshot/src/machine.rs`, `snapshot_image`) |

This was the right shape for the campaign so far, and this document
does not fault it: the differential harness runs one program per
machine on both engines over byte-identical bytecode and atoms, and
nothing in stages 1–6 needed a second program on the same machine —
the snapshot bars' PROG_A/PROG_B are deliberately self-contained, with
no named global crossing the crank boundary.

### What it makes inexpressible

The persistent realm: one machine, many separately-compiled programs,
one accreting heap.
Four consumers in this repository need exactly that shape:

1. **Runtime evaluation** — the point of `eval` and
   `Compartment.evaluate`: guest source compiled *at runtime* whose
   resulting closures persist in the heap.
   The `compartment:intrinsic-surface` fold records the missing
   re-entrant compile seam; this document records the other half —
   the freshly compiled program must **join the machine's symbol
   space**, or the slot IDs it stamps are meaningless to the next
   program and to the snapshot.
2. **The endor daemon's boot** — `polyfills.js` →
   `host_aliases.js` → `ses_boot.js` are three sequential scripts
   into one machine
   ([daemon-endor-architecture](daemon-endor-architecture.md)
   § Unified runner).
   The current boot-bundle bar dual-runs each committed bundle
   independently — correct for locating each bundle's first gap —
   but the stage-4 acceptance sentence ("the endor daemon boot
   bundles run identically on both engines") ultimately means
   *sequentially, on one machine*, which requires this contract.
3. **Thixotrope workers**
   ([thixotrope-ironhorse-engine](thixotrope-ironhorse-engine.md)) —
   per vat: one worker process, one machine, one heap, into which
   flow the boot script, the worker-peer bundle, a small dispatch
   script per delivery, and every guest `evaluate(source)` — with
   engine snapshots at delivery boundaries.
   Many vats, each its own heap; the many-programs-one-heap shape
   recurs *inside every vat*.
4. **`endor worker -e ironhorse`** — the same shape behind the
   envelope protocol; today a named gap
   (`rust/endo/src/ironhorse_engine.rs`).

### The failure modes, concretely

- **Cross-program reference.** Program A runs
  `globalThis.f = () => 1`; separately-compiled program B runs
  `f()`.
  B's symbols atom assigns `f` a different ordinal than A's did, so
  under the id-keyed model B either misses A's global or — the worse
  case — silently **aliases** whichever of A's names happens to share
  the ordinal.
  The slot ID fields already stamped into the arena carry A's
  numbering; nothing re-maps them.
- **Snapshot.** A heap built by two compilations holds slots stamped
  under two numbering schemes.
  The container's single `NAME` table cannot express "id 3 means `f`
  in these slots and `cryptography` in those"; a heap built by
  several differently-compiled programs has **no representation** in
  the current image, and restore's `bind_program_symbols` re-derives
  every name-keyed cache from the one table — sound precisely
  because the model is single-program.

## Design

Close the gap by adding XS's *interning semantics* at the load
boundary, while keeping Ironhorse's out-of-machine compiler — the
crate split (differential isolation, `#![forbid(unsafe_code)]`, the
stage-5 byte-identity bar) is a strength this design preserves.

1. **A machine-interned symbol space.**
   Promote the name↔id tables from per-program to
   machine-accreting: `intern(name) → machine id`, append-only,
   deterministic order, over the same 16-bit ID space as XS, with
   XS's exhaustion behavior mirrored exactly (measured at the pin,
   not guessed).
   The `Interp`'s existing `next_intern_id` already gestures at
   accretion; runtime-created keys (computed property names,
   `Symbol.for`) intern into the same space, which is also the
   `SymbolRegistry` side-table row's story.
2. **Per-program relink at load.**
   A load step maps a program's local ordinals to machine ids by
   name.
   Preferred realization: **rewrite ID operands in a load pass**
   using the existing instruction-length walker (the disassembler
   already advances ID-operand and embedded-code opcodes correctly,
   `lib.rs:80-84`) — the analogue of XS's archive-map linkage, which
   rebases a compiled unit's symbol table onto the live machine.
   Dispatch stays untouched, and the stage-5 byte-identity bar is
   unaffected because identity is measured on compiler *output*,
   before load.
   The alternative — a per-program indirection table consulted at
   dispatch — perturbs the hot loop and the cost model, and is
   rejected unless measurement forces it.
3. **The persistent-realm API.**
   An `Interp`-level `evaluate_program(bytecode, symbols)` — intern,
   relink, run as one crank — beside the existing bare `run`; and
   `Compartment` graduates from replaying `globals_by_id` into
   throwaway interpreters to being a **heap-resident realm** whose
   global object is machine heap state.
   This is the same seam the guest-callable `Compartment` intrinsic
   needs: re-entrant compile (linking `ironhorse-compile`) → intern →
   relink → run in the calling machine.
   One contract, two consumers; they should land as one piece of
   machinery.
4. **Snapshot: the accreted tables ride.**
   Serialize the machine-wide tables in the reserved
   `KEYS`/`NAME`/`SYMB` atoms (the writer already carries the arms,
   empty today); restore rebuilds the hash indexes from them,
   generalizing `bind_program_symbols`.
   Slot ID fields then decode against the machine table —
   position-independent by construction, exactly as in XS.
5. **Determinism and metering stance.**
   Interning order is a pure function of program arrival order and
   within-program atom order — deterministic per release.
   Load-time relinking is host work and unmetered, mirroring XS
   (archive mapping is unmetered; only in-machine *parsing* meters);
   the in-machine compile of the future `Compartment.evaluate` path
   meters as parse per the release's cost table.
   Either way the choice is frozen per release per the
   accuracy-over-parity doctrine (ironhorse-engine § Metering).

## Acceptance Bars

- **Two-program probe.** Program A defines a named global and a
  closure; separately-compiled program B reads and calls it.
  Result agreement against the oracle evaluating A then B on **one**
  XS machine.
  This needs a named oracle-shim extension — sequential evaluation on
  one machine, where today's audited shim compiles and runs one
  program per machine — a separately-audited FFI widening in the
  pattern of the harden-globals install before it.
- **Collision probe.** A and B constructed so the same local ordinal
  names different identifiers; B must observe its own name and never
  alias A's.
- **Suspend/resume probe.** A; snapshot; restore; B — equal to the
  uninterrupted A;B run in result and computrons, extending
  `suspend_resume_equals_uninterrupted` to cross-program named-global
  state.
- **Sequential-boot graduation.** The boot-bundle bar gains a
  sequential mode — `polyfills.js` → `host_aliases.js` →
  `ses_boot.js` on one machine — once the per-bundle gaps close, and
  the thixotrope boot bar (thixotrope-ironhorse-engine Phase 1) rides
  the same mode with its own artifacts.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Parent program; this is a sibling spec in its family. Its § Ground Truth documents the XS tables and atoms this contract completes, and its stage-4 boot acceptance implicitly assumes sequential evaluation |
| [thixotrope-ironhorse-engine](thixotrope-ironhorse-engine.md) | Consumer: its runner model and guest `evaluate` gate on this contract (its Phases 2 and 4 reference it) |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Consumer: the unified runner's three-script sequential boot |
| [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md) | The atom grammar whose `KEYS`/`NAME`/`SYMB` arms item 4 fills |

## Design Decisions

1. **Load-time ID rewriting over dispatch-time indirection.**
   The hot loop and the cost model stay untouched; XS's own archive
   linkage is the precedent; the byte-identity bar is measured before
   load and therefore unaffected.
2. **One contract for runtime eval and sequential host evaluation.**
   The guest-callable `Compartment` intrinsic and the persistent
   realm are the same machinery entered from two directions; building
   them separately would duplicate the interning seam.
3. **The compiler stays out of the machine.**
   Ironhorse copies XS's interning *semantics*, not its architecture:
   accretion lives machine-side at the load boundary; compilation
   remains a pure crate the differential campaign can hold to byte
   identity.
4. **Fill the reserved atoms rather than invent new ones.**
   `KEYS`/`NAME`/`SYMB` already exist in the grammar and the writer;
   using them keeps the container compatible and keeps the
   (out-of-scope) future XS snapshot importer tractable.

## Open Questions

1. **Metering the re-entrant compile.** The compiler crate already
   proves parse-meter determinism (`parse_meter_determinism` tests);
   wiring its computrons into the calling machine's accumulator for
   `Compartment.evaluate` is its own calibration child.
2. **Scope of the oracle-shim sequential mode.** How much of the
   audited FFI seam the two-program probe needs to widen, and whether
   the collision probe can be expressed under it.
3. **ID-space exhaustion.** The exact XS abort on key-table overflow,
   measured at the pin and mirrored, including its observability to
   metering.
4. **Sequencing inside the program lane.** Whether `Compartment`
   heap-residency lands with this contract or with the intrinsic
   child that consumes it.

## Prompt

> many programs in many vats, each its own heap
>
> lets make sure this xs-ironhorse difference is clearly documented
> (formally) and what would be needed to close the gap

(Raised while reviewing
[thixotrope-ironhorse-engine](thixotrope-ironhorse-engine.md), whose
runner model first forced the question; the per-vat framing above is
the correction from that exchange.)
