# The wasm build's memory: a model, ceilings per host, and a host-failure halt

Measured 2026-10-14 on `llm` at `dc960427` plus this branch, which turns
[WASM-BLOCKERS.md](WASM-BLOCKERS.md) B8 ("the ceilings do not bound memory") into a decision.
The build is the B1 recipe of `stack-lanes/build_probe.py` (std rebuilt with unwinding, `exnref`,
a 4 MiB shadow stack, `consensus`), the same flags as the official build script that
[endojs/endo-but-for-bots#1450](https://github.com/endojs/endo-but-for-bots/pull/1450) adds.
The host is the Wasmtime 49.0.0 CLI on a shared 4-core x86_64 Linux machine; Node 22.22.0 stands
in for V8.
Every number below comes from a file in [`stack-lanes/memory/results/`](stack-lanes/memory/results/)
and the command that wrote it ([Reproduction](#reproduction)).

None of the sibling tasks this depends on had landed: array-item and side-table admission, the
streaming snapshot encoder, the consensus caps on `set_chunk_ceiling` and `set_slot_ceiling`,
and the target-independent admission widths
([endojs/endo-but-for-bots#1449](https://github.com/endojs/endo-but-for-bots/pull/1449)).
The numbers are today's engine; [the formula](#the-worst-case-formula) says which constants each
of those tasks moves.

## Decisions

- **The footprint is a linear function of the ceilings, with measured constants.**
  On wasm32 the worst running heap takes 4.5 bytes of linear memory per byte of chunk ceiling and
  50 per slot of slot ceiling, over a 7.25 MiB empty instance.
  A whole-heap snapshot takes 6.9 bytes per chunk byte and 117 per slot, and an eager restore 6.0
  and 145.
  Array items and Map and Set entries are bounded by no ceiling and cost up to 221 and 398 bytes
  each at a checkpoint.
- **Ceilings belong at powers of two.**
  Both arenas grow by doubling, so a slot ceiling just past 2^20 took 91 bytes per slot where 2^20
  took 48, and a 160 MiB chunk ceiling took 3.27 bytes per chunk byte where 256 MiB took 2.04.
- **A 128 MB Cloudflare isolate: 4 MiB of chunks and 262,144 slots.**
  Every phase then stays within 78 MiB of the 98 MiB left after the host, by the formula with a
  15% margin; no measured shape passed 54 MiB.
  A vat keeps at most about 9 MB of container under them: the 7.65 MB SES boot heap is at the
  edge, and the 17.27 MB counter vat does not fit.
- **A 512 MB container (the native worker): 64 MiB of chunks and 1,048,576 slots.**
  The worst phase is 422 MiB by the native formula; both Thixotrope heaps fit.
- **An uncapped native host: keep the defaults** (256 MiB, 1,000,000 slots; worst 1,322 MiB),
  and raise them no further than the consensus caps.
- **The consensus caps should be 2^28 bytes and 2^23 (8,388,608) slots**, not 2^29 and
  44,739,242.
  At the proposed caps every phase overruns wasm32's 4 GiB (5,111 MiB running, 10,656 MiB at an
  eager restore); at 2^28 and 2^23 the costliest phase, a whole-heap snapshot, needs 3,116 MiB.
- **Recycle an instance at a crank boundary once its linear memory passes
  T(C, S) = 1.15 × (7.25 MiB + 6.0·C + 145·S)**, the most a fresh instance at those ceilings
  needs to restore and run a crank, and always after a trap or a host failure.
  A recycle costs a fresh instance's restore: 90 to 357 ms under Node's Liftoff for 6.4 to 32.1 MB
  snapshots, against Cloudflare's 78 to 174 ms first evaluation.
- **A host that refuses memory now halts with `Halt::HostAllocationFailed`**, which the embedder
  never commits.
  Under a 128 MiB Wasmtime cap, B8's forty-string loop ends in it at 4,457,259 computrons, where
  native and uncapped wasm32 return `40` at 10,487,663; before this change it ended in
  `HeapExhausted`.
- **Production Cloudflare's enforcement is still unknown**, and one Worker that grows a memory by
  4 MiB per request would settle it ([below](#what-production-cloudflare-enforcement-would-change)).

## How it was measured

[`stack-lanes/memory/`](stack-lanes/memory/) holds a probe crate, one program per heap shape, and
`memory.py`, which runs them; its README has the details.
The probe runs one program and reads two figures after each phase.
`linear` is the host's view: wasm linear memory, which never shrinks, so a reading is the peak so
far.
`heap_peak` is the engine's view: the most bytes the global allocator had live at once.
The phases are:

- **running**: the program, on a fresh machine;
- **checkpoint**: the program as the first crank of a `begin_store_session`, as the Thixotrope
  worker runs it, then `checkpoint_to_store`, into a store that keeps the manifest and the section
  hashes and drops every row, as a host-side store does;
- **snapshot**: the program, then `write_snapshot` of the whole heap;
- **restore**: that snapshot resumed with `from_snapshot_bytes` in a fresh instance, then `1 + 1`.

For each shape, `memory.py` finds the largest size that completes natively under the ceilings.
It then runs the wasm probe once past it ("at the ceiling", which halts with `HeapExhausted`) and
at 95% of it in every phase.
Array items and Map and Set entries are admitted against no ceiling, so those shapes run at fixed
sizes.

The shapes:

| Shape | Program | Binds |
|---|---|---|
| Strings | strings of 2^20 code units, kept in an array | chunks |
| A doubled string | `s = s + s` from 2^20 units | chunks |
| Small strings | strings of 1,024 units, kept | chunks |
| Objects | a linked list of two-property objects | slots |
| A vat-like mix | records in a Map by string id, each an object with a string, a number and a three-element array | slots, then chunks |
| Arrays | integers pushed onto one array | nothing |
| Maps, Sets | integer entries | nothing |

Two runs of one heap can differ by about 15% in `linear` while their `heap_peak` agrees to the
byte: the Map and Set runs of 4,000,000 entries ran at 514.6 and 452.9 MiB.
The formula carries that as its margin.

## Footprint per heap shape

Wasm32 under Wasmtime, default ceilings (1,000,000 slots, 256 MiB of chunks), in MiB of linear
memory; the empty instance takes 7.25.

| Shape | At the ceiling | Running | Checkpoint | Snapshot | Restore | Snapshot size (MB) |
|---|---:|---:|---:|---:|---:|---:|
| Strings, 120 of 127 | 524.5 | 524.5 | 524.5 | 1,484.6 | 1,207.2 | 251.70 |
| A doubled string, 6 doublings | 1,153.3 | 897.3 | 897.3 | 1,405.4 | 1,277.1 | 266.38 |
| Small strings, 122,572 | 711.1 | 711.1 | 711.1 | 1,682.9 | 1,469.9 | 256.97 |
| Objects, 949,433 slots | 55.2 | 55.2 | 55.1 | 113.2 | 138.4 | 19.01 |
| Vat-like mix, 158,080 records | 253.2 | 253.2 | 380.4 | 570.2 | 432.5 | 85.22 |
| Arrays, 4,000,000 items | | 225.2 | 851.2 | 622.1 | 495.5 | 96.04 |
| Maps, 1,000,000 entries | | 118.6 | 386.6 | 381.1 | 219.1 | 40.04 |
| Maps, 4,000,000 entries | | 514.6 | 1,484.0 | 1,339.2 | 854.8 | 160.04 |

Against the ceilings, the same runs give these coefficients: linear memory above the empty
instance per chunk byte held, per slot held, or per element.

| Shape | Unit | At the ceiling | Running | Checkpoint | Snapshot | Restore |
|---|---|---:|---:|---:|---:|---:|
| Strings | per chunk byte | 2.04 | 2.16 | 2.16 | 6.16 | 5.00 |
| A doubled string | per chunk byte | 4.51 | 3.50 | 3.50 | 5.50 | 5.00 |
| Small strings | per chunk byte | 2.75 | 2.91 | 2.91 | 6.92 | 6.04 |
| Objects | bytes per slot | 50 | 53 | 53 | 117 | 145 |
| Vat-like mix | bytes per slot | 258 | 272 | 412 | 622 | 470 |
| Array items | bytes per item | | 57 | 221 | 161 | 128 |
| Map entries | bytes per entry | | 117–133 | 387–398 | 349–392 | 222 |
| Set members | bytes per member | | 117–128 | 387–398 | 349–392 | 222 |

The coefficients hold across scales.
At 250,000 slots and 32 MiB, strings ran at 2.21 per chunk byte and the doubled string at 4.27,
objects at 50 bytes per slot, small strings snapshot at 6.90 and restore at 6.03.
At 262,144 slots and 4 MiB, objects ran at 48, snapshot at 114 and restored at 144.

What the numbers say:

- **Strings cost two to three times their chunks while running**, because the arena's last
  doubling holds the old and the new buffer while it copies, and every string passes through a
  scratch copy; doubling one string costs 4.5 times, because its own copies (both operands
  decoded, the result, its encoding) sit beside the arena's growth.
- **A checkpoint of a crank that built the whole heap fit inside the running peak** for strings and
  objects: the dirty extents it copies fit in what the crank's transients had freed.
  It did not for side tables: `checkpoint_to_store` re-encodes every changed array's items and
  every changed Map's entries whole, at 221 and 387 to 398 bytes each, more than a whole-heap
  snapshot of them takes.
- **A whole-heap snapshot needs six to seven times the chunks and 117 bytes per slot**, as B7
  found: the image copies the arenas and the encoder then builds the payload in more buffers.
  Under a cap it traps: with 20 strings under a 256 MiB cap, the crank completed and the snapshot
  aborted on `memory allocation of 83913394 bytes failed`.
- **An eager restore costs about what a snapshot does**: 5.0 to 6.0 per chunk byte and 145 bytes
  per slot, more per slot than the snapshot.
  A fresh instance that restores a vat therefore starts near the high-water mark the vat's last
  snapshot reached, not near its running size.
- **Power-of-two ceilings are cheapest.**
  An arena whose ceiling is a power of two never grows past it; one whose ceiling is just past a
  power of two doubles to nearly twice the ceiling.

| Ceilings | Shape | At the ceiling | Coefficient |
|---|---|---:|---:|
| 1,048,576 slots | Objects | 55.2 MiB | 48 bytes per slot |
| 1,100,000 slots | Objects | 103.2 MiB | 91 bytes per slot |
| 256 MiB | Strings | 524.5 MiB | 2.04 per chunk byte |
| 160 MiB | Strings | 524.5 MiB | 3.27 per chunk byte |
| 160 MiB | A doubled string | 643.3 MiB | 5.05 per chunk byte |

An arena restored from a snapshot starts at its exact length, so its doubling lands anywhere: a
restored arena carries the past-a-power-of-two cost whatever its ceiling.

Natively the same programs ran at much less while running, because the allocator remaps a growing
buffer in place, and at two-thirds to three-quarters of wasm32's peak in the other phases (peak
RSS, default ceilings):

| Shape | Running | Checkpoint | Snapshot | Restore |
|---|---:|---:|---:|---:|
| Strings, per chunk byte | 1.05 | 2.03 | 4.03 | 4.02 |
| A doubled string at the ceiling, per chunk byte | 4.05 | | | |
| Small strings, per chunk byte | 1.06 | 2.11 | 4.10 | 4.07 |
| Objects, bytes per slot | 33 | 54 | 98 | 90 |
| Array items, bytes per item | 60–65 | 172–178 | 140–146 | 116–121 |
| Map entries, bytes per entry | 165–170 | 338–356 | 290–308 | 169–174 |

## The worst-case formula

For a chunk ceiling of C bytes and a slot ceiling of S slots, at powers of two, the linear memory
a wasm32 instance can reach in a phase is

```text
W(C, S) = 1.15 × (L0 + a·C + b·S)            L0 = 7.25 MiB (4 MiB of it the shadow stack)

phase        a (per chunk byte)   b (bytes per slot)
running      4.5                  50
checkpoint   4.5                  53       (110.5 once side tables are admitted, below)
snapshot     6.9                  117
restore      6.0                  145
```

`a` is the worst string shape (the doubled string while running, small strings otherwise), `b`
the object list, and 1.15 the allocator's layout variation.
The terms add because the two arenas are separate allocations, and the margin covers the rest:
on the vat-like mix at default ceilings, with its own chunks, slots, items and entries put through
the per-unit constants, every phase measured under the prediction.

| Phase | Predicted, with the margin (MiB) | Measured (MiB) |
|---|---:|---:|
| Running | 261.5 | 253.2 |
| Checkpoint | 395.9 | 380.4 |
| Snapshot | 635.0 | 570.2 |
| Restore | 571.4 | 432.5 |

Unadmitted storage adds `i·items + e·entries`, with `i` = 57, 221, 161, 128 and `e` = 133, 398,
392, 222 bytes in the four phases; today nothing bounds either term.
Off a power of two, or on a restored arena, the slot term can nearly double (91 against 48 bytes
per slot) and the chunk term grow by half again (3.27 against 2.04).
At the default ceilings the formula gives 1,388 MiB running, 2,168 MiB for a snapshot and 1,934
MiB for a restore, against 1,153, 1,683 and 1,470 MiB measured.

What the sibling tasks change:

- **Admitting array items and side tables** turns `i` and `e` into slot charges.
  Charging 2 slots per array item and 4 per Map or Set entry keeps every phase's per-slot cost
  within the object list's, except the checkpoint's, where `b` rises from 53 to 110.5; that is
  the figure the recommendations below use.
  Charging less leaves the side tables' per-slot cost above the objects' in that phase.
- **The streaming snapshot encoder** should bring the snapshot row down toward the running one (`a`
  from 6.9, `b` from 117), plus whatever buffer it keeps.
  It does not touch the restore row, which is decoding, or the checkpoint's side-table
  re-encoding, which is the checkpoint batch.
- **The consensus caps** set the largest C and S the formula is ever evaluated at
  ([below](#the-consensus-caps)).
- **Target-independent admission widths**
  ([endojs/endo-but-for-bots#1449](https://github.com/endojs/endo-but-for-bots/pull/1449)) move
  where scratch admission halts, not what a heap costs; no constant here changes.

Three engine changes would lower the constants themselves, and none is made here:

- clamping each arena's growth at its ceiling would remove the off-power-of-two and restored-arena
  penalty, and make the bound independent of history, as B7's latent paragraph asks;
- building strings straight into the chunk arena, and decoding operands without a whole copy,
  would cut the 2.0 to 4.5 running cost toward 1;
- checkpointing a changed array or Map section by its dirty part would cut `i` and `e` at the
  checkpoint.

## Recommended ceilings

### A 128 MB Cloudflare isolate

The budget starts at 128 MB (122.1 MiB), which covers the isolate's JS heap and its wasm memory.
Under Node, compiling and instantiating the 9.1 MB probe module under Liftoff grew the resident
set by 19.7 MB, and the JS heap held 4.6 MB.
Whether compiled wasm code counts toward the cap is one of the unknowns below, so the host's share
is taken as 24 MiB, leaving 98 MiB of linear memory, of which the 4 MiB shadow stack is part of
L0.
With admitted side tables (`b` = 110.5 at the checkpoint):

| Ceilings | Running | Checkpoint | Snapshot | Restore | Fits 98 MiB |
|---|---:|---:|---:|---:|---|
| 4 MiB, 2^18 slots | 43 | 61 | 74 | 78 | every phase |
| 8 MiB, 2^19 slots | 78 | 113 | 139 | 147 | running only |
| 16 MiB, 2^20 slots | 149 | 218 | 270 | 285 | no phase |

**Recommended: a chunk ceiling of 2^22 bytes (4 MiB) and a slot ceiling of 2^18 (262,144).**
Measured under them, no shape passed 54 MiB in any phase: the vat-like mix reached 25.4 running,
39.6 at its checkpoint, 53.9 at a snapshot and 43.8 at a restore, and objects 41.5 at a restore.
Under 8 MiB and 2^19 the mix reached 71.9 at its checkpoint and 99.9 at a snapshot, past the
budget even before side tables are admitted.

A vat keeps at most 262,144 slots and 4 MiB of chunks under them, about 9 MB of container at most
(5.24 MB of slot records, 4.19 MB of chunks, and the side tables' sections).
At 95% of those ceilings the measured snapshots were 5.00 MB for objects and 7.38 MB for the mix.
The SES boot heap's 7.65 MB container is at that edge, and fits only if its slots and chunks each
do.
The counter vat's 17.27 MB container is nearly twice what these ceilings hold, so it halts before
it finishes loading.

That is not because the counter vat is too big for the isolate: the Cloudflare review measured it
at 42.13 MiB after a lazy wake and 77.75 MiB after an eager one and a chunk-allocating crank,
with the 8 MiB shadow stack (about 4 MiB less with this build's).
It is that ceilings large enough to admit it, such as 16 MiB and 2^20, let a runaway vat reach
1.5 to 3 times the budget before they halt it.
So a vat of the counter vat's size can run on Cloudflare only with its memory bounded by the cap's
enforcement rather than by its ceilings, until the streaming encoder, lazy wake and the engine
changes above lower the constants.
Until side tables are admitted, nothing bounds an array or a Map under any ceilings: under a
128 MiB Wasmtime cap, four million array items, Map entries or Set members each ended in
`HostAllocationFailed`.

### A 512 MB container

A Container runs the native worker, so the native constants apply (L0 about 6.5 MiB, `a` = 4.05,
4.05, 4.10 and 4.07, `b` = 33, 89 with admitted side tables, 98 and 90).
Leaving 48 MiB of the 488 MiB for the worker's own process and SQLite, 440 MiB remains.

**Recommended: a chunk ceiling of 2^26 bytes (64 MiB) and a slot ceiling of 2^20 (1,048,576).**
The formula gives 344 MiB running, 408 at a checkpoint, 422 at a snapshot and 411 at a restore.
Measured under them natively, the doubled string reached 260.8 MiB running, small strings 254.9
at a snapshot, and the mix 331.9 at its checkpoint and 374.5 at a restore; the mix's 459.1 at a
snapshot is over the budget, and side-table admission is what would halt it sooner.
A vat keeps up to about 21 MB of slot records and 64 MiB of chunks, so both Thixotrope heaps fit.

### An uncapped native host

**Recommended: the defaults**, 2^28 bytes (256 MiB) of chunks and 1,000,000 slots.
The native formula gives at most 1,322 MiB in any phase, at a snapshot; side tables are bounded
only by the host, which reached 4 to 6.6 GiB in B7's repros.
Raise them only as far as the consensus caps, 2^28 bytes and 2^23 slots, which the native formula
puts at 2,116 MiB at a snapshot.
A consensus group that includes a wasm32 replica is held to what that replica can honor, which is
what the caps are for.

## The consensus caps

The sibling task proposes to start the caps at 2^29 bytes and 44,739,242 slots, the `isize::MAX`
wall of B7's latent paragraph.
**They should be lower: 2^28 bytes and 2^23 (8,388,608) slots.**

| Caps | Running | Checkpoint | Snapshot | Restore |
|---|---:|---:|---:|---:|
| 2^29 bytes, 44,739,242 slots | 5,111 | 8,080 | 9,812 | 10,656 |
| 2^29 bytes, 2^22 slots | 2,888 | 3,166 | 4,609 | 4,208 |
| 2^28 bytes, 2^24 slots | 2,253 | 3,366 | 4,192 | 4,443 |
| **2^28 bytes, 2^23 slots** | 1,793 | 2,350 | 3,116 | 3,109 |
| 2^27 bytes, 2^24 slots | 1,591 | 2,704 | 3,177 | 3,560 |

MiB of wasm32 linear memory by the formula, with admitted side tables; the address space is
4,096.
At the proposed caps every phase overruns it, and running alone needs 5,111 MiB; with B7's
measured 73 bytes per slot at 44,000,000 objects, where the slot vector has doubled to 2^26, it
needs 6,240.
At 2^28 bytes and 2^23 slots the costliest phase needs 3,116 MiB, leaving 980 MiB for what the
formula does not see.
The other pair that fits, 2^27 and 2^24, leaves half as much at its restore.
The chunk cap is then today's default ceiling, and the slot cap eight times it.

Two conditions come with them.
The bound holds for arenas grown from empty; until growth is clamped at the ceiling, a restored
arena can grow to nearly twice its ceiling, so the caps task should clamp, or refuse ceilings a
restored arena could outgrow.
And the restore row binds once the streaming encoder lands, so raising the caps further needs a
cheaper restore, such as the lazy store resume the worker can use, not only a cheaper snapshot.

## Recycling the instance

Wasm linear memory never shrinks, so an instance keeps the most memory any crank, checkpoint or
restore in it ever took, plus whatever fragmentation it accumulated.
A fresh instance at ceilings C and S never needs more than the formula's restore row, which is
also the largest row a host runs in the instance once whole-heap snapshots move out of it.
The policy:

1. **After a trap or `Halt::HostAllocationFailed`, always recycle**: drop the instance, instantiate
   the module again, and restore the last committed state into it.
2. **At a committed crank boundary, recycle when linear memory exceeds**

   ```text
   T(C, S) = 1.15 × (7.25 MiB + 6.0·C + 145·S)
   ```

   which is 78 MiB at 4 MiB and 2^18 slots (Cloudflare), 1,934 MiB at the defaults, and 3,109 MiB
   at the caps.
   An instance above T holds memory a fresh one at the same ceilings would never use.
   A host that only ever wakes lazily and never restores in the instance can use the checkpoint
   row instead: `1.15 × (7.25 MiB + 4.5·C + 110.5·S)`, 61 MiB on Cloudflare.
3. **Where isolates are shared** (Cloudflare places several Durable Objects in one), also recycle
   when linear memory exceeds twice what the live heap would take to restore,
   `2 × (7.25 MiB + 6.0·chunks + 145·slots)` from the manifest's `chunk_len` and `slot_count`.
   A crank that briefly needed far more than the heap it left behind otherwise pins that memory
   for every later crank.

What a recycle costs, for snapshots of the vat-like mix (`--recycle`):

| Snapshot | Node Liftoff: compile, instantiate, restore and one crank | Wasmtime, precompiled: whole process | Linear memory after |
|---|---:|---:|---:|
| 6.39 MB | 14.8 + 3.8 + 90.3 ms | 41.0 ms | 40.7 MB |
| 14.97 MB | 16.8 + 4.6 + 162.3 ms | 101.6 ms | 85.6 MB |
| 32.14 MB | 18.2 + 5.4 + 356.9 ms | 203.1 ms | 175.4 MB |

On workerd the module is bundled and compiled once per isolate (*inferred*), so a recycle in the
same isolate pays instantiation and the restore.
For a heap the size of the SES boot heap that is about one cold first evaluation, which the
Cloudflare section measured at 78 to 174 ms under Liftoff; for the counter vat's size, one to
two.
The review measured the real counter vat's lazy wake at 781 ms under Node, so the restore, not
instantiation, is the cost to cut.
A restore re-inflates: each restored mix took 5.5 to 6.4 times its snapshot, so recycling pays
off only when the instance holds well over that, which is what rule 3's factor of two is for.

## Host allocation failure

Before this change, a fallible growth path that the host allocator refused (the chunk and slot
arenas, `reserved_vec` and the other `try_reserve` sites) halted with `Halt::HeapExhausted`.
That is the halt a ceiling gives, deterministic and the same on every host, so an embedder could
not tell a host failure from a program's outcome.
A supervisor recording halts in consensus, or terminating a vat for exhausting its heap, would
have acted on an accident of one host's memory.

`Halt::HostAllocationFailed` is that case's own halt (`ironhorse-vm/src/interp.rs`).
Its documentation is the embedder contract:

1. **Never commit a crank that ends in it**: neither its heap nor its outbound effects, and never
   record the halt as the crank's outcome.
2. **Restore from the last committed state** and re-drive the crank.
3. **Recycle the instance** first ([above](#recycling-the-instance)).

It is a panic (`Halt::is_panic`), so every commit path that discards panics already discards it,
and the `endo` crate's `ExecutionOutcome::classify` reports it as `Panicked`.
`Halt::is_host_failure` is the predicate that separates it from `HeapExhausted`: true only for
this halt, it answers whether the halt may be recorded as the crank's result.
The Thixotrope worker already exits without committing on any halt; it now names this one as the
host's in its fatal frame ("host failure, crank not committed: ... restore in a fresh worker").

What raises it:

- **Every `try_reserve` that the ceilings had admitted**: the slot and chunk arenas' growth,
  `reserved_vec`, `reserve_copy_scratch` and the scratch helpers in `admission.rs`, and the sites
  in `property.rs`, `text.rs`, `array.rs` and `json.rs`; the ceiling's own refusals still raise
  `HeapExhausted`.
  A request past the target's `isize::MAX` (2 GiB on wasm32) counts as the host's, since the
  ceiling admitted it.
- **The RegExp crate**, whose compiler stops with a new `CompileStop::Host`
  (`CompileError::HostAllocationFailed`) and whose matcher reports `host_allocation_failed`
  beside `resource_limit`; a literal's validation becomes the lexer's
  `RegExpHostAllocationFailed`, which every source-compiler bridge maps to the halt.
- **Paths that allocated infallibly and now do not**: `units_to_be16`, which copies every guest
  string on its way into the chunk arena; Map and Set entries and their index; and array items,
  whose `BTreeMap` has no fallible insert on stable Rust, so the engine asks the allocator for a
  64 KiB block (and frees it) once for every 128 inserts, and halts if it refuses.
  The pre-flight is best effort: another infallible allocation between two of them can take the
  space it found.

What still allocates infallibly, and so still aborts (a trap on wasm) under a cap: decoding a
string's payload (`be16_to_units`), property tables and key interning, the compiler, Intl, the Map
index's copies of string keys, and the snapshot image, encoder, decoder and checkpoint batch.
The contract treats such a trap the same way, and none of these can commit a crank: the checkpoint
and snapshot paths run after the crank, so a trap there leaves it uncommitted.

Evidence:

- `ironhorse-vm/tests/host_allocation_failure.rs` caps a test thread's allocator natively and
  checks that the forty-string loop, a 40 MB `repeat`, the slot arena, Map entries and array items
  each end in the new halt, that a ceiling below the cap still halts with `HeapExhausted` at the
  same computrons capped and uncapped, and that the process survives.
  With each conversion reverted in turn, the slot test reports `HeapExhausted` and the Map and
  array tests abort the binary (`memory allocation of 320 bytes failed` for an array node).
- `memory.py --host-halt` runs the probe under a 128 MiB Wasmtime cap.
  The forty-string loop ends in `HostAllocationFailed` at 4,457,259 computrons; strings, the
  doubled string, the mix, arrays, Maps and Sets each end in it rather than trapping, and the
  object list, which fits, still returns.
- **Release-neutral**: `stack-lanes/differential.py --base dc960427` reports `same` on all 1,763
  programs; `cargo test --release --workspace --no-fail-fast` passes 3,676 tests in 476 suites;
  the benchmark check is in the pull request.
  The halt is unreachable unless an allocation fails.

One more wasm blocker surfaced: `begin_store_session` panicked on WASI, because `RandomTokens`
hashed `std::process::id()`, which WASI lacks.
This branch takes the fix
[endojs/endo-but-for-bots#1450](https://github.com/endojs/endo-but-for-bots/pull/1450) makes, line
for line, so the checkpoint could be measured.

## What production Cloudflare enforcement would change

The Workers documentation says the 128 MB limit is per isolate and that an isolate past it is
replaced once its in-flight requests complete.
Local workerd enforces no limit, so whether production also fails `memory.grow` first is unknown.
The two answers lead to different hosts:

- **If production fails `memory.grow` at the cap**, as Wasmtime's limits do, the engine halts with
  `HostAllocationFailed` on the paths above and traps on the rest.
  The Durable Object host rolls back the transaction, drops the instance, records nothing, and
  re-drives the delivery in a fresh instance after recycling.
  The ceilings are then a safety margin, and a vat larger than they allow could run, its overruns
  turned into retryable host failures.
- **If production only replaces the isolate**, nothing inside the crank fails: the crank can
  complete and commit, and the replacement then resets every Durable Object in the isolate.
  Committed state survives, but every co-resident object pays a wake.
  The ceilings and the recycling threshold are then the only bound, and they must be the
  conservative ones above.
- **Either way**, whether compiled wasm code counts toward the 128 MB decides the host's share,
  taken here as 24 MiB.

The smallest experiment that would settle it, which this report describes and does not run:

1. A Worker, not a Durable Object, bundling a module of a few lines of WAT that exports its memory,
   `grow(pages) -> i32` (`memory.grow`) and `size() -> i32`, and a global id drawn once per
   isolate (`crypto.randomUUID()` at module scope).
2. A fetch handler that grows the memory by 64 pages (4 MiB) per request and returns the id,
   `grow`'s result and the new size.
3. A local script that requests it in a loop until 200 MB, recording, per request, whether `grow`
   returned -1, whether the request failed (and with what message), and when the id changed.
4. A second run growing past 128 MB inside one request, to see whether the request itself fails.
5. A third with a JS array of the same size instead of wasm memory, and one with a larger module,
   to see what counts toward the cap.

`grow` returning -1 means the first answer above; the id changing with every `grow` succeeding
means the second.
The run costs one deploy and a few hundred requests.

## Reproduction

From `rust/engine/stack-lanes/memory`, with the toolchain of `stack-lanes/README.md`, the Wasmtime
49 CLI as `$WASMTIME` and Node 22; `memory.py --summarize <file>` prints a file as the tables
above.

| Figures | Command | File |
|---|---|---|
| Footprints and coefficients at 1,000,000 and 250,000 slots | `python3 memory.py --output results/matrix.json` | `matrix.json` |
| Restores of the large string and Map heaps | `python3 memory.py --no-build --ceilings default --shape strings --shape string-doubling --shape small-strings --shape maps --output results/large-restores.json` | `large-restores.json` |
| The capped-host halt | `python3 memory.py --no-build --host-halt --output results/host-halt.json` | `host-halt.json` |
| Objects at 2^20 and just past it | `python3 memory.py --no-build --shape objects --ceiling 1048576 268435456 --output results/slots-2-20.json`, and `1100000` into `slots-past-2-20.json` | `slots-2-20.json`, `slots-past-2-20.json` |
| Strings at a 160 MiB ceiling | `python3 memory.py --no-build --shape strings --shape string-doubling --ceiling 1000000 167772160 --output results/chunks-160MiB.json` | `chunks-160MiB.json` |
| The Cloudflare candidates | `python3 memory.py --no-build --shape strings --shape string-doubling --shape small-strings --shape objects --shape mixed --ceiling 262144 4194304 --output results/cloudflare-2-18-4MiB.json`, and `524288 8388608` into `cloudflare-2-19-8MiB.json` | `cloudflare-2-18-4MiB.json`, `cloudflare-2-19-8MiB.json` |
| Native, default ceilings | `python3 memory.py --no-build --native --ceilings default --output results/native.json` | `native.json` |
| The container candidate, native | `python3 memory.py --no-build --native --shape strings --shape string-doubling --shape small-strings --shape objects --shape mixed --ceiling 1048576 67108864 --output results/container-2-20-64MiB-native.json` | `container-2-20-64MiB-native.json` |
| The recycle cost | `python3 memory.py --no-build --recycle --output results/recycle.json` | `recycle.json` |
| The capped snapshot trap | `sed 's/__N__/20/' programs/strings.js \| $WASMTIME run -W exceptions=y -W max-memory-size=268435456 probe/target/wasm32-wasip1/release/ih-memory-probe.wasm snapshot` | |

The formula's rows are the coefficient tables' worst entries; the profile tables evaluate it.
The host's share comes from `recycle.json`'s `rss_before_mb`, `rss_instantiated_mb` and
`js_heap_mb`.
The B7 figure of 73 bytes per slot at 44,000,000 objects is from
[WASM-BLOCKERS.md](WASM-BLOCKERS.md#latent-host-limits-the-ceilings-can-outrun), and the counter
vat's wake from the
[Cloudflare review](../../designs/thixotrope-on-cloudflare-review.md).
