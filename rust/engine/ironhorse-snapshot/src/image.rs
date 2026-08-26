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
//! (`STAC`), the symbol/key tables (`NAME`/`KEYS`/`SYMB`), the
//! `VERS`/`SIGN`/`CREA` headers, and — since the G1 side-table ledger —
//! the arrays, collections, and `Symbol.for` registry tables
//! (`ARRY`/`COLL`/`REGY`, emitted only when non-empty so side-table-free
//! containers keep their exact prior bytes). The rich per-instance side
//! tables are enumerated in [`crate::sidetable`] with their coverage; the
//! ones marked `Pending` there are the remaining atoms.

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
        // Exact consumption: this decoder also reads the small state's
        // length-delimited meter section, where tolerated trailing
        // bytes would defeat the store decoders' fail-closed rule.
        if 28 + vlen != p.len() {
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

/// One array instance's serialized side-table row (the `ARRY` atom /
/// small-state arrays section): the owning slot, the spec `length`,
/// and the sparse items ascending by index. Values are ordinary slot
/// records — their slot/chunk references round-trip with the arenas,
/// and the full collector's chunk remap rewrites the live table, so a
/// quiescent image is always internally consistent.
#[derive(Clone, Debug, PartialEq)]
pub struct ArrayImage {
    pub owner: u32,
    pub length: u32,
    pub items: Vec<(u32, Slot)>,
}

/// One collection instance's serialized side-table row (the `COLL`
/// atom / small-state collections section): the owning slot, the
/// frozen kind code (0 Map, 1 Set, 2 WeakMap, 3 WeakSet), XS's
/// power-of-two hash-table length (metering geometry), and the
/// insertion-ordered entries. Set/WeakSet carry an undefined value
/// half, exactly as the live table does.
#[derive(Clone, Debug, PartialEq)]
pub struct CollectionImage {
    pub owner: u32,
    pub kind: u8,
    pub table_length: u32,
    pub entries: Vec<(Slot, Slot)>,
}

/// One `Symbol.for` registry entry (the `REGY` atom / small-state
/// registry section): the registration key's bytes and the symbol
/// descriptor's slot. Ascending by key bytes in serialized form.
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryImage {
    pub key: Vec<u8>,
    pub descriptor: u32,
}

/// The symbol-key property-id table (the `SYMB` atom / small-state
/// symbols section): the machine's top-down mint counter and every
/// `(id, descriptor slot)` pair, ascending by id. Symbol keys mint
/// DOWNWARD from `u16::MAX` (string keys — program symbols and
/// runtime-interned names alike — live in the NAME table, growing up
/// from 1), so persisting this table is what lets a heap holding
/// symbol-KEYED properties round-trip: the restored machine re-binds
/// each stored id to the same descriptor slot instead of re-minting
/// the number for a different symbol.
///
/// Wire form: the canonical EMPTY table (`next_id == u16::MAX`, no
/// pairs) encodes as the legacy 4-zero-byte empty list, byte-stable
/// with every blob and store written before the table traveled;
/// anything else encodes as `u16 next_id`, `u32 count`, then the
/// pairs (`u16 id`, `u32 desc`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolKeyImage {
    pub next_id: u16,
    pub pairs: Vec<(u16, u32)>,
}

impl Default for SymbolKeyImage {
    fn default() -> SymbolKeyImage {
        SymbolKeyImage {
            next_id: u16::MAX,
            pairs: Vec::new(),
        }
    }
}

impl SymbolKeyImage {
    /// The registered id set, for the stored-id audit.
    pub fn id_set(&self) -> std::collections::BTreeSet<u16> {
        self.pairs.iter().map(|&(id, _)| id).collect()
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
    /// `SYMB`: the symbol-key property-id table (see [`SymbolKeyImage`]).
    pub symbols: SymbolKeyImage,
    /// `METR`: the metering state (design row 6). A resumed machine
    /// continues its meter from exactly this point.
    pub meter: MeterImage,
    /// `ARRY`: the arrays side table (side-table ledger), owner-ascending.
    pub arrays: Vec<ArrayImage>,
    /// `COLL`: the collections side table (ledger), owner-ascending.
    pub collections: Vec<CollectionImage>,
    /// `REGY`: the `Symbol.for` registry (ledger), key-ascending.
    pub registry: Vec<RegistryImage>,
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
        symbols: SymbolKeyImage,
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
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
        }
    }

    /// The first stored property id that is registered in NEITHER table —
    /// not a `names` position (string keys live IN the table since the
    /// id-space unification) and not a `symbols` pair (the SYMB atom now
    /// carries every minted symbol-key id) — or `None` if every stored id
    /// resolves. The persist/adopt paths treat a hit as
    /// [`crate::store::StoreError::Corrupt`]: an unregistered id maps to
    /// nothing on resume, and honest minting cannot produce one, so it
    /// can only be torn or crafted bytes. Free slots are skipped — a
    /// stale record on the free list names nothing.
    ///
    /// Asking the IMAGE rather than the live machine's mint counter is
    /// what makes the answer survive a round trip: the counter is small
    /// state a resume restores verbatim, but a counter says only that
    /// minting HAPPENED, not that an id was stored (review wave 5's
    /// false-positive lesson) — and a crafted image lies about its
    /// counter anyway. The stored ids are the evidence.
    pub fn stored_unregistered_key_id(&self) -> Option<u16> {
        let registered = self.symbols.id_set();
        let free: std::collections::BTreeSet<u32> = self.slot_free.iter().copied().collect();
        let live = self
            .slots
            .iter()
            .enumerate()
            .filter(|(i, _)| !free.contains(&(*i as u32)))
            .map(|(_, s)| s);
        first_stored_unregistered_id(live.chain(self.stack.iter()), self.names.len(), &registered)
            .or_else(|| {
                first_stored_unregistered_id(
                    self.arrays.iter().flat_map(|a| a.items.iter().map(|(_, s)| s)),
                    self.names.len(),
                    &registered,
                )
            })
            .or_else(|| {
                first_stored_unregistered_id(
                    self.collections
                        .iter()
                        .flat_map(|c| c.entries.iter().flat_map(|(k, v)| [k, v])),
                    self.names.len(),
                    &registered,
                )
            })
    }

    /// Attach a metering state to this image (design row 6). The snapshot
    /// surface calls this with the live machine's [`MeterState`] so a
    /// resume continues the meter exactly.
    pub fn with_meter(mut self, meter: MeterState) -> MachineImage {
        self.meter = MeterImage::of(meter);
        self
    }

    /// Attach the bulk side tables and symbol registry (side-table
    /// ledger). The snapshot surface calls this with the live
    /// machine's `*_snapshot()` views, already in canonical order.
    pub fn with_side_tables(
        mut self,
        arrays: Vec<ArrayImage>,
        collections: Vec<CollectionImage>,
        registry: Vec<RegistryImage>,
    ) -> MachineImage {
        self.arrays = arrays;
        self.collections = collections;
        self.registry = registry;
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
        // checked_add: `len` is attacker-sized (a full u32), so on a
        // 32-bit usize `i + len` can wrap past the gate and panic at
        // the slice below instead of returning the structured error
        // (wave-3 finding; the `i + 4` advances elsewhere cannot wrap
        // because `i` never exceeds `p.len()`).
        let end = i
            .checked_add(len)
            .ok_or(SnapshotError::Corrupt("string list entry body"))?;
        if end > p.len() {
            return Err(SnapshotError::Corrupt("string list entry body"));
        }
        let s = std::str::from_utf8(&p[i..end])
            .map_err(|_| SnapshotError::Corrupt("string list entry not utf8"))?;
        out.push(s.to_string());
        i = end;
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
    // checked_mul, not `*`: on a 32-bit usize the product can wrap,
    // and a wrapped `want` would satisfy the truncation gate below
    // while `slot_count` stays attacker-sized — falsifying the bound
    // the `seen` scratch depends on (review finding; latent until a
    // 32-bit/wasm port, but the comment below claims the bound on
    // every target, so make it true on every target).
    let want = slot_count
        .checked_mul(SLOT_RECORD_BYTES)
        .ok_or(SnapshotError::Corrupt("HEAP record count"))?;
    if p.len() - i < want {
        return Err(SnapshotError::Corrupt("HEAP records truncated"));
    }
    // Semantic gates on the free list, matching the store path's
    // (`validate_store`): every index in range, no duplicates. An
    // out-of-range entry would panic the arena's free-bitmap rebuild
    // at construction (the snapshot_decoder fuzz target found that
    // panic within its first half-minute once the toolchain ran
    // locally), and a duplicate aliases one record to two allocations
    // after resume. Checked AFTER the records-truncation gate above,
    // which bounds `slot_count` by the payload length, so the `seen`
    // scratch cannot be attacker-sized.
    let mut seen = vec![false; slot_count];
    for &f in &free {
        if (f as usize) >= slot_count || seen[f as usize] {
            return Err(SnapshotError::Corrupt("HEAP free list entry"));
        }
        seen[f as usize] = true;
    }
    if free.len() as u64 + live as u64 != slot_count as u64 {
        return Err(SnapshotError::Corrupt("HEAP live/free accounting"));
    }
    let slots = decode_slots(&p[i..i + want]).map_err(|_| SnapshotError::Corrupt("HEAP slot record"))?;
    Ok((slots, free, live))
}

/// STAC payload: `[count][records…]`.
/// A bounds-checked big-endian cursor over an attacker-shaped payload:
/// every read is gated and every failure is the caller's named
/// [`SnapshotError::Corrupt`] — the side-table decoders below share the
/// string/u32 decoders' fuzz discipline through it.
struct Cursor<'a> {
    p: &'a [u8],
    i: usize,
    what: &'static str,
}

impl<'a> Cursor<'a> {
    fn new(p: &'a [u8], what: &'static str) -> Cursor<'a> {
        Cursor { p, i: 0, what }
    }
    fn u32(&mut self) -> Result<u32, SnapshotError> {
        if self.i + 4 > self.p.len() {
            return Err(SnapshotError::Corrupt(self.what));
        }
        let x = u32::from_be_bytes(self.p[self.i..self.i + 4].try_into().unwrap());
        self.i += 4;
        Ok(x)
    }
    fn u16(&mut self) -> Result<u16, SnapshotError> {
        if self.i + 2 > self.p.len() {
            return Err(SnapshotError::Corrupt(self.what));
        }
        let x = u16::from_be_bytes(self.p[self.i..self.i + 2].try_into().unwrap());
        self.i += 2;
        Ok(x)
    }
    fn u8(&mut self) -> Result<u8, SnapshotError> {
        if self.i >= self.p.len() {
            return Err(SnapshotError::Corrupt(self.what));
        }
        let x = self.p[self.i];
        self.i += 1;
        Ok(x)
    }
    fn bytes(&mut self, len: usize) -> Result<&'a [u8], SnapshotError> {
        // checked_add: `len` is attacker-sized, so `i + len` can wrap
        // on 32-bit targets (the wave-3 class the string decoder guards).
        let end = self
            .i
            .checked_add(len)
            .ok_or(SnapshotError::Corrupt(self.what))?;
        if end > self.p.len() {
            return Err(SnapshotError::Corrupt(self.what));
        }
        let b = &self.p[self.i..end];
        self.i = end;
        Ok(b)
    }
    fn slot(&mut self) -> Result<Slot, SnapshotError> {
        let b = self.bytes(crate::slot_codec::SLOT_RECORD_BYTES)?;
        crate::slot_codec::decode_slot(b).map_err(|_| SnapshotError::Corrupt(self.what))
    }
    fn done(&self) -> Result<(), SnapshotError> {
        if self.i != self.p.len() {
            return Err(SnapshotError::Corrupt(self.what));
        }
        Ok(())
    }
}

/// Encode the arrays side table (the `ARRY` payload / small-state
/// arrays section). Input is owner-ascending (the vm snapshot's
/// canonical order), items index-ascending.
pub(crate) fn encode_arrays(arrays: &[ArrayImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(arrays.len() as u32).to_be_bytes());
    for a in arrays {
        v.extend_from_slice(&a.owner.to_be_bytes());
        v.extend_from_slice(&a.length.to_be_bytes());
        v.extend_from_slice(&(a.items.len() as u32).to_be_bytes());
        for (index, value) in &a.items {
            v.extend_from_slice(&index.to_be_bytes());
            crate::slot_codec::encode_slot(value, &mut v);
        }
    }
    v
}

pub(crate) fn decode_arrays(p: &[u8]) -> Result<Vec<ArrayImage>, SnapshotError> {
    let mut c = Cursor::new(p, "arrays side table");
    let count = c.u32()? as usize;
    // Each array costs at least 12 header bytes; clamp the reservation
    // like the string/u32 decoders do.
    let mut out = Vec::with_capacity(count.min(p.len() / 12));
    for _ in 0..count {
        let owner = c.u32()?;
        let length = c.u32()?;
        let item_count = c.u32()? as usize;
        let mut items = Vec::with_capacity(item_count.min(p.len() / 24));
        let mut prev_index: Option<u32> = None;
        for _ in 0..item_count {
            let index = c.u32()?;
            let value = c.slot()?;
            // Strictly-ascending ITEM indices, for the same reason the
            // owner check below exists — one level deeper, which wave 4
            // missed. `restore_bulk_side_tables` inserts items into a
            // `BTreeMap`, so a crafted duplicate or out-of-order pair is
            // silently DEDUPED and RE-SORTED by a resume: items
            // [(1,10),(1,11)] come back as one item, and [(3,30),(1,10)]
            // come back reordered. Either way resume-then-re-snapshot
            // emits different bytes than it read, breaking the
            // import∘export identity the CAS key rests on.
            //
            // Note the plain `write_machine(read_machine(b))` round trip
            // IS idempotent for these, which is exactly why the wave-4
            // test missed it: the divergence only appears once the image
            // has passed through a live `Interp` (review wave 5).
            if prev_index.is_some_and(|prev| index <= prev) {
                return Err(SnapshotError::Corrupt(
                    "arrays side table: item indices not strictly ascending",
                ));
            }
            prev_index = Some(index);
            items.push((index, value));
        }
        // The declared `length` must actually cover the items. An item
        // at or past it is a wrong answer twice over: `arr[last]` reads
        // a value that `arr.length` says is not there, and a resume
        // re-emitting the row would have to either drop the item or
        // silently grow the length, so import∘export stops being the
        // identity the CAS key rests on (review wave 5).
        //
        // What is deliberately NOT checked here is `length` itself. A
        // sparse array is ordinary JS state, so a row declaring a huge
        // length with one item is a faithful image, and a decoder that
        // refused it would refuse correct snapshots. The reason that
        // used to be dangerous — `ironhorse-vm`'s TypedArray-from-source
        // path collecting `0..length` before its bound check and its
        // metering, so a ~7.5 KB container declaring length 200_000_000
        // reserved gigabytes of slots off a tiny input — is a defect of
        // that consumer, and is fixed and locked there
        // (`ironhorse-vm/tests/typed_array_source_length.rs`).
        //
        // Bounding the LAST index bounds the row: the indices are already
        // strictly ascending, so `last < length` gives every index a
        // distinct value below `length`, hence `item_count <= length` with
        // no separate count check. (A count check was written first and
        // bite-checking found it unreachable behind these two.)
        if let Some(last) = prev_index {
            if last >= length {
                return Err(SnapshotError::Corrupt(
                    "arrays side table: item index at or past the declared length",
                ));
            }
        }
        // Strictly-ascending owners (wave-4 P2): the writer emits them
        // owner-sorted and unique (one row per instance). Enforcing it
        // at decode rejects a crafted duplicate — whose restore would
        // displace the first row's `ArrayData` WITHOUT decrementing its
        // side-ref counts (a parity-net panic / release over-pin) — and
        // makes `import ∘ export` idempotent (the dedup-and-re-sort a
        // crafted unordered image would otherwise survive).
        if out.last().is_some_and(|prev: &ArrayImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt("arrays side table: owners not strictly ascending"));
        }
        out.push(ArrayImage {
            owner,
            length,
            items,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the collections side table (the `COLL` payload /
/// small-state collections section).
pub(crate) fn encode_collections(collections: &[CollectionImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(collections.len() as u32).to_be_bytes());
    for coll in collections {
        v.extend_from_slice(&coll.owner.to_be_bytes());
        v.push(coll.kind);
        v.extend_from_slice(&coll.table_length.to_be_bytes());
        v.extend_from_slice(&(coll.entries.len() as u32).to_be_bytes());
        for (key, value) in &coll.entries {
            crate::slot_codec::encode_slot(key, &mut v);
            crate::slot_codec::encode_slot(value, &mut v);
        }
    }
    v
}

pub(crate) fn decode_collections(p: &[u8]) -> Result<Vec<CollectionImage>, SnapshotError> {
    let mut c = Cursor::new(p, "collections side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 13));
    for _ in 0..count {
        let owner = c.u32()?;
        let kind = c.u8()?;
        if kind > 3 {
            return Err(SnapshotError::Corrupt("collection kind code"));
        }
        let table_length = c.u32()?;
        let entry_count = c.u32()? as usize;
        let mut entries = Vec::with_capacity(entry_count.min(p.len() / 40));
        for _ in 0..entry_count {
            let key = c.slot()?;
            let value = c.slot()?;
            entries.push((key, value));
        }
        // Strictly-ascending owners — same rationale as `decode_arrays`.
        if out.last().is_some_and(|prev: &CollectionImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "collections side table: owners not strictly ascending",
            ));
        }
        out.push(CollectionImage {
            owner,
            kind,
            table_length,
            entries,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the `Symbol.for` registry (the `REGY` payload / small-state
/// registry section).
/// Encode the symbol-key table (the `SYMB` payload / small-state
/// symbols section). See [`SymbolKeyImage`] for the wire form and the
/// legacy-empty byte-stability rule.
pub(crate) fn encode_symbol_keys(symbols: &SymbolKeyImage) -> Vec<u8> {
    if symbols.next_id == u16::MAX && symbols.pairs.is_empty() {
        // Canonical empty: the legacy empty-u32-list bytes, so every
        // pre-table blob and store stays byte-identical.
        return vec![0, 0, 0, 0];
    }
    let mut v = Vec::with_capacity(6 + symbols.pairs.len() * 6);
    v.extend_from_slice(&symbols.next_id.to_be_bytes());
    v.extend_from_slice(&(symbols.pairs.len() as u32).to_be_bytes());
    for &(id, desc) in &symbols.pairs {
        v.extend_from_slice(&id.to_be_bytes());
        v.extend_from_slice(&desc.to_be_bytes());
    }
    v
}

pub(crate) fn decode_symbol_keys(p: &[u8]) -> Result<SymbolKeyImage, SnapshotError> {
    if p == [0, 0, 0, 0] {
        return Ok(SymbolKeyImage::default());
    }
    let mut c = Cursor::new(p, "symbol-key table");
    let next_id = c.u16()?;
    // `next_id == u16::MAX` means nothing was ever minted, and that
    // state has exactly one canonical encoding — the 4-byte legacy
    // empty accepted above (every pair would fail `id <= next_id`, so
    // a new-format payload claiming it can only be the redundant
    // empty). Accepting it would break the import∘export byte
    // identity the sibling decoders enforce by rejecting their
    // non-canonical forms.
    if next_id == u16::MAX {
        return Err(SnapshotError::Corrupt(
            "symbol-key table: non-canonical empty (legacy encoding required)",
        ));
    }
    let count = c.u32()? as usize;
    let mut pairs = Vec::with_capacity(count.min(p.len() / 6));
    let mut prev: Option<u16> = None;
    let mut descs = std::collections::BTreeSet::new();
    for _ in 0..count {
        let id = c.u16()?;
        let desc = c.u32()?;
        // Every minted id is above the counter (top-down mints), and
        // strictly-ascending unique ids + pairwise-distinct descriptors
        // keep the id→symbol map a bijection and the encoding
        // canonical — a crafted duplicate would displace a binding at
        // restore and break import∘export identity, the same class the
        // sibling decoders refuse.
        if id <= next_id || prev.is_some_and(|prev_id| id <= prev_id) {
            return Err(SnapshotError::Corrupt(
                "symbol-key table: ids not strictly ascending above the counter",
            ));
        }
        if !descs.insert(desc) {
            return Err(SnapshotError::Corrupt(
                "symbol-key table: two ids share a descriptor",
            ));
        }
        prev = Some(id);
        pairs.push((id, desc));
    }
    c.done()?;
    Ok(SymbolKeyImage { next_id, pairs })
}

pub(crate) fn encode_registry(registry: &[RegistryImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(registry.len() as u32).to_be_bytes());
    for e in registry {
        v.extend_from_slice(&(e.key.len() as u32).to_be_bytes());
        v.extend_from_slice(&e.key);
        v.extend_from_slice(&e.descriptor.to_be_bytes());
    }
    v
}

pub(crate) fn decode_registry(p: &[u8]) -> Result<Vec<RegistryImage>, SnapshotError> {
    let mut c = Cursor::new(p, "symbol registry");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 8));
    for _ in 0..count {
        let key_len = c.u32()? as usize;
        let key = c.bytes(key_len)?.to_vec();
        let descriptor = c.u32()?;
        // Strictly-ascending, unique keys (the writer sorts by key
        // bytes): a crafted duplicate/unordered registry would
        // otherwise not round-trip byte-identically and could displace
        // a forward/reverse map entry at restore.
        if out.last().is_some_and(|prev: &RegistryImage| key <= prev.key) {
            return Err(SnapshotError::Corrupt(
                "symbol registry: keys not strictly ascending",
            ));
        }
        // DESCRIPTORS must be distinct too. Ascending KEYS say nothing
        // about the reverse map: restore fills forward (key -> desc) and
        // reverse (desc -> key) pairwise, last-writer-wins on the
        // reverse, so two rows sharing a descriptor make
        // `Symbol.for('aaa') === Symbol.for('bbb')` TRUE and leave
        // `Symbol.keyFor` answering the wrong key. Both indices are in
        // bounds and the registry is a GC root, so nothing downstream
        // catches it — it is a silent spec break, not a crash (review
        // wave 5). Linear scan: one row per registered symbol, decoded
        // once at an untrusted boundary, where clarity beats a hash set.
        if out
            .iter()
            .any(|prev: &RegistryImage| prev.descriptor == descriptor)
        {
            return Err(SnapshotError::Corrupt(
                "symbol registry: two keys share a descriptor",
            ));
        }
        out.push(RegistryImage { key, descriptor });
    }
    c.done()?;
    Ok(out)
}

/// Every slot index and chunk offset a decoded image can carry, checked
/// against the geometry the image itself declares.
///
/// This is the SEMANTIC gate the byte-level decoders lack: a crafted
/// index is rooted or walked by the collector and hits an unchecked
/// `Vec` index — a RELEASE panic on the first `collect_garbage`. Wave 4
/// closed only the three side tables; review wave 5 showed the class is
/// wider, and that the narrow version missed containers with NO side
/// table at all (a 238-byte container panicked at `value.rs`'s
/// `marks[i]`). So the walk now covers, against `slot_count`:
///
/// - every `HEAP` slot's `next` link and `Reference` payload,
/// - every `STAC` slot's ditto,
/// - side-table owners, array item values, collection entry keys AND
///   values, and registry descriptors;
///
/// and, against `chunk_len`, every `String`/`BigInt` chunk offset on any
/// of those slots — invisible to `each_ref_slot`, and reachable at
/// compaction from a side table even when the owner is DEAD, because
/// `external_chunk_refs` walks the tables unconditionally.
///
/// `SlotIndex::NULL` is skipped, matching `SideRefCounts::page_of`: a
/// null reference is an absence, not an out-of-arena index, and scoring
/// it as one would refuse honest images.
///
/// `heap` is empty on the store path, where rows are not read at
/// validation time; those records are bounds-checked as they fault
/// ([`crate::machine`]'s page source).
/// The chunk arena's per-payload header width (`value.rs`'s private
/// `CHUNK_HEADER`). A payload offset always sits this far above its
/// header, which is why `0` is not a valid offset.
const CHUNK_HEADER: usize = 4;

/// The lowest property id that would be RUNTIME-INTERNED on a machine
/// whose program symbol table holds `program_names` names — ids are
/// 1-based table positions, so everything past the table was minted at
/// runtime.
///
/// `None` for an EMPTY table, which is not "everything is interned" but
/// its opposite: an unlinked machine runs raw bytecode whose ID operands
/// are positions in a table that does not exist, so its ids carry no
/// name mapping in the first place. There is nothing for a resume to
/// lose, and a resumed machine re-reads the same operands the same way.
/// (A machine that both stays unlinked AND interns would collide its
/// minted ids with those operands, but that is an engine hazard in raw
/// mode, not a persistence one, and it is not what this gate is about.)
pub fn runtime_intern_floor(program_names: usize) -> Option<u16> {
    (program_names > 0).then(|| (program_names as u16).saturating_add(1))
}

/// The first UNREGISTERED property id stored anywhere in `slots` — an
/// id past the `program_names` name-table positions that the
/// `registered` symbol-key id set does not carry — or `None`.
///
/// Since the id-space unification, every string key lives IN the name
/// table and every symbol key the machine minted is in its symbol-key
/// table, so a stored id outside both maps to nothing: it can only
/// come from crafted or torn bytes, and restoring it would leave a
/// property no lookup can ever name. The audit refuses it as corrupt.
pub fn first_stored_unregistered_id<'a, I>(
    slots: I,
    program_names: usize,
    registered: &std::collections::BTreeSet<u16>,
) -> Option<u16>
where
    I: IntoIterator<Item = &'a Slot>,
{
    let floor = runtime_intern_floor(program_names)?;
    slots
        .into_iter()
        .find_map(|s| s.stored_key_id().filter(|&id| id >= floor && !registered.contains(&id)))
}

/// `SYMB` joined this walk when the symbol-key table became live
/// state (it was deliberately excluded while nothing consumed the
/// section on restore — review wave 5): each pair's descriptor is a
/// slot index the restored machine will use as a property-key
/// identity, so an out-of-arena descriptor is refused with the same
/// closed fist as every other crafted index.
pub(crate) fn check_image_slot_bounds(
    heap: &[Slot],
    stack: &[Slot],
    arrays: &[ArrayImage],
    collections: &[CollectionImage],
    registry: &[RegistryImage],
    symbols: &SymbolKeyImage,
    slot_count: u32,
    chunk_len: usize,
) -> Result<(), SnapshotError> {
    const OOB: SnapshotError = SnapshotError::Corrupt("slot index out of arena bounds");
    const OOC: SnapshotError = SnapshotError::Corrupt("chunk offset out of arena bounds");
    let check = |s: &Slot| -> Result<(), SnapshotError> {
        let mut bad = false;
        s.each_ref_slot(|r| bad |= !r.is_null() && r.0 >= slot_count);
        if bad {
            return Err(OOB);
        }
        if let Some(off) = s.chunk_ref() {
            if !off.is_null() {
                let o = off.0 as usize;
                // A payload offset sits ABOVE its 4-byte header and the
                // header must lie inside the arena — the two asserts
                // `ChunkArena::compact` would otherwise hit.
                if o < CHUNK_HEADER || o > chunk_len {
                    return Err(OOC);
                }
            }
        }
        Ok(())
    };
    for s in heap.iter().chain(stack) {
        check(s)?;
    }
    for a in arrays {
        if a.owner >= slot_count {
            return Err(OOB);
        }
        for (_, v) in &a.items {
            check(v)?;
        }
    }
    for coll in collections {
        if coll.owner >= slot_count {
            return Err(OOB);
        }
        for (k, v) in &coll.entries {
            check(k)?;
            check(v)?;
        }
    }
    for e in registry {
        if e.descriptor >= slot_count {
            return Err(OOB);
        }
    }
    for &(_, desc) in &symbols.pairs {
        if desc >= slot_count {
            return Err(OOB);
        }
    }
    Ok(())
}

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
    // checked_mul for the same reason as `decode_heap`'s twin gate: on
    // a 32-bit usize the product can wrap to a small `want` that
    // satisfies the truncation gate below, silently short-decoding the
    // stack (wave-3 finding — the decode_heap fix was not mirrored
    // here; latent until a 32-bit/wasm port, closed on every target).
    let want = count
        .checked_mul(SLOT_RECORD_BYTES)
        .ok_or(SnapshotError::Corrupt("STAC record count"))?;
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
    w.atom(SYMB, &encode_symbol_keys(&image.symbols));
    w.atom(METR, &image.meter.encode());
    // Side-table ledger atoms, emitted ONLY when non-empty: a machine
    // with no side-table state keeps its exact pre-ledger container
    // bytes, so the CAS/blob identity of every existing container —
    // the golden-vector pin included — is unchanged by the ledger.
    // Presence is content-determined, so the canonical-bytes property
    // (same image → same bytes) holds either way.
    if !image.arrays.is_empty() {
        w.atom(crate::format::ARRY, &encode_arrays(&image.arrays));
    }
    if !image.collections.is_empty() {
        w.atom(crate::format::COLL, &encode_collections(&image.collections));
    }
    if !image.registry.is_empty() {
        w.atom(crate::format::REGY, &encode_registry(&image.registry));
    }
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
        Some(a) => decode_symbol_keys(a.payload)?,
        None => SymbolKeyImage::default(),
    };
    // The symbol-key counter must clear the name table (its ids mint
    // DOWNWARD from u16::MAX; a counter at or below the table would
    // alias a symbol id onto a string key at restore — see
    // `Interp::restore_symbol_key_table`). Checked here where names
    // and symbols are both in hand; `validate_store` mirrors it for
    // the store path.
    if (symbols.next_id as usize) <= names.len() {
        return Err(SnapshotError::Corrupt(
            "symbol-key table: counter inside the name table",
        ));
    }

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

    // Side-table ledger atoms: absent means empty (a pre-ledger or
    // side-table-free container), exactly mirroring the writer's
    // emit-only-when-non-empty rule.
    let arrays = match r.find(crate::format::ARRY) {
        Some(a) => decode_arrays(a.payload)?,
        None => Vec::new(),
    };
    let collections = match r.find(crate::format::COLL) {
        Some(a) => decode_collections(a.payload)?,
        None => Vec::new(),
    };
    let registry = match r.find(crate::format::REGY) {
        Some(a) => decode_registry(a.payload)?,
        None => Vec::new(),
    };
    // Semantic bounds gate (wave-4 P1, widened in wave 5): every slot
    // index and chunk offset the container carries — heap, stack,
    // symbols and side tables alike — must fall inside the decoded
    // arenas, or the collector would index them out of range in
    // release.
    check_image_slot_bounds(
        &slots,
        &stack,
        &arrays,
        &collections,
        &registry,
        &symbols,
        slots.len() as u32,
        chunks.len(),
    )?;

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
        arrays,
        collections,
        registry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::{ChunkOffset, Kind, Payload, SlotIndex};

    fn sig() -> Signature {
        Signature::new("ironhorse-test-sig-v1")
    }

    #[test]
    fn decode_rejects_non_ascending_side_table_owners() {
        // A crafted ARRY with two rows for the same owner: restore
        // would displace the first `ArrayData` without decrementing its
        // side-ref counts (wave-4 P2). Decode must reject it.
        let dup = vec![
            ArrayImage { owner: 3, length: 0, items: vec![] },
            ArrayImage { owner: 3, length: 0, items: vec![] },
        ];
        assert!(matches!(
            decode_arrays(&encode_arrays(&dup)),
            Err(SnapshotError::Corrupt(_))
        ));
        // Unordered (would break import∘export idempotency / CAS).
        let unordered = vec![
            CollectionImage { owner: 5, kind: 0, table_length: 0, entries: vec![] },
            CollectionImage { owner: 2, kind: 0, table_length: 0, entries: vec![] },
        ];
        assert!(matches!(
            decode_collections(&encode_collections(&unordered)),
            Err(SnapshotError::Corrupt(_))
        ));
        let dup_key = vec![
            RegistryImage { key: b"k".to_vec(), descriptor: 1 },
            RegistryImage { key: b"k".to_vec(), descriptor: 2 },
        ];
        assert!(matches!(
            decode_registry(&encode_registry(&dup_key)),
            Err(SnapshotError::Corrupt(_))
        ));
        // The ascending forms decode fine.
        let ok = vec![
            ArrayImage { owner: 2, length: 0, items: vec![] },
            ArrayImage { owner: 5, length: 0, items: vec![] },
        ];
        assert_eq!(decode_arrays(&encode_arrays(&ok)).unwrap(), ok);
    }

    #[test]
    fn image_bounds_reject_out_of_arena_indices() {
        // Wave 4 closed the three side tables; wave 5 showed the class is
        // wider — a container with NO side table at all panicked the
        // collector via an unchecked `marks[i]`. Each arm below is a
        // shape a reviewer actually crafted and reached a release panic
        // (or an abort) with. slot_count = 4, chunk_len = 64 throughout.
        let ok = |heap: &[Slot], stack: &[Slot]| {
            check_image_slot_bounds(heap, stack, &[], &[], &[], &SymbolKeyImage::default(), 4, 64)
        };
        let refd = |i: u32| Slot::of(Kind::Reference, Payload::Reference(SlotIndex(i)));

        // --- the wave-5 additions: heap, next, stack, symbols, chunks ---
        assert!(ok(&[refd(9)], &[]).is_err(), "heap Reference past the arena");
        let mut chained = Slot::undefined();
        chained.next = SlotIndex(9);
        assert!(ok(&[chained], &[]).is_err(), "heap `next` past the arena");
        assert!(ok(&[], &[refd(9)]).is_err(), "stack Reference past the arena");
        let bad_chunk = Slot::of(Kind::String, Payload::String(ChunkOffset(0xFFFF_0000)));
        assert!(ok(&[bad_chunk], &[]).is_err(), "chunk offset past the arena");
        let below_header = Slot::of(Kind::String, Payload::String(ChunkOffset(0)));
        assert!(ok(&[below_header], &[]).is_err(), "chunk offset below the header");

        // --- the wave-4 arms, still enforced ---
        let bad_desc = [RegistryImage { key: b"k".to_vec(), descriptor: 9 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &bad_desc, &SymbolKeyImage::default(), 4, 64).is_err());
        // A symbol-key descriptor beyond the arena is refused the same way.
        let bad_sym = SymbolKeyImage {
            next_id: u16::MAX - 1,
            pairs: vec![(u16::MAX, 4)],
        };
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &bad_sym, 4, 64).is_err());
        let bad_owner = [ArrayImage { owner: 9, length: 0, items: vec![] }];
        assert!(check_image_slot_bounds(&[], &[], &bad_owner, &[], &[], &SymbolKeyImage::default(), 4, 64).is_err());
        let bad_ref = [ArrayImage { owner: 1, length: 1, items: vec![(0, refd(9))] }];
        assert!(check_image_slot_bounds(&[], &[], &bad_ref, &[], &[], &SymbolKeyImage::default(), 4, 64).is_err());
        // Collections were passed `&[]` in every wave-4 case, so that
        // whole branch never executed (wave 5, llvm-cov). Exercise both
        // the key and the value side.
        let bad_key = [CollectionImage {
            owner: 1,
            kind: 0,
            table_length: 0,
            entries: vec![(refd(9), Slot::undefined())],
        }];
        assert!(check_image_slot_bounds(&[], &[], &[], &bad_key, &[], &SymbolKeyImage::default(), 4, 64).is_err());
        let bad_val = [CollectionImage {
            owner: 1,
            kind: 0,
            table_length: 0,
            entries: vec![(Slot::undefined(), refd(9))],
        }];
        assert!(check_image_slot_bounds(&[], &[], &[], &bad_val, &[], &SymbolKeyImage::default(), 4, 64).is_err());

        // --- in-bounds and NULL pass ---
        assert!(ok(&[refd(3)], &[refd(0)]).is_ok(), "in-bounds indices pass");
        assert!(
            ok(&[refd(SlotIndex::NULL.0)], &[]).is_ok(),
            "a NULL reference is an absence, not an out-of-arena index",
        );
        let good_chunk = Slot::of(Kind::String, Payload::String(ChunkOffset(8)));
        assert!(ok(&[good_chunk], &[]).is_ok(), "an in-range chunk offset passes");
    }

    /// Review wave 5: the declared `length` must cover the row's items.
    ///
    /// Note what this does NOT do: it does not bound `length` itself. A
    /// sparse array is ordinary JS state (`a[0] = 7; a.length = 2e8`), so
    /// a row declaring a huge length with one item is a faithful image
    /// and a decoder must accept it. The reason that used to be
    /// dangerous — a restore materializing `0..length` before any bound
    /// check or metering — is a defect of the CONSUMER, and is fixed
    /// where it lives, in `ironhorse-vm`'s TypedArray-from-source path.
    #[test]
    fn decode_rejects_items_outside_the_declared_length() {
        let v = |n: i32| Slot::of(Kind::Integer, Payload::Integer(n));
        // More items than the length can hold — caught, like the case
        // below, by bounding the last index: ascending indices under
        // `length` cannot outnumber it.
        let overfull = vec![ArrayImage { owner: 1, length: 1, items: vec![(0, v(7)), (1, v(8))] }];
        assert!(matches!(
            decode_arrays(&encode_arrays(&overfull)),
            Err(SnapshotError::Corrupt(_)),
        ));
        // A single item sitting AT or PAST the declared length.
        let past = vec![ArrayImage { owner: 1, length: 2, items: vec![(2, v(7))] }];
        assert!(matches!(
            decode_arrays(&encode_arrays(&past)),
            Err(SnapshotError::Corrupt(_)),
        ));
        // A dense, honest row still decodes.
        let ok = vec![ArrayImage { owner: 1, length: 2, items: vec![(0, v(7)), (1, v(8))] }];
        assert_eq!(decode_arrays(&encode_arrays(&ok)).unwrap(), ok);
        // And a SPARSE row does too — the guard bounds the items, it does
        // not require density. Including the extreme: this is exactly
        // `a[0] = 7; a.length = 2e8`, and refusing it would refuse a
        // correct snapshot.
        let sparse = vec![ArrayImage { owner: 1, length: 9, items: vec![(0, v(7)), (8, v(8))] }];
        assert_eq!(decode_arrays(&encode_arrays(&sparse)).unwrap(), sparse);
        let huge = vec![ArrayImage { owner: 1, length: 200_000_000, items: vec![(0, v(7))] }];
        assert_eq!(decode_arrays(&encode_arrays(&huge)).unwrap(), huge);
    }

    #[test]
    fn decode_rejects_non_ascending_array_item_indices() {
        let v = |n: i32| Slot::of(Kind::Integer, Payload::Integer(n));
        // Restore inserts items into a BTreeMap, so a duplicate is
        // silently DEDUPED and an out-of-order pair RE-SORTED — a resume
        // then re-emits different bytes than it read, breaking the
        // import-export identity the CAS key rests on. Note the plain
        // write(read(b)) round trip IS idempotent for these, which is
        // why only a live-Interp round trip exposes it.
        let dup = vec![ArrayImage { owner: 1, length: 4, items: vec![(1, v(10)), (1, v(11))] }];
        assert!(matches!(
            decode_arrays(&encode_arrays(&dup)),
            Err(SnapshotError::Corrupt(_)),
        ));
        let unordered = vec![ArrayImage { owner: 1, length: 4, items: vec![(3, v(30)), (1, v(10))] }];
        assert!(matches!(
            decode_arrays(&encode_arrays(&unordered)),
            Err(SnapshotError::Corrupt(_)),
        ));
    }

    #[test]
    fn decode_rejects_a_registry_whose_keys_share_a_descriptor() {
        // Ascending KEYS say nothing about the REVERSE map. Two rows
        // sharing a descriptor make `Symbol.for('aaa') === Symbol.for('bbb')`
        // true and leave `Symbol.keyFor` answering the wrong key — both
        // indices in bounds, registry rooted, nothing downstream catches
        // it.
        let shared = vec![
            RegistryImage { key: b"aaa".to_vec(), descriptor: 3 },
            RegistryImage { key: b"bbb".to_vec(), descriptor: 3 },
        ];
        assert!(matches!(
            decode_registry(&encode_registry(&shared)),
            Err(SnapshotError::Corrupt(_)),
        ));
        // Distinct descriptors decode fine.
        let ok = vec![
            RegistryImage { key: b"aaa".to_vec(), descriptor: 3 },
            RegistryImage { key: b"bbb".to_vec(), descriptor: 4 },
        ];
        assert_eq!(decode_registry(&encode_registry(&ok)).unwrap(), ok);
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
            symbols: SymbolKeyImage::default(),
            meter: MeterImage::current(),
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
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
            symbols: SymbolKeyImage::default(),
            meter: MeterImage::current(),
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
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
            SymbolKeyImage {
                next_id: u16::MAX - 2,
                pairs: vec![(u16::MAX - 1, 0), (u16::MAX, 1)],
            },
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
            symbols: SymbolKeyImage {
                next_id: u16::MAX - 1,
                pairs: vec![(u16::MAX, 0)],
            },
            meter: MeterImage::current(),
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
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
            SymbolKeyImage::default(),
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
    fn non_canonical_empty_symbol_table_is_rejected() {
        // The empty table has ONE encoding (the 4-byte legacy zeros);
        // a new-format payload with next_id == u16::MAX could only be
        // the same empty state spelled differently, and re-encoding it
        // would emit the legacy bytes — breaking import∘export
        // identity. The decoder refuses it like every other
        // non-canonical form.
        let crafted = [0xFF, 0xFF, 0, 0, 0, 0];
        assert_eq!(
            decode_symbol_keys(&crafted),
            Err(SnapshotError::Corrupt(
                "symbol-key table: non-canonical empty (legacy encoding required)"
            ))
        );
        // The canonical legacy empty still round-trips byte-exactly.
        let empty = decode_symbol_keys(&[0, 0, 0, 0]).unwrap();
        assert_eq!(empty, SymbolKeyImage::default());
        assert_eq!(encode_symbol_keys(&empty), vec![0, 0, 0, 0]);
    }

    #[test]
    fn malformed_u32_count_does_not_over_allocate() {
        // SYMB claims a huge pair count but carries none: the cursor
        // refuses at the first missing pair instead of pre-allocating
        // for the claimed count. (next_id = 1 keeps the payload past
        // the non-canonical-empty gate so the count path is what's
        // exercised.)
        let mut payload = vec![0u8, 1];
        payload.extend_from_slice(&u32::MAX.to_be_bytes());
        let mut w = valid_prefix();
        w.atom(SYMB, &payload);
        let bytes = w.finish();
        assert_eq!(
            read_machine(&bytes, &sig()),
            Err(SnapshotError::Corrupt("symbol-key table"))
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
    fn heap_free_list_semantic_gates_fail_closed() {
        // Fuzz trophy (snapshot_decoder, first local run): an
        // out-of-range free index panicked the arena's free-bitmap
        // rebuild at construction. The decoder now refuses range,
        // duplicate, and accounting violations — same gates as the
        // store path.
        let record = [0u8; SLOT_RECORD_BYTES]; // one Undefined record
        let arm = |free: &[u32], live: u32, slot_count: u32, what: &'static str| {
            let mut heap = Vec::new();
            heap.extend_from_slice(&slot_count.to_be_bytes());
            heap.extend_from_slice(&(free.len() as u32).to_be_bytes());
            heap.extend_from_slice(&live.to_be_bytes());
            for f in free {
                heap.extend_from_slice(&f.to_be_bytes());
            }
            for _ in 0..slot_count {
                heap.extend_from_slice(&record);
            }
            let mut w = AtomWriter::new();
            w.atom(VERS, &Version::current().encode());
            w.atom(SIGN, &sig().encode());
            w.atom(HEAP, &heap);
            assert_eq!(
                read_machine(&w.finish(), &sig()),
                Err(SnapshotError::Corrupt(what)),
                "free={free:?} live={live} slot_count={slot_count}"
            );
        };
        // Out of range.
        arm(&[7], 0, 1, "HEAP free list entry");
        // Duplicate.
        arm(&[0, 0], 0, 2, "HEAP free list entry");
        // Accounting: free + live != slot_count.
        arm(&[], 5, 1, "HEAP live/free accounting");
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
