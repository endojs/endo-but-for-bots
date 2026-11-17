# Lens: sanity and correctness

Reviewed commit `61cd656cb`.

The question: does IronHorse compute what ECMA-262, ECMA-402 and Temporal specify, and what its
own contracts promise (compartment isolation, replica determinism, heap ceilings and the meter,
validation of persisted state), without host panics, nondeterminism, or resource bounds that a
guest can step around?

Mostly yes on the core language: the oracle-independent test262 verdict is 93.5% on core
ECMA-262 (see [`test262-conformance.md`](test262-conformance.md)), and every reviewer who looked
for order-sensitive hash iteration, float or address dependence found none.
The exceptions fall into the seven sections below: one sandbox escape on the deployed SES-shim
path, one live-versus-resumed divergence, a handful of host panics, ceilings and a meter that
bound much less than they appear to, limits surfaced as uncatchable halts, a tail of wrong
results concentrated in async iteration, the property-key namespace, accessor emulation and the
Intl/Temporal profile, and persisted state that is trusted more than it is checked.

## Method

Thirteen region reviewers each mapped one region (compile, regexp, VM dispatch, functions and
async, property model, memory/GC/meter, native objects, native values, boot/realm/modules,
snapshot image codec, snapshot store, test262 harness, integration/fuzz/oracle).
They probed guest-visible behavior with JS probes on the release
`rust/engine/target/release/ironhorse-xst`, compared against Node 22 as the spec reference, and
probed internals (sizes, computron counts, host allocation, crafted snapshots) with temporary
Rust integration tests built in a separate target directory and deleted afterwards.

Every candidate went through two verification passes.
Pass 1 re-opened each finding at the commit, re-ran or extended its probes, and recorded a
verdict, corrected location, summary and numbers, and a final severity; it also found one new
defect (NOBJ-NEW-1).
Pass 2 was an adversarial refuter for every finding still critical or high after pass 1
(44 findings): it refuted none, upheld 30, and lowered 14 (13 high to medium, 1 critical to
high).
Final severity is pass 1's, lowered to pass 2's where pass 2 is lower.

| Outcome | Count |
|---|---:|
| Findings verified (173 from maps, 1 found in verification) | 174 |
| Confirmed / confirmed with corrections / downgraded / refuted | 92 / 67 / 15 / 0 |
| Final severity, all lenses: critical / high / medium / low | 1 / 30 / 79 / 64 |
| Carrying this lens: critical / high / medium / low | 1 / 30 / 52 / 26 |
| Full entries below after merges (critical / high / medium) | 1 / 27 / 47 |

Where a map and its verification disagree, this lens uses the verification.
Cross-map merges follow the orchestrator's decisions: a merged defect is written once under its
primary ID and the others are listed as "same defect".
PROP-4 is written under BOOT-4, the same mechanism reported independently; NOBJ-15 (merged into
MEM-6) and T262-1 appear as one-line cross-references because their primary lens is another.
Wall-clock figures are load-dependent (verifiers saw a 2-3x spread between runs); computron
counts are build-independent and reproduced exactly.
The interpreter baseline is about 42 ns per computron (41.8 ns on a release Rust probe: a
1M-iteration loop, 22,500,031 computrons in 0.94 s); ratios below use the baseline of the same
run where it differs.
test262 counts are per file from the differential sweep's `report.json` unless called "rows"
(case/mode rows of the committed shards).
Probes are cited relative to this file as `../probes/<region>/<file>`; verifier probes live under
`../probes/verify/<region>/`.

## Security and isolation

### CMP-1 — Dynamic Function constructors run injected code at construction time (critical)

`create_dynamic_function` (Function, GeneratorFunction, AsyncFunction, AsyncGeneratorFunction)
builds `(<head> anonymous(<params>\n) {\n<body>\n})` and hands it to `eval_source`.
It never parses the parameters as FormalParameters or the body as FunctionBody on their own, as
ECMA-262 CreateDynamicFunction requires, and does not even check that the result is exactly one
function expression (XS's `fxCheckFunction`).
A body such as `}); <code>; (function(){` closes the function early, and `<code>` runs in the
caller's global scope during the constructor call; comment-spanning and comma shapes are
accepted too, where Node throws SyntaxError.
On IronHorse-native compartments each compartment's `Function` is homed to its own global, so
there this is a spec divergence.
The deployed path is different: the thixotrope IronHorse worker bundles the SES shim (it resolves
`ses` with no `xs` condition) and calls its `lockdown`, and guest source runs in
`new Compartment()`.
The shim's per-compartment `Function` validates guest text by calling the start compartment's
`FERAL_FUNCTION` on the parameters alone and on the body alone, relying on "all engines validate
the bodyText, taken by itself, correctly".
On IronHorse those validation calls execute the injected statements against the
start-compartment global, where `thixotropeSend` and `thixotropeTakeOutbound` are bound: a
compartment escape on a path CI runs (`test-thixotrope-ironhorse`).
No end-to-end SES run was possible (no built bundle in the checkout); the probe reproduces the
shim's two validation calls exactly.

**Where:** `rust/engine/ironhorse-vm/src/interp/eval.rs:323-380` (concatenation and
`eval_source` call at :346-379); `rust/engine/ironhorse-compile/src/scoper.rs:421-432` (`Goal` has
no FormalParameters/FunctionBody goal); `packages/ses/src/make-function-constructor.js:47-56`;
`packages/ses/src/global-object.js:166`;
`packages/thixotrope/scripts/bundle-ironhorse-worker.mjs:14,39-42`;
`packages/thixotrope/src/worker-peer.js:52,71,79`; `.github/workflows/ci.yml:791` (the CI job that
runs this worker).

**Evidence:** `../probes/compile/fninject.js`:

```js
var FERAL_FUNCTION = Function;
var startSecret = "start-compartment-only";
function validateLikeSES(parameters, bodyText) {
  try { new FERAL_FUNCTION(parameters, ""); } catch (e) { return "params:" + e.name; }
  try { new FERAL_FUNCTION(bodyText); } catch (e) { return "body:" + e.name; }
  return "validated";
}
var r1 = validateLikeSES("", "}); globalThis.leak1 = startSecret; (function(){");
var r2 = validateLikeSES("a) {}); globalThis.leak2 = startSecret; (function(b", "");
throw new Error([r1, r2, "leak1=" + globalThis.leak1, "leak2=" + globalThis.leak2].join(" | "));
```

IronHorse:
`Error: validated | validated | leak1=start-compartment-only | leak2=start-compartment-only`.
Node: `Error: body:SyntaxError | params:SyntaxError | leak1=undefined | leak2=undefined`.
Both verifiers and the orchestrator reproduced it.
`../probes/compile/v2/fn_shapes.js` shows the comment-span, body-close-reopen and generator
`yield`-escape shapes all yield a function on IronHorse and SyntaxError on Node.

**Fix:** Add compiler goals for FormalParameters (with each function kind's `[Yield, Await]`)
and FunctionBody that must consume their whole input, and run both before compiling the
assembled expression.
A cheaper interim: require that the assembled source parses to exactly one parenthesized function
expression whose parameter and body spans coincide with the supplied pieces (the lexer already
computes `Lexeme.start/end`, which nothing reads today).
Add regressions for the body-close, parameter-close, comment-span and comma shapes for all four
constructors.
Until this lands, the SES shim on IronHorse is not a sandbox; tell its maintainers.

**Also:** same defect FN-9 (verified as a native-compartment spec divergence).
test262 has almost no coverage of this shape; no `built-ins/Function` failure is attributable.

Findings near a boundary that the verifiers established are not escapes: PROP-6 (pre-lockdown
code can already mutate `%Object.prototype%`, and after lockdown it is non-extensible), RGX-2 (the
accessor special case always returns the true internal value), CORE-4 (compartment globals have
a null prototype, a fidelity gap), BOOT-8 (lockdown shares the start compartment's `Date` and
`Math`, but `Date.now()` is 0 and `Math.random` is absent; lens 3), and SNI-1 to SNI-4 (crafted
containers are host-supplied input, and no production daemon path adopts containers).

## Determinism and replica agreement

### BOOT-1 — A resumed machine diverges from its live twin via unpersisted `pending_surfaces` (high)

`ordinary_define_own_property` runs `materialize_intrinsic_own_surface(inst)` only while
`self.pending_surfaces` contains the holder.
`pending_surfaces` is seeded at boot with every roster holder, shrunk only by materialization,
and deliberately not persisted, so a resumed machine has every holder pending again.
Materialization ends with `install_pending_intrinsics()`, a machine-wide pass that installs every
above-floor name on every holder, so the doc claim that "completing a complete surface again
changes nothing" is false.
Once a live machine has completed holder H, a later define of a new key on H skips the pass on
the live machine but runs it on the resumed twin.
Any name interned meanwhile without a pass (JSON.parse keys, RegExp group names, groupBy keys)
then gets its intrinsic members installed on the resumed twin only, and the two compute
different results and charge different computrons for the same delivery.
Pass 2 lowered this from critical: the shipped consensus configurations freeze or lock down
before their first checkpoint (endo's `Machine::new()` freezes the intrinsic graph; the thixotrope
worker's boot bundle ends in SES `lockdown()`), and frozen holders skip materialization.
It is reachable when an embedder checkpoints an unlocked machine: the default `Interp::new()`,
`Machine::unfrozen_with_start_global_names`, or SES-shim users before lockdown.

**Where:** `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:260-265`;
`rust/engine/ironhorse-vm/src/interp/state.rs:2873-2882`;
`rust/engine/ironhorse-vm/src/interp/boot.rs:89`;
`rust/engine/ironhorse-vm/src/interp/link.rs:1578-1582,1651-1652`;
`rust/engine/ironhorse-snapshot/src/sidetable.rs:733-736`.

**Evidence:** twin probe `../probes/verify/vm-boot-realm-modules/zz_audit_verify_1.rs` (pass-2
copy `pass2/zz_audit_verify_21.rs`).
Crank 1 is `Object.getOwnPropertyNames(Boolean.prototype); 0`; crank 2 runs on the live machine
and on a twin resumed from a store:

```js
var parsed = JSON.parse('{"to' + 'Fixed":1, "x":2}');
Object.setPrototypeOf(Number.prototype, parsed);
Boolean.prototype.zz = 1;
var seen = []; for (var k in Object(1)) seen.push(k); seen.join()
```

Live: `(true, "Return", "toFixed,x", 212)`; resumed: `(true, "Return", "x", 177)`.
Result and computrons differ.
A control with crank 1 = `0` agrees; adding `lockdown()` or `Object.freeze(Boolean.prototype)` to
crank 1 makes both sides agree (on BOOT-2's wrong answer).

**Fix:** Stop branching on non-persisted state.
Persist per-holder completion (a bitset row, as `designs/ironhorse-intrinsic-fault-in.md`
proposes) or derive it from persisted data (H is complete iff every roster name of H has an id at
or below `installed_names_len`); the smallest fix makes the define path independent of
`pending_surfaces`.
Add this live-versus-resumed pair to `ironhorse-snapshot/tests/name_floor_carry.rs`, whose
existing row covers only the reflection path.

**Also:** same root (lazy intrinsic installation) BOOT-2, BOOT-3, BOOT-4, PROP-4.

**What else was checked.**
Every region reviewer looked for nondeterminism and none survived: compiler hash collections are
lookups only; all 34 snapshot capture functions sort hash-map iteration by owner; GC roots and
live chunk offsets are sorted and finalization callbacks run in owner order;
`hoist_vars_to_global` and `boot_fingerprint` sort; the `CollKey` hash is process-random but only
picks a lookup start; `PropertyIndex`'s `RandomState` affects only which owners are dropped first;
time sources are the constant 0; NaN payloads are canonicalized; transcendental `Math` uses
platform libm unless the `deterministic-math` feature (enabled by `consensus`) is on.
Panics and halts found elsewhere in this lens are deterministic across replicas.
One residual risk remains: where host memory lies outside every ceiling (the second part of
"Resource bounds that do not bound"), host RAM rather than the deterministic ceiling decides when
a machine fails, so replicas on hosts of different sizes can fail at different points.
The verifiers judged that speculative for today's homogeneous deployments; it is part of why those
findings are high.
INT-9 (each embedder compiles cranks with a different goal) and SNI-9 (one machine admits several
valid container encodings) are low and in the table at the end.

## Host panics and aborts reachable from guest input or persisted state

The workspace release profile sets `overflow-checks = true` (`rust/engine/Cargo.toml:30-31`), so
unchecked arithmetic panics rather than wraps.
`run_shared_outcome` converts only resource stops (`HeapExhausted`, `HostAllocationFailed`) into
halts and re-raises every other panic past `Interp::run`
(`rust/engine/ironhorse-vm/src/interp.rs:2973-2992`), and neither endo entry point catches it
(INT-2).
Each trigger below therefore reaches the embedder as an unwind.
Two further abort paths are infallible host allocation outside the ceilings (CMP-2 and CORE-5,
under "Resource bounds that do not bound") and unbounded host-memory growth from a crafted
container (SNI-4, under "Persistence correctness").

### CORE-1 — `x--` on the Integer -2147483648 panics the host (high)

`exec_increment` handles INCREMENT/DECREMENT on an Integer slot with a boundary of `i32::MAX` for
increment and `-i32::MAX` (-2147483647) for decrement, and does `v - 1` whenever `v` differs from
the boundary.
An Integer slot can hold `i32::MIN`: `1 << 31`, `~0x7fffffff`, `x | 0` and array elements built
from them all produce it, so `v - 1` overflows and panics.
Any guest that decrements a value produced by a bitwise operator kills the worker; every replica
dies the same way, so this is a deterministic liveness denial of service, not divergence.
The boundary is transliterated from XS (`xsRun.c:3368`), where the same input is C signed
overflow (in practice a wrap to 2147483647, a wrong result); Rust's checked build turns XS's
latent bug into a host panic.
Sixteen other `i32::MIN` operations (negation, `* -1`, `/ -1`, `% -1`, SUBTRACT and more) are
correct, as is `++` at `i32::MAX`.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:3913-3921` (the only `-i32::MAX` in
the crate); `rust/engine/Cargo.toml:30-31`; `rust/engine/ironhorse-vm/src/interp.rs:2976-2991`.

**Evidence:** `../probes/verify/vm-core-dispatch/c1_dec.js`:

```js
var a = 1 << 31; --a; throw new Error(String(a));
```

IronHorse: `panicked at ironhorse-vm/src/interp/dispatch.rs:3917:74: attempt to subtract with
overflow` then `InternalError: ironhorse panicked`; Node: `Error: -2147483649`.
`c1_elem.js` (`a[0]--` on `[-2147483648|0]`) and `c1_post.js` (postfix `a--` on `~0x7fffffff`)
panic at the same line.

**Fix:** Use the pattern `apply_arith` already uses: `checked_add(1)` / `checked_sub(1)`, and on
`None` switch the slot to Number with `v as f64 ± 1.0`; keep the metering unchanged.
Add `i32::MIN` prefix and postfix decrement on a variable, an element and a property to the
operator regressions, and note in the oracle notes that XS itself yields 2147483647 here, so the
differential must expect the spec value.

**Also:** INT-2 (no containment at the embedding seam); same panic class as CORE-14.

### INT-2 — Panics escape both endo entry points, and a surviving caller commits the crank (medium)

In `rust/endo`, the only unwind boundary on the execution path is `catch_store_fault`, which
converts the typed store-fault unwind and calls `resume_unwind` for everything else, without
rewinding or clearing the session.
`PanicKind::EngineFault` is documented as produced "at the thread/FFI boundary", but its only
production construction wraps the compiler.
A guest-reachable panic such as CORE-1 therefore escapes `Machine::eval`/`run_script` (so
`endor run -e ironhorse` dies with a Rust panic rather than an engine-fault report) and escapes
`PersistentMachine::eval` with the heap left mid-crank.
If any caller catches the unwind and keeps the `PersistentMachine`, the next completed crank
passes the quiescence gate and checkpoints the panicked crank's writes, breaking the type's
"no partial effect ever persists" contract.
Downgraded from high: `PersistentMachine` has no production caller
(`rust/endo/src/engine/js_machine.rs:18-23`), and
the production thixotrope worker does not catch panics, so its thread dies and nothing is
checkpointed; the defect is latent until a supervisor wraps `eval` in `catch_unwind`, as
`rust/endo/src/inproc.rs:268-290` already does for xsnap.

**Where:** `rust/endo/src/ironhorse_engine.rs:1071-1081` (`catch_store_fault` re-raises),
`:1482-1525` (eval's only rewind paths), `:727-773` (ephemeral evaluate, no unwind boundary),
`:637-640` (only `Halt::Panic(EngineFault)`); `rust/engine/ironhorse-vm/src/interp.rs:2973-2992`.

**Evidence:** `../probes/verify/integration-fuzz-oracle/int2_dec_min.js` (CORE-1's trigger)
panics through `ironhorse-xst`.
The persistence half rests on the region map's exact-call mirror over `SqliteHeapStore`
(`rust/endo` cannot build here; reviewed, not re-run): after crank C1 `x = 2` panics and is
caught, crank C2 `String(x)` completes with `"2"` and checkpoints, and a reopened store still
answers `"2"`.

**Fix:** Make execution an unwind boundary in both entry points: wrap it in `catch_unwind`,
convert a non-store-fault payload to `Halt::Panic(PanicKind::EngineFault{..})`, and on the
persistent path rewind to the last checkpoint (or clear the session so the next call meets
`SessionLost`) before returning.
Pin it with the VM's `PANIC_AT_STEP` hook.

**Also:** CORE-1, SNS-4 (other unwinds that reach this seam); INT-5 (low, lens 6: the halt
taxonomy this boundary should feed).

### SNS-4 — A damaged row under a lazy fault panics past every store-fault catch (medium)

A failed row read under a lazy fault unwinds as a typed `StoreFault(StoreError)`, which
`catch_store_fault` converts into a classifiable error.
A row that reads but has the wrong length, fails to decode, or holds an out-of-arena or
free-slot reference instead hits a plain `panic!`/`assert!` with a `String` payload, which every
catch site re-raises.
For a truncated slot-page row the panic already fires inside `resume_from_store_lazy`, because
restoring bulk side tables faults pages to validate value shapes.
So the daemon's `PersistentMachine::open`, `rewind_to_last_checkpoint` (both through
`resume_shared`, which has no catch) and `eval` unwind anonymously and never return a
`MachineError::Store` the supervisor could classify as Poisoned; eval's rewind branch never runs.
The eager path and `validate_store_content` report the same damage as typed `RowLength`/`Corrupt`.

**Where:** `rust/engine/ironhorse-snapshot/src/machine.rs:1396-1404` (decode panic),
`:677-685`; `rust/engine/ironhorse-vm/src/value.rs:313-372` (`validate_records` asserts),
`:2169-2176` (extent-length assert); `rust/endo/src/ironhorse_engine.rs:1071-1081`, `:1220-1226`,
`:1366-1372`, `:1482-1521`.

**Evidence:** `../probes/verify/snapshot-store/zz_audit_verify_1.rs` (output in `output.txt`) wraps
a `MemoryStore` and drops the last 20-byte record of one slot page: `MODE 0: UNTYPED PANIC
escaped catch_store_fault: page source returned 255 records for page 18, expected 256`, with a
backtrace from `SlotArena::ensure_page_resident` up through `resume_from_store_lazy`.
The control (an `Io` error for one page) is typed and classifies Transient.

**Fix:** Validate length and decode in `StorePageSource::slot_page`/`chunk_extent` and raise
`StoreFault(StoreError::RowLength{..})` or `Snapshot(Corrupt(..))`; give `PageSource` a fallible
hook in place of the asserts in `value.rs`; wrap `resume_shared` in `catch_store_fault` in the
daemon; add a `row_corruption` case asserting `classify() == Poisoned` on the lazy path.

**Also:** SNS-12, SNS-13 (low: the same damage classified differently by construction site).

### SNI-2 — Crafted HEAP string offsets give wrong answers, then a host panic (medium)

Side-table chunk references are validated with `ChunkArena::validate_references`, which walks the
block chain, but HEAP records (string and BigInt property values, symbol descriptors) get only
`4 <= offset <= chunk_len`, and the BLOC chain itself is never walked on the container path.
A container that moves a string's offset four bytes into its own payload is adopted; `len_of`
then reads two UTF-16 code units as a length header, and the first concatenation slices past the
arena and panics.
Pass 2 lowered this from high: the input is a host-supplied container, not guest input, no
production daemon path adopts containers, and the store-seam design names hostile chunk content
a known "decode-later-panic-at-compact surface"; it still breaks the container contract that
containers "are still validated completely before adoption" (`rust/engine/ARCHITECTURE.md:236`).

**Where:** `rust/engine/ironhorse-snapshot/src/image.rs:5099-5108`, `:5215-5219`;
`rust/engine/ironhorse-vm/src/value.rs:2596-2607` (`len_of`), `:2316-2318` (unchecked slice).

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test
`v2_string_offset` (log `v2_string_offset.log`): the crafted container is accepted;
`s.length` answers `553656448`; `s.charCodeAt(0)` answers 67 (`C` instead of `A`);
`(s + '!').length` panics with `range end index 1107330088 out of range for slice of length
17226` at `value.rs:2318:57`.

**Fix:** In the single adoption pass SNI-1 recommends, collect every non-null chunk reference
held by a live HEAP record, validate them with one `validate_references` call (which also walks
the BLOC chain compaction later asserts on), and apply the per-kind payload checks
`validate_restore_value_shape` already applies to side tables.

**Also:** same root SNI-1, SNI-4 (HEAP records not validated at adoption).

### SNI-3 — A crafted METR meter index panics the host on the first instruction (medium)

`MeterImage::decode` accepts the meter's index, interval and count as arbitrary `u64`, and
`validate` compares only the cost-table name and digest; restore installs them verbatim.
The per-dispatch tick is `self.index += CODE_METERING` (1 << 16) with a plain `+=`, so a container
carrying `index = u64::MAX - 3` panics on the first instruction of every crank, while
`charge_and_check` and `charge_compilation` already use `checked_add` and fail closed.
For honest machines the index is a lifetime accumulator once a resumed machine is reattached
(only boot calls `begin`), so a long-lived daemon vat would also panic after 2^48 computrons,
which is weeks of CPU and theoretical today.
Lowered from high for the same reason as SNI-2: host-supplied input, no production adoption path.

**Where:** `rust/engine/ironhorse-snapshot/src/image.rs:103-131,133-151`;
`rust/engine/ironhorse-vm/src/meter.rs:325-331` (restore), `:187-189` (`tick_code`), and the
unchecked adds at `:207,213,219,228,235,268`.

**Evidence:** test `v4_meter` (log `../probes/verify/snapshot-image-codec/v4_meter.log`):
`METR index=u64::MAX-3 ACCEPTED`, then `panicked at ironhorse-vm/src/meter.rs:188:9: attempt to
add with overflow` on the crank `t + 1`.

**Fix:** Validate METR at decode (bound the index with headroom for any single charge; require
interval/count coherence), and make every `tick_*` use `checked_add` and fail closed through the
existing abort path.

Low in this group (table at the end): CORE-14, a crafted `*_4` instruction length that overflows
`usize` on wasm32 in `instruction_len`, dispatch and snapshot restore (static; the compiler never
emits it).

## Resource bounds that do not bound

IronHorse promises three bounds: a slot ceiling and a chunk ceiling that are supposed to make the
footprint "a linear function of the ceilings" (`rust/engine/WASM-MEMORY.md:34-36`), and a meter
that is a deterministic proxy for CPU time.
Each fails in a different way.
Within a crank the ceilings bound cumulative allocation rather than the live set, so ordinary
garbage-producing code halts.
Several kinds of host memory are charged to no ceiling at all, so a guest can hold hundreds of
MiB with a few slots.
And a family of natives does work far out of proportion to what it charges, so a computron
budget does not bound wall time.

### No reclamation within a crank

Collection is admitted only at a quiescent boundary and run by the host
(`rust/engine/ironhorse-vm/src/interp/gc.rs:6-14`); `rust/engine/RECLAMATION.md:63-66` makes
"No collection runs within a crank" a documented decision.
XS, which IronHorse transliterates, collects under allocation pressure, so programs that run on
XS halt here.
The resulting `HeapExhausted` halt is uncatchable and deterministic.
INT-1 (high, under "Persistence correctness") is the extreme case: the thixotrope IronHorse worker
never collects at all.

### NVAL-3 — String append in a loop exhausts the 256 MiB chunk ceiling at ~16,400 appends (high)

`concat_add` decodes both operands into `Vec<u16>`, joins them into a third vector, re-encodes it
and allocates a fresh chunk holding the whole result, so every `s += c` leaves the previous
result behind as garbage that cannot be reclaimed within the crank.
An append loop of n characters therefore consumes about n² bytes, which reaches the 256 MiB
default ceiling at n ≈ 16,384 and halts uncatchably.
Building output with `+=` (serializers, escapers, templates) is ordinary JavaScript; Node
completes 2e5 appends in milliseconds, and `Array.prototype.join` of 2e5 parts works in IronHorse
(0.25 s).
Pass 2 kept high: raising the ceiling to the 512 MiB consensus maximum moves the threshold only to
about 23,000 appends, and appending 80-character lines fails after about 1,800 lines.

**Where:** `rust/engine/ironhorse-vm/src/interp/strings.rs:130-142` (`concat_add`), `:170-172`;
`rust/engine/ironhorse-vm/src/value.rs:15` (`DEFAULT_CHUNK_CEILING`).

**Evidence:** `../probes/verify/vm-natives-values/n3_concat_17000.js`:

```js
let s = ''; for (let i = 0; i < 17000; i++) { s += 'x'; } if (s.length !== 17000) throw new Error('bad');
```

IronHorse: `InternalError: ironhorse halted: HeapExhausted`; Node completes.
16,000 appends complete (0.31 s); 16,500, 17,000 and 20,000 halt.

**Fix:** Concatenate the two stored payloads directly into the new chunk (one copy instead of
four); remove the quadratic retention with a rope or concat-node string kind flattened lazily, or
extend in place when the left operand's chunk is the unaliased arena tail.

**Also:** same root MEM-1, CORE-6, FN-12, INT-1; NVAL-17 (low, lens 4: every empty-string result
appends an uncharged 4-byte chunk, so 2^26 empty results halt).

### MEM-1 — Allocation never triggers collection, so total allocation halts a crank (medium)

`SlotArena::alloc` reuses only the free list refilled by a previous collection and otherwise
halts at the ceiling (1,000,000 slots; 256 MiB of chunks); the only exact collector is
host-admitted at quiescence.
Within one crank the ceilings therefore bound cumulative allocation, not the live set: a loop
`last = {a: i}` completes 499,448 iterations and halts at 499,449, a closure loop halts at
166,483, and `s += 'x'` halts by 16,400 where Node builds a 1,000,000-character string.
A guest `try`/`catch` around the loop never runs its handler.
Pass 2 lowered this to medium: the policy is documented (`RECLAMATION.md:3`, `:63-66`), the halt is
loud, deterministic and replica-identical, and the bound is stricter rather than looser; the
consequence for ordinary programs is larger than the documentation conveys.
It contributes to, but does not decide, the 452 RegExp `ironhorse-aborted-limit` cases (RGX-1
decides them).

**Where:** `rust/engine/ironhorse-vm/src/value.rs:1226-1231` (slot ceiling), `:2561-2567` (chunk
append ceiling); `rust/engine/ironhorse-vm/src/interp/gc.rs:6-14`;
`rust/engine/RECLAMATION.md:63-66`.

**Evidence:** `../probes/verify/vm-memory-gc-meter/e_nothrow.js` and `e_nothrow2.js`:
`var last; var i; for (i = 0; i < 499448; i++) { last = { a: i }; }` exits 0; the same with 499449
prints `InternalError: ironhorse halted: HeapExhausted`.
`catch.js` (2M iterations inside `try`/`catch`) halts with the handler not run; Node runs 10M.

**Fix:** Add a deterministic in-crank trigger: when the slot free list is empty at the ceiling or
a chunk append would cross it, request a collection at the next dispatch-loop safepoint with no
native frame holding unrooted slots, and halt only if the heap is still full.
The trigger depends only on replicated counters, so it is consensus-safe, but it changes
allocation order and must ship as a new cost and heap release.
Until then, document the per-crank cumulative-allocation bound as the binding limit for ordinary
code.

**Also:** same root NVAL-3, CORE-6, FN-12, INT-1; MEM-7 (lens 4: collected memory is never
returned to the host).

### CORE-6 — Literals and closures allocate per evaluation, so garbage-only loops halt (medium)

`exec_string` converts a literal and allocates a fresh chunk on every evaluation, and every
closure creation allocates 4 to 6 slots, including a default prototype that non-constructors
discard at once (CORE-12).
XS also allocates per literal, but collects when its heap fills; IronHorse keeps every allocation
until the crank ends.
Assigning a 36-character literal 4 million times, or calling `a.forEach(x => ...)` 300,000 times,
halts with `HeapExhausted` where XS and Node complete; 300,000 `{a: i}` creations still fit.
Downgraded from high for the same reason as MEM-1; the dispatch-side allocation makes the policy
much easier to hit than it needs to be.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:3170-3190` (`exec_string`);
`rust/engine/ironhorse-vm/src/interp/function.rs:314-378`.

**Evidence:** `../probes/verify/vm-core-dispatch/c6_p10_garbage.js`:

```js
(function(){ var s; for (var i = 0; i < 4000000; i++) { s = "abcdefghijklmnopqrstuvwxyz0123456789"; } })();
```

IronHorse: `InternalError: ironhorse halted: HeapExhausted` at 268,556 KB peak RSS; Node completes.
`c6_p21_arrow_churn.js` halts the same way.

**Fix:** Share one chunk per string literal site and keep the metering tick; stop allocating the
dead default prototype for non-constructors (CORE-12, FN-15); document the effective per-crank
garbage budget (about 250,000 closures at the default slot ceiling).

**Also:** same root MEM-1; CORE-12, FN-15 (lens 4, the dead prototype).

### FN-12 — Each `await` of a non-promise allocates an unreclaimable capability (medium)

`schedule_native_await`'s general path builds a full promise capability for every awaited value
that is not a native promise: a promise slot, two resolving-function slots and their side rows.
All of it is garbage at the resume, so `for (...) await 1` consumes 3 slots per iteration until
the slot ceiling halts the crank; awaiting an already-resolved native promise takes the fast path
and completes.
For a primitive operand, PromiseResolve has no observable steps, so the capability is pure
overhead.

**Where:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:1165-1168`.

**Evidence:** `../probes/verify/vm-functions-async/p22_await_loop_heap.js`
(`async function f() { for (let i = 0; i < 400000; i++) await 1; }`): `InternalError: ironhorse
halted: HeapExhausted` at 295.7 MiB; `p22b_await_promise_loop_heap.js` (awaiting
`Promise.resolve(1)`) completes at 10.9 MiB; Node completes both.

**Fix:** For a primitive or provably non-thenable operand, enqueue the resume job directly with
the value and keep the calibrated charge.

**Also:** same root MEM-1; FN-5, FN-7 (same function's fast-path condition and an extra
capability on async generator return).

### Host memory outside every ceiling

The side-storage ledger, the only mechanism that charges host-side tables against the chunk
ceiling, sums four tables: array items, index properties, collections and Intl segments
(`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:13-35`).
Everything else a guest can make the host retain is invisible to both ceilings; only the meter
limits it, and some of it is infallible allocation that aborts the process (or traps on wasm32)
instead of halting.
`RECLAMATION.md` and `WASM-BLOCKERS.md` (B7, B8) record "other side tables are still not charged"
as an open blocker, but `WASM-MEMORY.md`'s Decisions still size the 128 MB isolate profile on the
premise that the footprint is linear in the ceilings.

### CMP-2 — Compiling holds ~220-345 B of uncharged, infallible host memory per character (high)

One compile holds the decoded source as `Vec<u32>` (4 B per character), an offsets `Vec<usize>`
(8 B per character) that exists only to fill `Lexeme.start/end`, which nothing outside the lexer
reads, one boxed 80-byte node per AST node, one `Vec<u16>` per identifier occurrence, the scoper's
tables and every coder record until serialization.
None of it is charged to a ceiling, and all of it is infallible, so exhaustion aborts the native
process or traps the wasm32 instance rather than raising `HostAllocationFailed`
(`WASM-MEMORY.md:552-556` lists the compiler among infallible allocators; the magnitude is new).
A guest controls source length through `eval` and `Function`, bounded only by the chunk ceiling:
at the recommended 4 MiB chunk ceiling a 2M-unit `eval` needs about 550 MB, several times the
128 MB worker cap, and the trap is deterministic, so replaying the crank traps again.

**Where:** `rust/engine/ironhorse-compile/src/lexer.rs:146-187` (chars and offsets), `:37-48`;
`rust/engine/ironhorse-compile/src/ast.rs:137-207`;
`rust/engine/ironhorse-compile/src/coder.rs:378-382,744-753`; reached from
`rust/engine/ironhorse-vm/src/interp/eval.rs:90`.

**Evidence:** `../probes/compile/maxrss.py` on release `ironhorse-xst`: building a 2M-character
source string costs 29.9 MB peak RSS; `(0, eval)` of it costs 550.2 MB (2.07 s); a 4M-character
source costs 1,094 MB.

**Fix:** Admit a per-compile allowance proportional to source length against the chunk ceiling
before lexing (or cap `eval`/`Function` source length); make the dominant growth points fallible
or run the compile under an allocation budget; cut the constants (drop or use the offsets, lex
the `&[u16]` in place, intern identifiers, arena-allocate nodes, stream code records).

**Also:** CMP-5 (uncharged cover-grammar clones).

### CORE-5 — Spread into a native call grows the host value stack without bound (high)

The modeled XS stack (4,096 slots) is enforced only by `would_overflow`, which runs at user-frame
entry and at the four generator/async resume sites.
`Interp::push` is an unchecked `Vec::push`, the compiler emits a spread as one push per element,
and `exec_run` dispatches native callees with no overflow check.
So `Math.max(...a)` over 100,000 elements completes where the same spread into a user function
halts `StackOverflow`, and a guest that spreads one 1M-element array 20 times into one native
call drives about 470 MB of host memory that no ceiling covers.
The stack is never shrunk, a failed allocation aborts natively, and XS (which checks every push)
would overflow on both spreads.

**Where:** `rust/engine/ironhorse-vm/src/interp/frames.rs:28-36` (`would_overflow`, unchecked
push), `:340-401` (`enter_call`); `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2536-2564`;
`rust/engine/ironhorse-vm/src/interp/suspend.rs:267,462,722,932`.

**Evidence:** `../probes/verify/vm-core-dispatch/c5_p17_spread_native.js` (100k `Math.max(...a)`):
`Error: max=99999`; `c5_p17_spread_user.js` (same spread into a user function):
`InternalError: ironhorse halted: StackOverflow(6)`; `c5_p18_spread_amplify.js` (1e6 elements
spread 20 times): peak RSS 532,160 KB against 63,284 KB for building the array alone.

**Fix:** Check `would_overflow(1)` in `push` (or reserve in bulk in the spread loop) and
`would_overflow(argc)` at every native call entry, raising the same halt as `enter_call`; report
the pre-truncation slot count; optionally shrink the stack at crank end.
Pin the change against the XS oracle, since it changes which programs halt.

**Also:** FN-10 (the user-frame side of the same budget, and an uncatchable halt).

### MEM-3 — Bound args, disposal records, registry cells and side rows escape every ceiling (high)

`Function.prototype.bind` builds its bound-argument `Vec<Slot>` with `reserve_scratch`, which
only checks that the capacity would fit at that moment and reserves nothing, then keeps it in
`BoundData`; DisposableStack `defer`/`use`/`adopt` records, FinalizationRegistry cells and pending
reaction vectors are plain `Vec::push`; `FuncInfo`, `PromiseData`, `SavedFrame` and `ErrorInfo`
rows are uncharged.
Under the 128 MB isolate profile (262,144 slots, 4 MiB of chunks) a guest holds 185.5 MiB with
400 binds of a 20,000-argument spread, 224.3 MiB with 4M defers, and 128.3 MiB with 3M
registrations of one target, each with about 1,100-3,100 live slots and 0-1 MiB charged.
The cells and records persist across cranks; on wasm32 a failed infallible push traps.

**Where:** `rust/engine/ironhorse-vm/src/interp/function.rs:763-775,847-854`;
`rust/engine/ironhorse-vm/src/interp/natives/resource.rs:121,149,176`;
`rust/engine/ironhorse-vm/src/interp/natives/weak.rs:195`;
`rust/engine/ironhorse-vm/src/interp/natives/promise.rs:468-472,1127-1131`;
`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:15-34`;
`rust/engine/ironhorse-vm/src/interp/admission.rs:265-273`; `rust/engine/WASM-MEMORY.md:34-36`.

**Evidence:** `../probes/verify/vm-memory-gc-meter/zz_audit_verify_1.rs` test
`mem3_uncharged_retention` (output `verify1.out`), counting allocator:
`bind_400x20k: host_heap=185.5MiB live_slots=3116 side_charged=1064960B`,
`defer_4M: host_heap=224.3MiB live_slots=1112 side_charged=0B`,
`finreg_register_3M: host_heap=128.3MiB live_slots=1112 side_charged=0B`.

**Fix:** Charge every retained row to the chunk ledger at a declared width: convert bind's
scratch admission into a side reservation, reserve per disposal record, finalization cell and
reaction with `try_reserve` (halting instead of aborting), add per-row widths for function,
promise, frame, error and RegExp rows, and re-derive them in `side_storage_charge`.
Correct `WASM-MEMORY.md`'s per-slot constant until then.

**Also:** same root FN-2, FN-3, NOBJ-6 (overlapping shapes reported from other regions), RGX-4,
CMP-2, CORE-5; MEM-6 (lens 4: the per-row sizes).

### FN-3 — Function, promise, activation and bound-argument rows escape the ceilings (high)

This is MEM-3's mechanism seen from the function and async region: `side_storage_charge` covers
none of `functions`, `promises`, resolving-function pairs, `promise_functions`, suspended
generator and async activations, `error_data` or `bound_functions`, so each such object costs host
memory that the slot ceiling sees as 1 to 6 slots.
The verifier found a sharper case than MEM-3's: native callees accept argument lists far beyond
the value stack (FN-10), so `Function.prototype.bind.apply(t, {length: 1e6})` makes one bound
function that holds about 24 MB.

**Where:** `rust/engine/ironhorse-vm/src/interp/side_ledger.rs:13-31`;
`rust/engine/ironhorse-vm/src/interp.rs:679-683` (`BoundData.args`), `:843-905` (`FuncInfo`),
`:1201-1214` (`PromiseData`), `:2313-2336` (`SavedFrame`);
`rust/engine/ironhorse-vm/src/interp/function.rs:763-775`.

**Evidence:** `../probes/verify/vm-functions-async/v03_bound_huge.js`:

```js
var args = { length: 1000000 };
function t() {}
var keep = [];
for (var j = 0; j < N; j++) keep.push(Function.prototype.bind.apply(t, args));
throw new Error('done bound=' + keep.length + ' len=' + keep[keep.length - 1].length);
```

N = 1: 51.8 MiB peak RSS; N = 20: 487.1 MiB (5.1 s).

**Fix:** As MEM-3, with bound arguments charged by length; bound the native argument list
(FN-10) so that one slot cannot carry megabytes.

**Also:** same root MEM-3, FN-2, NOBJ-6.

### NOBJ-6 — FinalizationRegistry cells are charged to no ceiling (high)

`FinalizationRegistry.prototype.register` appends a 32-byte cell to a host `Vec` and only ticks
the meter.
The same live target can be registered without limit, so no new heap slots are needed and the
heap ceiling never fires.
Cells persist across cranks and into snapshots until the target dies; XS allocates each cell from
its ceiling-bounded slot heap.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:190-204`;
`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:16-35`.

**Evidence:** `../probes/verify/vm-natives-objects/n6_fr_<n>.js`
(`const fr = new FinalizationRegistry(() => {}); const t = {}; for (...) fr.register(t, 0);`):
1M cells 36.6 MB, 4M 128.3 MB, 12M 372.0 MB and completes; the control `n6_arr_12m.js` (12M array
pushes) halts `HeapExhausted` at 239.8 MB.
A Rust probe measured 32.0 host bytes and 0.0 charged bytes per cell.

**Fix:** Charge cells in the side ledger by capacity class (reserve on push, release on
unregister, cleanup and collection) and include registries and DisposableStack records in
`side_storage_charge`.

**Also:** same root MEM-3; MEM-5 (the same cell list makes `unregister` O(n)).

### FN-2 — Error construction copies every frame's name into uncharged host memory (high)

Every error construction (including internal errors, AggregateError, SuppressedError and promise
rejections) clones `FuncInfo.name` for every live frame into `ErrorInfo.frames: Vec<String>`,
uncharged and kept as long as the error lives; the `stack` getter then clones the whole record
again.
A function name can be set at run time from a computed key of any length, so retained host memory
per error is depth × name length with no guest-visible bound.

**Where:** `rust/engine/ironhorse-vm/src/interp/errors.rs:10-22` (call sites `:61,112,227,327` and
`natives/promise.rs:2050`); `rust/engine/ironhorse-vm/src/interp.rs:1567-1576`;
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:7681-7711`.

**Evidence:** `../probes/verify/vm-functions-async/v02_errframes_dynname.js`:

```js
var name = 'f' + 'x'.repeat(NAMELEN);
var o = { [name]: function (n) { if (n > 0) return o[name](n - 1); for (var i = 0; i < 20; i++) keep.push(new Error('e')); return 0; } };
var keep = [];
o[name](200);
throw new Error('done errors=' + keep.length + ' namelen=' + o[name].name.length);
```

`NAMELEN = 1`: 10.9 MiB peak RSS; `NAMELEN = 100000`: 391.1 MiB, with the same guest work and
live slots.

**Fix:** Capture frames as function slot indexes or interned name ids, charge them per frame to
the side ledger, cap the captured depth, render lazily, and make the `stack` getter borrow rather
than clone.

**Also:** same root MEM-3, FN-3.

### RGX-4 — Compiled RegExp programs live outside the chunk ceiling (high)

In XS, compiled code and data buffers are chunk allocations that count against the heap.
Here each compiled `Program` lives in the `regexps` side table, its bytes are charged only as
meter work (`charge_chunk_work` allocates nothing and charges one raw unit, 1/65,536 computron,
per byte), and `side_storage_charge` omits `regexps`.
The amplification is large: under the `v` flag, `\p{RGI_Emoji}` lowers its multi-scalar sequences
into a disjunction, so 15 characters of source compile to 257,716 bytes.
Pass 2 measured the remaining bound: at the production embedding's 100M-computron crank limit
(`rust/endo/src/ironhorse_engine.rs:471`), one crank can retain about 15,600 instances, roughly
4 GB, against a 256 MiB chunk ceiling, and the total grows across cranks.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:383-404`;
`rust/engine/ironhorse-vm/src/interp/admission.rs:104-112`;
`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:16-35`;
`rust/engine/ironhorse-regexp/src/compile.rs:2090` (`charset_strings_disjunction`).

**Evidence:** `../probes/verify/regexp/zz_audit_verify_1.rs`: with the chunk ceiling set 2 MiB
above the base, keeping 40 `new RegExp('\\p{RGI_Emoji}','v')` completes with a chunk delta of
1,440 bytes, while keeping 40 copies of a 250,000-character string halts `HeapExhausted`.
`../probes/regexp/p14_retained_14.js` (2,000 instances): 501.5 MB peak RSS against 11.0 MB for
2,000 `/a/v` (Node: 43.7 MB).

**Fix:** Count each retained RegExp (program bytes, data-buffer estimate, source and flags) in
`side_storage_charge` and reserve it through chunk-ceiling admission before insertion; share
compiled programs between instances with the same source and flags; give string-set classes a
dedicated matcher node instead of a lowered disjunction.

**Also:** same root MEM-3.

### COV-3 — Crank completion and uncaught-throw rendering is unbounded, unmetered host work (high)

Every completed crank renders its completion value, and every uncaught throw, into a host
`String` through a walker bounded only by nesting depth, which charges no computrons and allocates
outside both ceilings, so arrays that share children render exponentially many leaves: the guest
pays O(n) to build what the host spends O(2^n) to print.
A 30-deep DAG of two-element arrays ends in a Rust abort (`memory allocation of 2684354560 bytes
failed`, SIGABRT after 27.27 s at 1,286 MiB under a 2 GiB address-space limit), not a typed halt;
the 485 MB end-of-run RSS this lens first listed as a lead is the same render.

**Where:** `rust/engine/ironhorse-vm/src/interp.rs:3223-3242` (`run_inner`), `:3271-3276`
(`finish_step`); `rust/engine/ironhorse-vm/src/interp/render.rs:41-96`; reached from the endo seam
(`rust/endo/src/ironhorse_engine.rs:777-780`), `ironhorse-xst` and the test262 lanes.

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/handed-off-leads/l3_dag_24.js` and
`l3_dag_30.js`.

The cross-region merge MEM-6 (lens 4; same defect NOBJ-15) belongs to this theme but is not a
bypass: array items cost 55.6 host bytes each while the ledger charges 32 or 64 bytes depending on
the capacity class, and an array pushed to the ceiling halts at about 240 MB RSS.

Array sort's merge scratch is outside every ceiling too (unnumbered; `../COVERAGE.md`, "Lost
content and consistency").
`values.clone()` at `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4293`, inside
`array_stable_sort` (`:4284`), is admitted to no ceiling, while its input is admitted by
`reserve_scratch` at `:4549`, so a sort near the chunk ceiling holds up to about twice the ceiling.

### Work charged far below its cost (meter amplification)

The meter is meant to approximate CPU time (`rust/engine/README.md:5-21`; the 2026-07-04
revision of `designs/ironhorse-engine.md` chose accuracy over XS parity).
The operations below do host work that grows faster than their charge, or charge after the work,
or do work no meter sees.
A computron budget sized for ordinary code (about 42 ns per computron) then admits seconds to
hours of host CPU per crank, and a host meter cannot interrupt the call while it runs.
The table consolidates the measurements; "×" is against the same run's interpreter baseline.

| Finding | Operation | Host time | Computrons | ns per computron (×) | Growth |
|---|---|---:|---:|---:|---|
| MEM-2 | host collection after building 16,000 objects with own getters | 3.75 s | 0 (659,435 to build) | uncharged (≈5,700 per build computron) | O(marked × rows) + O(swept × rows); WeakMap chains O(n²) |
| MEM-4 | `new Uint8Array(16e6).fill(7)` | 3.54 s | 282 (274 is the allocation) | ≈12,500,000 (≈300,000×) | O(n²/65,536) dirty marking, no per-element charge |
| MEM-4, NOBJ-2 | default `sort()` of a reversed `Int32Array(20000)` | 0.686 s | 5,013 | 136,858 (≈3,300×) | Θ(n²) host, O(n) charge |
| MEM-5 | 40,000 `WeakMap` deletes (same loop on `Map`: 0.127 s) | 5.09 s | 3,141,338 (Map: 3,141,362) | 1,619 (Map: 40) | O(n) per delete |
| MEM-5 | 2,000 `FinalizationRegistry.prototype.unregister` on 1M cells | +3.55 s | +6,000 | ≈590,000 (≈14,000×) | O(cells) per call |
| NOBJ-3 | `union` of two disjoint 20,000-element Sets | 1.64 s | 20,353 | 80,532 (≈1,900×) | O(n·m) |
| NOBJ-3 | `Map.groupBy` with 20,000 distinct keys | 0.498 s | 230,432 | 2,163 (≈52×) | O(n·buckets) |
| NOBJ-4 (a) | `a.splice(a.length - 1, 1)` on a 200,000-element array | ≈44 ms per call | ≈39 per call | ≈1,100,000 (≈27,000×) | O(length) per call |
| NOBJ-4 (d) | 5,000 `Array.prototype.toString` fallbacks with 60,000 closures live | 0.164 s (0.012 s with none) | 130,030 either way | 1,261 (92 with none) | O(live functions) per call |
| NOBJ-5 | default `sort()` of 2,000 references to one 100,000-character string | 1.77 s | 1,021 | 1,734,246 (≈41,000×) | O(n log n × length); this site adds 20-30× over a comparator sort |
| NVAL-1 | `'a'.repeat(40000).includes('a'.repeat(20000) + 'b')` | 2.83 s | 7 | ≈400,000,000 | O(n·m), uncharged |
| NVAL-1 | the same search with `indexOf` | 3.13 s | ≈6,100 | ≈510,000 (≈14,000×) | O(n·m), 1/65,536 computron per unit |
| NVAL-2 | one squaring of a 260,000-bit BigInt | 67 ms | ≈16,000 | ≈4,100 (≈110×) | O(n²), charged after the work |
| NVAL-2 | `String(x)` of that BigInt | 124 ms | 9 | ≈13,700,000 | O(n²) |
| NVAL-2 | `BigInt('7'.repeat(200000))` | 1.21 s | 50,035 | ≈24,000 (≈650×) | O(d²) |
| RGX-5 | sticky `/a/y.test` on a 4 Mi-unit subject (16-unit subject: 2.5 µs) | 27 ms per exec | 34 per exec | ≈794,000 (≈11,000× the short subject) | O(n) per exec; O(n·m) for global loops |
| BOOT-3 | 20,000 `o['k' + j] = j` with novel keys (index keys: 0.022 s, 522,703) | 2.86 s | 470,300 | ≈6,070 (≈145×) | O(rosters + live functions) per novel key; capped near 64,400 keys per machine |
| BOOT-4, PROP-4 | 200,000 `p[k]` computed reads (static `p.k`: 0.23 s, 4,300,049) | 2.23 s | 4,900,057 | 454 (static: 53) | O(standard globals) per computed-key operation |
| BOOT-5 | relink of a 200-name crank after 50,000 runtime keys (none: 0.27 ms) | 40.5 ms per crank | 0 | uncharged | O(N·M) per crank |
| PROP-3 | `delete o[k]; o[k] = v` on an 8,000-key object (30 keys: 86 ms per 4,000 ops) | ≈2.6 ms per op | ≈10 per op | ≈250,000 (≈2,800×) | O(N) per op, N up to the key ceiling |
| CORE-10 | block exit in a frame with 20,000 `var` bindings | 279,000 instructions per iteration (3,100 with one binding) | about a dozen dispatches either way | (≈90× per iteration) | O(frame bindings) per block exit, bounded at 10^5-10^6 instructions |
| CMP-5 | compile an 80-deep arrow-parameter pattern around a 150,000-element array | 6.4 s (0.35 s at depth 1) | 1,756,376 (1,750,174) | ≈3,650 (≈18× the depth-1 compile) | O(depth × subtree), depth capped near 90 |
| COV-6 | 400,000 closure captures in closures of k = 8,000 bindings each (k = 125: 155.5 ms, 3,300,923) | 4.12 s | 3,204,720 | 1,286 (≈27× the k = 125 run) | O(k²) per closure for an O(k) charge, k capped by CMP-11's 65,534 names |
| NVAL-13 | `JSON.stringify` of a 1 MiB string nested 2,000 deep (1 level: 27.6 ms, 262,233) | 583 ms | 330,744 | ≈1,760 (≈17×) | O(depth × payload) |
| NVAL-15 (low) | `JSON.stringify({}, keys)` with 10,000 string keys | 3.50 s | 297,065 | ≈11,800 (≈110×) | O(n²) |
| FN-16 (low) | 2,000 `for-in` passes over one 100,000-character key | halts `HeapExhausted` (Node completes) | one `ENUMERATOR_NEXT` per step | n/a | O(key length) per step |

Rows from the natives-values map's own Rust probe (NVAL-13, NVAL-15) ran on a loaded host whose
baseline was 107 ns per computron; their ratios use it.
The COV-6 row is from the coverage review's Rust probe
(`../probes/coverage-review/lost-content/zz_audit_cov_91.rs`, output in `outputs.txt`).

COV-3 (high; entry under "Host memory outside every ceiling") is the limiting case: the
crank-boundary render of a completion value or uncaught throw runs after the meter has stopped, so
it charges nothing at all.
On a mirror of the endo seam's compartment path with a 20,000-computron crank ceiling
(`../probes/coverage-review/handed-off-leads/zz_audit_cov_71.rs`), a completion that is a 24-deep DAG of
two-element arrays over one 10-character string costs 917 computrons, exactly as a `void 0`
control does, and then 3.21 s of host time and a 184,549,375-byte result against 301.9 µs for the
control.
Each further level doubles the host work, and no computron budget sees any of it.

### MEM-2 — Collection time is quadratic in guest-built accessor, private and WeakMap state (high)

For every marked slot the collector's `extra_edges` iterates the whole of each pair-keyed table
(`accessors`, `private_values`, `private_accessors`) and filters by owner, and the sweep runs
`HashMap::retain` over the same tables once per reclaimed slot.
The ephemeron fixpoint rescans every live WeakMap each round, so a key chain needs one round per
link, and while any symbol-key descriptor is unmarked each round also scans the whole slot arena.
Collection charges nothing (`interp/gc.rs:102`), so a guest pays linear computrons to build such
state and every later host-driven collection (persistent workers collect on a delivery cadence)
pays quadratic wall time; pass 2 extrapolates 16,000 objects at 3.75 s to about 15 minutes per
collection at the 1M-slot ceiling.

**Where:** `rust/engine/ironhorse-vm/src/interp/gc_tables.rs:723-740`, `:40-47`, `:824-848`,
`:868-896`; `rust/engine/ironhorse-vm/src/gc.rs:183-212`.

**Evidence:** `../probes/verify/vm-memory-gc-meter/zz_audit_verify_1.rs` test
`mem2_gc_quadratic` (`verify1.out`): own getters at 4,000 / 8,000 / 16,000 objects collect in
0.161 / 0.586 / 3.747 s; two private fields per instance 17.3 / 67.0 / 262.3 ms at 2,000 / 4,000
/ 8,000; a 4,000-link WeakMap chain with 200,000 live objects collects in 79 ms, and 1.093 s once
one dead symbol-keyed property exists; 100,000 plain objects: 12.1 ms.

**Fix:** Index pair-keyed rows by owner (or keep accessor pairs in the property slot as XS does);
prune those tables once after the sweep using the swept bitmap; replace per-round WeakMap rescans
with per-key pending-value lists; mark a symbol-key descriptor when a record carrying its id is
traced.
Until then, cap or charge the tables whose collection cost is superlinear.

**Also:** MEM-9 (low: the same row walks are hand-written three times).

### MEM-4 — TypedArray fill, reverse, element stores and sort do unmetered superlinear work (high)

`ChunkArena::slice_mut(off, len)` returns the payload prefix `[0, len)` and marks every 64 KiB
extent in it dirty, and element writers pass `pos + size`, so writing element i walks O(i/65,536)
extents.
`%TypedArray%.prototype.fill` and `reverse` charge nothing per element and never check the meter
(`reverse` also allocates two `Vec`s per swap), although other TypedArray paths charge
`TYPED_ARRAY_ELEMENT_METERING`.
The default sort is an insertion sort over a `Vec<Slot>` (24 B per element whatever the element
width) charged about 0.25 computron per element, so `Uint8Array(12e6).sort()` halts
`HeapExhausted` at admission where Node sorts it.
XS sorts the default case with `c_qsort`; the comparator path is metered per callback.

**Where:** `rust/engine/ironhorse-vm/src/value.rs:2677-2687` (`slice_mut`), `:2348-2364`;
`rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:1691-1695` (fill), `:1698-1715`
(reverse), `:1306-1398` (sort; insertion loop `:1333-1388`).

**Evidence:** table rows; `../probes/verify/vm-memory-gc-meter/ta_fill_1e8.js` runs 71 s;
1M writes to byte 199,999,999 of a 200 MB `Uint8Array` take 3.95 s against 1.0 s at byte 0;
`../probes/verify/vm-natives-objects/n2_ta_sort_<n>.js` takes 0.19 / 0.68 / 2.83 s at 10k / 20k
/ 40k reversed elements (Node 0.04 s) and 0.02 s on already-sorted input.

**Fix:** Add `slice_mut_range(off, start, len)` that dirties only touched extents and use it at
every element store; charge `TYPED_ARRAY_ELEMENT_METERING × count` before (or in strides during)
fill, reverse, copyWithin and set; sort numeric elements in a typed vector with a stable
O(n log n) sort and the spec's total order, route the comparator path through
`array_stable_sort` (`natives/array.rs:4284`), and charge n·log2 n.

**Also:** same defect NOBJ-2 (the sort part); NOBJ-12 (lens 3: `toSorted` is missing and should
reuse the fixed sort).

### MEM-5 — WeakMap/WeakSet delete and registry unregister cost O(n), charged O(1) (high)

For weak collections `CollectionData::remove_entry` physically removes the entry: `keys.remove`,
a walk over every cached position to decrement those above it, and `entries.remove`.
`Map` and `Set` instead tombstone and compact amortized, at the same charge.
`FinalizationRegistry.prototype.unregister` runs `cells.retain` over every cell with no per-cell
charge, and cleanup does a position scan plus `Vec::remove` per dead cell.

**Where:** `rust/engine/ironhorse-vm/src/bulk.rs:791-808`;
`rust/engine/ironhorse-vm/src/interp/natives/weak.rs:207-221` (unregister), `:259-271` (cleanup).

**Evidence:** table rows; on `ironhorse-xst` the delete loop takes 0.22 / 0.99 / 5.34 / 23.97 s
for 10k / 20k / 40k / 80k WeakMap entries against 0.06 / 0.11 / 0.22 / 0.39 s for Map
(`../probes/verify/vm-memory-gc-meter/del_WeakMap_<n>.js`, `del_Map_<n>.js`).

**Fix:** Weak collections have no observable order: `swap_remove` and repair the one moved
position, or reuse the Map tombstone path; index registry cells by unregister token and keep a
dead-cell queue.

**Also:** same defect NOBJ-4 parts (b) and (c); same root NOBJ-6 (the cell list grows unbounded).

### NOBJ-3 — Set operations and groupBy deduplicate through uncharged linear scans (high)

The four result-building Set methods accumulate the result in a `Vec<Slot>` and test membership
with a linear SameValueZero scan (`key_list_contains`) or remove with `retain`; `Map.groupBy` and
`Object.groupBy` find each key's bucket with a linear `position`.
None of these scans is charged (union charges only memory admission per push), while XS uses its
hashed table.
Inputs of 1e6 elements are cheap in computrons and fit the heap; an `Object.groupBy` over
1,000,005 distinct keys did not finish in 120 s.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:2323-2325`, `:2370-2459`,
`:2709-2741`.

**Evidence:** table rows; `../probes/verify/vm-natives-objects/n3_union_<n>.js` takes 0.39 /
1.52 / 6.31 s at 10k / 20k / 40k (Node under 0.07 s).

**Fix:** Build each result directly in a `CollectionData` and wrap it; index groupBy buckets by
collection key (Map) or interned key (Object); charge per element visited for any residual work.

**Also:** NOBJ-16 (low: the intersection loop also re-checks `this`); NOBJ-10 (lens 3: groupBy's
1M cap truncates silently).

### NOBJ-4 — Dense splice and the `toString` fallback do O(n) work for an O(1) charge (high)

(a) The dense `splice` path snapshots all `length` elements, builds a new vector, clears the
BTreeMap and re-inserts every element even when the tail is empty, charging only
`deletions × 10 + tail_len × 10` plus constants; XS moves only the tail.
Used as `pop`, its host time per computron grows without bound with the array length.
(d) `Array.prototype.toString` with a non-callable `join` walks the whole `functions` table to
rediscover `%Object.prototype.toString%` on every call, so its cost scales with the number of live
closures.
Parts (b) and (c) are written once under MEM-5.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:4975-5046` (charges at
`:4981-4999`); `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2448-2454` (same pattern at
`natives/collection.rs:248-254`).

**Evidence:** table rows; `../probes/verify/vm-natives-objects/n4a_splice_200k_x200.js` takes
9.06 s against 0.21 s for the push-only control `n4a_push_200k_only.js`;
`n4d_tostring_60000.js` takes 3.99 s against 0.045 s with no closures.

**Fix:** Splice in place, moving only tail keys (or adopt contiguous storage, MEM-6); cache the
`%Object.prototype.toString%` slot at boot.

**Also:** same defect MEM-5 (parts b and c); MEM-6 (lens 4: BTreeMap storage aggravates (a)).

### NVAL-1 — `includes` is an uncharged O(n·m) search; `indexOf` charges 1/65,536 per unit (high)

`includes` charges one fixed tick and then runs a naive `(from..=len - m).any(all(...))` scan
with no charge and no meter check; the code comment says "the search runs unmetered".
`indexOf` and `lastIndexOf` use the same algorithm and call `charge_and_check(1)` per matched unit,
but the argument is a raw 16.16 unit, about four orders of magnitude below the work.
The comment frames this as XS fidelity, which `README.md:5-21` rejects as a goal.
A host meter cannot interrupt the call: with the meter armed at 20,000 computrons, `includes`
completes at 15,047 after 2.86 s, while a control loop aborts in 0.7 ms.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/string.rs:434-451` (includes),
`:459-535` (indexOf, lastIndexOf); `rust/engine/ironhorse-vm/src/interp/admission.rs:84-95`.

**Evidence:** `../probes/verify/vm-natives-values/n1_includes.js`:

```js
const h = 'a'.repeat(40000); const n = 'a'.repeat(20000) + 'b';
if (h.includes(n)) throw new Error('found?');
```

IronHorse 2.45 s, Node 0.04 s; computrons from `zz_audit_verify_nval_1.rs` in the table.

**Fix:** One linear-time search helper (Two-Way or `memmem` over the stored payload with an
alignment check) shared by `includes`, `indexOf`, `lastIndexOf`, `startsWith` and `endsWith`,
charged per scanned unit with `charge_builtin_work` in bounded batches; fix the comment.

**Also:** same root NVAL-2, NVAL-13, NVAL-15.

### NVAL-2 — BigInt `*`, `/`, `%` and decimal conversion: quadratic work, linear charge (high)

`bigint_arith` decodes both operands, runs schoolbook multiplication or bit-serial division (one
allocating subtract per quotient bit), and only then ticks a charge linear in the result, with no
host check.
`String(bigint)` renders in O(n²) for one builtin tick plus the output chunk, while
`x.toString()` is charged about 79.5M computrons for the same digits; `BigInt(string)` and
BigInt-to-string comparisons parse in O(d²) and charge only the result.
`**`, `<<` and `asIntN`/`asUintN` refuse results above 64 Ki bits with an uncatchable `Refused`
whose comment says it keeps one opcode from monopolizing the host, but `*` has no cap: five
squarings from 10n ** 15000n reach 1.59M bits in 64 s.
An armed meter at 12,000 computrons let a BigInt program finish at 36,607: straight-line BigInt
code reaches no check point.

**Where:** `rust/engine/ironhorse-vm/src/interp/bigint.rs:97-113`, `:118-153`, `:351-378`,
`:428-474`; `rust/engine/ironhorse-vm/src/interp/natives/bigint.rs:438-491` (charge after work),
`:233,264` (asN cap), `:308,338-349` (`**` cap), `:628` (shift cap);
`rust/engine/ironhorse-vm/src/interp/strings.rs:206-212`;
`rust/engine/ironhorse-vm/src/interp.rs:3672-3708` (`bi_to_radix`).

**Evidence:** table rows (`../probes/verify/vm-natives-values/zz_audit_verify_nval_1.rs`);
`n2_mulbig.js` (`var a = 10n ** 15000n; var b = a; for (var i = 0; i < 5; i++) b = b * b;`)
completes after 64.1 s; `n2_pow_catch.js` shows `10n ** 20000n` halts
`Refused("exponentiation:result-too-large")` inside `try`.

**Fix:** Precharge an estimate with `charge_and_check` before the work (|a|·|b| limb products for
`*`, (|a|-|b|+1)·|b| for `/` and `%`, d²/9 for decimal parse and render); replace bit-serial
division with Knuth's Algorithm D; route `String(bigint)` and `toString(10)` through one renderer
with one charge; apply one size policy to every BigInt-producing operation and make the limit a
catchable RangeError (see NVAL-9).

**Also:** same root NVAL-1, NVAL-15; NVAL-9 (the caps' classification).

### RGX-5 — Every exec re-decodes and re-encodes the whole subject without charging it (high)

On every exec, `regexp_exec_inner` copies the subject out of the chunk arena and re-encodes it
into a fresh CESU-8 buffer plus a code-unit-to-byte offset map; `reserve_scratch` admits that
memory but charges no computrons.
Each exec is billed a fixed amount whatever the subject length, so global operations that exec
once per match are O(n·m) in time for a linear charge: `match(/a/g)`, `split(/,/)` and
`replace(/a/g)` over 32,000 characters take 1.0, 2.1 and 1.0 s against about 0.05 s in Node, and
quadruple when the input doubles.
`matchAll` is worse: each `next()` also materializes the subject as a new chunk-arena string, so
`'ab'.repeat(16000).matchAll(/a/g)` produces about 1 GB of garbage subject copies and halts
`HeapExhausted`.
XS does none of this, because its strings are already in the matcher's encoding.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1041-1053`
(`regexp_exec_inner`), `:1008-1034` (`regexp_subject_bytes`), `:946-990`
(`regexp_string_iterator_next`).

**Evidence:** `../probes/verify/regexp/zz_audit_verify_3.rs`: `len=16: computrons/exec=34
wall/exec=2.454µs`, `len=4194304: computrons/exec=34 wall/exec=27.01315ms`;
`../probes/verify/regexp/m1.js` (200 sticky tests on `'b'.repeat(1<<22)`) 5.41 s against 0.01 s
for a 16-character subject; `../probes/regexp/p07_matchall_16000.js` halts `HeapExhausted`.

**Fix:** Make per-exec cost independent of subject length: cache the encoded subject and offset
map keyed by the subject's chunk identity (or keep them in the global-loop drivers and the
iterator state), resume the matcher from a byte offset, and pass the iterator's existing string
slot instead of re-creating it.
Until then, charge the decode and encode per element.

**Also:** RGX-1 (the other uncatchable `HeapExhausted` on benign RegExp input); same root MEM-1
(the matchAll garbage).

### BOOT-3 — Each novel runtime string key runs an unmetered whole-roster install pass (high)

`resolve_at_key` interns a novel computed string key and then calls `install_pending_intrinsics`,
which for a one-name suffix still walks every boot roster: it clones the method, data and accessor
rosters, does a `SymbolIds::get(&str)` per roster entry (each allocating two vectors and
SipHashing), evaluates about 40 dependency gates, and scans the whole `functions` map (guest
closures included) to find `%TypedArray%`.
The meter charges only the new name's slot.
The work is capped per machine because the u16 key space saturates near 64,400 novel keys (then a
catchable RangeError) and names persist; pass 2 measured that cap as 8.24 s of stall, or 54 s
with 150,000 closures live, inside a crank charged less than the same number of index stores.

**Where:** `rust/engine/ironhorse-vm/src/interp/property/keys.rs:530-539` (also `:659-676`,
`:748-756`); `rust/engine/ironhorse-vm/src/interp/link.rs:1502-1511`, `:384-830` (roster clones
`:576,680,699,818`; `functions.iter().find_map` `:566`);
`rust/engine/ironhorse-vm/src/symbols.rs:24-26`; `rust/engine/ironhorse-text/src/lib.rs:107-110`.

**Evidence:** `../probes/verify/vm-boot-realm-modules/zz_audit_verify_2.rs`: `index_keys_20k
seconds=0.022 computrons=522703`, `novel_computed_keys_20k seconds=2.855 computrons=470300`,
`fns_50k_then_novel_keys_20k seconds=9.489`; callgrind on `v3_novel_keys_1k.js` attributes 98% of
instructions to `install_pending_intrinsics`, 87% to `SymbolIds::get`, 70% to
`SymbolName::from(&str)`.

**Fix:** Index the rosters by name so a k-name suffix costs O(k × members per name); cache boot
identities in fields; make `SymbolIds` lookup allocation-free (`Borrow<[u8]>` on `SymbolName`);
longer term, the fault-in design removes the per-key pass.
Until then, charge the pass so wall time tracks computrons.

**Also:** same root BOOT-1, BOOT-2, BOOT-4, PROP-4 (lazy intrinsic installation); BOOT-5.

### PROP-3 — A delete on a long chain rebuilds the property index: O(N) unmetered per op (high)

`SlotArena::find_property` scans 8 chain nodes, then `PropertyIndex::find` rescans up to 32 from
the head and, on a miss, collects the entire chain and publishes an index (a hash map per owner
plus a watched entry with its own `HashSet` per node).
`delete o[k]` changes the predecessor's link and frees the node, and both routes drop the whole
owner index, so the next miss on the object (the create in `o[k] = v`) rebuilds all N entries;
unlike the hit path, the rebuild has no throttle.
`delete_own_property` meters only its dispatch.
Neither XS nor IronHorse charges chain length, but the rebuild multiplies the inherited O(N) walk
by about 230×, and the LRU/queue idiom `delete o[k]; o[k] = v` reaches it.
An indexed object also costs about 234 B per property against about 49 B un-indexed.

**Where:** `rust/engine/ironhorse-vm/src/property_index.rs:66-82` (free), `:85-100` (synchronize),
`:152-158` (`Walk::End` rebuild), `:14-18`; `rust/engine/ironhorse-vm/src/value.rs:1325-1350`,
`:1285`; `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:1048-1137`.

**Evidence:** `../probes/prop/del/queue_8000.js` (JSON.parse of 8,000 keys, then 4,000 ×
`delete o[ks[i]]; o[ks[i]] = i`) takes 10.66 s and `queue_16000.js` 20.96 s; the overwrite
control `../probes/verify/vm-property-model/p3_ctrl_8000.js` takes 0.19 s and the 30-key
`p3_small_delete.js` 0.086 s; Node about 50 ms.

**Fix:** On a change to one watched node, unlink just that name from the owner's map instead of
dropping the owner; throttle `Walk::End` rebuilds like `Walk::Found`; replace per-node watched
sets with a compact per-owner table validated by a generation; charge chain walks beyond the
linear prefix.

**Also:** PROP-10 (low, lens 4: SipHash dominates the rebuild).

### NOBJ-5 — Default `sort` copies both operands' strings on every comparison (medium)

With no comparator, `array_compare_elements` calls `to_string_units` on both operands for every
merge-sort comparison and compares the resulting vectors, so each comparison allocates and copies
two whole strings; the only charge is `length × BUILTIN_METERING` up front.
Pass 2 lowered this from high: length-proportional string comparison is uncharged everywhere in
the engine (`<`, `===`, comparator sorts), as in XS, so the unbounded ratio is engine-wide;
what this site adds is a 20-30× constant factor (the same data sorts in 0.098 s with a comparator
doing two comparisons per call, against 2.06 s by default).
The spec does call ToString per comparison, which is observable only for objects.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4275-4277`, `:4284-4331`; charge
at `:4548`.

**Evidence:** table row; `../probes/verify/vm-natives-objects/n5_longstr_var_<n>.js` takes 0.92 /
1.79 / 4.36 s at 1,000 / 2,000 / 4,000 elements, with peak RSS flat at 10.9 MB.

**Fix:** Compare stored primitive strings in place; for other primitives compute the string once
per element; keep the per-comparison ToString only for objects.

### CORE-10 — UNWIND and CATCH cost O(frame bindings) for one metered dispatch (medium)

XS's `UNWIND n` touches n scope slots.
IronHorse's truncates `locals` and then runs `HashMap::retain` over the whole per-frame `id_map`,
which is O(all named bindings in the frame); inside a `try`, `CATCH` stores an `Rc` clone of the
map, so the next binding insert or unwind deep-clones it.
Both are charged as one dispatch.
The frame size is bounded by the 16-bit id space and by code size, so the amplification per
dispatch is bounded at roughly 10^5 to 10^6 instructions: a metering-precision hole and a
performance cliff rather than an unbounded bypass.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:443-451` (UNWIND), `:4628-4641`
(CATCH), `:1579` (`NEW_LOCAL`).

**Evidence:** callgrind on `../probes/verify/vm-core-dispatch/c10_big_<n>.js`
(`var v0,...,v19999;` then a loop with `{ let x = i; s = s + x; }`): 279,087 instructions per
iteration against 3,073 for one binding (`c10_small_<n>.js`).

**Fix:** Remove `id_map` (CORE-7); short of that, keep names in a stack-ordered vector so UNWIND
truncates by range, and store only `locals_len` in the catch record.

**Also:** CORE-7, FN-11 (lens 4: the same `id_map` costs every call).

### CMP-5 — Cover-grammar conversions deep-clone subtrees per level, uncharged (medium)

When the parser converts a parenthesized or array/object cover into a reference or binding
pattern, each level clones the subtree below it before deciding, and `check_strict_binding`
clones every pattern list it visits.
A cover d levels deep around n nodes therefore costs O(d·n) host work while the meter charges the
O(n) tokens; the nesting budget bounds d near 90 levels, which caps the amplification at about 30×.

**Where:** `rust/engine/ironhorse-compile/src/parser.rs:821-850` (clone at `:826`);
`rust/engine/ironhorse-compile/src/parser/stmt.rs:1254-1275` (`:1260`), `:1384-1412`,
`:1614-1645`, `:1783-1796`.

**Evidence:** `../probes/verify/compile/gen5.js` generates `cover_assign_<d>.js` and
`pattern_arrow_<d>.js` around a 150,001-element array: paren depth 0 / 85 compile in 0.265 /
1.120 s, arrow-pattern depth 1 / 80 in 0.231 / 6.726 s, with token counts within 170.

**Fix:** Move rather than clone (`std::mem::take`); check then convert so no fallback copy is
needed; walk patterns by reference; failing that, charge `work(size)` per copy.

**Also:** CMP-2 (uncharged compile memory); CMP-8 (lens 3: the nesting caps exist partly because
these conversions recurse).

### BOOT-4 — Every computed string-key operation runs the global catch-up scan (medium)

`install_pending_intrinsics` always finishes with `missing_environment_global_bindings()`, even
when the name table has not grown: it iterates every standard global name and probes
`SymbolIds::get(&str)`, which allocates two vectors and hashes, then sorts and dedups.
`resolve_at_key`, `to_read_key` and `to_property_id` call it for every non-index computed string
key, so `o[k]`, `k in o`, `Reflect.get`, `Object.hasOwn(o, 'a')`, `defineProperty` and per-key
`Object.keys` conversion all pay it; `s += o[k]` costs about 9.2 µs against 0.15 µs for
`s += o.alpha`, for about 2 extra computrons.
The verifier of the PROP-4 report showed that a simple floor guard is not enough: the second half
is unguarded on purpose because per-environment global bindings can be missing while the
machine-wide floor has advanced (compartments).

**Where:** `rust/engine/ironhorse-vm/src/interp/link.rs:313-335`, `:1502-1537` (called
unconditionally at `:1522`); `rust/engine/ironhorse-vm/src/interp/property/keys.rs:539,676,755`;
`rust/engine/ironhorse-vm/src/symbols.rs:24-26`.

**Evidence:** `../probes/verify/vm-boot-realm-modules/zz_audit_verify_2.rs`: `static_reads_200k
seconds=0.229 computrons=4300049`, `computed_reads_200k seconds=2.226 computrons=4900057`;
callgrind on `../probes/verify/vm-property-model/p4_cg.js`: 94.8% of instructions under
`install_pending_intrinsics`, 64.9% in `SymbolName::from(&str)`.

**Fix:** Keep a per-environment "catch-up needed" flag (or generation) set when a standard-global
name is interned or an environment is created or relinked, and skip the scan when clear;
pre-resolve the intrinsic name ids once; make `SymbolIds::get` allocation-free (BOOT-3).

**Also:** same mechanism PROP-4 (reported independently from the property-model region); same root
BOOT-3.

### BOOT-5 — Crank relink cost grows with the never-shrinking name table (medium)

`relink_crank` takes its aligned fast path only when the crank's names equal the whole machine
table.
Otherwise it clones `symbol_names` and resolves each crank name with a linear `position`, O(N·M);
if the table grew, it then runs `bind_program_symbols`, which copies the table again and
re-inserts every name.
Runtime-interned names are permanent and cheap to mint (20,000 `JSON.parse` keys take about
0.07 s), so every later crank of that machine pays this unmetered work before guest code runs.
The doc comment still describes a refusal the code no longer has.

**Where:** `rust/engine/ironhorse-vm/src/interp/link.rs:1403-1419`, `:1457`, `:20-71`; stale doc
`:1370-1376`.

**Evidence:** `../probes/verify/vm-boot-realm-modules/zz_audit_verify_2.rs`: growing and reusing
relinks take 0.27 / 0.02 ms with no runtime keys, 7.21 / 0.56 ms at 10,000, and 40.53 / 2.22 ms
at 50,000.

**Fix:** Resolve crank names through `symbol_ids` (O(M) lookups); append novel names
incrementally through `append_name_key`; keep `bind_program_symbols` for restore only; fix the
doc comment.

**Also:** same root BOOT-3; NOBJ-1, PROP-2 (other drains on the same table); BOOT-9 (low).

### COV-6 — Closure-capture append is O(k²) host work for O(k) computrons (medium)

`store_closure` and `append_environment_capture` (the latter for arrow `this`/`new.target`
captures and direct-eval `var` hoisting) charge one slot allocation per captured binding and then
walk the environment's capture chain to its tail in an unmetered loop, so a closure that captures
k bindings costs k(k−1)/2 slot reads for a charge linear in k.
XS has the same walk, but the meter's design chose accuracy over XS parity, and a tail pointer
fixes it host-side without changing a computron; CMP-11's 65,534-name cap bounds k, which keeps
this at medium.

**Where:** `rust/engine/ironhorse-vm/src/interp/environment.rs:566-595`, `:603-623`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:3075-3082`, `:3108-3118`.

**Full entry:** `../COVERAGE.md` (primary lens: memory and performance); evidence
`../probes/coverage-review/lost-content/capture_k125.js` and its `capture_k*.js` siblings.

## Uncatchable halts where JavaScript expects an exception

A `Halt` ends the whole crank, and no guest `try`/`catch` observes it.
That is the right outcome for crank-level resource exhaustion, but several limits that ordinary
programs reach are reported this way where engines throw a catchable error (usually RangeError)
or simply succeed.
The common fix is one rule, enforced in `rust/engine/ironhorse-vm/src/halt_labels.rs`: an
implementation limit a single operation can reach becomes a catchable error; halts are reserved
for the meter, the ceilings and frame-depth exhaustion.

### RGX-1 — Long greedy matches and huge quantifier bounds halt the machine uncatchably (high)

The backtracking matcher saves one state per position matched by an unbounded greedy quantifier
(after the first iteration of `+` too), and `save_captures` refuses the 65,537th retained state
(or more than 64 MiB); the VM turns that into `Halt::HeapExhausted`, though the heap is not
exhausted.
Ordinary successful matches over long subjects therefore stop the machine: `/a*/` on 65,536 `a`s,
`/(?:a|b)*/` on 32,768 characters (two states per character), `/^(.*)$/` on an 80,000-character
line, `"x".repeat(100000).replace(/x+$/, "")`, extracting a 70,000-character JSON string value with
`/"k":"([^"]*)"/`, splitting front matter from a 100 KB document, or validating 100,000 characters
of base64 with `/^[A-Za-z0-9+\/]*={0,2}$/`.
A second path ends the same way: the pattern parser returns `ResourceLimit` for a quantifier bound
above 0x7FFFFFFF, so `new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}")` halts at construction,
where the spec requires a pattern that compiles and fails to match and XS clamps the bound
(`xsre.c:1666`).
XS and Node complete every case; XS's matcher has no state count cap.

**Where:** `rust/engine/ironhorse-regexp/src/matcher.rs:127` (`MAX_MATCH_STATES = 65_536`),
`:152-174`, push sites `:339,563,647,686`;
`rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:556-558`;
`rust/engine/ironhorse-regexp/src/compile.rs:2221-2223` with `natives/regexp.rs:348-349`.

**Evidence:** `../probes/regexp/p32_catch_ceiling.js`:

```js
let caught="no"; try { /a*/.exec("a".repeat(100000)); } catch(e){ caught="caught "+e.name; } throw new Error(caught);
```

IronHorse: `InternalError: ironhorse halted: HeapExhausted` (the handler does not run); Node:
`Error: no`.
`../probes/regexp/p04_thresh_65535.js` returns 65535; `p04_thresh_65536.js` halts;
`../probes/verify/regexp-pass2/a5.js` (JSON value) and `pass2_b64.js` under
`../probes/verify/test262-harness/` halt where Node returns.
All 452 `ironhorse-aborted-limit` cases in the sweep are this defect (904 rows): 444
`built-ins/RegExp/property-escapes/generated`, 4 `unicodeSets/generated`, 3 `CharacterClassEscapes`
positive cases, and `quantifier-integer-limit.js` (the compile-time path).
The XS oracle completes them
(`../probes/verify/test262-harness/mini262/test/probe/regex-70k-xsonly.js`).

**Fix:** Do not report a deterministic matcher or compiler ceiling as a machine halt: throw a
catchable error, or bound the matcher by the meter and heap ceiling as XS bounds it by memory.
Add a fast path for a greedy loop over a single-character atom with no captures (record the
iteration count and back off by decrementing), share one capture snapshot between states, and
clamp quantifier bounds above 2^31-1 as XS does.

**Also:** same defect T262-7; RGX-5 (matchAll's `HeapExhausted` has a different cause); MEM-1.

### FN-10 — User calls halt uncatchably above ~2,025 arguments; native calls take millions (medium)

`enter_call` evaluates `would_overflow(FRAME_OVERHEAD_SLOTS + argc)` before truncating the pending
call tuple off the value stack, but the slots already in use include those `4 + argc` slots, so
the arguments are counted twice against the 4,064 usable slots (the comment calls this a
deliberate conservative over-count).
Any user-function call with more than about 2,025 arguments (`f.apply(null, a)`, `f(...a)`) is
`Halt::StackOverflow`, which no `try` observes, where engines raise a catchable RangeError much
later.
Native callees take no check at all (CORE-5), so the limit is both too tight and inconsistent.

**Where:** `rust/engine/ironhorse-vm/src/interp/frames.rs:347-350`, `:13-15`, `:29-31`.

**Evidence:** `../probes/verify/vm-functions-async/v10_apply_2030.js`:

```js
function f(){return arguments.length} var a=[]; for (var i=0;i<2030;i++) a.push(i); var r; try { r = f.apply(null,a); } catch (e) { r = "caught " + e; } throw new Error("argc=2030 => " + r);
```

IronHorse: `InternalError: ironhorse halted: StackOverflow(8)`; Node: `Error: argc=2030 => 2030`.
2,000 and 2,020 arguments work.
`../probes/verify/vm-functions-async/p31_native_apply_huge.js`:
`Math.max.apply(null, {length: 3e6})` completes at 143.3 MiB, where Node throws RangeError.

**Fix:** Count pending arguments once; apply the same budget before pushing a native call's
argument list; raise a catchable RangeError for argument-list overflow and keep the halt for true
frame-depth exhaustion.

**Also:** CORE-5, FN-3 (native argument lists are unbounded); FN-14, FN-18 (lens 3: other depth
halts).

### NVAL-13 — JSON nesting beyond 2,048 levels halts uncatchably despite heap stacks (medium)

`JSON.parse` and `JSON.stringify` keep explicit heap-allocated frame stacks, yet each nesting level
still charges one unit of the shared 2,048-unit native recursion budget, and exceeding it is
`Halt::ReentryLimit`.
`JSON.parse` of untrusted text with 3,000 nested brackets therefore kills the crank: a 6 KB peer
message halts a service that parses it.
`JSON.stringify` also materializes each container's text in its own vector and copies it into the
parent, so a payload at depth d is copied d times while only punctuation is charged (table row in
the meter section).

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1323-1331` (parse),
`:828-840` (stringify), `:1213-1251` (per-level copy); `rust/engine/ironhorse-vm/src/interp.rs:409`.

**Evidence:** `../probes/verify/vm-natives-values/n13_deep_catch.js`:

```js
try { JSON.parse('['.repeat(3000) + ']'.repeat(3000)); } catch (e) { throw new Error('caught ' + e.name); }
throw new Error('ok');
```

IronHorse: `InternalError: ironhorse halted: ReentryLimit { depth: 2049, limit: 2048 }`; Node:
`Error: ok`.
`n13_str.js` (stringify of a 3,000-deep array inside `try`) halts the same way.

**Fix:** Give JSON its own depth budget that throws a catchable RangeError, or none, since the
stacks are heap-allocated and admitted; serialize into one output buffer and charge per unit
copied.

**Also:** NVAL-9 (classification); same root NVAL-1, NVAL-2 (work not charged in proportion).

### NVAL-9 — One "too large" or "not modelled" condition is classified five ways (medium)

There is no single rule deciding whether an implementation limit or profile gap becomes a
catchable spec-shaped error, an uncatchable halt, or a silently wrong value.
`padStart`/`padEnd` above 2^24 units and `String.raw` above 2^24 segments are `Halt::Refused`,
while `repeat` of the same size succeeds and `repeat` beyond 2^31-1 is a catchable RangeError;
`repeat(2**28)` is `HeapExhausted` where engines throw RangeError; BigInt result caps
(`**`, `<<`, `asIntN`/`asUintN` above 64 Ki bits) are `Refused`; JSON depth is `ReentryLimit`;
`NumberFormat.prototype.formatRange` and non-English compact notation are `NotImplemented`;
an unmodelled time zone or calendar is a catchable RangeError worded as invalid input; and
unmodelled locale data is silently formatted as English.
`intl.rs:1298-1314` states the intended doctrine and admits the file violates it elsewhere.

**Where:** `Refused`: `rust/engine/ironhorse-vm/src/interp/natives/string.rs:148-151,741-746`,
`rust/engine/ironhorse-vm/src/interp/natives/bigint.rs:264-265,338-349,638-640`,
`rust/engine/ironhorse-vm/src/interp/natives/json.rs:664-667,1045-1046`.
Catchable RangeError: `natives/string.rs:603-608`,
`rust/engine/ironhorse-vm/src/interp/admission.rs:128-130`.
`HeapExhausted`: `admission.rs:131-133`.
`NotImplemented`: `natives/dispatch.rs:3152-3154`, `natives/intl.rs:1316-1319`,
`natives/temporal.rs:1780-1782`.
"Unsupported" RangeError: `natives/intl.rs:454-456` and the Temporal calendar and zone sites.

**Evidence:** `../probes/verify/vm-natives-values/n9_tmp.js` variants, each inside `try`:
`'abc'.padStart(2**25)` halts `Refused("String.prototype.pad:result-too-large")` (Node returns a
33,554,432-unit string); `'abc'.repeat(2**28)` halts `HeapExhausted` (Node: caught RangeError);
`new Intl.NumberFormat('en').formatRange(1, 5)` halts
`NotImplemented("Intl.NumberFormat:formatRange")` (Node: `1–5`); `10n ** 20000n`, `1n << 70000n`
and `BigInt.asUintN(70000, -1n)` halt `Refused`;
`new Intl.DateTimeFormat('en', {timeZone: 'Europe/Kyiv'})` throws a catchable "invalid or
unsupported timeZone".
`n9_cmp.js`: `'a'.repeat(2**25)` succeeds, then `''.padStart(2**25, 'a')` halts.

**Fix:** Define one taxonomy in `halt_labels.rs`: size limits become catchable RangeErrors through
`reserve_units` with one shared limit; unmodelled features are `NotImplemented` everywhere,
including Temporal zones and calendars and Intl locale data; silent approximation is not allowed.
Add a test that each label maps to exactly one class.

**Also:** NVAL-2, NVAL-6, NVAL-8, NVAL-13; BOOT-9 (low: key-space exhaustion classified four ways).

### CMP-3 — Class static blocks: declarations halt through `eval`; blocks share one scope (medium)

The scoper hoists every static field initializer and static-block body of a class into one
synthesized `constructorInit` function scope.
If that scope holds a declaration written directly in a static block (`let`, `const`, `var`,
`function`, `class`), the coder reports `Unsupported`, which the VM turns into
`Halt::NotImplemented("eval:compiler-unimplemented")` on the `eval`, `Function` and
`Compartment.evaluate` paths; at the `ironhorse-xst` top level it prints InternalError.
Because blocks share a scope, two blocks that each declare the same name fail earlier with a
spurious catchable `SyntaxError: duplicate variable`; ECMA-262 gives each ClassStaticBlock its own
function-like environment.
A static block that wraps its declarations in an inner `{ }` compiles correctly.
Downgraded from high: this is a refusal of an ES2022 feature with plausible users (libraries and
TypeScript output targeting ES2022), not a panic or a silently wrong result.

**Where:** `rust/engine/ironhorse-compile/src/coder.rs:3552-3568`;
`rust/engine/ironhorse-compile/src/scoper.rs:803-833`, `:1373-1376`;
`rust/engine/ironhorse-vm/src/interp/eval.rs:117-121`.

**Evidence:** `../probes/compile/v2/static_eval.js`:

```js
var r;
try { r = eval("class C { static { let x = 1; C.y = x; } } C.y"); } catch (e) { r = "caught " + e.name; }
throw new Error("result=" + r);
```

IronHorse: `InternalError: ironhorse halted: NotImplemented("eval:compiler-unimplemented")`; Node:
`Error: result=1`.
`v2/static_blocks.js`: `two-let=SyntaxError:duplicate variable a` where Node gives `ok`.
test262: three `language/statements/class/static-init-scope-*` files are `parse-or-decode` and
`static-init-scope-lex-open.js` is an ironhorse-failure.

**Fix:** Give each static block its own function-kind scope chained under the class scope and code
it like a method body, keeping static field initializers in `constructorInit`.
Until then report the refusal as a catchable SyntaxError.

**Also:** CMP-6 (the scope model merges environments the spec keeps apart); T262-6 (low: the
harness files the refusal as `parse-or-decode`).

**Related halts whose primary lens is lens 3, skipped features and aborted conditions** (one line
each):

- FN-13 (same defect NOBJ-10), medium: hard 1,000,000-element caps in Promise combinators,
  IterableToList, collection constructors, `Array.from`, `TypedArray.from`, iterator helpers and
  `Object.fromEntries` halt with `StepLimit` (documented as the bounded-run harness ceiling), and
  `groupBy` silently truncates at 1,000,000 without closing the iterator.
- FN-14, medium: async nesting deeper than 126 levels, or `yield*` recursion 50-70 levels deep,
  halts `ReentryLimit`; the fix (C5 in `STACK-DEPTH-REFACTOR.md`) is deferred.
- NOBJ-11, medium: thirteen `1 << 24` "oversized array-like" caps halt `Refused` on sparse real
  arrays (`a.length = 2**25; a.sort()`), and sort reserves O(length) scratch before reading.
- NOBJ-13, medium: symbols as weak keys are a catchable TypeError on method paths but a `Refused`
  halt in the WeakMap/WeakSet constructors, even for registered symbols, where the spec requires
  TypeError.
- T262-4 (same defect NOBJ-14), medium: `Atomics.wait`, `notify` and `waitAsync` halt `Refused`
  before any validation, including spec outcomes that never block (`notify` on a non-shared
  array returns 0).
- FN-18, low (same defect T262-8, medium): no proper tail calls, so strict tail recursion halts
  `StackOverflow` near 4,058 frames where XS runs in constant stack, and the harness pre-skips the
  35 tail-call test262 files.
- CMP-8, medium: deterministic nesting caps refuse valid flat chains past about 2,040 terms and
  nests past 89-90 cascade levels; these are catchable SyntaxErrors, so they are a refusal, not
  this class.

## Wrong guest-visible results

How these defects show up in test262 is measured in
[`test262-conformance.md`](test262-conformance.md).
One harness finding bears on reading those numbers: T262-1 (medium; primarily the test262 lens)
shows that the harness's categories track agreement with XS rather than test262's own verdict, so
the published ironhorse-failure count (1,064 files) understates IronHorse's failures several-fold.
`ironhorse-xst` does not surface errors thrown in promise jobs, so async results below were read
out with a binary-search oracle or a Rust probe; Node 22 lacks Temporal, `AsyncDisposableStack`
and `using`, so those comparisons are against the spec text.

### Language and async semantics

### CORE-2 — `for await` and async `yield*` lack CreateAsyncFromSyncIterator (high)

For `for await`, `dispatch_for_of` reads only `@@asyncIterator`; when that is absent it never
reads `@@iterator`.
It hard-codes four built-in shapes (an Array, a String, a Map or Set, a generator) and pushes the
raw synchronous iterator with no async-from-sync wrapper, and anything else, including a user
object whose only protocol is `[Symbol.iterator]`, gets `TypeError: call: not a function`.
The compiled loop awaits the step object but not its value, so `for await (const x of
[p1, p2])` binds the promise objects, a rejected element is not thrown into the loop, and the
per-element await ticks are missing, which reorders interleaving with other jobs.
`yield*` over a synchronous iterable inside an async generator fails the same way.
`for await (const r of urls.map(fetchLike))` is the canonical idiom; the comment at
`iteration.rs:73-74` says each value is awaited, and it is not.
XS implements the wrapper, and the oracle passes the affected test262 cases.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:7-167` (`@@asyncIterator`
only at `:18-22`; fallback `:73-101`; built-in shapes `:102-165`);
`rust/engine/ironhorse-vm/src/interp/natives/promise.rs:941-956` (the `yield*` stand-in).

**Evidence:** `../probes/verify/vm-functions-async/p03b_for_await_sync_each.js` (an array, a
generator, a custom iterable and a Set, each yielding one promise; then a plain array): IronHorse
`["obj","obj","custom threw TypeError: call: not a function","obj","e"]`; Node
`["a","b","c","d","e"]`.
`../probes/verify/vm-core-dispatch/c2_order.js` (`for await (var x of [Promise.resolve(1), 2])`
beside a five-step `then` chain): IronHorse
`["fa-[object Promise]","p1","fa-2","p2","fa-end","p3","p4","p5"]`; Node
`["p1","fa-1","p2","p3","fa-2","p4","p5","fa-end"]`.
test262: about 115 failing files (29 `built-ins/AsyncFromSyncIteratorPrototype`, 36
`yield-star-sync-{next,return,throw}`, 48 `yield-star-getiter-*sync*`, 2-3 `for-await-of` tick
tests), 103 of them with reason `call: not a function`.

**Fix:** Implement `%AsyncFromSyncIteratorPrototype%` (next, return and throw with
AsyncFromSyncIteratorContinuation, which awaits the value and closes the sync iterator on
rejection) by transliterating XS's `fxNewAsyncFromSyncIteratorInstance`, and make `for await` and
async `yield*` call GetIterator(obj, async), which reads `@@asyncIterator` and then `@@iterator`.
Keep the built-in shapes only as a fast path guarded on the intrinsic `@@iterator` being in place;
fix the comment.

**Also:** same defect FN-1; FN-5 (the for-await constructor-lookup tick tests share the await
path).

### NOBJ-8 — `disposeAsync` neither awaits disposers nor propagates their rejections (high)

`disposeAsync` pops each record and calls its disposer synchronously through
`run_callback_catching_throw`, collecting only synchronous throws; the promise an async disposer
returns is ignored, and the result promise is created and settled right after the loop.
Spec DisposeResources awaits each disposer's result before calling the next and folds rejections
into the completion (a SuppressedError when several).
So disposers run interleaved rather than in sequence, `disposeAsync` settles before cleanup
finishes, and a rejection from an async disposer is silently lost.
`await using` declarations do not share this path.
Pass 2 kept high: awaiting async disposers is the main purpose of this method, though adoption of
the feature is still small.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/resource.rs:213-267`.

**Evidence:** Rust probe `c_async_dispose_awaits` in
`../probes/verify/vm-natives-objects/zz_audit_verify_1.rs` (output `rust_verify1.out`), two
deferred async disposers where b rejects after an await: log
`[b-start, a-start, sync-after, b-end, settled, a-end]`, promise fulfilled; spec order
`[b-start, sync-after, b-end, a-start, a-end, settled]`, rejected with `boom`.
test262: 2 ironhorse-failure files and 1 unsupported under
`built-ins/AsyncDisposableStack/prototype/disposeAsync`.

**Fix:** Implement async disposal as a resumable job chain (an internal async state machine, or
the resumable mechanism `Array.fromAsync` uses) that awaits each result, accumulates errors into
SuppressedError and settles at the end; add ordering and rejection regressions.

**Also:** NOBJ-9 (the same feature's `disposed` accessor).

### COV-1 — `new` on a bound cross-segment target runs the caller's bytes (high)

`enter_construct_bound` enters a bound function's bytecode target in place without the
active-segment check that every other in-place entry makes, so `new B()` continues the caller's
code buffer at the target's offset whenever B's target came from `eval`, `new Function`,
`Compartment.prototype.evaluate` or an earlier crank, the normal case for a long-lived vat.
The result is an uncatchable halt (such as `StackOverflow`, `ReentryLimit`, `EngineInvariant` or
`Decode(ProgramCounterOutOfBounds)`) that leaves the machine non-quiescent and unable to
checkpoint, or the wrong bytes running as guest code; `Reflect.construct(B, [])` and same-segment
`new` are correct.

**Where:** `rust/engine/ironhorse-vm/src/interp/apply.rs:493` (`enter_construct_bound`), `:548`
(the unguarded return); `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2721`.

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/blind-spots/bc5.js`, where
`new B().a` inside `try` halts `StackOverflow(4056)` and Node gives `3`.

### CMP-6 — With parameter expressions, a body `var` shares the parameter's binding (medium)

FunctionDeclarationInstantiation creates a separate VariableEnvironment when the parameter list
contains expressions; a body `var` with a parameter's name is then a distinct binding initialized
from the parameter, and closures in the parameter list keep seeing the parameter.
`hoist_var` adds the body-scope var only when the function scope has no argument or var of that
name, so the two are one binding: a default-parameter closure sees the body's assignment, and a
closure that assigns the parameter changes the body variable.
The code transliterates XS's `fxScopeHoistVar`, so the oracle probably shares the defect (not
measured).

**Where:** `rust/engine/ironhorse-compile/src/scoper.rs:1533-1542`.

**Evidence:** `../probes/compile/v2/pscope2.js`:

```js
var r = [];
function f1(a, b = () => a) { var a = 2; return [a, b()]; } r.push(f1(1).join("/"));
function f2(a, b = () => a) { var a; return [a, b()]; } r.push(f2(1).join("/"));
function f3(a, b = () => { a = 9; }) { var a = 2; b(); return a; } r.push(f3(1));
var f4 = (a, b = () => a) => { var a = 2; return b(); }; r.push(f4(1));
function f5(a, b = function () { return a; }) { var a = 2; return b(); } r.push(f5(1));
function f6(a, b = () => arguments[0]) { var a = 2; return b(); } r.push(f6(1));
throw new Error(r.join(","));
```

IronHorse: `Error: 2/2,1/1,9,2,2,1`; Node: `Error: 2/1,1/1,2,1,1,1`.
No test262 case is affected (its `scope-paramsbody-var-*` tests use names that are not
parameters).

**Fix:** With parameter expressions, always declare body vars in the separate body scope and
initialize each one that matches a parameter from that parameter at body entry (step 28.f.i.4).

**Also:** CMP-3 (the same scope-merging pattern).

### CMP-7 — Non-decimal literals round per digit; sloppy `08.5` and `09e1` are rejected (medium)

Hex, octal, binary and legacy 0-prefixed literals are converted by `n = n * radix + d` in `f64`,
rounding at every digit, so any literal needing more than 53 significant bits is double-rounded;
ECMA-262 defines their value as the correctly rounded mathematical value at any length.
The legacy branch reads only digits, so a NonOctalDecimalIntegerLiteral followed by a fraction or
exponent, valid sloppy DecimalLiteral syntax, is a SyntaxError.
XS accumulates the same way, so this is probably shared with the oracle.

**Where:** `rust/engine/ironhorse-compile/src/lexer.rs:874-879`, `:827-850`.

**Evidence:** `../probes/compile/numlits.js` (each literal through indirect `eval`):
`0x200000000000011` is 144115188075855870 (Node 144115188075855900);
`0999999999999999999999` is 1.0000000000000001e+21 (Node 1e+21, the only value RoundMVResult
permits); `../probes/compile/feat/legacy_decimal_fraction.js` (`08.5`) gives `SyntaxError:
missing ;` and `legacy_decimal_exp.js` (`09e1`) `SyntaxError: invalid number`, where Node accepts
both.

**Fix:** Accumulate exactly (into `u128` or limbs, or build the significand with sticky bits) and
round once; hand legacy NonOctalDecimal digits to the decimal path once an 8 or 9 has made the
literal decimal.

**Also:** CMP-9 (low: the same lexer path misses the strict re-check); NVAL-11 (the same
double rounding at run time).

### CMP-4 — `for (using ... of ...)` disposes twice and swallows disposer errors (medium)

The coder emits the disposal sequence after the loop body and again in the loop's `finally`, and
resets the disposal slot only at the top of the next iteration, so on normal completion the last
resource is disposed twice; a one-element loop disposes its only resource twice.
When a per-iteration disposer throws, the error is stored and the loop continues, so it is lost,
where the spec ends the loop abruptly and closes the iterator.
Exits by `break`, `return` or `throw` dispose once, and block, function-body and `for(;;)` `using`
are correct.
Pass 2 lowered this from high: the emission is a line-for-line transliteration of XS's
`fxCodeForInForOf` (`xsCode.c:3292,3355`), so the oracle very likely shares it and test262 does not
exercise it (its `for`/`using` cases pass), and the form is new; it still loses errors and
releases resources twice.

**Where:** `rust/engine/ironhorse-compile/src/coder.rs:2383` (per-iteration disposal), `:2452`
(again in the iterator-close `finally`), `:2495-2539`; stale "deferred" comment at `:2493-2494`.

**Evidence:** `../probes/compile/v2/using_forof.js`: IronHorse
`plain=body,dispose:a,body,dispose:b,body,dispose:c,dispose:c,after-loop,dispose:p,dispose:p`
(spec: `...,dispose:c,after-loop,dispose:p`); `using_forof_throw.js`: `disposer-throws:
body,dispose:a,body,dispose:b,dispose:b,after-loop caught=undefined` (spec: `body,dispose:a
caught=Ea`).

**Fix:** Clear the disposal slot after the per-iteration disposal (or skip the `finally` disposal on
normal completion), route a per-iteration disposer exception out of the loop through the body-throw
path, closing the iterator, and add disposal-count and propagation tests for sync and `await using`.

### FN-4 — Resolving with a native promise skips NewPromiseResolveThenableJob (medium)

In the resolve-with-thenable branch, after the observable `Get(resolution, "then")`, IronHorse
registers a pass-through reaction directly when the resolution is a native promise with the
intrinsic `then`.
The spec and XS (`xsPromise.c:742-758`) queue NewPromiseResolveThenableJob, whose later `then`
call performs SpeciesConstructor (a `constructor` read) and adds a tick.
So `resolve(p)` and `return p` from an async function settle one tick early and never consult a
`constructor` getter; the order diverges from XS, V8 and SpiderMonkey.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:718-740`.

**Evidence:** `../probes/verify/vm-functions-async/p01_job_order_resolve_promise.js`: IronHorse
`["b","a","c","d","e"]`, Node `["b","c","a","d","e"]`; `p08_adopt_species_read.js`: IronHorse
`["constructor reads=0","async-return reads=0"]`, Node `["constructor reads=2","async-return
reads=2"]`.

**Fix:** Queue the thenable job as XS does; if a native shortcut stays for cost, it must still take
a job turn and perform the `constructor` read, with the charge re-calibrated against the oracle.

**Also:** FN-5, FN-7, FN-8 (native shortcuts that take a different number of jobs than the spec).

### FN-5 — The `await` fast path omits PromiseResolve's `constructor` check (medium)

`schedule_native_await` takes its fast path whenever the awaited value has a row in `promises`, a
brand check only, while spec Await calls PromiseResolve(%Promise%, v), which reads
`v.constructor` and reuses v only when it is %Promise%.
The comment claims XS's `mxGetID(_constructor)` check, which the code does not perform.
A Promise subclass instance resumes two ticks early, a throwing `constructor` getter never throws,
and AsyncGeneratorAwaitReturn, which uses the same helper, fulfills `gen.return(brokenPromise)`
where it must reject; `Array.fromAsync` and the async-generator yield and await steps inherit it.

**Where:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:1144-1169`.

**Evidence:** `../probes/verify/vm-functions-async/p09_await_constructor.js`: IronHorse
`["await reads=0","await-subclass","t1",...]`, Node
`["await reads=1","t1","t2","await-subclass",...]`;
`p24_broken_promise.js`: IronHorse `["await fulfilled 42","gen.return fulfilled {...}",...]`, Node
`["await threw broken","gen.return rejected broken",...]`.
test262: 3 `AsyncGeneratorPrototype/return/*broken-promise*` files and
`for-await-of/ticks-with-async-iter-resolved-promise-and-constructor-lookup-two.js` fail.

**Fix:** Perform the observable `constructor` read inside `native_try`; take the fast path only
for the intrinsic %Promise%, the general path on a mismatch, and the abrupt path on a throw; fix
the comment.

**Also:** FN-4, FN-7, FN-8; FN-12 (the same function's general path).

### FN-6 — `Promise.any` with synchronously rejecting thenables reports no errors (medium)

The combinator loop seeds `remaining` at 1 and adds 1 per element.
When an element's `then` rejects synchronously, the error is recorded and the count decremented,
but the seed keeps it above zero; at iterator exhaustion the final decrement reaches zero and calls
`settle_empty_combinator`, which assumes an empty iterable and builds an AggregateError with no
errors, discarding the recorded ones.
`all` and `allSettled` are unaffected.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1768-1780`, `:1898-1922`.

**Evidence:** `../probes/verify/vm-functions-async/p10_promise_any_sync_reject.js`
(`Promise.any.call(C, [p1, p2])` with thenables that reject synchronously): IronHorse
`["rejected errors=[] isArray=true",...]`, Node
`["rejected errors=[\"e1\",\"e2\"] isArray=true",...]`.
test262: 3 failing files under `built-ins/Promise/any/`, for example
`call-reject-element-items.js`.

**Fix:** At loop exit with `remaining == 0`, settle `any` with an AggregateError over the recorded
results; keep the empty AggregateError for the empty-iterable case only.

### FN-7 — Async generator completion awaits its return value a second time (medium)

The compiled `return expr` already awaits its operand inside the body, and spec AsyncGeneratorStart
then completes the request without another Await.
On `Step::Returned`, IronHorse calls `schedule_native_await(value, AsyncGeneratorReturn)`, which
awaits again: the request settles one tick late (also for an implicit `return`), a thenable's
`then` getter is read twice, and a non-promise value allocates an extra capability (FN-12).
The same second await reaches two ordinary shapes: `break` out of a `for await` over an async
generator, and `return()` called while the generator is suspended at a `yield` (with or without
`finally`), both settle one tick late.
`return()` on a completed generator is on time
(`rust/engine/ironhorse-vm/src/interp/suspend.rs:607-612`).

**Where:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:815-846`.

**Evidence:** `../probes/verify/vm-functions-async/p29_asyncgen_return_ticks.js`: IronHorse
`["t1","g1 implicit","g2 explicit","g3 yield",...]`, Node `["g1 implicit","g2 explicit","t1",...]`.
`../probes/vm-core-dispatch/p8c.js` (`break` out of `for await`): Node logs `a5-end` after `p3`,
IronHorse after `p4`; `../probes/coverage-review/handed-off-leads/l1b_return_at_yield.js` shows the
`return()` cases (both settled by the coverage review, `../COVERAGE.md`).
test262: `language/statements/async-generator/return-undefined-implicit-and-explicit.js`,
`yield-return-then-getter-ticks.js` (`[start, tick 1, get then, tick 2, get then]` against
`[start, tick 1, get then, tick 2]`) and `yield-star-return-then-getter-ticks.js` fail.

**Fix:** On `Step::Returned`, finish the request directly with a done result; keep the await only
for `return(v)` requests made while the generator is suspendedStart or completed.

**Also:** FN-4, FN-5, FN-8; FN-12.

### FN-8 — Native `finally` settles a tick early and constructs fewer species promises (medium)

For a native promise with the intrinsic `then`, `finally` bypasses the spec's thenFinally and
catchFinally closures, which the generic path already implements, and chains the settlement
directly through a FinallyAwait reaction.
Spec thenFinally returns `PromiseResolve(C, onFinally()).then(valueThunk)`, which costs a
species-constructed promise and an adoption job, so `p.finally(f).then(g)` runs g one tick earlier
than XS and V8, and a subclass observes 5 constructions instead of 7.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1313-1317`, `:1505-1519`.

**Evidence:** `../probes/verify/vm-functions-async/p07_finally_ticks.js`: IronHorse
`[...,"t2","F-then1","F-catch2","t3",...]`, Node `[...,"t2","t3","F-then1","F-catch2",...]`.
test262: 5 failing files under `built-ins/Promise/prototype/finally/`, for example
`species-constructor.js` (`7 new promises were created Expected SameValue(«5», «7»)`).

**Fix:** Use `make_promise_finally_handler` for the intrinsic case too, or model the extra
PromiseResolve and adoption job exactly; re-calibrate the meter afterwards.

**Also:** FN-4, FN-5, FN-7.

### INT-3 — The thixotrope worker's private compiler adapter drops the direct-eval context (medium)

`SourceCompiler::compile_eval_units` has a default body that ignores the caller's `EvalContext`,
so a direct eval's `super`, `new.target` and private names become SyntaxErrors.
`ironhorse-runtime`'s `IronhorseSourceCompiler` overrides it, but the thixotrope IronHorse worker
re-implements the adapter instead of depending on `ironhorse-runtime` and overrides only
`compile_source` and `compile_source_units`.
In a thixotrope IronHorse vat, `eval('super.x')` in a method, `eval('new.target')` in a
constructor and `eval('this.#x')` in a method throw SyntaxError, and since every incomplete crank
is fatal in that worker, they kill it; the same code works on `ironhorse-xst`, on the endo seam
and in Node.

**Where:** `rust/thixotrope-ironhorse-worker/src/main.rs:17-116` (copy at
`rust/engine/wasm-worker-spike/src/session.rs:24-123`); trait default
`rust/engine/ironhorse-vm/src/interp.rs:300-312`; correct override
`rust/engine/ironhorse-runtime/src/lib.rs:107`.

**Evidence:** `../probes/verify/integration-fuzz-oracle/worker_eval.py` against the real worker
binary: `class C extends B { m() { return eval('super.x'); } }` gives `{"op":"fatal"}` with
`SyntaxError: invalid super`; the `new.target` and `#x` cases give `invalid new.target` and
`invalid private identifier`; the same three expressions on `ironhorse-xst` and Node give
`[42,true,7]`.

**Fix:** Make the worker (and the spike, or delete it) use `IronhorseSourceCompiler`; remove the
trait default for `compile_eval_units` or make it return `Unsupported`, so a compiler that cannot
honor the eval context fails loudly.

**Also:** INT-13 (low, lens 2: the adapter exists in many hand-maintained copies).

### T262-2 — Top-level `let`, `const` and `class` are not shared across Scripts (medium)

GlobalDeclarationInstantiation puts a Script's top-level lexical declarations in the realm's global
declarative Environment Record, visible to later Scripts, and makes a later redeclaration a
SyntaxError.
IronHorse keeps them per Script: `define_global_lexical` is fed only by the Compartment
constructor's `globalLexicals` option, never by Script evaluation, so a second Script on the same
machine cannot see the first one's `const` and may redeclare it.
The XS oracle evaluates each Script with eval framing, which hides them too, so the 724 test262
rows whose bodies use a lexical declared by a harness include fail identically on both engines and
are filed as shared failures; they pass when setup and body are one Script.
Pass 2 lowered this from high: the host's multi-evaluate path (`Compartment::evaluate`) mirrors
XS/SES `compartment.evaluate`, which is eval-framed and does not share either, so the divergence
shows only when an embedder runs several Scripts in one realm.

**Where:** `rust/engine/ironhorse-vm/src/interp/environment.rs:39-52` (only caller
`rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:158`); harness
`rust/engine/ironhorse-262/src/xst.rs:453-500`, `rust/engine/ironhorse-262/src/lib.rs:602-639`.

**Evidence:** `../probes/verify/test262-harness/mini262/` (include `lexinc.js` declaring a
`const`, `let`, `class` and `var`): only the `var` case is covered; `test/probe/redecl-let.js`
redeclares `let SHARED_LET` with no SyntaxError; Node (`node2.js`, two `vm.runInContext` calls)
throws `SyntaxError: Identifier 'L' has already been declared`.

**Fix:** Implement the global declarative record for Script-goal lexical declarations with the
cross-Script redeclaration and restricted-global early errors; meanwhile concatenate setup and body
in the harness, as `test262-harness` hosts do.

**Also:** INT-9 (low: the thixotrope worker's Script goal drops top-level `let` across cranks);
T262-9 (low, lens 3: `$262.evalScript` needs this record).

### COV-4 — Object environments skip the HasProperty re-check; globals resolve late (medium)

For a `with` or eval object environment, `dispatch_set_variable` ignores its HasProperty re-check,
so a strict write to a binding deleted during the assignment recreates it instead of throwing
`ReferenceError`; `dispatch_get_variable` has no HasProperty step, so a strict read drops its
`ReferenceError` and a Proxy `with` object sees one `has` trap too few; and an unresolvable strict
global reference is decided only after the right-hand side has run.
The comment that justifies the ignored result cites an `oracle_loses_with_reference` exclusion that
has never existed in the repository; 23 test262 cases fail, 19 of which XS passes.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:251-264` (the comment and
the ignored result), `:86` (the read path), `:278` and `:352-353` (global resolution at set time).

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/verify-cov-t262-2/p1.js`.

Related engine defects recorded under other lenses:
FN-19 (low, lens 2) loses `this_captures` across an `await`, so an async arrow in a derived
constructor that captures `this` and then calls `super()` throws ReferenceError where Node
returns the instance; T262-5 (medium, lens 6) records IronHorse accepting `{...rest,} = {}`,
completing `let undefined;` at global scope and not throwing for strict
`undeclared = (this.undeclared = 5)` (all shared with XS), and rejecting ES2022 string export names;
CMP-12 (low, lens 3) records that Annex B sloppy syntax is refused and B.3.3 block-function hoisting
silently skipped.

### Property model and MOP

### NOBJ-1 — Integer indices become permanent 16-bit names, exhausting the key space (high)

Property keys are `u16` ids in one positional name table that is persisted as the snapshot NAME
row and never shrinks; once guest names approach the symbol-id floor (about 64,400 usable ids)
every novel key throws `RangeError: property key space exhausted`.
The read side keeps a canonical array index as `ReadKey::Index` and mints nothing, but the write
and reflective paths intern the decimal string: `array_generic_index_id` does
`k.to_string()` + `intern_key` for every index a generic Array method touches (29 callers,
including RegExp captures and `split`), and `to_property_id` does the same for
`Reflect.set`/`defineProperty`, Proxy `set`/`defineProperty`, expandos on Map, Set, RegExp,
ArrayBuffer, DataView and wrappers, computed `super[i] = v`, and computed-index class or literal
methods.
So any array that leaves the dense fast path, and any method that always writes generically (sort
and `toSorted` write-back, holey `reverse`/`shift`/`splice`/`fill`, species `map`), spends one
permanent name per index.
`new Array(70000).fill(0)`, a 70,000-element `sort(cmp)` or `toSorted`, and (pass 2)
`JSON.parse(JSON.stringify(arr70k))`, `Object.entries(arr70k)` and `Object.assign({}, arr70k)`
throw where Node succeeds; smaller calls silently drain the budget for the life of the vat, across
cranks and snapshots.
XS addresses indices as `(XS_NO_ID, index)` and never interns them, and the source itself calls
this "Consequence, unfixed" (`natives/array.rs:3195-3213`).

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2056-2059`
(`array_generic_index_id`; callers include `:2495,2519,2568-2637,2787-2858,3010,3213` and
`natives/regexp.rs:656,823,984,1687`, `natives/string.rs:156`);
`rust/engine/ironhorse-vm/src/interp/property/keys.rs:713-721` (`to_property_id`), `:53-82`,
`:120-140`; `rust/engine/ironhorse-vm/src/interp/property.rs:327,524,576,725`;
`rust/engine/ironhorse-vm/src/interp/dispatch/super_property.rs:110`;
`rust/engine/ironhorse-vm/src/interp/dispatch/property_write.rs:451`.

**Evidence:** `../probes/verify/vm-natives-objects/n1_persist.js`:

```js
const out = [];
new Array(40000).fill(0); out.push("40k fill ok");
const o = {}; let i = 0;
try { for (; i < 30000; i++) o["zz" + i] = i; out.push("30k names ok"); } catch (e) { out.push("names failed after " + i + " " + e.name); }
throw new Error(JSON.stringify(out));
```

IronHorse: `["40k fill ok","names failed after 24409 RangeError"]`; Node: `["40k fill ok","30k names
ok"]`; the control `n1_control.js` (30,000 names only) succeeds on IronHorse.
`n1_fill.js` (`new Array(70000).fill(0)`) throws `RangeError: property key space exhausted`.
`../probes/verify/vm-property-model/p1_paths.js` shows `Reflect.set`, `defineProperty` and Proxy
writes draining the same budget.

**Fix:** Give MOP set, delete and define an index key form (mirroring XS's `(XS_NO_ID, index)`)
and route every `array_generic_index_id` caller through it for k ≤ 2^32-2; split `to_property_id`
like `to_read_key`; extend `indexes_by_index` to every spec-ordinary object; compare `ownKeys` trap
strings by value.
Add regressions that assert the name-table length is unchanged after `new Array(1e5).fill(0)`, a
1e5-element sort and holey `reverse`/`shift`/`splice`.

**Also:** same defect PROP-1; same root PROP-2, BOOT-5, INT-4, CMP-11 (the finite, monotone 16-bit
key namespace); NOBJ-11 (its 2^24 caps are unreachable today because this fires first).

### NOBJ-NEW-1 — Array fast paths store a `const` binding's non-writable flag (high)

Found while verifying NOBJ-5.
When a function-local `const` is passed to `push` (and `unshift`, `Array.of`, `new Array(a, b)`,
`concat`, `fill`), the dense fast path copies the argument slot from the stack and resets only
`id` and `next`, keeping the flag byte, which for a value read from a `const` binding carries
`XS_DONT_SET`.
The element is stored non-writable; because the array then has an attributed item, later pushes
leave the fast path, so typically exactly one element is affected.
Assigning to it throws in strict code and is silently ignored in sloppy code, and `sort` throws.
Top-level `const`, `let`/`var` bindings, ordinary property sets, `Reflect.set`, array literals,
`splice` and `with` are unaffected.
XS's stack push copies kind and value only.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:4209-4214` (dense push), and
the same pattern at `:1864,1878` (Array constructor), `:3582` (concat), `:3753` (`Array.of`),
`:4391` (fill), `:4746` (unshift).

**Evidence:** `../probes/verify/vm-natives-objects/nx_const_flag_strict.js`:

```js
'use strict';
const r = [];
function collect(n) { const out = []; for (let i = 0; i < n; i++) { const v = i * 10; out.push(v); } return out; }
const a = collect(3);
r.push(JSON.stringify(Object.getOwnPropertyDescriptors(a)[0]));
try { a[0] = 99; r.push('assign ok ' + a[0]); } catch (e) { r.push('assign ' + e.name + ': ' + e.message); }
try { a.sort((x, y) => y - x); r.push('sort ok ' + a.join()); } catch (e) { r.push('sort ' + e.name + ': ' + e.message); }
throw new Error(JSON.stringify(r));
```

IronHorse: element 0 has `writable:false`, then `assign TypeError: set ?: not writable` and
`sort TypeError: C: xsSet ?: not writable`; Node: `writable:true`, `assign ok 99`,
`sort ok 99,20,10`.
`nx_const_flag.js` shows the same for unshift, `Array.of`, the constructor, concat and fill.
test262 does not catch it.

**Fix:** Normalize every slot stored by an array fast path to a plain data value (clear the flag
as well as `id`/`next`) through one helper used at all seven sites, or strip binding attributes
when a local is pushed onto the operand stack so no native can observe them.
Add regressions for each site followed by a write and a sort.

### COV-2 — Strict computed-key writes drop a rejected `[[Set]]` silently (high)

`property_at_set`, behind `o[k] = v`, discards the boolean result of `ordinary_set` for a named key
(a non-index string or a symbol) on an ordinary object and for a non-numeric key on a TypedArray,
so strict `o[k] = v`, `o[k] += 1`, `o[k]++` and `[o[k]] = [v]` complete silently on a frozen
object, a non-writable or getter-only property, or a new key on a non-extensible object, where the
static `o.k = v` form, XS and Node throw `TypeError`.
Integrity holds because the value never changes, but Hardened JavaScript, which is always strict
and works on frozen objects, loses the signal that a write was rejected; 5 test262 cases are
accepted failures that XS passes.

**Where:** `rust/engine/ironhorse-vm/src/interp/property.rs:801` (named-key arm), `:632`
(TypedArray arm); `rust/engine/ironhorse-vm/src/interp/dispatch.rs:489` (`SET_PROPERTY_AT`).

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/verify-cov-t262-1/p.js`.

### PROP-2 — The ~64,400-id key budget is monotone; collected symbol ids are not reused (medium)

String names are appended to the persisted `symbol_names` table and never removed, and symbol keys
draw ids from a counter that only decreases; GC prunes a dead symbol's descriptor entry but does
not return its id.
Every distinct string key, every `o[Symbol()]` even after the symbol is garbage, every identifier
in each `eval` or `Function` body and every distinct `JSON.parse` key draws on the budget, and the
exhaustion survives snapshot and restore.
Downgraded from high: `rust/engine/ARCHITECTURE.md:349-353` documents the table as "monotone and
positional in snapshots: this is exhaustion handling, not reclamation", and the error is
catchable; undocumented are the non-reuse of collected symbol ids and the index, eval-identifier
and template-site drains.

**Where:** `rust/engine/ironhorse-vm/src/interp/property/keys.rs:126-160` (`append_name_key`),
`:183-205`, `:54-68` (`admit_guest_key_count`); `rust/engine/ironhorse-vm/src/interp/state.rs:2455`.

**Evidence:** `../probes/vm-property-model/js/keys4_symbols.js`
(`for (i < 70000) { var o = {}; o[Symbol()] = 1; n++ }`) throws `RangeError: property key space
exhausted` at iteration 64,411 after 198 ms; `eval_names.js`
(`(0,eval)('var v' + i + ' = 1; delete globalThis.v' + i)`) at 64,413; Node completes both.

**Fix:** Reuse collected symbol ids through a persisted free list fed by the existing `gc_weak`
prune; fix NOBJ-1 so indices never draw; longer term make the name table collectable or widen the
id; document every drain in `ARCHITECTURE.md`.

**Also:** same root NOBJ-1, BOOT-5; BOOT-9, INT-4 (low: how exhaustion is reported).

### CORE-3 — `GET_PROPERTY` brand shortcuts are the only implementation of some accessors (medium; high as merged into ONT-6)

`dispatch_get_property`, the `o.k` opcode with a static id, tests side-table membership (regexps,
Temporal values, locales, collators, disposable stacks) before ordinary lookup and answers from
internal state, ignoring own shadowing properties, deleted or redefined prototype accessors, and
the receiver of `Reflect.get`.
`o[k]`, `Reflect.get`, `in` and `getOwnPropertyDescriptor` go through the MOP and find nothing,
because the accessors do not exist: `RegExp.prototype` has only `compile`, `constructor`, `exec`,
`test` and `toString` as string-keyed own properties, and the Temporal getters,
`Intl.Locale.prototype.language`, `Intl.Collator.prototype.compare` and
`DisposableStack.prototype.disposed` are absent too.
There is no native getter for any of them anywhere in the crate.
Downgraded from high: dot access on genuine instances and the natives that read flags internally
(`replaceAll`, `matchAll`, `split`, `new RegExp(re)`, `String(re)`) all match Node.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:44-196` (Temporal),
`:197-203` (`disposed`), `:214-249` (RegExp), `:250-284` (`Intl.Locale`), `:285-299`
(`Collator.prototype.compare`).

**Evidence:** `../probes/verify/vm-core-dispatch/c3_natives.js`: `var k = 'flags'; /x/gi[k]` is
`undefined` (Node `gi`), `'flags' in /x/` is `false`, and `RegExp.prototype`'s own string keys
are 5 (Node 15); `c3_p14_regexp_desc.js`: the `flags` descriptor is `undefined` and
`Reflect.get(RegExp.prototype, 'source', /zz/)` is `undefined`; `c3_p12_getshortcut.js`: an own
`source` on a regexp and an own `language` on a locale are ignored by dot access.
test262: 86 ironhorse-failure files under `built-ins/RegExp/prototype/{flags,source,global,...}`
and 8 under `{Async,}DisposableStack/prototype/disposed`; the Temporal and Intl accessor tests are
mostly pre-skipped, so their share is under-measured.

**Fix:** Install real accessor properties (moving the bodies from `property_read.rs` into native
getters with brand checks), then delete the shortcuts, or keep one only behind the guard that no
own property exists and the prototype slot still holds the intrinsic accessor, so `o.k`, `o[k]`
and `Reflect.get` share one implementation.

**Also:** same root RGX-2, RGX-3, NVAL-4, NOBJ-9 (entries below, each with its own consequences);
CORE-8 (lens 4: the same brand-probe chain costs every ordinary read).

### BOOT-2 — Lazily installed intrinsic members are observably absent on some paths (medium)

An intrinsic member exists only after an install pass has covered its name above the installed
floor.
Passes run at link, relink, eval, computed-key conversion and about ten native sites, but other
natives intern names with plain `intern_key` and no pass (JSON.parse keys, RegExp group names,
groupBy keys).
Two observers then see a hole: GetSubstitution's `$<name>` interns the group name and reads it at
once, so `Get(groups, 'toFixed')` on a Number wrapper is `undefined`; and for-in builds each
prototype level's keys from the raw slot chain rather than [[OwnPropertyKeys]], so a
not-yet-installed non-enumerable member fails to shadow an enumerable key of the same name
further up.
The same property can read absent and later present in one crank.
Downgraded from high: both triggers need a name that never appears in source text colliding with an
intrinsic member, plus an unusual observer.

**Where:** `rust/engine/ironhorse-vm/src/interp/enumerate.rs:66-72`, `:95-153`;
`rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1819-1823`; pass-less interning at
`natives/json.rs:1768`, `natives/regexp.rs:1125,1230`, `natives/collection.rs:2880`.

**Evidence:** `../probes/vm-boot-realm-modules/p2_forin_shadow_proto.js`:

```js
var parsed = JSON.parse('{"to' + 'Fixed":1, "x":2}');
Object.setPrototypeOf(Number.prototype, parsed);
var seen = [];
for (var k in Object(1)) seen.push(k);
throw new Error(JSON.stringify(seen));
```

IronHorse: `Error: ["toFixed","x"]`; Node: `Error: ["x"]`.
`p3_get_hole_replace.js` gives `"[]"` where Node substitutes `function toFixed() ...`.

**Fix:** Adopt the fault-in design (`designs/ironhorse-intrinsic-fault-in.md`), treating for-in
level enumeration on an intrinsic holder as a whole-key-set observer, and route every native
intern-then-read site through the same miss check; add both probes to
`ironhorse-262/tests/implicit_member_reach.rs`.

**Also:** same root BOOT-1 (the live machine's answer there is this wrong result), BOOT-3, BOOT-4.

### CORE-4 — The global object, and every Compartment global, has a null [[Prototype]] (medium)

`Interp::new` allocates the global object with a null prototype (the comment says the
`%Object.prototype%` wiring would land later; nothing re-points it), and `create_environment`
allocates every Compartment global the same way.
To keep `typeof toString === 'function'` and sloppy `toString = 1` working, `GET_VARIABLE` and
`SET_VARIABLE` add an explicit `%Object.prototype%` fallback, so bare-name resolution and
object-level operations on `globalThis` disagree: `typeof toString` is `function` while
`'toString' in globalThis` is `false`, which ECMA-262 does not allow even though the global's
prototype is host-defined.
`globalThis instanceof Object` is false, top-level `this.hasOwnProperty('x')` throws `TypeError:
call: not a function`, and `String(globalThis)` throws.
XS, Node and browsers chain the global to `%Object.prototype%`.

**Where:** `rust/engine/ironhorse-vm/src/interp/boot.rs:62-66`;
`rust/engine/ironhorse-vm/src/interp/realm.rs:941-943`;
`rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:114-141`, `:300-317`.

**Evidence:** `../probes/verify/vm-core-dispatch/c4_global.js`: IronHorse
`["proto-null=true","instanceof-Object=false","isPrototypeOf=false","this-hasOwnProperty=throw
TypeError:call: not a function","in-toString=false","bare-toString-typeof=function",
"String-global=throw TypeError:cannot coerce object to string"]`; Node
`[false,true,true,true,true,"function","[object global]"]`.
`c4_comp.js`: `new Compartment().evaluate("Object.getPrototypeOf(globalThis) === null")` is
`true`.
test262: 10 ironhorse-failure files call `this.hasOwnProperty` or `this.propertyIsEnumerable` at
global scope, for example `built-ins/Object/defineProperty/15.2.3.6-4-625gs.js` and
`built-ins/decodeURI/S15.1.3.1_A5.5.js`.

**Fix:** After `%Object.prototype%` exists, set it as the prototype of the default global and of
every compartment global, delete the two fallbacks so name resolution and [[HasProperty]] agree,
and check that snapshot restore and boot fixtures carry the link.

**Also:** same defect PROP-7; PROP-6.

### PROP-6 — `%Object.prototype%` is not an immutable-prototype exotic object (medium)

ECMA-262 10.4.7 requires `%Object.prototype%.[[SetPrototypeOf]](V)` to return SameValue(V,
current).
`mop_set_prototype_inner` applies only the ordinary checks to every non-proxy instance, so before
lockdown `Reflect.setPrototypeOf(Object.prototype, Object.create(null))` succeeds and the new
prototype's properties appear on every object.
This is not a privilege escalation (pre-lockdown code can add properties to `Object.prototype`
directly, and after lockdown it is non-extensible).

**Where:** `rust/engine/ironhorse-vm/src/interp/property.rs:965-999`.

**Evidence:** `../probes/vm-property-model/js/immutable_proto2.js`: IronHorse `reflect:true | proto
is n:true | ({}).injected=from n`; Node `reflect:false | proto is n:false |
({}).injected=undefined`.
test262: `built-ins/Object/prototype/setPrototypeOf-with-non-circular-values.js` and its
`__proto__` twin fail.

**Fix:** In `mop_set_prototype_inner`, return `Ok(current == new_proto)` for each realm's
`%Object.prototype%` before the ordinary checks.

**Also:** CORE-4 (the same `%Object.prototype%` wiring area).

### PROP-5 — Proxy [[Call]] is recomputed per call instead of fixed at creation (medium)

ProxyCreate gives a proxy [[Call]] only if its target is callable, fixed at creation and kept after
revocation.
IronHorse stores no such bit: the call opcode reaches `proxy_call_step`, which invokes the
handler's `apply` trap without checking the target, so `new Proxy({}, {apply(){return 'trap
ran'}})()` returns `'trap ran'` (Node: TypeError), although `Reflect.apply(p)` does throw.
Conversely `slot_is_callable` stops at a revoked layer, so a revoked function proxy has `typeof`
`object` and every IsCallable test treats it as non-callable (a Promise reaction would pass the
value through instead of rejecting).
[[Construct]] already has a pre-trap gate (`proxy_construct_refused`).

**Where:** `rust/engine/ironhorse-vm/src/interp/property/proxy.rs:1224-1248`, contrast
`:1279-1291`; `rust/engine/ironhorse-vm/src/interp/invoke.rs:568-580`;
`rust/engine/ironhorse-vm/src/interp/function.rs:664-676`.

**Evidence:** `../probes/verify/vm-property-model/p5_proxy_call.js`: IronHorse `call_nonfn:trap ran
| reflect_apply_nonfn:TypeError | ... | revoked_typeof:object`; Node `call_nonfn:TypeError | ... |
revoked_typeof:function`.
test262: `built-ins/Proxy/revocable/target-is-revoked-function-proxy.js` and
`language/expressions/typeof/proxy.js` fail (`Expected SameValue(«"object"», «"function"»)`).

**Fix:** Record callable and constructor bits in `ProxyData` at creation (as XS does with
`XS_CAN_CALL_FLAG`/`XS_CAN_CONSTRUCT_FLAG`), read them in `slot_is_callable`,
`slot_is_constructor` and `typeof`, and gate the call opcode on the callable bit.

### PROP-8 — Built-in iterators reuse one non-writable `{value, done}` result object (medium)

CreateIterResultObject must return a fresh ordinary object with writable, enumerable,
configurable `value` and `done` on every `next()`.
These iterators allocate one result object per iterator, flag `value` and `done`
`XS_DONT_DELETE|XS_DONT_SET`, and rewrite them in place with `set_own_unmetered`, which bypasses
[[DefineOwnProperty]], mirroring XS's `fxNewIteratorInstance`.
So `a = it.next(); b = it.next(); a === b` is true and `a.value` changes, the descriptor reports
`writable:false, configurable:false`, and collecting result objects yields copies of the final
`{value: undefined, done: true}`.
Generators and RegExp String Iterator results are fresh and correct; test262 does not catch it
because the XS oracle shares it.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1369-1375`, `:1390`,
`:1541-1543`; `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:625,662` (allocation),
`:2040-2041,2968-2969` (rewrite); `rust/engine/ironhorse-vm/src/interp/environment.rs:334-356`.

**Evidence:** `../probes/vm-property-model/js/iter_reuse.js` and `iter_reuse2.js`: IronHorse
`same:true | a.value:2 | desc:{"value":2,"writable":false,"enumerable":true,"configurable":false}`
and `collected:,`; Node `same:false | a.value:1 | ...writable:true...` and `collected:10,20`.

**Fix:** Allocate a fresh ordinary result object per `next()` through the ordinary define path in
the three iterator kinds; if XS parity is kept on purpose, list it among the documented oracle
divergences; restrict `set_own_unmetered` to engine-private objects.

Low in this group (table at the end): PROP-9, the order of `IsExtensible(target)` and
ToPropertyDescriptor in a Proxy's [[GetOwnProperty]].

### Built-ins

### RGX-2 — RegExp.prototype's accessors exist only as a `GET_PROPERTY` special case (medium; high as merged into ONT-6)

This is CORE-3's mechanism for RegExp, with consequences of its own.
`%RegExp.prototype%` gets only `exec`, `test`, `toString` and `compile`; the ten accessors
(`source`, `flags`, `global`, `ignoreCase`, `multiline`, `dotAll`, `sticky`, `unicode`,
`hasIndices`, `unicodeSets`) are answered only when the static-name opcode sees a RegExp receiver
and a program-local id equal to a link-time getter id.
Bracket and computed reads fail even when the program spells `.global` elsewhere, an own data
property on an instance and a subclass getter are both ignored, `RegExp.prototype.source` is
`undefined` instead of `"(?:)"`, and the getters cannot be extracted and called, which also
matters to Hardened JS lockdown, which enumerates intrinsic accessors by descriptor.
Pass 2 lowered this from high: dot access, destructuring, `toString` and
`new RegExp(r.source, r.flags)` work, and no capability escape follows because the special case
always returns the true internal value; `designs/ironhorse-native-lockdown.md:102` already lists
"RegExp.prototype metadata" as a known intrinsic-surface gap.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:214-247` (the only use
of `regexp_getter_ids`); `rust/engine/ironhorse-vm/src/interp/link.rs:46-56`, `:120-129`;
`rust/engine/ironhorse-vm/src/interp/boot.rs:1427-1443`;
`rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:568-584` (names listed, never
materialized).

**Evidence:** `../probes/regexp/p27_getter_bracket.js`:

```js
const r = /a/gi; const k = "glo" + "bal"; throw new Error(JSON.stringify([r["global"], r["source"], r["flags"], r[k], r["ignoreCase"]]));
```

IronHorse: `[null,null,null,null,null]`; Node: `[true,"a","gi",true,true]`.
`../probes/verify/regexp/g1.js`: an own `global` defined as 42 reads `false` (Node 42), and a
subclass `get flags() { return 'zz' }` reads `g` (Node `zz`).
test262: 86 ironhorse-failure files under the ten accessor directories.

**Fix:** Install the ten accessors on `%RegExp.prototype%` as native getters that read the
`regexps` side table and follow the spec's `%RegExp.prototype%` receiver branches, then delete the
special case.

**Also:** same root CORE-3, RGX-3.

### RGX-3 — Match results get `index`, `input`, `groups` only if the source names them (medium)

RegExpBuiltinExec must always create `index`, `input` and `groups` (and `indices` under `d`).
IronHorse creates each only when `regexp_result_ids` holds a program-local id for the name,
resolved from the program's symbol table at link time; the generic `@@replace` path force-interns
only `index` and `groups`.
So `Object.keys(/a/.exec('a'))` is `['0']`, `{...m}` and `Object.assign({}, m)` drop the
standard properties, and `m['index']` is `undefined` unless `.index` appears somewhere in the
program, even in a function that is never called.
Ordinary code that uses `m.index` or destructures `{index, groups}` works, because those spellings
intern the names.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1098-1156`, `:1223`,
`:1603-1610`; `rust/engine/ironhorse-vm/src/interp/link.rs:57-62`, `:130-133`.

**Evidence:** `../probes/regexp/p21_result_keys.js`
(`throw new Error(JSON.stringify(Object.keys(/a/.exec("a"))));`): IronHorse `["0"]`, Node
`["0","index","input","groups"]`; `p29_spell_fix.js` shows that adding an uncalled
`function spell(o){ sink = o.index; }` makes `index` appear.
test262: `built-ins/RegExp/match-indices/indices-groups-object-undefined.js` fails; most RegExp
tests escape because `harness/regExpUtils.js` spells `.index` and `.input`.

**Fix:** Intern `index`, `input`, `groups` and `indices` unconditionally when the RegExp surface
links, always create the properties, and make the `RegExpResultIds` fields non-optional.

**Also:** same root RGX-2, CORE-3.

### NOBJ-9 — `disposed` is an opcode special case, not a prototype accessor (medium; high as merged into ONT-6)

Another instance of CORE-3: the get-property opcode answers `x.disposed` from the stack's internal
flag when the property id is the interned name `disposed` and the receiver is a disposable stack.
No accessor exists on either prototype, so `Reflect.get`, computed keys, `in` and
`getOwnPropertyDescriptor` see nothing, and the special case overrides an own shadowing property.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-203`; no getter in
`natives/resource.rs`, `native_ids.rs` or `boot.rs`.

**Evidence:** `../probes/verify/vm-natives-objects/n9_disposed.js`:
`{"dot":false,"computed":"undefined","reflect":"undefined","inOp":false,"desc":"undefined",...,
"shadowDot":false,"shadowReflect":"shadow"}`.
test262: 8 of 14 files under `built-ins/{,Async}DisposableStack/prototype/disposed/` fail.

**Fix:** Install `get disposed` accessors on both prototypes with a brand check, and delete the
opcode special case.

**Also:** same root CORE-3; NOBJ-8.

### NVAL-10 — `JSON.parse` and `JSON.rawJSON` accept `\u+XYZ` escapes (medium)

The `\u` escape handler converts the next four bytes with `u32::from_str_radix(h, 16)`, which
accepts a leading `+`.
So `"\u+041"` decodes to `A` and `"\u+0041"` to U+0004 followed by `1`, where the JSON grammar
requires exactly four hex digits.
The same parser validates `JSON.rawJSON`, which then lets `JSON.stringify` emit the invalid text
verbatim; a validator that relies on `JSON.parse` rejecting malformed input accepts it, and peers
disagree on the same payload.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1585-1597`.

**Evidence:** `../probes/verify/vm-natives-values/n10_json.js`:

```js
const r = [];
for (const s of ['"\\u+041"', '"\\u+0041"', '"\\u-041"', '"\\u 041"']) { try { r.push(JSON.stringify(JSON.parse(s))); } catch (e) { r.push(e.name); } }
try { const v = JSON.rawJSON('"\\u+041"'); r.push('raw-ok:' + JSON.stringify({ v })); } catch (e) { r.push('raw:' + e.name); }
throw new Error(JSON.stringify(r));
```

IronHorse parses the first two (`"A"` and `"\u00041"`) and emits `{"v":"\u+041"}`; Node throws
SyntaxError for all five.

**Fix:** Require four ASCII hex digits before converting; add regressions for `+` in `parse` and
`rawJSON`.

### NVAL-11 — `parseInt` and non-decimal `Number()` double-round in `f64` (medium)

Both loops accumulate in `f64`, rounding at every step once the value exceeds 2^53.
ECMA-262 requires `parseInt` to be exact for radices 2, 4, 8, 16 and 32 and for up to 20
significant decimal digits, and StringToNumber requires the correctly rounded value for
non-decimal literals; decimal `Number()` and `parseFloat` are correct because they use Rust's
correctly rounded parser.
`parseInt` of a 17-digit ID or a hex constant above 2^53 yields a different Number than every other
engine.

**Where:** `rust/engine/ironhorse-vm/src/interp/numeric.rs:84-99` (`parse_int`), `:233-242`.

**Evidence:** `../probes/verify/vm-natives-values/n11_parse.js`: `parseInt('48835871506362344')`
is 48835871506362340 (Node 48835871506362344); `parseInt('1000000000000081', 16)` and
`Number('0x1000000000000081')` are 1152921504606847000 (Node 1152921504606847200);
`parseInt('12345678901234567891')` is 12345678901234570000 (Node 12345678901234567000).

**Fix:** For power-of-two radices accumulate exact bits and round once; for radix 10 truncate to 20
significant digits and reuse the correctly rounded decimal parser; for other radices accumulate in
`u64` and switch to an exact big-integer conversion on overflow.

**Also:** CMP-7 (the same double rounding at compile time).

### NVAL-12 — `Math.fround`, `Math.hypot` and `Math.round` are wrong on edge inputs (medium)

`fround` returns a `Kind::Integer` argument unchanged, but i32 values above 2^24 are not exact in
`f32`.
`hypot` with three or more arguments takes the square root of a naive sum of squares, so it
overflows to Infinity for 1e200 inputs, underflows to 0 for 1e-200, and returns NaN for
`(NaN, Infinity, 1)` where any infinite argument must give Infinity.
`round` applies `floor(x + 0.5)` only below 4503599627370495 and returns other non-integers
unchanged.
The comments attribute each shortcut to XS; the `Integer` kind is being read as "needs no
rounding".

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/number.rs:148-152` (fround), `:82-94`
(hypot), `:116-132` (round).

**Evidence:** `../probes/verify/vm-natives-values/n12_math.js`: `Math.fround(16777217)` 16777217
(Node 16777216); `Math.hypot(1e200, 1e200, 1e200)` Infinity (Node 1.7320508075688773e+200);
`Math.hypot(NaN, Infinity, 1)` NaN (Node Infinity); `Math.round(4503599627370495.5)`
4503599627370495.5 (Node 4503599627370496).

**Fix:** Keep the `fround` fast path only for |i| ≤ 2^24; implement `hypot` per spec (infinities
first, then NaN, then scale by the largest magnitude); make `round` return integral x unchanged and
`floor(x + 0.5)` with the ±0 corners otherwise.
If XS shares these, record an oracle exception rather than preserve them.

### COV-8 — Non-unicode `/i` canonicalization equates 27 Greek iota-subscript pairs (low)

Without `u` or `v`, `canonicalize` takes the XS-derived IGNORE0 table, which maps U+1F80-1F87,
U+1F90-1F97, U+1FA0-1FA7, U+1FB3, U+1FC3 and U+1FF3 to their titlecase forms, where spec
Canonicalize keeps a character whose full uppercase is not a single code unit, so
`/ᾈ/i.test('ᾀ')` is true (Node false).
A differential over every code point with a single-code-point case mapping (2,905) found exactly
these 27 differences, all in the non-`u` mode; XS shares them, so the differential gate cannot see
them.

**Where:** `rust/engine/ironhorse-regexp/src/charcase.rs:913-918`, `:920`, `:926`, `:938`, `:950`,
`:974` (the rows), `:2517` (`canonicalize`).

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/verify-bs3/q.js` and
`../probes/coverage-review/blind-spots/ufold.js`.

### COV-19 — `using` and `use()` accept primitives; async forms fall back to `@@dispose` (low)

`exec_using` and the `DisposableStack`/`AsyncDisposableStack` `use` methods run ToObject on a
non-nullish primitive and accept it whenever its prototype carries `@@dispose`, where
CreateDisposableResource throws `TypeError` for any non-Object; the async forms also fall back to
`@@dispose` when `@@asyncDispose` is a non-callable value such as `42`, where GetMethod throws
(it falls back only on `undefined` or `null`).
The behavior matches XS, so the oracle agrees, and `xs_departures.rs` records no departure.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/resource.rs:85-113`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:4716-4775` (the fallback at `:4752-4766`).

**Full entry:** `../COVERAGE.md`; evidence `../probes/coverage-review/verify-lost-content-2/p1.js`
(against Bun; Node 22 lacks `DisposableStack`).

Low in this group (table at the end): NOBJ-16 (`Set.prototype.intersection` re-checks `this`),
NOBJ-17 (Map/Set iterators stop after `clear()`), NVAL-14 (`Date.parse` normalizes illegal ISO
fields), NVAL-16 (`String.fromCharCode` saturates), CMP-9 and CMP-10 (lexer edge cases).

### Intl and Temporal

`designs/ironhorse-engine.md` decision 10 retains Intl and Temporal on in-tree tables and does not
claim full ECMA-402 or Temporal conformance.
The XS oracle has neither, so the differential sweep cannot judge them (see T262-1); the figures
below come from a plain-host test262 run of `ironhorse-xst` with no oracle (sloppy mode, no
`$262`, async cases skipped).

### NVAL-6 — Time zones are fixed standard-time offsets: DST ignored, most zones refused (high)

`resolve_time_zone` maps UTC aliases, numeric offsets, `Etc/GMT±N` and a 23-row table (22 zones)
to one constant standard-time offset each, and `Intl.DateTimeFormat` and `Temporal.ZonedDateTime`
share it.
Every summer instant in a DST zone (New York, London, Paris, Berlin, Sydney, Auckland, ...) is
rendered an hour off with the wrong zone name; ZonedDateTime strings carrying the correct summer
offset, which other engines emit, are rejected as invalid; and every other IANA zone, including
no-DST zones such as `America/Phoenix`, is a RangeError worded as invalid input.
Pass 2 kept high: an implementation may support few zones, but a zone it accepts must follow its
rules, and this answers wrongly for about half of every year on the main path of using a named
zone.

**Where:** `rust/engine/ironhorse-vm/src/interp/temporal.rs:1409-1494` (`resolve_time_zone`,
"DST not modeled"), `:1167-1174`, `:1176-1178`;
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:450-459`.

**Evidence:** `../probes/verify/vm-natives-values/n6_tz.js` (TZ=UTC): `en-US` hour, minute and
short zone name for `America/New_York` at 2024-07-01T12:00Z give `7:0 AM GMT-5` (Node
`8:00 AM EDT`); `Europe/London` `12:0 PM GMT+0` (Node `1:00 PM GMT+1`);
`Temporal.ZonedDateTime.from('2024-07-01T12:00[America/New_York]').offset` is `-05:00`, and
`...T12:00-04:00[America/New_York]` throws `RangeError: invalid zoned date/time string`;
`Pacific/Chatham`, `Europe/Kyiv`, `Antarctica/Troll` and `America/Phoenix` throw RangeError.
Plain-host test262: `built-ins/Temporal/ZonedDateTime` 495/901 and `intl402/DateTimeFormat`
122/244; 29 Temporal failures cite "invalid or unsupported time zone".

**Fix:** Embed a frozen tzdb snapshot versioned with `INTL_DATA_VERSION` so replicas stay
deterministic, and apply transitions; until then, refuse DST-observing zones with a self-naming
`NotImplemented` rather than answering with a wrong offset.

**Also:** same root NVAL-5, NVAL-8 (hand tables standing in for CLDR and tzdb); NVAL-9.

### NVAL-4 — Temporal getters and `Collator.compare` exist only on the `GET_PROPERTY` path (medium; high as merged into ONT-6)

The Temporal and Collator instance of CORE-3: the opcode matches the key text (allocating a
`String` per read) against names such as `years`, `month`, `epochNanoseconds` and `compare`, and
no accessor exists on the prototypes.
Computed access, `Reflect.get`, a Proxy forwarding to the target (so a membrane around a Temporal
value), `in` and descriptors see nothing, an own property cannot shadow them, and a non-branded
receiver such as `Object.create(duration)` yields `undefined` instead of TypeError.
`Intl.DateTimeFormat.prototype.format` is a data property holding a function rather than the spec
accessor.
So a detached `format` has no bound receiver: `var g = dtf.format; g(0)` throws
`TypeError: Intl.DateTimeFormat: incompatible receiver`, and so does `[0].map(dtf.format)`, where
the spec's getter returns a function bound to `dtf` (`../probes/coverage-review/blind-spots/dtf.js`).
Pass 2 lowered this from high: dot access, destructuring and passing `collator.compare` to `sort`
work.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:44-53` (Instant),
`:54-73` (Duration), `:74-128` (Plain types), `:129-196` (Zoned), `:250-284` (Locale), `:285-298`
(Collator `compare`).

**Evidence:** `../probes/verify/vm-natives-values/n4_getter.js` with
`d = Temporal.Duration.from({years: 1})`: `d.years` 1, but `d['ye' + 'ars']`,
`Reflect.get(d, 'years')`, `new Proxy(d, {}).years` and `Object.create(d).years` are all
`undefined`, and `typeof Reflect.get(collator, 'compare')` is `undefined`.
Plain-host test262: the largest single failure class, 215 `built-ins/Temporal` and 86 `intl402`
failures with `cannot coerce undefined to object`.

**Fix:** Install real accessors (native getters with brand checks) on every Temporal and Intl
prototype and delete the opcode cases; if a fast path stays, key it on the resolved accessor, not
the key text.

**Also:** same root CORE-3; NVAL-7.

### NVAL-5 — `Intl.Collator` is not UCA; base sensitivity and numeric options are wrong (medium)

`collator_compare_units` NFC-normalizes, lowercases and orders by code point, falling back to
original code points for ties, which is not the Unicode Collation Algorithm: `ä` sorts after `z`,
`A` before `a`, `sensitivity: 'base'` still distinguishes `a` from `á` and `ß` from `ss`, and
numeric collation parses only the first digit run (`'b1' < 'a2'`).
Pass 2 lowered this from high: ordering is implementation-defined and decision 10 acknowledges the
approximation, so the spec divergences are the two options (base sensitivity and numeric), which
give wrong but deterministic answers.
Comparison is also unmetered per unit and clones the collator data per call.

**Where:** `rust/engine/ironhorse-vm/src/interp/locale.rs:903-962`, `:964-988`; callers
`rust/engine/ironhorse-vm/src/interp/natives/string.rs:651-670`,
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2828-2844`.

**Evidence:** `../probes/verify/vm-natives-values/n5_collate.js`: base-sensitivity
`compare('a', 'á')` -1 (Node 0); numeric `compare('b1', 'a2')` -1 (Node 1) and
`compare('a10b2', 'a10b10')` 1 (Node -1); German sort of `['ä','a','z']` `a,z,ä` (Node `a,ä,z`).
Plain-host test262: `intl402/Collator` 44/65.

**Fix:** Use `icu_collator` (the ICU4X 2.x family is already in the lock) with root data plus the
advertised locales, or document collation as lowercase code-point order and stop advertising the
options; charge per input unit and cache the resolved collator.

**Also:** same root NVAL-6, NVAL-8.

### NVAL-7 — Temporal is an outdated, lax, unmetered subset (~44% plain-host test262) (medium)

The implementation follows an older proposal snapshot (`Temporal.Calendar` exists, the ISO era is
`ce`) and omits much of the current spec: property-bag `overflow` handling, ISO date limits,
critical-annotation validation, leap-second clamping, and `largestUnit`/`smallestUnit` for
`Plain*.until`/`since`, whose options argument is never read (even `'bogus'` is accepted).
No Temporal or Intl path calls the meter beyond result-string allocation.
Because XS has no Temporal, the whole-tree shards record 8,316 skip and 890 fail rows whose oracle
side is a ReferenceError; they pin IronHorse's current errors but cannot judge correctness.

**Where:** `rust/engine/ironhorse-vm/src/interp/temporal.rs:158-179`, `:181-252` (annotations
dropped by `split('[')`), `:962-1019`;
`rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:41-56`, `:432-438` (options ignored),
`:1780-1782`.

**Evidence:** `../probes/verify/vm-natives-values/n7_temporal.js`:
`PlainDate.from({year: 2021, month: 2, day: 31})` throws TypeError (spec: 2021-02-28);
`new PlainDate(300000, 1, 1)` is accepted; `PlainDate.from('2021-01-01[!u-ca=hebrew]')` is
accepted; `Instant.from('2020-01-01T00:00Z')` and `PlainTime.from('12:00:60')` throw RangeError;
`n7_until.js`: `d.until(e, {largestUnit: 'months'})` returns `P1000000D`.
`../probes/coverage-review/blind-spots/tp.js` adds two instances:
`PlainDateTime.from('2024-01-31T10:20:30.123456789').add({days: 1})` throws
`RangeError: Temporal: date/time arithmetic out of range` (as does every date unit, in `add` and
`subtract`), and `PlainMonthDay.from('--02-29')` is rejected as an invalid date/time string.
Plain-host test262: `built-ins/Temporal` 2,023/4,603 and `intl402/Temporal` 112/2,029.

**Fix:** Adopt `temporal_rs` behind the existing side-table records, or gate Temporal off until it
conforms; add an oracle-independent Temporal and intl402 test262 gate in CI; meter parsing and
field arithmetic.

**Also:** NVAL-4 (its largest failure class), NVAL-6, NVAL-9; T262-1.

### NVAL-8 — Intl's hand tables format supported locales with English data (medium)

`supportedLocalesOf` and ResolveLocale accept a set of languages, but each formatter keys its own
small table on the language subtag and silently falls back to English data; "supported locale" is
defined eight times.
`PluralRules('ar').resolvedOptions()` lists six categories while `select()` returns only `one` or
`other`; ListFormat, DateTimeFormat and `Locale.prototype.maximize` use English or Latn/US data for
de, ja, th and el; `NumberFormat('xx')` resolves to `xx`; CanonicalizeLocaleList skips ToObject, so
an array-like locale list is a RangeError; `Date.prototype.toLocaleDateString` ignores locales; and
DateTimeFormat renders numeric minutes without zero-padding (`7:0 AM`).

**Where:** `rust/engine/ironhorse-vm/src/interp/locale.rs:225-248`, `:182-202`, `:272-298`,
`:816-901`, `:466-677`; `rust/engine/ironhorse-vm/src/intl_number.rs:884-913`;
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:55-85`, `:313-328`;
`rust/engine/ironhorse-vm/src/interp/boot.rs:2766-2768`.

**Evidence:** `../probes/verify/vm-natives-values/n8_intl.js`: `PluralRules('ru').select(3)`
`other` (Node `few`); `ListFormat('de')` `a, b, and c` (Node `a, b und c`);
`DateTimeFormat('de').format(0)` `1/1/1970` (Node `1.1.1970`); `NumberFormat('fr')`
`1.234.567,891` (Node `1 234 567,891`); `new Locale('th').maximize()` `th-Latn-US` (Node
`th-Thai-TH`); `getCanonicalLocales({length: 1, 0: 'en'})` throws (Node `en`).
Plain-host test262 for non-Temporal `intl402`: 673/1,328 (51%), with RelativeTimeFormat 0/80 and
DurationFormat 0/110.

**Fix:** Make one "supported locale" predicate the single source of truth, and either ship CLDR
data for every advertised locale (`icu_plurals`, `icu_list`, `icu_datetime`, `icu_decimal`) or
shrink the advertised set to what is modelled; implement CanonicalizeLocaleList per spec; route
`Date.prototype.toLocale*String` through DateTimeFormat; zero-pad numeric fields.

**Also:** same root NVAL-5, NVAL-6; NVAL-9 (silent approximation is one of its five classes).

## Persistence correctness

The store path is sound where it was tested hardest: commits are atomic on both backends, SQLite
enforces a single writer, migrations land in one compare-and-swap, and the partial collector
over-approximates the full one (see "Leads that did not survive").
The defects are in what is persisted (garbage that is never collected), in containers adopted from
elsewhere, which `rust/engine/ARCHITECTURE.md:236` says "are still validated completely before
adoption" but whose HEAP records are checked only for range and liveness, and in import paths that
spend quadratic CPU before any gate.
Related entries elsewhere: BOOT-1 (live and resumed machines diverge), SNI-2 and SNI-3 (crafted
containers that panic the host) and SNS-4 (damaged rows that panic past every catch), all above.

### INT-1 — The thixotrope IronHorse worker never collects, so long-lived vats brick (high)

The VM never collects on allocation pressure; by design (`designs/ironhorse-quiescent-gc.md`)
the embedder decides when to collect.
The thixotrope IronHorse worker's protocol has only `eval` and `close`, its crank loop is `eval`
then `checkpoint_to_store`, and nothing in it requests a collection.
Unreachable objects therefore stay allocated, count against the 1,000,000-slot ceiling, are written
to SQLite at every checkpoint and restored on every restart.
Every ordinary delivery is two cranks that leave garbage, so every long-lived vat on this path
eventually halts `HeapExhausted`, is quarantined and not replayed, and restarting restores the same
garbage-laden heap; the thixotrope README tells operators to wait for "guest GC" that this worker
never performs.
The wasm-worker-spike carries the same loop verbatim.

**Where:** `rust/thixotrope-ironhorse-worker/src/main.rs:118-180` (eval), `:308-334` (crank loop);
`rust/engine/wasm-worker-spike/src/session.rs:125-187`; `rust/engine/ironhorse-vm/src/value.rs:14`.

**Evidence:** `../probes/verify/integration-fuzz-oracle/worker_no_gc.py` against the real worker
binary over its NDJSON protocol, with `GARBAGE = "var keep = 0; for (var i = 0; i < 50000; i++)
{ var o = { a: i, b: [i] }; keep = keep + 1; } keep"`: cranks 1-4 return `50000`; crank 5 is
`{"message":"guest crank halted: HeapExhausted","op":"fatal"}`; the heap file is 29,982,720 bytes;
after a restart a tiny crank succeeds and the same garbage crank fails again.
Pass 2 reproduced it exactly.

**Fix:** Collect in the worker at a checkpoint boundary on a replica-visible cadence (count
completed cranks, as `PersistentMachine`'s `collect_every` does) using the store-aware collection
in `ironhorse-snapshot`; at minimum, on a `HeapExhausted` crank, rewind to the last checkpoint,
collect and retry once before declaring it fatal.
Add a worker test that runs N garbage cranks across a restart, and apply the same change to the
spike or delete it.

**Also:** same root MEM-1, NVAL-3, CORE-6, FN-12; INT-13 (low, lens 2: the spike's verbatim copy).

### SNI-1 — A crafted prototype cycle is adopted and spins past an armed meter (medium)

A [[Prototype]] link is the reference payload of an instance's HEAP record.
On adoption, `check_stored_bounds` only requires references to be in range and not free, and
restore validates only the global object's own-property chain and the boot accessor prototypes;
nothing checks prototype-chain acyclicity.
Live code never creates a cycle because [[SetPrototypeOf]] refuses it, so the lookup loops have
neither a cycle guard nor a meter check, and the first lookup that misses the object's own
properties loops forever inside one bytecode: an armed meter whose host refuses never regains
control.
The snapshot fuzz target only decodes and restores, so it cannot find this class.
Pass 2 lowered this from high: the input is a host-supplied container, the production daemon only
resumes trusted stores, and the only adoption callers are `import_from_container`, the
`vat_surgery` example, the wasm spike and a probe; it would be high if a production path adopted
containers from untrusted peers.

**Where:** `rust/engine/ironhorse-vm/src/interp/persist.rs:266` (the only chain validation);
`rust/engine/ironhorse-snapshot/src/image.rs:5051-5120`; unguarded walks such as
`rust/engine/ironhorse-vm/src/interp/property.rs:1361` (also `:354,1688,1830,1867`),
`interp/property/read_index.rs:94`, `interp/render.rs:442`.

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test
`v1_proto_cycle` (logs `v1_proto_cycle.log`, `v1_proto_cycle.pass2.log`): with `o`'s prototype
set to `o` (or `o -> p -> o`), `from_snapshot_bytes` accepts the container; `'zz' in o` under a
10,000-computron meter whose host refuses produces no result after 10 s; the own hit `o.mark`
answers normally.

**Fix:** One O(slots) adoption pass over live HEAP records, fused with SNI-2's and SNI-4's checks:
run `validate_restore_chain` for every instance with a shared completion set, and check that the
prototype graph is acyclic (out-degree 1, so linear marking suffices).
`read_validated_machine` already makes four or more full passes over HEAP (decode, the
`check_stored_bounds` visitor, `stored_unregistered_key_id` and the canonical re-encode;
`../maps/snapshot-image-codec.md:1139`); fusing them into one visitor would host the SNI-1, SNI-2
and SNI-4 semantic checks at no extra pass.
As defence in depth, give prototype walkers a hop bound or a meter tick per hop, and make the
snapshot fuzz target run a short metered crank on every accepted machine.

**Also:** same root SNI-2, SNI-4 (one fix); CORE-14 (low: the same crafted-input class for
bytecode).

### SNI-4 — Unvalidated HEAP shapes; a cyclic own chain grows host memory without bound (medium)

`decode_slot` checks only that the kind byte and the payload tag are each known, not that they
agree, and the VM's per-kind shape validator runs on side-table values but never on HEAP records.
An Integer property retagged as a String kind is adopted (`typeof n` answers `string`, `n + 1`
answers `"7770031"`), and so is a property chain whose tail links back to its head.
Lookups tolerate that cycle, but `own_property_slots`, used by `Object.freeze`, `seal`, `isFrozen`
and other integrity operations, pushes into a host vector until it reaches null, growing host
memory without bound inside one instruction, past an armed refusing meter and outside the heap
ceiling.
Pass 1 raised this to high; pass 2 returned it to medium on the same input-source argument as
SNI-1.

**Where:** `rust/engine/ironhorse-snapshot/src/slot_codec.rs:115-129`;
`rust/engine/ironhorse-snapshot/src/image.rs:5091-5111`;
`rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:74-90` (`own_property_slots`);
`rust/engine/ironhorse-vm/src/interp/persist.rs:103-145` (the validator applied only to side
tables).

**Evidence:** test `v3_heap_shape` (logs `v3_heap_shape.log`, `v3_heap_shape.pass2.log`, run under
`ulimit -v 8000000` with an allocator watchdog): `[V3a typeof n] result="string"`,
`[V3b] crafted cyclic own-property chain ACCEPTED`, then `[V3b watchdog] live heap grew by 1024 MiB
during the enumeration; exiting` during the metered `Object.freeze(o)` crank.

**Fix:** In the SNI-1 adoption pass, run `validate_restore_value_shape` over every live HEAP record
(or put a kind-to-payload table in `decode_slot`) and `validate_restore_chain` for every live
instance; give `own_property_slots` the cycle-detecting walk `find_property` already has.

**Also:** same root SNI-1, SNI-2.

### SNI-5 — Duplicate-atom detection is O(n²) and runs before every other gate (medium)

`AtomReader::parse` splits the envelope into any number of atoms (8 bytes minimum each) and then
rejects duplicates with a pairwise scan, before the VERS, SIGN and canonical-order checks, although
a valid container has at most 38 atoms and the later canonical-order check already implies
uniqueness.
A crafted container of N distinct empty atoms costs N²/2 comparisons before refusal on every import
path (`from_snapshot_bytes`, `resume_from_cas` after its hash check, store import).

**Where:** `rust/engine/ironhorse-snapshot/src/atom.rs:186-192`.

**Evidence:** test `v5_atoms` (release; log `v5_atoms.log`): 64,000 atoms (512 KB) refused in
0.654 s, 128,000 atoms (1 MiB) in 6.10 s; a 16 MiB container extrapolates to 10-25 minutes.
The map's figures were from a debug build, about 45× slower.

**Fix:** Refuse more than `CANONICAL_ATOM_ORDER.len()` atoms in `parse`, or fuse the canonical-order
check into parsing so each tag must advance a cursor through the canonical order.

**Also:** SNI-6 (the same unbounded pre-validation CPU class).

### SNI-6 — The FUNC gate re-walks each row's body: O(rows × body) read cost (medium)

For every function row with a body, the roster's Functions gate walks the bytecode from
`body_start` to `body_start + body_len` with no memoization, and `restore_function_state` repeats
the walk.
Many rows naming one body is valid (distinct closures of one function share it) and a row costs
about 67 bytes on the wire, so a crafted container pairing one large segment with F rows costs F
full walks.
The generator gate and `validate_suspended_cursors` memoize by owner rather than by body.

**Where:** `rust/engine/ironhorse-snapshot/src/snapshot_roster.rs:1472-1504`, `:2060-2098`;
`rust/engine/ironhorse-vm/src/interp/persist.rs:1782-1801`;
`rust/engine/ironhorse-vm/src/interp/restore.rs:161-224`.

**Evidence:** test `v6_func_gate` (release; log `v6_func_gate.log`), one 1 MiB body:
`rows=100 container=1101823 B: read_machine 440.658342ms`, `rows=1600 container=1202323 B:
read_machine 7.19080736s`; about 4.5 ms per row per MiB, so a 16 MiB container split between body
and rows would cost on the order of an hour.

**Fix:** Walk each referenced body once: memoize the verdict per `(segment, body_start, body_len)`
in one shared helper used by both gates, `restore_function_state` and
`validate_suspended_cursors`, and let VM restore reuse the gate's proof.

**Also:** SNI-5; SNI-11 (low, lens 2: the walk exists in four places).

Low in this group (table at the end): SNI-9 (one machine, several valid encodings), SNS-7
(migrations tested only on synthesized stores), SNS-8, SNS-12 and SNS-13 (store failures classified
by construction site rather than by condition), SNS-9 (FileStore single-writer not enforced).
Checkpoint cost (SNS-1, SNS-2, SNI-7, SNI-8) is in the performance lens.

## Low-severity findings

| ID | Title | Note |
|---|---|---|
| BOOT-9 | Key-space exhaustion is reported as RangeError, `HeapExhausted`, `Decode(InvalidSymbols)` or `Refused` depending on the entry path | Deterministic per path; a supervisor misreads a full table as malformed bytecode. |
| CMP-9 | `'use strict'; 010` is accepted: the directive does not re-check a numeric token already lexed in sloppy mode | Only the first token after the directive; strings are re-checked correctly. |
| CMP-10 | `\u{100000041}` in an identifier wraps modulo 2^32 to `A` | The identifier escape reader accumulates with wrapping arithmetic; the string reader is bounded. |
| CMP-13 | Compile-time key canonicalization copies the VM's routines; non-ASCII identifiers lex about 5× slower per computron | Two copies that must agree byte for byte (`number_to_ecma_string`, `string_to_index`). |
| CORE-14 | A crafted `*_4` instruction length overflows `usize` on wasm32, panicking in `instruction_len`, dispatch and snapshot restore | Static; `opcode.rs:1092-1097`; the compiler never emits it; carrier is persisted bytecode. |
| COV-10 | `await` in a module-level class heritage halts `EngineInvariant` instead of the `module:top-level-await` refusal | The heritage's flag restore drops the AWAITING bit XS folds back (`rust/engine/ironhorse-compile/src/parser/stmt.rs:1846`, `:2019`); 24 test262 cases; full entry: `../COVERAGE.md`. |
| COV-15 | Direct eval takes its early-error context from XS's flags, not PerformEval | `eval('super()')` in a derived constructor and `eval('new.target')` in a method or generator throw SyntaxError; XS-faithful and tracked as `SHARED` rows in `rust/engine/ironhorse-262/tests/xs_departures.rs:660` (`rust/engine/ironhorse-vm/src/interp/eval.rs:56-71`); full entry: `../COVERAGE.md`. |
| COV-16 | A compartment's own `eval`, `Function` and `Compartment` are never frozen, even after `lockdown()` | Mutable and extensible on every host, including the frozen `Machine::new()`, where XS and SES freeze them, so a copy handed to a peer is shared mutable state (`rust/engine/ironhorse-vm/src/interp/realm.rs:150-176`); full entry: `../COVERAGE.md`. |
| COV-18 | The 280-raw key-allocation remainder is charged per property creation, not once per name as XS does | Deterministic calibration drift (the literal path inverts it for default keys); the comment at `rust/engine/ironhorse-vm/src/interp/metering.rs:80-93` claims per-site oracle agreement; full entry: `../COVERAGE.md`. |
| FN-16 | `for-in` materializes a fresh, unmetered chunk (four copies) per named key | O(key length) per step for an O(1) charge; the ceiling still stops it. |
| INT-4 | The ephemeral endo Machine shares a never-reclaimed key table across "fresh Realm" evaluations; a full table is reported as `Decode` | Latent: production runs one evaluation per process. |
| INT-9 | The crank goal differs: Eval on the endo seam, Script on the thixotrope IronHorse worker, sloppy try-wrapped eval on the XS worker | Affects host-authored boot scripts only; the worker's Script goal drops top-level `let` across cranks. |
| INT-10 | The oracle's 256-byte error buffer truncates with no flag | One false ironhorse-failure in the sweep (`with/...proxy-env.js`). |
| INT-12 | `endor run -e ironhorse` runs the engine on the main thread, outside `NATIVE_STACK_BYTES` | Debug builds or a small `ulimit -s` can SIGSEGV where `ReentryLimit` is expected. |
| MEM-9 | Per-row GC field lists are written three times (chunk walk, slot walk, root walk) with no subfield coverage check | A field added to one walk compiles and later dangles after compaction. |
| NOBJ-16 | `Set.prototype.intersection` re-checks membership in `this` after `other.has` | A mutating `has` drops elements (`2,3` where Node gives `1,2,3`). |
| NOBJ-17 | Map/Set iterators and `forEach` stop after `clear()` (XS purge model) while `delete` follows the spec | `clear(); add(9)` during iteration visits `1` only (spec `1,9`). |
| NVAL-14 | `Date.parse` normalizes illegal field values in conforming ISO strings instead of returning NaN | XS-parity fallback: `'2020-13-01'` parses as 2021-01-01. |
| NVAL-15 | `JSON.stringify` replacer-array dedupe is O(n²) and uncharged | 10,000 keys: 3.5 s for 297,065 computrons (meter table). |
| NVAL-16 | `String.fromCharCode`'s ToUint16 saturates for \|n\| ≥ 2^63 | `n.trunc() as i64`; `number_to_u64_wrapping` already exists. |
| PROP-9 | A Proxy's [[GetOwnProperty]] runs `IsExtensible(target)` after ToPropertyDescriptor | Observable order of traps and descriptor getters (`proxy.rs:465-467`). |
| RGX-6 | `run_bounded`'s step limit does not count matcher steps | An exponential regex hangs unmetered fuzz and test hosts; Node hangs the same way. |
| SNI-9 | KEYS content, `CREA.initial_slot_count` and format-15 restamps give one machine several valid encodings | CAS deduplication and hash identity fail; rewriting yields the honest bytes. |
| SNS-7 | Migration ladder steps are tested only on stores the current build synthesizes | All five real-bytes fixtures stop at the boot gate; failure is fail-closed. |
| SNS-8 | `check_succession` classifies batch-side defects (cadence, counters, schema stamp, non-canonical sections) as a Poisoned store | Should be `BatchRejected` (Refused); the stored state is intact. |
| SNS-9 | FileStore's single-writer contract is not enforced, and each commit reads the header twice unbuffered | Concurrent commits can lose an acknowledged epoch (reference backend only; SQLite enforces exclusion). |
| SNS-12 | A store schema this build cannot read classifies Poisoned, while an unreadable container version classifies Refused | After a rollback the supervisor is told to abandon a store a newer binary would resume. |
| SNS-13 | The SQLite backend reports stored-content damage and configuration refusals as `Io`, which classifies Transient | A supervisor retries permanent damage until its retry bound. |
| `StoreError::Io` (unnumbered) | `StoreError::Io` drops `io::ErrorKind`, so permanent medium failures on the FileStore and generic paths classify as Transient | The non-SQLite twin of SNS-13; its own doc comment acknowledges it (`rust/engine/ironhorse-snapshot/src/store.rs:161-168`); from `../COVERAGE.md`'s lost-content sweep. |
| T262-3 | An IronHorse hang in a module-goal case is attributed to the oracle | No current case is affected. |
| T262-6 | A compiler panic on a positive case is a skip, not a Fail | The `corpus_compiler_totality` gate catches compiler panics on test262 sources first. |

## Leads that did not survive

No finding was refuted at either pass.
These were lowered, or partly withdrawn, with the verifier's reason:

- BOOT-1, critical to high: the shipped consensus configurations freeze or lock down before the
  first checkpoint, and frozen holders skip materialization.
- CMP-3, high to medium: a refusal of an ES2022 feature, not a host panic or a common-path wrong
  result.
- CMP-4, high to medium: a line-for-line transliteration of XS's `fxCodeForInForOf`, confined to
  the new `for (using ... of ...)` form.
- CORE-3, CORE-4 and CORE-6, high to medium: dot access and internal flag readers are correct;
  the global prototype is host-defined per spec; the no-in-crank-collection policy is documented
  and its halt deterministic.
- MEM-1, high to medium: `RECLAMATION.md` documents the decision, and the halt is loud,
  deterministic and stricter than the bound, not looser.
- INT-2, high to medium: no production caller catches the unwind, so the persistent-state
  corruption is latent.
- PROP-2, high to medium: `ARCHITECTURE.md:349-353` documents the monotone key budget.
- BOOT-2, high to medium: both triggers need a runtime-only name colliding with an intrinsic member
  and an unusual observer.
- RGX-2 and RGX-3, high to medium: dot access and destructuring work; the RegExp special case
  cannot be redirected, so no escape.
- NVAL-4 and NVAL-5, high to medium: the main access paths work; collation order is
  implementation-defined, leaving only two option divergences.
- SNI-1 to SNI-4, high to medium: crafted containers are host-supplied input and no production
  path adopts them (SNI-4 was raised to high by pass 1 and returned by pass 2).
- NOBJ-5, raised to high by pass 1 and returned to medium: length-proportional string comparison
  is uncharged engine-wide and XS-inherited; the site adds a 20-30× constant.
- T262-7, raised to high by pass 1 and lowered to medium as a deterministic refusal; it is merged
  into RGX-1, whose own pass 2 upheld high on common-path grounds, and this lens follows the merge.
- T262-1 and T262-2, high to medium: harness measurement and a less common embedder path.
- RGX-6, medium to low: Node and XS hang on the same exponential pattern; only `run_bounded`'s
  documentation gap remains.
- INT-4, INT-9, BOOT-9, T262-3 and T262-6, medium to low: latent, reachable only from
  host-authored boot scripts, deterministic per path, or caught by another gate.
- NOBJ-7 (lens 4), medium to low: its `HeapExhausted` symptom is the quiescent-only collection
  policy and reproduces with plain allocation churn.
- Partly withdrawn claims: NOBJ-15's "about 445 MB at the ceiling" (an array pushed to the ceiling
  halts at about 240 MB; the charge swings between 32 and 64 B per item against 55.6 B host, so it
  is not a bypass); FN-9's escape (native compartments keep injected code in the guest's own
  compartment; the escape is CMP-1's shim path); CMP-2's "only computrons bound it" (the source is
  also bounded by the chunk ceiling); NOBJ-11's per-iteration caps (unreachable today because
  NOBJ-1 fires first); PROP-1's interning of indices returned by `ownKeys` traps (only non-index
  strings are interned); RGX-3's `JSON.stringify` scenario (arrays serialize only indexed
  elements); NVAL-5's accent-sensitivity row (IronHorse agrees with Node); the 485 MB RSS first
  attributed to NOBJ-5's sort (it arises in end-of-run processing, see below); SNS-1's suspected
  widening through a guest `new Compartment()` (that heap refuses to checkpoint).

Region reviewers also checked these and found them sound:

- Nondeterminism: no order-sensitive iteration of a `RandomState` map in any region; capture
  functions, GC roots, chunk offsets, finalization order, global hoisting and the boot fingerprint
  are all sorted; time sources are constant; NaN payloads are canonical.
- Native stack: every deep-source shape is a catchable compiler `SyntaxError`, including through
  `eval` and `Function`; the regexp parser, measurer, emitter and matcher and every snapshot
  decoder are iterative; compiling at the VM's deepest re-entry fits the 8 MiB release thread.
- Integer arithmetic: every `i32::MIN` operation other than DECREMENT is correct (16 probed);
  branch targets, `expect` sites and stack indexing in dispatch are guarded.
- Persisted bytes: decoder allocations are clamped, offsets use `checked_add`, the slot codec
  canonicalizes NaN and no address enters the bytes.
- Store: no torn epoch is reachable on either backend; SQLite single-writer exclusion is enforced
  and tested; migration lands in one compare-and-swap; free-segment diffing is exact; the partial
  collector over-approximates the full mark set.
- Keys: no guest-reachable poison latch was found; every exhaustion probe produced a catchable
  RangeError.
- Collection safety: Rust-local vectors in natives are safe because collection is quiescent-only;
  WeakRef targets are kept during jobs for the same reason.
- Charging: `enter_construct_bound`'s quadratic copy is charged quadratically; BigInt literal
  conversion is charged per digit; Map/Set delete is amortized O(1); `shift`/`unshift`, URI coding
  and base64/hex are charged per unit; `PersistentMachine`'s meter arithmetic saturates.
- Parsers: a fuzz-style probe over 11 Temporal, Date and Intl parsers produced no panic.
- XS-faithful behaviors kept by design: the cross-plane case-fold over-match under `/iu`, and the
  `ReentryLimit` halt for cyclic `[a].join()`.
- Divergences from Node where IronHorse is right: `Object.isFrozen(Object.preventExtensions([]))`
  is false (`length` is writable), and `Object.seal` of a TypedArray and `preventExtensions` of a
  length-tracking TypedArray throw (ES2024).

## What this lens did not cover

- The three leads handed between regions and never numbered are now settled by the coverage review
  (`../COVERAGE.md`, "Unverified leads").
  `break` out of `for await` over an async generator finishing one tick late
  (`../probes/vm-core-dispatch/p8c.js`) is FN-7, whose scenario now includes it and `return()` at
  a `yield`.
  `eval("super()")` in a derived constructor throwing `SyntaxError: invalid super` on
  `ironhorse-xst` (`../probes/vm-core-dispatch/p11_super.js`) is COV-15.
  The rise in peak RSS from 10.9 MB to 485 MB when a 5,000-element array of references to one
  100,000-character string is live at normal completion
  (`../probes/verify/vm-natives-objects/v5.js` against `v6.js`, `v7.js`) is COV-3: the host renders
  that completion value as 500,004,999 bytes of text.
- wasm32: nothing was built or run for wasm32, so CORE-14 and the wasm-trap consequences of
  infallible allocation (CMP-2, CORE-5, MEM-3) are static.
- XS behavior: no XS binary was available in most regions; "XS shares this" claims come from
  reading `c/moddable/xs/sources`, except where the oracle was run directly (the `oracle_probe`
  shim and the `typeof Temporal` guard technique through `endot-ih`).
- The SES shim end to end: CMP-1 reproduces the shim's two validation calls but did not run a
  built `ses` bundle.
- `rust/endo` did not build here (a generated `ses_boot.js` is missing), so INT-2's persistence
  half rests on an exact-call mirror.
- Replica agreement was tested only as live-versus-resumed twins on one host; no run compared hosts
  with different memory sizes or libm builds, and the `deterministic-math` feature was not
  exercised.
- Async results: `ironhorse-xst` does not surface errors thrown in jobs, so async outcomes were read
  through a binary-search oracle or Rust probes; Node lacks Temporal, `AsyncDisposableStack` and
  `using`, so those comparisons are against the spec text.
- Hardened JavaScript: beyond CMP-1 and the boundary notes in the first section, `lockdown` and
  `harden` fidelity was not examined, and both test262 sweeps ran with `ses_mode` none.
- Dispatch as a decoder of untrusted bytecode was not re-audited beyond CORE-13 and CORE-14; the
  bytecode-decoder fuzz target runs on 64-bit hosts only.
- Annex B (CMP-12), modules (BOOT-7, BOOT-8), Atomics and proper tail calls are refusals covered by
  the skipped-features lens; duplication and pure performance findings are in their own lenses.
