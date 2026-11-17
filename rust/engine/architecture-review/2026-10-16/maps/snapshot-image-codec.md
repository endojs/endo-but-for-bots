# Map: Snapshot images, codecs and the persistence seam

Reviewed commit `61cd656cb`.

## Scope

Snapshot crate (`rust/engine/ironhorse-snapshot/src/`), 19,841 lines:

| File | Lines | Notes |
|---|---:|---|
| `image.rs` | 11,956 | ~5,460 production, ~6,500 unit tests (from line 5463) |
| `image/shared_codec.rs` | 421 | format-21 shared-Realm FUNC extension |
| `snapshot_roster.rs` | 4,074 | `snapshot_payloads!` table (34 sections, lines 12-2817) plus tests |
| `sidetable.rs` | 1,392 | side-table coverage ledger |
| `format.rs` | 683 | FourCCs, `VERS`, `SIGN`, `SnapshotError` |
| `stream.rs` | 347 | streaming whole-heap writer |
| `atom.rs` | 317 | `XS_M` atom framing |
| `slot_codec.rs` | 291 | 20-byte slot record |
| `sink.rs` | 202 | `Sink`, `ByteCounter`, `WriteSink` |
| `versions.rs` | 82 | version-axis doc |
| `lib.rs` | 76 | exports |

VM side (`rust/engine/ironhorse-vm/src/`), 8,675 lines:

| File | Lines |
|---|---:|
| `interp/persist.rs` | 4,643 |
| `interp/restore.rs` | 1,946 |
| `interp/shared_persist.rs` | 925 |
| `interp/snapshot_rows.rs` | 648 |
| `module_snapshot.rs` | 237 |
| `interp/persistence.rs` | 200 |
| `interp/snapshot_views.rs` | 51 |
| `snapshot_api.rs` | 25 |

Tests skimmed: `ironhorse-snapshot/tests/` (85 files, 23,161 lines).

## What was read

- Full read: `atom.rs`, `format.rs`, `sink.rs`, `stream.rs`, `lib.rs`, `versions.rs`, `interp/persistence.rs`, `snapshot_api.rs`, `interp/snapshot_views.rs`.
- `slot_codec.rs`: codec (1-166) in full; tests skimmed.
- `image.rs`, targeted: `MeterImage`/`CreationParams` (40-180), `MachineImage`/`GatedImage`/`ValidatedSnapshot` (400-560), arena conversion (808-827), string/name/u32/heap codecs and `Cursor` (831-1143), FUNC codec (2182-2414), WKRF/FNRG codecs (2751-2873), bounds gates (4793-5120), stack codec, `encode_machine`, `read_machine`, `read_validated_machine` (5122-5461); one test (7818-7870).
  The other ~25 decoders were checked only with greps for allocation clamps, ascending-owner checks, `unwrap`/`unreachable`, and narrowing casts.
- `image/shared_codec.rs`: encoder and decoder head (1-140), the rest by grep.
- `snapshot_roster.rs`: header and first four sections (1-186), Functions gate (1427-1595), Generators gate (2030-2110), WeakRefs/FinalizationRegistries (2685-2817), payload-descriptor macro head.
  I measured per-section size and gate size with a script.
- `sidetable.rs`: coverage model (100-270) and ledger tests (560-700).
- `interp/persist.rs`: restore validators (1-210), `restore_snapshot_state` (233-310), persistence admission `stored_unpersistable_row_inner`/`function_persists` (530-800), boot accessor rebuild (850-925), `restore_function_state` (1705-1880), `restore_weak_refs`, `finalization_registries_snapshot` (2342-2390), `promise_cluster_snapshot` ordering (2760-2990, grep), `is_quiescent` (4539).
  A script checked every `*_snapshot` capture function for sorting.
- `interp/restore.rs`: session, finish, cross-row validators, admission (1-360); every row wrapper (394-604).
- `module_snapshot.rs`: 1-180.
- `snapshot_rows.rs`: outline only.
- Neighbours read for context: `ironhorse-snapshot/src/machine.rs` (`MachineSnapshotError` 55-90, `persist_gate` and write verbs 159-280, `image_to_interp`/`from_snapshot_bytes`/`resume_from_cas` 491-584), `ironhorse-vm/src/value.rs` (`Slot`/`Payload`/`SlotIndex`/`ChunkOffset` 430-640, `find_property` 1325-1350, `ChunkArena` `view`/`len_of`/`restored_payload_len`/`validate_references`/`from_image`), `property/ordinary.rs` 40-140, `property_index.rs::find`, `meter.rs` 180-240 and 320-345, `opcode.rs::instruction_len`, `interp/natives/weak.rs` header, `ironhorse-fuzz/src/snapshot.rs` decoder target (1072-1101), `ARCHITECTURE.md` 215-240, `WASM-MEMORY.md` 170-290, `designs/ironhorse-snapshot-store-seam.md` 1-30 and 960-1000.

## What was not read

- `image.rs` decoders for ARRY/IDXP/COLL/REGY/ERRD/ESTK/ABUF/TARR/DVIW/WRAP/REGX/DATE/TMPR/INTL/ITER/ASYN/PRMS/DISP/PROX/ACCS/IBFN/PRIV/GENR were not read line by line, only grepped.
  The Temporal, Intl, iterator and promise-cluster decoders (about 1,700 lines) are the largest blind spot.
- `image.rs` unit tests (6,500 lines), apart from the one test named above.
- `snapshot_roster.rs` gate bodies for Promises (264 lines), Iterators (78), Buffers (66), Intl, Proxies, Accessors, PrivateElements, and its 1,250 lines of tests.
- `interp/shared_persist.rs` restore bodies (605 lines); `persist.rs` Temporal/Intl/iterator/promise restore (3000-4500).
- `sidetable.rs` tests beyond the ledger.
- The store path (`store.rs`, `store_file.rs`, `store_sections.rs`, `stored_slots.rs`, most of `machine.rs`), which belongs to another region.
- Integration tests other than `crafted_row_refusals.rs` (partly), `restore_side_tables.rs` (head), `persist_gates.rs` (test list and two tests), `chunk_length_refusal.rs` (head) and `refusal_allowlist.tsv`.

## Architecture as built

**Wire grammar.**
A container is one `XS_M` atom whose payload is a sequence of `[u32 BE size][FourCC][payload]` atoms (`atom.rs:19-55`).
`AtomReader::parse` (`atom.rs:166-194`) requires exact envelope consumption and rejects a duplicate tag with a pairwise scan (`atom.rs:186-192`).
`read_machine` then requires the atom sequence to be an in-order subsequence of `CANONICAL_ATOM_ORDER` (`image.rs:5382-5395`).
That order is 38 tags: the five fixed atoms `VERS SIGN CREA BLOC HEAP` plus the 33 atom-bearing roster sections (`format.rs:185`, `snapshot_roster.rs`).
`VERS` is a 10-byte payload: `"IRON"`, the u32 format, slot width 20, and endianness 1 (`format.rs:286-336`).
The write stamp is 26; the read range is `1..=26` (`format.rs:246,254`).
`SIGN` is `"IHB1"`, a 32-byte boot fingerprint and the host string (`format.rs:419-440`); both the container's and the caller's fingerprints must equal `Interp::boot_fingerprint()`.

**Slot record.**
A slot record is 20 bytes on the wire (`slot_codec.rs:9-34`).
The layout is kind, flag, id u16, next u32, payload tag, one reserved byte, then 10 data bytes.
The in-memory `Slot` is 24 bytes, with a 16-byte `Payload` (measured `size_of`).
`decode_slot` (`slot_codec.rs:115-129`) checks that the kind byte and payload tag are known, and checks nothing else.
It ignores the reserved byte, and it does not check that the kind agrees with the payload arm.
NaNs are canonicalized on encode.

**HEAP and BLOC.**
`HEAP` is `[slot_count][free_count][live][free…][records…]` (`image.rs:979-1077`).
The decoder checks that the free list is in range and has no duplicates, that `free + live == slot_count`, and that there are no trailing bytes.
Free records are carried as opaque stale bytes, 20 bytes each plus a 4-byte list entry.
`BLOC` is the raw chunk arena: `[u32 LE len][payload]` blocks, with a `u32::MAX` free-block marker since format 17.
It is copied verbatim (`image.rs:5404-5405`).
For format ≥16 its length must equal `CREA.initial_chunk_bytes` (`image.rs:5402`).

**Image types.**
`MachineImage` (`image.rs:406-488`) is the public plain-data model of a machine: 38 fields.
Eleven side tables use snapshot-crate structs (`ArrayImage`…`DateImage`, `image.rs:189-345`); newer rows reuse the VM's `snapshot_api` row structs directly.
`GatedImage` (`image.rs:500`) is the write proof and `ValidatedSnapshot` (`image.rs:538`) is the restore proof.
Both are private-field newtypes.

**Roster.**
`snapshot_roster.rs:12-2817` is a single `macro_rules!` table of 34 sections.
Each section declares its image field, live capture, bounds and gate code, restore call, small-state initializer, legacy store decode, container decode, atom, presence rule, encoder, canonicalizer, and slot-visit class.
The consumers include `image.rs` itself, through `define_container_decoder!` (`image.rs:5276`) and `define_gate_chain!` (`image.rs:4871`).
The gate code totals 947 lines.
`SmallSection`, the store section id, is generated from the VM's `snapshot_sections!` (`store_sections.rs:17-47`), so section identity has one source.

**Write path.**
`MachineSnapshot::write_snapshot` (`machine.rs:262-277`) runs `persist_gate` first: `is_quiescent`, then `stored_unpersistable_row`.
It then streams through `LiveSnapshot` (`stream.rs:52-344`).
A sizing pass runs every section encoder into a `ByteCounter`, and a write pass runs the same encoders into the sink, with a length check per atom.
HEAP and BLOC are read in place (`records_iter`, `raw_bytes`), and arrays, index properties and collections through borrowed row views (`snapshot_views.rs`).
Other side tables are copied into an owned `SmallState`.
`encode_machine` (`image.rs:5173-5245`) is the image-based writer, used by `write_machine(GatedImage)` and by the reader's canonical check.

**Read path.**
`from_snapshot_bytes` (`machine.rs:547`) → `read_validated_machine` (`image.rs:5450`) → `read_machine` (`image.rs:5359-5442`).
`read_machine` runs these steps in order:

1. Parse atoms, then check `VERS`, the `SIGN` boot fingerprint and host signature, and the canonical atom order.
2. Decode CREA and BLOC, then `decode_heap`.
3. Run the roster's container decoders (each enforces ascending owners and exact consumption).
4. `check_machine_image_bounds` (`image.rs:4955`) visits every stored `Slot`.
   References must be in range and not free; non-null chunk offsets must satisfy `4 <= o <= chunk_len` (`image.rs:5051-5120`).
   It then runs the roster gate chain and `check_buffer_chunk_lengths`.
5. For format ≥15, require the core atoms; for format ≥16, re-encode the whole image and require byte equality with the input (`image.rs:5438`).

`image_to_interp` (`machine.rs:491-529`) then opens a `RestoreSession` (`restore.rs:47-345`).
The session admits 25 named row sets exactly once each (`RESTORE_ROWS`, `restore.rs:7-32`).
`snapshot_state` must come first and `native_names` before the side tables.
Each VM `restore_*` validates its rows again: owners live, `Kind::Instance`, ascending; values well-shaped, with chunk references walked through `ChunkArena::validate_references` (`persist.rs:103-180`).
`finish` (`restore.rs:68-132`) runs the cross-row checks: callable-graph acyclicity, suspended cursors, accessor backing, mapped arguments, promise capabilities, quiescence, and the lockdown marker.
For HEAP itself, restore validates only the global object's property chain and the boot accessor prototypes' chains (`persist.rs:266`, `persist.rs:890`).

**Admission (persistence refusals).**
`stored_unpersistable_row_inner` (`persist.rs:578-766`) refuses, in order:

- a module graph that is Linking/Evaluating or holds a non-primitive value (`module_snapshot.rs:23-34`);
- the `$262` host;
- a live guest `Compartment`;
- compartment `globalLexicals`;
- `shared_compartments` without a primordial profile;
- an uncarried reaction kind (currently unreachable);
- a stored reference to a function `function_persists` rejects (`persist.rs:775-808`; today only `CopyObject`), found by a heap walk plus the `persist_holder!` traversal (`persistence.rs:15-120`).

`Coverage::Pending` has no members (`sidetable.rs`).

**Determinism.**
Every capture function sorts by owner (34/34 checked), NaNs are canonical, and no address enters the bytes.
The encoding is a deterministic function of the arena history, but not of the logical heap: free records and the free list order are history.

## Candidate findings

### SNI-1 — A crafted container can make a prototype cycle, so property lookups spin forever and the meter never fires

- **Lens(es):** 1 (sanity/correctness: host hang, meter bypass from untrusted input)
- **Proposed severity:** high
- **Location:** `rust/engine/ironhorse-vm/src/interp/persist.rs:266` (the only chain validation in `restore_snapshot_state`); `rust/engine/ironhorse-snapshot/src/image.rs:5051-5120` (`check_stored_bounds`); the unbounded prototype walks at `rust/engine/ironhorse-vm/src/interp/property.rs:354,1361,1688,1830,1867`, `property/read_index.rs:94` and `render.rs:442`; the contract at `rust/engine/ARCHITECTURE.md:236`.
- **Excerpt:** `ARCHITECTURE.md:236`: "Containers can come from elsewhere, so they are still validated completely before adoption."
  `persist.rs:266`: `validate_restore_chain(&slots, self.environment.global_obj, &mut Default::default())?;`
  `property.rs:1361`: `while !current.is_null() {`
- **Mechanism:** An instance's prototype is the `Payload::Reference` of its `Kind::Instance` slot.
  The reader's bounds gate only checks that the reference is in range and live.
  The VM checks acyclicity for proxy and bound-function targets (`restore.rs:247-280`), but never for `[[Prototype]]` chains.
  Live code keeps the chain acyclic through the `[[SetPrototypeOf]]` check, so the lookup loops have no cycle guard and no meter check inside them.
- **Scenario:** A container from another host or a CAS peer sets `o.__proto__ = o` in the HEAP record.
  `from_snapshot_bytes` accepts it.
  The first `o.missing` or `'x' in o` spins inside one bytecode, so even an armed meter whose host refuses at the first check never gets control.
- **Evidence:** Probe 1, P7 (source below; output in `probes/snapshot-image-codec/probe1.log`).
  The meter is armed at 10,000 computrons with a host that always refuses:
  ```text
  [P7] owner=1100 proto=Reference(SlotIndex(1))
  [P7] crafted self-prototype ACCEPTED
  [P7 'zz' in o] HANG: no result after 15s
  [P7 o.zz (metered)] HANG: no result after 15s
  ```
  The fuzz target `ironhorse-fuzz/src/snapshot.rs:1078-1101` only decodes and restores; it never runs a crank on the restored machine, so it cannot find this class.
- **Recommendation:** At container adoption, after `restore_snapshot_state`, run one O(slots) pass over the live HEAP.
  It should check, for every `Kind::Instance`:
  - the property chain, with `validate_restore_chain` and its shared `complete` set (this also covers SNI-4's own-chain cycles);
  - the prototype chain, with three-colour marking that refuses any back edge.
  The cost matches the existing `stored_unregistered_key_id` walk.
  As cheap insurance, add a hop bound or cycle check to the prototype walkers.
- **Confidence:** confirmed by probe.

Probe 1 source (`ironhorse-snapshot/tests/zz_audit_sni_1.rs`, deleted after the run; archived at `../probes/snapshot-image-codec/zz_audit_sni_1.rs`):

```rust
//! TEMPORARY audit probe (SNI region). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{ChunkOffset, Interp, Kind, Payload, Slot, SlotIndex};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            if n > l.size() {
                let c = CUR.fetch_add(n - l.size(), Ordering::Relaxed) + (n - l.size());
                PEAK.fetch_max(c, Ordering::Relaxed);
            } else {
                CUR.fetch_sub(l.size() - n, Ordering::Relaxed);
            }
        }
        q
    }
}
#[global_allocator]
static A: Counting = Counting;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn machine(src: &str) -> Interp {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "fixture: {:?}", o.halt);
    m
}

fn crank(m: &mut Interp, src: &str) -> String {
    let (b, n) = compile(src);
    let code = m.relink_crank(&b, &n).expect("relinks");
    let o = m.run(&code);
    format!(
        "completed={} result={:?} halt={:?}",
        o.completed,
        o.result.chars().take(80).collect::<String>(),
        o.halt
    )
}

/// Run `f` on a fresh thread with a deadline; report its outcome or a hang.
fn guarded(label: &str, secs: u64, f: impl FnOnce() -> String + Send + 'static) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
            let _ = tx.send(match r {
                Ok(s) => format!("returned: {s}"),
                Err(e) => format!(
                    "HOST PANIC: {}",
                    e.downcast_ref::<String>()
                        .cloned()
                        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default()
                ),
            });
        })
        .unwrap();
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(s) => {
            println!("[{label}] {s}");
            false
        }
        Err(_) => {
            println!("[{label}] HANG: no result after {secs}s");
            true
        }
    }
}

fn find_int(slots: &[Slot], v: i32) -> Vec<usize> {
    slots
        .iter()
        .enumerate()
        .filter(|(_, s)| s.value == Payload::Integer(v))
        .map(|(i, _)| i)
        .collect()
}

fn owner_of(slots: &[Slot], prop: usize) -> usize {
    for (i, s) in slots.iter().enumerate() {
        if s.kind != Kind::Instance {
            continue;
        }
        let mut cur = s.next;
        for _ in 0..16 {
            if cur.is_null() || cur.0 as usize >= slots.len() {
                break;
            }
            if cur.0 as usize == prop {
                return i;
            }
            cur = slots[cur.0 as usize].next;
        }
    }
    panic!("no owner");
}

#[test]
fn sni_probe() {
    println!(
        "size_of Slot={} Payload={} SlotIndex={}",
        std::mem::size_of::<Slot>(),
        std::mem::size_of::<Payload>(),
        std::mem::size_of::<SlotIndex>()
    );

    // ---- P1: peak allocation during an eager container restore ----
    for (label, src) in [
        (
            "objects",
            "var a = []; for (var i = 0; i < 100000; i++) { a.push({x: i, y: i + 1}); } a.length",
        ),
        (
            "strings",
            "var a = []; for (var i = 0; i < 20000; i++) { a.push('s' + i + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); } a.length",
        ),
    ] {
        let m = machine(src);
        let before = CUR.load(Ordering::Relaxed);
        let bytes = m.write_snapshot(&sig()).unwrap();
        let c = bytes.len();
        let slots = m.slots().capacity();
        let chunk = m.chunks().byte_size();
        drop(m);
        let base = CUR.load(Ordering::Relaxed);
        PEAK.store(base, Ordering::Relaxed);
        let t = Instant::now();
        let image = ironhorse_snapshot::image::read_validated_machine(&bytes, &sig()).unwrap();
        let read_peak = PEAK.load(Ordering::Relaxed) - base;
        let after_read = CUR.load(Ordering::Relaxed) - base;
        PEAK.store(CUR.load(Ordering::Relaxed), Ordering::Relaxed);
        let base2 = CUR.load(Ordering::Relaxed);
        let restored = ironhorse_snapshot::machine::image_to_interp(image).unwrap();
        let interp_peak = PEAK.load(Ordering::Relaxed) - base2 + after_read;
        let resident = CUR.load(Ordering::Relaxed) - base;
        println!(
            "[P1 {label}] container={c} B, slots={slots} (wire {} B), chunk={chunk} B; \
             read_validated_machine peak +{read_peak} B ({:.2}x container), image held {after_read} B; \
             image_to_interp peak (incl. image) +{interp_peak} B ({:.2}x); restored machine {resident} B; \
             total {:?}; pre-snapshot live {before}",
            slots as usize * 20,
            read_peak as f64 / c as f64,
            interp_peak as f64 / c as f64,
            t.elapsed()
        );
        drop(restored);
    }

    // ---- P2: O(n^2) duplicate-tag scan before any gate ----
    for n in [8_000usize, 16_000, 32_000, 64_000] {
        let mut buf = Vec::with_capacity(8 + 8 * n);
        buf.extend_from_slice(&((8 + 8 * n) as u32).to_be_bytes());
        buf.extend_from_slice(b"XS_M");
        for i in 0..n as u32 {
            buf.extend_from_slice(&8u32.to_be_bytes());
            buf.extend_from_slice(&(i | 0x8000_0000).to_be_bytes());
        }
        let t = Instant::now();
        let r = read_machine(&buf, &sig());
        println!(
            "[P2] atoms={n} bytes={} refused={:?} in {:?}",
            buf.len(),
            r.err().map(|e| e.to_string()),
            t.elapsed()
        );
    }

    // ---- P3: dead/advisory fields accepted (KEYS content, CREA slot count) ----
    {
        let m = machine("var t = 1; t");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        image.keys = vec!["junk".into(), "x".repeat(1000)];
        image.creation.initial_slot_count = image.creation.initial_slot_count.wrapping_add(12345);
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(r) => {
                let again = r.write_snapshot(&sig()).unwrap();
                println!(
                    "[P3] crafted KEYS+CREA ACCEPTED; honest={} crafted={} rewrite={} rewrite==honest:{} rewrite==crafted:{}",
                    honest.len(),
                    crafted.len(),
                    again.len(),
                    again == honest,
                    again == crafted
                );
            }
            Err(e) => println!("[P3] refused: {e}"),
        }
    }

    // ---- P4: string slot offset moved inside its own allocation ----
    {
        let m = machine("var s = 'ABCDEFGHIJKLMNOP'; var mark = 777002; s.length");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let pat: Vec<u8> = "ABCDEFGHIJKLMNOP"
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        let at = image
            .chunks
            .windows(pat.len())
            .position(|w| w == pat.as_slice())
            .expect("string bytes in BLOC");
        let mut changed = 0;
        for s in image.slots.iter_mut() {
            if s.value == Payload::String(ChunkOffset(at as u32)) {
                s.value = Payload::String(ChunkOffset(at as u32 + 4));
                changed += 1;
            }
        }
        println!("[P4] string payload at {at}, rewired {changed} slot(s) to +4");
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P4] crafted container ACCEPTED by from_snapshot_bytes");
                let c2 = crafted.clone();
                guarded("P4 s.length", 20, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "s.length")
                });
                let c3 = crafted.clone();
                guarded("P4 s + '!'", 20, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    crank(&mut r, "(s + '!').length")
                });
            }
            Err(e) => println!("[P4] refused: {e}"),
        }
    }

    // ---- P5: kind/payload mismatch in a heap record ----
    {
        let m = machine("var n = 777003; n");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let hits = find_int(&image.slots, 777003);
        for &i in &hits {
            image.slots[i].kind = Kind::String;
        }
        println!("[P5] retagged {} slot(s) Integer->String kind", hits.len());
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P5] crafted container ACCEPTED");
                let c2 = crafted.clone();
                guarded("P5 n.length", 20, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "n.length")
                });
                let c3 = crafted.clone();
                guarded("P5 typeof n", 20, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    crank(&mut r, "typeof n")
                });
            }
            Err(e) => println!("[P5] refused: {e}"),
        }
    }

    // ---- P6: own-property chain cycle on a non-global object ----
    {
        let m = machine("var o = {a: 777004, b: 777005}; 1");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let pa = find_int(&image.slots, 777004)[0];
        let pb = find_int(&image.slots, 777005)[0];
        let owner = owner_of(&image.slots, pa);
        // Whichever of a/b is the tail, point its next back at the head.
        let head = image.slots[owner].next.0 as usize;
        let tail = if head == pa { pb } else { pa };
        println!(
            "[P6] owner={owner} head={head} tail={tail} tail.next={:?}",
            image.slots[tail].next
        );
        image.slots[tail].next = SlotIndex(head as u32);
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P6] crafted cyclic own-property chain ACCEPTED");
                let c2 = crafted.clone();
                guarded("P6 o.zz (lookup)", 10, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "o.zz")
                });
            }
            Err(e) => println!("[P6] refused: {e}"),
        }
    }

    // ---- P7: prototype cycle (instance is its own prototype) ----
    let mut hung = false;
    {
        let m = machine("var o = {mark: 777001}; 1");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let p = find_int(&image.slots, 777001)[0];
        let owner = owner_of(&image.slots, p);
        println!("[P7] owner={owner} proto={:?}", image.slots[owner].value);
        image.slots[owner].value = Payload::Reference(SlotIndex(owner as u32));
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P7] crafted self-prototype ACCEPTED");
                let c2 = crafted.clone();
                hung |= guarded("P7 'zz' in o", 15, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "'zz' in o")
                });
                let c3 = crafted.clone();
                hung |= guarded("P7 o.zz (metered)", 15, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "o.zz")
                });
            }
            Err(e) => println!("[P7] refused: {e}"),
        }
    }
    if hung {
        println!("exiting with spinning thread(s)");
        std::process::exit(0);
    }
}
```

### SNI-2 — HEAP chunk offsets are only range-checked, so a crafted string gives wrong answers and then a host panic

- **Lens(es):** 1
- **Proposed severity:** high
- **Location:** `rust/engine/ironhorse-snapshot/src/image.rs:5099-5108` (the only chunk check on heap records); `rust/engine/ironhorse-vm/src/value.rs:2596-2607` (`len_of` trusts the header); `value.rs:2316-2318` (`view` slices unchecked).
- **Excerpt:**
  ```rust
  if let Some(off) = s.chunk_ref() {
      if !off.is_null() {
          let o = off.0 as usize;
          // A payload offset sits ABOVE its 4-byte header and the
          // header must lie inside the arena …
          if o < CHUNK_HEADER || o > chunk_len {
              return Err(OOC);
  ```
- **Mechanism:**
  - Side-table values go through `ChunkArena::validate_references`, which walks the block chain and requires real allocation boundaries (`persist.rs:148-170`).
  - HEAP records (`Kind::String`/`BigInt` property values, `Symbol` descriptors) get only `4 <= off <= len`.
  - An offset inside another block makes `len_of` read four payload bytes as a length.
  - The `BLOC` chain itself is never walked at read either (`image.rs:5216-5219` says "malformed block lengths retain the existing deferred-validation policy").
  - The store design accepts this as a named limitation for the trusted resident store (`designs/ironhorse-snapshot-store-seam.md:977-993`).
    For containers it contradicts `ARCHITECTURE.md:236`.
- **Scenario:** A container moves one string's offset four bytes into its own payload.
  It is accepted.
  `s.length` silently returns 553,656,448.
  The first concatenation panics the host with an out-of-range slice.
  The panic is not a resource halt, so `run` re-raises it (`interp.rs:2973-2991`).
- **Evidence:** Probe 1, P4:
  ```text
  [P4] string payload at 17188, rewired 1 slot(s) to +4
  [P4] crafted container ACCEPTED by from_snapshot_bytes
  [P4 s.length] returned: completed=true result="553656448" halt=Return
  [P4 s + '!'] HOST PANIC: range end index 1107330088 out of range for slice of length 17226
  ```
  The panic site is `ironhorse-vm/src/value.rs:2318:57`, reached via `strings.rs:22` from `coerce.rs:1034`.
- **Recommendation:** In the same adoption pass as SNI-1, collect every non-null chunk reference of the live HEAP records.
  Pass them to one `ChunkArena::validate_references` call, which walks the chain once in O(chunk bytes + refs log refs).
  Then apply the per-kind payload checks `validate_restore_values` already makes (even-length String, canonical BigInt).
  This also validates the BLOC chain that GC compaction later asserts on.
- **Confidence:** confirmed by probe.

### SNI-3 — `METR` counters are not validated, so a crafted meter index panics the host on the first dispatched instruction

- **Lens(es):** 1
- **Proposed severity:** high
- **Location:** `rust/engine/ironhorse-snapshot/src/image.rs:103-131` (`MeterImage::decode`), `image.rs:133-151` (`validate` checks only the cost-table identity), `rust/engine/ironhorse-vm/src/meter.rs:328-334` (`restore`), `meter.rs:187-189` (`tick_code`), `rust/engine/Cargo.toml:30-31` (`overflow-checks = true` in release).
- **Excerpt:** `meter.rs:188`: `self.index += CODE_METERING;` with `CODE_METERING = 1 << 16` (`ironhorse-meter/src/lib.rs:131`).
- **Mechanism:** `index`, `interval` and `count` are accepted as arbitrary u64 values.
  Overflow checks are on in every profile, so an index near `u64::MAX` panics at the first tick.
  That panic is not a resource halt, so it propagates to the host.
- **Scenario:** A crafted container carries `index = u64::MAX - 3`.
  Every crank on the restored machine aborts the host process or thread.
  Honest reachability is a separate question for the meter region.
  The endo embedder arms once and then reattaches across restores (`rust/endo/src/ironhorse_engine.rs:1189,1320-1324`), so `index` is a lifetime accumulator in 2^-16-computron units.
  It overflows after 2^48 computron-equivalents of lifetime work, which is about a month of CPU at 10^8 dispatches/s.
- **Evidence:** Probe 4:
  ```text
  [P11] honest METR index=1214256 interval=0 count=0
  [P11] METR index=u64::MAX-3 ACCEPTED
  thread 'sni_part4_meter_counters' panicked at ironhorse-vm/src/meter.rs:188:9:
  [P11] HOST PANIC: attempt to add with overflow
  ```
  Probe 4 source (deleted from the tree; archived as `zz_audit_sni_4.rs`):
  ```rust
  //! TEMPORARY audit probe (SNI region, part 4). Delete after the audit.
  #[path = "common/compile.rs"]
  mod guest_compile;
  use guest_compile::compile;

  use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
  use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
  use ironhorse_snapshot::Signature;
  use ironhorse_vm::Interp;

  fn sig() -> Signature {
      Signature::new("ironhorse-worker-v1")
  }

  #[test]
  fn sni_part4_meter_counters() {
      let (b, n) = compile("var t = 1; t");
      let mut m = Interp::new();
      m.link_intrinsics(&n);
      assert!(m.run(&b).completed);
      let honest = m.write_snapshot(&sig()).unwrap();
      let mut image = read_machine(&honest, &sig()).unwrap();
      println!(
          "[P11] honest METR index={} interval={} count={}",
          image.meter.index, image.meter.interval, image.meter.count
      );
      image.meter.index = u64::MAX - 3;
      let crafted = write_machine_unchecked(&image);
      match from_snapshot_bytes(&crafted, &sig()) {
          Ok(mut r) => {
              println!("[P11] METR index=u64::MAX-3 ACCEPTED");
              let (b2, n2) = compile("t + 1");
              let code = r.relink_crank(&b2, &n2).unwrap();
              let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                  let o = r.run(&code);
                  format!("completed={} result={} halt={:?}", o.completed, o.result, o.halt)
              }));
              match out {
                  Ok(s) => println!("[P11] crank returned: {s}"),
                  Err(e) => println!(
                      "[P11] HOST PANIC: {}",
                      e.downcast_ref::<String>()
                          .cloned()
                          .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                          .unwrap_or_default()
                  ),
              }
          }
          Err(e) => println!("[P11] refused: {e}"),
      }
  }
  ```
- **Recommendation:**
  - Bound `index` at decode, for example `index <= u64::MAX >> 1`, and check `count`/`interval` coherence (`interval == 0` ⇒ `count == 0`; armed ⇒ `count >= index - interval`, or whatever invariant `check` assumes).
  - In the VM, make the meter's adds saturating, or turn a near-overflow into a `Halt`, so that honest long-lived machines fail closed rather than panic.
- **Confidence:** confirmed by probe (crafted); static arithmetic for the honest case.

### SNI-4 — HEAP record shape is not validated: kind/payload mismatches and own-property cycles are accepted

- **Lens(es):** 1, 6
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-snapshot/src/slot_codec.rs:115-129` (kind and payload decoded independently); `image.rs:5093-5111` (bounds only); the unbounded own-chain walk at `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:75-91` (`own_property_slots`).
- **Excerpt:** `slot_codec.rs:117-121`:
  ```rust
  let kind = Kind::from_u8(rec[0]).ok_or(SlotCodecError::BadKind(rec[0]))?;
  …
  let value = decode_payload(rec[8], &rec[10..20])?;
  ```
- **Mechanism:**
  - The VM already has a per-kind shape table, `validate_restore_value_shape` (`persist.rs:103-145`), but applies it only to side-table values, never to HEAP.
  - Own-property chains are acyclicity-checked only for the global object and boot accessor prototypes.
  - `find_property` tolerates a cycle (`property_index.rs` `Walk::Cycle`).
  - `own_property_slots` pushes into a `Vec` until the chain reaches null, so on a cycle it grows until memory runs out.
    It is reached by `Object.keys`, `freeze`, `JSON.stringify` and integrity checks.
- **Scenario:** A container retags an Integer property as `Kind::String` with an Integer payload.
  `typeof n` answers `"string"` and `n.length` answers `undefined`.
  Another container closes a property chain into a loop.
  It is accepted, and any own-keys enumeration exhausts host memory.
- **Evidence:** Probe 1, P5 and P6:
  ```text
  [P5] crafted container ACCEPTED
  [P5 n.length] returned: completed=true result="undefined" halt=Return
  [P5 typeof n] returned: completed=true result="string" halt=Return
  [P6] crafted cyclic own-property chain ACCEPTED
  [P6 o.zz (lookup)] returned: completed=true result="undefined" halt=Return
  ```
  I did not run the own-keys enumeration on the cyclic chain, because it would exhaust the shared host's memory; that part is static.
- **Recommendation:** Run `validate_restore_value_shape` (or a codec-level kind↔payload table) over every live HEAP record in the SNI-1/SNI-2 pass, plus `validate_restore_chain` for every instance.
  A wire-level table in `decode_slot` is cheaper and makes the slot codec self-describing: it is the one place where "which payload arm a kind takes" would be written.
- **Confidence:** confirmed by probe for acceptance and the wrong answers; high for the OOM path.

### SNI-5 — Duplicate-atom detection is O(n²) and runs before every gate, so a 512 KB container burns 30 s

- **Lens(es):** 1, 4
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-snapshot/src/atom.rs:186-192`
- **Excerpt:**
  ```rust
  for (i, a) in atoms.iter().enumerate() {
      if atoms[..i].iter().any(|b| b.tag == a.tag) {
          return Err(AtomError::DuplicateAtom(a.tag));
  ```
- **Mechanism:** `parse_atoms` accepts any number of 8-byte atoms.
  The duplicate scan is pairwise and runs before `VERS`, `SIGN` and the canonical-order check.
  A valid container has at most 38 atoms, so anything over `CANONICAL_ATOM_ORDER.len()` can only be crafted.
- **Scenario:** Any container import (`from_snapshot_bytes`, `resume_from_cas` after its hash check, store import) is handed N distinct empty atoms.
  A 16 MiB file holds 2M atoms, which is about 2×10^12 comparisons.
- **Evidence:** Probe 1, P2, in a debug build (release will be faster by a constant, not in growth):
  ```text
  [P2] atoms=8000  bytes=64008  refused=…`VERS` is absent in 648ms
  [P2] atoms=16000 bytes=128008 refused=…                 in 3.22s
  [P2] atoms=32000 bytes=256008 refused=…                 in 9.91s
  [P2] atoms=64000 bytes=512008 refused=…                 in 30.5s
  ```
- **Recommendation:** Refuse more than `CANONICAL_ATOM_ORDER.len()` atoms inside `parse`.
  Better, fold the canonical-order check into the parse: each tag must advance a cursor in the order list.
  That implies no duplicates and bounds the work at O(38).
- **Confidence:** confirmed by probe.

### SNI-6 — The FUNC gate walks every function row's body again, so read cost is O(rows × body)

- **Lens(es):** 1, 4, 2
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-snapshot/src/snapshot_roster.rs:1475-1506`; repeated by the VM at `rust/engine/ironhorse-vm/src/interp/persist.rs:1782-1801`.
  Related per-`cur_func` (not per-body) memoization is at `snapshot_roster.rs:2063-2098` and `restore.rs:156-245`.
- **Excerpt:**
  ```rust
  let mut pc = start as usize;
  let end = end as usize;
  while pc < end {
      let Some(len) = ironhorse_vm::instruction_len(code, pc) else {
  ```
- **Mechanism:** Every function row with a body triggers a full instruction walk of `[body_start, body_start+body_len)`.
  Rows are about 40 bytes each, so a crafted container pairs many rows with one large segment.
  Distinct closures of one function legitimately share a body range, so many rows naming one body is a valid shape.
  Honest machines pay the walk once per closure too.
- **Scenario:** A container with a 1 MiB segment and F rows naming it costs F full walks at read, then F more in VM restore.
  The generator gate and `validate_suspended_cursors` memoize by `cur_func` owner rather than by body, so distinct closures of one generator body walk it again.
  Each also runs an O(F) nested-body subtraction per function.
- **Evidence:** Probe 2 (debug build; source below):
  ```text
  [P8] body=1048576 B, rows=1   container=1095190 B: read_machine 109.8ms -> None
  [P8] body=1048576 B, rows=25  container=1096798 B: read_machine 2.14s  -> None
  [P8] body=1048576 B, rows=50  container=1098473 B: read_machine 4.36s  -> None
  [P8] body=1048576 B, rows=100 container=1101823 B: read_machine 9.04s  -> None
  ```
  That is about 90 ms per row per MiB, linear in rows at a constant container size, so quadratic in container size.
  Each row adds 67 bytes.
  ```rust
  //! TEMPORARY audit probe (SNI region, part 2). Delete after the audit.
  #[path = "common/compile.rs"]
  mod guest_compile;
  use guest_compile::compile;

  use std::time::Instant;

  use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
  use ironhorse_snapshot::machine::MachineSnapshot;
  use ironhorse_snapshot::Signature;
  use ironhorse_vm::snapshot_api::FunctionRow;
  use ironhorse_vm::{Interp, Slot};

  fn sig() -> Signature {
      Signature::new("ironhorse-worker-v1")
  }

  /// P8: the FUNC gate walks every function row's body without memoizing by
  /// body range, so F rows naming one L-byte body cost O(F * L) at read.
  #[test]
  fn sni_function_gate_cost() {
      let (b, n) = compile("function f() { return 1; } f()");
      let mut m = Interp::new();
      m.link_intrinsics(&n);
      assert!(m.run(&b).completed);
      let honest = m.write_snapshot(&sig()).unwrap();
      let base = read_machine(&honest, &sig()).unwrap();
      let op = (0u8..=255)
          .find(|&b| ironhorse_vm::instruction_len(&[b], 0) == Some(1))
          .expect("a one-byte opcode");
      println!("one-byte opcode = {op:#04x}");
      let len = 1usize << 20;
      for rows in [0usize, 25, 50, 100] {
          let mut image = base.clone();
          let seg = image.function_state.segments.len() as u32;
          image.function_state.segments.push(vec![op; len]);
          let first = image.slots.len() as u32;
          for i in 0..rows as u32 {
              image.slots.push(Slot::undefined());
              image.function_state.functions.push(FunctionRow {
                  owner: first + i,
                  segment: Some(seg),
                  body_start: Some(0),
                  body_len: len as u64,
                  closures: u32::MAX,
                  name: String::new(),
                  arity: 0,
                  name_chunk: u32::MAX,
                  is_generator: false,
                  home: u32::MAX,
                  class_derived: None,
              });
          }
          if rows == 0 {
              // Keep the segment densely referenced with one row.
              image.slots.push(Slot::undefined());
              image.function_state.functions.push(FunctionRow {
                  owner: first,
                  segment: Some(seg),
                  body_start: Some(0),
                  body_len: len as u64,
                  closures: u32::MAX,
                  name: String::new(),
                  arity: 0,
                  name_chunk: u32::MAX,
                  is_generator: false,
                  home: u32::MAX,
                  class_derived: None,
              });
          }
          image.slot_live = image.slots.len() as u32 - image.slot_free.len() as u32;
          let crafted = write_machine_unchecked(&image);
          let t = Instant::now();
          let r = read_machine(&crafted, &sig());
          println!(
              "[P8] body={len} B, rows={} container={} B: read_machine {:?} -> {:?}",
              rows.max(1),
              crafted.len(),
              t.elapsed(),
              r.as_ref().err().map(|e| e.to_string())
          );
      }
  }
  ```
- **Recommendation:** Memoize the instruction-start set per `(segment, body_start, body_len)`, or walk each segment once and check that body bounds fall on its instruction starts.
  Do it in one shared helper (see the duplication inventory: four copies of this walk), and let the VM restore reuse the gate's proof instead of re-walking.
- **Confidence:** confirmed by probe.

### SNI-7 — Eager restore peaks near 4.7× the container, from avoidable whole-image copies

- **Lens(es):** 4
- **Proposed severity:** medium
- **Location:**
  - `rust/engine/ironhorse-snapshot/src/image.rs:5405` (`let chunks = chunk_bytes.to_vec();`)
  - `image.rs:5438` (`encode_machine(&image)? != buf`)
  - `image.rs:5173-5245` (`encode_machine` builds a separate HEAP `Vec`, an `AtomWriter` body, then `finish` copies into a second buffer, `atom.rs:50-55`)
  - `image.rs:820-826` (`try_to_arenas` clones `slots`, `slot_free`, `chunks`)
  - `rust/engine/ironhorse-snapshot/src/machine.rs:494-496` (clones although `image` is owned)
- **Excerpt:** `machine.rs:494-496`:
  ```rust
  let image = snapshot.into_image();
  let meter = image.meter.to_state();
  let (slots, chunks) = image.try_to_arenas()?;
  ```
- **Mechanism:** The write path streams (`stream.rs`), but the read path does not.
  The canonical-bytes check materializes the full container again, twice transiently.
  The arena build then clones the image's heap and BLOC while the image and the caller's input buffer are both still alive.
- **Scenario:** In `WASM-MEMORY.md` an eager restore is the costliest phase (6.0 per chunk byte and 114 per slot).
  That figure sets the ceilings for a 128 MB isolate.
- **Evidence:** Probe 1, P1, measured with a counting global allocator.
  The peak is above a baseline that already includes the input buffer:
  ```text
  [P1 objects] container=8446403 B … read_validated_machine peak +30980412 B (3.67x container), image held 10452780 B;
               image_to_interp peak (incl. image) +24161084 B (2.86x); restored machine 13651992 B
  [P1 strings] container=5481953 B … read_validated_machine peak +21078378 B (3.85x container), image held 5648276 B;
               image_to_interp peak (incl. image) +12042486 B (2.20x); restored machine 6337098 B
  ```
  Including the input, the peak is 4.7–4.85× the container.
  The floor (input plus restored machine) is about 2.2–2.6×.
- **Recommendation:**
  - Compare canonical bytes through a comparing `Sink` (`struct Cmp<'a>{expect:&'a [u8], pos, equal}`), sized by the `ByteCounter` pass `stream.rs` already has, so the check allocates nothing.
  - Add `MachineImage::into_arenas(self)` that moves the vectors.
  - Optionally take the input as an owned `Vec` so BLOC can be split off rather than copied.
  - Expected peak is about 2.5× the container.
    This is the "decode straight into the arenas" item `WASM-MEMORY.md:284` lists, made concrete.
- **Confidence:** confirmed by measurement; the attribution to sites is by code reading and matches the magnitudes.

### SNI-8 — Freed slot records stay in every container: 98% of the bytes after a garbage burst

- **Lens(es):** 4
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-snapshot/src/image.rs:995-1012` (`encode_heap_into` writes every record, free or not); `rust/engine/ironhorse-vm/src/interp/persist.rs:245-250` (the arena never shrinks).
- **Excerpt:** `for record in records { crate::slot_codec::put_slot(&record, v); }`, and from `image.rs:5075-5083`: "a freed heap record is OPAQUE — the sweep does not scrub it".
- **Mechanism:** The slot arena's capacity is a high-water mark.
  Every snapshot carries 20 bytes of stale content plus 4 bytes of free-list entry per free slot, and restore re-allocates them at 24 bytes in memory.
  The free-list order is load-bearing for allocation determinism, but the stale record contents are not: nothing reads them before `alloc` overwrites them.
- **Scenario:** A vat that once built and dropped a large structure pays for it in every later snapshot, CAS blob and restore.
- **Evidence:** Probe 3, P10: 50,000 objects are dropped, then GC runs.
  ```text
  [P10] container before drop=3246398 B; after GC=2446366 B; slots=101104 free=100001 live=1103
        (free records+list on wire = 2400024 B); stats=GcStats { slots_reclaimed: 100001, … }
  ```
  2.40 MB of the 2.45 MB container is free records and the free list.
- **Recommendation:**
  - Under a format bump, write free records as nothing: the free list already names them, and the reader fills `Slot::undefined()`.
    That saves 20 bytes per free slot.
  - Or zero them at sweep time so they at least compress.
  - Trailing-free truncation of the arena (VM side) would remove both the wire and the memory cost.
- **Confidence:** confirmed by probe.

### SNI-9 — Several accepted-but-meaningless degrees of freedom break "one machine, one container encoding"

- **Lens(es):** 1, 6
- **Proposed severity:** low
- **Location:**
  - `rust/engine/ironhorse-snapshot/src/image.rs:420-421` and `snapshot_roster.rs:79-108` (`KEYS` decoded into `image.keys` and never used; writers always emit it empty, `machine.rs:392`)
  - `image.rs:155-180` (`CREA.initial_slot_count` never compared with the HEAP count)
  - `image.rs:5419-5440` (core-atom and canonical-bytes gates only for format ≥15/≥16)
  - `format.rs:254` (`MIN_READ = 1`)
- **Excerpt:** `image.rs:5438`: `if image.version.format_version >= 16 && encode_machine(&image)? != buf {`
- **Mechanism:**
  - The reader's stated invariant is that a logical machine has exactly one container encoding, or its SHA-256 CAS key is not an identity (`format.rs:173-184`, `image.rs:5337-5343`).
  - `KEYS` content (up to 4 GiB of strings) and `initial_slot_count` are free parameters.
  - Atoms are not version-gated (WKRF/FNRG/ASYN/PRMS are accepted under any stamp in the read range).
  - So any producer can restamp a current container to format 15 by dropping the FUNC native-name suffix.
    That bypasses the canonical-bytes gate, after which the reserved byte of every slot record is also free.
- **Scenario:** Two hosts store the same vat under different CAS keys, so dedup and equality-by-hash between replicas fail.
  It also gives an attacker a channel to smuggle data through a container that "validates".
- **Evidence:** Probe 1, P3, and Probe 3, P9 (source below):
  ```text
  [P3] crafted KEYS+CREA ACCEPTED; honest=46276 crafted=47288 rewrite=46276 rewrite==honest:true rewrite==crafted:false
  [P9] written VERS format = 15
  [P9] format-15 restamp with 1103 dirty reserved bytes ACCEPTED; rewrite==crafted:false rewrite==honest:true
  [P9 control] format-26 dirty reserved byte: Some("corrupt payload: non-canonical machine encoding")
  ```
  ```rust
  //! TEMPORARY audit probe (SNI region, part 3). Delete after the audit.
  #[path = "common/compile.rs"]
  mod guest_compile;
  use guest_compile::compile;

  use ironhorse_snapshot::atom::AtomReader;
  use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
  use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
  use ironhorse_snapshot::Signature;
  use ironhorse_vm::Interp;

  fn sig() -> Signature {
      Signature::new("ironhorse-worker-v1")
  }

  fn machine(src: &str) -> Interp {
      let (b, n) = compile(src);
      let mut m = Interp::new();
      m.link_intrinsics(&n);
      let o = m.run(&b);
      assert!(o.completed, "fixture: {:?}", o.halt);
      m
  }

  #[test]
  fn sni_part3() {
      // P9: a container restamped to format 15 skips the canonical-bytes gate,
      // so the reserved byte of every slot record becomes free payload.
      let m = machine("var o = {a: 1}; var t = 2; t");
      let honest = m.write_snapshot(&sig()).unwrap();
      let mut image = read_machine(&honest, &sig()).unwrap();
      image.version.format_version = 15;
      // A native-name suffix forces the writer to stamp format 18; a legacy
      // (pre-18) FUNC payload has none.
      image.function_state.native_names = None;
      let mut crafted = write_machine_unchecked(&image);
      {
          let r = AtomReader::parse(&crafted).unwrap();
          let v = r.find(ironhorse_snapshot::VERS).unwrap();
          println!("[P9] written VERS format = {}", u32::from_be_bytes(v.payload[4..8].try_into().unwrap()));
      }
      let clean15 = crafted.clone();
      println!(
          "[P9] clean format-15 restamp: {:?}",
          from_snapshot_bytes(&clean15, &sig()).err().map(|e| e.to_string())
      );
      // Locate HEAP and set every record's reserved byte (offset 9) to 0xA5.
      let (heap_at, heap_len) = {
          let r = AtomReader::parse(&crafted).unwrap();
          let heap = r.find(ironhorse_snapshot::HEAP).unwrap();
          let at = heap.payload.as_ptr() as usize - crafted.as_ptr() as usize;
          (at, heap.payload.len())
      };
      let slot_count = u32::from_be_bytes(crafted[heap_at..heap_at + 4].try_into().unwrap()) as usize;
      let free = u32::from_be_bytes(crafted[heap_at + 4..heap_at + 8].try_into().unwrap()) as usize;
      let records = heap_at + 12 + 4 * free;
      for i in 0..slot_count {
          crafted[records + i * 20 + 9] = 0xA5;
      }
      let _ = heap_len;
      match from_snapshot_bytes(&crafted, &sig()) {
          Ok(r) => {
              let again = r.write_snapshot(&sig()).unwrap();
              println!(
                  "[P9] format-15 restamp with {slot_count} dirty reserved bytes ACCEPTED; rewrite==crafted:{} rewrite==honest:{}",
                  again == crafted,
                  again == honest
              );
          }
          Err(e) => println!("[P9] refused: {e}"),
      }
      // The same patch on the current format is refused (control).
      let mut current = honest.clone();
      let (heap_at, _) = {
          let r = AtomReader::parse(&current).unwrap();
          let heap = r.find(ironhorse_snapshot::HEAP).unwrap();
          (heap.payload.as_ptr() as usize - current.as_ptr() as usize, 0)
      };
      let free = u32::from_be_bytes(current[heap_at + 4..heap_at + 8].try_into().unwrap()) as usize;
      current[heap_at + 12 + 4 * free + 9] = 0xA5;
      println!(
          "[P9 control] format-26 dirty reserved byte: {:?}",
          from_snapshot_bytes(&current, &sig()).err().map(|e| e.to_string())
      );

      // P10: freed slots stay in the container forever (arena never shrinks).
      let mut m = machine(
          "var a = []; for (var i = 0; i < 50000; i++) { a.push({x: i}); } a.length",
      );
      let before = m.write_snapshot(&sig()).unwrap().len();
      let (b, n) = compile("a = 0; 1");
      let code = m.relink_crank(&b, &n).unwrap();
      assert!(m.run(&code).completed);
      let stats = m.collect_garbage().expect("gc");
      let after = m.write_snapshot(&sig()).unwrap();
      let image = read_machine(&after, &sig()).unwrap();
      println!(
          "[P10] container before drop={before} B; after GC={} B; slots={} free={} live={} (free records+list on wire = {} B); stats={stats:?}",
          after.len(),
          image.slots.len(),
          image.slot_free.len(),
          image.slot_live,
          image.slot_free.len() * 24
      );
  }
  ```
- **Recommendation:**
  - Require `KEYS` to be empty, or retire the atom with a format bump.
  - Require `initial_slot_count == slot_count` for format ≥16.
  - Gate each atom on the format that introduced it, so a format-15 stamp cannot carry WKRF/FNRG/shared FUNC.
  - Either apply a per-version canonical re-encode to old stamps, or raise `MIN_READ` once deployed CAS stores are migrated.
- **Confidence:** confirmed by probe.

### SNI-10 — The persistence-refusal taxonomy calls non-side-table refusals "pending side tables"

- **Lens(es):** 6, 3
- **Proposed severity:** low
- **Location:** `rust/engine/ironhorse-snapshot/src/machine.rs:61-66,77-82` (`PendingStateUnsupported { row }` and its `Display`); `rust/engine/ironhorse-vm/src/interp/persist.rs:590,613,640,669,674,715,759`; `rust/engine/ironhorse-snapshot/src/sidetable.rs` (`Coverage::Pending` has zero members).
- **Excerpt:** `machine.rs:77-82`: `"heap holds live {row}: that side table does not travel yet"`.
  Here `row` is free text such as `"a test262 `$262` host object, which no snapshot carries"`.
- **Mechanism:** Every admission refusal is reported as one "pending side table" variant carrying a sentence.
  The refusals fall into three classes:
  - permanently unpersistable by policy (`$262`);
  - unrepresentable by design (no-profile shared compartments);
  - not yet carried (`Compartment` binding, `globalLexicals`, heap-backed module cells).
  None of them is a side table, and the side-table coverage ledger says nothing is pending.
- **Scenario:** An embedder cannot tell from the error whether to retry after an upgrade or never.
  The rendered message is ungrammatical ("heap holds live a test262 …: that side table does not travel yet").
- **Evidence:** static, from the excerpts.
- **Recommendation:** Replace `row: &'static str` with an enum `Unpersistable { Policy(Host262), NotYetCarried(GuestCompartment | CompartmentLexicals | HeapModuleCells), Unrepresentable(SharedRealmWithoutProfile), NonPersistingNative }`.
  Rename the variant, and assert it against the ledger so "pending" means one thing.
- **Confidence:** high.

### SNI-11 — Persistence code is repeated across the codec, the roster gate and the VM restore

- **Lens(es):** 2
- **Proposed severity:** low
- **Location:** see the Duplication inventory; the main items are `restore.rs:394-604`, `image.rs` encode wrappers, `image.rs:846-939`, and the instruction walks.
- **Excerpt:** `restore.rs:515-519`:
  ```rust
  pub fn restore_weak_refs(&mut self, rows: Vec<WeakRefRow>) -> Result<(), RestoreError> {
      self.admit("weak_refs")?;
      let result = self.interp.restore_weak_refs(rows);
      self.failed = result.err();
      result
  }
  ```
- **Mechanism:** A row's validation is written up to three times:
  - in the decoder (ascending owners, enum bytes);
  - in the roster gate (947 lines: owners live, cross-table geometry, bytecode);
  - in the VM `restore_*` (2,345 lines of restore plus 319 of validators, which recheck owners, ascending order and bytecode).
  The design keeps the VM checks as a "release-visible invariant tripwire" (store-seam design, "UntrustedSnapshot → ValidatedSnapshot"), but the copies already drift.
  For example, the gate checks owner liveness, the VM additionally requires `Kind::Instance`, and the HEAP itself gets neither (SNI-1, SNI-4).
- **Scenario:** A future row adds a field checked in one layer and not another, or two layers disagree about what is refused (the error message differs by layer).
- **Evidence:** static; counts in the inventory.
- **Recommendation:**
  - Generate the 25 `RestoreSession` wrappers from `RESTORE_ROWS` with one macro.
  - Delete the 32 `encode_X` Vec wrappers in favour of one generic `encode_to_vec(|s| encode_X_into(.., s))`.
  - Give `Cursor` `u64`/`bool`/`text`/`ascending_owner` helpers.
  - Make one layer (the VM restore, which sees typed state) the validator, keeping the decoder structural only.
- **Confidence:** high.

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Instruction-start walk over a function body | `snapshot_roster.rs:1491-1506`, `ironhorse-vm/src/interp/persist.rs:1794-1801`, `ironhorse-vm/src/interp/restore.rs:199-208`, `image.rs:4924-4953` | 4 × 10-30 lines | Same `instruction_len` loop and "crosses the body" refusal |
| Nested-body subtraction for resume cursors | `snapshot_roster.rs:2069-2097`, `restore.rs:210-224` | 2 × ~20 lines | Same rule and comment ("distinct closures share this exact body range") |
| `RestoreSession` row wrappers | `restore.rs:394-604` (25 verbs) + `RESTORE_ROWS` `restore.rs:7-32` | ~210 + 26 lines | admit, delegate, record `failed`; names kept in sync by a source-guard test |
| `encode_X` → `Vec` wrappers | `image.rs`, 32 functions (for example 1147, 1240, 1402, 1559, 2142, 2751, 2791) | 32 × ~5 lines | each is `let mut v = Vec::new(); encode_X_into(..,&mut v); v` |
| String-list vs name-list codecs | `image.rs:837-844` ≡ `892-899`; `846-884` ≈ `901-939` | 2 × 8, 2 × 39 lines | differ only in element decode and label |
| Ad-hoc cursor helpers | named `boolean` helpers ×4 (`image.rs:3011`, `4233`, `shared_codec.rs:87`, `280`) plus 4 inline `0 => false, 1 => true` decodes in `image.rs`; `u64_value` ×2 (`image.rs:2269`, `3008`); `text` ×3+ (`2194`, `2264`, `4214`); inline strict-ascending owner checks ×34 (`last().is_some_and(..)`), plus `owner_of` at `image.rs:4240` used only by INTL | ~250 lines | `Cursor` (`image.rs:1084-1143`) lacks these primitives |
| Three-layer row validation | decoder (193 `Corrupt` sites in `image.rs`), roster gate (947 lines), VM `restore_*` (`persist.rs` 2,345 + 319; `shared_persist.rs` 605) | ~4,200 lines | for example, FNRG callback kind at `image.rs:2833` and `snapshot_roster.rs:2762`; WeakRef owner/target at `snapshot_roster.rs:2700-2705` and `persist.rs:2343-2348` |
| Snapshot-crate image structs vs VM rows | `image.rs:189-345` (11 `*Image` structs), VM tuples/structs in `snapshot_rows.rs` and `persist.rs`; bridging traits `ArrayRowLike` (`image.rs:1158-1215`) and `CollectionRowLike` (`1411-1460`); conversions in `machine.rs:1897-2010` | ~400 lines | older rows use local image types, newer rows reuse VM structs: two conventions |
| Slot-holder traversals of row fields | `ironhorse-vm/src/interp/persistence.rs:15-120` (19 `persist_holder!` arms), `runtime_key_iter!` (`persistence.rs:149-158`), `ironhorse-snapshot/src/stored_slots.rs` visitors, GC `gc_slots` | 4 traversals | partly generated from `interp_state!`; the per-row field lists are hand-written in each |
| Required-core-atom list | `image.rs:5426` vs roster `present(_image): true` entries | 10 tags | hand-listed beside a generated presence rule |

## Skipped features and refusals inventory

| Site | What is refused / skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `ironhorse-vm/src/interp/persist.rs:590`, `module_snapshot.rs:23-34` | Module graph in `Linking`/`Evaluating`, or holding any non-primitive binding (object, function, string) | Modules are ECMA-262 §16.2; cells holding objects are ordinary | Yes, for cells: carry `CellState::Ready(Value)` as stored slots (visited by `stored_slots`/GC). Linking/Evaluating are mid-crank and correctly refused. | medium |
| `persist.rs:613` | test262 `$262` host present | harness-only | No (policy) | none |
| `persist.rs:640` | Live guest `Compartment` (instance→environment association) | Compartment is a proposal / SES | Yes; `designs/ironhorse-guest-compartment.md` §7 two-column table | medium |
| `persist.rs:669` | Compartment `globalLexicals` | as above | Yes; add an `EnvironmentRow` column | small |
| `persist.rs:674` | `shared_compartments` without a primordial profile | n/a | No: no restore can accept the image; refusing on write is correct | none |
| `persist.rs:700-716` | Reaction kinds without a carry | n/a | Unreachable today (every kind is listed); keep as a guard | none |
| `persist.rs:717-763`, `function_persists` `persist.rs:775-808` | Stored reference to a non-persisting native (`CopyObject` only) | n/a | No: `CopyObject` is transient | none |
| `machine.rs:253` | Not quiescent (mid-crank or halted) | n/a | By design | none |
| `format.rs:316` | Container format > 26 | n/a | By design | none |
| `image.rs:4963-4970` | Shared/host-function FUNC extension under format < 21/22 | n/a | Correct | none |
| `image.rs:5216-5219` (comment), `value.rs:2590-2595` | BLOC block-chain and HEAP record semantics "deferred" (not validated at read) | n/a | Should be validated for containers (SNI-1, SNI-2, SNI-4) | small (one O(heap) pass) |
| `sidetable.rs` `Coverage::Pending` | no members | n/a | Generators, async functions/generators, `Array.fromAsync`, WeakRef, FinalizationRegistry, Proxy and accessors are all carried | none |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `image.rs:5438` canonical re-encode, `image.rs:5405` BLOC copy, `image.rs:820-826` + `machine.rs:496` clones | Whole-container and whole-heap copies on the read path | Measured restore peak 4.7–4.85× the container (P1); floor about 2.5× | Comparing `Sink`; `into_arenas(self)` (SNI-7) |
| `image.rs:995-1012` free records on the wire | 20 B stale record + 4 B list entry per free slot, forever | 98% of the container after dropping 50k objects (P10) | Omit or zero free records (SNI-8) |
| `atom.rs:186-192` | O(n²) duplicate scan | 30 s at 64k atoms in debug (P2) | Bound or fuse with the order check (SNI-5) |
| `snapshot_roster.rs:1491`, `persist.rs:1794` | Body walk per row, not per body | ~90 ms/row/MiB in debug (P8) | Memoize per body range (SNI-6) |
| `read_validated_machine` | ≥4 full passes over HEAP: decode, `check_stored_bounds` visitor, `stored_unregistered_key_id`, canonical re-encode; plus VM restore | ~0.8 s for 300k slots in debug (P1) | Fuse into one visitor; would also host the SNI-1/2/4 checks at no extra pass |
| `stream.rs:225-289` | Every side-table encoder runs twice (sizing + write) | O(side-table bytes) CPU, no memory | Acceptable; could cache small payloads below a threshold |
| `slot_codec.rs` | 20 B/slot on the wire vs 24 B `Slot` in memory | Wire is denser than memory; no action | — |
| ARRY/IDXP items | 4-byte index + 20-byte slot per item, even for dense arrays | ~17% of an array row | Dense-run encoding under a format bump (low priority) |
| `KEYS` atom | Always empty but always written (12 B) and always parsed | trivial | Retire with SNI-9 |

## Ontology notes

- **"Row" has at least five meanings in this region:**
  - a VM capture/restore struct (`snapshot_api::*Row`);
  - a "row set" in `RESTORE_ROWS` (25 entries; groups differ from sections: `typed_array_family` = Buffers+TypedArrays+DataViews, `bulk_side_tables` = Arrays+IndexProperties+Collections+Registry, `error_data` = Errors+ErrorFrames, `promise_cluster` = Promises+AsyncInstances);
  - a side-table "ledger row" (`SideTable`, 42 entries);
  - a store page/extent "row";
  - the `row` field of `PendingStateUnsupported`, which holds a free-text reason (SNI-10).

  Section (`SnapshotSection`/`SmallSection`, 34), payload (roster, 34), atom (38 tags) and side table (42) are four further near-synonyms for overlapping units, with different cardinalities.
- **`RestoreError.row` labels mix vocabularies for one row set:** `"accessors"` and `"Accessors"`, `"native_names"` and `"NativeNames"`, `"function_state"` and `"Functions"`, `"error_data"` and `"Errors"`, plus ad hoc `"SavedFrame"`, `"property_chain"`, `"callable_graph"`, `"session"`, `"lockdown_complete"`, `"module_state"` (counted from `persist.rs`/`restore.rs`).
  `machine.rs:535` then branches on the string `"promise_cluster"`, and every other row collapses into one message (`machine.rs:534-540`).
  The structured `{row, reason}` taxonomy is discarded at the crate boundary.
- **Doc/code disagreements:**
  - `format.rs:286` says `VERS` starts with "`ENDR` magic", and the test comment at `format.rs:606` says the same; the magic is `IRON` (`format.rs:194`).
  - `format.rs:39` defines `SYMB` as "well-known / registered symbol identities", and `format.rs:64-68` says KEYS/SYMB keep their XS meanings "for the ledger rows still pending".
    In fact `SYMB` is the symbol-key property-id table (`image.rs:424-425`), `KEYS` is dead, and nothing is pending.
  - `CreationParams` is documented as "heap-sizing hints … so a restore can pre-size" (`image.rs:151-154`), but one field became an exact admission check and the other is ignored (SNI-9).
- **Absence encoding is inconsistent across rows:** most rows use `u32::MAX` for "no slot/chunk" (`FunctionRow.closures/home/name_chunk`, `WeakRefRow.target`, FNRG cells).
  `EnvironmentRow.unhandled_rejection` is an `Option<u32>` that the codec maps to `u32::MAX` (`shared_codec.rs:39`, `117-124`).
  `FunctionRow` carries `segment: Option<u32>` and `body_start: Option<u64>`, whose joint presence is enforced by `unreachable!` on encode (`image.rs:2214`).
- **Bare integers stand for distinct referents (type lens):** row fields typed `u32` are variously `SlotIndex` (owner, target, home), `ChunkOffset` (`name_chunk`, buffer `data`), segment ordinals, and counts.
  Several rows are anonymous tuples (`(u32, u32, u32, u8, u32)` buffers, `(u32, u8, u32, u32, u32)` views, `(u32, u64)` dates; `restore.rs:403-441`), so a swapped field type-checks.
  The VM already has `SlotIndex`/`ChunkOffset` newtypes; the row schema does not use them.
- **"Environment" homonym:** `EnvironmentRow` (`shared_codec.rs:29-40`) is a compartment's global context: global object, binding-name history, module graph, host ownership, unhandled rejection.
  It is not an ECMA-262 Environment Record, which elsewhere in the VM is the closure `env`.
  No guest-visible divergence was found from this naming.
- **Version axes:** container format (26), store schema (38), row schema (6), cost-table release, and Intl data version.
  `versions.rs` documents these coherently, but `format.rs:217-245` mixes doc comments and line comments for the version history, so rustdoc shows only part of it.

## Leads that did not survive

- **Determinism:** all 34 VM `*_snapshot`/`*_rows` capture functions sort hash-map iteration by owner (scripted check); the slot codec canonicalizes NaN; no address enters the bytes; the streaming and image writers share encoders.
- **Allocation before validation:** all ~40 count-driven `Vec::with_capacity` calls in `image.rs` decoders clamp by `p.len()/k`; `decode_heap`'s `seen` scratch is sized after the truncation gate; `shared_codec` uses `collect` with no reservation.
- **Integer overflow in offsets:** `Cursor::bytes` and `decode_strings`/`decode_names` use `checked_add`; HEAP/STAC sizes are computed in u64; `AtomWriter` checks the cumulative envelope.
- **Recursion on nested structures:** all decoders are iterative.
- **Decoder panics:** only `try_into().unwrap()` on exact-length slices; `unreachable!` in `encode_function_state` (`image.rs:2214`) is reachable only through unchecked tooling.
- **Bytecode trust:** restored segments are framing-checked only, but dispatch already treats bytecode as untrusted (`run()` accepts raw bytecode, and the `bytecode_decoder` fuzz target exists), so restore grants nothing `run()` does not (medium confidence; dispatch not re-audited here).
- **WeakRef targets that are symbols:** these would fail the restore's `Kind::Instance` owner check, but the engine follows XS and refuses symbol weak targets (`natives/weak.rs:5-27`).
- **"Live generators/async/WeakRef/FinalizationRegistry/Proxy refuse persistence":** no longer true; all are carried (`persist_gates.rs`, `pending_row_gates.rs`) and `Coverage::Pending` is empty.
- **Promise `finally` handlers as non-persisting runtime natives:** they register in `promise_functions`, which `function_persists` admits (`natives/promise.rs:226-235`).
- **Nested decoder over-reservation:** inner reservations (cells, items, args) are clamped per row, and a dishonest count fails on the same row, so at most about 1.3× the payload is reserved transiently.
