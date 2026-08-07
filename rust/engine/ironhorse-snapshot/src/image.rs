//! The `MachineImage` — the plain-data snapshot of an ironhorse machine's
//! serializable state — and the [`write_machine`]/[`read_machine`] codec
//! that maps it to and from the `XS_M` atom container.
//!
//! This is the **narrow, documented surface child 3 calls** (job spec):
//! child 3's `Machine`-level `write_snapshot_to_file`/`from_snapshot_file`/
//! `suspend_to_cas` build a `MachineImage` from a live `Interp` (reading
//! its private fields) and stream [`write_machine`]'s bytes; on restore it
//! [`read_machine`]s the bytes into a `MachineImage` and rebuilds the
//! arenas with [`ironhorse_vm::SlotArena::from_image`] /
//! [`ironhorse_vm::ChunkArena::from_image`]. This crate owns the *format*; the
//! `Interp`↔image conversion stays in the engine.
//!
//! Coverage today: the index arenas (`HEAP`/`BLOC`), the interpreter stack
//! (`STAC`), and the symbol/key tables (`NAME`/`KEYS`/`SYMB`), plus the
//! `VERS`/`SIGN`/`CREA` headers. The rich per-instance side tables are
//! enumerated in [`crate::sidetable`] with their coverage; the ones marked
//! `Pending` there are the remaining atoms.

use crate::atom::{AtomReader, AtomWriter};
use crate::format::{
    Signature, SnapshotError, Version, BLOC, CREA, HEAP, KEYS, METR, NAME, SIGN, STAC, SYMB, VERS,
};
use crate::slot_codec::{decode_slots, encode_slots, SLOT_RECORD_BYTES};
use ironhorse_vm::{ChunkArena, MeterState, Slot, SlotArena, COST_TABLE_VERSION};

/// The metering state carried in the `METR` atom (design row 6: "meter
/// state across suspend"). The frozen 16.16 fixed-point counters plus the
/// **cost-table version** that produced them; a resume whose cost-table
/// version differs from this engine's [`ironhorse_vm::COST_TABLE_VERSION`]
/// fails closed ([`SnapshotError::CostTableMismatch`]) rather than
/// silently continuing a meter whose weights changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeterImage {
    pub cost_table_version: String,
    pub index: u64,
    pub interval: u64,
    pub count: u64,
}

impl MeterImage {
    /// The image of a live meter state under this engine's current frozen
    /// cost table.
    pub fn of(state: MeterState) -> MeterImage {
        MeterImage {
            cost_table_version: COST_TABLE_VERSION.to_string(),
            index: state.index,
            interval: state.interval,
            count: state.count,
        }
    }

    /// A zeroed, un-armed meter under the current cost table (the meter of
    /// a machine that has run nothing).
    pub fn current() -> MeterImage {
        MeterImage::of(MeterState::default())
    }

    /// The carried metering state as the engine's [`MeterState`] (drops the
    /// cost-table version, which the reader has already validated).
    pub fn to_state(&self) -> MeterState {
        MeterState {
            index: self.index,
            interval: self.interval,
            count: self.count,
        }
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.index.to_be_bytes());
        v.extend_from_slice(&self.interval.to_be_bytes());
        v.extend_from_slice(&self.count.to_be_bytes());
        let vb = self.cost_table_version.as_bytes();
        v.extend_from_slice(&(vb.len() as u32).to_be_bytes());
        v.extend_from_slice(vb);
        v
    }

    pub(crate) fn decode(p: &[u8]) -> Result<MeterImage, SnapshotError> {
        if p.len() < 28 {
            return Err(SnapshotError::Corrupt("METR header"));
        }
        let index = u64::from_be_bytes(p[0..8].try_into().unwrap());
        let interval = u64::from_be_bytes(p[8..16].try_into().unwrap());
        let count = u64::from_be_bytes(p[16..24].try_into().unwrap());
        let vlen = u32::from_be_bytes([p[24], p[25], p[26], p[27]]) as usize;
        if 28 + vlen > p.len() {
            return Err(SnapshotError::Corrupt("METR version string"));
        }
        let cost_table_version = std::str::from_utf8(&p[28..28 + vlen])
            .map_err(|_| SnapshotError::Corrupt("METR version not utf8"))?
            .to_string();
        Ok(MeterImage {
            cost_table_version,
            index,
            interval,
            count,
        })
    }
}

/// Machine creation parameters (`CREA`). The heap-sizing hints XS records
/// so a restore can pre-size the arenas; ironhorse's arenas grow on demand, so
/// these are advisory (recorded for fidelity and future pre-sizing).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CreationParams {
    pub initial_slot_count: u32,
    pub initial_chunk_bytes: u32,
}

impl CreationParams {
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(8);
        v.extend_from_slice(&self.initial_slot_count.to_be_bytes());
        v.extend_from_slice(&self.initial_chunk_bytes.to_be_bytes());
        v
    }
    pub(crate) fn decode(p: &[u8]) -> Result<CreationParams, SnapshotError> {
        if p.len() < 8 {
            return Err(SnapshotError::Corrupt("CREA payload too short"));
        }
        Ok(CreationParams {
            initial_slot_count: u32::from_be_bytes([p[0], p[1], p[2], p[3]]),
            initial_chunk_bytes: u32::from_be_bytes([p[4], p[5], p[6], p[7]]),
        })
    }
}

/// The serializable image of an ironhorse machine.
#[derive(Clone, Debug, PartialEq)]
pub struct MachineImage {
    pub version: Version,
    pub signature: Signature,
    pub creation: CreationParams,
    /// `BLOC`: the chunk arena bytes, header discipline included.
    pub chunks: Vec<u8>,
    /// `HEAP`: every slot record (live and free alike), index-ordered.
    pub slots: Vec<Slot>,
    /// `HEAP`: the slot arena's free list.
    pub slot_free: Vec<u32>,
    /// `HEAP`: the live slot count (`currentHeapCount`).
    pub slot_live: u32,
    /// `STAC`: the interpreter's live stack slots.
    pub stack: Vec<Slot>,
    /// `KEYS`: runtime-interned property key names.
    pub keys: Vec<String>,
    /// `NAME`: the program symbol names, id-ordered (`symbol_names`).
    pub names: Vec<String>,
    /// `SYMB`: well-known / registered symbol identity slot indices.
    pub symbols: Vec<u32>,
    /// `METR`: the metering state (design row 6). A resumed machine
    /// continues its meter from exactly this point.
    pub meter: MeterImage,
}

impl MachineImage {
    /// Build an image straight from a pair of arenas plus the stack and
    /// symbol tables — the arena-(de)serialization surface. The caller
    /// supplies the machine signature (its callback-table version).
    pub fn from_arenas(
        signature: Signature,
        slots: &SlotArena,
        chunks: &ChunkArena,
        stack: &[Slot],
        names: Vec<String>,
        keys: Vec<String>,
        symbols: Vec<u32>,
    ) -> MachineImage {
        MachineImage {
            version: Version::current(),
            signature,
            creation: CreationParams {
                initial_slot_count: slots.capacity(),
                initial_chunk_bytes: chunks.byte_size() as u32,
            },
            chunks: chunks.raw_vec(),
            slots: slots.records(),
            slot_free: slots.free_list().to_vec(),
            slot_live: slots.live_count(),
            stack: stack.to_vec(),
            keys,
            names,
            symbols,
            meter: MeterImage::current(),
        }
    }

    /// Attach a metering state to this image (design row 6). The snapshot
    /// surface calls this with the live machine's [`MeterState`] so a
    /// resume continues the meter exactly.
    pub fn with_meter(mut self, meter: MeterState) -> MachineImage {
        self.meter = MeterImage::of(meter);
        self
    }

    /// Rebuild the slot and chunk arenas from this image. Round-trips the
    /// index arenas exactly (indices preserved, free list preserved).
    pub fn to_arenas(&self) -> (SlotArena, ChunkArena) {
        let slots = SlotArena::from_image(self.slots.clone(), self.slot_free.clone(), self.slot_live);
        let chunks = ChunkArena::from_image(self.chunks.clone());
        (slots, chunks)
    }
}

// --- string-list and slot-list atom payload helpers ---

pub(crate) fn encode_strings(list: &[String]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(list.len() as u32).to_be_bytes());
    for s in list {
        let b = s.as_bytes();
        v.extend_from_slice(&(b.len() as u32).to_be_bytes());
        v.extend_from_slice(b);
    }
    v
}

pub(crate) fn decode_strings(p: &[u8]) -> Result<Vec<String>, SnapshotError> {
    if p.len() < 4 {
        return Err(SnapshotError::Corrupt("string list header"));
    }
    let count = u32::from_be_bytes([p[0], p[1], p[2], p[3]]) as usize;
    // Reserve no more than the payload could possibly hold: every entry
    // carries at least a 4-byte length header, so a valid `count` never
    // exceeds `p.len() / 4`. Clamping the pre-reservation keeps a malformed
    // `count` (up to `u32::MAX`) from reserving gigabytes before the
    // per-entry bounds check below rejects the truncation (fuzz trophy
    // `malformed_string_count_does_not_over_allocate`).
    let mut out = Vec::with_capacity(count.min(p.len() / 4));
    let mut i = 4;
    for _ in 0..count {
        if i + 4 > p.len() {
            return Err(SnapshotError::Corrupt("string list entry header"));
        }
        let len = u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]) as usize;
        i += 4;
        if i + len > p.len() {
            return Err(SnapshotError::Corrupt("string list entry body"));
        }
        let s = std::str::from_utf8(&p[i..i + len])
            .map_err(|_| SnapshotError::Corrupt("string list entry not utf8"))?;
        out.push(s.to_string());
        i += len;
    }
    Ok(out)
}

pub(crate) fn encode_u32s(list: &[u32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + list.len() * 4);
    v.extend_from_slice(&(list.len() as u32).to_be_bytes());
    for &x in list {
        v.extend_from_slice(&x.to_be_bytes());
    }
    v
}

pub(crate) fn decode_u32s(p: &[u8]) -> Result<Vec<u32>, SnapshotError> {
    if p.len() < 4 {
        return Err(SnapshotError::Corrupt("u32 list header"));
    }
    let count = u32::from_be_bytes([p[0], p[1], p[2], p[3]]) as usize;
    // Clamp the pre-reservation to what the payload can hold (4 bytes per
    // entry); a malformed `count` must not reserve gigabytes before the
    // per-entry bounds check below rejects it (fuzz trophy
    // `malformed_u32_count_does_not_over_allocate`).
    let mut out = Vec::with_capacity(count.min(p.len() / 4));
    let mut i = 4;
    for _ in 0..count {
        if i + 4 > p.len() {
            return Err(SnapshotError::Corrupt("u32 list entry"));
        }
        out.push(u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]));
        i += 4;
    }
    Ok(out)
}

/// HEAP payload: `[slot_count][free_count][live][free…][records…]`.
fn encode_heap(image: &MachineImage) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(image.slots.len() as u32).to_be_bytes());
    v.extend_from_slice(&(image.slot_free.len() as u32).to_be_bytes());
    v.extend_from_slice(&image.slot_live.to_be_bytes());
    for &f in &image.slot_free {
        v.extend_from_slice(&f.to_be_bytes());
    }
    v.extend_from_slice(&encode_slots(&image.slots));
    v
}

fn decode_heap(p: &[u8]) -> Result<(Vec<Slot>, Vec<u32>, u32), SnapshotError> {
    if p.len() < 12 {
        return Err(SnapshotError::Corrupt("HEAP header"));
    }
    let slot_count = u32::from_be_bytes([p[0], p[1], p[2], p[3]]) as usize;
    let free_count = u32::from_be_bytes([p[4], p[5], p[6], p[7]]) as usize;
    let live = u32::from_be_bytes([p[8], p[9], p[10], p[11]]);
    let mut i = 12;
    // Clamp the free-list pre-reservation to what the payload can hold (4
    // bytes per entry); a malformed `free_count` must not reserve gigabytes
    // before the per-entry bounds check below rejects it (fuzz trophy
    // `malformed_heap_free_count_does_not_over_allocate`).
    let mut free = Vec::with_capacity(free_count.min(p.len() / 4));
    for _ in 0..free_count {
        if i + 4 > p.len() {
            return Err(SnapshotError::Corrupt("HEAP free list"));
        }
        free.push(u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]));
        i += 4;
    }
    let want = slot_count * SLOT_RECORD_BYTES;
    if p.len() - i < want {
        return Err(SnapshotError::Corrupt("HEAP records truncated"));
    }
    let slots = decode_slots(&p[i..i + want]).map_err(|_| SnapshotError::Corrupt("HEAP slot record"))?;
    Ok((slots, free, live))
}

/// STAC payload: `[count][records…]`.
pub(crate) fn encode_stack(stack: &[Slot]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(stack.len() as u32).to_be_bytes());
    v.extend_from_slice(&encode_slots(stack));
    v
}

pub(crate) fn decode_stack(p: &[u8]) -> Result<Vec<Slot>, SnapshotError> {
    if p.len() < 4 {
        return Err(SnapshotError::Corrupt("STAC header"));
    }
    let count = u32::from_be_bytes([p[0], p[1], p[2], p[3]]) as usize;
    let want = count * SLOT_RECORD_BYTES;
    if p.len() - 4 < want {
        return Err(SnapshotError::Corrupt("STAC records truncated"));
    }
    decode_slots(&p[4..4 + want]).map_err(|_| SnapshotError::Corrupt("STAC slot record"))
}

/// Serialize a machine image into an `XS_M` atom container. Atoms are
/// written in the canonical order `VERS SIGN CREA BLOC HEAP STAC KEYS NAME
/// SYMB METR` (the order `xsSnapshot.c` emits, with the ironhorse-specific
/// `METR` meter atom last), so two writes of the same image are
/// byte-identical.
pub fn write_machine(image: &MachineImage) -> Vec<u8> {
    let mut w = AtomWriter::new();
    w.atom(VERS, &image.version.encode());
    w.atom(SIGN, &image.signature.encode());
    w.atom(CREA, &image.creation.encode());
    w.atom(BLOC, &image.chunks);
    w.atom(HEAP, &encode_heap(image));
    w.atom(STAC, &encode_stack(&image.stack));
    w.atom(KEYS, &encode_strings(&image.keys));
    w.atom(NAME, &encode_strings(&image.names));
    w.atom(SYMB, &encode_u32s(&image.symbols));
    w.atom(METR, &image.meter.encode());
    w.finish()
}

/// Parse an `XS_M` atom container into a machine image, enforcing the
/// ironhorse `VERS` discriminator and checking the host callback-table
/// `SIGN` against `expected_sig` — a mismatch fails closed exactly as
/// `fxReadSnapshot` does (a callback index would bind the wrong host
/// function). Pass the machine's current signature.
pub fn read_machine(buf: &[u8], expected_sig: &Signature) -> Result<MachineImage, SnapshotError> {
    let r = AtomReader::parse(buf)?;

    let vers = r.find(VERS).ok_or(SnapshotError::MissingAtom(VERS))?;
    let version = Version::decode(vers.payload)?;

    let sign = r.find(SIGN).ok_or(SnapshotError::MissingAtom(SIGN))?;
    let signature = Signature::decode(sign.payload)?;
    if !signature.is_compatible_with(expected_sig) {
        return Err(SnapshotError::SignatureMismatch {
            expected: expected_sig.clone(),
            found: signature,
        });
    }

    let creation = match r.find(CREA) {
        Some(a) => CreationParams::decode(a.payload)?,
        None => CreationParams::default(),
    };
    let chunks = r.find(BLOC).map(|a| a.payload.to_vec()).unwrap_or_default();

    let heap = r.find(HEAP).ok_or(SnapshotError::MissingAtom(HEAP))?;
    let (slots, slot_free, slot_live) = decode_heap(heap.payload)?;

    let stack = match r.find(STAC) {
        Some(a) => decode_stack(a.payload)?,
        None => Vec::new(),
    };
    let keys = match r.find(KEYS) {
        Some(a) => decode_strings(a.payload)?,
        None => Vec::new(),
    };
    let names = match r.find(NAME) {
        Some(a) => decode_strings(a.payload)?,
        None => Vec::new(),
    };
    let symbols = match r.find(SYMB) {
        Some(a) => decode_u32s(a.payload)?,
        None => Vec::new(),
    };

    // METR (design row 6): decode the metering state and fail closed on a
    // cost-table version this engine did not produce — the metering
    // analogue of the SIGN check above. An absent METR (a pre-row-6
    // container) reads as a zeroed meter under the current table.
    let meter = match r.find(METR) {
        Some(a) => MeterImage::decode(a.payload)?,
        None => MeterImage::current(),
    };
    if meter.cost_table_version != COST_TABLE_VERSION {
        return Err(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: meter.cost_table_version,
        });
    }

    Ok(MachineImage {
        version,
        signature,
        creation,
        chunks,
        slots,
        slot_free,
        slot_live,
        stack,
        keys,
        names,
        symbols,
        meter,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::{Kind, Payload, SlotIndex};

    fn sig() -> Signature {
        Signature::new("ironhorse-test-sig-v1")
    }

    #[test]
    fn empty_machine_round_trips_byte_equal() {
        let img = MachineImage {
            version: Version::current(),
            signature: sig(),
            creation: CreationParams::default(),
            chunks: Vec::new(),
            slots: Vec::new(),
            slot_free: Vec::new(),
            slot_live: 0,
            stack: Vec::new(),
            keys: Vec::new(),
            names: Vec::new(),
            symbols: Vec::new(),
            meter: MeterImage::current(),
        };
        let bytes = write_machine(&img);
        let back = read_machine(&bytes, &sig()).unwrap();
        assert_eq!(back, img);
        // Second write byte-equals the first.
        assert_eq!(write_machine(&back), bytes);
    }

    #[test]
    fn signature_mismatch_fails_closed() {
        let img = MachineImage {
            version: Version::current(),
            signature: Signature::new("written-under-v1"),
            creation: CreationParams::default(),
            chunks: Vec::new(),
            slots: Vec::new(),
            slot_free: Vec::new(),
            slot_live: 0,
            stack: Vec::new(),
            keys: Vec::new(),
            names: Vec::new(),
            symbols: Vec::new(),
            meter: MeterImage::current(),
        };
        let bytes = write_machine(&img);
        match read_machine(&bytes, &Signature::new("host-is-now-v2")) {
            Err(SnapshotError::SignatureMismatch { .. }) => {}
            other => panic!("expected signature mismatch, got {:?}", other),
        }
    }

    /// Build an arena with an object graph (an instance whose two property
    /// slots hold an integer and a heap string), a closure cell, and a
    /// stack, and round-trip it through the atom container — the arena
    /// (de)serialization surface, write → read → write byte-equal.
    #[test]
    fn arena_graph_round_trips() {
        let mut slots = SlotArena::new();
        let mut chunks = ChunkArena::new();

        // A heap string "hi" (UTF-16BE).
        let hi = chunks.alloc(&[0x00, 0x68, 0x00, 0x69]);
        // The shared closure cell holding integer 7.
        let cell = slots.alloc(Slot::integer(7));
        // A property list: {a: 5, b: "hi"} on an instance.
        let prop_b = slots.alloc(Slot::property(2, Payload::String(hi)));
        let mut prop_a = Slot::property(1, Payload::Integer(5));
        prop_a.next = prop_b;
        let prop_a_i = slots.alloc(prop_a);
        let mut inst = Slot::instance(SlotIndex::NULL);
        inst.next = prop_a_i;
        let inst_i = slots.alloc(inst);
        // A closure scope slot indirecting to the cell.
        let closure = slots.alloc(Slot::of(Kind::Closure, Payload::Reference(cell)));

        // Free one slot to exercise the free-list round-trip.
        let scratch = slots.alloc(Slot::integer(0));
        slots.free(scratch);

        let stack = vec![
            Slot::of(Kind::Reference, Payload::Reference(inst_i)),
            Slot::of(Kind::Closure, Payload::Reference(cell)),
            Slot::of(Kind::String, Payload::String(hi)),
        ];
        let _ = closure;

        let img = MachineImage::from_arenas(
            sig(),
            &slots,
            &chunks,
            &stack,
            vec!["length".to_string(), "name".to_string()],
            vec!["dynKey".to_string()],
            vec![101, 202],
        );

        let bytes = write_machine(&img);
        let back = read_machine(&bytes, &sig()).unwrap();
        assert_eq!(back, img);
        // Byte-equality of the second write.
        assert_eq!(write_machine(&back), bytes);

        // Structural: the rebuilt arenas reproduce the graph.
        let (slots2, chunks2) = back.to_arenas();
        assert_eq!(slots2.capacity(), slots.capacity());
        assert_eq!(slots2.live_count(), slots.live_count());
        // The instance's first property is the integer 5.
        let inst2 = slots2.get(inst_i);
        let pa = slots2.get(inst2.next);
        assert_eq!(pa.value, Payload::Integer(5));
        // Its successor property references the "hi" chunk; decode it back.
        let pb = slots2.get(pa.next);
        if let Payload::String(o) = pb.value {
            assert_eq!(&*chunks2.payload(o), &[0x00, 0x68, 0x00, 0x69]);
        } else {
            panic!("second property should be a string");
        }
        // The closure cell survived with its value.
        assert_eq!(slots2.get(cell).value, Payload::Integer(7));
    }

    #[test]
    fn string_and_symbol_tables_round_trip() {
        let img = MachineImage {
            version: Version::current(),
            signature: sig(),
            creation: CreationParams {
                initial_slot_count: 3,
                initial_chunk_bytes: 16,
            },
            chunks: vec![1, 2, 3, 4],
            slots: vec![Slot::integer(9)],
            slot_free: vec![],
            slot_live: 1,
            stack: vec![Slot::boolean(true)],
            keys: vec!["k1".to_string(), "k2".to_string(), "".to_string()],
            names: vec!["Object".to_string(), "length".to_string()],
            symbols: vec![7, 8, 9],
            meter: MeterImage::current(),
        };
        let bytes = write_machine(&img);
        let back = read_machine(&bytes, &sig()).unwrap();
        assert_eq!(back, img);
    }

    #[test]
    fn missing_heap_atom_is_rejected() {
        // A hand-built container with VERS+SIGN but no HEAP.
        use crate::atom::AtomWriter;
        let mut w = AtomWriter::new();
        w.atom(VERS, &Version::current().encode());
        w.atom(SIGN, &sig().encode());
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::MissingAtom(HEAP))
        );
    }

    #[test]
    fn bigint_chunk_survives() {
        // A BigInt slot referencing a chunk of little-endian digits.
        let mut chunks = ChunkArena::new();
        let digits = chunks.alloc(&[0x00, 0x01, 0x00, 0x00, 0x00]); // sign + LE u32
        let mut slots = SlotArena::new();
        let bi = slots.alloc(Slot::of(Kind::BigInt, Payload::BigInt(digits)));
        let _ = bi;
        let img = MachineImage::from_arenas(
            sig(),
            &slots,
            &chunks,
            &[],
            vec![],
            vec![],
            vec![],
        );
        let bytes = write_machine(&img);
        let back = read_machine(&bytes, &sig()).unwrap();
        assert_eq!(write_machine(&back), bytes);
        let (slots2, chunks2) = back.to_arenas();
        if let Payload::BigInt(o) = slots2.get(bi).value {
            assert_eq!(&*chunks2.payload(o), &[0x00, 0x01, 0x00, 0x00, 0x00]);
        } else {
            panic!("bigint payload");
        }
    }

    // --- malformed-atom decoder trophies (stage-6 child 4) ---
    //
    // A container whose list-count field is enormous but whose payload is
    // short must fail closed **promptly** — the reader must not pre-reserve a
    // `Vec` sized by the untrusted count (up to `u32::MAX`), which reserves
    // gigabytes and aborts under a memory limit before the per-entry bounds
    // check ever runs. These locks build a minimal valid VERS+SIGN+HEAP
    // prefix, then a single list atom whose count claims `u32::MAX` with no
    // entry bytes behind it, and assert a structured `Corrupt` error. The
    // clamp in `decode_strings`/`decode_u32s`/`decode_heap` is what makes them
    // return in microseconds; before it, each hung on a 16–100 GB allocation.
    // (The daemon restore path must fail closed on a corrupt snapshot, never
    // crash the worker — job spec item 2.)

    use crate::atom::AtomWriter;

    /// A valid container prefix (VERS + SIGN + empty HEAP) that
    /// `read_machine` accepts up to the list atoms, so a malformed list atom
    /// appended after it is reached by the decoder.
    fn valid_prefix() -> AtomWriter {
        let mut w = AtomWriter::new();
        w.atom(VERS, &Version::current().encode());
        w.atom(SIGN, &sig().encode());
        // Empty HEAP payload: slot_count=0, free_count=0, live=0.
        w.atom(HEAP, &[0u8; 12]);
        w
    }

    /// A `u32::MAX` count with no entry bytes: `[count=0xFFFFFFFF]`.
    fn huge_count_payload() -> Vec<u8> {
        u32::MAX.to_be_bytes().to_vec()
    }

    #[test]
    fn malformed_string_count_does_not_over_allocate() {
        // KEYS claims u32::MAX strings but carries none.
        let mut w = valid_prefix();
        w.atom(KEYS, &huge_count_payload());
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("string list entry header"))
        );
        // NAME is decoded by the same path — lock it too.
        let mut w = valid_prefix();
        w.atom(NAME, &huge_count_payload());
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("string list entry header"))
        );
    }

    #[test]
    fn malformed_u32_count_does_not_over_allocate() {
        // SYMB claims u32::MAX ids but carries none.
        let mut w = valid_prefix();
        w.atom(SYMB, &huge_count_payload());
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("u32 list entry"))
        );
    }

    #[test]
    fn malformed_heap_free_count_does_not_over_allocate() {
        // A HEAP header whose free_count claims u32::MAX with no free bytes.
        let mut heap = Vec::new();
        heap.extend_from_slice(&0u32.to_be_bytes()); // slot_count = 0
        heap.extend_from_slice(&u32::MAX.to_be_bytes()); // free_count = u32::MAX
        heap.extend_from_slice(&0u32.to_be_bytes()); // live = 0
        let mut w = AtomWriter::new();
        w.atom(VERS, &Version::current().encode());
        w.atom(SIGN, &sig().encode());
        w.atom(HEAP, &heap);
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("HEAP free list"))
        );
    }

    #[test]
    fn malformed_heap_slot_count_does_not_over_allocate() {
        // A HEAP header whose slot_count claims u32::MAX records with none
        // present: the `want > remaining` check must reject it before
        // `decode_slots` reserves the record array.
        let mut heap = Vec::new();
        heap.extend_from_slice(&u32::MAX.to_be_bytes()); // slot_count = u32::MAX
        heap.extend_from_slice(&0u32.to_be_bytes()); // free_count = 0
        heap.extend_from_slice(&0u32.to_be_bytes()); // live = 0
        let mut w = AtomWriter::new();
        w.atom(VERS, &Version::current().encode());
        w.atom(SIGN, &sig().encode());
        w.atom(HEAP, &heap);
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("HEAP records truncated"))
        );
    }

    #[test]
    fn malformed_stack_count_does_not_over_allocate() {
        // STAC claims u32::MAX slots but carries none.
        let mut stac = Vec::new();
        stac.extend_from_slice(&u32::MAX.to_be_bytes()); // count = u32::MAX
        let mut w = valid_prefix();
        w.atom(STAC, &stac);
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("STAC records truncated"))
        );
    }
}
