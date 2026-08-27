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

    // Free a distinct prefix of the allocated slots to exercise the free-list
    // round-trip (indices are distinct — all allocated before any free — so no
    // double-free).
    let n_free = (c.byte() as usize) % idxs.len();
    for &ix in idxs.iter().take(n_free) {
        slots.free(ix);
    }

    // A value stack of slots (empty at true quiescence, but the codec must
    // round-trip a non-empty stack too).
    let n_stack = (c.byte() % 6) as usize;
    let stack: Vec<Slot> = (0..n_stack)
        .map(|_| {
            let mut s = Slot::of(Kind::Integer, payload(&mut c, &offs, &idxs));
            s.id = c.u32() as u16;
            s
        })
        .collect();

    let names = rand_string_list(&mut c);
    let keys = rand_string_list(&mut c);
    // Symbol-key table: generated VALID like the ledger rows below —
    // ids strictly ascending above the counter, descriptors distinct
    // and in-bounds — so write→read identity holds while the DECODER
    // sees ill-formed tables from the raw-bytes fuzz lane.
    let bound = (n_slots as u32).max(1);
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
    // pairwise distinct. Generating rows the decoder refuses would turn
    // the round-trip target into a decode-failure target and stop
    // exercising the identity it exists for.
    let cap = n_slots as u32;
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
        collections.push(ironhorse_snapshot::image::CollectionImage {
            owner,
            kind: c.byte() % 4,
            table_length: c.u32() % 16,
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
        });
        next_owner += 1;
    }

    MachineImage::from_arenas(fuzz_snapshot_sig(), &slots, &chunks, &stack, names, keys, symbols)
        .with_meter(meter)
        .with_side_tables(arrays, collections, registry, errors)
}

/// The core round-trip invariant over a built image: a freshly written
/// snapshot must **read back** (a decode failure on our own output is a
/// defect), and **write → read → write must be byte-identical**.
///
/// Byte-equality — not `MachineImage` value equality — is the invariant on
/// purpose. A slot may hold a `Payload::Number(f64::NAN)` (or any non-
/// reflexive float), and `NaN != NaN`, so the *derived* `PartialEq` on
/// `MachineImage` reports a spurious inequality even though the codec
/// preserves the NaN bit pattern exactly (fuzz trophy
/// `nan_payload_round_trips_byte_exact_but_not_parteq`; the slot codec's own
/// `nan_bits_preserved` proves the bits survive). Byte-equality of
/// write→read→write is the faithful, NaN-safe statement of "the container
/// round-trips" the daemon restore path depends on, and it subsumes value
/// fidelity: it proves `encode(decode(encode(img))) == encode(img)`.
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
    Ok(())
}

/// Round-trip invariance over a fuzzer-generated arena image (oracle-free).
pub fn roundtrip_generated_is_invariant(data: &[u8]) -> Result<(), RoundtripDivergence> {
    roundtrip_image_is_invariant(&gen_machine_image(data))
}

/// Round-trip invariance over a **live machine**: compile a generated program
/// with the oracle, drive the engine to populate its heap, snapshot it, and
/// assert the container round-trips byte-identically and the resumed machine's
/// meter equals the live one. Skips (returns `Ok`) any source the oracle
/// declines to compile.
pub fn roundtrip_program_is_invariant(source: &str) -> Result<(), RoundtripDivergence> {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return Ok(()),
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
        Err(_) => return Ok(()),
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
    Ok(())
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
) -> Result<(), RoundtripDivergence> {
    let a = match xs_oracle::run(source_a) {
        Some(o) => o,
        None => return Ok(()),
    };
    let b = match xs_oracle::run(source_b) {
        Some(o) => o,
        None => return Ok(()),
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
        Err(_) => return Ok(()),
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
    Ok(())
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
        let mut saw_stack = false;
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
        for seed in 0u32..3000 {
            let buf = seed_bytes(seed, 7);
            let img = gen_machine_image(&buf);
            distinct.insert(write_machine(&img));
            saw_free |= !img.slot_free.is_empty();
            saw_stack |= !img.stack.is_empty();
            saw_chunks |= !img.chunks.is_empty();
            saw_symbols |= !img.symbols.pairs.is_empty();
            saw_arrays |= !img.arrays.is_empty();
            saw_collections |= !img.collections.is_empty();
            saw_registry |= !img.registry.is_empty();
            if let Err(d) = roundtrip_image_is_invariant(&img) {
                panic!("arena snapshot round-trip divergence at seed {seed}: {d:?}");
            }
        }
        assert!(distinct.len() > 500, "arena sweep too uniform: {} distinct", distinct.len());
        assert!(saw_free, "free-list arm never exercised");
        assert!(saw_stack, "value-stack arm never exercised");
        assert!(saw_chunks, "chunk-arena arm never exercised");
        assert!(saw_symbols, "symbol-table arm never exercised");
        assert!(saw_arrays, "side-table ARRY arm never exercised");
        assert!(saw_collections, "side-table COLL arm never exercised");
        assert!(saw_registry, "side-table REGY arm never exercised");
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
                    Ok(()) => checked += 1,
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
                Ok(()) => checked += 1,
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
        // Locked trophy (snapshot_roundtrip campaign, seed input `22 03 ff ff`,
        // 2026-07-16): this input generates a machine image with a slot whose
        // payload is `Number(NaN)`. The container round-trips **byte-exactly**
        // (the codec preserves the NaN bit pattern — the real invariant), but
        // `MachineImage`'s derived `PartialEq` reports the decoded image
        // unequal to the original because `NaN != NaN`. The fix is not in the
        // codec (it is correct) but in the invariant: `roundtrip_image_is_-
        // invariant` asserts write→read→write **byte-equality**, not value
        // equality, so a non-reflexive float payload is not a false trophy.
        let data = [0x22u8, 0x03, 0xff, 0xff];
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
