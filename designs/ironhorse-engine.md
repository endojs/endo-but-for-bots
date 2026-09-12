# Ironhorse Engine: Porting XS to Rust

| | |
|---|---|
| **Created** | 2026-07-02 |
| **Updated** | 2026-09-12 |
| **Author** | endolinbot (prompted) |
| **Status** | Approved (2026-07-02, program supervisor `port-xs-to-rust-memory-safe-engine`; all ten open questions resolved, see § Resolved Questions) |
| **Revised** | 2026-07-04 — **metering doctrine: accuracy over parity** (maintainer directive). The meter is Ironhorse's own release-versioned deterministic cost model, a proxy for real (wall-clock) execution cost, NOT a reproduction of XS's computron counts. The XS differential oracle is retained for **result** correctness only; computron comparison is demoted to advisory telemetry. This selects the "stated determinism-equivalence proof" branch the § Prompt already permitted. See § Metering (requirement 1a) and § Agoric consensus compatibility for the authoritative statement. |
| **Revised** | 2026-07-06 — **string representation: UTF-16 code units, replacing CESU-8** (the `xs2rust-endor-strings-utf16` revisit enabled by the accuracy-over-parity doctrine). String values are stored as UTF-16 code units in chunks; code-unit indexing becomes intrinsically O(1) and the constant-time-index machinery CESU-8 needs is deleted, not ported. String-op cost-table weights are re-based to code-unit length via the cost-calibration instrumentation, not CESU-8 byte counts. See § Value and heap model, § Metering (string-op weights), and resolved question 4. |

Feasibility, architecture, and a staged roadmap for porting the XS
JavaScript engine to Rust as a crate the `endor` daemon embeds
in-process, replacing the C engine behind the existing `Machine`
API while preserving metering, the debugger protocol, and heap
snapshots. This document is stage 1 of the supervised program
`port-xs-to-rust-memory-safe-engine`; the implementation accretes
onto the same branch and pull request as this design.

## Status

Current-state audit: 2026-09-09, base `96db92e23`.
GC policy incorporates the W6 decision at `d38196799`.
This ledger separates implemented surfaces from the roadmap's acceptance bars.
Historical measurements are retained in
[`rust/engine/CHANGELOG.md`](../rust/engine/CHANGELOG.md); they are evidence at
named tips, not a fresh whole-tree conformance run.
The [architecture guide](../rust/engine/ARCHITECTURE.md) describes the current
crate graph and seams; [W6 decisions](ironhorse-w6-decisions.md) record Realm
extraction, engine-trait deferral, transcendental providers and consumer-owned GC policy.

| Roadmap stage | Implementation | Acceptance and deviations |
|---|---|---|
| 1. Thin slice | Landed | Interpreter, meter and oracle harness exist. The early corpus passed historically; present release costs are pinned by oracle-free golden tests. Shared frozen intrinsics are implemented; full SES boot and parity acceptance remain stage-4 work. |
| 2. Object model and control flow | Partial | Broad opcode, object, closure and exception support exists. Exact GC exists but is not the production collection path; chunk reclamation remains open. W6 decision 5 assigns GC scheduling to the engine consumer. |
| 3. Built-ins | Partial | RegExp, promises, BigInt, collections, Intl and Temporal exist. Covered cases are not full built-ins conformance; platform Math is per binary/platform; `deterministic-math` carries cross-host execution. |
| 4. Hardened JavaScript | Partial — bar not met | Object integrity operations exist. Shared Realm extraction is implemented; complete daemon SES boot and SES parity acceptance remain open; named skips are not passing acceptance. |
| 5. Compiler port | Landed; full bar not reverified | Lexer, parser, scoper and coder are the default compiler. Historical byte-identity measurements cover named corpora; budgeted compilation and golden costs now share the runtime release identity. No fresh full-conformance oracle run is claimed here. |
| 6. Snapshots | Partial | Container/store persistence, checked restore and supervisor tests exist. Historically accepted subset expanded substantially; live activations and unsupported side-table states still fail closed. Complete daemon worker protocol integration remains open. |
| 7. Debugger | Not started as an accepted engine surface | No standalone debugger crate or reproduced xsbug/CapTP acceptance is present. Orchestration labels such as “stage-7 child” in historical evidence do not name this roadmap stage. |
| 8. Parity closure and hardening | Partial — bar not met | Debug/release/macOS, sanitizer and benchmark gates exist. Full result equality, the XS-relative performance/footprint envelope and daemon benchmark arm remain open. |
| 9. Ecosystem validation | Not started as a completed campaign | No zero-divergence daemon/Agoric corpus acceptance record establishes this bar. |

### Determinism scope

**`deterministic-math` carries cross-host execution determinism.**
It selects the versioned software libm provider and is enabled by `consensus`.
Matching release, initial state, inputs and host policy are still required.
The ordinary platform-provider default remains scoped per binary/platform.
The canonical cost-table SHA-256 identity describes weights, while the boot
fingerprint also distinguishes provider and locked ICU data profiles.
This qualification applies to every “deterministic per release” claim below.
W6 §4 and [the implementation record](../rust/engine/DETERMINISM-METERING.md)
record C1–C4 prerequisites, C7 oracle scope, and independent cross-host vectors.

## Feasibility Verdict

**Feasible, with the risk front-loaded into the first two stages.**
The XS engine core is roughly 75 KLOC of C (94 KLOC counting its
own RegExp and dtoa implementations), which puts a full port in the
12 to 24 month range for a single sustained lane. What makes the
project tractable rather than open-ended is that the crux — a
**result-correct** transliteration whose meter is a **deterministic,
release-versioned cost model** — is testable within weeks, not
years. Two sub-properties are separated (see § Metering): (a)
*result correctness*, the semantic port, which the differential
oracle checks against XS on every commit (completion kind, value,
error identity); and (b) *meter determinism within a release binary and
platform*, for matching initial state, input and host policy.
The frozen increment points and table do not establish execution equivalence
across different math providers, platforms or builds. The meter's *purpose* is to be the best available
deterministic proxy for real (wall-clock) execution cost, not to
reproduce XS's computron counts; XS-computron parity is an explicit
non-goal. The roadmap below front-loads a differential harness that
executes XS-compiled bytecode in both engines and compares
**results** on every commit; computron counts are recorded
alongside as advisory telemetry (a calibration and
allocation-faithfulness signal), never a build-gating equality
check. If stage 1 cannot hold result agreement on its corpus, or
cannot demonstrate a reproducible per-release meter, the program
stops early with a cheap, informative failure instead of a late,
expensive one.

Kill criteria, named up front:

- Stage 1 cannot reach result agreement with the oracle on the
  stage corpus after the interpreter subset is complete, or cannot
  demonstrate a deterministic-per-release meter (identical
  computrons across repeated runs of the same build).
- Stage 5 cannot reach byte-identical bytecode output against the
  oracle compiler on the conformance corpus.
- The stage 8 performance envelope (geometric mean within 2.0x of
  XS) proves unreachable by more than 2x after the planned
  optimization pass.

## What Is the Problem Being Solved?

Endo and agoric-sdk trust XS with their most security-critical
work: executing untrusted, guest-supplied JavaScript under
Hardened JavaScript confinement, with deterministic metering that
Agoric treats as a consensus input. That trust rests on ~94 KLOC
of memory-unsafe C that parses and executes hostile input. The
[Endor architecture](daemon-endor-architecture.md) already moved
the supervisor to Rust; the engine itself remains the largest
unsafe surface in the process, and the `shared` worker platform
(XS machines inside the supervisor process) makes an engine
memory-safety bug a whole-daemon compromise.

A Rust port raises memory-safety confidence for exactly the
component that faces untrusted input, while an interpreter-only
design preserves the properties that make XS uniquely suited here
and that mainstream engines cannot offer: deterministic execution,
deterministic and reproducible computation metering (a
release-versioned cost model, § Metering), whole-heap snapshots, and
native Compartment support.

## Ground Truth: What Is Being Ported

The source reference is `Moddable-OpenSource/moddable` at
`23b4d6b0a65f35209d9118c4c13c6c9b3e68784d` (Moddable 8.3.1).
This is also the superproject's current `c/moddable` gitlink.
The original 8.2.3-to-8.3.1 bump narrative is preserved in
[`rust/engine/CHANGELOG.md`](../rust/engine/CHANGELOG.md).
The measurements below describe the XS reference, not the Rust resident layout.

**Interpreter.** `fxRunID` in `xs/sources/xsRun.c` is a single
~4,000-line dispatch loop, computed-goto under GCC/Clang and a
plain `switch` otherwise, over the `XS_CODE_*` bytecode set defined
in `xsCommon.h`: 245 opcodes (many in 1/2/4-byte operand-width
variants), with per-opcode size and name tables (`gxCodeSizes`,
`gxCodeNames`). The machine is a slot-stack machine: one downward-
growing stack of `txSlot` cells holds values, call frames
(`XS_FRAME_KIND` slots linked through `next`), and scopes; the
frame geometry is fixed (result at `frame+1`, function at
`frame+2`, `this` at `frame+3`, arguments at `frame-1-i`, argument
count in `frame->ID`).

**Heap.** A `txSlot` is 32 bytes on 64-bit targets: `next` pointer,
kind byte, flag byte, 16-bit ID, and a 16-byte value union with
roughly 40 arms across ~66 slot kinds. Objects are linked lists of
property slots (no hidden classes or shapes). There are two heaps:
a slot heap of fixed-size slots that never move, and a chunk heap
of variable-size data (strings in CESU-8, ArrayBuffers, BigInt
digits, bytecode) that slide-compacts during collection. The
collector (`fxCollect` in `xsMemory.c`) is exact, non-generational
mark-and-sweep, with weak collections handled in a dedicated mark
phase.

**Metering.** Under `mxMetering`, the dispatch macro adds
`XS_CODE_METERING` (1<<16) to `the->meterIndex` before every
bytecode; built-in operation macros add `XS_BUILTIN_METERING`
(1<<14) per step via `mxMeterOne`/`mxMeterSome`, with hand-tuned
`mxMeterSome(k)` on optimized fast paths to match the unoptimized
count; the parser adds `XS_PARSE_CODE_METERING` (1<<16) units. The
meter is a 16.16 fixed-point value; the host callback installed by
`fxBeginMetering` sees `meterIndex >> 16` ("computrons"). The
check is not per-bytecode: `fxCheckMetering` runs only at
loop-closing points (backward branches, call and return, exception
catch, generator and async resume), and a false return aborts with
`XS_TOO_MUCH_COMPUTATION_EXIT`. Note the divergence: the XS fork
agoric-sdk pins today (`agoric-labs/moddable`, XS 13.3.0) meters
one integer per bytecode with no fixed point, and agoric-sdk's
consensus-facing meter version is `xs-meter-37`
(`packages/xsnap/api.js` as of 2026-07-01). Metering changes are
consensus-breaking for Agoric because computron counts feed the
swingset run policy (how many cranks fit in a block); divergent
counts across validators halt the chain (agoric-sdk issues #4911,
#5040, #6361). This paragraph describes XS and the current Agoric
fleet; Ironhorse does **not** lock its own meter to these values.
Ironhorse's meter is its own release-versioned cost model (§ Metering),
and its consensus story rests on every validator running the same
Ironhorse release rather than on XS-computron parity (§ Agoric consensus
compatibility).

**Snapshots.** `xsSnapshot.c` writes a length-prefixed big-endian
FourCC atom container: `XS_M` wrapping `VERS` (engine version, slot
width, endianness), `SIGN` (host callback-table signature), `CREA`
(machine creation parameters), `BLOC` (chunk data), `HEAP` (slot
images), `STAC` (stack slots), `KEYS`/`NAME`/`SYMB` (key and symbol
tables). The on-disk form is position-independent: slot pointers
are projected to dense indices, chunk pointers to offsets, and
native-function pointers to indices into the engine's static
callback table plus a host-supplied callback array; the reader
rebases indices onto fresh heaps and re-hashes Maps and Sets.
xsnap restores at boot and writes on command; agoric-sdk streams
snapshots over dedicated file descriptors.

**Debugger.** `xsDebug.c` speaks the xsbug protocol: XML messages
framed by CRLF, engine-to-IDE wrapped in `<xsbug>`, parsed by a
small hand-rolled state machine. Commands include `go`, `step`,
`step-inside`, `step-outside`, `set-breakpoint` (plus condition,
hit-count, and trace variants), `select`, `toggle`, `eval`, and
profiling start/stop; responses carry `<frames>`, `<local>`,
`<global>`, `<break>`, `<log>`, and lazily expandable property
trees. Transport is host-provided through five platform hooks
(`fxConnect`, `fxDisconnect`, `fxIsConnected`, `fxReceive`,
`fxSend`), which is what lets the
[debugger design](daemon-xs-worker-debugger.md) route the protocol
over the envelope bus without touching `xsDebug.c`.

**Hardened JavaScript.** XS implements SES natively:
`xsLockdown.c` provides `lockdown` (freezes shared intrinsics and
replaces per-compartment evaluators), `harden` (transitive freeze),
and the XS extensions `petrify` and `mutabilities`; `xsModule.c`
provides the native `Compartment` constructor with `evaluate`,
`import`, `importNow`, and a per-compartment `globalThis` over
shared frozen intrinsics. XS is the only engine with a native
Hardened JavaScript implementation.

**Conformance.** On the 2026-07-02 test262.fyi run (53,404 tests),
XS passes 81.57% overall, but the number is dominated by the
deliberate absence of Intl (intl402: 25 of 3,341); its language
section is 98.2%, and Moddable's own conformance accounting
(strict and sloppy runs, implemented features only) reports 99.95%
language / 99.85% built-ins.

## Build Approach: Extend a Rust Engine, or Port XS?

Survey of Rust-native (and one Zig) engines, 2026-07-02, from
test262.fyi and source inspection:

| Engine | test262 | Metering | Snapshot | SES/Compartment | Notes |
|---|---|---|---|---|---|
| Boa | 95.4% | Loop/recursion limits; per-instruction budget only behind the `fuzz` feature | None | None; SES shim untested | MIT; most mature embedding API; `Math.random` not hookable today; Rc-style traced GC |
| Kiesel (Zig) | 93.3% | None | None | None | MIT; Boehm conservative GC precludes precise snapshots |
| Nova | 77.2% | None | None (index-arena heap is snapshot-friendly in principle) | None | MPL-2.0; RegExp non-compliant; 2026 activity slowing |
| Brimstone | >97% language (self-reported) | None | Ships a heap serializer | None | MIT; single author; "not ready for production"; copying GC in very unsafe Rust |
| XS (C) | 98.2% language | Exact, consensus-grade | Native | Native | The thing being ported |

The decisive observations:

1. **No Rust engine has deterministic metering, and Ironhorse's meter
   must be a first-class, reproducible cost model either way.**
   Under the accuracy-over-parity doctrine (§ Metering) Ironhorse's
   meter is a *new* release-versioned deterministic model whatever
   engine underlies it, so metering is no longer, by itself, the
   argument for porting XS rather than extending Boa: any base
   would need the same purpose-built meter. What porting XS *does*
   buy the meter is a well-understood, guest-reachable increment
   seam (XS's per-opcode and per-builtin-step points, whose *check*
   sites also shape observable abort behavior) that the same-ISA
   differential oracle can validate opcode-for-opcode on **results**
   — a seam a foreign engine with a different bytecode set does not
   offer. The decisive reasons to port XS are the other three
   requirements below (result-conformance semantics, native SES,
   native snapshots); metering rides along on the same ISA rather
   than driving the choice.
2. **No Rust engine has Compartment, lockdown, or harden.**
   Requirement 5 would mean either running the `ses` shim on an
   engine where lockdown has never been exercised (Boa is the only
   plausible candidate and it is untested), or implementing native
   SES in a foreign ~240 KLOC codebase we do not control.
3. **Snapshot save/restore exists nowhere except a single-author
   experimental engine.** Requirement 1's snapshot surface would
   be new work in any engine.

**Decision: port XS, as an oracle-checked transliteration.** The
Rust engine adopts XS's bytecode ISA (the 245-opcode `XS_CODE_*`
set), its meter increment *points* (as the instrumentation seam —
but **not** its weights, which become release-versioned calibration
constants of Ironhorse's own cost model, § Metering), its two-heap
object model semantics, its snapshot atom grammar, and its debugger
protocol, while re-architecting the *implementation* for safety
(index-based arenas instead of pointer graphs, safe Rust instead
of C). XS itself, already compiled and linked by the existing
`xsnap` crate, becomes a continuously-exercised differential
oracle in CI for **result** correctness: every conformance and
fuzz run executes both engines and compares observable results
(completion kind, value, error identity), with computron counts
recorded alongside as advisory telemetry rather than compared for
equality.

Considered and rejected: extending Boa. Reason: SES and snapshots
would be new work anyway; ~240 KLOC of foreign engine code
replaces one audit problem with another; and result-semantics
fidelity (Ironhorse is a transliteration of XS behavior) is what the
same-ISA oracle checks cheaply. (Metering is no longer a reason
either way — observation 1 — since Ironhorse's meter is a purpose-built
release-versioned model on any base.) Considered and rejected:
building on Nova's data-oriented heap. Reason: conformance is 20
points behind, RegExp is non-compliant, MPL-2.0, and the same
metering/SES gaps apply. Considered and rejected: wrapping XS in
a tighter sandbox (Wasm, process isolation) instead of porting.
Reason: already have process isolation (`separate` platform); the
goal is raising confidence for the in-process `shared` platform
and the long-term maintenance position, which sandboxing does not
address.

The staging is hybrid in one specific, temporary way: until the
compiler port lands (stage 5), the Rust interpreter executes
bytecode produced by the XS compiler through the oracle harness.
This guarantees the bytecode stream is identical during the phase
where interpreter result correctness (and the meter's
determinism/calibration against a fixed bytecode stream) are being
proven, and confines the C dependency to development and CI; no
intermediate stage
ships a mixed C/Rust engine to production.

## Architecture

The implemented topology is the nine-member workspace listed in
[`rust/engine/ARCHITECTURE.md`](../rust/engine/ARCHITECTURE.md).
`ironhorse-meter` owns the digest-pinned weights and `ironhorse-text` owns CESU-8
symbol-name conversion; neither a separate SES crate nor a debugger crate exists.
`rust/endo` embeds IronHorse directly alongside its separate xsnap integration.
The SQLite store backend belongs to the outer workspace and links bundled SQLite.
See the architecture guide for dependency direction and runtime versus test edges.


### Value and heap model

The single largest safety re-architecture: XS's pointer-linked
slot graph becomes an index-based arena.

- A `SlotIndex(u32)` replaces `txSlot*`; slots live in an arena with a free list.
  Rust `Slot` has no stable `repr(C)` contract and is 24 bytes on the audited
  64-bit build, not XS's 32-byte resident record.
  The snapshot codec serializes fields into a separate fixed-width wire record;
  Rust struct layout is not the snapshot ABI.
  XS accounting constants do not measure resident slots, bookkeeping vectors or
  side-table allocations, so they cannot establish the footprint acceptance bar.
- A `ChunkOffset(u32)` replaces chunk pointers; the chunk heap is
  a growable byte arena with the same `txChunk` header discipline
  and slide-compaction during GC (offsets are rewritten exactly
  where XS rewrites pointers).
- The GC is XS's exact, non-generational mark-and-sweep, ported
  semantically: mark from machine roots (stack, globals, keys,
  host roots), sweep slots to the free list, compact chunks,
  handle weak collections in the dedicated phase. Index arenas
  make the collector safe code: there are no raw pointers to
  invalidate, and a stale index is a logic bug caught by kind
  checks, not undefined behavior.
- String values are stored as **UTF-16 code units** in chunks
  (revised 2026-07-06 from the XS Ironhorse build's CESU-8; resolved
  question 4). The stored form is exactly what the specification
  defines a string to be — a sequence of 16-bit code units, lone
  surrogates included — so every code-unit-addressed operation
  (`length`, `[i]`, `charCodeAt`, `codePointAt`, iteration, ordering
  comparison) is **intrinsically O(1) per code-unit access** with no
  decode step, and the auxiliary constant-time-index machinery a
  variable-width encoding needs — cached last-access cursors,
  ASCII/BMP fast paths, index side-tables — is **deleted, not
  ported**. The trade is explicit: roughly 2 bytes per code unit
  where CESU-8 spends 1 on ASCII, bought for simpler,
  obviously-correct indexing. Because string chunk bytes change
  size, `currentHeapCount` and chunk-growth observables shift
  relative to XS — fine under the accuracy-over-parity meter
  (§ Metering), but the snapshot-atom round-trip fixtures and the
  differential harness's allocation-telemetry expectations must be
  updated **deliberately with this change, not silently**. NaN
  canonicalization follows `mxCanonicalNaN`.

An index arena also makes snapshots nearly structural: XS's write
path exists to *convert* pointers into indices and offsets; the
Ironhorse heap is already in that form.

### Interpreter and dispatch

A `match` over a `#[repr(u8)]` opcode enum is compiled by LLVM to a jump table.
The current implementation keeps the program counter local to `dispatch_at_inner`
and the stack, frame registers, and scope state on `Interp`, alongside its arenas
and side tables.
The declaration in
[`interp/state.rs`](../rust/engine/ironhorse-vm/src/interp/state.rs) generates those
fields and their GC hook inventory.
Call boundaries save caller state in `CallerState`; suspended activations carry a
`SavedFrame`.
Any future register-localization optimization must be evaluated against the
[`dispatch_bench` controls](../rust/engine/benches/README.md), rather than assuming
that a separate small register struct already provides that benefit.

No JIT, ever (requirement 4): no code generation,
no execution-count-dependent behavior, no fast paths whose cost
differs from the metered count. Tail-call threaded dispatch (the
unstable `become` feature) is a possible later optimization behind
the same opcode semantics; it is explicitly not load-bearing for
the performance envelope.

The stack is a `Vec`-backed slot stack with the same frame
geometry as XS (frames are stack slots, arguments below the frame,
fixed offsets for result/function/this), because the debugger's
frame walk, the exception machinery, and several opcodes observe
that geometry.

### Metering (requirement 1a)

**Doctrine (2026-07-04, maintainer directive): accuracy over
parity.** The meter's purpose is to be the best available
**deterministic proxy for real (wall-clock) execution cost**, not
to reproduce XS's computron counts. XS-computron parity is an
explicit non-goal. Two properties are separated:

- **Determinism within a release binary and platform.**
  The frozen increment points and integer weights determine the charge for a
  given execution trace.
  Identical initial state, input and host policy on the same binary/platform
  must produce identical computrons.
  The table's canonical digest is platform-independent, but the trace can depend
  on platform transcendental results; a release name alone does not guarantee
  identical execution on every host, architecture or build.
  See [Determinism scope](#determinism-scope) and W6 §4 for the provider decision.
- **Accuracy across releases (recalibrated, versioned).** The cost
  table is a *model* of real execution cost. It is recalibrated
  between releases as measurement improves, and every recalibration
  is a meter-version bump (`ironhorse-meter-N`) shipped with the
  release — never a silent change. Better accuracy is bought at
  release boundaries; reproducibility within a release is never
  traded for it.

The meter is a `u64` accumulator; the increment *points* are
inherited from XS as a well-understood, guest-reachable
instrumentation seam, but the *weights* are entries in Ironhorse's own
release-versioned cost table, not XS's constants:

| Event | Increment point (seam, from XS) | Weight |
|---|---|---|
| Bytecode dispatch | `mxBreak` metering variant in `xsRun.c` | cost-table entry, per opcode |
| Built-in operation step | `mxMeterOne`/`mxMeterSome` on the `mx*` operation macros | cost-table entry, per built-in step |
| Allocation | slot alloc (`XS_SLOT_ALLOCATION_METERING`) / chunk byte (`XS_CHUNK_ALLOCATION_METERING`) | cost-table entry |
| Compilation | source admission, tokens, scope/code/optimizer work | shared frozen entries; incremental host budget |

**Deriving and freezing the cost table.**
The shipped weights are XS-derived historical estimates, now reified in
`rust/engine/ironhorse-meter` with a fixed-order table and a pinned SHA-256 digest.
They have not yet been calibrated against measured Ironhorse wall-clock cost.
Source compilation now shares the running crank's budget from before the first
source-sized allocation through serialization.
`CompiledSource` reports whole and raw front-end costs already charged by its
incremental callback; `eval` and `Function` must not debit those reports again.
The Endo fresh and persistent seams start the budget before compilation and
preserve its baseline and consultation window through execution.
A compiler budget refusal is a host `MeterAbort`, never a catchable syntax error.
The compiler contains a private unwind to stop nested infallible coder loops
immediately and rejects `panic=abort` builds; unrelated panics propagate unchanged.

The [cost-calibration instrumentation](ironhorse-meter-opcode-cost-instrumentation.md)
is the path to future evidence-based calibration, not evidence already obtained.
A weight or charging-point change requires a new `ironhorse-meter-N` release and
an explicit update to the local golden corpus.
Snapshots carry both the release name and actual table digest and refuse a mismatch.
Older name-only meters cannot establish which weights produced them and are refused.
The oracle certifies observable results; all oracle computron comparisons,
including the legacy `--gate-meter-exact` option, are advisory drift telemetry.

**String-op weights are re-based to UTF-16 (2026-07-06).** With
string storage revised to UTF-16 code units (§ Value and heap
model), the cost-table entries for string operations — concat,
compare, index, slice, char access — are expressed against the
representation's real cost shape: **O(n) in code-unit length** for
the length-proportional operations, **O(1) for a single code-unit
access** (the cursor and fast-path machinery CESU-8 indexing
required no longer exists to meter).
Future calibrated weights will derive from the
[cost-calibration instrumentation](ironhorse-meter-opcode-cost-instrumentation.md)
and a timing driver measuring the UTF-16 implementation, rather than CESU-8 byte
lengths or values chosen to match the oracle's counts.
C1 currently supplies histogram/model scaffolding only.
Like every other entry, weights are frozen per release and changed only with an
`ironhorse-meter-N` bump.

**Check points and abort.** Checks happen at XS's loop-closing
points (backward branch, call, return, catch, generator iteration,
async resume): the accumulator is compared against the crank limit
and the crank aborts on refusal. The *points* are inherited because
they shape observable abort behavior; the *point at which* a given
program aborts is an ironhorse-release-defined outcome (a function of
the Ironhorse cost table), deterministic per release, and is **not**
required to coincide with XS's abort point. A metering-limit abort
is therefore an ironhorse-meter outcome, not an oracle-checked parity
fact.

Two release-defined check points sit outside the dispatch loop
(architecture review finding 2, F012 and F014).
The regexp matcher consults the host every `MATCH_CHECK_STRIDE`
steps of a match, charging what the match has accumulated so far, so
an armed crank limit can halt a catastrophic backtracking match
instead of waiting for it to finish; the charge is the same
`match_meter_raw` armed or un-armed, so the stride changes when the
meter is consulted and never what is counted; like every consultation
point it is outside the `METR` cost-table gate, which covers what a
program is charged, not where it can be interrupted.
And the check point is fail-closed: a meter that is armed (the
snapshot carries `interval != 0`) but has no host attached aborts at
its first check rather than running unbounded, because the host
callback cannot travel in a snapshot and a restored machine that
skipped every arm form used to report itself metered while
consulting nobody.

**The shipped embedder arms the meter.** The `rust/endo` seam runs
every crank under a `MeterBounds` policy: armed by default with a
per-crank computron limit, consulted on a fixed cadence, enforced
against the machine's absolute meter as `crank start + limit`, with
the check window re-based at every crank start (as xsnap resets its
meter per crank) and the host reattached on every resume and rewind
through the persistent path.
Re-basing per crank is what makes a refusal a pure function of the
crank's own cost and the policy, whatever the machine's suspend,
rewind, or migration history.
Un-metered execution is an explicit `MeterBounds::Unbounded` opt-in.
The policy is consensus-relevant like the checkpoint cadence, and like
the cadence it is not recorded in the store (only the armed interval
rides the `METR` atom, never the limit): replicas must agree on it out
of band to refuse the same cranks.
The meter checks loops, regexp work and routed allocation/operation admission.
[W2 allocation](../rust/engine/architecture-review/2026-09-06/W2-ALLOCATION.md)
added slot/chunk ceilings, fallible guest-sized reservations and uncatchable
`HeapExhausted` stops.
These bound arenas and selected scratch/collection paths, not total process memory
or aggregate side-table allocation.
Allocation-pressure collection and chunk reclamation remain open.

**The oracle is result-only; computrons are advisory telemetry.**
The differential harness compares **results** (completion kind,
value, error identity) between Ironhorse and XS, and a result
divergence is a red build. Computron counts from both engines are
recorded *alongside*, as a comparative/calibration signal and as an
allocation-faithfulness canary (a large, unexpected computron drift
often means the allocation sequence diverged, which is itself a
*result*-relevant bug worth surfacing) — but computron **equality**
with XS is never an acceptance gate. XS's hand-tuned
`mxMeterSome(k)` fast-path annotations are consequently no longer a
parity obligation the port must reproduce weight-for-weight; where a
built-in's port keeps them, it is to preserve the meter's *internal*
consistency across fast and slow paths within an Ironhorse release, not
to match XS. Ironhorse must be
*internally* deterministic within the stated binary/platform scope (the differential harness
and golden vectors verify computron stability for their covered inputs;
cross-platform coverage does not prove arbitrary executions equivalent); cross-engine computron equality with XS is neither
required nor pursued.

The actual embedder seam arms a meter host closure and supplies compilation budgets.
The Endo wrapper starts the crank budget before compilation and retains it through
execution; persistent failures rewind to the last checkpoint.
It does not preserve the xsnap metering method list verbatim or use a thread-local
`CRANK_LIMIT` as a shared engine abstraction.
See [W4's implementation record](../rust/engine/architecture-review/2026-09-06/W4-IMPLEMENTATION.md)
and `rust/endo/src/ironhorse_engine.rs` for the wired lifecycle.

### Agoric consensus compatibility (the doctrine's binding question)

Agoric metering is consensus-critical: computron counts drive
gas/fees and must be identical across all validators, or the chain
halts.
Adopting Ironhorse as the consensus meter requires coordinated release identity
**and** the current execution scope: matching release binary, platform, initial
state, input and host policy.
A shared table alone does not imply a shared execution trace or identical computrons.
Heterogeneous-platform consensus requires the provider work and coverage recorded
in W6 §4; a coordinated release label does not supply that guarantee by itself.
The reference is Ironhorse's own release costs, not equality with XS's counts.

**Decision — (b): Ironhorse ships its own release-versioned native meter
that consumers, Agoric included, adopt at a coordinated upgrade
boundary.** This is the same shape every XS meter change has ever
shipped as — an `xs-meter-N` bump at a coordinated chain upgrade
(§ Ground Truth) — restated for Ironhorse as `ironhorse-meter-N`. It aligns
with, and is now load-bearing for, resolved questions 1 and 2: the
oracle is the `c/moddable` pin (for *results*), and consensus entry
is by coordinated upgrade, never mixed-fleet operation. A
bit-for-bit **XS-computron-compatible meter mode (option a) is not a
build-phase goal**, and pursuing one would re-impose the very parity
the maintainer declared a non-goal — freezing Ironhorse's meter to a
2023-era fork's weights, worse for accuracy and heavier to maintain,
to buy a continuity the coordinated-upgrade mechanism already
provides.

**The door to (a) stays open as a versioned meter, not a doctrine
change (conditional (c)).** Because the meter is release-versioned by
construction, an XS-computron-compatible table *can* be added later
as one more named meter version (`ironhorse-meter-xs13compat`, say) if —
and only if — a concrete consensus consumer needs bit-for-bit
continuity with today's XS metering *without* a governance-approved
gas re-pricing at the switchover. That would be a bounded, optional
compatibility surface gated on a real consumer, its own design
amendment, with its own oracle pin against the agoric-labs fork; it
is explicitly out of scope now and is not what the accuracy-mode
meter is calibrated against.

**Consequence for consumers.** Switching a live chain's meter changes
gas costs, so adoption is a chain-governance / migration event, not a
drop-in. Ironhorse therefore targets **(b) — a new ironhorse-native metered
release consumers opt into at an upgrade boundary** — with (a)
available only as the conditional, versioned compatibility mode
above. This choice bounds the whole doctrine: Ironhorse's accuracy-mode
meter is free to model wall-clock cost as well as it can, precisely
because it is never asked to be simultaneously bit-compatible with a
legacy meter on a running fleet.

### Snapshots (requirement 1c)

Ironhorse writes an `XS_M`-shaped container with its own version discriminator,
field codec, meter identity and mechanical boot fingerprint.
The current atom grammar is
[`CANONICAL_ATOM_ORDER`](../rust/engine/ironhorse-snapshot/src/format.rs), not a
second hand-maintained tag list in this document.
Slot records are serialized field by field; Rust resident layout is not the ABI.
The container codec and paged `HeapStore` representation have distinct version gates.
`MachineSnapshot` provides file/CAS operations, while `rust/endo` embeds the
persistent engine directly; this is not an unchanged xsnap supervisor API.
Production writes materialize encoded buffers, so the file helper is not a
streaming, constant-memory serializer.
See the [architecture guide](../rust/engine/ARCHITECTURE.md#seam-2-heapstore) for
validation, checkpoints, rollback and the remaining daemon worker-protocol gap.

**The format question.** Reading *XS-produced* snapshots is more
tractable than it first appears, because the on-disk form is
already position-independent (indices, offsets, and callback-table
ordinals rather than raw pointers); an importer is a decoder from
field-encoded slot images and chunk data into Ironhorse arenas, not a
layout-compatibility exercise. It is still real work (every slot
kind's union arm must be decoded, both endiannesses and the
version matrix handled), and no Ironhorse use case requires migrating
a live XS heap: the endo daemon restarts workers from durable
persistence, and agoric replays from transcripts and rebuilds
snapshots. The design therefore ships the Rust-native writer and
reader first, and treats the XS snapshot importer as bounded,
optional work gated on an actual migration need (resolved
question 3: out of scope for the build phase).

### Debugger (requirement 1b)

The stage-7 target is to implement the xsbug wire protocol byte-compatibly: the same
XML elements, the same CRLF framing, the same command set
(including breakpoint conditions, hit counts, and profiling), so
`xsbug`, the headless `xsbug-node` client, and the endo
`DebugSession` SAX parser of the
[debugger design](daemon-xs-worker-debugger.md) work unchanged.
The five C platform hooks collapse into a Rust `DebugTransport`
trait (the envelope-bus buffers of that design implement it);
"always compiled, dormant by default" becomes a runtime flag
rather than an `mxDebug` compile-time bifurcation, with the same
negligible dormant cost (one branch at debug points). The
break-on-uncaught-exceptions augmentation (the `firstJump` walk)
is carried into the port as a native feature: the Rust exception
machinery keeps the equivalent of the jump chain with its
JS-versus-host flag, and the `uncaughtExceptions` pseudo-
breakpoint lands in stage 7 rather than as a C patch.

### Hardened JavaScript and Compartment (requirement 5)

Native, from the start, as in XS: `lockdown`, `harden`, `petrify`,
and `mutabilities` port from `xsLockdown.c`; `Compartment` ports
from `xsModule.c` with per-compartment globals and evaluators over
shared frozen intrinsics. `harden`'s transitive freeze worklist
operates on the slot arena. The acceptance bar is that
the endor daemon's actual boot sequence (`polyfills.js`, then
`ses_boot.js` lockdown, then the HandledPromise shim, per
[daemon-endor-architecture](daemon-endor-architecture.md) §
Unified runner) runs identically on both engines, plus the SES
test suites XS itself is exercised against.

**Realm implementation (2026-09-12).**
The host-side `Machine`, `Compartment` and `Intrinsics` types remain public,
following [W6 decision 1](ironhorse-w6-decisions.md#1-realm--decided-extract-it).
`Machine` now owns the shared interpreter and arenas through its `Intrinsics` owner.
Each compartment retains a `Realm` with a separate global object, bindings,
intrinsic binding permit and source compiler policy.
Repeated evaluations preserve globals; siblings share the same frozen primordial
objects, rather than independently copied graphs.
Boot links the full primordial vocabulary and freezes all primordial instances,
including non-global generator/async and iterator prototype families, before
reporting `is_locked_down()`.
The prior `BootTemplate` has been replaced.

The machine owns the canonical symbol table because stored property IDs must retain
one meaning across its heap.
Evaluation retains its public `&self` signature using a checked exclusive machine
borrow; sibling/reentrant entry returns `RealmBusy` until the active crank completes
and drains, instead of switching globals under suspended work.
Raw heap endowments remain refused until a provenance-bearing value-transfer API exists.
Named scalar endowments now bind at evaluation and persist until explicitly rebound.
The optional intrinsic permit restricts global bindings, not transitive capabilities.
GC retains inactive live Realms and rooted object identities.
Names and tagged-template cache entries remain machine-owned costs after Realm drop.

Shared-Realm snapshots remain explicitly refused; the current Endo persistent path
uses standalone `Interp` capture/restore.
The snapshot row contract is now `snapshot_api::ROW_SCHEMA_VERSION`, while `interp`
is private and the arena accessors remain read-only.
The common `JsMachine` engine trait stays deferred under W6 decision 2.
Full daemon SES acceptance and host-function registration remain open; the new
`ironhorse-runtime` compiler adapter supplies dynamic source compilation, not a
host-callable registration table.
See the [architecture guide](../rust/engine/ARCHITECTURE.md) for the implemented
boundary, retained costs and release rules.

The same review's integrity findings (F015 `harden` stale marks,
F057 frozen globals writable by bare name, F058 exotic objects
unfreezable, F061 the `with` and descriptor paths bypassing the
`mop_*` seam) are pinned by
`rust/engine/ironhorse-vm/tests/hardened_js_boundary.rs`, and the
`with` seam additionally by
`rust/engine/ironhorse-262/tests/with_statement_mop.rs`, which gates
it against the pinned XS oracle.
Two of the five were already fixed on the mainline when this work
began — F015 by the `harden` mark-clearing loop, and F058 whole —
so their entries here are pins, not repairs.
The review's descriptor-path evidence for F061 did not reproduce:
`descriptor_from_object` already routes through `mop_get`, and
`Reflect.ownKeys` agrees between a function and a trapless proxy
over it.
The test262 `$262` host object, whose `detachArrayBuffer` is a
memory-detach primitive no hardened realm should carry (F143), is
no longer part of the boot: a default machine has no `$262`, and the
conformance harness installs it explicitly through
`Interp::install_test262_host` (pinned by
`rust/engine/ironhorse-vm/tests/test262_host_gate.rs`; the snapshot
boot-layout generation was bumped for the boot-metadata change).
One divergence stays open there: `ironhorse-compile` scopes a
strict-mode *program's* top-level `var` as a frame local rather than
a global-object property, so `'use strict'; var g = 1;` leaves
`globalThis.g` undefined; that is a compiler question for the
differential harness, not an interpreter integrity gap.

### Minimizing `unsafe` (requirement 2)

The budget is zero in shipped engine crates, enforced by
`#![forbid(unsafe_code)]` on every library root in the `rust/engine` workspace
except the audited `xs-oracle` FFI harness, checked by the Cargo-metadata test.
Some harness binary roots lack that declaration; the check does not claim otherwise.
This is a workspace-source rule, not a claim that transitive dependencies or
the daemon contain no C.
The index-arena design is what makes this achievable: no raw
pointers, no self-referential structures, no `unsafe` GC.

| Zone | `unsafe` allowed | Justification and containment |
|---|---|---|
| `ironhorse-vm` and other engine crates | No (`forbid`) | The headline property; index arenas remove the need |
| `xs-oracle` | Yes | FFI to XS via the existing xsnap `ffi.rs`; dev and CI only, never linked into a shipped engine |
| `ironhorse-store-sqlite` (outer workspace) | Bundled SQLite through `rusqlite` | Production persistence backend; outside the engine workspace unsafe budget |
| `xsnap` crate glue | Existing FFI remains until the C engine is retired; Ironhorse paths add none | Audited seam, shrinking over time |

Any future proposal to introduce `unsafe` into an engine crate (a
measured hot path, a mmap'd snapshot reader) requires amending
this design with a per-use justification, an audit note, and Miri
coverage; it is a design change, not a code review nicety.

### Memory-safety confidence (requirement 3)

What is actually bought, stated so it can be weighed against
performance: elimination of spatial and temporal memory errors
(out-of-bounds, use-after-free, double-free, type confusion via
union misuse) in the component that parses and executes untrusted
JavaScript, under a `forbid(unsafe_code)` regime where that claim
is compiler-checked rather than audited. The historical record
this addresses is concrete: the class of bugs like the host-frame
off-by-one documented in
[daemon-rust-xs-performance](daemon-rust-xs-performance.md) (raw
slot-pointer arithmetic silently reading wrong stack slots) is
unrepresentable against typed arena accessors.
CI enforcement is `forbid(unsafe_code)`, ordinary arena/GC unit tests, the fuzz
targets below, and ASAN/UBSAN instrumentation scoped to the C oracle harness.
The oracle sanitizer runner compiles all XS and shim C objects with Clang and
links the sanitizer runtimes into the Rust harness; it does not instrument Rust.
UBSAN excludes the pinned upstream `c/moddable/xs/sources/` directory, whose
unaligned loads and pointer arithmetic triggered the initial reports.
ASAN still checks those sources, and both sanitizers check our shim and platform
layer; executable C fault probes enforce that exclusion boundary.
The runner and CI check fail on every remaining report; the sanitizer lane is
blocking after applying this source-scoped exemption.
There is no Miri CI lane, and ordinary unit-test names are not Miri evidence.
This W0 amendment (2026-09-08, F034) replaces the earlier unimplemented Miri gate.
Logic bugs
(a wrong index reaching a kind-checked accessor) remain possible
and surface as deterministic panics, which the supervisor already
treats as worker death; a panic is a crashed crank, not a
compromised daemon.

### test262 conformance (requirement 6)

`ironhorse-262` is a dual-run harness: it executes each test on Ironhorse
and on the oracle, recording four-valued **result** agreement (both
pass, both fail, ironhorse-only fail, oracle-only fail), and — when
metering is enabled — the two engines' computron counts *alongside*
as advisory telemetry. The acceptance bar for the build phase is
**result parity with XS**, stated precisely: on the pinned test262
revision, Ironhorse's pass vector equals the oracle's pass vector on the
language and built-ins sections (XS deliberately omits Intl; Ironhorse
omits it identically). Computron counts are **not** part of the
acceptance bar: they are reported for calibration and as an
allocation-faithfulness canary, but a computron difference against
XS is not, by itself, a failing test (per the accuracy-over-parity
doctrine, § Metering). Ironhorse's own metering acceptance is
*determinism*: the harness re-runs metered tests and confirms
identical computrons across repeated runs of the same binary and platform.
Cross-platform equality remains subject to the [determinism scope](#determinism-scope).
Matching the *fail* vector matters as much as the pass vector: a
test Ironhorse passes that XS fails is a semantic divergence and gets
an exceptions-ledger entry or a fix, never a silent "improvement".

Coverage bootstraps by section, tracking the stage ladder:
the committed cases now live under
`packages/test262-runner/test262/test/ironhorse/`, with module fixtures in
`ironhorse-262/corpora-modules/` and coverage policy in `ironhorse-262/expectations/`.
Reports and expectation checks expose covered cases and named gaps; historical
covered counts are not current measurements.

**Completion-phase convergence (maintainer directive, 2026-07-02,
PR #600).** Toward the completion of the port, the bespoke stage
corpora convert into test262-style cases and this dual-run harness
into a proper analogue of `xst` (XS's test262 runner). The sibling
design
[ironhorse-test262-convergence](ironhorse-test262-convergence.md)
specs both halves — the case shape and `features:`-marker gating,
the meter assertions kept out of test bodies, and the `endot-ih`
runner that subsumes this harness with the differential oracle as
its Ironhorse extension. The `endot-ih` runner and fixture conversion have landed; this does not
by itself meet the complete SES or full-conformance acceptance bars.

**Corpus source: the monorepo's `packages/test262-runner`, not a
separate pinned submodule** (maintainer directive, 2026-07-03,
PR #600 review). The repo already carries a curated, pinned
test262 subset under `packages/test262-runner/test262/` (the tc39
`test` and `harness` trees plus additional Moddable and Hardened
JavaScript tests) and a `test262-harness`-driven runner that today
proves XS↔Node HardenedJS parity by running the tests marked with
the `ses-xs-parity` feature on both the `xst` (XS) and `node`
hosts against a SES prelude. ironhorse-262 drives its Ironhorse↔XS
**pass-vector (result) parity** off that **same** tree and the
**same** `ses-xs-parity` feature markers (recording computrons as
advisory telemetry, § Metering) rather than pinning a
second, independent test262 submodule. The two parity axes then
share one corpus and one feature convention: `test262-runner`
compares XS against Node at the SES surface, and ironhorse-262 adds
Ironhorse against XS at the bytecode-and-meter surface, so a single
maintained test262 subset serves both. This also inherits the
runner's stated rationale for a checked-in copy over a live
submodule (stability plus autobuild speed, the same technique V8,
JSC, and SpiderMonkey use — see `packages/test262-runner/README.md`).
Reusing the existing tree supersedes the earlier "pinned submodule
like `c/moddable`" plan. As Ironhorse's SES/Compartment surface lands
(stage 4), the `ses-xs-parity`-tagged tests become directly
runnable on Ironhorse through the runner's host abstraction (a third
host alongside `xst` and `node`); until then ironhorse-262's curated
historical corpus lists were the stage-scoped bootstrap that converged onto
that shared tree.

### Fuzzability (requirement 7)

cargo-fuzz (libFuzzer) targets, in the `ironhorse-fuzz` crate:

1. **Differential source fuzzing** (the flagship): a structure-
   aware JavaScript generator (grammar-based, `arbitrary`-driven,
   with corpus splicing in the Fuzzilli style) feeds identical
   source to Ironhorse and the oracle; the comparator checks
   completion kind, result string, and error identity. A **result**
   divergence is a crash-equivalent finding. Computron and heap
   counts are collected as advisory signals, not equality
   assertions (per § Metering): a large or structured computron/heap
   divergence is triaged as a likely allocation-faithfulness or
   calibration issue — and escalated to a finding only when it
   points at a *result*-affecting bug — rather than failing the run
   for a mere weight difference against XS.
2. **Bytecode decoder fuzzing**: malformed and truncated bytecode
   against the loader's validity envelope (XS treats bytecode as
   trusted; Ironhorse's loader still must not panic on corrupt input
   from a bad snapshot or a buggy compiler).
3. **Snapshot round-trip and decoder fuzzing**: write/read
   round-trip invariance, plus malformed-atom inputs against the
   reader.
4. **String boundary-transcoding fuzzing**: UTF-8 ⇄ UTF-16
   conversion at the `Machine` API and source boundary, including
   unpaired-surrogate handling. (Retargeted 2026-07-06 from CESU-8
   codec round-trip fuzzing when the heap encoding moved to UTF-16;
   `cesu8.rs` fuzzing remains with the xsnap crate, whose XS
   boundary the codec still serves.)
5. **RegExp differential fuzzing** against the oracle's `xsre`
   once the RegExp port lands.

Fuzzing starts in stage 1 (targets 1 and 2 exist as soon as the
interpreter subset does) and runs nightly in CI with a checked-in
corpus and a trophies ledger.

### Endor integration (requirement 8)

**Current status:** direct embedding exists in `rust/endo/src/ironhorse_engine.rs`;
the common engine trait is deferred under W6 decision 2, and the complete worker
deliver protocol and host-function/SES boot surface remain open.
The implemented entry points are Endo's `ironhorse_engine::Machine` and
`PersistentMachine`, backed by the VM and snapshot crates.
The VM's `Machine` owns shared Realm execution state; it is not the xsnap supervisor
wrapper of the same name.
No shared trait makes the XS and Ironhorse supervisor APIs interchangeable.
Engine selection supports direct Ironhorse execution, while full worker delivery,
host powers, debugger transport and archive execution retain separate acceptance work.

Reconciliation with the design cluster, per document:

| Design | Reconciliation |
|---|---|
| [daemon-endor-architecture](daemon-endor-architecture.md) | Ironhorse is embedded directly through its own wrappers. Thread pinning remains; the full worker protocol and common engine abstraction are not wired. |
| [daemon-rust-xs-performance](daemon-rust-xs-performance.md) | Engine benchmarks exist, but the complete XS supervisor pump has not been replaced by an interchangeable Ironhorse implementation. |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Ironhorse owns `Meter`, `MeterBounds` and per-crank reports. Dynamic compilation and dispatch share the live budget; these are separate Rust entry points, not the XS metering API. |
| [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md) | `MachineSnapshot` and `HeapStore` implement buffered container encoding, CAS/store operations and validated standalone restore. They are not XS callback streaming or shared-Realm snapshots. |
| [daemon-xs-worker-debugger](daemon-xs-worker-debugger.md) | Centralized VM raises are available; the transport and complete xsbug/supervisor integration remain later work. |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) and host powers | Arbitrary host-function registration is still missing. Snapshot signatures identify compatibility but do not create a host table or power-registration surface. |
| [endor-run-expanded](endor-run-expanded.md) | Direct source execution exists. Archive/CAS worker execution must be verified through its Ironhorse path; it does not follow automatically from a shared `Machine` API. |

### Performance and footprint envelope

Interpreter-only Rust versus interpreter-only C is a fair fight;
the envelope is set where the port remains an unambiguous win on
its actual goals:

- **Throughput**: geometric mean within 2.0x of XS on the
  four-variant daemon benchmark plus a microbenchmark corpus
  (parse, property access, calls, GC churn, string ops) at stage
  8. Computed-goto C versus `match`-jump-table Rust typically
  lands well inside this.
- **Footprint**: heap within 1.1x (the slot accounting is
  identical by construction; overhead can come only from arena
  bookkeeping); engine code size within 2x of `libxs.a`.
- **Latency**: no regression on the pump-loop properties the
  performance design fought for (no sleeps, no polling).

Performance is subordinate to safety and determinism: the envelope
is a gate against unacceptable regression, not an optimization
target, and no optimization that perturbs metering observability
is admissible.

## Staged Roadmap

Each stage lands as commits on this PR's branch, is independently
green, and names its acceptance bar. Stage 1 is the thin slice the
program brief demands: it proves the metering-determinism bar and
the Compartment seam, and bootstraps test262, before any breadth.

| Stage | Deliverable | Acceptance bar |
|---|---|---|
| 1. Thin slice: interpreter core + meter + oracle harness | `ironhorse-vm` arenas and value model; interpreter for the arithmetic/logic/branch/call/stack opcode subset; meter with the release-versioned cost table and XS check points; `xs-oracle` compiling source with XS and executing bytecode on both engines; a primordial `Compartment.evaluate` (fresh globals, shared intrinsics seam, no modules); `ironhorse-262` dual-run skeleton with the stage corpus; fuzz targets 1 and 2 | **Result** agreement with the oracle on the stage corpus; meter deterministic per release (identical computrons across repeated runs of the same build); computron-vs-XS recorded as advisory telemetry only; `forbid(unsafe_code)` holds outside `xs-oracle` |
| 2. Object model and control flow | Objects, prototypes, property ops, closures, exceptions (jump-chain with JS/host flags), full 245-opcode coverage (built-ins stubbed); GC v1 (mark-sweep + chunk compaction) | test262 `language/` dual-run agreement on the covered grammar; ordinary GC test suite (`forbid(unsafe_code)`), no Miri gate |
| 3. Built-ins | Object/Array/String (built CESU-8; re-based to UTF-16 by the 2026-07-06 revision — § Value and heap model)/Math (canonical NaN)/JSON/Map/Set/TypedArray/BigInt; promises and job queue with the pump-loop latch semantics; RegExp port decision executed (resolved question 6: port `xsre`) | Built-ins sections dual-run **result** agreement; meter deterministic per release (computron-vs-XS advisory); the `mxMeterSome` fast-path annotations, where kept, preserve the meter's internal fast/slow-path consistency within an Ironhorse release rather than matching XS |
| 4. Hardened JavaScript | `lockdown`, `harden`, `petrify`, `mutabilities`; full native `Compartment` + module machinery (ModuleSource, module maps); async/generators complete | The endor daemon boot bundles (`polyfills.js`, `ses_boot.js`, HandledPromise) run identically on both engines; SES conformance suites pass |
| 5. Compiler port | `ironhorse-compile`: lexer, parser, scoper, coder replacing the oracle compiler; parse metering | Byte-identical bytecode versus the oracle compiler on the full conformance corpus; parse metering deterministic per release (parse computrons stable across runs; computron-vs-XS advisory); parser fuzz target armed |
| 6. Snapshots | `ironhorse-snapshot` atom writer/reader; `Machine` snapshot surface; suspend/resume through the supervisor; meter state across suspend | Round-trip invariance under fuzzing; supervisor suspend/resume integration test passes on `-e ironhorse` |
| 7. Debugger | xsbug protocol; `DebugTransport` over the envelope bus; instruments; break-on-uncaught | The existing 11 Rust debug-protocol tests and 16 CapTP debugger tests pass unmodified against Ironhorse; xsbug connects |
| 8. Parity closure and hardening | test262 result-parity per the requirement 6 bar; nightly differential fuzzing at full breadth; performance pass to the envelope; fourth benchmark variant wired; engine selection documented | Pass-vector (result) equality with the oracle; meter determinism verified for repeated same-binary/platform runs, with cross-platform vectors measuring their covered cases; computron-vs-XS characterized as calibration telemetry, not gated; envelope met |
| 9. Ecosystem validation (fork-scoped) | Differential replay of real workload corpora: endo daemon integration suites, and agoric contract corpora on the `kriscendobot/agoric-sdk` fork tooling only (no upstream interaction) | Zero **result** divergence on the corpora (computron divergence recorded as calibration telemetry, not a failure); divergences triaged to the exceptions ledger or fixed |

Stages 1 through 4 keep the oracle compiler in the loop, which is
deliberate: interpreter behavior and compiler behavior are separated
so a *result* divergence (or a flagged advisory computron/allocation
drift) always has exactly one suspect.

**Doctrine-transition note (2026-07-04).** The acceptance bars above
are restated to **result agreement + a deterministic-per-release
meter**, per the accuracy-over-parity doctrine (§ Metering),
superseding the earlier "(result, computron) parity against XS"
framing. The landed-stage records below (stage 2a, stage 2b, and the
in-flight stage 3) were built and accepted under the *superseded*
parity doctrine, and did in fact achieve bit-exact computron
agreement with XS on their covered grammars. That evidence is
**retained** — as a strong *result*-correctness and
allocation-faithfulness signal and as free calibration data — but it
is no longer the bar: those stages already satisfy, a fortiori, the
weaker result-agreement bar, and future stages are held only to
result agreement plus meter determinism. No landed work is
invalidated by the doctrine change; the historical amendment prose
below is preserved as written, with its "bit-exact computron parity"
language read as the (now advisory) evidence it produced, not as a
standing requirement.

**Stage-2 amendment (supervisor, 2026-07-02).** Stage 2 executes as two
sub-stages on this PR, because the stage-2 build established — and the
supervisor verified against the pin's `xsMemory.c` — that bit-exact
computron parity on *any* program that allocates at run time requires
the allocation-faithful object heap first: XS meters every `fxNewSlot`
(`XS_SLOT_ALLOCATION_METERING`, 1<<8), every chunk byte
(`XS_CHUNK_ALLOCATION_METERING`, 1), and built-in steps (1<<14) on the
property paths, so the count depends on the engine's exact allocation
sequence, not just its dispatch sequence. **Stage 2a (landed):** program
frame + scope/variable/loop interpreter over compiler-emitted bytecode,
GC v1 (mark-sweep + chunk slide-compaction, ordinary unit-tested), real
`Compartment.evaluate` global binding, and the instruction-length
walker; its new grammar is verified for **result agreement only** and
deliberately kept out of the bit-exact corpus rather than faked.
**Stage 2b (next):** the object model — instances, prototypes, property
behaviors, closures via heap cells, exceptions' jump-chain, call/return
frame switching, full 245-opcode coverage (built-ins stubbed) — with
allocation-faithful metering; the original stage-2 acceptance bar
(bit-exact test262 `language/` dual-run agreement on the covered
grammar) is 2b's bar, and the 2a grammar graduates into the bit-exact
corpus as the heap makes its computrons faithful. Meter-check placement
moves with the frame machinery: per the pin's `xsRun.c`, checks belong
at the `mxFirstCode` sites (call entry, return-into-a-JS-caller, catch
resume) and at backward branches; XS runs **no** check when
END/RETURN exits to the C caller, and `fxBeginMetering` scales the
host's interval `<<16` and resets `meterIndex` — both to be matched
exactly (stage-2a review findings 1 and 2).

**Stage-2b complete (2026-07-03).** The three-part 2b orchestration landed:
child 1 the allocation-faithful object heap, child 2 call/return frame
switching and closures via heap cells, child 3 exceptions (the XS
jump-buffer chain with the JS/host flag reduced to a structural predicate:
`catch`/`uncatch`/`exception`/`throw`/`rethrow`, uncaught propagation to the
host boundary with its measured host-escape metering), full 245-opcode
decode+dispatch coverage (built-ins stubbed — each opcode executes with
faithful stack/frame/meter effects where its semantics need no built-in, or
halts `Unsupported` self-naming where they do), and the tightened
`DualRun::is_bit_exact` (a shared abort compares thrown value AND computrons,
like the completion arm). The stage-2 acceptance bar is met as the real
test262 `language/` dual-run runner (`ironhorse_262::test262`): every test it
runs end-to-end agrees bit-exactly (result/thrown-value AND computron) with
the XS oracle — **zero divergence** — with the covered/skipped split
stated honestly (each skip named by the unsupported opcode or built-in gap,
never folded into a pass rate). The covered grammar is what stage 2b models;
the built-ins the bulk of `language/` needs arrive in later stages, growing
the covered count against the same zero-divergence bar. The differential
fuzz grammar now spans objects, calls, closures, and thrown-and-caught
exceptions, all bit-exact.

**Stage-3 decomposition (supervisor, 2026-07-03).** The stage-2b review
(s5, all acceptance evidence independently reproduced; all three s4
findings verified closed) accepted stage 2 and confirmed stage 3 is
monolith-sized — larger than the stage-2 monolith that twice overran the
2400s handler wall-clock — so it executes as a **seven-child serial
orchestration** (`xs2rust-endor-build-stage3`), each child independently
green on this PR against the design's stage-3 bar (built-ins sections
dual-run **result** agreement with a deterministic-per-release meter,
per the accuracy-over-parity doctrine; computron-vs-XS is advisory
telemetry, not gated — the doctrine-transition note above governs;
the `mxMeterSome` fast-path annotations land here, kept for the
meter's internal fast/slow-path consistency within a release):
1. **language** — chunk-backed string *values*: literals, concat
   with `XS_STRING_METERING`, comparison (built as CESU-8, the
   encoding answer of the day; re-based to UTF-16 code units by the
   2026-07-06 revision, § Value and heap model); the `global` opcode, and the
   remaining language opcodes the `language/` sweeps name as top skip
   reasons (`typeof`, `increment`/`decrement`/`to_numeric`,
   exponentiation, `this`, `let`/`const` closures, `current`/
   `refresh_local`, `delete_property`, `copy_object`/`extend`,
   `branch_coalesce`/`branch_chain`, `arguments` sloppy/strict). Also
   carries the review's parity observations: model XS's **fixed stack
   limits** (`fxOverflow`/`mxStackCount`, including the value-stack
   width-not-depth geometry) so stack-exhaustion aborts are bit-exact —
   deterministic stack overflow is consensus-relevant in the xsnap
   lineage — and decompose the measured `FUNCTION_*` definition
   constants analytically to retire the ≤~288-raw per-definition
   residuals.
2. **fundamentals** — constructor calls (`to_instance`/`new`/`target`/
   `instantiate`), Object, Function.prototype (`call`/`apply`/`bind`/
   `toString`), Boolean, Symbol, and the real Error hierarchy (which
   graduates abort-value parity from primitive throws to Error objects);
   `instanceof`/`in` completion.
3. **arrays** — the Array exotic object (length semantics), literals/
   spread/holes, the iteration protocol (`for-of`/`for-in`, array and
   string iterators; generators stay stage 4), Array.prototype methods.
4. **text-math-json** — String.prototype (code-unit semantics; the
   backing store is UTF-16 per the 2026-07-06 revision), Number,
   Math (canonical NaN), `parseInt`/`parseFloat`, JSON.
5. **collections** — Map/Set/WeakMap/WeakSet, ArrayBuffer/TypedArray/
   DataView, BigInt (`XS_BIGINT_METERING`).
6. **promises** — Promise and the job queue with the pump-loop latch
   semantics (daemon-rust-xs-performance is ground truth).
7. **xsre** — the RegExp engine port (resolved question 6; the 11.6
   KLOC cost the verdict priced in), RegExp built-in + literals, and a
   structure-aware regex fuzz target.

**GC roots and scheduling contract (updated by Phase 1G/2B).**
Whole-machine collection must trace the interpreter's complete retained graph, including
side tables and suspended continuations; arena-index reuse must never rely only on the
value stack and scope.
The supported boundary is quiescence, as specified in
[collection only at quiescence](ironhorse-quiescent-gc.md).
A halted crank must be rewound or discarded before collection; allocation does not trigger
emergency collection inside guest execution.

[W6 decision 5](ironhorse-w6-decisions.md#5-gc-schedule--decided-engine-consumer-policy)
supersedes the former requirement for release-fixed allocation-pressure thresholds.
The consumer chooses explicit, delivery, pressure, idle, or timed requests.
Consumers requiring replica-identical heaps must coordinate collection events and recovery
across resume; equal guest input and release alone do not establish equal heap bytes under
different schedules.
Existing meter accounting and authenticated store cadence remain required.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-endor-architecture](daemon-endor-architecture.md) | Parent: defines the embedding, worker platforms, and `Machine` seam this engine slots into |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Preserved surface: crank metering model and API |
| [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md) | Preserved surface: snapshot lifecycle and CAS integration |
| [daemon-xs-worker-debugger](daemon-xs-worker-debugger.md) | Preserved surface: xsbug pass-through and debugger capability |
| [daemon-rust-xs-performance](daemon-rust-xs-performance.md) | Benchmark harness and pump-loop semantics; the performance envelope's instrument |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | Host-power registration pattern the engine must keep serving |
| [endor-run-expanded](endor-run-expanded.md) | Downstream consumer through the `Machine` API |

## Design Decisions

1. **Oracle-checked transliteration over engine adoption.** Same
   ISA, meter *points* (as the instrumentation seam), heap
   semantics, and protocols as XS; safety re-architecture in the
   implementation; XS as a permanent differential oracle in CI
   **for result correctness**. This realizes requirement 1's
   "stated determinism-equivalence proof" branch: Ironhorse's meter is
   internally deterministic per release, and the oracle certifies
   result semantics rather than computron parity.
2. **Index arenas over pointer graphs.** `SlotIndex`/`ChunkOffset`
   arenas give a safe GC, a nearly structural snapshot format, and
   `forbid(unsafe_code)` engine crates, at the cost of an index
   indirection the performance envelope absorbs.
3. **Zero `unsafe` in shipped engine crates, enforced not
   promised.** The budget is a `forbid` attribute plus a
   design-amendment process, not a count to creep.
4. **Compiler ported last, behind a byte-identity bar.** Bytecode
   identity separates interpreter behavior from compiler behavior
   and keeps the result-correctness crux isolated while it is being
   proven.
5. **Meter is a release-versioned accuracy model, not XS-parity
   (accuracy over parity, 2026-07-04).** The meter's purpose is to
   be the best available deterministic proxy for real wall-clock
   cost. Determinism is scoped per release binary per platform.
   The frozen table is currently an XS-derived estimate; future calibration
   changes ship as an `ironhorse-meter-N` bump.
   XS-computron parity is a non-goal; the
   `c/moddable` oracle checks *results*, with computrons kept as
   advisory telemetry (§ Metering).
6. **Rust-native snapshots first; XS import as optional bounded
   work.** No live-heap migration need exists in endo or agoric
   practice; the atom grammar is shared so the importer stays
   tractable if a need appears.
7. **Debugger protocol byte-compatibility over protocol
   modernization.** Every existing client (xsbug, xsbug-node, the
   DebugSession stack) keeps working; the six-layer pass-through
   design is preserved wholesale.
8. **Both engines selectable through the whole campaign.** The
   `-e` engine flag and the four-variant benchmark keep XS and
   Ironhorse running side by side until result parity is demonstrated,
   and after, for as long as the differential oracle earns its keep.
9. **Agoric consensus by coordinated ironhorse-native upgrade, option
   (b).** Ironhorse's own release-versioned meter is the consensus meter
   (subject to the release-binary/platform scope and matching state, input and
   host policy); Agoric
   adopts it at a coordinated upgrade boundary, exactly as every
   `xs-meter-N` bump has shipped. No XS-computron-compatible mode is
   a build-phase goal; one can be added later only as a conditional,
   versioned compatibility meter gated on a real consumer needing
   mid-flight continuity (§ Agoric consensus compatibility).

## Resolved Questions

The ten questions below were posed to the supervising agent of
program `port-xs-to-rust-memory-safe-engine` per the program
contract, and were resolved by that supervisor on 2026-07-02.
Each entry states the decision and its grounds; the decisions are
binding on the build stages, and reopening one is a design
amendment, not a code-review discussion.

**Amended 2026-07-04 by the accuracy-over-parity doctrine
(§ Metering, § Agoric consensus compatibility).** That maintainer
directive is itself the design amendment; it revises the metering
framing of questions 1, 2, 4, and 6 below (the oracle is
result-only; the meter is release-versioned, not XS-locked). The
annotations inline mark exactly what changed.

1. **Result oracle: the in-tree `c/moddable` submodule pin**
   (upstream XS semantics), not the agoric-labs fork (XS 13.3,
   integer meter, `xs-meter-37`). Grounds: the oracle must be the
   engine Ironhorse actually replaces, and the endor daemon compiles
   the in-tree pin today. *(Amended 2026-07-04: the oracle checks
   **result** correctness, not computron parity — accuracy over
   parity, § Metering. Ironhorse's meter is its own release-versioned
   model, so no oracle pin is a "parity" target; computron
   comparison against this pin is advisory telemetry only. The
   16.16-fixed-point detail of the pin's meter is no longer
   inherited: Ironhorse uses an integer cost-table accumulator of its
   own.)* Agoric-fleet meter compatibility, if ever needed, is a
   separate later target with its own oracle pin and program
   (§ Agoric consensus compatibility, option (a)).
2. **Consensus entry is by coordinated upgrade (`ironhorse-meter-1`),
   not mixed-fleet operation.** Ironhorse is not required to run
   alongside XS validators under the same `xs-meter-N`. Grounds:
   every XS meter change has ever shipped as a coordinated
   `xs-meter-N` bump at a chain upgrade; mixed-fleet bit-exactness
   would force decision 1 onto the divergent fork oracle and make
   the strictly harder target load-bearing for no operational
   gain. Internal determinism remains required within the release-binary
   and platform scope, with matching initial state, input and host policy. *(Reinforced 2026-07-04: this question is now
   load-bearing for the accuracy-over-parity doctrine — it is the
   mechanism (option (b)) by which "accuracy over XS-parity" stays
   consensus-safe. The former "published equivalence corpus against
   the pinned oracle" is demoted from an obligation to advisory
   calibration telemetry; the consensus guarantee is same-release
   determinism, not cross-engine equivalence. See § Agoric consensus
   compatibility.)*
3. **The XS snapshot importer is out of scope for the build
   phase.** No Ironhorse or agoric use case migrates a live XS
   heap (workers restart from durable persistence; chains replay
   transcripts). The shared atom grammar documented in § Snapshots
   keeps a future importer bounded; building one now would spend
   a stage on a decoder with no consumer. Revisit only against an
   actual migration need, as its own design amendment.
4. **Internal string encoding is UTF-16 code units.** *(Resolved
   2026-07-06 by the `xs2rust-endor-strings-utf16` revisit,
   superseding the original CESU-8 answer.)* The original grounds
   for CESU-8 leaned on parity — "UTF-8 boundary conversion would
   perturb chunk sizes and therefore heap accounting" — which the
   accuracy-over-parity doctrine (2026-07-04 amendment) no longer
   treats as a constraint. Reopened as an **accuracy/simplicity**
   question, the answer is UTF-16: storing the spec's own code-unit
   sequence makes code-unit indexing intrinsically O(1) and deletes
   the constant-time-index machinery outright (§ Value and heap
   model), and string metering is re-based to code-unit length
   derived from calibration measurement (§ Metering). Ironhorse snapshot
   content diverges from the oracle's CESU-8 chunk bytes; the
   snapshot fixtures and the differential harness's
   allocation-telemetry expectations are updated deliberately with
   the change, and the (out-of-scope, resolved question 3) future
   XS snapshot importer would transcode at import. The xsnap
   crate's `cesu8.rs` codec remains where it serves the XS
   boundary; it is no longer Ironhorse's heap encoding.
5. **Slot memory layout is distinct from serialization.**
   The Rust record is 24 bytes on the audited 64-bit build and has no stable
   representation guarantee; the codec writes its wire fields explicitly.
   XS's 32-byte accounting is not a resident-memory measurement.
   The stage-8 footprint envelope therefore needs a separate instrument.
6. **RegExp: port `xsre`.** RegExp execution is metered and
   guest-reachable, and an off-the-shelf engine such as `regress`
   has different internals, hence subtle **semantic** drift and a
   different, un-modeled cost profile. *(Amended 2026-07-04: the
   original grounds cited the "computron-parity bar"; under accuracy
   over parity the decisive reasons are instead (i) **result**
   semantics — `xsre`'s match behavior is what the differential
   oracle checks against XS — and (ii) that a ported `xsre` gives
   Ironhorse's own cost model a RegExp cost surface it can calibrate,
   whereas a foreign engine's internals would be an un-modeled,
   hard-to-calibrate cost. Parity of RegExp computrons with XS is
   not required.)* The 11.6 KLOC cost lands in stage 3 per the
   roadmap, with the differential fuzz target (item 5 of
   § Fuzzability) as its result-level enforcement.
7. **Naming as proposed: workspace at `rust/engine/`, crates
   `endor-vm`, `endor-oracle`, `endor-262`, `endor-fuzz` (later
   `endor-compile`, `endor-ses`, `endor-snapshot`, `endor-debug`),
   engine flag value `endor-rs`.** No collision with the existing
   `endo` and `xsnap` crates, and `-e xs` / `-e endor-rs`
   distinguishes the engines through the parity campaign.
   *Amended 2026-07-17 by maintainer directive
   ([issuecomment-4997629312](https://github.com/endojs/endo-but-for-bots/pull/600#issuecomment-4997629312))
   — the naming north-star for the whole port:* the `-rs` suffix
   reads as "the **R**ust port of X**S**", so the two
   engine-selecting variants are named symmetrically —
   **`endor-xs`** (endor backed by the C-XS engine, the `-e xs`
   flag) and **`endor-rs`** (endor backed by the Rust port, the
   `-e endor-rs` flag). The port converges on **`endor`** with no
   suffix as the name of the fully-Rust Endo — the Rust port of
   both the Endo tool and the novel JavaScript engine — once that
   port is the default and the C-XS variant is no longer built by
   default. The combined build that links both engines,
   **`endocr`** (Endo with C and Rust), is retained only for
   parity testing: the differential oracle harness (`endor-oracle`,
   dev- and CI-only) is its home and the sole surviving place C is
   compiled in. This refines — it does not reopen — the
   crate-naming and flag-value decisions above; the flag values
   stay `-e xs` / `-e endor-rs`, and `endor-xs` / `endor-rs` /
   `endocr` name the resulting build variants. **Open — routed to
   the maintainer, not resolved here:** the user-facing CLI binary
   was renamed `endor` → `endot`
   ([issuecomment-4900059356](https://github.com/endojs/endo-but-for-bots/pull/600#issuecomment-4900059356)),
   which this north-star reads against — if `endor` is to name the
   Rust Endo tool, the `endot` binary rename likely wants reverting
   or re-scoping. That decision is the maintainer's; this note only
   records the tension.
   *Amended 2026-07-29 by maintainer directive (the
   `pr-ebfb-600-ironhorse-rename` job on this branch) — the naming
   settles on the engine/binding boundary, superseding the
   2026-07-17 north-star's variant names:* the Rust engine is
   **Ironhorse**; **Endor** is the binding of an engine to a
   platform (the unified `endor` daemon binary, the `rust/endo`
   tool layer, the `Machine` seam this engine slots behind); the
   existing engine is simply **XS** — never "C-XS" in
   current-facing prose. Ironhorse owns language execution; Endor
   owns platform binding and integration. The engine-selecting
   variants are named by engine — `-e xs` and `-e ironhorse` — and
   `endor-xs` / `endor-rs` / `endocr` are retired as variant names
   (the combined C-and-Rust build is now just "the `xs-oracle`
   harness", still the sole place C is compiled in). The full
   before→after map: crates `endor-vm` → `ironhorse-vm`,
   `endor-compile` → `ironhorse-compile`, `endor-snapshot` →
   `ironhorse-snapshot`, `endor-regexp` → `ironhorse-regexp`,
   `endor-262` → `ironhorse-262`, `endor-fuzz` → `ironhorse-fuzz`,
   `endor-oracle` → `xs-oracle` (the oracle binds the XS engine, so
   it names what it binds); the test262 runner `endor-xst` →
   `endot-ih`; the cargo feature `endor-engine` →
   `ironhorse-engine`; the daemon seam module `endor_engine` →
   `ironhorse_engine`; the snapshot image magic
   `ENDOR_MAGIC`/`b"ENDR"` → `IRONHORSE_MAGIC`/`b"IRON"`; the
   differential labels `ENDOR-REJECTED` / `ENDOR-ONLY-ACCEPT` →
   `IRONHORSE-REJECTED` / `IRONHORSE-ONLY-ACCEPT`; the corpus
   feature labels `endor-dual-run`, `endor-meter-exact`,
   `endor-meter-determinism` → `ironhorse-dual-run`,
   `ironhorse-meter-exact`, `ironhorse-meter-determinism`; the host
   script `yarn test262:endor` → `yarn test262:ironhorse`; this
   document family `xs2rust-endor-*.md` → `ironhorse-*.md`. The
   `endor` daemon binary, the tool-facing design docs
   (`daemon-endor-architecture`, `endor-run-expanded`,
   `endor-npm-registry-proxy`, …), and `ENDOR_REGISTRY_LIVE_TEST`
   keep their names — they name the binding, not the engine.
   Retained transitional identifiers, deliberately not rewritten:
   the branch `xs2rust-endor`; historical job basenames
   (`xs2rust-endor-strings-utf16`, `xs2rust-endor-build-stage3`,
   `port-endor-oracle-bump-8-3-1`,
   `xs2rust-endor-meter-calibration-stage-c1`…`-c4`); the program
   name `port-xs-to-rust-memory-safe-engine`; commit messages; the
   quoted 2026-07-17 directive above; and the verification-ledger
   blockquotes in `rust/engine/CHANGELOG.md`, whose crate names and
   `ENDOR-*` labels record what the tools were called at those
   measured tips.
   The current acceptance record is the [Status section](#status), not those
   historical blockquotes.
8. **Machines stay `!Send`.** Preserving thread-pinned parity
   with today's runner model keeps the port's behavior envelope
   identical; cross-thread machine migration is a separate
   scheduler design with its own determinism questions and earns
   nothing during the parity campaign.
9. **Stage 1 builds in-repo at `rust/engine/` from the first
   commit.** The program binds design and implementation to this
   branch and PR, and the oracle harness consumes the existing
   xsnap crate as a path dependency; an incubation directory would
   only defer the integration it exists to prove.
   *Amended by supervisor ruling, 2026-07-02 (stage-1 review):*
   the oracle links the XS sources directly — reusing xsnap's
   audited platform layer (`xsnap-platform.{c,h}`) and identical
   feature defines — rather than through a Cargo path dependency
   on `xsnap`, because xsnap's `lib.rs` embeds gitignored generated
   SES bundles absent from a fresh checkout and its `ffi.rs`
   declares the pre-drift argument-free `fxInitializeSharedCluster`.
   *Amended 2026-09-09:* the superproject gitlink has since been bumped to
   `23b4d6b0a65f35209d9118c4c13c6c9b3e68784d` (Moddable 8.3.1), matching
   the oracle build pin.
   Populate it with `git submodule update --init --depth 1 c/moddable` from
   the repository root; see the engine README for a full-fetch fallback.
10. **Intl and Temporal are retained in the consensus engine (amended 2026-09-10).**
    This supersedes the original omission decision for both globals.
    They already supply deterministic language behavior, retained instance records,
    and snapshot state; removing them would retract shipped guest capabilities.
    Intl uses in-tree locale tables and pinned ICU normalization/segmentation data,
    with no host locale or dynamic database lookup.
    Temporal uses engine-owned calendar/zone rules; `Temporal.Now` returns the Unix
    epoch and its system zone is UTC, with no host clock or zone database.
    This choice accepts maintenance of those tables, algorithms and persisted records.
    It does not claim full ECMA-402 or Temporal conformance.

    The pinned XS oracle omits both globals.
    Only its exact missing-global failures qualify for the corresponding harness
    carveouts; unrelated exceptions must remain failures.
    Oracle-free semantic, carry/resume and fixed-clock tests provide positive evidence;
    an oracle skip is never counted as differential agreement.

    Supported releases use checked lockfiles and bundled ICU data.
    `scripts/intl-profile.py` generates the guest-visible data identity from the
    resolved ICU closure (versions, checksums, edges and requested root features).
    CI checks both workspaces and rejects stale generation.
    Today's dependency graph keeps a fixed legacy alias; that alias must never be
    reassigned to an upgraded graph.
    The identity enters the boot fingerprint, making incompatible snapshot resume fail.
    In-tree locale/calendar/zone changes still need an explicit profile release;
    custom ICU data or downstream feature overrides are outside this supported profile.
    Review provider/data upgrades against semantic tests, state/receipt goldens and
    compatibility fixtures; do not silently regenerate pins to accept drift.
    Meter weights need a new release when charging semantics change, while a provider
    identity changes independently even when the weight table does not.
    See [the implementation record](../rust/engine/DETERMINISM-METERING.md).

## Prompt

> Port XS (Moddable's interpreted JS engine, as consumed by Endo's
> xs-worker / agoric-sdk xsnap) to Rust, as a crate endor embeds,
> to raise confidence in memory safety while preserving what makes
> XS uniquely suited to Endo/agoric. The design must carry ALL of
> these hard requirements: (1) preserve metering, debugger,
> snapshot-persistence; metering reproduced EXACTLY versus XS (a
> consensus requirement) or a stated determinism-equivalence
> proof; decide the snapshot FORMAT question. (2) Minimize
> `unsafe`: an unsafe budget plus per-use justification, isolated
> behind audited modules. (3) Increase memory-safety confidence:
> the headline metric, weighed against perf. (4) No JIT, ever.
> (5) HardenedJS / Compartment first-class. (6) High test262
> coverage to parity with XS; test262 parity is the acceptance
> bar for the build phase. (7) Fuzzability: cargo-fuzz/libFuzzer,
> structure-aware parser+interpreter fuzzing, differential fuzzing
> versus XS. (8) Better endor integration: embed as a Rust crate
> instead of the C xsnap subprocess; reconcile with the
> daemon-endor-architecture, daemon-rust-xs-performance,
> daemon-endo-rust-sqlite, and daemon-xs-worker-* design cluster.
> Investigation to weigh: build approaches (from-scratch versus
> extend a Rust engine like Boa versus hybrid), the
> determinism/metering bar (the crux), snapshot compatibility and
> debugger protocol, and the footprint/perf envelope. Deliverable
> is a feasibility verdict + architecture design + a STAGED
> roadmap (a thin first slice proving the metering-determinism +
> Compartment bar and bootstrapping test262 coverage, then
> iterate).
