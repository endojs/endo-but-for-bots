//! Stage-6 child 4 (design § Snapshots, § Fuzzability): the **snapshot
//! round-trip-invariance** and **malformed-atom decoder** fuzz arms over
//! `ironhorse-snapshot`'s `XS_M` writer/reader.
//!
//! Two invariants, mirroring the two stage-1 fuzz targets' write/read split:
//!
//! - **Round-trip invariance** ([`roundtrip_generated_is_invariant`],
//!   [`roundtrip_program_is_invariant`]): a machine state serialized with
//!   [`ironhorse_snapshot::write_machine`], read back with
//!   [`ironhorse_snapshot::read_machine`], and re-serialized must be
//!   **byte-identical**, and the decoded image must equal the original. The
//!   generated-image arm folds fuzzer bytes into an adversarially-shaped
//!   slot/chunk arena graph directly (fast, oracle-free); the program arm
//!   **drives the engine** with a generated program — objects, closures,
//!   bigints, collections — so a *live* machine's real heap rides the codec,
//!   and additionally checks **behavioral continuation** (the resumed meter
//!   equals the live one; [`suspend_resume_is_transparent`] checks that a
//!   suspend→resume→continue crank equals the uninterrupted run bit-for-bit).
//!
//! - **Malformed-atom decoding** ([`decoder_is_error_free`]): arbitrary and
//!   *mutated-valid* bytes into the reader must **never panic, hang, or
//!   allocate unboundedly** — every malformed input yields a structured
//!   [`ironhorse_snapshot::SnapshotError`]. `forbid(unsafe_code)` rules out a
//!   memory-safety hazard, but a panic (or an OOM from a `Vec` pre-reserved by
//!   an untrusted count) in a `read` path is still a defect: the daemon's
//!   restore path must **fail closed, not crash the worker**.
//!
//! Inputs are seed-derived and deterministic (no wall-clock, no
//! `Math.random`), so a trophy reproduces from its bytes. A crash/invariance
//! trophy is locked as a committed Rust regression next to the code it
//! exercises (the malformed-count over-allocation trophies live in
//! `ironhorse-snapshot/src/image.rs`, alongside the `decode_*` clamps that fix
//! them), so the finding survives independent of the fuzzing infrastructure.

use ironhorse_snapshot::{
    from_snapshot_bytes, read_machine, write_machine, MachineImage, MachineSnapshot, Signature,
};
use ironhorse_vm::{
    parse_symbols, ChunkArena, ChunkOffset, Interp, Kind, MeterState, Payload, Slot, SlotArena,
    SlotIndex,
};

/// The host callback-table signature the snapshot fuzz arms write and read
/// under. A fixed value on purpose: these arms fuzz the *container* (framing,
/// atom payloads, round-trip), not the signature gate — the machine-surface
/// tests (`ironhorse-snapshot/src/machine.rs`) already cover the `SIGN` mismatch
/// fail-closed path.
pub fn fuzz_snapshot_sig() -> Signature {
    Signature::new("ironhorse-fuzz-snapshot-v1")
}

/// A cursor over fuzzer-provided bytes, folding raw input into a machine image
/// deterministically (a local copy of the lib's `Bytes` driver — the snapshot
/// arms need `u32`/`ChunkOffset` draws the grammar driver does not expose).
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Cursor { data, pos: 0 }
    }
    fn byte(&mut self) -> u8 {
        if self.data.is_empty() {
            return 0;
        }
        let b = self.data[self.pos % self.data.len()];
        self.pos = self.pos.wrapping_add(1);
        b
    }
    fn choice(&mut self, n: u8) -> u8 {
        if n == 0 {
            0
        } else {
            self.byte() % n
        }
    }
    fn u32(&mut self) -> u32 {
        let mut v = 0u32;
        for _ in 0..4 {
            v = (v << 8) | self.byte() as u32;
        }
        v
    }
}

/// A divergence in the snapshot round-trip invariant: a freshly written
/// snapshot that fails to read back, a decoded image that differs from the
/// original, a write→read→write that is not byte-identical, or a
/// suspend/resume that diverges from the uninterrupted run.
#[derive(Debug)]
pub struct RoundtripDivergence {
    pub detail: String,
}

fn pick_off(c: &mut Cursor, offs: &[ChunkOffset]) -> ChunkOffset {
    if offs.is_empty() {
        // The arena has no payloads, so there is no valid offset to
        // point at. `ChunkOffset(0)` is NOT the way to say that: a
        // payload always sits above its 4-byte header, so 0 is an
        // offset the compactor rejects outright ("chunk offset below
        // header"). `NULL` is the absence sentinel, and the bounds gate
        // and `page_of` both skip it (review wave 5 — the widened gate
        // caught this generator minting images that would have panicked
        // at their first compaction).
        ChunkOffset::NULL
    } else {
        offs[(c.byte() as usize) % offs.len()]
    }
}

fn pick_ref(c: &mut Cursor, idxs: &[SlotIndex]) -> SlotIndex {
    if idxs.is_empty() {
        SlotIndex::NULL
    } else {
        idxs[(c.byte() as usize) % idxs.len()]
    }
}

/// A primitive-or-reference slot payload folded from the cursor, spanning
/// every [`Payload`] arm the slot codec serializes.
fn payload(c: &mut Cursor, offs: &[ChunkOffset], idxs: &[SlotIndex]) -> Payload {
    match c.choice(8) {
        0 => Payload::None,
        1 => Payload::Boolean(c.byte() & 1 == 1),
        2 => Payload::Integer(c.u32() as i32),
        3 => Payload::Number(f64::from_bits(((c.u32() as u64) << 32) | c.u32() as u64)),
        4 => Payload::String(pick_off(c, offs)),
        5 => Payload::BigInt(pick_off(c, offs)),
        6 => Payload::Reference(pick_ref(c, idxs)),
        _ => Payload::At(c.u32() as u16, c.u32()),
    }
}

/// A short ASCII string folded from the cursor (a program symbol name, an
/// interned key).
fn rand_string(c: &mut Cursor) -> String {
    let n = (c.byte() % 6) as usize;
    (0..n).map(|_| (b'a' + c.byte() % 26) as char).collect()
}

fn rand_string_list(c: &mut Cursor) -> Vec<String> {
    let n = (c.byte() % 5) as usize;
    (0..n).map(|_| rand_string(c)).collect()
}

/// Fold fuzzer bytes into a structured [`MachineImage`]: a slot/chunk arena
/// graph (heap-string and bigint chunks, object instances with property
/// chains, closure cells, references, and every primitive), a free list, a
/// value stack, the symbol/key/name tables, and a metering state — the kinds
/// of reachable state a live machine holds. The graph need not be semantically
/// runnable: the round-trip invariant is a pure serialization identity, so
/// this exercises the codec over rich, adversarially-shaped heaps that the
/// engine-driven arm reaches only slowly and never at these boundary values
/// (NaN payloads, `u32::MAX` indices, empty and maximal property chains).
pub fn gen_machine_image(data: &[u8]) -> MachineImage {
    let mut c = Cursor::new(data);
    let mut chunks = ChunkArena::new();
    let mut slots = SlotArena::new();

    // A handful of chunks: heap-string UTF-16BE bytes and bigint digit blobs.
    let mut offs: Vec<ChunkOffset> = Vec::new();
    let n_chunks = (c.byte() % 6) as usize;
    for _ in 0..n_chunks {
        let len = (c.byte() % 8) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| c.byte()).collect();
        offs.push(chunks.alloc(&bytes));
    }

    // A spread of slots of every kind, referencing earlier slots/chunks so the
    // graph has real edges (property chains, closure cells, prototype links).
    let n_slots = 1 + (c.byte() % 24) as usize;
    let mut idxs: Vec<SlotIndex> = Vec::new();
    for _ in 0..n_slots {
        let mut slot = match c.choice(11) {
            0 => Slot::undefined(),
            1 => Slot::null(),
            2 => Slot::boolean(c.byte() & 1 == 1),
            3 => Slot::integer(c.u32() as i32),
            4 => Slot::number(f64::from_bits(((c.u32() as u64) << 32) | c.u32() as u64)),
            5 => Slot::of(Kind::String, Payload::String(pick_off(&mut c, &offs))),
            6 => Slot::of(Kind::BigInt, Payload::BigInt(pick_off(&mut c, &offs))),
            7 => Slot::of(Kind::Reference, Payload::Reference(pick_ref(&mut c, &idxs))),
            8 => Slot::of(Kind::Closure, Payload::Reference(pick_ref(&mut c, &idxs))),
            9 => Slot::property(c.u32() as u16, payload(&mut c, &offs, &idxs)),
            _ => Slot::instance(pick_ref(&mut c, &idxs)),
        };
        // Perturb the framing fields (next link, id, flag) so the record
        // encoding rides non-zero values in every position.
        slot.next = pick_ref(&mut c, &idxs);
        slot.id = c.u32() as u16;
        slot.flag = c.byte();
        idxs.push(slots.alloc(slot));
    }

    // Free a distinct SUFFIX of the allocated slots to exercise the
    // free-list round-trip (indices are distinct — all allocated before
    // any free — so no double-free). A suffix, not a prefix: the ledger
    // rows below take ascending owners/descriptors from the LOW indices,
    // and the reader now refuses a side-table row owned by a free slot
    // (review findings 2+3), so the generated free set and the generated
    // owners must not overlap.
    let n_free = (c.byte() as usize) % idxs.len();
    for &ix in idxs.iter().skip(idxs.len() - n_free) {
        slots.free(ix);
    }
    // The low indices that stayed live — the pool the ledger rows below
    // draw owners and descriptors from.
    let live_cap = (idxs.len() - n_free) as u32;

    // The value stack is EMPTY: the reader enforces quiescence (a
    // populated `STAC` cannot come from an honest writer — review
    // finding 5), so a generated stack would turn the round-trip target
    // into a decode-failure target. The refusal itself is locked by
    // `crafted_row_refusals.rs`, and the raw-bytes mutation lane still
    // corrupts the STAC atom's framing.
    let stack: Vec<Slot> = Vec::new();

    let names = rand_string_list(&mut c);
    let keys = rand_string_list(&mut c);
    // Symbol-key table: generated VALID like the ledger rows below —
    // ids strictly ascending above the counter, descriptors distinct,
    // in-bounds AND live (a descriptor on a free slot is refused) — so
    // write→read identity holds while the DECODER sees ill-formed
    // tables from the raw-bytes fuzz lane.
    let bound = live_cap.max(1);
    // At most one pair per distinct in-bounds descriptor, or the
    // dedup nudge below cannot terminate on a tiny arena.
    let n_sym = ((c.byte() % 5) as usize).min(bound as usize);
    let sym_next = u16::MAX - n_sym as u16 - (c.byte() % 4) as u16;
    let mut seen = std::collections::BTreeSet::new();
    let sym_pairs: Vec<(u16, u32)> = (0..n_sym)
        .map(|k| {
            let mut d = c.u32() % bound;
            while !seen.insert(d) {
                d = (d + 1) % bound;
            }
            (sym_next + 1 + k as u16, d)
        })
        .collect();
    let symbols = ironhorse_snapshot::image::SymbolKeyImage {
        next_id: sym_next,
        pairs: sym_pairs,
    };

    let meter = MeterState {
        index: ((c.u32() as u64) << 16) | c.u32() as u64,
        interval: c.byte() as u64 * 4096,
        count: c.u32() as u64,
    };

    // Side-table ledger rows (wave-4 fuzz gap): arrays, collections,
    // and the `Symbol.for` registry. Generated VALID — owners/refs
    // in-bounds (`< n_slots`), owners/keys strictly ascending — so the
    // round-trip target's write→read identity holds while the
    // byte-mutation target now has well-framed ARRY/COLL/REGY atoms to
    // corrupt (before this the decoders were never exercised). A
    // running counter keeps owners ascending-unique.
    //
    // "Valid" is whatever the decoders accept, so wave 5's new rules are
    // generated here too: array item indices strictly ascending and
    // below the row's declared length, and registry descriptors
    // pairwise distinct — and, since the review round, owners drawn
    // only from LIVE slots and collection tables with reachable rehash
    // geometry. Generating rows the decoder refuses would turn the
    // round-trip target into a decode-failure target and stop
    // exercising the identity it exists for.
    let cap = live_cap;
    let mut next_owner = 0u32;
    let mut arrays: Vec<ironhorse_snapshot::image::ArrayImage> = Vec::new();
    while next_owner < cap && (c.byte() & 3) != 0 {
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        let n_items = (c.byte() % 4) as usize;
        // A running index, stepped by 1..3, gives ascending-unique item
        // indices with fuzzer-chosen holes between them.
        let mut next_index = 0u32;
        let mut items = Vec::with_capacity(n_items);
        for _ in 0..n_items {
            let value = Slot::of(Kind::Reference, Payload::Reference(pick_ref(&mut c, &idxs)));
            items.push((next_index, value));
            next_index += 1 + (c.byte() % 3) as u32;
        }
        arrays.push(ironhorse_snapshot::image::ArrayImage {
            owner,
            // `next_index` already sits past the last item, so the
            // declared length covers the row; the remainder is a
            // fuzzer-chosen sparse tail.
            length: next_index + c.u32() % 8,
            items,
        });
    }
    let mut next_owner = 0u32;
    let mut collections: Vec<ironhorse_snapshot::image::CollectionImage> = Vec::new();
    while next_owner < cap && (c.byte() & 3) != 0 {
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        let n_entries = (c.byte() % 4) as usize;
        let entries = (0..n_entries)
            .map(|_| {
                (
                    Slot::of(Kind::Reference, Payload::Reference(pick_ref(&mut c, &idxs))),
                    Slot::of(Kind::Reference, Payload::Reference(pick_ref(&mut c, &idxs))),
                )
            })
            .collect();
        let kind = c.byte() % 4;
        // Reachable rehash geometry (review finding 9): weak kinds
        // carry no table; Map/Set carry the smallest power of two
        // whose grow threshold covers the live size, optionally
        // doubled a step or two (the cleared-then-shrinking states the
        // engine can also rest in).
        let table_length = if kind >= 2 {
            0
        } else {
            let mut l = 1u32;
            while (l >> 1) + (l >> 2) < n_entries as u32 {
                l <<= 1;
            }
            (l << (c.byte() % 3)).min(1 << 20)
        };
        collections.push(ironhorse_snapshot::image::CollectionImage {
            owner,
            kind,
            table_length,
            entries,
        });
    }
    let n_reg = (c.byte() % 4) as usize;
    let mut registry: Vec<ironhorse_snapshot::image::RegistryImage> = Vec::new();
    // Distinct ascending keys ("k0","k1",…) paired with in-bounds
    // descriptors that a running counter keeps pairwise DISTINCT — two
    // keys sharing a descriptor would make `Symbol.for('k0') ===
    // Symbol.for('k1')` on restore, which is why the decoder refuses it.
    let mut next_desc = 0u32;
    for i in 0..n_reg {
        if next_desc >= cap {
            break;
        }
        registry.push(ironhorse_snapshot::image::RegistryImage {
            key: format!("k{i}").into_bytes(),
            descriptor: next_desc,
        });
        next_desc += 1 + (c.byte() % 3) as u32;
    }

    // Error-data rows (the ERRD atom): ascending in-bounds owners, names
    // drawn from the engine's closed error-name set (the decoder refuses
    // anything else), and an optional message from the input bytes.
    let n_err = (c.byte() % 4) as usize;
    let mut errors: Vec<ironhorse_snapshot::image::ErrorImage> = Vec::new();
    let mut next_owner = 0u32;
    const ERROR_NAMES: [&str; 4] = ["Error", "TypeError", "RangeError", "AggregateError"];
    for _ in 0..n_err {
        next_owner += (c.byte() % 3) as u32;
        if next_owner >= cap {
            break;
        }
        let name = ERROR_NAMES[(c.byte() % 4) as usize].to_string();
        let message = (c.byte() % 2 == 1).then(|| format!("m{}", c.u32() % 1000));
        errors.push(ironhorse_snapshot::image::ErrorImage {
            owner: next_owner,
            name,
            message,
            // The construction frames, in their own `ESTK` atom: a
            // frame list is either absent or non-empty (the writer
            // omits the row rather than emitting a zero count), so the
            // generator emits both shapes.
            frames: (0..(c.byte() % 3) as usize)
                .map(|k| format!("f{}", c.u32() % 100 + k as u32))
                .collect(),
        });
        next_owner += 1;
    }
    let n_dates = ((c.byte() % 4) as usize).min(cap as usize);
    let dates: Vec<ironhorse_snapshot::image::DateImage> = (0..n_dates)
        .map(|owner| ironhorse_snapshot::image::DateImage {
            owner: owner as u32,
            value_bits: ((c.u32() as u64) << 32) | c.u32() as u64,
        })
        .collect();

    // The GRADUATION-WAVE atoms. Eight state-bearing families landed
    // and only `DATE` reached this generator, so seven decoders were
    // exercised by nothing but their own hand-written fixtures --
    // exactly the gap the earlier ARRY/COLL/REGY comment describes,
    // reopened one wave later. Generated VALID for the same reason:
    // what the DECODERS accept (strictly-ascending keys, in-range
    // enums, UTF-8 names, no records on a disposed stack, frame and
    // state agreeing), so write -> read identity holds here while the
    // byte-mutation target gets well-framed atoms to corrupt. The
    // cross-table SEMANTIC rules (a callable getter, a generator frame
    // whose function has a row) belong to the bounds gate, which this
    // target does not run, so they are not modeled.
    // Draw references from the LIVE prefix only: the free slots are a
    // suffix, and the bounds gate refuses a side table that names one
    // ("side table names a free slot").
    let live_idxs: Vec<SlotIndex> = idxs.iter().copied().filter(|i| i.0 < live_cap).collect();
    let slot = |c: &mut Cursor| {
        Slot::of(Kind::Reference, Payload::Reference(pick_ref(c, &live_idxs)))
    };
    let opt_slot = |c: &mut Cursor| (c.byte() % 3 != 0).then(|| slot(c));

    let mut next_owner = 0u32;
    let mut proxies: Vec<ironhorse_vm::ProxyRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_owner >= cap {
            break;
        }
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        let revoked = c.byte() % 4 == 0;
        proxies.push(ironhorse_vm::ProxyRow {
            owner,
            // A revoked proxy NULLs both edges (`SlotIndex::NULL`, not
            // index 0, which is a live slot): the decoder refuses a
            // revoked row that retains them.
            target: if revoked { u32::MAX } else { pick_ref(&mut c, &live_idxs).0 },
            handler: if revoked { u32::MAX } else { pick_ref(&mut c, &live_idxs).0 },
            revoked,
        });
    }
    let mut next_owner = 0u32;
    let mut revokers: Vec<ironhorse_vm::ProxyRevokerRow> = Vec::new();
    for _ in 0..(c.byte() % 4) {
        if next_owner >= cap || proxies.is_empty() {
            break;
        }
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        revokers.push(ironhorse_vm::ProxyRevokerRow {
            owner,
            proxy: proxies[(c.byte() as usize) % proxies.len()].owner,
            // A name chunk is a real chunk-arena offset (or NULL), not
            // a free `u32`: `pick_off` draws the ones this image has.
            name_chunk: pick_off(&mut c, &offs).0,
        });
    }

    let mut next_owner = 0u32;
    let mut accessors: Vec<ironhorse_vm::AccessorRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_owner >= cap || names.is_empty() {
            break;
        }
        let owner = next_owner;
        // Always step the OWNER, so the (owner, id) key ascends
        // strictly whatever id the row draws -- and the id is drawn
        // from the program-symbol space, since the decoder refuses one
        // outside the property-key tables. (Ids are 1-based: id `k + 1`
        // names `names[k]`.)
        next_owner += 1 + (c.byte() % 3) as u32;
        accessors.push(ironhorse_vm::AccessorRow {
            owner,
            id: (c.u32() as usize % names.len()) as u16 + 1,
            get: opt_slot(&mut c),
            set: opt_slot(&mut c),
        });
    }

    // `IBFN` is NOT generated: a bound-function row's owner must have
    // an `INTL` collator or number-format row, and this builder does
    // not model the nine Intl tables (segment geometry above all) --
    // the same cross-table dependence that keeps the typed-array
    // family out, noted at the builder's tail. Crafted `IBFN` bytes
    // are exercised by the byte-level container decoder target and by
    // `intl_carry.rs`.
    // Both private tables step the RECEIVER each row, so the
    // (receiver, brand) key ascends strictly however the brand is
    // drawn -- and the brand is a slot index like any other, so it
    // comes from the live prefix.
    let mut next_receiver = 0u32;
    let mut private_values: Vec<ironhorse_vm::PrivateValueRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_receiver >= cap || live_idxs.is_empty() {
            break;
        }
        let receiver = next_receiver;
        next_receiver += 1 + (c.byte() % 3) as u32;
        private_values.push(ironhorse_vm::PrivateValueRow {
            receiver,
            brand: pick_ref(&mut c, &live_idxs).0,
            value: slot(&mut c),
        });
    }
    // Accessor receivers start past the value receivers: the bounds
    // gate refuses a key carrying both a value and an accessor, so
    // keeping the two disjoint means the generated image stays
    // adoptable as well as decodable.
    let mut next_receiver = next_receiver + 1;
    let mut private_accessors: Vec<ironhorse_vm::PrivateAccessorRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_receiver >= cap || live_idxs.is_empty() {
            break;
        }
        let receiver = next_receiver;
        next_receiver += 1 + (c.byte() % 3) as u32;
        private_accessors.push(ironhorse_vm::PrivateAccessorRow {
            receiver,
            brand: pick_ref(&mut c, &live_idxs).0,
            get: opt_slot(&mut c),
            set: opt_slot(&mut c),
        });
    }

    let mut next_owner = 0u32;
    let mut disposable_stacks: Vec<ironhorse_vm::DisposableStackRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_owner >= cap {
            break;
        }
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        let disposed = c.byte() % 4 == 0;
        // A disposed stack ran its records to completion; the decoder
        // refuses one that still retains them.
        let n_records = if disposed { 0 } else { (c.byte() % 3) as usize };
        disposable_stacks.push(ironhorse_vm::DisposableStackRow {
            owner,
            disposed,
            asynchronous: c.byte() % 2 == 0,
            records: (0..n_records)
                .map(|_| ironhorse_vm::DisposalRecordRow {
                    resource: slot(&mut c),
                    method: slot(&mut c),
                    pass_resource: c.byte() % 2 == 0,
                })
                .collect(),
        });
    }

    // `FUNC`, minimally but HONESTLY: one segment of `XS_CODE_END`
    // bytes (a 1-byte opcode, so every offset in the body is an
    // instruction start) and one function row over the whole of it.
    // The point is not to model real bytecode -- the engine-driven
    // target does that -- but to give the `GENR` frames below a
    // function row to name and a body whose instruction starts a
    // resume cursor can legally sit on, so the frame codec is
    // exercised at all. Without it every generated generator had to be
    // Completed, and `SavedFrameRow` never round-tripped here.
    const XS_CODE_END: u8 = 68;
    let n_body = 4 + (c.byte() % 8) as u64;
    let func_owner = pick_ref(&mut c, &live_idxs);
    let function_state = if live_idxs.is_empty() {
        ironhorse_vm::FunctionStateSnapshot::default()
    } else {
        ironhorse_vm::FunctionStateSnapshot {
            segments: vec![vec![XS_CODE_END; n_body as usize]],
            functions: vec![ironhorse_vm::FunctionRow {
                owner: func_owner.0,
                segment: Some(0),
                body_start: Some(0),
                body_len: n_body,
                closures: pick_ref(&mut c, &live_idxs).0,
                name: format!("f{}", c.u32() % 1000),
                arity: c.u32() % 8,
                name_chunk: pick_off(&mut c, &offs).0,
                is_generator: true,
                home: pick_ref(&mut c, &live_idxs).0,
                class_derived: None,
            }],
            bound_functions: Vec::new(),
            ctor_prototypes: Vec::new(),
            deleted_meta: Vec::new(),
        }
    };
    let has_function = !function_state.functions.is_empty();

    let mut next_owner = 0u32;
    let mut generators: Vec<ironhorse_vm::GeneratorRow> = Vec::new();
    for _ in 0..(c.byte() % 6) {
        if next_owner >= cap {
            break;
        }
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        // 0 SuspendedStart / 1 SuspendedYield carry a frame; 2
        // Completed must not -- the decoder checks the agreement. With
        // no function row to name, only Completed rows are legal.
        let state = if has_function && !names.is_empty() { c.byte() % 3 } else { 2 };
        let frame = (state != 2).then(|| {
            let n_locals = 1 + (c.byte() % 4) as usize;
            ironhorse_vm::SavedFrameRow {
                locals: (0..n_locals).map(|_| slot(&mut c)).collect(),
                // A scope entry names a program symbol (1-based, in
                // range) and a local of THIS frame; the ids ascend
                // strictly, so the map is walked from a running id
                // capped at the table size.
                id_map: {
                    let mut id = 0u16;
                    (0..(c.byte() % 3) as usize)
                        .map_while(|_| {
                            id += 1 + (c.byte() % 3) as u16;
                            (id as usize <= names.len())
                                .then(|| (id, (c.byte() as usize % n_locals) as u64))
                        })
                        .collect()
                },
                args: (0..(c.byte() % 3) as usize).map(|_| slot(&mut c)).collect(),
                this_val: slot(&mut c),
                env: slot(&mut c),
                cur_func: func_owner.0,
                cur_target: c.byte() % 2 == 0,
                target_func: u32::MAX,
                strict: c.byte() % 2 == 0,
                result: slot(&mut c),
                stack_slice: (0..(c.byte() % 3) as usize).map(|_| slot(&mut c)).collect(),
                jumps: Vec::new(),
                // An instruction start inside the body above.
                resume_pc: c.u32() as u64 % n_body,
            }
        });
        generators.push(ironhorse_vm::GeneratorRow { state, owner, frame });
    }

    // The promise cluster (`PRMS`): generated to satisfy the decoder's
    // cross-checks -- a resolving pair per emitted guard (dense guard
    // coverage), a `Combine` reaction naming each combinator (dense
    // combinator coverage), derived promises with rows of their own,
    // `remaining` covering the pending element reactions, results
    // naming a real `ARRY` row, and NO null name chunks (the mint
    // always interns a real empty chunk, and the bounds gate refuses
    // the null it tolerates on other rows).
    let mut next_owner = 0u32;
    let mut prms_promises: Vec<ironhorse_vm::PromiseRow> = Vec::new();
    for _ in 0..(c.byte() % 4) {
        if next_owner >= live_cap {
            break;
        }
        let owner = next_owner;
        next_owner += 1 + (c.byte() % 3) as u32;
        // 0 Pending / 1 Fulfilled / 2 Rejected; only Pending rows may
        // carry reactions (settlement drains them) — and a reaction's
        // capability must reference a resolving PAIR, so reactions
        // join below once the pair rows exist.
        let state = c.byte() % 3;
        prms_promises.push(ironhorse_vm::PromiseRow {
            owner,
            state,
            result: slot(&mut c),
            ever_handled: c.byte() % 2 == 1,
            reactions: Vec::new(),
        });
    }
    let mut prms_combinators: Vec<ironhorse_vm::CombinatorRow> = Vec::new();
    {
        let pending: Vec<usize> = prms_promises
            .iter()
            .enumerate()
            .filter(|(_, p)| p.state == 0)
            .map(|(i, _)| i)
            .collect();
        // The results Array must have a POSITIVE carried length (the
        // element index is bounded below it), and an undone
        // combinator's derived promise must be PENDING. A done
        // combinator instead needs a settled derived promise: `done`
        // latches that settlement exactly.
        let settled: Vec<usize> = prms_promises
            .iter()
            .enumerate()
            .filter(|(_, p)| p.state != 0)
            .map(|(i, _)| i)
            .collect();
        let sized: Vec<&ironhorse_snapshot::image::ArrayImage> =
            arrays.iter().filter(|a| a.length > 0).collect();
        if !pending.is_empty() && !sized.is_empty() {
            for _ in 0..(c.byte() % 3) {
                let ci = prms_combinators.len() as u32;
                let host = pending[(c.byte() as usize) % pending.len()];
                let results = sized[(c.byte() as usize) % sized.len()];
                // A native element reaction carries NO capability —
                // the decoder refuses populated slots on one.
                let reaction = ironhorse_vm::PromiseReactionRow {
                    on_fulfilled: ironhorse_vm::Slot::undefined(),
                    on_rejected: ironhorse_vm::Slot::undefined(),
                    resolve: ironhorse_vm::Slot::undefined(),
                    reject: ironhorse_vm::Slot::undefined(),
                    kind: 2,
                    a: ci,
                    b: c.u32() % results.length,
                };
                prms_promises[host].reactions.push(reaction);
                let kind = c.byte() % 4;
                // `remaining` sits in [pending, element count]; the one
                // pending reaction makes the floor 1, the results
                // Array's preset length is the ceiling — and a race
                // (kind 2) never decrements, so it stays AT the count.
                let remaining = if kind == 2 {
                    results.length
                } else {
                    1 + c.u32() % results.length
                };
                let done = !settled.is_empty() && c.byte() % 2 == 0;
                let derived_candidates = if done { &settled } else { &pending };
                prms_combinators.push(ironhorse_vm::CombinatorRow {
                    kind,
                    derived: prms_promises
                        [derived_candidates[(c.byte() as usize) % derived_candidates.len()]]
                    .owner,
                    remaining,
                    results: results.owner,
                    done,
                });
            }
        }
    }
    // Resolving functions come as PAIRS — one guard, one promise,
    // opposite polarity — exactly `fxPushPromiseFunctions`' mint (the
    // guard-coherence gate refuses anything else; a swept singleton
    // half is also honest but a pair exercises more of the codec).
    let mut prms_functions: Vec<ironhorse_vm::PromiseFnRow> = Vec::new();
    let mut prms_guards: Vec<bool> = Vec::new();
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    if !prms_promises.is_empty() && !offs.is_empty() {
        let mut next_fn = 0u32;
        for _ in 0..(c.byte() % 4) {
            let resolve_fn = next_fn;
            let reject_fn = next_fn + 1 + (c.byte() % 3) as u32;
            next_fn = reject_fn + 1 + (c.byte() % 3) as u32;
            if reject_fn >= live_cap {
                break;
            }
            let guard = prms_guards.len() as u32;
            prms_guards.push(c.byte() % 2 == 1);
            let promise = prms_promises[(c.byte() as usize) % prms_promises.len()].owner;
            let name_chunk = pick_off(&mut c, &offs).0;
            for (function, reject) in [(resolve_fn, false), (reject_fn, true)] {
                prms_functions.push(ironhorse_vm::PromiseFnRow {
                    function,
                    promise,
                    reject,
                    guard,
                    name_chunk,
                });
            }
            pairs.push((resolve_fn, reject_fn));
        }
    }
    // User / FinallyReturn reactions on pending rows, each capability
    // a reference pair to one minted resolving pair (the shape every
    // honest `.then`/`finally`/adoption registration has).
    {
        let pending: Vec<usize> = prms_promises
            .iter()
            .enumerate()
            .filter(|(_, p)| p.state == 0)
            .map(|(i, _)| i)
            .collect();
        if !pending.is_empty() && !pairs.is_empty() {
            for _ in 0..(c.byte() % 3) {
                let host = pending[(c.byte() as usize) % pending.len()];
                let (resolve_fn, reject_fn) = pairs[(c.byte() as usize) % pairs.len()];
                let fn_ref = |f: u32| {
                    Slot::of(
                        Kind::Reference,
                        Payload::Reference(SlotIndex(f)),
                    )
                };
                prms_promises[host].reactions.push(ironhorse_vm::PromiseReactionRow {
                    on_fulfilled: slot(&mut c),
                    on_rejected: slot(&mut c),
                    resolve: fn_ref(resolve_fn),
                    reject: fn_ref(reject_fn),
                    kind: c.byte() % 2,
                    a: 0,
                    b: 0,
                });
            }
        }
    }
    let promise_cluster = ironhorse_vm::PromiseClusterSnapshot {
        promises: prms_promises,
        functions: prms_functions,
        guards: prms_guards,
        combinators: prms_combinators,
    };

    MachineImage::from_arenas(fuzz_snapshot_sig(), &slots, &chunks, &stack, names, keys, symbols)
        .with_meter(meter)
        .with_function_state(function_state)
        .with_proxy_state(ironhorse_vm::ProxyStateSnapshot { proxies, revokers })
        .with_accessors(accessors)
        .with_private_elements(ironhorse_vm::PrivateElementSnapshot {
            values: private_values,
            accessors: private_accessors,
        })
        .with_disposable_stacks(disposable_stacks)
        .with_generators(generators)
        .with_promise_cluster(promise_cluster)
        // The typed-array family is left empty here: honest ABUF rows
        // need REAL chunk-arena extents, which this builder does not
        // model. Crafted family bytes are exercised by the byte-level
        // container decoder target instead.
        .with_side_tables(arrays, collections, registry, errors, Vec::new(), Vec::new(), Vec::new())
        .with_dates(dates)
}

/// The core round-trip invariant over a built image: a freshly written
/// snapshot must **read back** (a decode failure on our own output is a
/// defect), and **write → read → write must be byte-identical**.
///
/// Byte-equality is the always-applicable invariant. When `img` is reflexive
/// under `MachineImage`'s derived `PartialEq` (it contains no NaN), value
/// equality is checked too. The second check catches a writer that silently
/// omits a model field: byte idempotence alone would accept both writes
/// dropping the same field. A NaN-bearing image cannot use derived value
/// equality (`NaN != NaN`), so it keeps the bit-exact byte check; the slot
/// codec's `nan_bits_preserved` lock covers that payload directly.
pub fn roundtrip_image_is_invariant(img: &MachineImage) -> Result<(), RoundtripDivergence> {
    let sig = fuzz_snapshot_sig();
    let bytes = write_machine(img);
    let back = match read_machine(&bytes, &sig) {
        Ok(b) => b,
        Err(e) => {
            return Err(RoundtripDivergence {
                detail: format!("a freshly written snapshot failed to read back: {e:?}"),
            })
        }
    };
    let bytes2 = write_machine(&back);
    if bytes != bytes2 {
        return Err(RoundtripDivergence {
            detail: format!(
                "write→read→write is not byte-identical ({} then {} bytes)",
                bytes.len(),
                bytes2.len()
            ),
        });
    }
    let reflexive_twin = img.clone();
    if img == &reflexive_twin && &back != img {
        return Err(RoundtripDivergence {
            detail: "write→read changed the decoded machine model".to_string(),
        });
    }
    Ok(())
}

/// Round-trip invariance over a fuzzer-generated arena image (oracle-free).
pub fn roundtrip_generated_is_invariant(data: &[u8]) -> Result<(), RoundtripDivergence> {
    roundtrip_image_is_invariant(&gen_machine_image(data))
}

/// Round-trip invariance over a **live machine**: compile a generated program
/// with the oracle, drive the engine to populate its heap, snapshot it, and
/// assert the container round-trips byte-identically and the resumed machine's
/// meter equals the live one. Returns `Ok(false)` when the oracle declines the
/// source or the generated state is outside the current persistence coverage;
/// `Ok(true)` means the round trip actually ran.
pub fn roundtrip_program_is_invariant(source: &str) -> Result<bool, RoundtripDivergence> {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return Ok(false),
    };
    let names = parse_symbols(&oracle.symbols);
    let mut interp = Interp::new();
    interp.link_intrinsics(&names);
    interp.run(&oracle.bytecode);

    let sig = fuzz_snapshot_sig();
    // The persist gate refuses a non-quiescent machine (a generated
    // program that HALTED) — a named refusal, not a divergence.
    let bytes = match interp.write_snapshot(&sig) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let restored = match from_snapshot_bytes(&bytes, &sig) {
        Ok(m) => m,
        Err(e) => {
            return Err(RoundtripDivergence {
                detail: format!("engine snapshot failed to restore: {e:?} (source {source:?})"),
            })
        }
    };
    // The restored machine is quiescent by construction; a refusal
    // HERE is a real divergence.
    let bytes2 = match restored.write_snapshot(&sig) {
        Ok(b) => b,
        Err(e) => {
            return Err(RoundtripDivergence {
                detail: format!("restored machine refused to re-snapshot: {e:?}"),
            })
        }
    };
    if bytes != bytes2 {
        return Err(RoundtripDivergence {
            detail: format!(
                "engine snapshot write→read→write not byte-identical (source {source:?})"
            ),
        });
    }
    if restored.meter_state() != interp.meter_state() {
        return Err(RoundtripDivergence {
            detail: format!("meter state not preserved across snapshot (source {source:?})"),
        });
    }
    Ok(true)
}

/// Behavioral continuation: a machine that runs crank A, suspends, resumes,
/// and runs crank B must equal the uninterrupted run of A-then-B in
/// completion, result, and computron count (the row-6 bar, generalized to
/// fuzzer-chosen crank pairs). Both cranks are symbol-free arithmetic (no
/// intrinsic relinking across the restore), the regime where the current
/// suspend contract holds exactly (`machine.rs` § suspend-point contract).
pub fn suspend_resume_is_transparent(
    source_a: &str,
    source_b: &str,
) -> Result<bool, RoundtripDivergence> {
    let a = match xs_oracle::run(source_a) {
        Some(o) => o,
        None => return Ok(false),
    };
    let b = match xs_oracle::run(source_b) {
        Some(o) => o,
        None => return Ok(false),
    };

    // Uninterrupted: one machine runs crank A then crank B.
    let mut uninterrupted = Interp::new();
    uninterrupted.run(&a.bytecode);
    let ub = uninterrupted.run(&b.bytecode);

    // Suspended: machine 1 runs A, snapshots; machine 2 restores and runs B.
    let sig = fuzz_snapshot_sig();
    let mut m1 = Interp::new();
    m1.run(&a.bytecode);
    let bytes = match m1.write_snapshot(&sig) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let mut m2 = match from_snapshot_bytes(&bytes, &sig) {
        Ok(m) => m,
        Err(e) => {
            return Err(RoundtripDivergence {
                detail: format!("suspend snapshot failed to restore: {e:?} (A={source_a:?})"),
            })
        }
    };
    let b2 = m2.run(&b.bytecode);

    if b2.completed != ub.completed || b2.result != ub.result || b2.computrons != ub.computrons {
        return Err(RoundtripDivergence {
            detail: format!(
                "suspend/resume diverged from uninterrupted: resumed(completed={}, result={:?}, \
                 computrons={}) vs uninterrupted(completed={}, result={:?}, computrons={}) \
                 [A={source_a:?} B={source_b:?}]",
                b2.completed, b2.result, b2.computrons, ub.completed, ub.result, ub.computrons
            ),
        });
    }
    Ok(true)
}

/// Mutate a (valid) snapshot buffer deterministically from the cursor bytes —
/// byte overwrites, `0xFF`-filled 4-byte windows (targeting the length/count
/// fields that live at atom-payload heads), truncations, and zeroed windows.
/// This is the productive malformed corpus: the mutant still passes the
/// `VERS`/`SIGN` gates often enough to reach the atom-payload decoders where a
/// corrupt count field would, unclamped, drive an unbounded allocation.
fn mutate_bytes(base: &[u8], data: &[u8]) -> Vec<u8> {
    let mut out = base.to_vec();
    if out.is_empty() {
        return out;
    }
    let mut c = Cursor::new(data);
    let n_edits = 1 + (c.byte() % 8) as usize;
    for _ in 0..n_edits {
        if out.is_empty() {
            break;
        }
        match c.choice(4) {
            0 => {
                let i = (c.u32() as usize) % out.len();
                out[i] = c.byte();
            }
            1 => {
                let i = (c.u32() as usize) % out.len();
                for k in 0..4 {
                    if i + k < out.len() {
                        out[i + k] = 0xff;
                    }
                }
            }
            2 => {
                let keep = (c.u32() as usize) % out.len();
                out.truncate(keep);
            }
            _ => {
                let i = (c.u32() as usize) % out.len();
                let l = (c.byte() % 8) as usize;
                for k in 0..l {
                    if i + k < out.len() {
                        out[i + k] = 0;
                    }
                }
            }
        }
    }
    out
}

/// Target 2 body: the snapshot reader must not panic, hang, or allocate
/// unboundedly on arbitrary or mutated-valid bytes. Feeds the raw bytes
/// straight in (usually rejected at the `VERS`/`SIGN` gates) **and** a mutated
/// valid snapshot (which reaches the atom-payload decoders). The point is that
/// both calls *return* — a structured [`ironhorse_snapshot::SnapshotError`] or a
/// restored machine — in bounded time and memory.
pub fn decoder_is_error_free(data: &[u8]) {
    let sig = fuzz_snapshot_sig();

    // Arbitrary bytes: the outermost framing/version/signature gates catch
    // almost all of these, but the reader must fail closed on every one.
    let _ = read_machine(data, &sig);
    let _ = from_snapshot_bytes(data, &sig);

    // The productive corpus: a valid snapshot with the bytes mutated in, so
    // the reader passes the gates and reaches the count-bearing decoders.
    let valid = write_machine(&gen_machine_image(data));
    let mutated = mutate_bytes(&valid, data);
    let _ = read_machine(&mutated, &sig);
    let _ = from_snapshot_bytes(&mutated, &sig);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{gen_program, gen_stage2b_program, gen_stage3_bigint_program};
    use crate::{gen_stage3_collections_program, gen_stage3_reentrant_program};

    /// Fold a `u32` seed into a spread of pseudo-bytes (the seed-mixing shape
    /// the existing generator sweeps use).
    fn seed_bytes(seed: u32, salt: u8) -> Vec<u8> {
        let s = seed.to_le_bytes();
        let mut buf = Vec::new();
        for k in 0..(20 + (seed % 40)) {
            buf.push(
                s[(k as usize) % 4]
                    .wrapping_add((k as u8).wrapping_mul(29))
                    .wrapping_add((seed as u8).wrapping_mul(salt)),
            );
        }
        buf
    }

    #[test]
    fn generated_arena_snapshots_round_trip_byte_exact() {
        // Sweep a spread of seeds: every fuzzer-generated arena image must
        // write→read→write byte-identically, and the images must be genuinely
        // diverse (not one shape a thousand times).
        let mut distinct = std::collections::BTreeSet::new();
        let mut saw_free = false;
        let mut saw_chunks = false;
        let mut saw_symbols = false;
        // The side-table arms need witnesses too. Review wave 5 probed
        // the generator and found it DOES produce all three today — but
        // the four witnesses above exist precisely so a refactor cannot
        // silently degrade an arm to empty, and the ledger arm shipped
        // without that protection.
        let mut saw_arrays = false;
        let mut saw_collections = false;
        let mut saw_registry = false;
        let mut saw_dates = false;
        let mut saw_functions = false;
        let mut saw_proxies = false;
        let mut saw_revokers = false;
        let mut saw_accessors = false;
        let mut saw_private = false;
        let mut saw_disposable = false;
        let mut saw_generators = false;
        let mut saw_generator_frames = false;
        let mut saw_promises = false;
        let mut saw_promise_reactions = false;
        let mut saw_promise_functions = false;
        let mut saw_combinators = false;
        for seed in 0u32..3000 {
            let buf = seed_bytes(seed, 7);
            let img = gen_machine_image(&buf);
            distinct.insert(write_machine(&img));
            saw_free |= !img.slot_free.is_empty();
            saw_chunks |= !img.chunks.is_empty();
            saw_symbols |= !img.symbols.pairs.is_empty();
            saw_arrays |= !img.arrays.is_empty();
            saw_collections |= !img.collections.is_empty();
            saw_registry |= !img.registry.is_empty();
            saw_dates |= !img.dates.is_empty();
            saw_functions |= !img.function_state.functions.is_empty();
            saw_proxies |= !img.proxy_state.proxies.is_empty();
            saw_revokers |= !img.proxy_state.revokers.is_empty();
            saw_accessors |= !img.accessors.is_empty();
            saw_private |= !img.private_elements.values.is_empty()
                || !img.private_elements.accessors.is_empty();
            saw_disposable |= !img.disposable_stacks.is_empty();
            saw_generators |= !img.generators.is_empty();
            saw_generator_frames |= img.generators.iter().any(|g| g.frame.is_some());
            saw_promises |= !img.promise_cluster.promises.is_empty();
            saw_promise_reactions |= img
                .promise_cluster
                .promises
                .iter()
                .any(|p| !p.reactions.is_empty());
            saw_promise_functions |= !img.promise_cluster.functions.is_empty();
            saw_combinators |= !img.promise_cluster.combinators.is_empty();
            if let Err(d) = roundtrip_image_is_invariant(&img) {
                panic!("arena snapshot round-trip divergence at seed {seed}: {d:?}");
            }
        }
        assert!(distinct.len() > 500, "arena sweep too uniform: {} distinct", distinct.len());
        assert!(saw_free, "free-list arm never exercised");
        // (No value-stack witness: the reader enforces quiescence, so
        // the generator emits only the empty stack every honest writer
        // does — review finding 5.)
        assert!(saw_chunks, "chunk-arena arm never exercised");
        assert!(saw_symbols, "symbol-table arm never exercised");
        assert!(saw_arrays, "side-table ARRY arm never exercised");
        assert!(saw_collections, "side-table COLL arm never exercised");
        assert!(saw_registry, "side-table REGY arm never exercised");
        assert!(saw_dates, "side-table DATE arm never exercised");
        assert!(saw_functions, "side-table FUNC arm never exercised");
        assert!(saw_proxies, "side-table PROX arm never exercised");
        assert!(saw_revokers, "PROX revoker arm never exercised");
        assert!(saw_accessors, "side-table ACCS arm never exercised");
        assert!(saw_private, "side-table PRIV arm never exercised");
        assert!(saw_disposable, "side-table DISP arm never exercised");
        assert!(saw_generators, "side-table GENR arm never exercised");
        // The frame is the substantial half of the GENR codec; a
        // generator sweep that only ever emitted Completed rows would
        // leave `SavedFrameRow` unexercised while looking covered.
        assert!(saw_generator_frames, "GENR suspended-frame arm never exercised");
        assert!(saw_promises, "side-table PRMS arm never exercised");
        assert!(saw_promise_reactions, "PRMS reaction arm never exercised");
        assert!(saw_promise_functions, "PRMS resolving-function arm never exercised");
        assert!(saw_combinators, "PRMS combinator arm never exercised");
        // (`IBFN` and the typed-array family are deliberately not
        // generated -- both are cross-table dependent on state this
        // builder does not model. See the builder for the reasons.)
    }

    #[test]
    fn engine_driven_snapshots_round_trip_byte_exact() {
        // Drive the engine with rich generated programs (objects/calls/
        // closures/exceptions, bigints, keyed collections, re-entrant array
        // methods), snapshot each live machine, and assert the container
        // round-trips byte-identically and the meter is preserved.
        let mut checked = 0;
        for seed in 0u32..250 {
            let buf = seed_bytes(seed, 11);
            for prog in [
                gen_stage2b_program(&buf),
                gen_stage3_bigint_program(&buf),
                gen_stage3_collections_program(&buf),
                gen_stage3_reentrant_program(&buf),
            ] {
                match roundtrip_program_is_invariant(&prog) {
                    Ok(true) => checked += 1,
                    Ok(false) => {}
                    Err(d) => panic!("engine snapshot round-trip divergence on {prog:?}: {d:?}"),
                }
            }
        }
        assert!(checked > 0, "no engine-driven program round-trips ran");
    }

    #[test]
    fn suspend_resume_is_transparent_over_arithmetic_cranks() {
        // A suspend→resume→continue crank equals the uninterrupted A-then-B
        // run in result AND computron count, over fuzzer-chosen arithmetic
        // crank pairs (the regime the current suspend contract holds exactly).
        let mut checked = 0;
        for seed in 0u32..400 {
            let a = gen_program(&seed_bytes(seed, 13));
            let b = gen_program(&seed_bytes(seed.wrapping_mul(2654435761), 17));
            match suspend_resume_is_transparent(&a, &b) {
                Ok(true) => checked += 1,
                Ok(false) => {}
                Err(d) => panic!("suspend/resume transparency divergence: {d:?}"),
            }
        }
        assert!(checked > 0, "no suspend/resume crank pairs ran");
    }

    #[test]
    fn decoder_never_panics_on_arbitrary_or_mutated_bytes() {
        // The bounded property loop that stands in for a libFuzzer campaign of
        // the malformed-atom target: thousands of arbitrary and mutated-valid
        // inputs through the reader, which must never panic, hang, or
        // over-allocate. A panic/hang fails the test in bounded time.
        for seed in 0u32..5000 {
            let mut s = seed.wrapping_mul(2654435761);
            let n = (s % 48) as usize;
            let mut bytes = Vec::with_capacity(n);
            for _ in 0..n {
                s = s.wrapping_mul(1103515245).wrapping_add(12345);
                bytes.push((s >> 16) as u8);
            }
            decoder_is_error_free(&bytes);
        }
        // Fixed adversarial inputs: the huge-count fields the clamps defend
        // against, fed through the mutation path.
        decoder_is_error_free(&[0xff; 64]);
        decoder_is_error_free(&[0x00; 64]);
        decoder_is_error_free(&[]);
    }

    #[test]
    fn nan_payload_round_trips_byte_exact_but_not_parteq() {
        // Locked trophy (snapshot_roundtrip campaign, originally seed
        // input `22 03 ff ff`, 2026-07-16): an input that generates a
        // machine image carrying a `Number(NaN)` payload. The container
        // round-trips **byte-exactly** (the codec preserves the NaN bit
        // pattern — the real invariant), but `MachineImage`'s derived
        // `PartialEq` reports the decoded image unequal to the original
        // because `NaN != NaN`. The fix is not in the codec (it is
        // correct) but in the invariant: `roundtrip_image_is_invariant`
        // asserts write→read→write **byte-equality**, not value
        // equality, so a non-reflexive float payload is not a false
        // trophy. The seed input was re-derived when the reader's
        // quiescence gate emptied the generated stack (review finding
        // 5) — the original's NaN rode a stack slot; this one is
        // constructed to land it in heap slot 0 (no chunks, one slot,
        // arm 4, bits 0x7ff8_0000_…).
        let data = [0x00u8, 0x00, 0x04, 0x7f, 0xf8, 0x00, 0x00, 0x00];
        let img = gen_machine_image(&data);
        // The image genuinely contains a NaN payload (the condition that made
        // the derived PartialEq fire).
        let has_nan = img
            .slots
            .iter()
            .chain(img.stack.iter())
            .any(|s| matches!(s.value, ironhorse_vm::Payload::Number(n) if n.is_nan()));
        assert!(has_nan, "the seed input must still generate a NaN payload");
        // The byte-level round-trip invariant holds and must never regress.
        assert!(
            roundtrip_generated_is_invariant(&data).is_ok(),
            "NaN-carrying image must round-trip byte-exact"
        );
        // Direct byte-equality, as the invariant states.
        let sig = fuzz_snapshot_sig();
        let bytes = write_machine(&img);
        let back = read_machine(&bytes, &sig).expect("valid snapshot reads back");
        assert_eq!(write_machine(&back), bytes, "write→read→write byte-identical");
    }

    #[test]
    fn mutation_corpus_reaches_the_atom_decoders() {
        // Prove the malformed corpus is meaningful: over the sweep, the mutated
        // snapshots reach BOTH the outer-gate rejections and the inner
        // atom-payload decoders (a decoded machine or a Corrupt error), rather
        // than all bouncing off the VERS gate. Uses the crate-internal reader
        // directly so the outcome is observable.
        let sig = fuzz_snapshot_sig();
        let mut reached_inner = 0;
        let mut restored_ok = 0;
        let mut gate_rejected = 0;
        for seed in 0u32..3000 {
            let buf = seed_bytes(seed, 23);
            let valid = write_machine(&gen_machine_image(&buf));
            let mutated = mutate_bytes(&valid, &buf);
            match read_machine(&mutated, &sig) {
                Ok(_) => restored_ok += 1,
                Err(ironhorse_snapshot::SnapshotError::Corrupt(_)) => reached_inner += 1,
                Err(_) => gate_rejected += 1,
            }
        }
        assert!(restored_ok > 0, "no mutant ever read back (mutation too destructive)");
        assert!(reached_inner > 0, "no mutant reached the atom-payload decoders");
        assert!(gate_rejected > 0, "no mutant hit the outer gates");
    }
}
