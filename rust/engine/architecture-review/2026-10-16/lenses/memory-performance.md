# Lens: performance and memory overhead

Reviewed commit `61cd656cb`.

The question: where does IronHorse spend memory and time it need not, with emphasis on the
resident cost of each object, each value, each function and each heap, and what would recover
it?

The short answer.
A plain object in the slot arena costs about what it costs in XS (one 24-byte slot against XS's
32-byte one), but nearly everything else a JavaScript program allocates lives in Rust side
tables beside the arena, and those dominate.
A pending promise costs 1,578 host bytes, an arrow closure 490, an array item 55.6 and a Map
entry 127, against 57, 105, 6.8 and 37 in Node.
Collected memory is never returned to the host, garbage is not reclaimed within a crank, the
thixotrope worker never collects at all, and freed slots are written into every container.
On the time side, a user call pays about 1,600 instructions of SipHash and three to five
allocations, every ordinary `o.k` read builds a heap string, every computed key runs a catch-up
scan that makes `o[k]` about ten times slower than `o.k`, and arithmetic has no integer fast
path.
On the daemon path every checkpoint re-encodes and hashes the whole small state, and one touched
element rewrites its whole side table.
Most of the recoveries are host-only and change no bytes; some move where cranks halt (a release
change in this repository's terms, `rust/engine/CHANGELOG.md:3-12`) and a few need a container
format or store schema bump.
The ranked table at the end says which.

## Method

- **Builds.**
  JS probes ran on the release `rust/engine/target/release/ironhorse-xst`.
  Rust probes ran as temporary integration tests built `--release` in a separate target directory
  and were deleted afterwards; their sources are under `../probes/`.
  Two measurements came from debug builds and are marked where cited: the property-index memory
  (allocation sizes do not depend on the build) and the snapshot map's first SNI-5 and SNI-6
  timings (re-run in release by the verifier).
- **Type sizes.**
  `size_of` printed by Rust probes: `SIZE Slot=24 Payload=16 Kind=1 SlotIndex=4 ChunkOffset=4
  Interp=6080 SlotArena=520 ChunkArena=192` (`../probes/vm-memory-gc-meter/probe1_ab.out`) and,
  for the compiler, `SIZE Node=80 Item=32 Value=32 Lexeme=168`
  (`../probes/compile/zz_audit_compile_1.release-output.txt`).
- **Resident cost per unit.**
  A counting global allocator in the Rust probes: build n units and keep them live (100,000, or
  10,000 to 20,000 for heavier units), then report host heap bytes, slots, chunk bytes and
  side-ledger bytes per unit.
  Where the units are kept in a holder array, the figure includes the holder's array item
  (55.6 B); "net" subtracts it.
- **Whole-process memory.**
  Peak RSS of `ironhorse-xst` runs, sampled from `VmHWM` in `/proc/<pid>/status` every 50 ms
  (`../probes/vm-memory-gc-meter/run.sh`) or read from `getrusage(RUSAGE_CHILDREN)`
  (`../probes/compile/maxrss.py`, `../probes/regexp/rss.py`).
- **Time.**
  Wall time on a shared 4-vCPU host is load-dependent (verifiers saw 2-3× spreads between runs),
  so it is set against computrons, which are build- and load-independent.
  The interpreter baseline is 35-42 ns per computron (release `baseline_int_loop_1e6`: 22,500,034
  computrons in 0.79 s, `../probes/vm-memory-gc-meter/probe3.out`).
  Instruction counts are callgrind marginals, (Ir at 20,000 iterations − Ir at 10,000) / 10,000
  (`../probes/verify/vm-core-dispatch/cg/`); allocation counts come from valgrind's heap summary.
- **Baselines.**
  Node 22 with `--expose-gc`: the `heapUsed` delta per unit after `gc()`, including the holder
  array's slot (`../probes/vm-memory-gc-meter/node_units.js`,
  `../probes/verify/vm-memory-gc-meter/node_prom.js`).
  XS was not run.
  Its column is an estimate: XS's documented 32-byte `txSlot` (the unit
  `SlotArena::xs_accounted_byte_size` reports, `rust/engine/ironhorse-vm/src/value.rs:1445-1460`)
  times the slots XS would use, plus chunk bytes where relevant.
- **Verification.**
  Every finding went through two adversarial passes; final severity is pass 1's, lowered to pass
  2's where pass 2 was lower.
  Numbers are the verifier's where they differ from the map's.
- **test262.**
  No finding in this lens decides a test262 verdict.
  MEM-1 contributes to, but does not decide, the 452 `ironhorse-aborted-limit` cases in
  `built-ins/RegExp`, which RGX-1 decides (`../lenses/test262-conformance.md`).

The repository's own instrument (`rust/engine/benches/README.md:229-251`) reports the engine at
0.2× XS's heap on property, call and string work and 2.5× on allocation churn.
It measures the slot arena only (`xs_accounted_byte_size` and `resident_byte_size`), so the side
tables and the chunk arena, which hold most of the bytes below, are outside both figures.

## Measured footprint

Resident host bytes per unit, release build, counting allocator.
"Net" removes the 55.6-byte holder array item; Node includes its holder array's slot.

| Unit | IronHorse host B (net) | Slots | Chunk B | Node 22 B | XS est. B |
|---|---:|---:|---:|---:|---:|
| Empty object `{}` | 89.2 (33.6) | 1 | 0 | 65 | 32 |
| Object with 4 properties | 191.8 (136.2) | 5 | 0 | 65 | 160 |
| Linked-list node with 1 property (no holder) | 67.6 | 2 | 0 | — | 64 |
| Class instance, 2 public fields | 138.4 (82.8) | 3 | 0 | — | 96 |
| Class instance, 2 private fields | 203.8 (148.2) | 1 | 0 | 49 | 96 |
| Short string `'s' + i` | 84.2 (28.6) | 0 | 21.8 | 33 | ~24 |
| Arrow closure over a `let` | 489.7 (434.1) | 6 | 4 | 105 | ~200 |
| IIFE closure, before collection | 1,294.2 | 14 | 8 | — | — |
| `f.bind(null)` | 475.2 (419.6) | 1 | 18 | 121 | — |
| `new Error('x')` | 373.4 (317.8) | 2 | 12 | 713 | — |
| RegExp literal `/ab+c/g` | 592.0 (536.4) | 2 | 18 | 65 | — |
| Object with an own getter, before collection | 777.3 (721.7) | 7 | 18 | — | — |
| Pending `new Promise(() => {})` | 1,578.1 (1,522.5) | 9 | 8 | 57 | ~400 |
| `p.then()` on one pending promise | 931.9 | 3 | 4 | — | ~380 |
| Suspended async call | 1,570.9 (1,515.3) | 4 | 4 | — | — |
| Suspended generator | 1,094.4 (1,038.8) | 10 | 4 | — | — |
| Map entry, integer key and value | 127.1 | 0 | 0 | 37 | ~72 |
| Map entry, string key | 155.8 | 0 | 21.8 | — | — |
| WeakMap entry, with its key object | 254.5 | 1 | 0 | — | — |
| Array item, small integer | 55.6 | 0 | 0 | 6.8 | 32 |
| Property of an object with an index (more than 32 properties) | 234.3 | 1 | 0 | — | 32 |
| Property of an 8-property object, object and holder included | 48.8 | 1.1 | 0 | — | 32 |

Sources: `../probes/vm-memory-gc-meter/probe1_ab.out` and `probe2.out`; the two property rows
from `../probes/vm-property-model/rust_probe_2.log` (debug build); Node from
`../probes/vm-memory-gc-meter/node_units.js`.
Plain objects are competitive.
Most kinds whose state lives in a side table are 3 to 27 times Node's size (an `Error` is the
exception, at about half) and, by estimate, 1.7 to 4 times XS's.

Cross-checks and what the ceilings see:

- **RSS.**
  100,000 pending promises (`../probes/verify/vm-memory-gc-meter/prom100k.js`) peak at 166,572 KB
  against 11,856 KB for 100,000 `{}` (`obj100k.js`): about 1.55 KB per promise beyond an empty
  object, matching the allocator.
  Node measures 57.2 B per promise (`node_prom.js`).
- **Charged versus resident.**
  An array item is charged 32 B times its capacity class: 32.0 B per item at exactly 262,144
  items and 64.0 B at 262,145, against 55.6 B resident; Map entries are charged 96 B against
  122.1 B resident (`../probes/verify/vm-natives-objects/rust_verify1.out`).
- **Per slot.**
  `rust/engine/WASM-MEMORY.md:34-38` sizes isolates at about 50 B of wasm32 memory per slot of
  slot ceiling (114 B at an eager restore).
  The functions map measured host bytes per slot of 54 for a two-property object, 153 for an
  arrow, 335 for `new Promise(exec)`, 491 for a pending async call and 600 for a bound function
  (`../maps/vm-functions-async.md`, FN-3), so promise- and closure-heavy heaps reach 3 to 11
  times the documented footprint at the same slot ceiling.
- **Boot.**
  `Interp::new` allocates 327 KB of heap; linking a tiny program brings it to 366 KB and 1,100
  live slots; dropping an `Interp` leaves 63.6 KB of one-time process state, not per machine.

### Slot and per-slot bookkeeping (CORE-11)

`Slot` is `{ next: SlotIndex(u32), id: u16, flag: u8, kind: Kind(u8), value: Payload }`
(`rust/engine/ironhorse-vm/src/value.rs:617-629`).
`Payload` is an eight-variant Rust enum whose largest arm is `f64` (`value.rs:563-580`), so it
carries its own one-byte discriminant and seven bytes of padding: 16 B, making `Slot` 24 B.
The discriminant repeats `kind`; with an untagged 8-byte payload the slot would be 16 B.
The arena adds per-slot `Vec<bool>`s, one byte per bit: `free_marks` and `marks`
(`value.rs:863`, `:868`), and `watched_slots` and `owner_slots` in the embedded property index
(`rust/engine/ironhorse-vm/src/property_index.rs:31`, `:35`); and a `free: Vec<u32>` list
(`value.rs:844`) that never shrinks (3.2 MB after 800,000 slots were reclaimed).
A slot in a growing arena measured 33.6 B resident including vector growth slack.
`Slot` is also the value type outside the arena (the value stack, bound arguments, collection
entries, array items, saved frames), where `next` and `id` carry nothing.

### Side-table rows (MEM-6, FN-3)

`Interp` is 6,080 B as a struct and holds 46 `HashMap<SlotIndex, _>` tables with SipHash
`RandomState`, plus pair-keyed maps for accessors and private elements.

| Row | Cost | Where | Source |
|---|---|---|---|
| Array item in `ArrayData.items: BTreeMap<u32, Slot>` | 55.6 B resident; charged 32 B per capacity-class slot (32-64 B per item) | `rust/engine/ironhorse-vm/src/bulk.rs:159-185`; `side_storage.rs:45`, `:93-97` | MEM-6, NOBJ-15 |
| Map or Set entry (`CollEntry` 56 B + 40 B index, declared) | 122-127 B resident; 96 B charged | `bulk.rs:476`; `side_storage.rs:47-51` | MEM-6 |
| `FuncInfo` | name kept as a `String` beside `name_chunk`; inline `Option<HostFunctionData>`; a separate `func_segments` entry per instance | `interp.rs:843-905` (`name` at `:880`); `interp/dispatch.rs:2212` | CORE-12 |
| Resolving-function pair | two full `FuncInfo` rows, two `PromiseFnData` rows and a guard: `new Promise(exec)` is 1,004 B for 3 slots | `interp/natives/promise.rs:137-203` | FN-3 (map probe) |
| `PromiseData.reactions` | the first push grows the vector to 4 × 112 B = 448 B | `interp.rs:1201-1214` | functions map inventory |
| `SavedFrame` | four `Vec`s per suspended frame; an inline `Option<SavedFrame>` of about 200 B per generator or async row, kept after completion until collection | `interp.rs:2313-2336` | MEM-6; functions inventory |
| `ErrorInfo.frames` | one cloned `String` per live frame | `interp.rs:1567-1576` | FN-2 |
| Accessor pair | outside the property slot, est. 64-130 B per accessor | `interp/state.rs:2486` | property inventory |
| Private field | keyed by `(receiver, private name)`, about 40 B and a hash per field, against one XS slot | `interp/state.rs:1368` | core inventory |
| Interned name | stored twice (`symbol_names` and `symbol_ids`), about 73 B per name | `interp/property/keys.rs:126-150` | property inventory |
| FinalizationRegistry cell | 32 B, charged to nothing | `interp/natives/weak.rs:190-204` | NOBJ-6 |

Paths in this table are under `rust/engine/ironhorse-vm/src/`.
"Inventory" rows were measured or derived by a region map and not separately verified.

### Property index (PROP-3)

A named-property chain longer than 32 nodes gets a derived index: per owner a
`HashMap<u16, SlotIndex>` and a node vector, and per indexed node a
`Watched { id, next, owners: HashSet<SlotIndex> }` entry (`property_index.rs:7-18`).
On a 20,000-property object whose names were already interned, a property costs 234.3 B,
against 48.8 B per property on 8-property objects that have no index: about 210 B per property
above the 24-byte slot (debug build; allocation sizes do not depend on the build).

### Functions and the dead default prototype (CORE-12, FN-15)

Slots and chunk bytes per creation (`../probes/vm-core-dispatch/zz_audit_vmcore_1.rs`, output in
`../maps/vm-core-dispatch.md`):

| Created 1,000 times | Slots | Chunk bytes |
|---|---:|---:|
| arrow | 4,006 | 6,004 |
| arrow, in a program that names `constructor` | 5,008 | 6,004 |
| method in an object literal | 6,006 | 10,004 |
| `function(){}` expression | 6,006 | 6,004 |
| `function someLongFunctionName(){}` expression | 6,006 | 44,004 |
| calls of a 3-local function | 12 | 10 |
| evaluations of an 8-character string literal | 6 | 20,004 |

Collection shows the dead part: in the functions map's PROTO probe (`../maps/vm-functions-async.md`)
an arrow drops from 5 slots to 3, a method shorthand from 7 to 5 and an async arrow from 5 to 3,
the two dead slots being the discarded prototype and its `constructor` slot; a plain function
keeps all 7.
An arrow with one capture holds 612.5 host bytes for its 4 slots.

### Boot and Machine (BOOT-6)

`Interp::new` takes 0.24 ms (verifier) to 0.56 ms (map) and leaves 797 live slots.
`Machine::new` boots, links about 2,000 names and hardens every primordial: 38 ms (verifier) to
90 ms (map), 3,173 live slots and 523 KB of RSS per Machine.
A compartment costs 76 slots and 92 µs.
A shared-machine restore builds two more complete Machines only to validate.

### Compile-time memory (CMP-2)

`../probes/compile/zz_audit_compile_1.release-output.txt` (counting allocator, peak bytes per
phase):

```text
PHASE arr0_1mb  src=1.00MB parse_peak=104.0MB tree=56.0MB  scope_peak=104.0MB compile_peak=311.1MB (x311) bytecode=6.44MB computrons=4587614  ns/computron=116.6
PHASE ids_1mb   src=1.00MB parse_peak=124.0MB tree=76.0MB  scope_peak=188.6MB compile_peak=343.1MB (x343) bytecode=6.44MB computrons=4685928  ns/computron=212.5
PHASE stmts_1mb src=1.00MB parse_peak=152.0MB tree=122.0MB scope_peak=202.5MB compile_peak=222.8MB (x223) bytecode=1.00MB computrons=2129992  ns/computron=362.4
```

The components: the source decoded to `Vec<u32>` (4 B per character); an `offsets: Vec<usize>`
(8 B per character) that only fills `Lexeme.start/end`, which nothing outside the lexer reads; one
boxed 80-byte `Node` per node and one `Vec<u16>` per identifier occurrence; the parser's stack,
still held after the tree is built (44 MB per MB of source); and one `Code` record of about 40 B
per opcode, all alive until serialization.
Scaling is linear: 4 MB sources peak at 891 MB to 1,372 MB.

### RegExp programs (RGX-4)

Program sizes, release (`../probes/verify/regexp/zz_audit_verify_2.rs`):

| Pattern and flags | Code bytes | Compile computrons | Compile wall |
|---|---:|---:|---:|
| `\p{RGI_Emoji}` with `v` | 257,716 | 6,390 | 4.02 ms |
| `a` with `v` | 44 | — | — |
| `[\0-\u{10FFFF}]` with `iu` | 6,516 | 417,824 | 40.35 ms |
| `\p{Lu}` with `iu` | 1,468 | 569 | — |
| `\p{Lu}` with `u` | 5,276 | 103 | — |

Every RegExp object holds its own compiled program; identical sources are not shared.
The matcher clones the whole capture vector for each backtracking state, about 95 B per state
(`(a)*` over 60,000 characters: 6.2 MB in 60,018 allocations; regexp map inventory).

## Memory findings

Findings about overhead, retention and reclamation, by final severity and then by theme.
The resource-bound defects that the correctness lens owns (no reclamation within a crank, host
memory outside every ceiling) are one-line cross-references at the end of this section.
CMP-2, RGX-4, NVAL-3 and PROP-3 also appear in that lens for the bound or meter they bypass;
their entries here are about the representation and what it costs.

| Theme | Findings |
|---|---|
| Per-object representation | PROP-3, MEM-6 (NOBJ-15), CORE-11, CORE-12 (FN-15) |
| Strings | NVAL-3, NVAL-17, FN-16 |
| Compile and RegExp memory | CMP-2, RGX-4 |
| Returning and compacting memory | MEM-7, MEM-8, NOBJ-7 |
| Boot | BOOT-6 |
| Containers | SNI-7, SNI-8 |

### PROP-3 — The property index costs about 210 B per property and rebuilds on delete (high)

An object whose named-property chain exceeds 32 nodes gets a derived `PropertyIndex`: a hash map
per owner plus, per node, a `Watched` entry with its own `HashSet`, about 210 B per property on
top of the 24-byte slot.
The index is invalidated wholesale: `delete o[k]` rewrites the predecessor's link (caught by
`synchronize`) and frees the node (`PropertyIndex::free`), and both routes drop the owner's
entire index.
The next miss on the object, such as the create in `o[k] = v`, re-collects and republishes all N
entries, allocating a `HashSet` per node, and `Walk::End` rebuilds are not throttled as
`Walk::Found` rebuilds are.
None of it is metered: the LRU or queue idiom on an 8,000-key object costs about 2.6 ms per
operation for about 10 computrons (about 2,800 times the host time per computron of ordinary
code), and the per-operation cost grows linearly with N up to the key ceiling.

**Where:** `rust/engine/ironhorse-vm/src/property_index.rs:7-18` (`Owner`, `Watched`), `:66-82`
(`free`), `:85-100` (`synchronize`), `:152-158` (`Walk::End` rebuild);
`rust/engine/ironhorse-vm/src/value.rs:1285`, `:1325-1350` (`find_property`);
`rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:1048-1137`.

**Evidence:** `../probes/prop/del/queue_8000.js`:

```js
// LRU/queue pattern: insert at tail, delete oldest, steady size 8000
var parts = []; for (var i = 0; i < 8000; i++) parts.push('"k' + i + '":' + i);
var o = JSON.parse('{' + parts.join(',') + '}'); var ks = Object.keys(o);
for (var i = 0; i < 4000; i++) { delete o[ks[i]]; o[ks[i]] = i; }
```

10.66 s on release `ironhorse-xst` (`queue_16000.js`: 20.96 s for the same 4,000 operations);
overwriting the same keys without `delete` (`../probes/verify/vm-property-model/p3_ctrl_8000.js`)
0.19 s; the same churn on a 30-key object (`p3_small_delete.js`) 0.086 s; Node about 50 ms.
Memory: `../probes/vm-property-model/rust_probe_2.log` reports 234.3 B per property on the
indexed object and 48.8 B on small un-indexed objects.

**Fix:** On a change to one watched node, unlink just that name from the owner's map and patch
the predecessor's link instead of dropping the owner; throttle `Walk::End` rebuilds like
`Walk::Found`; replace the per-node `Watched` entries and `HashSet`s with a per-owner
open-addressed `u16 → u32` table validated by a generation stamp (6-8 B per entry by the map's
estimate); charge chain walks beyond the linear prefix.
The index is derived ("No entry is a GC root or snapshot payload", `property_index.rs:2`), so
none of this touches a format.

**Also:** PROP-10 (SipHash dominates the rebuild); BOOT-4, PROP-4 (the probe's computed keys,
under 2% here); metering consequence in `../lenses/correctness.md`.

### NVAL-3 — String append copies the whole result four times into a fresh chunk per `+` (high)

Strings are flat UTF-16BE chunks.
`concat_add` decodes both operands into `Vec<u16>`s, joins them into a third vector, re-encodes
it with `units_to_be16` and appends the result as a new chunk, so every `s += c` makes four
copies of the whole result and leaves the previous result in the arena.
Nothing is reclaimed within a crank, so an append loop of n characters consumes about n² bytes
of chunk space and halts uncatchably at about 16,400 single-character appends under the 256 MiB
default ceiling (about 23,000 at the 512 MiB consensus maximum).
`Array.prototype.join` of 200,000 parts completes in 0.25 s, so the failure belongs to the
concatenation representation.
The uncatchable halt is written up in `../lenses/correctness.md`.

**Where:** `rust/engine/ironhorse-vm/src/interp/strings.rs:130-142` (`concat_add`), `:170-172`;
`rust/engine/ironhorse-vm/src/value.rs:15` (`DEFAULT_CHUNK_CEILING`).

**Evidence:** `../probes/verify/vm-natives-values/n3_concat_<N>.js`:

```js
let s = ''; for (let i = 0; i < N; i++) { s += 'x'; } if (s.length !== N) throw new Error('bad');
```

N = 16,000 completes in 0.31 s; N = 16,500, 17,000 and 20,000 print
`InternalError: ironhorse halted: HeapExhausted`; Node completes each in about 0.03 s.
The memory map's `concat_loop_16000` takes 0.30 s for 313,999 computrons, 960 ns per computron
against the 35 ns baseline (`../probes/vm-memory-gc-meter/probe3.out`).

**Fix:** Copy the two stored payloads straight into the new chunk: one copy instead of four, a
host-only change.
To remove the quadratic retention: a rope or concat-node string kind flattened lazily (a new slot
kind, so a container format bump), extending in place when the left operand's chunk is the
unaliased arena tail (a release change, since chunk allocation changes), or in-crank collection
(MEM-1).

**Also:** same root MEM-1, CORE-6, FN-12, INT-1 (`../lenses/correctness.md`); NVAL-17, FN-16
(string garbage per operation, below).

### CMP-2 — Compiling holds 220 to 345 bytes of host memory per source character (high)

One compile holds all of these at once: the source decoded to `Vec<u32>`; an offsets
`Vec<usize>` that exists only to fill `Lexeme.start/end`, which nothing outside the lexer reads;
a tree of boxed 80-byte `Node`s with a `Vec<u16>` per identifier occurrence (56-122 MB per MB of
source); the parser stack, still held after the tree is built (44 MB per MB); the scoper's
tables; and one `Code` record per opcode until serialization.
Peak host memory is 223 to 343 times the source size and linear in it; through a guest `eval`,
a 2 MB source peaks at 550 MB of RSS.
This matters wherever large sources are compiled inside a bounded instance: pass 2 notes that
under the recommended 4 MiB chunk ceiling and 128 MiB wasm instance, an `eval` of under 1M code
units already exceeds the instance.
None of it is charged to a ceiling and all of it is allocated infallibly; that bypass is in
`../lenses/correctness.md`.

**Where:** `rust/engine/ironhorse-compile/src/lexer.rs:146-187` (`chars`, `offsets`), `:37-48`
(`Lexeme`); `rust/engine/ironhorse-compile/src/ast.rs:137-207`;
`rust/engine/ironhorse-compile/src/coder.rs:378-382`, `:744-753`; reached from
`rust/engine/ironhorse-vm/src/interp/eval.rs:90`.

**Evidence:** the phase table under "Compile-time memory" above.
`../probes/compile/maxrss.py` on release `ironhorse-xst`: `evalmem_base.js`, which only builds a
2,097,173-character source string, peaks at 29.9 MB; `evalmem.js`, which also runs
`(0, eval)(s)` on it, at 550.2 MB in 2.07 s; `evalmem2.js` (4M characters) at 1,094.3 MB.

**Fix:** Cut the constants: drop `offsets` and `Lexeme.start/end` (or use them for CMP-1 and
`Function.prototype.toString`), lex the `&[u16]` in place, intern identifier names, allocate
nodes in an arena with `u32` ids, release the parser stack before scoping, and emit code records
per function.
Then admit a per-compile allowance proportional to source length against the chunk ceiling
(correctness lens).
The bytecode must stay byte-identical, which the corpus totality gate and the compile
differential check; no format changes.

**Also:** CMP-5 (cover-grammar clones add uncharged allocation); CMP-1 (the unused offsets);
same root MEM-3.

### RGX-4 — Every RegExp keeps its own program; `\p{RGI_Emoji}` with `v` is 257,716 bytes (high)

Every RegExp object, including each evaluation of a literal, compiles its pattern and keeps the
resulting `Program` in the `regexps` side table; identical sources are not shared.
String-set classes are lowered into a disjunction subtree (`charset_strings_disjunction`), so the
15-character `\p{RGI_Emoji}` under `v` compiles to 257,716 bytes of code.
2,000 retained instances hold about 500 MB, against 11 MB for 2,000 `/a/v` and 43.7 MB in Node.
The program bytes are charged only as meter work and sit outside the chunk ceiling; that bypass
(about 4 GB per crank at the production 100M-computron limit) is in `../lenses/correctness.md`.
The snapshot does not carry programs: restore recompiles each row from its source and flags
(`rust/engine/ironhorse-vm/src/interp/persist.rs:1244-1280`), so sharing needs no format change.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:383-404`;
`rust/engine/ironhorse-regexp/src/compile.rs:2090` (`charset_strings_disjunction`),
`:1401-1460` (`charset_range` under `i`);
`rust/engine/ironhorse-vm/src/interp/persist.rs:1244-1280`.

**Evidence:** the program-size table under "RegExp programs" above.
`../probes/regexp/p14_retained_14.js`:

```js
const keep = [];
for (let i = 0; i < 2000; i++) keep.push(new RegExp("\\p{RGI_Emoji}", "v"));
throw new Error(String(keep.length));
```

501.5 MB peak RSS in 4.04 s; the `/a/v` variant `p14_retained_1.js` peaks at 11.0 MB; Node at
43.7 MB in 0.05 s.
Pass 2 measured 1,000 instances at 255.1 MB, about 244 KB per instance.

**Fix:** Share compiled programs between instances with the same source and flags
(`Rc<Program>` interned by `(source, flags)`), which also makes a literal in a loop compile once;
give string sets a dedicated matcher node (a trie or sorted list) instead of a lowered
disjunction; then count retained programs in `side_storage_charge` (correctness lens) with a
deterministic rule for shared programs, charged per instance or per distinct program and fixed in
the release.

**Also:** same root MEM-3; RGX-5 (per-exec subject re-encoding).

### MEM-6 — Per-object state lives in SipHash side tables and per-array B-trees (medium)

Exotic and function objects keep their internal state in 46 `HashMap<SlotIndex, Row>` tables
with the default SipHash `RandomState`; arrays keep their items in a `BTreeMap<u32, Slot>`;
values outside the arena are full 24-byte `Slot`s; `FuncInfo` duplicates the function name as a
`String` beside its chunk.
Measured: a pending promise 1,578 B, an arrow closure 490 B, a bound function 475 B, an array
item 55.6 B and a Map entry 127 B, against Node's 57, 105, 121, 6.8 and 37 B; 100,000 pending
promises peak at 166.6 MB of RSS.
The collector pays one hash lookup per map-shaped table for every marked slot (about 96 ns per
live slot marked).
The array part is the same defect as NOBJ-15: an item costs 55.6 host bytes against a charge of
32 B per capacity-class slot (32 B per item at exactly 262,144 items, 64 B at 262,145), access is
O(log n), and `shift`, `unshift` and `splice` rebuild the tree; an array pushed to the ceiling
halts at about 240 MB of RSS.

**Where:** `rust/engine/ironhorse-vm/src/interp/state.rs` (46 tables, for example `:536`, `:566`,
`:582`, `:2564`); `rust/engine/ironhorse-vm/src/bulk.rs:159-185` (`ArrayData`, `items` at
`:175`), `:476` (`CollEntry`); `rust/engine/ironhorse-vm/src/side_storage.rs:45`, `:93-97`;
`rust/engine/ironhorse-vm/src/interp.rs:843-905` (`FuncInfo`, `name` at `:880`), `:1567-1576`
(`ErrorInfo`), `:2313-2336` (`SavedFrame`).

**Evidence:** the footprint table above (`../probes/vm-memory-gc-meter/probe1_ab.out`,
`probe2.out`).
`../probes/verify/vm-memory-gc-meter/prom100k.js`:

```js
var keep = []; for (var i = 0; i < 100000; i++) keep.push(new Promise(function () {})); throw new Error('done ' + keep.length);
```

Peak RSS 166,572 KB, against 11,856 KB for the same loop with `{}`; Node `promise 57.2 B/unit`,
`object 65.2 B/unit`.
For the array part, `../probes/verify/vm-natives-objects/rust_verify1.out`:
`BYTES array_int_items_262144: host/unit=55.6 side-charged/unit=32.0`,
`BYTES array_int_items_262145: host/unit=55.6 side-charged/unit=64.0`,
`BYTES map_int_entries_131072: host/unit=122.1 side-charged/unit=96.0`; `n6_arr_12m.js` (12M
pushes) halts `HeapExhausted` at 239.8 MB.

**Fix:**
(a) Store dense arrays as a contiguous vector of values with a hole sentinel and a sparse B-tree
fallback (55.6 B to 24 B per item with today's `Slot`, 16 B with CORE-11).
(b) Give each exotic kind a dense `Vec<Row>` indexed from the slot (or one per-slot `u32`), or at
least an identity or Fx hasher for `SlotIndex` keys.
(c) Shrink the rows: drop `FuncInfo.name`; one compact row per resolving-function pair instead of
two `FuncInfo` rows; an inline first reaction in `PromiseData`; `ErrorInfo.frames` as ids;
`SavedFrame` as one boxed slice.
(d) A 16-byte value type outside the arena (CORE-11).
Report side-table bytes in the `benches` footprint instrument.
Row layout is host-only while rows are uncharged; the charged widths of array items and
collection entries are consensus state (`side_storage.rs:11-28`), so re-declaring them is a
release change.

**Also:** same defect NOBJ-15 (array items); same root MEM-3, FN-3 (the rows are uncharged,
`../lenses/correctness.md`); MEM-2 (row layout drives collector cost); MEM-7 (the maps are never
shrunk).

### CORE-11 — `Slot` carries two type tags: 24 bytes where 16 would do (medium)

`Payload` is a Rust enum whose discriminant sits beside an 8-byte `f64`, so `Payload` is 16 bytes
and `Slot` 24.
The discriminant repeats what `Slot.kind` already says, and every arm fits in 8 bytes (`At` is
6), so an untagged payload read through `Kind`-checked accessors makes `Slot` 16 bytes.
The free and mark bitmaps are `Vec<bool>`, a byte per bit, although the `free_marks` comment says
"one bit per record".
Resident cost is about 26 B per slot against about 16.25 B with a 16-byte slot and bitsets
(−37%, about 9.75 MB at the default 1M-slot ceiling), and every value held outside the arena
(value stack, bound arguments, array items, collection entries, saved frames) would shrink by 8 B
too.
The duplicate tag also makes invalid states representable (`Kind::BigInt` over a non-BigInt
payload), which code guards with `unreachable!` and `EngineInvariant`.

**Where:** `rust/engine/ironhorse-vm/src/value.rs:563-580` (`Payload`), `:617-629` (`Slot`),
`:863` (`free_marks`), `:868` (`marks`); `rust/engine/ironhorse-vm/src/property_index.rs:31`,
`:35`.

**Evidence:** `../probes/vm-memory-gc-meter/probe1_ab.out`:
`SIZE Slot=24 Payload=16 Kind=1 SlotIndex=4 ChunkOffset=4`; the source agrees ("The 16-byte value
payload", `value.rs:563`; "It is 24 bytes on the audited 64-bit build", `value.rs:617`); the
16-byte layout is static arithmetic (4 + 2 + 1 + 1 + 8).

**Fix:** Store the payload as a `u64` (or `[u32; 2]`) behind `Kind`-checked constructors and
getters in safe Rust, and make the four per-slot bitmaps bitsets.
The snapshot codec encodes fields individually (`value.rs:617-618`), so the container format does
not change.
The declared scratch and side-storage widths are asserted against `size_of` on 64-bit builds
(`rust/engine/ironhorse-vm/src/interp/admission.rs:11-53`), so `Slot`, `(u32, Slot)`, `CollEntry`
and their kin must be re-declared, which changes ceiling arithmetic (a release change), or the
declarations must be frozen at today's values independently of the layout.

**Also:** MEM-6 (d) (16-byte values outside the arena).

### CORE-12 — Functions allocate a dead default prototype and store the name three times (medium)

`new_function_with_prototype` allocates a default prototype object for every function instance
(and a `constructor` property slot when the program interns `constructor` anywhere) and records
it in `ctor_prototype`.
For the non-constructor opcodes (arrows, methods) and in `new_async_function`, the link is removed
at once, leaving one or two dead slots per closure until the crank ends.
XS allocates the default prototype only for `XS_CODE_CONSTRUCTOR_FUNCTION`; the comment here says
the allocation is kept to share metering with the constructor opcode.
Each instance also clones its name out of `symbol_names` into an owned `FuncInfo.name` `String`
(charged to no ceiling), copies it again as a UTF-16 chunk, and adds a `func_segments` entry
beside its `functions` row.
An arrow costs 4 slots (5 when the program names `constructor`) and a method 6, so the 1M-slot
default admits about 250,000 arrow creations per crank.
FN-15 (low on its own; merged into CORE-12, medium) reports the same defect from the functions
region, including async functions.

**Where:** `rust/engine/ironhorse-vm/src/interp/function.rs:314-378` (prototype at `:363`,
`constructor` link at `:370-377`, `ctor_prototype.insert` at `:378`, name at `:335-357`),
`:493-507` (`new_async_function`, removal at `:501`);
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:2088-2101` (`ctor_prototype.remove`), `:2212`
(`func_segments.insert`).

**Evidence:** the per-creation table under "Functions and the dead default prototype" above
(`../probes/vm-core-dispatch/zz_audit_vmcore_1.rs`) and the PROTO probe (arrow 5.00 slots per unit
before collection, 3.00 after).
`../probes/verify/vm-core-dispatch/c6_p21_arrow_churn.js` (300,000 arrow creations) halts
`HeapExhausted`.

**Fix:** For non-constructors, apply the calibrated metering constant without allocating; for
constructors, allocate the default prototype lazily on the first `.prototype` read, construction
or reflection, which is unobservable.
Keep the name once (the chunk, or an interned id) and drop `FuncInfo.name`; move `func_segments`
into `FuncInfo`.
Fewer slots per closure moves where cranks halt, so this ships as a release change; computrons
stay the same.

**Also:** same defect FN-15; CORE-6 (the dominant slot source in closure churn,
`../lenses/correctness.md`); CORE-7 (`func_segments` probes on every call).

### MEM-7 — Memory is never returned to the host after collection (medium)

After a collection the chunk vector is truncated but not shrunk; the slot record vector, the free
list and the per-slot bitmaps only grow; the side-table `HashMap`s keep their bucket arrays.
The only `shrink_to` calls in the crate are for collection entry lists and segmenter buffers.
A long-lived worker's RSS is therefore the peak of any crank it ever ran; Endo's ephemeral machine
wrapper reuses one machine across evaluations (`rust/engine/ARCHITECTURE.md:120-123`), so one
large evaluation pins its memory for the next.
Collection itself grows the heap by 3 to 4 MB: the free list it fills (3.2 MB for 800,000
slots) and a transient `HashSet` of swept indexes.
Separately, `alloc_array_buffer` builds a zeroed host `Vec` and copies it into the arena, so a
200 MB `Uint8Array` peaks at about 397 MB of RSS.

**Where:** `rust/engine/ironhorse-vm/src/value.rs:2818` (`truncate` without shrink), `:843-868`
(grow-only vectors); `rust/engine/ironhorse-vm/src/interp/gc.rs:110-133`, `:121` (swept
`HashSet`); `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2505-2508`.

**Evidence:** `../probes/verify/vm-memory-gc-meter/zz_audit_verify_1.rs` test `mem7_not_returned`
(`verify1.out`):

```text
MEM7 obj_churn_400k: boot=0.3MiB after_run=26.2MiB after_gc=30.2MiB reclaimed=800000 live_slots=1101 cap=801101 chunk_len 17184->17184
MEM7 closure_churn_150k: boot=0.3MiB after_run=72.7MiB after_gc=75.6MiB reclaimed=900000 live_slots=1102 cap=901102 chunk_len 1817184->17184
MEM7 promise_churn_100k: boot=0.3MiB after_run=117.7MiB after_gc=121.7MiB reclaimed=900000 live_slots=1102 cap=901102 chunk_len 817184->17184
MEM7 string_churn_50k_x1k: boot=0.3MiB after_run=176.3MiB after_gc=176.3MiB reclaimed=0 live_slots=1103 cap=1103 chunk_len 100696978->19188
```

`../probes/vm-memory-gc-meter/ta_write_pos_0.js` (a 200 MB `Uint8Array`) peaks at about
396,600 KB.

**Fix:** After collection, `shrink_to` the chunk vector and every side-table map whose length fell
below a quarter of its capacity (host-only).
Let the slot vector drop trailing free records by allocating from the lowest free index, or keep
the free list as the `free_marks` bitmap plus a cursor; the free-list order is serialized and
decides future allocation, so that part is a release change.
Replace the swept-index `HashSet` with the `free_marks` bitmap, add `ChunkArena::alloc_zeroed`
for buffers, and cap amortized arena growth at the ceiling.

**Also:** MEM-1 (within-crank garbage is what fills these vectors, `../lenses/correctness.md`);
MEM-8; SNI-8 (the same free records written into every container); MEM-6.

### BOOT-6 — `Machine::new` rebuilds the realm; shared restore builds two more to validate (medium)

Each `Machine` performs a fresh `Interp` boot, links the union of default keys, intrinsic names
and every roster member name through the allocating roster pass, and hardens every root, which
converts keys through `to_read_key` and so pays the BOOT-4 catch-up per key.
`Machine::new` took 38 ms in the verifier's run (90 ms in the map's; wall time is
load-dependent) and holds 523 KB of RSS, against 0.24 ms for `Interp::new`.
Restoring a shared machine starts from `Interp::new()`; `restore_shared_evaluators` then builds a
complete new Machine to copy evaluator templates, and `restore_shared_machine` builds another
solely to compare the default global and intrinsic roots: at least 76 ms of pure validation per
restore.

**Where:** `rust/engine/ironhorse-vm/src/interp/realm.rs:700`, `:725-892`;
`rust/engine/ironhorse-vm/src/interp/shared_persist.rs:216`, `:816`;
`rust/engine/ironhorse-vm/src/interp/restore.rs:56-61`, `:363-372`.

**Evidence:** `../probes/verify/vm-boot-realm-modules/zz_audit_verify_2.rs` (release):
`VERIFY machine_new_ms=38.1`, `VERIFY interp_new_us=235`.
The map's probe R1 (`../maps/vm-boot-realm-modules.md`): `AUDIT machine_new_us=89930
machine_live_slots=3173 chunk_bytes=17228`, `AUDIT rss_per_machine_kb=523`,
`AUDIT compartment_create_eval_us=92 slots_per_compartment=76.0`.
The integration map measured 48 ms for `Machine::new` in `endor run`
(`../probes/integration-fuzz-oracle/int8.out`).

**Fix:** Compute the reference root list and evaluator rows once per process (`OnceLock`, as
`boot_fingerprint` already is) and validate against them; build Machines by cloning a
process-wide frozen template `Interp`, checked against `boot_fingerprint`; fixing BOOT-3 and
BOOT-4 also shrinks link and harden time.

**Also:** BOOT-3, BOOT-4 (the dominant costs inside link and harden).

### SNI-7 — Eager restore peaks near 4.7 times the container size (medium)

The write path streams, but the read path materializes several whole copies.
`read_machine` copies `BLOC` into an owned `Vec`; the canonical check for format 16 and later
re-encodes the entire image into a fresh container (an `AtomWriter` body, then a second buffer in
`finish`) only to compare it with the input; and `image_to_interp` calls `try_to_arenas(&self)`,
which clones the slot vector, the free list and the chunk bytes while the owned image and the
caller's input are still alive.
For a 100,000-object machine (an 8.45 MB container) the peak is 4.67 times the container,
against a floor of about 2.6.
`rust/engine/WASM-MEMORY.md:38` names eager restore the costliest phase (114 B per slot), so this
lowers the largest heap an isolate can restore.

**Where:** `rust/engine/ironhorse-snapshot/src/image.rs:5405` (`BLOC` copy), `:5438` (re-encode),
`:5173-5245`, `:819-826` (`try_to_arenas` clones);
`rust/engine/ironhorse-snapshot/src/atom.rs:50-56`;
`rust/engine/ironhorse-snapshot/src/machine.rs:494-496`.

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test `v7_memory`
(release, counting allocator; `v7_memory.first.log`):

```text
[V7] container=8446403 B; read_validated_machine peak +30980412 B (3.67x); image held 10452780 B; image_to_interp peak incl image +24161084 B (2.86x); restored machine 13651992 B; overall peak incl input 4.67x
```

**Fix:** Compare canonical bytes through a comparing `Sink` sized by the existing `ByteCounter`
pass, so the check allocates nothing; add `MachineImage::into_arenas(self)` that moves the slots,
free list and chunks; optionally accept an owned input and split `BLOC` off.
Expected peak about 2.5 times the container; no format change.

**Also:** SNI-8 (free records inflate each copy).

### SNI-8 — Freed slot records are written into every container forever (medium)

The `HEAP` atom carries one 20-byte record for every slot up to the arena's high-water mark plus
a 4-byte free-list entry per free slot, and freed records are written with their stale content.
The collector frees slots onto the free list but never truncates the arena (MEM-7), so a vat that
once built and dropped a large structure pays for it in every later container, CAS blob and
restore, where the records become 24-byte `Slot`s again.
After building 50,000 objects, dropping them and collecting, 98% of the container is free
records and free list.
The free-list order decides future allocation and must be kept; the stale record bytes are dead,
since `alloc` overwrites them.

**Where:** `rust/engine/ironhorse-snapshot/src/image.rs:993-1012` (`encode_heap_into`);
`rust/engine/ironhorse-vm/src/value.rs:1277-1290` (`SlotArena::free`).

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test
`v8_free_and_canonical` (`v8_free_and_canonical.log`):

```text
[V8] before drop=3246398 B; after GC=2446366 B; slots=101104 free=100001 live=1103 (free records+list = 2400024 B); reclaimed=100001
```

**Fix:** Under a container format bump, omit free records from `HEAP` (the free list already
names them, and the reader fills `Slot::undefined()`), saving 20 B per free slot; short of that,
zero them at sweep time so they compress.
Longer term, truncate trailing free slots in the VM (MEM-7) so both costs go away, keeping the
free-list order deterministic.

**Also:** MEM-7; SNI-7.

### NVAL-17 — The empty string is not interned: every empty result appends a 4-byte chunk (low)

`new_string_units` says an empty result reuses an interned empty string, but it calls
`chunks.alloc(&[])`, which reuses a free chunk if one exists and otherwise appends a fresh 4-byte
header.
With no reclamation within a crank, each empty result (`slice(n, n)`, `charAt` out of range,
`trim` of whitespace, `'' + ''`) consumes 4 bytes of the ceiling for the rest of the crank, with
no chunk charge, and snapshots carry the dead chunks until the next collection.

**Where:** `rust/engine/ironhorse-vm/src/interp/strings.rs:113-118`;
`rust/engine/ironhorse-vm/src/value.rs:2506-2586`.

**Evidence:** `../probes/verify/vm-natives-values/n17_empty.js`:

```js
const s = 'a'; let n = 0;
for (let i = 0; i < 70000000; i++) { if (s.slice(1).length === 0) n++; }
throw new Error('done ' + n);
```

`InternalError: ironhorse halted: HeapExhausted` after 33.2 s (2^26 empty chunks of 4 bytes are
256 MiB); the control `n17_ctrl.js` (`s.length === 1`) completes in 16.6 s; Node completes both
in about 0.15 s.

**Fix:** Allocate one canonical empty-string chunk at boot, root it as the `typeof` atoms are
rooted, and return it from `new_string_units`, `concat_add` and every other zero-length producer
(or give `alloc` a zero-length fast path).
It changes chunk allocation, so it is a release change.

**Also:** same root NVAL-3, MEM-1.

### FN-16 — `for-in` makes a fresh chunk, by four copies, for every named key it yields (low)

For each named key the enumerator clones the `SymbolName`, copies its bytes, converts CESU-8 to
UTF-16 units and those to big-endian bytes, and allocates a new chunk; the step is charged only
`ENUMERATOR_NEXT_METERING`, and the comment says the allocation goes unmetered because XS yields
the interned key.
The chunks are garbage that cannot be reclaimed within the crank, so a loop over a long key
exhausts the chunk ceiling where XS and Node allocate nothing.
`Object.keys` and `ownKeys` allocate a fresh chunk per key per call the same way
(`property_key_slot`).

**Where:** `rust/engine/ironhorse-vm/src/interp/enumerate.rs:306-327`;
`rust/engine/ironhorse-vm/src/interp/property/keys.rs:759-783`.

**Evidence:** `../probes/verify/vm-functions-async/p27_forin_long_key.js`:

```js
const k = 'k'.repeat(100000);
const o = {}; o[k] = 1;
let n = 0;
for (let i = 0; i < 2000; i++) { for (const key in o) n += key.length; }
throw new Error('completed ' + n);
```

IronHorse: `InternalError: ironhorse halted: HeapExhausted`; Node: `completed 200000000`.

**Fix:** Cache one string chunk per interned key id, rooted by the name table and shared with
`Object.keys` and the other key-to-string paths; at minimum reuse the chunk and charge per unit.
A release change, since chunk allocation changes.

**Also:** NVAL-3, NVAL-17.

### MEM-8 — Dead chunk blocks across extents are never coalesced; the full compactor is unused (low)

The collector compacts chunks with `compact_local`, which packs the blocks inside one 64 KiB
extent only when at least 25% of it is dead, and turns each dead block that crosses an extent
boundary into its own free marker without merging neighbours.
The best-fit free index works over individual markers, and interior holes still count against
the chunk ceiling, so programs that alternate large strings or buffers of growing size can strand
ceiling margin until the tail is freed.
The full sliding compactor `ChunkArena::compact` exists but only tests call it.
Guest code cannot trigger collection, so the impact depends on the host's collection cadence.

**Where:** `rust/engine/ironhorse-vm/src/value.rs:2711-2838` (`compact_local`), `:2846-2943`
(`compact`); `rust/engine/ironhorse-vm/src/gc.rs:233`.

**Evidence:** `../probes/verify/vm-memory-gc-meter/zz_audit_verify_1.rs` test
`mem8_fragmentation` (eight 100 KiB blocks with blocks 1-2 and 5-6 dead; a 20%-dead extent of
1,000-byte blocks):

```text
MEM8 crossing: before=819232 after=819232 moved=0 fit150K=false fit90K=true
MEM8 small20pct: before=60240 after=60240 moved=0
```

**Fix:** Merge adjacent free markers when writing them and when rebuilding the index; run the
existing `compact` when the hole total passes a threshold, or delete it.
Chunk offsets are persisted, so a new compaction policy changes heap bytes: a release change.

**Also:** MEM-7.

### NOBJ-7 — ArrayBuffer `transfer` and `resize` copy twice into a fresh chunk (low)

`transfer` allocates a new zeroed buffer (through `alloc_array_buffer`'s zeroed host `Vec` and
copy), copies the common prefix through a temporary `reserved_vec`, then detaches the source;
`resize` likewise builds a new chunk and leaves the old one for the collector.
Each operation therefore does two host copies and holds two chunks until the crank ends, where
the spec intends a move and XS renews the chunk by reallocation for `resize`.
Downgraded from medium: the `HeapExhausted` that a `b = b.transfer()` loop reaches is the general
no-in-crank-collection policy, which plain buffer and string churn reach too.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:378-431` (`transfer`),
`:438-460` (`reallocate_array_buffer`), `:2498-2519` (`alloc_array_buffer`).

**Evidence:** `../probes/verify/vm-natives-objects/n7_transfer_churn.js` (a 4 MB buffer,
200 × `b = b.transfer()`) and `n7_resize_churn.js` halt `HeapExhausted` where Node completes; the
controls `n7_alloc_churn.js` (200 × `new ArrayBuffer(4 << 20)`) and `n7_str_churn.js` halt the
same way.

**Fix:** Move the `ChunkOffset` to the result when the new length fits the source chunk, keep the
chunk on a shrinking resize, and add `ChunkArena::alloc_zeroed` plus an arena-to-arena copy to
remove the temporary host vectors; the changed chunk allocation is a release change.

**Also:** MEM-7 (`alloc_zeroed`).

### Resource-bound defects owned by the correctness lens

Each is written up in `../lenses/correctness.md`, "Resource bounds that do not bound".

| ID | Severity | One line |
|---|---|---|
| INT-1 | high | The thixotrope IronHorse worker never collects, so every crank's garbage is checkpointed and a long-lived vat eventually halts for good. |
| MEM-3 | high | Bound arguments, DisposableStack records, finalization cells and side rows escape both ceilings: 185.5 MiB held by 3,116 slots under the 128 MB profile. |
| FN-3 | high | Function, promise, activation and bound-argument rows are uncharged; one bound function made through a native `apply` holds about 24 MB. |
| NOBJ-6 | high | FinalizationRegistry cells (32 B each) are charged to nothing; 12 million registrations reach 372 MB and complete. |
| FN-2 | high | Error construction clones every frame's function name into uncharged memory: 391 MiB for 20 errors at depth 200 with 100,000-character names. |
| CORE-5 | high | Spreading into a native call grows the value stack without bound (about 470 MB for 20 spreads of 1M elements), and the stack is never shrunk. |
| MEM-1 | medium | Allocation never triggers collection, so the ceilings bound a crank's cumulative allocation, not its live set: 499,449 `{a: i}` or 166,483 closures halt. |
| CORE-6 | medium | A string literal allocates a chunk per evaluation (2n + 4 B) and a closure 4-6 slots, so garbage-only loops halt. |
| FN-12 | medium | Each `await` of a non-promise builds a full capability (3 slots, about 737 host B) that cannot be reclaimed within the crank. |

## Time findings

These findings change no result and no computron count; they set how many computrons per second
the engine delivers, how long a checkpoint takes, and what an import costs.
The reference point is one function-scoped loop iteration of `s = s + i`, about 2,200 x86
instructions.

| Theme | Findings |
|---|---|
| Calls | CORE-7, FN-11 |
| Property access and keys | CORE-8, BOOT-4 (PROP-4), PROP-10 |
| Arithmetic and dispatch | CORE-9 |
| Lexing | CMP-13 |
| Checkpoints and the store | SNS-1, SNS-2, SNS-3, SNS-5, SNS-6, SNS-11, SNS-9 |
| Container import and restore | SNI-5, SNI-6 |

### CORE-7 — A call costs about 1,600 instructions of SipHash and three to five allocations (medium)

A call classifies the callee by probing several SipHash side tables (`functions`,
`promise_functions`, `bound_functions`, `proxies`, `func_segments`), copies the arguments into a
fresh `Vec`, and moves `locals`, `args` and `id_map` into a `CallerState`, installing fresh ones.
Every `NEW_LOCAL` and `NEW_CLOSURE` then pushes onto `locals` and inserts into
`Rc::make_mut(&mut self.id_map)`, a per-frame `HashMap<u16, usize>` consulted only by by-name
resolution (`eval`, `with`, `EVAL_REFERENCE`, global lookups); ordinary bytecode addresses locals
by index, and each local slot already carries its name in `Slot.id`.
A call to `f(a) { return a }` adds about 4,200 instructions to a loop iteration, and each `var`
local in the callee about 1,600 more; for a three-local callee, hashing is about 1,630 and
`malloc` plus `free` about 495 instructions per call.
XS keeps arguments and locals on its value stack.

**Where:** `rust/engine/ironhorse-vm/src/interp/frames.rs:323-452` (`enter_call`; `id_map` taken
at `:408`, restored at `:577`); `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2522-2536`
(callee probes), `:1572-1582` (`exec_new_local`), `:2864-2876` (`exec_new_closure`);
`rust/engine/ironhorse-vm/src/interp/state.rs:87-91`;
`rust/engine/ironhorse-vm/src/interp/code.rs:80-98`.

**Evidence:** callgrind on `../probes/verify/vm-core-dispatch/cg/{loop,call0,call3}_*.js`; for
example `call3_10000.js`:

```js
(function () { function f(a) { var x = a, y = x + 1, z = y + 1; return z; } var s = 0; for (var i = 0; i < 10000; i++) { s = s + f(i); } })();
```

Marginal instructions per iteration: `loop` 2,204, `call0` 6,407, `call3` 11,150; per call in
`call3`, `hash_one` 1,204 and `sip::Hasher::write` 427, `malloc` 225 and `_int_free` 270.

**Fix:** Resolve the callee once with a single lookup that returns a callee class (user, native,
method, bound, proxy, promise) and keep the segment in `FuncInfo`; delete `id_map` and answer
by-name lookups by scanning `locals` by `Slot.id` (or build the map lazily when a frame first
evaluates `eval` or `with`); keep arguments and locals on the shared value stack, or pool the
buffers.
`SavedFrameRow` and the catch-jump rows persist the sorted map
(`rust/engine/ironhorse-vm/src/interp/persist.rs:2450-2480`): derive those rows from `locals` at
encode time, or drop them under a container format bump.
Keep computron charges identical and gate on the benchmarks.

**Also:** FN-11 (the same map's allocations); CORE-10 (the same map makes block exit O(frame
bindings), `../lenses/correctness.md`); CORE-12 (`func_segments`).

### FN-11 — The per-activation `id_map` costs two allocations per call and a copy per `try` (medium)

Every activation owns an `Rc<HashMap<u16, usize>>`.
`enter_call` and five suspension drivers move it out with `mem::take`, so `Rc::default`
allocates a fresh box each time, and the first binding insert allocates the table.
`CATCH` clones the `Rc` into its `CatchJump`, so the first binding inserted inside a `try`
deep-copies the whole map.
The map accounts for two allocations per call that has any binding (one for a binding-free call)
of the three to four per call in all; the rest are the argument `Vec` and the regrown `locals`.

**Where:** `rust/engine/ironhorse-vm/src/interp/state.rs:91`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:449` (`UNWIND` retain), `:1579`, `:2871`,
`:4635` (`CATCH` clone); `rust/engine/ironhorse-vm/src/interp/environment.rs:555`;
`rust/engine/ironhorse-vm/src/interp/frames.rs:408`;
`rust/engine/ironhorse-vm/src/interp/suspend.rs:55`, `:284`, `:475`, `:737`, `:952`.

**Evidence:** valgrind heap summary of `ironhorse-xst`, 10,000 iterations each
(`../probes/verify/vm-functions-async/v11_*.js`): loop only, 8,762 allocations and 972,020 B;
`f()`, 18,738 (+1.0 per call); `function f(){var x=1}`, 38,795 (+3.0); `f(a)`, 48,798 (+4.0,
about 268 B per call); `try { let x = i }`, 28,749 allocations and 2,453,207 B against 8,692 and
961,001 B for a plain block (+2.0 allocations and about 149 B per iteration).

**Fix:** Remove `id_map` as in CORE-7.
As a stopgap, hold it as `Option<Rc<…>>` or share one empty `Rc` so `mem::take` does not
allocate, and store only `locals_len` in `CatchJump` and `SavedJump`.

**Also:** CORE-7, CORE-10; FN-19 (five frame records move the same register set; duplication
lens).

### CORE-8 — Every `o.k` read builds and hashes a heap `SymbolName` for `"disposed"` (medium)

In `dispatch_get_property` the DisposableStack arm's guard is
`self.symbol_ids.get("disposed") == Some(&id) && …`, with the string-keyed lookup first.
`SymbolIds::get` takes `impl Into<SymbolName>`, and `From<&str>` encodes the string into a
`Vec<u16>` and then a `Vec<u8>`: two allocations and a SipHash on every evaluation.
Every `o.k` on an ordinary object falls through about a dozen brand-table probes (arrays,
wrappers, four Temporal tables, buffers, typed arrays, data views) to reach this guard.
`dispatch_get_property` costs about 1,930 instructions per read, 1,160 of them (60%) in
`SymbolIds::get`.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-203` (guard chain
`:15-347`); `rust/engine/ironhorse-vm/src/symbols.rs:22-27`;
`rust/engine/ironhorse-text/src/lib.rs:107-111`.

**Evidence:** callgrind on `../probes/verify/vm-core-dispatch/cg/prop_{10000,20000}.js`:

```js
(function(){ var o = {a:1,b:2,c:3}; var s = 0; for (var i = 0; i < 10000; i++) { s = s + o.c; } })();
```

4,250 instructions per iteration against 2,204 without the read; `dispatch_get_property`
inclusive 1,930 per read, `SymbolIds::get` inclusive 1,161.

**Fix:** Cache the ids at link time (`disposed_id`, `compare_id`) as `length_id` already is, or
put the cheap brand check first; better, give each exotic instance one class tag so an ordinary
object pays one check instead of about a dozen hashed probes.
Most of these arms disappear with CORE-3's accessor fix.
Metering is unchanged.

**Also:** CORE-3 (the brand shortcut chain, `../lenses/correctness.md`); PROP-10 (the by-value
lookup).

### BOOT-4 — Every computed string key runs a catch-up scan of about 70 allocating lookups (medium)

`install_pending_intrinsics` always ends with `missing_environment_global_bindings()`, even when
the name table has not grown: it iterates every standard global name and probes
`SymbolIds::get(&str)`, which allocates two vectors and hashes, then sorts and dedups.
`resolve_at_key`, `to_read_key` and `to_property_id` call it for every non-index computed string
key, so `o[k]`, `k in o`, `Reflect.get`, `Object.hasOwn`, `defineProperty` and each key of an
`Object.keys` conversion pay it.
200,000 computed reads take 2.23 s against 0.23 s for static reads while being charged only 14%
more computrons; `s += o[k]` costs about 9.2 µs per iteration against 0.15 µs for `s += o.alpha`
and 0.45 µs for `m.get(k)`.
PROP-4 is the same mechanism reported from the property-model region.
A floor guard alone is not a fix: the scan is unguarded on purpose because a compartment's global
bindings can be missing while the machine-wide floor has advanced.

**Where:** `rust/engine/ironhorse-vm/src/interp/link.rs:313-335`, `:1502-1537` (unconditional call
at `:1522`); `rust/engine/ironhorse-vm/src/interp/property/keys.rs:539`, `:676`, `:755`;
`rust/engine/ironhorse-vm/src/symbols.rs:24-26`.

**Evidence:** `../probes/verify/vm-boot-realm-modules/zz_audit_verify_2.rs` (release):

```text
VERIFY static_reads_200k seconds=0.229 computrons=4300049
VERIFY computed_reads_200k seconds=2.226 computrons=4900057
```

Callgrind on `../probes/verify/vm-property-model/p4_cg.js` (5,000 iterations of `s += o[k]`):
632,663,350 instructions, 94.81% under `install_pending_intrinsics`, 64.87% in
`<SymbolName as From<&str>>::from`, about 120,000 instructions per read.

**Fix:** Keep a per-environment "catch-up needed" flag or generation, set when a standard-global
name is interned or an environment is created or relinked, and skip the scan when clear;
pre-resolve the intrinsic name ids once; make `SymbolIds::get` allocation-free (PROP-10).
Install semantics must not change (BOOT-1 and BOOT-2 depend on when the passes run); computrons
are unchanged.

**Also:** same mechanism PROP-4; same root BOOT-3, BOOT-5 (`../lenses/correctness.md`); BOOT-6
(hardening pays this per key).

### CORE-9 — No integer fast path in `+`, `-`, `*`, `<`, and every opcode is decoded twice (medium)

`relational` calls `to_primitive` on both operands and then `to_number_value` on each, which
calls `to_primitive` again; `op_add` calls `to_primitive_default` twice before classifying; and
`binary_arith` goes through the same helpers.
So `i < n` and `s + i` on two Integers run about six coercion calls each, where XS tests
`XS_INTEGER_KIND` on both operands first.
The dispatch prologue decodes the opcode with `Opcode::from_u8`, then `encoded_instruction_len`
re-reads the byte and decodes it again.
Of the 2,204 instructions in an iteration of `s = s + i` (about 12.6 opcodes), about 850 (38%)
coerce operands that are already Integers and 156 (about 12.4 per opcode) repeat the decode.

**Where:** `rust/engine/ironhorse-vm/src/interp/coerce.rs:544-646` (`relational`), `:1019-1050`
(`op_add`), `:443-471` (`binary_arith`); `rust/engine/ironhorse-vm/src/interp/dispatch.rs:297-334`;
`rust/engine/ironhorse-vm/src/opcode.rs:1074-1105`.

**Evidence:** callgrind on `../probes/verify/vm-core-dispatch/cg/loop_{10000,20000}.js`
(`(function () { var s = 0; for (var i = 0; i < 10000; i++) { s = s + i; } })();`), marginal per
iteration: `dispatch_at_inner` 1,138; `to_number_value` 212; `to_primitive_with_hint` 176;
`encoded_instruction_len` 156; `relational` 153; `op_add` 118; `binary_arith` 97;
`exec_increment` 96.

**Fix:** Add (Integer, Integer) and (Number, Number) fast paths at the top of `relational`,
`op_add` and `binary_arith` that apply the same meter ticks as the slow path; make the instruction
length a 256-entry const table consulted once in the prologue, and pass the decoded opcode and
length to the arms.
Computron counts must not change; gate on the benchmarks and the XS differential.

### SNS-1 — Shared-Machine checkpoints encode and hash the whole small state every time (medium)

`Interp::snapshot_dirty_sections` returns `SnapshotDirty::all()` whenever `shared_compartments`
is set, and every `ironhorse_vm::Machine` sets it.
`checkpoint_to_store_core` then runs `small_state_of` over all 34 sections, encodes and hashes
each, and finds by digest comparison that nothing changed.
The daemon's `PersistentMachine` uses exactly this path and checkpoints after every crank by
default, so a worker holding one 100,000-element array pays about 13 ms of CPU per no-op crank,
against 0.21 ms for the same heap on the standalone path, and the cost is linear in the small
state.
No I/O is wasted (`sections_written=0`).
Neither `store_suite.rs` nor `checkpoint_scaling_bench.rs` exercises a shared Machine, so no test
or bench can see it.

**Where:** `rust/engine/ironhorse-vm/src/interp/persist.rs:4545-4551`;
`rust/engine/ironhorse-snapshot/src/machine.rs:1161-1176`;
`rust/engine/ironhorse-vm/src/interp/realm.rs:854`;
`rust/engine/ironhorse-vm/src/interp/shared_persist.rs:512`;
`rust/endo/src/ironhorse_engine.rs:922-929` (`checkpoint_every: 1`).

**Evidence:** `../probes/verify/snapshot-store/zz_audit_verify_1.rs` (release; `output.txt`):

```text
STANDALONE n=100000 noop median=0.000210s | small[0]++ median=0.029722s small_bytes=2400129
SHARED n=100000 noop median=0.012952s sections_written=0 small_state_total=2417385
SHARED n=1000 noop median=0.000398s sections_written=0 small_state_total=41385
```

**Fix:** Track section dirt on shared machines: mark the sections that hold shared environment,
realm and job state dirty when that state changes, instead of returning `all()`.
Add a shared-Machine arm to `store_suite::checkpoint_acceptance` and to
`checkpoint_scaling_bench.rs` asserting that a no-op checkpoint does not scale with small-state
size; a missed dirty bit would silently drop state at the next checkpoint, so that test is the
safety net.
No format change.

**Also:** SNS-2, SNS-3.

### SNS-2 — Each bulk side table is one section, so an O(1) change rewrites the whole table (medium)

Slot pages and chunk extents are dirty-tracked per row, but the side tables that hold most
JavaScript data (every array's items, every Map and Set entry, every function record) are each
one small-state section with one dirty bit.
Touching one element of one small array re-extracts and re-encodes every array's items: the
session hashes the section, `check_succession`'s `validate_batch` decodes and re-encodes it to
check canonicality, the SQLite backend hashes it again, and the whole payload is written.
With one 100,000-item array and one 1-item array, `small[0]++` writes 2,400,129 bytes and takes
about 30 ms against a 0.21 ms no-op: 24 B per array item, 56 B per function record and 40 B per
Map entry rewritten per touched table, per crank under the daemon's default cadence.

**Where:** `rust/engine/ironhorse-vm/src/snapshot_dirty.rs:141-146`;
`rust/engine/ironhorse-snapshot/src/machine.rs:1161-1176`;
`rust/engine/ironhorse-snapshot/src/store_sections.rs:206-233`;
`rust/endo/ironhorse-store-sqlite/src/lib.rs:207-225`.

**Evidence:** the probe above:
`STANDALONE n=1000 noop median=0.000217s | small[0]++ median=0.000456s small_bytes=24129` and
`STANDALONE n=100000 noop median=0.000210s | small[0]++ median=0.029722s small_bytes=2400129`.

**Fix:** Dirty-track bulk tables per owner and persist them as owner-keyed rows or fixed-size
segments, as free-list segments already are; the unused SQLite `side_tables` table (SNS-10) is a
ready home, but this is a store schema step with a migration.
Short term, with no schema change: skip the commit-time canonical re-decode for engine-built
batches (or make it debug-only), and pass the session's digest through `SectionUpdate` so the
backend does not hash again.

**Also:** SNS-1; SNS-10.

### SNI-5 — Duplicate-atom detection is O(n²) and runs before every other gate (medium)

`AtomReader::parse` splits the envelope into any number of atoms (8 bytes each at minimum) and
rejects duplicates with a pairwise scan, before `VERS`, `SIGN` and the canonical-order check,
although a valid container has at most 38 atoms and the canonical-order check already implies
uniqueness.
A crafted container of N empty atoms costs N²/2 tag comparisons before refusal: 6.1 s for a
1 MiB container in release, and an extrapolated 10 to 25 minutes for 16 MiB, on every import
path.
Containers the engine writes never hit it; the adoption-path consequence is in
`../lenses/correctness.md`.

**Where:** `rust/engine/ironhorse-snapshot/src/atom.rs:186-192`;
`rust/engine/ironhorse-snapshot/src/image.rs:5382-5395`.

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test `v5_atoms`
(release; n atoms with distinct tags, each refused with ``required atom `VERS` is absent``):
8,000 atoms 14.7 ms, 16,000 46.0 ms, 32,000 150 ms, 64,000 654 ms, 128,000 (1 MiB) 6.10 s.

**Fix:** Refuse more than `CANONICAL_ATOM_ORDER.len()` atoms in `parse`, or fuse the order check
into parsing so that each tag must advance a cursor in `CANONICAL_ATOM_ORDER` (O(38)).

**Also:** SNI-6.

### SNI-6 — The FUNC gate and restore walk each function row's body afresh: O(rows × body) (medium)

For every `FunctionRow` with a body, the roster's Functions gate walks the bytecode from
`body_start` to `body_start + body_len` with `instruction_len`, without memoizing by body, and
`restore_function_state` repeats the walk.
Distinct closures of one function legitimately share a body range, and a row costs about 67 bytes
on the wire, so F rows over one large body cost F full walks: about 4.5 ms per row per MiB in
release.
For an ordinary heap this is restore time proportional to closures times body size: at the
measured rate, an estimated 0.44 s for the gate alone per 100,000 closures of a 1 KiB function.
For a crafted container it is unbounded pre-validation CPU (`../lenses/correctness.md`).

**Where:** `rust/engine/ironhorse-snapshot/src/snapshot_roster.rs:1472-1504`, `:2060-2098`;
`rust/engine/ironhorse-vm/src/interp/persist.rs:1782-1801`;
`rust/engine/ironhorse-vm/src/interp/restore.rs:161-224`.

**Evidence:** `../probes/verify/snapshot-image-codec/zz_audit_verify_sni_1.rs` test
`v6_func_gate` (release; one 1 MiB body named by every row): 1 row 6.5 ms, 100 rows 0.44 s,
400 rows 1.79 s, 1,600 rows 7.19 s for a 1.2 MB container.

**Fix:** Walk each referenced body once: memoize the verdict per `(segment, body_start, body_len)`,
or walk each segment once and check that every body's bounds fall on instruction starts; share one
helper among the roster gate, the generator gate, `restore_function_state` and
`validate_suspended_cursors`, and let restore reuse the gate's proof.

**Also:** SNI-5; SNI-11 (four copies of the walk; duplication lens).

### PROP-10 — Key and name lookups allocate per call and hash with SipHash (low)

`SymbolIds::get(name: impl Into<SymbolName>)` converts by value, so a `&SymbolName` probe clones
the byte vector and a `&str` probe allocates.
`key_id_index` probes for every key, and `ordered_own_key_ids` calls it from `sort_by_key`, so an
own-keys call makes O(n log n) allocations.
`array_own_descriptor` builds `scalar_key_text(id)` as a `String` twice per probe and runs at
every array level of a missed property read.
A loop of `a.indexOf === undefined` on a 3-element array costs about 9,600 instructions per
iteration, 34% in `exotic_own_descriptor` and 16% in `hash_one`.

**Where:** `rust/engine/ironhorse-vm/src/symbols.rs:22-27`;
`rust/engine/ironhorse-text/src/lib.rs:107`, `:122`;
`rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-561`;
`rust/engine/ironhorse-vm/src/interp/property/indexed.rs:1083-1110`;
`rust/engine/ironhorse-vm/src/interp/property.rs:2362-2373`, `:2399-2415`.

**Evidence:** callgrind on `../probes/verify/vm-property-model/p10_cg.js`:

```js
(function(){ var a=[1,2,3]; var n=0; for (var i=0;i<20000;i++) { if (a.indexOf === undefined) n++; } })()
```

Against `p10_base.js` (no iterations): 198,468,991 against 7,232,008 instructions, about 9,560
per iteration; `exotic_own_descriptor` inclusive 34.4%, `BuildHasher::hash_one` 16.0%.

**Fix:** Implement `Borrow<[u8]>` (or a borrowed key type) for `SymbolName` and look up by slice;
cache per-id facts (is-index, index value) in a `Vec` indexed by id and compare ids against cached
ids instead of re-deriving text; use `sort_by_cached_key`; consider a fixed-seed Fx or AHash hasher
for these maps after confirming that no iteration order reaches a result (the reviewers found
none).

**Also:** BOOT-4, PROP-4, BOOT-3 (the same lookup is most of their cost); PROP-3.

### CMP-13 — Non-ASCII identifier characters are classified by a linear table scan (low)

`is_identifier_first` and `is_identifier_next` walk a delta-encoded table from its start for
every character.
ASCII exits immediately, but each non-ASCII identifier character costs up to about 1 µs while it
is charged only its source bytes (0.25 computron per byte), so identifiers of astral CJK
characters lex about five times slower per computron than ASCII.
The finding's other half, numeric helpers copied verbatim between the compiler and the VM, is in
the duplication lens.

**Where:** `rust/engine/ironhorse-unicode/src/lib.rs:134-175`.

**Evidence:** release `ironhorse-xst`, two runs each: `../probes/compile/cjk_ident.js` (one
1M-character identifier of U+2B740, 4 MB) 1.089 s and 0.962 s; `../probes/compile/ascii_ident.js`
(4M ASCII characters, 4 MB) 0.158 s and 0.219 s.

**Fix:** An ASCII fast path plus a binary search over prefix-summed ranges, or generate the table
from the same source as `ironhorse-regexp`'s property tables.

**Also:** CMP-10 and the duplicated helpers (duplication lens).

### SNS-3 — The checkpoint persist gate scans every function and promise reaction every time (low)

`checkpoint_to_store_core` calls `stored_unpersistable_row_at_checkpoint` before every commit.
Before its dirty-pages-only heap walk, it scans every promise reaction and pending reaction job
and classifies every entry of `functions` through `function_persists`, collecting the result into
a `BTreeSet`: O(functions + reactions) whatever the crank touched.
The doc comment justifies the full walk with "they are small state, re-serialized on every
checkpoint anyway", which has been false since sparse section writes (store schema 28).
Downgraded from medium: about 37 ns per function per checkpoint is minor beside SNS-1, and any
crank that creates a function already rewrites the whole Functions section (SNS-2).

**Where:** `rust/engine/ironhorse-vm/src/interp/persist.rs:688-723` (reaction scan), `:724-728`,
`:810-816` (`non_persisting_functions`), doc `:561-576`;
`rust/engine/ironhorse-snapshot/src/machine.rs:1084`.

**Evidence:** `../probes/verify/snapshot-store/zz_audit_verify_1.rs` (n closures held live; the
gate returns `None`): `GATE n=1000 median=0.000036s`, `GATE n=100000 median=0.003714s`.

**Fix:** Keep the doomed-function set and a count of non-carried reaction kinds incrementally (a
function's persistability is fixed at creation and ends only when it is collected), so the gate is
O(1) when both are empty; fix the doc comment.

**Also:** SNS-1, SNS-2.

### SNS-5 — Edge summaries and `gen_dirty` are kept on every commit for test-only collectors (low)

Each checkpoint derives an edge summary for every dirty slot page and, in SQLite, mirrors it into
the `edge_pairs` reverse index (a delete and an insert per page) inside the commit transaction.
The only consumers (`partial_collect`, `generational_collect` and four queries) have no non-test
caller; the daemon uses `full_collect`.
`gen_dirty`, a `BTreeSet<u32>` of every page shipped, is seeded with every page and cleared only
by a collection, so under the daemon's default `collect_every: 0` it grows to the page count
(about 40 B per page dirtied).
The summaries cannot simply be dropped: `check_batch` requires them with page rows and
`validate_store_content` checks them, so removal is a store-format decision.

**Where:** `rust/engine/ironhorse-snapshot/src/machine.rs:1129-1147`, `:1006-1007`,
`:1195-1197`, consumers `:1625-1809`; `rust/endo/ironhorse-store-sqlite/src/lib.rs:1191-1245`,
`:599-890`.

**Evidence:** static: a repository-wide search for the six consumer names outside `tests/`,
`store_suite.rs` and benches finds only definitions, the uncalled `SharedStoreSession` wrappers
(`machine.rs:3057-3064`) and an ignored bench; `machine.rs:1006-1007` seeds `gen_dirty` with every
page and `:1196` extends it per commit.

**Fix:** Wire a production consumer, or make summary derivation, `edge_pairs` maintenance and
`gen_dirty` optional store features that are off on the daemon path; at minimum stop accumulating
`gen_dirty` when no collector reads it.

**Also:** SNS-10.

### SNS-6 — Every SQLite point read re-reads the manifest and prepares two uncached statements (low)

`read_slot_page`, `read_chunk_extent` and `read_free_seg` each call `stored_manifest` first, which
runs `SELECT value FROM meta` and decodes the whole `StoreManifest`, then query the row; both go
through `Connection::query_row`, which in rusqlite 0.31 prepares the statement each time.
A lazy wake that faults 1,000 pages therefore compiles 2,000 statements and decodes the manifest
1,000 times.
The handle holds `locking_mode=EXCLUSIVE` for its lifetime, so a cached manifest would be sound.

**Where:** `rust/endo/ironhorse-store-sqlite/src/lib.rs:570-583` (`stored_manifest`), `:972-1004`,
`:1091-1104`.

**Evidence:** static: `lib.rs:977`
`if Self::stored_manifest(&self.conn)?.is_none() { return Err(StoreError::Empty); }` followed by
`self.conn.query_row("SELECT bytes FROM slot_pages WHERE page = ?1", ...)`; no `prepare_cached`
in the crate.
Not measured: the outer workspace was not built.

**Fix:** Cache the decoded manifest (or a committed flag) in the handle, refreshed by
`commit_verified` and `replace_for_migration`, and use `prepare_cached` for all point reads.

### SNS-11 — Daemon open decodes and re-encodes the whole small state twice (low)

`PersistentMachine::open` reads the full small state and decodes it only to test whether
`function_state.shared` is present, then drops it; the lazy resume reads and decodes it again in
`open_state`.
`SmallState::decode` re-encodes its result to check canonicality, so a wake does two full reads,
two decodes and two encodes of the small state, which holds every bulk side table (2.4 MB for one
100,000-item array).

**Where:** `rust/endo/src/ironhorse_engine.rs:1157-1166`;
`rust/engine/ironhorse-snapshot/src/machine.rs:1438-1439`, `:3182`;
`rust/engine/ironhorse-snapshot/src/store.rs:1349-1355`, `:2182-2203`.

**Evidence:** static: `ironhorse_engine.rs:1157` decodes the full small state for the
`function_state.shared` test; `store.rs:2203` decodes it again; `store.rs:1350-1352` re-encodes to
compare.
Magnitude not measured separately.

**Fix:** Decide the shared-profile check from the Functions section alone, or have the lazy resume
report missing shared state itself as a typed refusal.

**Also:** SNS-1.

### SNS-9 — FileStore loads the header twice per commit with unbuffered small reads (low)

`load()` reads the header straight from an unbuffered `File`: one `read(2)` per 12-byte directory
entry and one per 4-byte edge target.
`commit_verified` calls it twice, before verification and after the rename, so each commit
issues O(pages + edges) system calls twice on top of the by-design whole-store rewrite.
The finding's other half, an unenforced single-writer contract, is in the correctness lens;
FileStore is the reference backend, and production uses SQLite.

**Where:** `rust/engine/ironhorse-snapshot/src/store_file.rs:364-460` (`load`), `:323`,
`:625-633` (`commit_verified`).

**Evidence:** static: `store_file.rs:374-378` `read_u32` reads 4 bytes from the `File`;
`:416-420` reads 12 bytes per directory entry; `:448-452` loops `read_u32` per edge target; no
`BufReader` in the file.

**Fix:** Read the header through a `BufReader` and reuse the verified durable view after the
rename instead of reloading it.

### Meter amplification owned by the correctness lens

These natives do host work far out of proportion to their charge.
The fix replaces the algorithm and charges what remains; each is written up in
`../lenses/correctness.md`, "Work charged far below its cost".

| ID | Severity | One line |
|---|---|---|
| MEM-2 | high | Collecting after building 16,000 objects with own getters takes 3.75 s (100,000 plain objects: 12 ms): pair-keyed tables scanned per marked and per swept slot, WeakMaps rescanned per ephemeron round. |
| MEM-4 (same defect for sort: NOBJ-2) | high | `new Uint8Array(16e6).fill(7)` takes 3.5 s for 282 computrons (whole-prefix dirty marking per element); the default TypedArray `sort` is an insertion sort. |
| MEM-5 (same defect: NOBJ-4 b, c) | high | 40,000 WeakMap deletes take 5.1 s against 0.13 s for Map at equal computrons; `unregister` is O(cells). |
| NOBJ-3 | high | `union` of two disjoint 20,000-element Sets takes 1.64 s for 20,353 computrons (linear-list dedupe). |
| NOBJ-4 | high | `a.splice(a.length - 1, 1)` on 200,000 elements costs about 44 ms per call for about 39 computrons (tree rebuild). |
| NVAL-1 | high | `includes` and `indexOf` run a naive O(n·m) search: 2.8-3.1 s for 7 to 6,100 computrons. |
| NVAL-2 | high | BigInt multiply, divide and decimal conversion are quadratic with a linear charge applied after the work. |
| RGX-5 | high | Every `exec` re-decodes and re-encodes the whole subject: 27 ms per sticky `test` on a 4 Mi-unit subject. |
| BOOT-3 | high | Each novel computed key runs a whole-roster install pass: 2.86 s for 20,000 keys. |
| COV-3 | high | Crank completion values and uncaught throws are rendered into a host `String` by a walker bounded only by depth, outside the meter and both heap ceilings: a DAG of 25 arrays renders 2^24 leaves (184,549,375 bytes in 3.2 s, for the same 917 computrons as a 0.3 ms `void` control), and at n = 30 the host aborts on allocation failure (`rust/engine/ironhorse-vm/src/interp.rs:3223-3242`, `rust/engine/ironhorse-vm/src/interp/render.rs:41-96`; full entry: `../COVERAGE.md`). |
| NOBJ-5 | medium | Default `sort` copies both operands' strings per comparison, 20-30 times a comparator sort. |
| CORE-10 | medium | Block exit is O(frame bindings) through `id_map`: 279,000 instructions per iteration with 20,000 bindings. |
| CMP-5 | medium | Cover-grammar conversions deep-clone per nesting level: 6.7 s at depth 80 against 0.23 s at depth 1. |
| BOOT-5 | medium | Crank relink is O(table × crank names): 40.5 ms per crank at 50,000 runtime keys. |
| NVAL-13 | medium | `JSON.stringify` copies each nested container into its parent: O(output × depth). |
| COV-6 | medium | Each captured variable's append walks the environment's capture chain to its tail, unmetered: k(k−1)/2 slot reads per closure for a charge linear in k; 400,000 captures take 0.16 s at k = 125 and 4.1 s at k = 8,000, with computrons flat at about 3.2M (`rust/engine/ironhorse-vm/src/interp/environment.rs:566-595`, `:603-623`; full entry: `../COVERAGE.md`). |
| NVAL-15 | low | `JSON.stringify` replacer-array dedupe is O(n²): 3.5 s for 10,000 keys. |

### Other findings that carry this lens

| ID | Severity | Owning lens | One line |
|---|---|---|---|
| CMP-8 | medium | `../lenses/skipped-features.md` | Deterministic depth caps refuse flat chains past about 2,040 terms; they exist because drop glue and some passes recurse per tree level. |
| FN-7 | medium | `../lenses/correctness.md` | Async generator completion awaits its return value a second time: one extra tick and, for a non-promise value, one extra capability per completion. |
| NVAL-5 | medium | `../lenses/correctness.md` | Collation is not UCA; its cost side is the `CollatorData` (five `String`s) cloned on every `compare`. |
| T262-13 | low | `../lenses/test262-conformance.md` | The sweep's run identity covers the whole repository HEAD and every shard, so any commit or one-shard edit re-runs all 1,930 batches. |

### Other measured waste in the region inventories

These rows come from the maps' "Memory and performance opportunities" tables.
The maps measured or read them, but they were not numbered findings and did not go through
verification.
The coverage review re-checked them and corrected two rows (`../COVERAGE.md`, "Unverified leads").

| Site | Waste | Magnitude | Map |
|---|---|---|---|
| Global-scope code | a top-level loop pays global binding resolution per access | `s = s + i` at top level: 9,759 instructions per iteration against 2,209 function-scoped | `../maps/vm-core-dispatch.md` |
| `interp/natives/array.rs:1617-1632` | `index.to_string()`, a `symbol_ids` lookup and a prototype walk per pushed element | one heap allocation per `push` | `../maps/vm-natives-objects.md` |
| `interp/natives/dispatch.rs:4684-4696`, `:4740-4750` | `shift` and `unshift` rebuild the whole B-tree | 10,000 shifts take 7.4 s (metered proportionally) | `../maps/vm-natives-objects.md` |
| `interp/natives/array.rs:1655-1676`, `:1698-1704`, `:1712-1747`, `:1827-1831` | the `*_fast_safe` predicates scan every item's flags for `XS_DONT_SET`/`DONT_DELETE`, although `dense_array_this` has already proved `attributed == 0` | one full B-tree walk per `shift`, `unshift`, `splice`, `fill` or `copyWithin`; for `shift` and `unshift`, beside NOBJ-15's rebuild | `../maps/vm-natives-objects.md` |
| `interp/natives/array.rs:4293` (in `array_stable_sort`, `:4284`) | `values.clone()` makes the merge scratch and is admitted to no ceiling, while its input is admitted by `reserve_scratch` at `:4549` | a sort near the chunk ceiling holds up to about twice the ceiling (the map: up to about 256 MB uncharged at the cap) | `../maps/vm-natives-objects.md` |
| Generator resume (`SavedFrame`) | each `next()` takes the `id_map` and re-allocates the `stack_slice` and `jumps` buffers (`split_off`) | about 15 mallocs and 420 B per `next()` (valgrind, `../probes/vm-functions-async/p19_gen_loop_5000.js` against `_10000.js`) | `../maps/vm-functions-async.md` |
| `interp.rs:3344`; `interp/natives/buffer.rs:1905`, `:2405` | a heap `Vec` per TypedArray element store and DataView get or set | one allocation per element access | `../maps/vm-natives-objects.md` |
| `interp/natives/string.rs:30-45`, `:567` | every non-indexed String method copies the receiver into a `Vec<u16>` | 2n bytes per call | `../maps/vm-natives-values.md` |
| `interp/natives/bigint.rs:75-96`, `:387-397`; `interp/coerce.rs:239-243`, `:428-431` | BigInt operations, `===` and truthiness decode limbs into vectors and re-encode | three or more allocations per operation, even for one limb | `../maps/vm-natives-values.md` |
| `interp/natives/json.rs:515-526` | `JSON.parse` copies its input twice (UTF-16, then WTF-8) | up to 5n bytes transient | `../maps/vm-natives-values.md` |
| `interp/natives/number.rs:383-437`; `interp/numeric.rs:607` | `toFixed` and `toPrecision` format 1,100 or more characters per call | about 1.2 KB temporary per call | `../maps/vm-natives-values.md` |
| `interp/natives/dispatch.rs:2839`; `interp/intl_data.rs:19-60` | `CollatorData` (five `String`s) cloned per `compare`; Intl options stored as strings and re-parsed per `format` | five allocations per comparison | `../maps/vm-natives-values.md` |
| `interp/natives/regexp.rs:946` | `matchAll` re-decodes the subject on each `next()` | O(n) per match; `HeapExhausted` at n = 16,000 | `../maps/regexp.md` |
| `interp/property.rs:2166` → `interp/link.rs:1587-1609` | every `[[OwnPropertyKeys]]` filters all four rosters, even for a plain object | about 2.4% of `Object.keys(o)` (30 µs per call); 86% is BOOT-4/PROP-4's per-key catch-up (callgrind, `../probes/coverage-review/handed-off-leads/profiles.txt`) | `../maps/vm-boot-realm-modules.md`; `../COVERAGE.md` |
| `interp/natives/collection.rs:2049-2068` | brand recovery scans `proto_methods` linearly per `forEach`, `keys`, `values`, `entries`, `clear` | O(intrinsic methods) per call | `../maps/vm-natives-objects.md` |
| `gc.rs:186`; `interp/gc.rs:121` | a fresh `Vec` per popped slot in the mark loop; a `HashSet` of every swept index | about 9 MiB transient for 800,000 swept slots (a 5 MiB `HashSet` of `u32` plus a 4 MiB `Vec`; arithmetic, not 16 MB) | `../maps/vm-memory-gc-meter.md`; `../COVERAGE.md` |
| `rust/endo/src/ironhorse_engine.rs:734-740` | the ephemeral wrapper runs a full collection before every evaluation | 0.47 ms of preparation against 0.088 ms to run `1+1` | `../maps/integration-fuzz-oracle.md` |
| `ironhorse-snapshot/src/machine.rs:966-994`; `store.rs:2062-2108` | store genesis and import hold the live heap, the image and the encoded batch at once | about 3 times the heap at peak | `../maps/snapshot-store.md` |
| `ironhorse-snapshot/src/machine.rs:1547-1553` | no eviction; the first scheduled full collection faults the whole heap | lazy-wake savings last until the first collection | `../maps/snapshot-store.md` |
| `ironhorse-262/src/xst.rs:464-500`; `lib.rs:602` | harness setup includes are re-parsed and re-run per case and mode on both engines | about 2 × 99,500 setup compiles per engine per sweep (not measured) | `../maps/test262-harness.md` |
| `interp/locale.rs:320` | `WordSegmenter::new_auto` links the CJ dictionary | 2,007,110 B of the 8,833,008-byte `ironhorse-xst` | `../maps/vm-natives-values.md` |

Paths without a crate prefix are under `rust/engine/ironhorse-vm/src/`.

## Opportunities ranked

Ranked by expected benefit for Endo workloads: many small objects, closures and promises;
long-lived persistent vats; a checkpoint after every crank.
"Host-only" means no byte of a container, store or meter changes and no program completes
differently.
"Release change" means the change moves where cranks halt (a different slot or chunk count, or a
different charge), so replicas must upgrade together, as `rust/engine/CHANGELOG.md:3-12` does for
side-storage charging.
"Format bump" and "schema step" are container and store versions with a migration or a refusal
(`rust/engine/ironhorse-snapshot/src/versions.rs`).
Savings marked "est." are derived from the measurements, not measured.

| Rank | Opportunity | Expected saving (evidence) | Effort | Risk to determinism or snapshot compatibility | IDs |
|---:|---|---|---|---|---|
| 1 | Collect in the thixotrope worker on a replica-visible crank cadence | Garbage stops accumulating in the heap and in every checkpoint. Today four cranks that each drop 50,000 `{a: i, b: [i]}` fill the 1M-slot ceiling, the fifth halts, the heap file is 29.98 MB, and a restart cannot recover. | S | Collection reorders the free list, so it must run at a replica-visible point (a crank count, as `PersistentMachine`'s `collect_every`, which defaults to 0, `rust/endo/src/ironhorse_engine.rs:908-929`). A collection faults the whole heap and the next checkpoint rewrites relocated data. No format change. | INT-1 |
| 2 | Track section dirt on shared Machines; keep the persist gate incremental | No-op checkpoint 13.0 ms → about 0.21 ms at 2.4 MB of small state (62×), on every daemon crank; the gate's 3.7 ms per checkpoint at 100,000 closures → O(1). | M | A missed dirty bit silently drops state: add the shared-Machine arm to `store_suite`. No format change. | SNS-1, SNS-3 |
| 3 | Compact per-kind rows for promises, functions and activations | Pending promise 1,578 B, `new Promise(exec)` 1,004 B, arrow 490 B, suspended async call 1,571 B, against Node's 57 and 105 B and XS's ~400 and ~200 B (est.): roughly 1 KB per pending promise and 200-300 B per closure (est.). Inventory: two full `FuncInfo` rows per resolving pair, a 448 B reaction vector from the first `then`, a `String` name per function, about 200 B of `SavedFrame` kept after completion. | M-L | Host-only while rows stay uncharged; rows are encoded field by field, so no format change. Charging them (MEM-3) makes their widths consensus state: a release change. | MEM-6 (b, c), FN-3, MEM-3 |
| 4 | Persist bulk side tables per owner; drop the commit-time re-decode and second hash now | Touching one element rewrites every array's items: 2,400,129 bytes and 29.7 ms at 100,000 items against 0.21 ms; per-owner rows make it proportional to the owners touched. The short-term step removes a decode, a re-encode and a SHA-256 per touched section. | S (short term), M-L | Per-owner rows are a store schema step with a migration (SNS-10's unused `side_tables` table is a home); the short-term step changes no bytes. | SNS-2, SNS-10 |
| 5 | Generation-gated global catch-up and allocation-free name lookups | `o[k]` about 9.2 µs → near a static read's 0.15 µs; 200,000 computed reads 2.23 s against 0.23 s static; 130-290 µs per first use of a runtime key. Endo's pass-style check reads every record property by computed key (`packages/pass-style/src/copyRecord.js:55-57`). | S-M | Install semantics must not change (BOOT-1 and BOOT-2 depend on when passes run); computrons unchanged; no format change. | BOOT-4, PROP-4, PROP-10, BOOT-3 |
| 6 | Skip the dead default prototype for non-constructors; store function names once | 2 of 5 slots per arrow and async arrow and 2 of 7 per method when the program names `constructor` (1 slot otherwise), plus a `String` per function: 1.3 to 1.7 times as many closures per crank before the slot ceiling (est., 4 or 5 slots → 3). | S | Release change: slot counts move where cranks halt. Keep the calibrated computron charge; existing heaps are unaffected. | CORE-12, FN-15, CORE-6 |
| 7 | Remove `id_map`, classify the callee once, keep arguments on the value stack | Per call: about 1,630 instructions of hashing and 495 of `malloc`/`free` out of about 8,950 for a three-local call (at least a quarter, est.), two of three to four allocations, and about 149 B and two allocations per `try { let }` iteration; block exit stops being O(frame bindings). | M | Computrons must stay identical. `SavedFrameRow` and catch-jump rows persist the sorted map (`interp/persist.rs:2450-2480`): derive them from `locals` at encode time, or drop them under a format bump. | CORE-7, FN-11, CORE-10 |
| 8 | Collect at a dispatch safepoint when an allocation would cross a ceiling | Ceilings bound the live set: allocation-churn residency at the boundary is about 2.5× XS's (`rust/engine/benches/README.md:244-251`); programs that halt today (166,483 closures, 499,449 `{a: i}`, 16,400 appends, about 330,000 awaits of non-promises) complete. | L | Release change: allocation order and which programs complete change. The trigger must depend only on replicated counters. No format change. | MEM-1, CORE-6, FN-12, NVAL-3 |
| 9 | Cut compile-time memory constants | 220-345 B per source character today (550 MB of RSS to `eval` 2 MB). The dead `offsets` and the `Vec<u32>` copy are 12 B per character outright; the tree (56-122 MB per MB), the retained parser stack (44 MB per MB) and the code records are the rest. Under a 128 MiB wasm instance an `eval` of under 1M code units fails today. | S (offsets, in-place lexing) to M | None if bytecode stays byte-identical (corpus totality gate, compile differential); no format change. | CMP-2, CMP-5 |
| 10 | Property-read and integer fast paths; one opcode decode | `o.k`: about 1,160 of 1,930 instructions per read (`s = s + o.c` 4,250 → about 3,100 per iteration, est.); integer arithmetic: about 850 of 2,204 instructions per loop iteration (38%) plus 12.4 per opcode. | S | Meter ticks must be identical; gate on the benchmarks and the XS differential. | CORE-8, CORE-9, CORE-3 |
| 11 | Replace SipHash for dense integer keys | SipHash is 12-16% of the instructions in the profiled computed-read and `a.indexOf` loops and about 1,630 per three-local call; the collector does about 20 lookups per marked slot (96 ns per live slot). | S | No reviewer found order-sensitive iteration of a `RandomState` map; a fixed-seed hasher removes process randomness rather than adding it. Audit each map. | MEM-6 (b), PROP-10, CORE-7 |
| 12 | Contiguous storage for dense arrays | 55.6 → 24 B per item with today's `Slot` (−57%), 16 B with rank 14 (−71%); O(1) indexing; `shift`, `unshift` and `splice` stop rebuilding a tree (10,000 shifts take 7.4 s in the natives map's probe). | M | The charged width (`ARRAY_ITEM_BYTES`, 32 B by capacity class) is consensus state: keeping it is no release change, re-declaring it is one. The ARRY encoding (4-byte index + 20-byte slot per item) need not change. | MEM-6 (a), NOBJ-15, NOBJ-4 |
| 13 | String representation | One copy instead of four per `+`; 4 B per empty result; 2n + 4 B per string-literal evaluation (a 4M-evaluation loop of a 36-character literal halts today); O(key length) per `for-in` step and per `Object.keys` key; a rope or tail-append removes the n² retention of append loops. | S each; rope L | One-copy concatenation is host-only. The shared empty string, per-site literal chunks and interned key strings change chunk allocation (release change). A rope string kind is a new slot kind (format bump). | NVAL-3, NVAL-17, CORE-6, FN-16 |
| 14 | 16-byte `Slot` and bitset marks | About 26 → 16.25 B per arena slot (−37%; about 9.75 MB at the default 1M-slot ceiling) and 8 B off every value outside the arena (value stack, bound arguments, collection entries, array items). | M | No container change (fields are encoded individually). Declared widths are asserted against `size_of` (`interp/admission.rs:11-53`): re-declaring them is a release change, or freeze the declarations. | CORE-11, MEM-6 (d) |
| 15 | Return memory after collection | 75-185 MB retained with about 1,100 live slots → about boot size plus live data; transient ArrayBuffer peak halved (397 MB for 200 MB). | S (`shrink_to`, `alloc_zeroed`), M (trailing-slot truncation) | `shrink_to` and `alloc_zeroed` are host-only. Allocating from the lowest free index changes the serialized free-list order: a release change. | MEM-7, NOBJ-7 |
| 16 | Omit free records from containers | 20 B per free slot in every container and restore: 2.40 of 2.45 MB (98%) after a 50,000-object burst. | S-M | Container format bump (`VERS`) and reader support; keep the free-list order. | SNI-8, MEM-7 |
| 17 | Owner-indexed accessor and private rows; per-key ephemeron lists | Collection with 16,000 own-getter objects 3.75 s, 8,000 instances with two private fields 0.26 s, a 16,000-link WeakMap chain 0.86 s → linear (100,000 plain objects collect in 12 ms). Accessor pairs in the property slot also save an estimated 64-130 B per accessor. | M | An owner index and ephemeron lists are host-only. Moving accessor pairs into slots changes the persisted accessor table (format bump). | MEM-2, MEM-9 |
| 18 | Restore without whole-image copies | Restore peak 4.67× → about 2.5× the container; raises the largest heap an isolate can restore (eager restore is the costliest phase at 114 B per slot). | S | None; the same bytes are accepted. | SNI-7 |
| 19 | Machine template and once-per-process reference roots | 38-90 ms and 523 KB per `Machine::new`; at least 76-180 ms of reference builds per shared restore removed outright. | S (`OnceLock`), M (template) | A cloned template must equal a fresh boot (`boot_fingerprint` checks it); no format change. | BOOT-6 |
| 20 | Share compiled RegExp programs; a string-set matcher node | 257,716 B per `\p{RGI_Emoji}` instance under `v`; 2,000 retained instances 501.5 MB → about the `/a/v` control's 11 MB with sharing; a literal in a hot function compiles once. | S (cache), M (matcher node) | Restore recompiles from source and flags, so no format change. Once programs are charged (correctness lens), the charge rule for a shared program must be fixed in the release. | RGX-4 |
| 21 | Compact property index with incremental unlink | About 210 → 6-8 B per indexed property (map est.); `delete o[k]; o[k] = v` on 8,000 keys 2.6 ms → microseconds. | M | None: the index is derived and never persisted (`property_index.rs:2`). | PROP-3, PROP-10 |
| 22 | Cheaper store reads and wake | Per lazy fault, two statement compilations and a manifest decode (1,000 faults: 2,000 compilations); one of two full decode and re-encode passes over the small state at open; two unbuffered header loads per FileStore commit; `gen_dirty` about 40 B per page dirtied. | S (SNS-5: M) | None, except SNS-5's edge summaries (a store-format decision). | SNS-6, SNS-11, SNS-9, SNS-5 |
| 23 | Walk each function body once at import and restore; bound the atom count | Restoring F closures of a B-byte function walks F × B bytes twice (4.5 ms per row per MiB) → B; crafted containers: 6.1 s per MiB of empty atoms → O(38). | S | None. | SNI-6, SNI-5 |
| 24 | Replace the quadratic natives | Wall time per computron back to the 35-42 ns baseline for TypedArray `fill` and `sort`, weak deletes, Set operations, `splice`, string search, BigInt and `exec` (amplification today: 50× to 10⁷×). Rare in typical vat code, but each is a time-bound bypass. | M | Replacing an algorithm with identical charges is host-only; charging what remains is a release change. | MEM-4, NOBJ-2, MEM-5, NOBJ-3, NOBJ-4, NVAL-1, NVAL-2, RGX-5, NOBJ-5, NVAL-15 |
| 25 | Coalesce free chunk markers; move instead of copy in `transfer` and `resize` | Stranded ceiling margin after alternating large allocations; one chunk and two host copies per `transfer` or `resize`. | S | Both change chunk layout or allocation: release change. | MEM-8, NOBJ-7 |

## Leads that did not survive

No finding in this lens was refuted.
These were lowered or partly withdrawn, with the verifier's reason:

- MEM-1, high to medium (pass 2): "no collection within a crank" is a documented decision
  (`rust/engine/RECLAMATION.md:63-66`), and the halt is loud, deterministic and stricter than the
  bound rather than looser.
- CORE-6, high to medium (pass 1): the same documented policy; the dispatch-side allocation only
  makes it easier to hit.
- NOBJ-7, medium to low: the `HeapExhausted` it showed reproduces with plain `ArrayBuffer` and
  string churn; `transfer` adds only an avoidable chunk and copy.
- SNS-3, medium to low: about 37 ns per function per checkpoint is minor beside SNS-1 and SNS-2.
- NOBJ-5, raised to high by pass 1 and returned to medium: length-proportional string comparison
  is uncharged engine-wide and inherited from XS; this site adds a 20-30× constant.
- NOBJ-15's "about 445 MB of host memory at the ceiling": an array pushed to the ceiling halts at
  about 240 MB of RSS, and the charge swings between 32 and 64 B per item against 55.6 B
  resident, so it is not a bypass.
- CMP-2's "only computrons bound it": the source is a guest string bounded by the chunk ceiling,
  so compile memory is bounded at about 110-170 times the chunk ceiling.
- RGX-4's whole-range fold: `charset_unicode_fold_targets` iterates the fold table, not 1.1M
  scalars (`\p{Lu}` with `iu` costs 569 compile computrons); the O(range) work is `charset_range`
  under `i`, metered per code point and faithful to XS (40 ms, not 137 ms).
- PROP-4's proposed floor guard: the catch-up's second half is unguarded on purpose (compartment
  bindings can be missing after the machine-wide floor advanced), so the fix needs a per-environment
  flag.
- Magnitudes corrected by verification: SNI-5 and SNI-6 map timings came from debug builds (about
  45 and 20 times lower in release); BOOT-6 38 ms rather than 90 ms; SNS-1 13.0 ms rather than
  18.1 ms; SNS-2 29.7 ms rather than 49 ms; SNS-3 3.7 ms rather than 6.6 ms; PROP-10 9,600 rather
  than 18,000 instructions per iteration; FN-11's `try { let }` 149 B rather than 353 B, and only
  two of the three to four allocations per call are `id_map`'s; CMP-13 5× rather than 3-10×;
  MEM-7's figures are MiB (26.2 and 30.2), not MB.

The region maps also dropped these leads before writing a finding:

- A per-machine leak on drop: the 63.6 KB left after dropping an `Interp` is one-time process
  state (1, 10 and 50 machines leave the same).
- Sweep cost on a large empty arena: 1.55 ms for 801,101 records with nothing to reclaim.
- Map and Set `delete`: tombstones compact amortized, so 40,000 front deletes take 148 ms,
  linear; Map's ceiling charge (96 B) is close to its resident cost (127 B).
- The boot footprint (327 KB) and the 24-byte slot are both smaller than XS's.
- Chunk allocation charged one raw unit per byte (200 MB in 0.36 s for 3,079 computrons): XS
  parity, a `memset`, bounded per crank by the ceiling.
- `shift` and `unshift` are metered proportionally (100 ns per computron against a 90 ns
  baseline); their cost is a representation issue (NOBJ-15), not a metering hole.
- `eval` code segments are compacted by collection (2,000 to 0); `split_off(0)` into a
  `SavedFrame` copies only the tail; `enter_construct_bound`'s quadratic copy is charged
  quadratically; `count_new_locals`'s per-closure scan is paid by the per-byte charge.
- Compiler: `Function`-loop memory growth is the in-crank policy, not a compiler leak;
  `scope_lookup` chain climbs are charged per scope visited; BigInt literal conversion is charged
  per digit before the step.
- Natives: the URI-decode test262 timeout (`S15.1.3.2_A2.5_T1.js`) is general interpreter cost
  (2.5 µs per call); `JSON.parse` of 20,000 distinct keys takes 0.25 s.
- Property model: lookups on long chains are O(1) once indexed (`big_idx_100k.js` scales
  linearly), and `keys_alloc.js`'s `HeapExhausted` is the in-crank policy, not property storage.
- Snapshots: the wire is denser than memory (20 B per slot against 24 B), so no action; decoder
  reservations are clamped (at most about 1.3 times the payload, transiently); free-segment
  diffing ships exactly the changed segments.
- HashMap iteration order: no order-sensitive iteration of a `RandomState` map reaches a result,
  a snapshot or the collector's output in any region, which is what makes a faster hasher safe
  to consider.

## What this lens did not cover

- **XS memory.**
  No XS binary was measured; every XS figure is an estimate from its documented 32-byte slot.
- **wasm32.**
  Nothing was built or run for wasm32; `WASM-MEMORY.md`'s per-slot and per-byte constants were
  not reproduced, and the native host-bytes-per-slot figures stand in for them.
- **Whole vats.**
  Measurements are per-unit microbenchmarks and synthetic heaps.
  No real Endo vat, SES boot heap or bundle load was measured (the 7.65 MB SES boot heap and
  17.27 MB counter vat in `WASM-MEMORY.md` were not re-measured), and both test262 sweeps ran
  without `lockdown()`.
- **The daemon end to end.**
  `rust/endo` did not build here, so checkpoint and wake costs come from the snapshot crate's
  sessions; SQLite I/O (fsync, WAL growth) was not measured, and SNS-6 and SNS-11 are static.
- **Collectors other than the exact one.**
  The store-side partial and generational collectors were not benchmarked (only tests call them,
  SNS-5); collection pause times are for `collect_garbage` on synthetic heaps.
- **Lazy residency.**
  Page faulting, eviction and the memory benefit of a lazy wake were not measured.
- **Meter weights.**
  The 292 weights in `ironhorse-meter` were not audited individually; time per computron was
  measured only for the operations named here and in the correctness lens.
- **Code retained by `eval` and `Function` closures.**
  Nested functions are emitted inline into their compile unit's one bytecode buffer, so a closure
  created by `eval` or `Function` may keep its whole unit's bytecode and symbol atom alive
  (`../maps/compile.md:697`, static).
  The VM-side retention was not traced or measured.
- **Side-table byte sizes.**
  The sizes in the "Side-table rows" table under "Measured footprint" are not verified.
  The types are private, so measuring them needs an in-crate `size_of` test (`../COVERAGE.md`).
- **Code size.**
  Only the ICU segmenter dictionary was attributed (2.0 MB of the 8.8 MB `ironhorse-xst`); the
  binary and the wasm module were not otherwise audited.
- **Wall times.**
  All are from a shared, loaded 4-vCPU host; ratios and computron counts are the robust figures.
