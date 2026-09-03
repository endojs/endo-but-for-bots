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
use ironhorse_vm::{
    dtf_component_key_static, ChunkArena, CollatorData, DateTimeFormatData, IntlTables,
    IteratorRow, Kind, ListFormatData, LocaleData, MeterState, NumberFormatData, Payload,
    PluralRulesData, SegmentIteratorData, SegmenterData, SegmentsData, Slot, SlotArena,
    COST_TABLE_VERSION,
};

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

/// One Error instance's serialized side-table row (the `ERRD` atom /
/// small-state errors section): the owning slot, the construction-time
/// constructor name, and the optional recorded message — exactly what
/// the abort-value render consults, so a resumed `throw e` stringifies
/// as `name` / `name: message` like the uninterrupted machine's.
/// Ascending by owner in serialized form; the name is drawn from the
/// engine's closed error-constructor set
/// ([`ironhorse_vm::error_name_static`]).
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorImage {
    pub owner: u32,
    pub name: String,
    pub message: Option<String>,
    /// The call-frame names captured when the error was CONSTRUCTED,
    /// which the `stack` accessor renders as `\n at <name> ()` lines.
    /// They must travel: the constructing call stack is gone by the
    /// time a resume happens, so nothing can rebuild them, and a
    /// resumed `e.stack` that drops them diverges silently (measured:
    /// `"Error: boom\n at inner ()\n at ()"` became `"Error: boom"`).
    /// Encoded in the SEPARATE `ESTK` atom, not in this row.
    pub frames: Vec<String>,
}

/// One `ArrayBuffer` instance's serialized side-table row (the `ABUF`
/// atom / small-state buffers section): the owning slot, the backing
/// store's chunk offset (the bytes themselves travel with the chunk
/// arena in `BLOC`), the byte length, and the brand flags (bit 0 =
/// detached, bit 1 = shared; all other bits refused). Ascending by
/// owner in serialized form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BufferImage {
    pub owner: u32,
    pub data: u32,
    pub length: u32,
    pub flags: u8,
}

/// One TypedArray instance's serialized side-table row (the `TARR`
/// atom / small-state typed-arrays section): the owning slot, the
/// element kind (an index into `ironhorse_vm::TYPED_ARRAY_TYPES`,
/// refused past it), the backing buffer's slot, the byte offset, and
/// the element length. Ascending by owner in serialized form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypedArrayImage {
    pub owner: u32,
    pub kind: u8,
    pub buffer: u32,
    pub offset: u32,
    pub length: u32,
}

/// One DataView instance's serialized side-table row (the `DVIW` atom
/// / small-state data-views section): the owning slot, the backing
/// buffer's slot, the byte offset, and the byte length. Ascending by
/// owner in serialized form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataViewImage {
    pub owner: u32,
    pub buffer: u32,
    pub offset: u32,
    pub size: u32,
}

/// One primitive wrapper's serialized side-table row (the `WRAP` atom /
/// small-state wrappers section): the owning slot and the boxed value —
/// an ordinary [`Slot`], so its chunk reference (a boxed String) rides
/// the arenas and joins the bounds walk. Ascending by owner.
#[derive(Clone, Debug, PartialEq)]
pub struct WrapperImage {
    pub owner: u32,
    pub value: Slot,
}

/// One RegExp instance's serialized side-table row (the `REGX` atom /
/// small-state regexps section): the owning slot, pattern source, flags, and
/// the legacy schema-11 numeric `lastIndex` fallback. Current snapshots carry
/// the authoritative arbitrary-valued property and its attributes in HEAP;
/// the fallback keeps older stores readable. The compiled program does not
/// travel — restore recompiles it from `(source, flags)`. Ascending by owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegExpImage {
    pub owner: u32,
    pub source: String,
    pub flags: String,
    pub last_index_bits: u64,
}

/// One Date instance's serialized `[[DateValue]]`: owning slot and raw
/// IEEE-754 bits. Raw bits preserve invalid dates and negative zero exactly.
/// Ascending by owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateImage {
    pub owner: u32,
    pub value_bits: u64,
}

/// The four Temporal record tables (the `TMPR` atom / small-state
/// temporal section), each ascending by owner. Pure numeric/string
/// data — no slot references beyond the weak owners.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TemporalImage {
    /// `(owner, epochNanoseconds)`.
    pub instants: Vec<(u32, i128)>,
    /// `(owner, the ten duration fields)`.
    pub durations: Vec<(u32, [i64; 10])>,
    /// `(owner, kind 0..=4, year, [month, day, hour, minute, second,
    /// ms, µs, ns])`.
    pub plains: Vec<(u32, u8, i64, [u32; 8])>,
    /// `(owner, epochNanoseconds, timeZone, offsetNs)`.
    pub zoneds: Vec<(u32, i128, String, i64)>,
}

impl TemporalImage {
    pub fn is_empty(&self) -> bool {
        self.instants.is_empty()
            && self.durations.is_empty()
            && self.plains.is_empty()
            && self.zoneds.is_empty()
    }
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
    /// `ERRD`: the error-data side table (ledger), owner-ascending.
    pub errors: Vec<ErrorImage>,
    /// `ABUF`: the array-buffers side table (ledger), owner-ascending.
    pub buffers: Vec<BufferImage>,
    /// `TARR`: the typed-arrays side table (ledger), owner-ascending.
    pub typed_arrays: Vec<TypedArrayImage>,
    /// `DVIW`: the data-views side table (ledger), owner-ascending.
    pub data_views: Vec<DataViewImage>,
    /// `WRAP`: the primitive-wrapper side table (ledger), owner-ascending.
    pub wrappers: Vec<WrapperImage>,
    /// `REGX`: the regexp side table (ledger), owner-ascending.
    pub regexps: Vec<RegExpImage>,
    /// `DATE`: Date `[[DateValue]]` records, owner-ascending.
    pub dates: Vec<DateImage>,
    /// `FUNC`: retained guest-callability state.
    pub function_state: ironhorse_vm::FunctionStateSnapshot,
    /// `PROX`: Proxy internal slots and revoker links.
    pub proxy_state: ironhorse_vm::ProxyStateSnapshot,
    /// `ACCS`: guest accessor getter/setter mappings.
    pub accessors: Vec<ironhorse_vm::AccessorRow>,
    /// `IBFN`: runtime Intl bound-function links.
    pub intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow>,
    /// `PRIV`: private values and accessors.
    pub private_elements: ironhorse_vm::PrivateElementSnapshot,
    /// `DISP`: explicit resource-management stacks.
    pub disposable_stacks: Vec<ironhorse_vm::DisposableStackRow>,
    /// `GENR`: synchronous generator saved activations.
    pub generators: Vec<ironhorse_vm::GeneratorRow>,
    /// `PRMS`: the promise cluster — settlement state, resolving
    /// functions, `[[AlreadyResolved]]` guards, and combinator
    /// accumulators, validated as one unit (the rows cross-reference).
    pub promise_cluster: ironhorse_vm::PromiseClusterSnapshot,
    /// `ARGB`: the arguments-exotic brand owners, ascending.
    pub arguments_brands: Vec<u32>,
    /// `TMPR`: the four Temporal record tables (ledger).
    pub temporal: TemporalImage,
    /// `INTL`: the nine Intl record tables (ledger), owner-ascending.
    pub intl: IntlTables,
    /// `ITER`: the built-in iterator cursors (ledger), owner-ascending.
    pub iterators: Vec<IteratorRow>,
    /// `NFLR`: the installed-names floor (wave-6 W6-7), when it
    /// traveled. `None` — a pre-floor snapshot — restores to the
    /// conservative full-table default.
    pub name_floor: Option<u32>,
}

/// A decoded machine image that has crossed the complete container
/// validation boundary.
///
/// The inner image is private so callers cannot mutate validated state and
/// then pass it directly to restore. Low-level tooling may inspect it through
/// [`Self::image`] or consume it through [`Self::into_image`], but restoring a
/// modified [`MachineImage`] requires encoding and validating it again.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedSnapshot {
    image: MachineImage,
}

impl ValidatedSnapshot {
    pub(crate) fn from_validated_image(image: MachineImage) -> ValidatedSnapshot {
        ValidatedSnapshot { image }
    }

    /// Borrow the validated plain-data image for inspection.
    pub fn image(&self) -> &MachineImage {
        &self.image
    }

    /// Consume the proof wrapper and return its plain-data image.
    pub fn into_image(self) -> MachineImage {
        self.image
    }
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
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: TemporalImage::default(),
            intl: IntlTables::default(),
            iterators: Vec::new(),
            name_floor: None,
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

    /// Attach the bulk side tables, symbol registry, and error data
    /// (side-table ledger). The snapshot surface calls this with the
    /// live machine's `*_snapshot()` views, already in canonical order.
    pub fn with_side_tables(
        mut self,
        arrays: Vec<ArrayImage>,
        collections: Vec<CollectionImage>,
        registry: Vec<RegistryImage>,
        errors: Vec<ErrorImage>,
        buffers: Vec<BufferImage>,
        typed_arrays: Vec<TypedArrayImage>,
        data_views: Vec<DataViewImage>,
    ) -> MachineImage {
        self.arrays = arrays;
        self.collections = collections;
        self.registry = registry;
        self.errors = errors;
        self.buffers = buffers;
        self.typed_arrays = typed_arrays;
        self.data_views = data_views;
        self
    }

    /// Attach the data-only language rows (store schema v11): primitive
    /// wrappers, regexps, the arguments-exotic brand, and the Temporal
    /// record tables. The snapshot surface calls this with the live
    /// machine's `*_snapshot()` views, already in canonical order.
    pub fn with_language_rows(
        mut self,
        wrappers: Vec<WrapperImage>,
        regexps: Vec<RegExpImage>,
        arguments_brands: Vec<u32>,
        temporal: TemporalImage,
        intl: IntlTables,
    ) -> MachineImage {
        self.wrappers = wrappers;
        self.regexps = regexps;
        self.arguments_brands = arguments_brands;
        self.temporal = temporal;
        self.intl = intl;
        self
    }

    /// Attach the built-in iterator cursors (ledger `Iterators` row).
    /// The snapshot surface calls this with the live machine's
    /// `iterators_snapshot()`, already owner-ascending and
    /// boundary-normalized (collection ordinals; staleness in `done`).
    pub fn with_iterators(mut self, iterators: Vec<IteratorRow>) -> MachineImage {
        self.iterators = iterators;
        self
    }

    /// Attach Date `[[DateValue]]` records, already owner-ascending.
    pub fn with_dates(mut self, dates: Vec<DateImage>) -> MachineImage {
        self.dates = dates;
        self
    }

    /// Attach the atomic retained guest-callability state.
    pub fn with_function_state(
        mut self,
        function_state: ironhorse_vm::FunctionStateSnapshot,
    ) -> MachineImage {
        self.function_state = function_state;
        self
    }

    pub fn with_proxy_state(
        mut self,
        proxy_state: ironhorse_vm::ProxyStateSnapshot,
    ) -> MachineImage {
        self.proxy_state = proxy_state;
        self
    }

    pub fn with_accessors(mut self, accessors: Vec<ironhorse_vm::AccessorRow>) -> MachineImage {
        self.accessors = accessors;
        self
    }

    pub fn with_intl_bound_functions(
        mut self,
        rows: Vec<ironhorse_vm::IntlBoundFunctionRow>,
    ) -> MachineImage {
        self.intl_bound_functions = rows;
        self
    }

    pub fn with_private_elements(
        mut self,
        private_elements: ironhorse_vm::PrivateElementSnapshot,
    ) -> MachineImage {
        self.private_elements = private_elements;
        self
    }

    pub fn with_disposable_stacks(
        mut self,
        disposable_stacks: Vec<ironhorse_vm::DisposableStackRow>,
    ) -> MachineImage {
        self.disposable_stacks = disposable_stacks;
        self
    }

    pub fn with_generators(mut self, generators: Vec<ironhorse_vm::GeneratorRow>) -> MachineImage {
        self.generators = generators;
        self
    }

    pub fn with_promise_cluster(
        mut self,
        promise_cluster: ironhorse_vm::PromiseClusterSnapshot,
    ) -> MachineImage {
        self.promise_cluster = promise_cluster;
        self
    }

    /// Attach the installed-names floor (wave-6 W6-7; the `NFLR`
    /// atom). The snapshot surface calls this with the live machine's
    /// floor so a resumed machine's partial install passes re-consider
    /// exactly the ids the live machine's would. CANONICALIZED: a floor
    /// AT the table length is the restore default, so it is stored (and
    /// wired) as `None` — one representation per meaning, which is what
    /// keeps the container round-trip byte- and value-identical.
    pub fn with_name_floor(mut self, floor: u32) -> MachineImage {
        self.name_floor = (floor as usize != self.names.len()).then_some(floor);
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
        // The rehash geometry (review finding 9): `table_length`
        // mirrors XS's power-of-two address array
        // (`fxResizeEntries` / the vm's `collection_table_resize`),
        // which the engine only ever doubles or halves between
        // `MAP_MIN_TABLE_LENGTH` and the 2^20 cap, re-checking after
        // every size change — so a weak collection's is exactly 0 (no
        // table), a Map/Set's is a power of two in that range, and
        // below the cap the live size never rests past the grow
        // threshold `(L>>1)+(L>>2)` (the add that crossed it doubled
        // the table). Anything else is crafted, and adopting it would
        // diverge the rehash boundaries — consensus-relevant chunk
        // metering — from an uninterrupted run.
        const TABLE_MAX: u32 = 1024 * 1024;
        if kind >= 2 {
            if table_length != 0 {
                return Err(SnapshotError::Corrupt(
                    "collections side table: weak kind carries a hash table",
                ));
            }
        } else {
            if !table_length.is_power_of_two()
                || table_length < ironhorse_vm::interp::MAP_MIN_TABLE_LENGTH
                || table_length > TABLE_MAX
            {
                return Err(SnapshotError::Corrupt(
                    "collections side table: unreachable rehash geometry",
                ));
            }
            let high = (table_length >> 1) + (table_length >> 2);
            if table_length < TABLE_MAX && entries.len() as u64 > high as u64 {
                return Err(SnapshotError::Corrupt(
                    "collections side table: live size past the grow threshold",
                ));
            }
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

/// Encode the error-data side table (the `ERRD` payload / small-state
/// errors section). Input is owner-ascending (the vm snapshot's
/// canonical order). Wire form per row: `u32 owner`, `u32 name_len` +
/// name bytes, `u8 has_message` (0/1), then `u32 msg_len` + message
/// bytes when present.
pub(crate) fn encode_errors(errors: &[ErrorImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(errors.len() as u32).to_be_bytes());
    for e in errors {
        v.extend_from_slice(&e.owner.to_be_bytes());
        let name = e.name.as_bytes();
        v.extend_from_slice(&(name.len() as u32).to_be_bytes());
        v.extend_from_slice(name);
        match &e.message {
            Some(m) => {
                v.push(1);
                let m = m.as_bytes();
                v.extend_from_slice(&(m.len() as u32).to_be_bytes());
                v.extend_from_slice(m);
            }
            None => v.push(0),
        }
    }
    v
}

pub(crate) fn decode_errors(p: &[u8]) -> Result<Vec<ErrorImage>, SnapshotError> {
    let mut c = Cursor::new(p, "error-data side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 9));
    for _ in 0..count {
        let owner = c.u32()?;
        let name_len = c.u32()? as usize;
        let name = String::from_utf8(c.bytes(name_len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("error-data side table: name not UTF-8"))?;
        // The engine only ever RECORDS its closed error-constructor
        // name set, so anything else is crafted or torn bytes; refusing
        // here keeps the vm restore's own check a belt-and-braces
        // debug assert, like the collection kind codes.
        if ironhorse_vm::error_name_static(&name).is_none() {
            return Err(SnapshotError::Corrupt(
                "error-data side table: not an engine error name",
            ));
        }
        // The message flag is exactly 0 or 1 — any other byte is a
        // non-canonical encoding a round trip could not reproduce.
        let message = match c.u8()? {
            0 => None,
            1 => {
                let msg_len = c.u32()? as usize;
                Some(String::from_utf8(c.bytes(msg_len)?.to_vec()).map_err(|_| {
                    SnapshotError::Corrupt("error-data side table: message not UTF-8")
                })?)
            }
            _ => {
                return Err(SnapshotError::Corrupt(
                    "error-data side table: message flag not 0/1",
                ))
            }
        };
        // Strictly-ascending owners, for the sibling decoders' reason:
        // the writer emits one owner-sorted row per instance, and a
        // crafted duplicate would displace a row at restore while an
        // unordered image would re-sort — either breaks the
        // import∘export identity the CAS key rests on.
        if out.last().is_some_and(|prev: &ErrorImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "error-data side table: owners not strictly ascending",
            ));
        }
        out.push(ErrorImage {
            owner,
            name,
            message,
            // The construction frames ride their OWN atom (`ESTK`), so
            // this row's encoding is unchanged and every older reader
            // still sees the subset it always did. Joined below.
            frames: Vec::new(),
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the error-frame side table (the `ESTK` payload / small-state
/// error-frames section): `(owner, frame names)` ascending by owner,
/// emitted only for errors that captured a non-empty frame list.
///
/// A SEPARATE atom rather than wider `ERRD` rows, which is what keeps
/// the format's read range honest: every prior bump ADDED an atom, so
/// an older container is an encoding-identical SUBSET of a newer one
/// and `1..=current` means what it says. Widening an existing row
/// would have made a v10 container undecodable by a v11 reader and
/// forced a rewrite-a-middle-section migration for a field that is
/// naturally optional.
pub(crate) fn encode_error_frames(errors: &[ErrorImage]) -> Vec<u8> {
    let rows: Vec<&ErrorImage> = errors.iter().filter(|e| !e.frames.is_empty()).collect();
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for e in rows {
        v.extend_from_slice(&e.owner.to_be_bytes());
        v.extend_from_slice(&(e.frames.len() as u32).to_be_bytes());
        for f in &e.frames {
            let f = f.as_bytes();
            v.extend_from_slice(&(f.len() as u32).to_be_bytes());
            v.extend_from_slice(f);
        }
    }
    v
}

/// Decode the error-frame side table, refusing the non-canonical
/// shapes an honest writer never emits: unordered or duplicate owners,
/// an empty frame list (the writer omits the row instead), and
/// non-UTF-8 names.
pub(crate) fn decode_error_frames(p: &[u8]) -> Result<Vec<(u32, Vec<String>)>, SnapshotError> {
    let mut c = Cursor::new(p, "error-frame side table");
    let count = c.u32()? as usize;
    let mut out: Vec<(u32, Vec<String>)> = Vec::with_capacity(count.min(p.len() / 8));
    for _ in 0..count {
        let owner = c.u32()?;
        if out.last().is_some_and(|(prev, _)| owner <= *prev) {
            return Err(SnapshotError::Corrupt(
                "error-frame side table: owners not strictly ascending",
            ));
        }
        let n = c.u32()? as usize;
        if n == 0 {
            return Err(SnapshotError::Corrupt(
                "error-frame side table: empty frame list is not emitted",
            ));
        }
        let mut frames = Vec::with_capacity(n.min(p.len() / 4));
        for _ in 0..n {
            let len = c.u32()? as usize;
            frames.push(String::from_utf8(c.bytes(len)?.to_vec()).map_err(|_| {
                SnapshotError::Corrupt("error-frame side table: frame name not UTF-8")
            })?);
        }
        out.push((owner, frames));
    }
    c.done()?;
    Ok(out)
}

/// Encode the array-buffers side table (the `ABUF` payload /
/// small-state buffers section). Input is owner-ascending. Wire form
/// per row: `u32 owner`, `u32 data`, `u32 length`, `u8 flags`.
pub(crate) fn encode_buffers(buffers: &[BufferImage]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + buffers.len() * 13);
    v.extend_from_slice(&(buffers.len() as u32).to_be_bytes());
    for b in buffers {
        v.extend_from_slice(&b.owner.to_be_bytes());
        v.extend_from_slice(&b.data.to_be_bytes());
        v.extend_from_slice(&b.length.to_be_bytes());
        v.push(b.flags);
    }
    v
}

pub(crate) fn decode_buffers(p: &[u8]) -> Result<Vec<BufferImage>, SnapshotError> {
    let mut c = Cursor::new(p, "array-buffers side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 13));
    for _ in 0..count {
        let owner = c.u32()?;
        let data = c.u32()?;
        let length = c.u32()?;
        let flags = c.u8()?;
        // Only the two brand bits (detached, shared) exist; anything
        // else is a non-canonical encoding.
        if flags > 0b11 {
            return Err(SnapshotError::Corrupt(
                "array-buffers side table: unknown flag bits",
            ));
        }
        // Strictly-ascending owners, for the sibling decoders' reason.
        if out.last().is_some_and(|prev: &BufferImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "array-buffers side table: owners not strictly ascending",
            ));
        }
        out.push(BufferImage {
            owner,
            data,
            length,
            flags,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the typed-arrays side table (the `TARR` payload /
/// small-state typed-arrays section). Wire form per row: `u32 owner`,
/// `u8 kind`, `u32 buffer`, `u32 offset`, `u32 length`.
pub(crate) fn encode_typed_arrays(views: &[TypedArrayImage]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + views.len() * 17);
    v.extend_from_slice(&(views.len() as u32).to_be_bytes());
    for t in views {
        v.extend_from_slice(&t.owner.to_be_bytes());
        v.push(t.kind);
        v.extend_from_slice(&t.buffer.to_be_bytes());
        v.extend_from_slice(&t.offset.to_be_bytes());
        v.extend_from_slice(&t.length.to_be_bytes());
    }
    v
}

pub(crate) fn decode_typed_arrays(p: &[u8]) -> Result<Vec<TypedArrayImage>, SnapshotError> {
    let mut c = Cursor::new(p, "typed-arrays side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 17));
    for _ in 0..count {
        let owner = c.u32()?;
        let kind = c.u8()?;
        let buffer = c.u32()?;
        let offset = c.u32()?;
        let length = c.u32()?;
        // The element kind indexes the engine's dispatch table; an
        // index past it can only be crafted or torn bytes.
        if (kind as usize) >= ironhorse_vm::TYPED_ARRAY_TYPES.len() {
            return Err(SnapshotError::Corrupt(
                "typed-arrays side table: unknown element kind",
            ));
        }
        if out.last().is_some_and(|prev: &TypedArrayImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "typed-arrays side table: owners not strictly ascending",
            ));
        }
        out.push(TypedArrayImage {
            owner,
            kind,
            buffer,
            offset,
            length,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the data-views side table (the `DVIW` payload / small-state
/// data-views section). Wire form per row: `u32 owner`, `u32 buffer`,
/// `u32 offset`, `u32 size`.
pub(crate) fn encode_data_views(views: &[DataViewImage]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + views.len() * 16);
    v.extend_from_slice(&(views.len() as u32).to_be_bytes());
    for d in views {
        v.extend_from_slice(&d.owner.to_be_bytes());
        v.extend_from_slice(&d.buffer.to_be_bytes());
        v.extend_from_slice(&d.offset.to_be_bytes());
        v.extend_from_slice(&d.size.to_be_bytes());
    }
    v
}

pub(crate) fn decode_data_views(p: &[u8]) -> Result<Vec<DataViewImage>, SnapshotError> {
    let mut c = Cursor::new(p, "data-views side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 16));
    for _ in 0..count {
        let owner = c.u32()?;
        let buffer = c.u32()?;
        let offset = c.u32()?;
        let size = c.u32()?;
        if out.last().is_some_and(|prev: &DataViewImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "data-views side table: owners not strictly ascending",
            ));
        }
        out.push(DataViewImage {
            owner,
            buffer,
            offset,
            size,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode the primitive-wrapper side table (the `WRAP` payload /
/// small-state wrappers section). Wire form per row: `u32 owner`, then
/// the slot record.
pub(crate) fn encode_wrappers(wrappers: &[WrapperImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(wrappers.len() as u32).to_be_bytes());
    for w in wrappers {
        v.extend_from_slice(&w.owner.to_be_bytes());
        crate::slot_codec::encode_slot(&w.value, &mut v);
    }
    v
}

pub(crate) fn decode_wrappers(p: &[u8]) -> Result<Vec<WrapperImage>, SnapshotError> {
    let mut c = Cursor::new(p, "wrapper side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 8));
    for _ in 0..count {
        let owner = c.u32()?;
        let value = c.slot()?;
        if out.last().is_some_and(|prev: &WrapperImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "wrapper side table: owners not strictly ascending",
            ));
        }
        out.push(WrapperImage { owner, value });
    }
    c.done()?;
    Ok(out)
}

/// Encode the regexp side table (the `REGX` payload / small-state
/// regexps section). Wire form per row: `u32 owner`, `u32 source_len` +
/// bytes, `u32 flags_len` + bytes, `u64 legacy lastIndex bits`.
pub(crate) fn encode_regexps(regexps: &[RegExpImage]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(regexps.len() as u32).to_be_bytes());
    for r in regexps {
        v.extend_from_slice(&r.owner.to_be_bytes());
        let src = r.source.as_bytes();
        v.extend_from_slice(&(src.len() as u32).to_be_bytes());
        v.extend_from_slice(src);
        let flags = r.flags.as_bytes();
        v.extend_from_slice(&(flags.len() as u32).to_be_bytes());
        v.extend_from_slice(flags);
        v.extend_from_slice(&r.last_index_bits.to_be_bytes());
    }
    v
}

pub(crate) fn decode_regexps(p: &[u8]) -> Result<Vec<RegExpImage>, SnapshotError> {
    let mut c = Cursor::new(p, "regexp side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 16));
    for _ in 0..count {
        let owner = c.u32()?;
        let source_len = c.u32()? as usize;
        let source = String::from_utf8(c.bytes(source_len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("regexp side table: source not UTF-8"))?;
        let flags_len = c.u32()? as usize;
        let flags = String::from_utf8(c.bytes(flags_len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("regexp side table: flags not UTF-8"))?;
        let last_index_bits = ((c.u32()? as u64) << 32) | c.u32()? as u64;
        if out.last().is_some_and(|prev: &RegExpImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "regexp side table: owners not strictly ascending",
            ));
        }
        out.push(RegExpImage {
            owner,
            source,
            flags,
            last_index_bits,
        });
    }
    c.done()?;
    Ok(out)
}

/// Encode Date `[[DateValue]]` rows: count, then `(owner, raw f64 bits)`.
pub(crate) fn encode_dates(dates: &[DateImage]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + dates.len() * 12);
    v.extend_from_slice(&(dates.len() as u32).to_be_bytes());
    for d in dates {
        v.extend_from_slice(&d.owner.to_be_bytes());
        v.extend_from_slice(&d.value_bits.to_be_bytes());
    }
    v
}

pub(crate) fn decode_dates(p: &[u8]) -> Result<Vec<DateImage>, SnapshotError> {
    let mut c = Cursor::new(p, "date side table");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 12));
    for _ in 0..count {
        let owner = c.u32()?;
        let value_bits = ((c.u32()? as u64) << 32) | c.u32()? as u64;
        if out.last().is_some_and(|prev: &DateImage| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "date side table: owners not strictly ascending",
            ));
        }
        out.push(DateImage { owner, value_bits });
    }
    c.done()?;
    Ok(out)
}

/// Encode the atomic retained guest-callability cluster (`FUNC`).
pub(crate) fn encode_function_state(state: &ironhorse_vm::FunctionStateSnapshot) -> Vec<u8> {
    let mut v = Vec::new();
    let text = |v: &mut Vec<u8>, value: &str| {
        v.extend_from_slice(&(value.len() as u32).to_be_bytes());
        v.extend_from_slice(value.as_bytes());
    };
    v.extend_from_slice(&(state.segments.len() as u32).to_be_bytes());
    for segment in &state.segments {
        v.extend_from_slice(&(segment.len() as u32).to_be_bytes());
        v.extend_from_slice(segment);
    }
    v.extend_from_slice(&(state.functions.len() as u32).to_be_bytes());
    for row in &state.functions {
        v.extend_from_slice(&row.owner.to_be_bytes());
        match (row.segment, row.body_start) {
            (Some(segment), Some(start)) => {
                v.push(1);
                v.extend_from_slice(&segment.to_be_bytes());
                v.extend_from_slice(&start.to_be_bytes());
                v.extend_from_slice(&row.body_len.to_be_bytes());
            }
            (None, None) => v.push(0),
            _ => unreachable!("function snapshot body and segment must travel together"),
        }
        v.extend_from_slice(&row.closures.to_be_bytes());
        text(&mut v, &row.name);
        v.extend_from_slice(&row.arity.to_be_bytes());
        v.extend_from_slice(&row.name_chunk.to_be_bytes());
        v.push(row.is_generator as u8);
        v.extend_from_slice(&row.home.to_be_bytes());
        v.push(match row.class_derived {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        });
    }
    v.extend_from_slice(&(state.bound_functions.len() as u32).to_be_bytes());
    for row in &state.bound_functions {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.extend_from_slice(&row.target.to_be_bytes());
        crate::slot_codec::encode_slot(&row.this_arg, &mut v);
        v.extend_from_slice(&(row.args.len() as u32).to_be_bytes());
        for arg in &row.args {
            crate::slot_codec::encode_slot(arg, &mut v);
        }
    }
    v.extend_from_slice(&(state.ctor_prototypes.len() as u32).to_be_bytes());
    for &(owner, prototype) in &state.ctor_prototypes {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&prototype.to_be_bytes());
    }
    v.extend_from_slice(&(state.deleted_meta.len() as u32).to_be_bytes());
    for &(owner, id) in &state.deleted_meta {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&id.to_be_bytes());
    }
    v
}

pub(crate) fn decode_function_state(
    p: &[u8],
) -> Result<ironhorse_vm::FunctionStateSnapshot, SnapshotError> {
    let mut c = Cursor::new(p, "function state");
    let text = |c: &mut Cursor<'_>| -> Result<String, SnapshotError> {
        let len = c.u32()? as usize;
        String::from_utf8(c.bytes(len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("function state: name not UTF-8"))
    };
    let u64_value = |c: &mut Cursor<'_>| -> Result<u64, SnapshotError> {
        Ok(((c.u32()? as u64) << 32) | c.u32()? as u64)
    };

    let segment_count = c.u32()? as usize;
    let mut segments = Vec::with_capacity(segment_count.min(p.len() / 4));
    for _ in 0..segment_count {
        let len = c.u32()? as usize;
        segments.push(c.bytes(len)?.to_vec());
    }

    let function_count = c.u32()? as usize;
    let mut functions = Vec::with_capacity(function_count.min(p.len() / 30));
    for _ in 0..function_count {
        let owner = c.u32()?;
        if functions
            .last()
            .is_some_and(|row: &ironhorse_vm::FunctionRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "function state: owners not strictly ascending",
            ));
        }
        let (segment, body_start, body_len) = match c.u8()? {
            0 => (None, None, 0),
            1 => (Some(c.u32()?), Some(u64_value(&mut c)?), u64_value(&mut c)?),
            _ => return Err(SnapshotError::Corrupt("function state: bad body tag")),
        };
        let closures = c.u32()?;
        let name = text(&mut c)?;
        let arity = c.u32()?;
        let name_chunk = c.u32()?;
        let is_generator = match c.u8()? {
            0 => false,
            1 => true,
            _ => return Err(SnapshotError::Corrupt("function state: bad boolean byte")),
        };
        let home = c.u32()?;
        let class_derived = match c.u8()? {
            0 => None,
            1 => Some(false),
            2 => Some(true),
            _ => return Err(SnapshotError::Corrupt("function state: bad class tag")),
        };
        functions.push(ironhorse_vm::FunctionRow {
            owner,
            segment,
            body_start,
            body_len,
            closures,
            name,
            arity,
            name_chunk,
            is_generator,
            home,
            class_derived,
        });
    }

    let bound_count = c.u32()? as usize;
    let mut bound_functions = Vec::with_capacity(bound_count.min(p.len() / 32));
    for _ in 0..bound_count {
        let owner = c.u32()?;
        if bound_functions
            .last()
            .is_some_and(|row: &ironhorse_vm::BoundFunctionRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "bound-function state: owners not strictly ascending",
            ));
        }
        let target = c.u32()?;
        let this_arg = c.slot()?;
        let arg_count = c.u32()? as usize;
        let mut args = Vec::with_capacity(arg_count.min(p.len() / SLOT_RECORD_BYTES));
        for _ in 0..arg_count {
            args.push(c.slot()?);
        }
        bound_functions.push(ironhorse_vm::BoundFunctionRow {
            owner,
            target,
            this_arg,
            args,
        });
    }

    let ctor_count = c.u32()? as usize;
    let mut ctor_prototypes = Vec::with_capacity(ctor_count.min(p.len() / 8));
    for _ in 0..ctor_count {
        let row = (c.u32()?, c.u32()?);
        if ctor_prototypes
            .last()
            .is_some_and(|prev: &(u32, u32)| row.0 <= prev.0)
        {
            return Err(SnapshotError::Corrupt(
                "constructor-prototype state: rows not strictly ascending",
            ));
        }
        ctor_prototypes.push(row);
    }

    let deleted_count = c.u32()? as usize;
    let mut deleted_meta = Vec::with_capacity(deleted_count.min(p.len() / 6));
    for _ in 0..deleted_count {
        let row = (c.u32()?, c.u16()?);
        if deleted_meta.last().is_some_and(|prev| row <= *prev) {
            return Err(SnapshotError::Corrupt(
                "deleted-function metadata: rows not strictly ascending",
            ));
        }
        deleted_meta.push(row);
    }
    c.done()?;
    Ok(ironhorse_vm::FunctionStateSnapshot {
        segments,
        functions,
        bound_functions,
        ctor_prototypes,
        deleted_meta,
    })
}

pub(crate) fn encode_proxy_state(state: &ironhorse_vm::ProxyStateSnapshot) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(state.proxies.len() as u32).to_be_bytes());
    for row in &state.proxies {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.extend_from_slice(&row.target.to_be_bytes());
        v.extend_from_slice(&row.handler.to_be_bytes());
        v.push(row.revoked as u8);
    }
    v.extend_from_slice(&(state.revokers.len() as u32).to_be_bytes());
    for row in &state.revokers {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.extend_from_slice(&row.proxy.to_be_bytes());
        v.extend_from_slice(&row.name_chunk.to_be_bytes());
    }
    v
}

pub(crate) fn decode_proxy_state(
    p: &[u8],
) -> Result<ironhorse_vm::ProxyStateSnapshot, SnapshotError> {
    let mut c = Cursor::new(p, "proxy state");
    let count = c.u32()? as usize;
    let mut proxies = Vec::with_capacity(count.min(p.len() / 13));
    for _ in 0..count {
        let owner = c.u32()?;
        if proxies
            .last()
            .is_some_and(|row: &ironhorse_vm::ProxyRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "proxy state: owners not strictly ascending",
            ));
        }
        let target = c.u32()?;
        let handler = c.u32()?;
        let revoked = match c.u8()? {
            0 => false,
            1 => true,
            _ => return Err(SnapshotError::Corrupt("proxy state: bad boolean byte")),
        };
        proxies.push(ironhorse_vm::ProxyRow {
            owner,
            target,
            handler,
            revoked,
        });
    }
    let count = c.u32()? as usize;
    let mut revokers = Vec::with_capacity(count.min(p.len() / 12));
    for _ in 0..count {
        let owner = c.u32()?;
        if revokers
            .last()
            .is_some_and(|row: &ironhorse_vm::ProxyRevokerRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "proxy revokers: owners not strictly ascending",
            ));
        }
        revokers.push(ironhorse_vm::ProxyRevokerRow {
            owner,
            proxy: c.u32()?,
            name_chunk: c.u32()?,
        });
    }
    c.done()?;
    Ok(ironhorse_vm::ProxyStateSnapshot { proxies, revokers })
}

pub(crate) fn encode_accessors(rows: &[ironhorse_vm::AccessorRow]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for row in rows {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.extend_from_slice(&row.id.to_be_bytes());
        for value in [row.get, row.set] {
            match value {
                None => v.push(0),
                Some(slot) => {
                    v.push(1);
                    crate::slot_codec::encode_slot(&slot, &mut v);
                }
            }
        }
    }
    v
}

pub(crate) fn decode_accessors(
    p: &[u8],
) -> Result<Vec<ironhorse_vm::AccessorRow>, SnapshotError> {
    let mut c = Cursor::new(p, "accessor state");
    let count = c.u32()? as usize;
    let mut rows = Vec::with_capacity(count.min(p.len() / 8));
    for _ in 0..count {
        let owner = c.u32()?;
        let id = c.u16()?;
        if rows
            .last()
            .is_some_and(|row: &ironhorse_vm::AccessorRow| (owner, id) <= (row.owner, row.id))
        {
            return Err(SnapshotError::Corrupt(
                "accessor state: rows not strictly ascending",
            ));
        }
        let mut value = || -> Result<Option<Slot>, SnapshotError> {
            match c.u8()? {
                0 => Ok(None),
                1 => Ok(Some(c.slot()?)),
                _ => Err(SnapshotError::Corrupt("accessor state: bad option tag")),
            }
        };
        let get = value()?;
        let set = value()?;
        rows.push(ironhorse_vm::AccessorRow {
            owner,
            id,
            get,
            set,
        });
    }
    c.done()?;
    Ok(rows)
}

pub(crate) fn encode_intl_bound_functions(rows: &[ironhorse_vm::IntlBoundFunctionRow]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for row in rows {
        v.push(row.kind);
        v.extend_from_slice(&row.function.to_be_bytes());
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.extend_from_slice(&(row.name.len() as u32).to_be_bytes());
        v.extend_from_slice(row.name.as_bytes());
        v.extend_from_slice(&row.name_chunk.to_be_bytes());
        v.extend_from_slice(&row.arity.to_be_bytes());
    }
    v
}

pub(crate) fn decode_intl_bound_functions(
    p: &[u8],
) -> Result<Vec<ironhorse_vm::IntlBoundFunctionRow>, SnapshotError> {
    let mut c = Cursor::new(p, "Intl bound-function state");
    let count = c.u32()? as usize;
    let mut rows = Vec::with_capacity(count.min(p.len() / 17));
    for _ in 0..count {
        let kind = c.u8()?;
        if kind > 1 {
            return Err(SnapshotError::Corrupt(
                "Intl bound-function state: unknown kind",
            ));
        }
        let function = c.u32()?;
        if rows
            .last()
            .is_some_and(|row: &ironhorse_vm::IntlBoundFunctionRow| function <= row.function)
        {
            return Err(SnapshotError::Corrupt(
                "Intl bound-function state: functions not strictly ascending",
            ));
        }
        let owner = c.u32()?;
        let name_len = c.u32()? as usize;
        let name = String::from_utf8(c.bytes(name_len)?.to_vec()).map_err(|_| {
            SnapshotError::Corrupt("Intl bound-function state: name not UTF-8")
        })?;
        rows.push(ironhorse_vm::IntlBoundFunctionRow {
            kind,
            function,
            owner,
            name,
            name_chunk: c.u32()?,
            arity: c.u32()?,
        });
    }
    c.done()?;
    Ok(rows)
}

pub(crate) fn encode_private_elements(state: &ironhorse_vm::PrivateElementSnapshot) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(state.values.len() as u32).to_be_bytes());
    for row in &state.values {
        v.extend_from_slice(&row.receiver.to_be_bytes());
        v.extend_from_slice(&row.brand.to_be_bytes());
        crate::slot_codec::encode_slot(&row.value, &mut v);
    }
    v.extend_from_slice(&(state.accessors.len() as u32).to_be_bytes());
    for row in &state.accessors {
        v.extend_from_slice(&row.receiver.to_be_bytes());
        v.extend_from_slice(&row.brand.to_be_bytes());
        for value in [row.get, row.set] {
            match value {
                None => v.push(0),
                Some(slot) => {
                    v.push(1);
                    crate::slot_codec::encode_slot(&slot, &mut v);
                }
            }
        }
    }
    v
}

pub(crate) fn decode_private_elements(
    p: &[u8],
) -> Result<ironhorse_vm::PrivateElementSnapshot, SnapshotError> {
    let mut c = Cursor::new(p, "private elements");
    let count = c.u32()? as usize;
    let mut values = Vec::with_capacity(count.min(p.len() / (8 + SLOT_RECORD_BYTES)));
    for _ in 0..count {
        let receiver = c.u32()?;
        let brand = c.u32()?;
        if values
            .last()
            .is_some_and(|row: &ironhorse_vm::PrivateValueRow| {
                (receiver, brand) <= (row.receiver, row.brand)
            })
        {
            return Err(SnapshotError::Corrupt(
                "private values: rows not strictly ascending",
            ));
        }
        values.push(ironhorse_vm::PrivateValueRow {
            receiver,
            brand,
            value: c.slot()?,
        });
    }
    let count = c.u32()? as usize;
    let mut accessors = Vec::with_capacity(count.min(p.len() / 10));
    for _ in 0..count {
        let receiver = c.u32()?;
        let brand = c.u32()?;
        if accessors
            .last()
            .is_some_and(|row: &ironhorse_vm::PrivateAccessorRow| {
                (receiver, brand) <= (row.receiver, row.brand)
            })
        {
            return Err(SnapshotError::Corrupt(
                "private accessors: rows not strictly ascending",
            ));
        }
        let mut value = || -> Result<Option<Slot>, SnapshotError> {
            match c.u8()? {
                0 => Ok(None),
                1 => Ok(Some(c.slot()?)),
                _ => Err(SnapshotError::Corrupt(
                    "private accessors: bad option tag",
                )),
            }
        };
        accessors.push(ironhorse_vm::PrivateAccessorRow {
            receiver,
            brand,
            get: value()?,
            set: value()?,
        });
    }
    c.done()?;
    Ok(ironhorse_vm::PrivateElementSnapshot { values, accessors })
}

pub(crate) fn encode_disposable_stacks(rows: &[ironhorse_vm::DisposableStackRow]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for row in rows {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.push(row.disposed as u8);
        v.push(row.asynchronous as u8);
        v.extend_from_slice(&(row.records.len() as u32).to_be_bytes());
        for record in &row.records {
            crate::slot_codec::encode_slot(&record.resource, &mut v);
            crate::slot_codec::encode_slot(&record.method, &mut v);
            v.push(record.pass_resource as u8);
        }
    }
    v
}

pub(crate) fn decode_disposable_stacks(
    p: &[u8],
) -> Result<Vec<ironhorse_vm::DisposableStackRow>, SnapshotError> {
    let mut c = Cursor::new(p, "disposable stacks");
    let count = c.u32()? as usize;
    let mut rows = Vec::with_capacity(count.min(p.len() / 10));
    let boolean = |c: &mut Cursor<'_>| -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt(
                "disposable stacks: bad boolean byte",
            )),
        }
    };
    for _ in 0..count {
        let owner = c.u32()?;
        if rows
            .last()
            .is_some_and(|row: &ironhorse_vm::DisposableStackRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "disposable stacks: owners not strictly ascending",
            ));
        }
        let disposed = boolean(&mut c)?;
        let asynchronous = boolean(&mut c)?;
        let record_count = c.u32()? as usize;
        let mut records =
            Vec::with_capacity(record_count.min(p.len() / (2 * SLOT_RECORD_BYTES + 1)));
        for _ in 0..record_count {
            records.push(ironhorse_vm::DisposalRecordRow {
                resource: c.slot()?,
                method: c.slot()?,
                pass_resource: boolean(&mut c)?,
            });
        }
        if disposed && !records.is_empty() {
            return Err(SnapshotError::Corrupt(
                "disposable stacks: disposed stack retains records",
            ));
        }
        rows.push(ironhorse_vm::DisposableStackRow {
            owner,
            disposed,
            asynchronous,
            records,
        });
    }
    c.done()?;
    Ok(rows)
}

pub(crate) fn encode_generators(rows: &[ironhorse_vm::GeneratorRow]) -> Vec<u8> {
    fn slots(v: &mut Vec<u8>, rows: &[Slot]) {
        v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
        for row in rows {
            crate::slot_codec::encode_slot(row, v);
        }
    }
    fn id_map(v: &mut Vec<u8>, rows: &[(u16, u64)]) {
        v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
        for &(id, index) in rows {
            v.extend_from_slice(&id.to_be_bytes());
            v.extend_from_slice(&index.to_be_bytes());
        }
    }
    fn frame(v: &mut Vec<u8>, row: &ironhorse_vm::SavedFrameRow) {
        slots(v, &row.locals);
        id_map(v, &row.id_map);
        slots(v, &row.args);
        crate::slot_codec::encode_slot(&row.this_val, v);
        crate::slot_codec::encode_slot(&row.env, v);
        v.extend_from_slice(&row.cur_func.to_be_bytes());
        v.push(row.cur_target as u8);
        v.extend_from_slice(&row.target_func.to_be_bytes());
        v.push(row.strict as u8);
        crate::slot_codec::encode_slot(&row.result, v);
        slots(v, &row.stack_slice);
        v.extend_from_slice(&(row.jumps.len() as u32).to_be_bytes());
        for jump in &row.jumps {
            v.extend_from_slice(&jump.target_pc.to_be_bytes());
            v.extend_from_slice(&jump.stack_offset.to_be_bytes());
            v.extend_from_slice(&jump.locals_len.to_be_bytes());
            id_map(v, &jump.id_map);
            v.extend_from_slice(&jump.call_depth_offset.to_be_bytes());
            crate::slot_codec::encode_slot(&jump.env, v);
            v.push(jump.flag);
        }
        v.extend_from_slice(&row.resume_pc.to_be_bytes());
    }
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for row in rows {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.push(row.state);
        match &row.frame {
            None => v.push(0),
            Some(saved) => {
                v.push(1);
                frame(&mut v, saved);
            }
        }
    }
    v
}

pub(crate) fn decode_generators(
    p: &[u8],
) -> Result<Vec<ironhorse_vm::GeneratorRow>, SnapshotError> {
    fn u64_value(c: &mut Cursor<'_>) -> Result<u64, SnapshotError> {
        Ok(((c.u32()? as u64) << 32) | c.u32()? as u64)
    }
    fn boolean(c: &mut Cursor<'_>) -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt("generator frame: bad boolean byte")),
        }
    }
    fn slots(c: &mut Cursor<'_>, p: &[u8]) -> Result<Vec<Slot>, SnapshotError> {
        let count = c.u32()? as usize;
        let mut rows = Vec::with_capacity(count.min(p.len() / SLOT_RECORD_BYTES));
        for _ in 0..count {
            rows.push(c.slot()?);
        }
        Ok(rows)
    }
    fn id_map(c: &mut Cursor<'_>, p: &[u8]) -> Result<Vec<(u16, u64)>, SnapshotError> {
        let count = c.u32()? as usize;
        let mut rows: Vec<(u16, u64)> = Vec::with_capacity(count.min(p.len() / 10));
        for _ in 0..count {
            let row = (c.u16()?, u64_value(c)?);
            if rows.last().is_some_and(|previous| row.0 <= previous.0) {
                return Err(SnapshotError::Corrupt(
                    "generator frame: id map not strictly ascending",
                ));
            }
            rows.push(row);
        }
        Ok(rows)
    }
    fn frame(c: &mut Cursor<'_>, p: &[u8]) -> Result<ironhorse_vm::SavedFrameRow, SnapshotError> {
        let locals = slots(c, p)?;
        let frame_id_map = id_map(c, p)?;
        let args = slots(c, p)?;
        let this_val = c.slot()?;
        let env = c.slot()?;
        let cur_func = c.u32()?;
        let cur_target = boolean(c)?;
        let target_func = c.u32()?;
        let strict = boolean(c)?;
        let result = c.slot()?;
        let stack_slice = slots(c, p)?;
        let jump_count = c.u32()? as usize;
        let mut jumps = Vec::with_capacity(jump_count.min(p.len() / 50));
        for _ in 0..jump_count {
            jumps.push(ironhorse_vm::SavedJumpRow {
                target_pc: u64_value(c)?,
                stack_offset: u64_value(c)?,
                locals_len: u64_value(c)?,
                id_map: id_map(c, p)?,
                call_depth_offset: u64_value(c)?,
                env: c.slot()?,
                flag: c.u8()?,
            });
        }
        Ok(ironhorse_vm::SavedFrameRow {
            locals,
            id_map: frame_id_map,
            args,
            this_val,
            env,
            cur_func,
            cur_target,
            target_func,
            strict,
            result,
            stack_slice,
            jumps,
            resume_pc: u64_value(c)?,
        })
    }

    let mut c = Cursor::new(p, "generators");
    let count = c.u32()? as usize;
    let mut rows = Vec::with_capacity(count.min(p.len() / 6));
    for _ in 0..count {
        let owner = c.u32()?;
        if rows
            .last()
            .is_some_and(|row: &ironhorse_vm::GeneratorRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "generators: owners not strictly ascending",
            ));
        }
        let state = c.u8()?;
        if state > 2 {
            return Err(SnapshotError::Corrupt("generators: invalid state"));
        }
        let saved = match c.u8()? {
            0 => None,
            1 => Some(frame(&mut c, p)?),
            _ => return Err(SnapshotError::Corrupt("generators: bad frame tag")),
        };
        if (state == 2) != saved.is_none() {
            return Err(SnapshotError::Corrupt(
                "generators: state and frame disagree",
            ));
        }
        rows.push(ironhorse_vm::GeneratorRow {
            state,
            owner,
            frame: saved,
        });
    }
    c.done()?;
    Ok(rows)
}

/// Encode the promise cluster (the `PRMS` payload / small-state
/// promise section): four `u32`-counted lists in the fixed order
/// promises, resolving functions, guards, combinators. See
/// [`ironhorse_vm::PromiseClusterSnapshot`] for the row shapes and the
/// compacted-arena canonical form.
pub(crate) fn encode_promise_cluster(c: &ironhorse_vm::PromiseClusterSnapshot) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(c.promises.len() as u32).to_be_bytes());
    for row in &c.promises {
        v.extend_from_slice(&row.owner.to_be_bytes());
        v.push(row.state);
        crate::slot_codec::encode_slot(&row.result, &mut v);
        v.push(row.ever_handled as u8);
        v.extend_from_slice(&(row.reactions.len() as u32).to_be_bytes());
        for r in &row.reactions {
            crate::slot_codec::encode_slot(&r.on_fulfilled, &mut v);
            crate::slot_codec::encode_slot(&r.on_rejected, &mut v);
            crate::slot_codec::encode_slot(&r.resolve, &mut v);
            crate::slot_codec::encode_slot(&r.reject, &mut v);
            v.push(r.kind);
            v.extend_from_slice(&r.a.to_be_bytes());
            v.extend_from_slice(&r.b.to_be_bytes());
        }
    }
    v.extend_from_slice(&(c.functions.len() as u32).to_be_bytes());
    for row in &c.functions {
        v.extend_from_slice(&row.function.to_be_bytes());
        v.extend_from_slice(&row.promise.to_be_bytes());
        v.push(row.reject as u8);
        v.extend_from_slice(&row.guard.to_be_bytes());
        v.extend_from_slice(&row.name_chunk.to_be_bytes());
    }
    v.extend_from_slice(&(c.guards.len() as u32).to_be_bytes());
    for &g in &c.guards {
        v.push(g as u8);
    }
    v.extend_from_slice(&(c.combinators.len() as u32).to_be_bytes());
    for row in &c.combinators {
        v.push(row.kind);
        crate::slot_codec::encode_slot(&row.resolve, &mut v);
        crate::slot_codec::encode_slot(&row.reject, &mut v);
        v.extend_from_slice(&row.remaining.to_be_bytes());
        v.extend_from_slice(&row.results.to_be_bytes());
    }
    v
}

/// Decode and CROSS-VALIDATE the promise cluster. Beyond the per-field
/// gates (state and kind bytes past their enums, non-boolean booleans),
/// the rows prove their cross-references against each other, the
/// discipline every compound atom follows (a view names a buffer row, a
/// generator frame names a function row):
///
/// - an async-flavored reaction kind (bytes 3–10) is refused by name —
///   it would resume machinery no atom carries, and the persist gate
///   refuses the machine before an honest writer can emit one; byte 11 is the
///   resumable second half of `Promise.prototype.finally`, and byte 12 is a
///   synchronous combinator element callback retained by a custom `then`;
/// - a settled promise carries no reactions (settlement drains them,
///   and quiescence requires the job queue empty);
/// - a `Combine`/`CombineDirect` reaction indexes a combinator row; a resolving
///   function indexes a guard and names a promise row; a capability executor
///   or persisted finally closure uses one of the three reserved high guard
///   tags and names its hidden home object; a
///   combinator carries reference-shaped capability callbacks whose callability
///   is rechecked after function restoration;
/// - both arenas are DENSELY referenced (the writer emits the
///   compacted form, so an unreferenced entry can only be crafted —
///   the segments-not-densely-referenced rule);
/// - a live non-`Race` combinator's `remaining` covers its
///   pending element reactions — each drain decrements it once, so a
///   smaller count would underflow at resume.
pub(crate) fn decode_promise_cluster(
    p: &[u8],
) -> Result<ironhorse_vm::PromiseClusterSnapshot, SnapshotError> {
    let mut c = Cursor::new(p, "promise cluster");
    let boolean = |c: &mut Cursor<'_>| -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt("promise cluster: bad boolean byte")),
        }
    };
    let count = c.u32()? as usize;
    let mut promises: Vec<ironhorse_vm::PromiseRow> =
        Vec::with_capacity(count.min(p.len() / (SLOT_RECORD_BYTES + 10)));
    for _ in 0..count {
        let owner = c.u32()?;
        if promises
            .last()
            .is_some_and(|row: &ironhorse_vm::PromiseRow| owner <= row.owner)
        {
            return Err(SnapshotError::Corrupt(
                "promise cluster: owners not strictly ascending",
            ));
        }
        let state = c.u8()?;
        if state > 2 {
            return Err(SnapshotError::Corrupt("promise cluster: invalid state"));
        }
        let result = c.slot()?;
        let ever_handled = boolean(&mut c)?;
        let reaction_count = c.u32()? as usize;
        if state != 0 && reaction_count != 0 {
            return Err(SnapshotError::Corrupt(
                "promise cluster: settled promise retains reactions",
            ));
        }
        let mut reactions =
            Vec::with_capacity(reaction_count.min(p.len() / (4 * SLOT_RECORD_BYTES + 9)));
        for _ in 0..reaction_count {
            let on_fulfilled = c.slot()?;
            let on_rejected = c.slot()?;
            let resolve = c.slot()?;
            let reject = c.slot()?;
            let kind = c.u8()?;
            if kind > 2 && kind != 11 && kind != 12 {
                return Err(SnapshotError::Corrupt(
                    "promise cluster: reaction kind does not resume",
                ));
            }
            reactions.push(ironhorse_vm::PromiseReactionRow {
                on_fulfilled,
                on_rejected,
                resolve,
                reject,
                kind,
                a: c.u32()?,
                b: c.u32()?,
            });
        }
        promises.push(ironhorse_vm::PromiseRow {
            owner,
            state,
            result,
            ever_handled,
            reactions,
        });
    }
    let count = c.u32()? as usize;
    let mut functions: Vec<ironhorse_vm::PromiseFnRow> =
        Vec::with_capacity(count.min(p.len() / 17));
    for _ in 0..count {
        let function = c.u32()?;
        if functions
            .last()
            .is_some_and(|row: &ironhorse_vm::PromiseFnRow| function <= row.function)
        {
            return Err(SnapshotError::Corrupt(
                "promise cluster: functions not strictly ascending",
            ));
        }
        functions.push(ironhorse_vm::PromiseFnRow {
            function,
            promise: c.u32()?,
            reject: boolean(&mut c)?,
            guard: c.u32()?,
            name_chunk: c.u32()?,
        });
    }
    let count = c.u32()? as usize;
    let mut guards = Vec::with_capacity(count.min(p.len()));
    for _ in 0..count {
        guards.push(boolean(&mut c)?);
    }
    let count = c.u32()? as usize;
    let mut combinators: Vec<ironhorse_vm::CombinatorRow> =
        Vec::with_capacity(count.min(p.len() / (2 * SLOT_RECORD_BYTES + 9)));
    for _ in 0..count {
        let kind = c.u8()?;
        if kind > 3 {
            return Err(SnapshotError::Corrupt(
                "promise cluster: unknown combinator kind",
            ));
        }
        combinators.push(ironhorse_vm::CombinatorRow {
            kind,
            resolve: c.slot()?,
            reject: c.slot()?,
            remaining: c.u32()?,
            results: c.u32()?,
        });
    }
    c.done()?;

    // The cross-references, all four tables now in hand.
    let owners: std::collections::BTreeSet<u32> =
        promises.iter().map(|row| row.owner).collect();
    // A guard is the `[[AlreadyResolved]]` boolean of exactly ONE
    // resolving pair (`fxPushPromiseFunctions` mints two rows per
    // guard: opposite polarity, one promise). The collector may sweep
    // one half of a pair the guest dropped, so a surviving SINGLETON
    // is honest — but two rows on one guard must be the pair itself,
    // and a guard spanning promises or doubling a polarity can only
    // be crafted (its trip would then gate the WRONG settlement).
    let mut guard_rows: Vec<Option<(u32, u8)>> = vec![None; guards.len()];
    let mut runtime_homes = std::collections::BTreeSet::new();
    for row in &functions {
        if row.guard >= u32::MAX - 2 {
            if (row.guard == u32::MAX && row.reject)
                || row.promise == row.function
                || !runtime_homes.insert(row.promise)
            {
                return Err(SnapshotError::Corrupt(if row.guard == u32::MAX {
                    "promise cluster: malformed capability executor home"
                } else {
                    "promise cluster: malformed finally function home"
                }));
            }
            continue;
        }
        if !owners.contains(&row.promise) {
            return Err(SnapshotError::Corrupt(
                "promise cluster: resolving function names no promise row",
            ));
        }
        let Some(entry) = guard_rows.get_mut(row.guard as usize) else {
            return Err(SnapshotError::Corrupt(
                "promise cluster: guard index out of range",
            ));
        };
        let polarity = 1u8 << (row.reject as u8);
        match entry {
            None => *entry = Some((row.promise, polarity)),
            Some((promise, mask)) => {
                if *promise != row.promise || *mask & polarity != 0 {
                    return Err(SnapshotError::Corrupt(
                        "promise cluster: guard not shared by one resolving pair",
                    ));
                }
                *mask |= polarity;
            }
        }
    }
    if guard_rows.iter().any(|entry| entry.is_none()) {
        return Err(SnapshotError::Corrupt(
            "promise cluster: guards not densely referenced",
        ));
    }
    // A user reaction's capability slots may be arbitrary callable references
    // supplied by a custom constructor. A queued combinator reaction carries
    // no callbacks; a direct one carries the private bridge's exact resolving
    // pair so a crafted kind byte cannot turn an ordinary promise reaction into
    // synchronous execution. Guest-function callability is checked after all
    // persisted function populations have restored.
    let mut comb_pending = vec![0u32; combinators.len()];
    let mut elem_seen = std::collections::BTreeSet::<(u32, u32)>::new();
    let direct_pair_ok = |owner: u32, resolve: &Slot, reject: &Slot| -> bool {
        let row_for = |slot: &Slot| match slot.value {
            Payload::Reference(function) if slot.kind == Kind::Reference => functions
                .binary_search_by_key(&function.0, |row| row.function)
                .ok()
                .map(|index| &functions[index]),
            _ => None,
        };
        matches!((row_for(resolve), row_for(reject)), (Some(a), Some(b))
            if a.promise == owner
                && b.promise == owner
                && !a.reject
                && b.reject
                && a.guard < u32::MAX - 2
                && a.guard == b.guard)
    };
    for promise in &promises {
        for r in &promise.reactions {
            if r.kind == 2 || r.kind == 12 {
                match comb_pending.get_mut(r.a as usize) {
                    Some(n) => *n += 1,
                    None => {
                        return Err(SnapshotError::Corrupt(
                            "promise cluster: combinator index out of range",
                        ))
                    }
                }
                // One reaction per element: the combinator registers each
                // element index exactly once at creation, so a duplicate
                // `(combinator, element)` pair can only be crafted — and
                // draining both would count one element twice, settling
                // the combinator short of its real total.
                if !elem_seen.insert((r.a, r.b)) {
                    return Err(SnapshotError::Corrupt(
                        "promise cluster: duplicate element reaction",
                    ));
                }
                let callback_shape = if r.kind == 2 {
                    [r.on_fulfilled, r.on_rejected, r.resolve, r.reject]
                        .iter()
                        .all(|slot| slot.kind == Kind::Undefined)
                } else {
                    r.on_fulfilled.kind == Kind::Undefined
                        && r.on_rejected.kind == Kind::Undefined
                        && direct_pair_ok(promise.owner, &r.resolve, &r.reject)
                };
                if !callback_shape {
                    return Err(SnapshotError::Corrupt(if r.kind == 2 {
                        "promise cluster: combinator reaction carries capability slots"
                    } else {
                        "promise cluster: malformed direct combinator callback"
                    }));
                }
            } else {
                let both_references =
                    r.resolve.kind == Kind::Reference && r.reject.kind == Kind::Reference;
                if !both_references {
                    return Err(SnapshotError::Corrupt(
                        "promise cluster: reaction capability names no resolving function",
                    ));
                }
                // `FinallyAwait.a` is its original-rejection boolean. The
                // `a`/`b` payload is otherwise zero outside combinator kinds,
                // so a different value is a second encoding of the machine.
                let payload_ok = if r.kind == 11 {
                    r.a <= 1 && r.b == 0 && r.on_rejected.kind == Kind::Undefined
                } else if r.kind == 1 {
                    r.a == 0 && r.b == 0 && r.on_rejected.kind == Kind::Reference
                } else {
                    r.a == 0 && r.b == 0
                };
                if !payload_ok {
                    return Err(SnapshotError::Corrupt(
                        "promise cluster: unused reaction payload not zero",
                    ));
                }
            }
        }
    }
    for (row, &pending) in combinators.iter().zip(&comb_pending) {
        if pending == 0 {
            return Err(SnapshotError::Corrupt(
                "promise cluster: combinators not densely referenced",
            ));
        }
        if row.resolve.kind != Kind::Reference || row.reject.kind != Kind::Reference {
            return Err(SnapshotError::Corrupt(
                "promise cluster: combinator capability names no function",
            ));
        }
        // kind byte 2 is Race, which never decrements `remaining`.
        if row.kind != 2 && row.remaining < pending {
            return Err(SnapshotError::Corrupt(
                "promise cluster: remaining below its pending reactions",
            ));
        }
    }
    Ok(ironhorse_vm::PromiseClusterSnapshot {
        promises,
        functions,
        guards,
        combinators,
    })
}

/// Encode the arguments-exotic brand owners (the `ARGB` payload /
/// small-state arguments section): a `u32` count then ascending owners.
pub(crate) fn encode_arguments_brands(owners: &[u32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + owners.len() * 4);
    v.extend_from_slice(&(owners.len() as u32).to_be_bytes());
    for o in owners {
        v.extend_from_slice(&o.to_be_bytes());
    }
    v
}

pub(crate) fn decode_arguments_brands(p: &[u8]) -> Result<Vec<u32>, SnapshotError> {
    let mut c = Cursor::new(p, "arguments brand set");
    let count = c.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(p.len() / 4));
    for _ in 0..count {
        let owner = c.u32()?;
        if out.last().is_some_and(|prev| owner <= *prev) {
            return Err(SnapshotError::Corrupt(
                "arguments brand set: owners not strictly ascending",
            ));
        }
        out.push(owner);
    }
    c.done()?;
    Ok(out)
}

/// Encode the four Temporal record tables (the `TMPR` payload /
/// small-state temporal section): four `u32`-counted lists in the
/// fixed order instants, durations, plains, zoneds. `i128`/`i64`
/// values travel as big-endian two's-complement bytes.
pub(crate) fn encode_temporal(t: &TemporalImage) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(t.instants.len() as u32).to_be_bytes());
    for (owner, ns) in &t.instants {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&ns.to_be_bytes());
    }
    v.extend_from_slice(&(t.durations.len() as u32).to_be_bytes());
    for (owner, f) in &t.durations {
        v.extend_from_slice(&owner.to_be_bytes());
        for x in f {
            v.extend_from_slice(&x.to_be_bytes());
        }
    }
    v.extend_from_slice(&(t.plains.len() as u32).to_be_bytes());
    for (owner, kind, year, f) in &t.plains {
        v.extend_from_slice(&owner.to_be_bytes());
        v.push(*kind);
        v.extend_from_slice(&year.to_be_bytes());
        for x in f {
            v.extend_from_slice(&x.to_be_bytes());
        }
    }
    v.extend_from_slice(&(t.zoneds.len() as u32).to_be_bytes());
    for (owner, ns, tz, off) in &t.zoneds {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&ns.to_be_bytes());
        let tzb = tz.as_bytes();
        v.extend_from_slice(&(tzb.len() as u32).to_be_bytes());
        v.extend_from_slice(tzb);
        v.extend_from_slice(&off.to_be_bytes());
    }
    v
}

pub(crate) fn decode_temporal(p: &[u8]) -> Result<TemporalImage, SnapshotError> {
    let mut c = Cursor::new(p, "temporal record tables");
    let mut t = TemporalImage::default();
    let ascending = |prev: Option<u32>, owner: u32, what: &'static str| {
        if prev.is_some_and(|prev| owner <= prev) {
            Err(SnapshotError::Corrupt(what))
        } else {
            Ok(())
        }
    };
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = c.u32()?;
        ascending(prev, owner, "temporal instants: owners not strictly ascending")?;
        prev = Some(owner);
        let mut b = [0u8; 16];
        b.copy_from_slice(c.bytes(16)?);
        t.instants.push((owner, i128::from_be_bytes(b)));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = c.u32()?;
        ascending(prev, owner, "temporal durations: owners not strictly ascending")?;
        prev = Some(owner);
        let mut f = [0i64; 10];
        for x in &mut f {
            let mut b = [0u8; 8];
            b.copy_from_slice(c.bytes(8)?);
            *x = i64::from_be_bytes(b);
        }
        t.durations.push((owner, f));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = c.u32()?;
        ascending(prev, owner, "temporal plains: owners not strictly ascending")?;
        prev = Some(owner);
        let kind = c.u8()?;
        // The engine's plain-record discriminants are 0..=4; anything
        // else is crafted bytes the consuming natives would match on.
        if kind > 4 {
            return Err(SnapshotError::Corrupt("temporal plains: unknown kind"));
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(c.bytes(8)?);
        let year = i64::from_be_bytes(b);
        let mut f = [0u32; 8];
        for x in &mut f {
            *x = c.u32()?;
        }
        t.plains.push((owner, kind, year, f));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = c.u32()?;
        ascending(prev, owner, "temporal zoneds: owners not strictly ascending")?;
        prev = Some(owner);
        let mut b = [0u8; 16];
        b.copy_from_slice(c.bytes(16)?);
        let ns = i128::from_be_bytes(b);
        let tz_len = c.u32()? as usize;
        let tz = String::from_utf8(c.bytes(tz_len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("temporal zoneds: time zone not UTF-8"))?;
        let mut b = [0u8; 8];
        b.copy_from_slice(c.bytes(8)?);
        t.zoneds.push((owner, ns, tz, i64::from_be_bytes(b)));
    }
    c.done()?;
    Ok(t)
}

/// Encode the nine Intl record tables (the `INTL` payload /
/// small-state intl section): nine `u32`-counted lists in the fixed
/// order locales, collators, list formats, plural rules, number
/// formats, segmenters, segments, segment iterators, date-time
/// formats. Strings are `u32`-length-prefixed UTF-8; options are a
/// one-byte presence tag; booleans are one byte. The
/// `NumberFormatData::bound_format` cache is NOT encoded (the emitter
/// strips it; see `Interp::intl_snapshot`).
pub(crate) fn encode_intl(t: &IntlTables) -> Vec<u8> {
    let mut v = Vec::new();
    fn s(v: &mut Vec<u8>, s: &str) {
        let b = s.as_bytes();
        v.extend_from_slice(&(b.len() as u32).to_be_bytes());
        v.extend_from_slice(b);
    }
    fn os(v: &mut Vec<u8>, o: &Option<String>) {
        match o {
            Some(x) => {
                v.push(1);
                s(v, x);
            }
            None => v.push(0),
        }
    }
    fn ou32(v: &mut Vec<u8>, o: &Option<u32>) {
        match o {
            Some(x) => {
                v.push(1);
                v.extend_from_slice(&x.to_be_bytes());
            }
            None => v.push(0),
        }
    }
    v.extend_from_slice(&(t.locales.len() as u32).to_be_bytes());
    for (owner, r) in &t.locales {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.tag);
        s(&mut v, &r.language);
        os(&mut v, &r.script);
        os(&mut v, &r.region);
        v.extend_from_slice(&(r.variants.len() as u32).to_be_bytes());
        for x in &r.variants {
            s(&mut v, x);
        }
        v.extend_from_slice(&(r.unicode.len() as u32).to_be_bytes());
        for (k, val) in &r.unicode {
            s(&mut v, k);
            s(&mut v, val);
        }
    }
    v.extend_from_slice(&(t.collators.len() as u32).to_be_bytes());
    for (owner, r) in &t.collators {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.usage);
        s(&mut v, &r.sensitivity);
        s(&mut v, &r.collation);
        v.push(r.numeric as u8);
        s(&mut v, &r.case_first);
        v.push(r.ignore_punctuation as u8);
    }
    v.extend_from_slice(&(t.list_formats.len() as u32).to_be_bytes());
    for (owner, r) in &t.list_formats {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.kind);
        s(&mut v, &r.style);
    }
    v.extend_from_slice(&(t.plural_rules.len() as u32).to_be_bytes());
    for (owner, r) in &t.plural_rules {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.kind);
        s(&mut v, &r.notation);
        v.extend_from_slice(&r.minimum_integer_digits.to_be_bytes());
        v.extend_from_slice(&r.minimum_fraction_digits.to_be_bytes());
        v.extend_from_slice(&r.maximum_fraction_digits.to_be_bytes());
        ou32(&mut v, &r.minimum_significant_digits);
        ou32(&mut v, &r.maximum_significant_digits);
        s(&mut v, &r.rounding_type);
        s(&mut v, &r.rounding_priority);
        s(&mut v, &r.rounding_mode);
        v.extend_from_slice(&r.rounding_increment.to_be_bytes());
        s(&mut v, &r.trailing_zero_display);
    }
    v.extend_from_slice(&(t.number_formats.len() as u32).to_be_bytes());
    for (owner, r) in &t.number_formats {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.numbering_system);
        s(&mut v, &r.style);
        s(&mut v, &r.notation);
        s(&mut v, &r.compact_display);
        s(&mut v, &r.sign_display);
        s(&mut v, &r.use_grouping);
        os(&mut v, &r.currency);
        s(&mut v, &r.currency_display);
        s(&mut v, &r.currency_sign);
        os(&mut v, &r.unit);
        s(&mut v, &r.unit_display);
        v.extend_from_slice(&r.minimum_integer_digits.to_be_bytes());
        v.extend_from_slice(&r.minimum_fraction_digits.to_be_bytes());
        v.extend_from_slice(&r.maximum_fraction_digits.to_be_bytes());
        ou32(&mut v, &r.minimum_significant_digits);
        ou32(&mut v, &r.maximum_significant_digits);
        s(&mut v, &r.rounding_type);
        s(&mut v, &r.rounding_priority);
        s(&mut v, &r.rounding_mode);
        v.extend_from_slice(&r.rounding_increment.to_be_bytes());
        s(&mut v, &r.trailing_zero_display);
    }
    v.extend_from_slice(&(t.segmenters.len() as u32).to_be_bytes());
    for (owner, r) in &t.segmenters {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.granularity);
    }
    v.extend_from_slice(&(t.segments.len() as u32).to_be_bytes());
    for (owner, r) in &t.segments {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&(r.units.len() as u32).to_be_bytes());
        for u in &r.units {
            v.extend_from_slice(&u.to_be_bytes());
        }
        v.extend_from_slice(&(r.segments.len() as u32).to_be_bytes());
        for &(start, end, word) in &r.segments {
            v.extend_from_slice(&(start as u32).to_be_bytes());
            v.extend_from_slice(&(end as u32).to_be_bytes());
            v.push(word as u8);
        }
        s(&mut v, &r.granularity);
    }
    v.extend_from_slice(&(t.segment_iterators.len() as u32).to_be_bytes());
    for (owner, r) in &t.segment_iterators {
        v.extend_from_slice(&owner.to_be_bytes());
        v.extend_from_slice(&r.segments_inst.0.to_be_bytes());
        v.extend_from_slice(&(r.pos as u32).to_be_bytes());
    }
    v.extend_from_slice(&(t.date_time_formats.len() as u32).to_be_bytes());
    for (owner, r) in &t.date_time_formats {
        v.extend_from_slice(&owner.to_be_bytes());
        s(&mut v, &r.locale);
        s(&mut v, &r.calendar);
        s(&mut v, &r.numbering_system);
        s(&mut v, &r.time_zone);
        v.extend_from_slice(&r.offset_minutes.to_be_bytes());
        os(&mut v, &r.hour_cycle);
        v.extend_from_slice(&(r.components.len() as u32).to_be_bytes());
        for (k, val) in &r.components {
            s(&mut v, k);
            s(&mut v, val);
        }
        os(&mut v, &r.date_style);
        os(&mut v, &r.time_style);
    }
    v
}

pub(crate) fn decode_intl(p: &[u8]) -> Result<IntlTables, SnapshotError> {
    let mut c = Cursor::new(p, "intl record tables");
    let mut t = IntlTables::default();
    fn text(c: &mut Cursor<'_>) -> Result<String, SnapshotError> {
        let len = c.u32()? as usize;
        String::from_utf8(c.bytes(len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("intl side table: string not UTF-8"))
    }
    fn opt_text(c: &mut Cursor<'_>) -> Result<Option<String>, SnapshotError> {
        match c.u8()? {
            0 => Ok(None),
            1 => Ok(Some(text(c)?)),
            _ => Err(SnapshotError::Corrupt("intl side table: bad option tag")),
        }
    }
    fn opt_u32(c: &mut Cursor<'_>) -> Result<Option<u32>, SnapshotError> {
        match c.u8()? {
            0 => Ok(None),
            1 => Ok(Some(c.u32()?)),
            _ => Err(SnapshotError::Corrupt("intl side table: bad option tag")),
        }
    }
    fn boolean(c: &mut Cursor<'_>) -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt("intl side table: bad boolean byte")),
        }
    }
    fn owner_of(
        c: &mut Cursor<'_>,
        prev: &mut Option<u32>,
    ) -> Result<u32, SnapshotError> {
        let owner = c.u32()?;
        if prev.is_some_and(|p| owner <= p) {
            return Err(SnapshotError::Corrupt(
                "intl side table: owners not strictly ascending",
            ));
        }
        *prev = Some(owner);
        Ok(owner)
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        let tag = text(&mut c)?;
        let language = text(&mut c)?;
        let script = opt_text(&mut c)?;
        let region = opt_text(&mut c)?;
        let vn = c.u32()? as usize;
        let mut variants = Vec::with_capacity(vn.min(p.len() / 4));
        for _ in 0..vn {
            variants.push(text(&mut c)?);
        }
        let un = c.u32()? as usize;
        let mut unicode = std::collections::BTreeMap::new();
        let mut prev_key: Option<String> = None;
        for _ in 0..un {
            let k = text(&mut c)?;
            let val = text(&mut c)?;
            // Canonical bytes only (review): the writer iterates the
            // `BTreeMap` in strictly-ascending key order, so a
            // duplicated or unordered key can only be crafted — and
            // silently accepting it re-canonicalizes, breaking the
            // write(read(bytes)) == bytes identity the seals pin.
            if prev_key.as_ref().is_some_and(|p| k <= *p) {
                return Err(SnapshotError::Corrupt(
                    "intl side table: unicode keys not strictly ascending",
                ));
            }
            prev_key = Some(k.clone());
            unicode.insert(k, val);
        }
        t.locales.push((
            owner,
            LocaleData {
                tag,
                language,
                script,
                region,
                variants,
                unicode,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        t.collators.push((
            owner,
            CollatorData {
                locale: text(&mut c)?,
                usage: text(&mut c)?,
                sensitivity: text(&mut c)?,
                collation: text(&mut c)?,
                numeric: boolean(&mut c)?,
                case_first: text(&mut c)?,
                ignore_punctuation: boolean(&mut c)?,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        t.list_formats.push((
            owner,
            ListFormatData {
                locale: text(&mut c)?,
                kind: text(&mut c)?,
                style: text(&mut c)?,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        t.plural_rules.push((
            owner,
            PluralRulesData {
                locale: text(&mut c)?,
                kind: text(&mut c)?,
                notation: text(&mut c)?,
                minimum_integer_digits: c.u32()?,
                minimum_fraction_digits: c.u32()?,
                maximum_fraction_digits: c.u32()?,
                minimum_significant_digits: opt_u32(&mut c)?,
                maximum_significant_digits: opt_u32(&mut c)?,
                rounding_type: text(&mut c)?,
                rounding_priority: text(&mut c)?,
                rounding_mode: text(&mut c)?,
                rounding_increment: c.u32()?,
                trailing_zero_display: text(&mut c)?,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        t.number_formats.push((
            owner,
            NumberFormatData {
                locale: text(&mut c)?,
                numbering_system: text(&mut c)?,
                style: text(&mut c)?,
                notation: text(&mut c)?,
                compact_display: text(&mut c)?,
                sign_display: text(&mut c)?,
                use_grouping: text(&mut c)?,
                currency: opt_text(&mut c)?,
                currency_display: text(&mut c)?,
                currency_sign: text(&mut c)?,
                unit: opt_text(&mut c)?,
                unit_display: text(&mut c)?,
                minimum_integer_digits: c.u32()?,
                minimum_fraction_digits: c.u32()?,
                maximum_fraction_digits: c.u32()?,
                minimum_significant_digits: opt_u32(&mut c)?,
                maximum_significant_digits: opt_u32(&mut c)?,
                rounding_type: text(&mut c)?,
                rounding_priority: text(&mut c)?,
                rounding_mode: text(&mut c)?,
                rounding_increment: c.u32()?,
                trailing_zero_display: text(&mut c)?,
                bound_format: None,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        t.segmenters.push((
            owner,
            SegmenterData {
                locale: text(&mut c)?,
                granularity: text(&mut c)?,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        let un = c.u32()? as usize;
        let mut units = Vec::with_capacity(un.min(p.len() / 2));
        for _ in 0..un {
            units.push(c.u16()?);
        }
        let sn = c.u32()? as usize;
        let mut segs: Vec<(usize, usize, bool)> = Vec::with_capacity(sn.min(p.len() / 9));
        let mut prev_end = 0usize;
        for _ in 0..sn {
            let start = c.u32()? as usize;
            let end = c.u32()? as usize;
            let word = boolean(&mut c)?;
            // Boundaries TILE the input left to right: the engine's
            // `segment_units` emits `(previous boundary, boundary)`
            // pairs, so every start is exactly the previous END and
            // every segment is non-empty. The pre-review check
            // compared against the previous START, so overlapping
            // ranges decoded silently (review); anything that does not
            // tile is crafted bytes the consuming natives would index
            // on.
            if start != prev_end || end <= start || end > units.len() {
                return Err(SnapshotError::Corrupt(
                    "intl side table: segment boundaries do not tile their input",
                ));
            }
            prev_end = end;
            segs.push((start, end, word));
        }
        // And they COVER it: ICU always emits the final boundary at
        // the input length, so an honest row's last end is the unit
        // count (vacuously zero for an empty input).
        if prev_end != units.len() {
            return Err(SnapshotError::Corrupt(
                "intl side table: segment boundaries do not cover their input",
            ));
        }
        let granularity = text(&mut c)?;
        t.segments.push((
            owner,
            SegmentsData {
                units,
                segments: segs,
                granularity,
            },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        let segments_inst = ironhorse_vm::value::SlotIndex(c.u32()?);
        let pos = c.u32()? as usize;
        t.segment_iterators.push((
            owner,
            SegmentIteratorData { segments_inst, pos },
        ));
    }
    let n = c.u32()? as usize;
    let mut prev = None;
    for _ in 0..n {
        let owner = owner_of(&mut c, &mut prev)?;
        let locale = text(&mut c)?;
        let calendar = text(&mut c)?;
        let numbering_system = text(&mut c)?;
        let time_zone = text(&mut c)?;
        let mut b = [0u8; 4];
        b.copy_from_slice(c.bytes(4)?);
        let offset_minutes = i32::from_be_bytes(b);
        let hour_cycle = opt_text(&mut c)?;
        let cn = c.u32()? as usize;
        let mut components = Vec::with_capacity(cn.min(p.len() / 8));
        for _ in 0..cn {
            let key = text(&mut c)?;
            // The component keys are a CLOSED engine set carried as
            // `&'static str`; an unknown key is crafted bytes.
            let key = dtf_component_key_static(&key).ok_or(SnapshotError::Corrupt(
                "intl side table: unknown date-time component key",
            ))?;
            let val = text(&mut c)?;
            components.push((key, val));
        }
        let date_style = opt_text(&mut c)?;
        let time_style = opt_text(&mut c)?;
        t.date_time_formats.push((
            owner,
            DateTimeFormatData {
                locale,
                calendar,
                numbering_system,
                time_zone,
                offset_minutes,
                hour_cycle,
                components,
                date_style,
                time_style,
            },
        ));
    }
    c.done()?;
    Ok(t)
}

/// Encode the built-in iterator cursors (the `ITER` payload /
/// small-state iterators section): a `u32`-counted list of rows
/// `(owner, kind, iterable, index, done, result, enum_keys, str_bytes)`
/// in owner order.
pub(crate) fn encode_iterators(rows: &[IteratorRow]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for r in rows {
        v.extend_from_slice(&r.owner.to_be_bytes());
        v.push(r.kind);
        v.extend_from_slice(&r.iterable.to_be_bytes());
        v.extend_from_slice(&r.index.to_be_bytes());
        v.push(r.done as u8);
        v.extend_from_slice(&r.result.to_be_bytes());
        v.extend_from_slice(&(r.enum_keys.len() as u32).to_be_bytes());
        for &(id, idx) in &r.enum_keys {
            v.extend_from_slice(&id.to_be_bytes());
            v.extend_from_slice(&idx.to_be_bytes());
        }
        v.extend_from_slice(&(r.str_bytes.len() as u32).to_be_bytes());
        v.extend_from_slice(&r.str_bytes);
    }
    v
}

pub(crate) fn decode_iterators(p: &[u8]) -> Result<Vec<IteratorRow>, SnapshotError> {
    let mut c = Cursor::new(p, "iterator cursors");
    let count = c.u32()? as usize;
    let mut out: Vec<IteratorRow> = Vec::with_capacity(count.min(p.len() / 19));
    for _ in 0..count {
        let owner = c.u32()?;
        if out.last().is_some_and(|prev| owner <= prev.owner) {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: owners not strictly ascending",
            ));
        }
        let kind = c.u8()?;
        // The engine's cursor kinds are 0..=9 (array values/keys/entries,
        // for-in, string, collection keys/values/entries, Iterator.from
        // generic wrappers, and RegExp String Iterator).
        if kind > 9 {
            return Err(SnapshotError::Corrupt("iterator cursors: unknown kind"));
        }
        let iterable = c.u32()?;
        let index = c.u32()?;
        let done = match c.u8()? {
            0 => false,
            1 => true,
            _ => return Err(SnapshotError::Corrupt("iterator cursors: bad done byte")),
        };
        let result = c.u32()?;
        let en = c.u32()? as usize;
        let mut enum_keys = Vec::with_capacity(en.min(p.len() / 6));
        for _ in 0..en {
            let id = c.u16()?;
            let idx = c.u32()?;
            enum_keys.push((id, idx));
        }
        let sn = c.u32()? as usize;
        let str_bytes = c.bytes(sn)?.to_vec();
        // Self-contained cursor sanity; the cross-table checks (a
        // collection cursor's covering row, the for-in ids against the
        // name table) run in the bounds gate where those rows are in
        // hand.
        if kind == 4 && (index as usize > str_bytes.len() || index % 2 != 0) {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: string cursor outside its text",
            ));
        }
        if kind == 3 && index as usize > enum_keys.len() {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: for-in cursor past its key list",
            ));
        }
        if kind == 9
            && (iterable == u32::MAX
                || result == u32::MAX
                || index > 3
                || !enum_keys.is_empty()
                || str_bytes.len() % 2 != 0)
        {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: invalid RegExp String Iterator",
            ));
        }
        out.push(IteratorRow {
            owner,
            kind,
            iterable,
            index,
            done,
            result,
            enum_keys,
            str_bytes,
        });
    }
    c.done()?;
    Ok(out)
}

/// The data-only language rows, bundled for the bounds gate (one
/// parameter instead of four more positionals as the ledger grows).
pub(crate) struct LangRows<'a> {
    pub wrappers: &'a [WrapperImage],
    pub regexps: &'a [RegExpImage],
    pub dates: &'a [DateImage],
    pub function_state: &'a ironhorse_vm::FunctionStateSnapshot,
    pub proxy_state: &'a ironhorse_vm::ProxyStateSnapshot,
    pub accessors: &'a [ironhorse_vm::AccessorRow],
    pub intl_bound_functions: &'a [ironhorse_vm::IntlBoundFunctionRow],
    pub private_elements: &'a ironhorse_vm::PrivateElementSnapshot,
    pub disposable_stacks: &'a [ironhorse_vm::DisposableStackRow],
    pub generators: &'a [ironhorse_vm::GeneratorRow],
    pub promise_cluster: &'a ironhorse_vm::PromiseClusterSnapshot,
    pub arguments_brands: &'a [u32],
    pub temporal: &'a TemporalImage,
    pub intl: &'a IntlTables,
}

impl LangRows<'_> {
    /// The empty rows, for callers checking language-row-free content.
    pub(crate) const EMPTY: LangRows<'static> = LangRows {
        wrappers: &[],
        regexps: &[],
        dates: &[],
        function_state: &EMPTY_FUNCTION_STATE,
        proxy_state: &EMPTY_PROXY_STATE,
        accessors: &[],
        intl_bound_functions: &[],
        private_elements: &EMPTY_PRIVATE_ELEMENTS,
        disposable_stacks: &[],
        generators: &[],
        promise_cluster: &EMPTY_PROMISE_CLUSTER,
        arguments_brands: &[],
        temporal: &EMPTY_TEMPORAL,
        intl: &EMPTY_INTL,
    };
}

static EMPTY_PROMISE_CLUSTER: ironhorse_vm::PromiseClusterSnapshot =
    ironhorse_vm::PromiseClusterSnapshot {
        promises: Vec::new(),
        functions: Vec::new(),
        guards: Vec::new(),
        combinators: Vec::new(),
    };

static EMPTY_TEMPORAL: TemporalImage = TemporalImage {
    instants: Vec::new(),
    durations: Vec::new(),
    plains: Vec::new(),
    zoneds: Vec::new(),
};

static EMPTY_INTL: IntlTables = IntlTables {
    locales: Vec::new(),
    collators: Vec::new(),
    list_formats: Vec::new(),
    plural_rules: Vec::new(),
    number_formats: Vec::new(),
    segmenters: Vec::new(),
    segments: Vec::new(),
    segment_iterators: Vec::new(),
    date_time_formats: Vec::new(),
};
static EMPTY_FUNCTION_STATE: ironhorse_vm::FunctionStateSnapshot =
    ironhorse_vm::FunctionStateSnapshot {
        segments: Vec::new(),
        functions: Vec::new(),
        bound_functions: Vec::new(),
        ctor_prototypes: Vec::new(),
        deleted_meta: Vec::new(),
    };
static EMPTY_PROXY_STATE: ironhorse_vm::ProxyStateSnapshot = ironhorse_vm::ProxyStateSnapshot {
    proxies: Vec::new(),
    revokers: Vec::new(),
};
static EMPTY_PRIVATE_ELEMENTS: ironhorse_vm::PrivateElementSnapshot =
    ironhorse_vm::PrivateElementSnapshot {
        values: Vec::new(),
        accessors: Vec::new(),
    };

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
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_image_slot_bounds(
    heap: &[Slot],
    stack: &[Slot],
    arrays: &[ArrayImage],
    collections: &[CollectionImage],
    registry: &[RegistryImage],
    errors: &[ErrorImage],
    buffers: &[BufferImage],
    typed_arrays: &[TypedArrayImage],
    data_views: &[DataViewImage],
    lang: &LangRows<'_>,
    iterators: &[IteratorRow],
    names_len: usize,
    symbols: &SymbolKeyImage,
    slot_count: u32,
    chunk_len: usize,
    free: &[u32],
) -> Result<(), SnapshotError> {
    const OOB: SnapshotError = SnapshotError::Corrupt("slot index out of arena bounds");
    const OOC: SnapshotError = SnapshotError::Corrupt("chunk offset out of arena bounds");
    const FREE: SnapshotError = SnapshotError::Corrupt("side table names a free slot");
    // The free set, as a bitmap (entries already range-checked and
    // deduplicated by both decode paths). It cuts BOTH ways (review
    // findings 2+3): a freed heap record is OPAQUE — the sweep does not
    // scrub it and chunk compaction remaps MARKED slots only, so an
    // honest post-GC snapshot legitimately holds freed records whose
    // stale chunk offsets sit outside the compacted arena, and nothing
    // reads those bytes before `alloc` overwrites them — while a
    // side-table row whose OWNER sits in the free set can only be
    // crafted: the sweep drops rows keyed by every index it frees, so
    // restoring one would attach exotic state to a free slot for an
    // unrelated later allocation to inherit.
    let mut free_marks = vec![false; slot_count as usize];
    for &f in free {
        if let Some(m) = free_marks.get_mut(f as usize) {
            *m = true;
        }
    }
    let is_free = |i: u32| free_marks.get(i as usize).copied().unwrap_or(false);
    let owned = |o: u32| -> Result<(), SnapshotError> {
        if o >= slot_count {
            return Err(OOB);
        }
        if is_free(o) {
            return Err(FREE);
        }
        Ok(())
    };
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
    for (i, s) in heap.iter().enumerate() {
        if is_free(i as u32) {
            continue; // opaque: dead bytes, preserved for index identity only
        }
        check(s)?;
    }
    for s in stack {
        check(s)?;
    }
    for a in arrays {
        owned(a.owner)?;
        for (_, v) in &a.items {
            check(v)?;
        }
    }
    for coll in collections {
        owned(coll.owner)?;
        for (k, v) in &coll.entries {
            check(k)?;
            check(v)?;
        }
    }
    for e in registry {
        owned(e.descriptor)?;
    }
    for e in errors {
        owned(e.owner)?;
    }
    // The typed-array family carries CROSS-table geometry, checked here
    // where all three tables are in hand (the SYMB-vs-NAME precedent):
    // every buffer's backing extent lies inside the chunk arena, and
    // every live view names a buffer ROW whose length covers the view.
    // Detached buffers retain the former view geometry, whose observable
    // accessors project zero lengths. A view that merely named an in-bounds
    // SLOT with no buffer row would restore without a backing allocation.
    let buffer_shape = |slot: u32| -> Option<(u32, bool)> {
        buffers
            .binary_search_by_key(&slot, |b| b.owner)
            .ok()
            .map(|i| (buffers[i].length, buffers[i].flags & 1 != 0))
    };
    for b in buffers {
        owned(b.owner)?;
        if b.data == u32::MAX
            || (b.data as usize) < CHUNK_HEADER
            || b.data as u64 + b.length as u64 > chunk_len as u64
        {
            return Err(OOC);
        }
    }
    for t in typed_arrays {
        owned(t.owner)?;
        owned(t.buffer)?;
        let shift = ironhorse_vm::TYPED_ARRAY_TYPES
            .get(t.kind as usize)
            .map(|ty| ty.shift)
            .ok_or(SnapshotError::Corrupt(
                "typed-arrays side table: unknown element kind",
            ))?;
        let covered = buffer_shape(t.buffer).is_some_and(|(len, detached)| {
            detached || t.offset as u64 + ((t.length as u64) << shift) <= len as u64
        });
        if !covered {
            return Err(SnapshotError::Corrupt(
                "typed-arrays side table: view geometry past its buffer",
            ));
        }
    }
    for d in data_views {
        owned(d.owner)?;
        owned(d.buffer)?;
        let covered = buffer_shape(d.buffer).is_some_and(|(len, detached)| {
            detached || d.offset as u64 + d.size as u64 <= len as u64
        });
        if !covered {
            return Err(SnapshotError::Corrupt(
                "data-views side table: view geometry past its buffer",
            ));
        }
    }
    // The language rows: weak owners bounded like every sibling's, and
    // a wrapper's boxed VALUE walks the same slot check as an array
    // item (its refs and chunk offset are real edges).
    for w in lang.wrappers {
        owned(w.owner)?;
        check(&w.value)?;
    }
    for r in lang.regexps {
        owned(r.owner)?;
        if !ironhorse_vm::regexp_source_compiles(&r.source, &r.flags) {
            return Err(SnapshotError::Corrupt(
                "regexp side table: persisted source does not compile",
            ));
        }
    }
    for d in lang.dates {
        owned(d.owner)?;
    }
    let function_owners: std::collections::BTreeSet<u32> = lang
        .function_state
        .functions
        .iter()
        .map(|row| row.owner)
        .collect();
    let bound_owners: std::collections::BTreeSet<u32> = lang
        .function_state
        .bound_functions
        .iter()
        .map(|row| row.owner)
        .collect();
    let mut referenced_segments = std::collections::BTreeSet::new();
    for row in &lang.function_state.functions {
        owned(row.owner)?;
        if row.closures != u32::MAX {
            owned(row.closures)?;
        }
        if row.home != u32::MAX {
            owned(row.home)?;
        }
        if row.name_chunk != u32::MAX {
            let offset = row.name_chunk as usize;
            if offset < CHUNK_HEADER || offset > chunk_len {
                return Err(OOC);
            }
        }
        match (row.segment, row.body_start) {
            (Some(segment), Some(start)) => {
                let Some(code) = lang.function_state.segments.get(segment as usize) else {
                    return Err(SnapshotError::Corrupt(
                        "function state: body names no segment",
                    ));
                };
                let Some(end) = start.checked_add(row.body_len) else {
                    return Err(SnapshotError::Corrupt(
                        "function state: body range overflow",
                    ));
                };
                if end > code.len() as u64 {
                    return Err(SnapshotError::Corrupt(
                        "function state: body range outside segment",
                    ));
                }
                let mut pc = start as usize;
                let end = end as usize;
                while pc < end {
                    let Some(len) = ironhorse_vm::instruction_len(code, pc) else {
                        return Err(SnapshotError::Corrupt(
                            "function state: malformed body bytecode",
                        ));
                    };
                    pc = pc.saturating_add(len);
                }
                if pc != end {
                    return Err(SnapshotError::Corrupt(
                        "function state: body instruction crosses its range",
                    ));
                }
                referenced_segments.insert(segment);
            }
            (None, None) if bound_owners.contains(&row.owner) => {}
            _ => {
                return Err(SnapshotError::Corrupt(
                    "function state: body and segment disagree",
                ))
            }
        }
    }
    if referenced_segments.len() != lang.function_state.segments.len()
        || referenced_segments
            .iter()
            .copied()
            .ne(0..lang.function_state.segments.len() as u32)
    {
        return Err(SnapshotError::Corrupt(
            "function state: segments not densely referenced",
        ));
    }
    for row in &lang.function_state.bound_functions {
        owned(row.owner)?;
        owned(row.target)?;
        if !function_owners.contains(&row.owner) {
            return Err(SnapshotError::Corrupt(
                "bound-function state: owner has no function row",
            ));
        }
        check(&row.this_arg)?;
        for arg in &row.args {
            check(arg)?;
        }
    }
    for &(owner, prototype) in &lang.function_state.ctor_prototypes {
        owned(owner)?;
        owned(prototype)?;
        if !function_owners.contains(&owner) {
            return Err(SnapshotError::Corrupt(
                "constructor-prototype state: owner has no function row",
            ));
        }
    }
    for &(owner, id) in &lang.function_state.deleted_meta {
        owned(owner)?;
        if id == 0 || id as usize > names_len {
            return Err(SnapshotError::Corrupt(
                "deleted-function metadata: id outside the name table",
            ));
        }
    }
    let proxy_owners: std::collections::BTreeSet<u32> = lang
        .proxy_state
        .proxies
        .iter()
        .map(|row| row.owner)
        .collect();
    for row in &lang.proxy_state.proxies {
        owned(row.owner)?;
        if row.revoked {
            if row.target != u32::MAX || row.handler != u32::MAX {
                return Err(SnapshotError::Corrupt(
                    "proxy state: revoked proxy retains target or handler",
                ));
            }
        } else {
            owned(row.target)?;
            owned(row.handler)?;
        }
    }
    for row in &lang.proxy_state.revokers {
        owned(row.owner)?;
        if !proxy_owners.contains(&row.proxy) {
            return Err(SnapshotError::Corrupt(
                "proxy revoker names no proxy row",
            ));
        }
        if row.name_chunk != u32::MAX {
            let offset = row.name_chunk as usize;
            if offset < CHUNK_HEADER || offset > chunk_len {
                return Err(OOC);
            }
        }
    }
    let symbol_ids = symbols.id_set();
    for row in lang.accessors {
        owned(row.owner)?;
        if row.id == 0
            || (row.id as usize > names_len && !symbol_ids.contains(&row.id))
        {
            return Err(SnapshotError::Corrupt(
                "accessor state: id outside the property-key tables",
            ));
        }
        for value in [row.get, row.set].into_iter().flatten() {
            if value.kind != Kind::Reference {
                return Err(SnapshotError::Corrupt(
                    "accessor state: getter or setter is not callable",
                ));
            }
            check(&value)?;
        }
    }
    for row in lang.intl_bound_functions {
        owned(row.function)?;
        owned(row.owner)?;
        if row.name_chunk != u32::MAX {
            let offset = row.name_chunk as usize;
            if offset < CHUNK_HEADER || offset > chunk_len {
                return Err(OOC);
            }
        }
        let owner_exists = match row.kind {
            0 => lang
                .intl
                .collators
                .binary_search_by_key(&row.owner, |(owner, _)| *owner)
                .is_ok(),
            1 => lang
                .intl
                .number_formats
                .binary_search_by_key(&row.owner, |(owner, _)| *owner)
                .is_ok(),
            _ => false,
        };
        if !owner_exists {
            return Err(SnapshotError::Corrupt(
                "Intl bound-function state: owner has no Intl row",
            ));
        }
    }
    let private_value_keys: std::collections::BTreeSet<(u32, u32)> = lang
        .private_elements
        .values
        .iter()
        .map(|row| (row.receiver, row.brand))
        .collect();
    for row in &lang.private_elements.values {
        owned(row.receiver)?;
        owned(row.brand)?;
        check(&row.value)?;
    }
    for row in &lang.private_elements.accessors {
        owned(row.receiver)?;
        owned(row.brand)?;
        if private_value_keys.contains(&(row.receiver, row.brand)) {
            return Err(SnapshotError::Corrupt(
                "private elements: key has both value and accessor rows",
            ));
        }
        for value in [row.get, row.set].into_iter().flatten() {
            if value.kind != Kind::Reference {
                return Err(SnapshotError::Corrupt(
                    "private accessors: getter or setter is not callable",
                ));
            }
            check(&value)?;
        }
    }
    for row in lang.disposable_stacks {
        owned(row.owner)?;
        for record in &row.records {
            check(&record.resource)?;
            check(&record.method)?;
            if record.method.kind != Kind::Reference {
                return Err(SnapshotError::Corrupt(
                    "disposable stacks: disposal method is not callable",
                ));
            }
        }
    }
    let mut body_starts: std::collections::HashMap<u32, std::collections::BTreeSet<u64>> =
        std::collections::HashMap::new();
    for row in lang.generators {
        owned(row.owner)?;
        let Some(frame) = &row.frame else {
            continue;
        };
        owned(frame.cur_func)?;
        if frame.target_func != u32::MAX {
            owned(frame.target_func)?;
        }
        for slot in frame
            .locals
            .iter()
            .chain(&frame.args)
            .chain(&frame.stack_slice)
            .chain([&frame.this_val, &frame.env, &frame.result])
        {
            check(slot)?;
        }
        let function = lang
            .function_state
            .functions
            .binary_search_by_key(&frame.cur_func, |function| function.owner)
            .ok()
            .and_then(|index| lang.function_state.functions.get(index))
            .ok_or(SnapshotError::Corrupt(
                "generator frame: current function has no function row",
            ))?;
        let code = function
            .segment
            .and_then(|segment| lang.function_state.segments.get(segment as usize))
            .ok_or(SnapshotError::Corrupt(
                "generator frame: current function has no segment",
            ))?;
        // A segment holds every function its crank compiled, so a
        // segment-wide bound is far too loose for a resume cursor: it
        // admits the segment end, a byte inside an instruction's
        // operand or payload, and a perfectly valid instruction start
        // belonging to a DIFFERENT body. Each of those enters dispatch
        // at a pc the generator never suspended at. The cursor and
        // every saved-handler target must instead be an instruction
        // START within `cur_func`'s OWN `[body_start, body_end)` --
        // the same walk the function-state gate above already proved
        // sizes cleanly to its end. Memoized per function because a
        // crafted image may name one large body from arbitrarily many
        // generator rows.
        let starts = match body_starts.entry(frame.cur_func) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let Some(body_start) = function.body_start else {
                    return Err(SnapshotError::Corrupt(
                        "generator frame: current function has no body",
                    ));
                };
                let Some(body_end) = body_start.checked_add(function.body_len) else {
                    return Err(SnapshotError::Corrupt(
                        "generator frame: current function has no body",
                    ));
                };
                let mut set = std::collections::BTreeSet::new();
                let mut pc = body_start as usize;
                while pc < body_end as usize {
                    let Some(len) = ironhorse_vm::instruction_len(code, pc) else {
                        return Err(SnapshotError::Corrupt(
                            "generator frame: malformed body bytecode",
                        ));
                    };
                    set.insert(pc as u64);
                    pc = pc.saturating_add(len);
                }
                // A NESTED function's bytecode lives INSIDE its
                // enclosing body's range -- a generator declaring
                // `var h = function () {...}` owns a body that
                // physically contains h's -- so the walk above collects
                // h's instruction starts too, and a cursor pointing at
                // one would enter h's code with the GENERATOR's frame.
                // That is the same "a pc in another function body"
                // class the sibling-body arm closes, one level down, so
                // subtract every contained body.
                for other in &lang.function_state.functions {
                    if other.owner == frame.cur_func || other.segment != function.segment {
                        continue;
                    }
                    let (Some(start), Some(end)) = (
                        other.body_start,
                        other
                            .body_start
                            .and_then(|s| s.checked_add(other.body_len)),
                    ) else {
                        continue;
                    };
                    if start >= body_start && end <= body_end {
                        set.retain(|&pc| pc < start || pc >= end);
                    }
                }
                e.insert(set)
            }
        };
        if !starts.contains(&frame.resume_pc)
            || frame
                .id_map
                .iter()
                .any(|&(id, index)| {
                    id == 0 || id as usize > names_len || index >= frame.locals.len() as u64
                })
        {
            return Err(SnapshotError::Corrupt(
                "generator frame: invalid resume cursor or scope map",
            ));
        }
        for jump in &frame.jumps {
            check(&jump.env)?;
            // The handler's `id_map` is bounded by the handler's OWN
            // `locals_len` -- the length its resumed `catch` resolves
            // against -- not by the frame's current locals. A shorter
            // `locals_len` with an index in between passed the frame's
            // bound and then misresolved a name on the way out.
            // `call_depth_offset` is the fifth attacker-controlled number
            // on this row and the only one the gate used to skip, while
            // restore computes `return_depth + jump.call_depth_offset`
            // unchecked -- an arithmetic panic on a crafted value under
            // the dev profile, and a handler scoped to an impossible
            // call depth otherwise.
            //
            // The structural bound is exact, not a chosen constant: a
            // generator suspends at a `yield` in its OWN body, so every
            // call it made has returned and every saved handler belongs
            // to that same activation. The offset is therefore always
            // zero. Measured across five shapes -- a bare yield, a
            // yield inside try/finally, a nested try, a yield after a
            // call returns, and `yield*` delegation -- all emit 0.
            if jump.flag != 1
                || jump.call_depth_offset != 0
                || !starts.contains(&jump.target_pc)
                || jump.stack_offset > frame.stack_slice.len() as u64
                || jump.locals_len > frame.locals.len() as u64
                || jump.id_map.iter().any(|&(id, index)| {
                    id == 0 || id as usize > names_len || index >= jump.locals_len
                })
            {
                return Err(SnapshotError::Corrupt(
                    "generator frame: invalid saved handler",
                ));
            }
        }
    }
    // The promise cluster: owners, settlement results, and reaction
    // slots bounded like every sibling's; a resolving function's name
    // chunk ranged like a function row's — with NO null exemption,
    // because `make_resolving_functions` always interns a real empty
    // chunk and reading a NULL one faults. A combinator's results
    // Array must name an `ARRY` row (the element drain writes through
    // the dense store), the view-names-a-buffer-row discipline. Its
    // capability callbacks are bounded like every other carried Slot.
    for row in &lang.promise_cluster.promises {
        owned(row.owner)?;
        check(&row.result)?;
        for r in &row.reactions {
            check(&r.on_fulfilled)?;
            check(&r.on_rejected)?;
            check(&r.resolve)?;
            check(&r.reject)?;
        }
    }
    for row in &lang.promise_cluster.functions {
        owned(row.function)?;
        owned(row.promise)?;
        let offset = row.name_chunk as usize;
        if offset < CHUNK_HEADER || offset > chunk_len {
            return Err(OOC);
        }
    }
    let mut results_lengths = Vec::with_capacity(lang.promise_cluster.combinators.len());
    for row in &lang.promise_cluster.combinators {
        check(&row.resolve)?;
        check(&row.reject)?;
        owned(row.results)?;
        let Ok(k) = arrays.binary_search_by_key(&row.results, |a| a.owner) else {
            return Err(SnapshotError::Corrupt(
                "promise cluster: combinator's results Array has no row",
            ));
        };
        let len = arrays[k].length;
        // `remaining` starts at the ELEMENT COUNT — which is exactly
        // the results Array's preset length — and only ever
        // decrements, so a value above it can only be crafted (it
        // would leave the combinator pending after every surviving
        // reaction drains). A `race` never decrements at all, so its
        // remaining still EQUALS the count.
        if row.remaining > len || (row.kind == 2 && row.remaining != len) {
            return Err(SnapshotError::Corrupt(
                "promise cluster: remaining outside its element count",
            ));
        }
        results_lengths.push(len);
    }
    // A combinator reaction's element index writes the results Array at
    // the drain (`array_set_dense` grows `length` to cover it) — and on
    // the `any` path the AggregateError builder then iterates
    // `0..length`. The combinator presets `length` to its ELEMENT COUNT
    // at creation and every honest element index sits below it, so an
    // index at or past the row's carried length can only be crafted:
    // unchecked, it resumes a machine whose accumulator no execution
    // produces (and a huge one turns the aggregate walk into a
    // billions-long loop). This is a cross-ATOM check, so it lives here
    // beside the results-names-a-row gate, not in the atom decoder.
    for r in lang
        .promise_cluster
        .promises
        .iter()
        .flat_map(|row| row.reactions.iter())
    {
        if (r.kind == 2 || r.kind == 12)
            && results_lengths
                .get(r.a as usize)
                .is_none_or(|len| r.b >= *len)
        {
            return Err(SnapshotError::Corrupt(
                "promise cluster: element index outside the results Array",
            ));
        }
    }
    for &o in lang.arguments_brands {
        owned(o)?;
    }
    for &(o, _) in &lang.temporal.instants {
        owned(o)?;
    }
    for &(o, _) in &lang.temporal.durations {
        owned(o)?;
    }
    for &(o, _, _, _) in &lang.temporal.plains {
        owned(o)?;
    }
    for (o, _, _, _) in &lang.temporal.zoneds {
        owned(*o)?;
    }
    // The Intl rows: weak owners bounded like every sibling's, and a
    // segment ITERATOR must name an owner with a segments ROW whose
    // list covers its cursor — the view-names-a-buffer-row discipline.
    for o in lang
        .intl
        .locales
        .iter()
        .map(|(o, _)| *o)
        .chain(lang.intl.collators.iter().map(|(o, _)| *o))
        .chain(lang.intl.list_formats.iter().map(|(o, _)| *o))
        .chain(lang.intl.plural_rules.iter().map(|(o, _)| *o))
        .chain(lang.intl.number_formats.iter().map(|(o, _)| *o))
        .chain(lang.intl.segmenters.iter().map(|(o, _)| *o))
        .chain(lang.intl.segments.iter().map(|(o, _)| *o))
        .chain(lang.intl.segment_iterators.iter().map(|(o, _)| *o))
        .chain(lang.intl.date_time_formats.iter().map(|(o, _)| *o))
    {
        owned(o)?;
    }
    for (_, it) in &lang.intl.segment_iterators {
        let row = lang
            .intl
            .segments
            .binary_search_by_key(&it.segments_inst.0, |(o, _)| *o);
        let covered = match row {
            Ok(k) => it.pos <= lang.intl.segments[k].1.segments.len(),
            Err(_) => false,
        };
        if it.segments_inst.0 >= slot_count || !covered {
            return Err(SnapshotError::Corrupt(
                "intl side table: segment iterator names no covering segments row",
            ));
        }
    }
    // The iterator cursors: weak owner and result slots bounded; a
    // collection cursor must name a COVERING collections row (its
    // `next()` indexes the table unconditionally) with the carried
    // ordinal inside the compacted live list; a RegExp String Iterator must
    // carry valid mode bits and UTF-16; a for-in cursor's key ids must live in
    // the restored name table.
    for r in iterators {
        owned(r.owner)?;
        owned(r.result)?;
        if r.iterable != u32::MAX {
            owned(r.iterable)?;
        }
        if (5..=7).contains(&r.kind) {
            let row = collections.binary_search_by_key(&r.iterable, |c| c.owner);
            let covered = match row {
                Ok(k) => r.index as usize <= collections[k].entries.len(),
                Err(_) => false,
            };
            if !covered {
                return Err(SnapshotError::Corrupt(
                    "iterator cursors: collection cursor names no covering row",
                ));
            }
        }
        if r.kind == 8
            && (r.iterable == u32::MAX
                || r.result == u32::MAX
                || r.index != 0
                || r.done
                || !r.enum_keys.is_empty()
                || !r.str_bytes.is_empty())
        {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: malformed Iterator.from wrapper",
            ));
        }
        if r.kind == 9
            && (r.iterable == u32::MAX
                || r.result == u32::MAX
                || r.index > 3
                || !r.enum_keys.is_empty()
                || r.str_bytes.len() % 2 != 0)
        {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: invalid RegExp String Iterator",
            ));
        }
        if r.kind == 3
            && r.enum_keys
                .iter()
                .any(|&(id, _)| id != 0 && id as usize > names_len)
        {
            return Err(SnapshotError::Corrupt(
                "iterator cursors: for-in key id outside the name table",
            ));
        }
    }
    for &(_, desc) in &symbols.pairs {
        owned(desc)?;
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
    if !image.errors.is_empty() {
        w.atom(crate::format::ERRD, &encode_errors(&image.errors));
        // Emitted only when some error actually captured frames, so a
        // machine whose errors have none writes byte-identically to
        // before this atom existed.
        if image.errors.iter().any(|e| !e.frames.is_empty()) {
            w.atom(crate::format::ESTK, &encode_error_frames(&image.errors));
        }
    }
    if !image.buffers.is_empty() {
        w.atom(crate::format::ABUF, &encode_buffers(&image.buffers));
    }
    if !image.typed_arrays.is_empty() {
        w.atom(crate::format::TARR, &encode_typed_arrays(&image.typed_arrays));
    }
    if !image.data_views.is_empty() {
        w.atom(crate::format::DVIW, &encode_data_views(&image.data_views));
    }
    if !image.wrappers.is_empty() {
        w.atom(crate::format::WRAP, &encode_wrappers(&image.wrappers));
    }
    if !image.regexps.is_empty() {
        w.atom(crate::format::REGX, &encode_regexps(&image.regexps));
    }
    if !image.arguments_brands.is_empty() {
        w.atom(
            crate::format::ARGB,
            &encode_arguments_brands(&image.arguments_brands),
        );
    }
    if !image.temporal.is_empty() {
        w.atom(crate::format::TMPR, &encode_temporal(&image.temporal));
    }
    if !image.intl.is_empty() {
        w.atom(crate::format::INTL, &encode_intl(&image.intl));
    }
    if !image.iterators.is_empty() {
        w.atom(crate::format::ITER, &encode_iterators(&image.iterators));
    }
    if !image.dates.is_empty() {
        w.atom(crate::format::DATE, &encode_dates(&image.dates));
    }
    if !image.function_state.is_empty() {
        w.atom(
            crate::format::FUNC,
            &encode_function_state(&image.function_state),
        );
    }
    if !image.proxy_state.is_empty() {
        w.atom(
            crate::format::PROX,
            &encode_proxy_state(&image.proxy_state),
        );
    }
    if !image.accessors.is_empty() {
        w.atom(crate::format::ACCS, &encode_accessors(&image.accessors));
    }
    if !image.intl_bound_functions.is_empty() {
        w.atom(
            crate::format::IBFN,
            &encode_intl_bound_functions(&image.intl_bound_functions),
        );
    }
    if !image.private_elements.is_empty() {
        w.atom(
            crate::format::PRIV,
            &encode_private_elements(&image.private_elements),
        );
    }
    if !image.disposable_stacks.is_empty() {
        w.atom(
            crate::format::DISP,
            &encode_disposable_stacks(&image.disposable_stacks),
        );
    }
    if !image.generators.is_empty() {
        w.atom(crate::format::GENR, &encode_generators(&image.generators));
    }
    if !image.promise_cluster.is_empty() {
        w.atom(
            crate::format::PRMS,
            &encode_promise_cluster(&image.promise_cluster),
        );
    }
    // The installed-names floor: `Some` only when it differs from the
    // name-table length (`with_name_floor` canonicalizes), so machines
    // whose floor sits at the table stay byte-stable with every
    // pre-floor container.
    if let Some(floor) = image.name_floor {
        w.atom(crate::format::NFLR, &floor.to_be_bytes());
    }
    w.finish()
}

/// Parse an `XS_M` atom container into a machine image, enforcing the
/// ironhorse `VERS` discriminator and checking the host callback-table
/// `SIGN` against `expected_sig` — a mismatch fails closed exactly as
/// `fxReadSnapshot` does (a callback index would bind the wrong host
/// function). Pass the machine's current signature.
///
/// This low-level API returns a mutable plain-data model for tooling and
/// crafted-input tests. Machine adoption uses [`read_validated_machine`], whose
/// private wrapper prevents mutation between this validation and restore.
/// An optional side-table atom the writer emits only when its table is
/// NON-EMPTY. A present-but-empty one can therefore only be crafted,
/// and accepting it would re-canonicalize on the next write -- the same
/// rule the `NFLR` floor already enforces, and the reason it matters is
/// the same: one logical machine must have exactly one container
/// encoding, or its SHA-256 CAS key is not an identity.
fn present_and_non_empty<T>(rows: Vec<T>, what: &'static str) -> Result<Vec<T>, SnapshotError> {
    if rows.is_empty() {
        return Err(SnapshotError::Corrupt(what));
    }
    Ok(rows)
}

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

    // The canonical atom GRAMMAR (the round-3 hardening follow-up):
    // the sequence must be an in-order subsequence of the writer's
    // emission order with no foreign tags. Checked after the VERS and
    // SIGN gates so a newer-format container — the one honest source
    // of tags this reader does not know — refuses by VERSION, and the
    // grammar refusal is reserved for what can only be crafted.
    let mut order_cursor = 0usize;
    for atom in r.atoms() {
        match crate::format::CANONICAL_ATOM_ORDER[order_cursor..]
            .iter()
            .position(|tag| *tag == atom.tag)
        {
            Some(advance) => order_cursor += advance + 1,
            None => {
                return Err(SnapshotError::Corrupt(
                    "container atoms out of canonical order or unknown",
                ))
            }
        }
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
    // The write verbs persist only QUIESCENT machines, and quiescence
    // includes an empty value stack — so a populated `STAC` cannot come
    // from an honest writer, and adopting one would seed a machine that
    // can neither run nor checkpoint safely (review finding 5: the
    // reader must enforce what the writer enforces).
    if !stack.is_empty() {
        return Err(SnapshotError::Corrupt(
            "STAC not empty at a quiescent boundary",
        ));
    }
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
        Some(a) => present_and_non_empty(decode_arrays(a.payload)?, "ARRY atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let collections = match r.find(crate::format::COLL) {
        Some(a) => present_and_non_empty(decode_collections(a.payload)?, "COLL atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let registry = match r.find(crate::format::REGY) {
        Some(a) => present_and_non_empty(decode_registry(a.payload)?, "REGY atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let mut errors = match r.find(crate::format::ERRD) {
        Some(a) => present_and_non_empty(decode_errors(a.payload)?, "ERRD atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    // Join the frames back onto their rows. An owner naming no `ERRD`
    // row is crafted: the writer emits frames only for errors it also
    // emitted — and emits the ATOM only when some row exists, so a
    // present-but-empty one is the same non-canonical shape every
    // optional atom refuses (a zero row COUNT; a zero-length frame
    // LIST inside a row is refused by the decoder itself).
    if let Some(a) = r.find(crate::format::ESTK) {
        let rows = decode_error_frames(a.payload)?;
        if rows.is_empty() {
            return Err(SnapshotError::Corrupt(
                "ESTK atom present but empty; the writer omits it",
            ));
        }
        for (owner, frames) in rows {
            let Some(row) = errors.iter_mut().find(|e| e.owner == owner) else {
                return Err(SnapshotError::Corrupt(
                    "error-frame side table: owner has no error row",
                ));
            };
            row.frames = frames;
        }
    }
    let buffers = match r.find(crate::format::ABUF) {
        Some(a) => present_and_non_empty(decode_buffers(a.payload)?, "ABUF atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let typed_arrays = match r.find(crate::format::TARR) {
        Some(a) => present_and_non_empty(decode_typed_arrays(a.payload)?, "TARR atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let data_views = match r.find(crate::format::DVIW) {
        Some(a) => present_and_non_empty(decode_data_views(a.payload)?, "DVIW atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let wrappers = match r.find(crate::format::WRAP) {
        Some(a) => present_and_non_empty(decode_wrappers(a.payload)?, "WRAP atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let regexps = match r.find(crate::format::REGX) {
        Some(a) => present_and_non_empty(decode_regexps(a.payload)?, "REGX atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let arguments_brands = match r.find(crate::format::ARGB) {
        Some(a) => present_and_non_empty(decode_arguments_brands(a.payload)?, "ARGB atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let temporal = match r.find(crate::format::TMPR) {
        Some(a) => {
            let t = decode_temporal(a.payload)?;
            if t.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "TMPR atom present but empty; the writer omits it",
                ));
            }
            t
        }
        None => TemporalImage::default(),
    };
    let intl = match r.find(crate::format::INTL) {
        Some(a) => {
            let t = decode_intl(a.payload)?;
            if t.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "INTL atom present but empty; the writer omits it",
                ));
            }
            t
        }
        None => IntlTables::default(),
    };
    let iterators = match r.find(crate::format::ITER) {
        Some(a) => present_and_non_empty(decode_iterators(a.payload)?, "ITER atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let dates = match r.find(crate::format::DATE) {
        Some(a) => present_and_non_empty(decode_dates(a.payload)?, "DATE atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let function_state = match r.find(crate::format::FUNC) {
        Some(a) => {
            let state = decode_function_state(a.payload)?;
            if state.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "FUNC atom present but empty; the writer omits it",
                ));
            }
            state
        }
        None => ironhorse_vm::FunctionStateSnapshot::default(),
    };
    let proxy_state = match r.find(crate::format::PROX) {
        Some(a) => {
            let state = decode_proxy_state(a.payload)?;
            if state.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "PROX atom present but empty; the writer omits it",
                ));
            }
            state
        }
        None => ironhorse_vm::ProxyStateSnapshot::default(),
    };
    let accessors = match r.find(crate::format::ACCS) {
        Some(a) => present_and_non_empty(decode_accessors(a.payload)?, "ACCS atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let intl_bound_functions = match r.find(crate::format::IBFN) {
        Some(a) => present_and_non_empty(decode_intl_bound_functions(a.payload)?, "IBFN atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let private_elements = match r.find(crate::format::PRIV) {
        Some(a) => {
            let state = decode_private_elements(a.payload)?;
            if state.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "PRIV atom present but empty; the writer omits it",
                ));
            }
            state
        }
        None => ironhorse_vm::PrivateElementSnapshot::default(),
    };
    let disposable_stacks = match r.find(crate::format::DISP) {
        Some(a) => present_and_non_empty(decode_disposable_stacks(a.payload)?, "DISP atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let generators = match r.find(crate::format::GENR) {
        Some(a) => present_and_non_empty(decode_generators(a.payload)?, "GENR atom present but empty; the writer omits it")?,
        None => Vec::new(),
    };
    let promise_cluster = match r.find(crate::format::PRMS) {
        Some(a) => {
            let cluster = decode_promise_cluster(a.payload)?;
            if cluster.is_empty() {
                return Err(SnapshotError::Corrupt(
                    "PRMS atom present but empty; the writer omits it",
                ));
            }
            cluster
        }
        None => ironhorse_vm::PromiseClusterSnapshot::default(),
    };
    let name_floor = match r.find(crate::format::NFLR) {
        Some(a) => {
            if a.payload.len() != 4 {
                return Err(SnapshotError::Corrupt("installed-names floor size"));
            }
            let floor = u32::from_be_bytes([a.payload[0], a.payload[1], a.payload[2], a.payload[3]]);
            // A floor past the name table cannot come from an honest
            // suspension — installs only ever floor at a table length
            // the machine actually had.
            if floor as usize > names.len() {
                return Err(SnapshotError::Corrupt(
                    "installed-names floor past the name table",
                ));
            }
            // A floor AT the table length is the fully-installed state
            // every writer canonicalizes as an ABSENT atom
            // (`with_name_floor`); an explicit one can only be crafted,
            // and accepting it re-canonicalizes on the next write —
            // breaking write(read(bytes)) == bytes (review).
            if floor as usize == names.len() {
                return Err(SnapshotError::Corrupt(
                    "installed-names floor: non-canonical explicit full floor",
                ));
            }
            Some(floor)
        }
        None => None,
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
        &errors,
        &buffers,
        &typed_arrays,
        &data_views,
        &LangRows {
            wrappers: &wrappers,
            regexps: &regexps,
            dates: &dates,
            function_state: &function_state,
            proxy_state: &proxy_state,
            accessors: &accessors,
            intl_bound_functions: &intl_bound_functions,
            private_elements: &private_elements,
            disposable_stacks: &disposable_stacks,
            generators: &generators,
            promise_cluster: &promise_cluster,
            arguments_brands: &arguments_brands,
            temporal: &temporal,
            intl: &intl,
        },
        &iterators,
        names.len(),
        &symbols,
        slots.len() as u32,
        chunks.len(),
        &slot_free,
    )?;

    // A container stamped with the CURRENT version must carry every
    // atom the current writer unconditionally emits — omitting one
    // (the reader would supply a default and the next write would put
    // it back) is one more second-encoding shape. Older versions in
    // the read range keep their recorded leniencies (e.g. the
    // pre-row-6 absent `METR`); their writers no longer run, so the
    // canonical-bytes property is claimed of current containers.
    // Checked LAST so a malformed atom refuses by its own decoder's
    // name first — this gate is about honest-looking omissions.
    if version.format_version == crate::format::IRONHORSE_FORMAT_VERSION {
        for tag in [VERS, SIGN, CREA, BLOC, HEAP, STAC, KEYS, NAME, SYMB, METR] {
            if r.find(tag).is_none() {
                return Err(SnapshotError::Corrupt(
                    "container missing an atom its version always writes",
                ));
            }
        }
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
        arrays,
        collections,
        registry,
        errors,
        buffers,
        typed_arrays,
        data_views,
        wrappers,
        regexps,
        dates,
        function_state,
        proxy_state,
        accessors,
        intl_bound_functions,
        private_elements,
        disposable_stacks,
        generators,
        promise_cluster,
        arguments_brands,
        temporal,
        intl,
        iterators,
        name_floor,
    })
}

/// Decode and validate container bytes into the proof-carrying image accepted
/// by the restore boundary.
///
/// [`read_machine`] remains the low-level inspection API. Adoption paths use
/// this function so no publicly mutable [`MachineImage`] exists between
/// validation and restore.
pub fn read_validated_machine(
    buf: &[u8],
    expected_sig: &Signature,
) -> Result<ValidatedSnapshot, SnapshotError> {
    let image = read_machine(buf, expected_sig)?;
    if image.stored_unregistered_key_id().is_some() {
        return Err(SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        ));
    }
    Ok(ValidatedSnapshot::from_validated_image(image))
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
    fn error_data_decode_refuses_crafted_rows() {
        // Duplicate owner: restore would displace the first row.
        let dup = vec![
            ErrorImage { owner: 3, name: "Error".to_string(), message: None , frames: Vec::new() },
            ErrorImage { owner: 3, name: "TypeError".to_string(), message: None , frames: Vec::new() },
        ];
        assert!(matches!(
            decode_errors(&encode_errors(&dup)),
            Err(SnapshotError::Corrupt(_))
        ));
        // A name outside the engine's closed error-name set can only be
        // crafted or torn bytes — the vm has no `&'static str` for it.
        let unknown = vec![ErrorImage {
            owner: 1,
            name: "NotAnError".to_string(),
            message: None,
                frames: Vec::new(),
        }];
        assert!(matches!(
            decode_errors(&encode_errors(&unknown)),
            Err(SnapshotError::Corrupt(_))
        ));
        // A message flag byte outside 0/1 is a non-canonical encoding.
        let mut bytes = encode_errors(&[ErrorImage {
            owner: 1,
            name: "Error".to_string(),
            message: None,
                frames: Vec::new(),
        }]);
        *bytes.last_mut().unwrap() = 2;
        assert!(matches!(
            decode_errors(&bytes),
            Err(SnapshotError::Corrupt(_))
        ));
        // The well-formed rows round-trip, message halves preserved.
        let ok = vec![
            ErrorImage { owner: 2, name: "RangeError".to_string(), message: Some("r".to_string()) , frames: Vec::new() },
            ErrorImage { owner: 7, name: "SuppressedError".to_string(), message: None , frames: Vec::new() },
        ];
        assert_eq!(decode_errors(&encode_errors(&ok)).unwrap(), ok);
        // And an out-of-arena owner is refused by the bounds gate.
        let oob = vec![ErrorImage { owner: 9, name: "Error".to_string(), message: None, frames: Vec::new() }];
        assert!(check_image_slot_bounds(
            &[],
            &[],
            &[],
            &[],
            &[],
            &oob,
            &[],
            &[],
            &[],
            &LangRows::EMPTY,
            &[],
            0,
            &SymbolKeyImage::default(),
            4,
            64
        , &[])
        .is_err());
    }

    #[test]
    fn date_decode_preserves_raw_bits_and_refuses_duplicate_owners() {
        let rows = vec![
            DateImage { owner: 2, value_bits: (-0.0f64).to_bits() },
            DateImage { owner: 7, value_bits: 0x7ff8_0000_0000_0042 },
        ];
        assert_eq!(decode_dates(&encode_dates(&rows)).unwrap(), rows);

        let duplicate = vec![
            DateImage { owner: 3, value_bits: 1.0f64.to_bits() },
            DateImage { owner: 3, value_bits: 2.0f64.to_bits() },
        ];
        assert!(matches!(
            decode_dates(&encode_dates(&duplicate)),
            Err(SnapshotError::Corrupt(_))
        ));
    }

    #[test]
    fn typed_array_family_decode_refuses_crafted_rows() {
        // Unknown flag bits on a buffer row.
        let bad_flags = vec![BufferImage { owner: 1, data: 4, length: 8, flags: 4 }];
        assert!(matches!(
            decode_buffers(&encode_buffers(&bad_flags)),
            Err(SnapshotError::Corrupt(_))
        ));
        // Duplicate owners in each table.
        let dup_buf = vec![
            BufferImage { owner: 2, data: 4, length: 8, flags: 0 },
            BufferImage { owner: 2, data: 16, length: 8, flags: 0 },
        ];
        assert!(matches!(
            decode_buffers(&encode_buffers(&dup_buf)),
            Err(SnapshotError::Corrupt(_))
        ));
        // Unknown element kind on a view row.
        let bad_kind = vec![TypedArrayImage { owner: 1, kind: 200, buffer: 2, offset: 0, length: 1 }];
        assert!(matches!(
            decode_typed_arrays(&encode_typed_arrays(&bad_kind)),
            Err(SnapshotError::Corrupt(_))
        ));
        // Unordered data-view owners.
        let unordered = vec![
            DataViewImage { owner: 5, buffer: 1, offset: 0, size: 1 },
            DataViewImage { owner: 3, buffer: 1, offset: 0, size: 1 },
        ];
        assert!(matches!(
            decode_data_views(&encode_data_views(&unordered)),
            Err(SnapshotError::Corrupt(_))
        ));
        // The well-formed rows round-trip.
        let ok_b = vec![
            BufferImage { owner: 1, data: 4, length: 8, flags: 0b10 },
            BufferImage { owner: 3, data: 16, length: 0, flags: 0b01 },
        ];
        assert_eq!(decode_buffers(&encode_buffers(&ok_b)).unwrap(), ok_b);
        let ok_t = vec![TypedArrayImage { owner: 2, kind: 0, buffer: 1, offset: 0, length: 8 }];
        assert_eq!(decode_typed_arrays(&encode_typed_arrays(&ok_t)).unwrap(), ok_t);
        let ok_d = vec![DataViewImage { owner: 2, buffer: 1, offset: 4, size: 4 }];
        assert_eq!(decode_data_views(&encode_data_views(&ok_d)).unwrap(), ok_d);
    }

    #[test]
    fn typed_array_family_bounds_refuse_crafted_geometry() {
        let sym = SymbolKeyImage::default();
        // A buffer whose backing extent runs past the chunk arena.
        let past = vec![BufferImage { owner: 1, data: 60, length: 8, flags: 0 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &past, &[], &[], &LangRows::EMPTY, &[], 0, &sym, 4, 64, &[]).is_err());
        // A buffer whose offset sits inside the chunk header.
        let low = vec![BufferImage { owner: 1, data: 2, length: 8, flags: 0 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &low, &[], &[], &LangRows::EMPTY, &[], 0, &sym, 4, 64, &[]).is_err());
        // The NULL chunk sentinel is never valid backing, even when a
        // store advertises a chunk domain large enough to cover u32::MAX.
        let null = vec![BufferImage { owner: 1, data: u32::MAX, length: 0, flags: 0 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &null, &[], &[], &LangRows::EMPTY, &[], 0, &sym, 4, usize::MAX, &[]).is_err());
        // A view naming a buffer with NO row (an in-bounds slot is not
        // enough — restoring it would read through unbacked geometry).
        let orphan = vec![TypedArrayImage { owner: 2, kind: 0, buffer: 3, offset: 0, length: 1 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &[], &orphan, &[], &LangRows::EMPTY, &[], 0, &sym, 4, 64, &[]).is_err());
        // View geometry past its buffer's length (Uint32Array: shift 2).
        let buf = vec![BufferImage { owner: 1, data: 4, length: 8, flags: 0 }];
        let kind_u32 = ironhorse_vm::TYPED_ARRAY_TYPES
            .iter()
            .position(|t| t.shift == 2)
            .unwrap() as u8;
        let wide = vec![TypedArrayImage { owner: 2, kind: kind_u32, buffer: 1, offset: 4, length: 2 }];
        assert!(
            check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &buf, &wide, &[], &LangRows::EMPTY, &[], 0, &sym, 4, 64, &[]).is_err()
        );
        // A data view past its buffer.
        let dv = vec![DataViewImage { owner: 2, buffer: 1, offset: 6, size: 4 }];
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &buf, &[], &dv, &LangRows::EMPTY, &[], 0, &sym, 4, 64, &[]).is_err());
        // The covered forms pass.
        let fit_view = vec![TypedArrayImage { owner: 2, kind: kind_u32, buffer: 1, offset: 0, length: 2 }];
        let fit_dv = vec![DataViewImage { owner: 3, buffer: 1, offset: 4, size: 4 }];
        assert!(check_image_slot_bounds(
            &[], &[], &[], &[], &[], &[], &buf, &fit_view, &fit_dv, &LangRows::EMPTY, &[], 0, &sym, 4, 64
        , &[])
        .is_ok());
    }

    #[test]
    fn intl_decode_refuses_crafted_rows() {
        use ironhorse_vm::{CollatorData, DateTimeFormatData, SegmentsData};
        fn collator(owner: u32) -> (u32, CollatorData) {
            (
                owner,
                CollatorData {
                    locale: "en".into(),
                    usage: "sort".into(),
                    sensitivity: "variant".into(),
                    collation: "default".into(),
                    numeric: false,
                    case_first: "false".into(),
                    ignore_punctuation: false,
                },
            )
        }
        // Owners not strictly ascending.
        let mut t = IntlTables::default();
        t.collators = vec![collator(5), collator(3)];
        assert!(decode_intl(&encode_intl(&t)).is_err(), "non-ascending owners");
        // Segment boundaries outside their input.
        let mut t = IntlTables::default();
        t.segments = vec![(
            1,
            SegmentsData {
                units: vec![104, 105],
                segments: vec![(0, 5, false)],
                granularity: "word".into(),
            },
        )];
        assert!(decode_intl(&encode_intl(&t)).is_err(), "segment end past units");
        // Overlapping ranges (review): a start must equal the previous
        // END — the pre-review check compared previous STARTS, so
        // (0,2),(1,3) decoded silently.
        let mut t = IntlTables::default();
        t.segments = vec![(
            1,
            SegmentsData {
                units: vec![104, 105, 106],
                segments: vec![(0, 2, false), (1, 3, false)],
                granularity: "word".into(),
            },
        )];
        assert!(decode_intl(&encode_intl(&t)).is_err(), "overlapping segments");
        // Boundaries that do not COVER the input (ICU always emits the
        // final boundary at the unit count).
        let mut t = IntlTables::default();
        t.segments = vec![(
            1,
            SegmentsData {
                units: vec![104, 105, 106],
                segments: vec![(0, 2, false)],
                granularity: "word".into(),
            },
        )];
        assert!(decode_intl(&encode_intl(&t)).is_err(), "non-covering segments");
        // Unicode-extension keys: the writer emits BTreeMap order, so
        // unordered or duplicated keys are non-canonical crafted bytes
        // (review: silently re-canonicalizing broke byte identity).
        let mut unicode = std::collections::BTreeMap::new();
        unicode.insert("ca".to_string(), "vx".to_string());
        unicode.insert("nu".to_string(), "wy".to_string());
        let mut t = IntlTables::default();
        t.locales = vec![(
            1,
            ironhorse_vm::LocaleData {
                tag: "en".into(),
                language: "en".into(),
                script: None,
                region: None,
                variants: vec![],
                unicode,
            },
        )];
        let canonical = encode_intl(&t);
        let ca = canonical.windows(2).position(|w| w == b"ca").unwrap();
        let nu = canonical.windows(2).position(|w| w == b"nu").unwrap();
        let mut swapped = canonical.clone();
        swapped[ca..ca + 2].copy_from_slice(b"nu");
        swapped[nu..nu + 2].copy_from_slice(b"ca");
        assert!(decode_intl(&swapped).is_err(), "unordered unicode keys");
        let mut duped = canonical.clone();
        duped[nu..nu + 2].copy_from_slice(b"ca");
        assert!(decode_intl(&duped).is_err(), "duplicate unicode keys");
        assert_eq!(decode_intl(&canonical).unwrap(), t, "canonical order round-trips");
        // An unknown date-time component key is crafted bytes: the keys
        // are a closed engine set carried as statics.
        let mut t = IntlTables::default();
        t.date_time_formats = vec![(
            1,
            DateTimeFormatData {
                locale: "en".into(),
                calendar: "gregory".into(),
                numbering_system: "latn".into(),
                time_zone: "UTC".into(),
                offset_minutes: 0,
                hour_cycle: None,
                components: vec![("year", "numeric".into())],
                date_style: None,
                time_style: None,
            },
        )];
        let mut bytes = encode_intl(&t);
        let needle = b"year";
        let at = bytes.windows(4).position(|w| w == needle).unwrap();
        bytes[at..at + 4].copy_from_slice(b"yerp");
        assert!(decode_intl(&bytes).is_err(), "unknown component key");
        // A boolean byte outside 0/1.
        let mut t = IntlTables::default();
        t.collators = vec![collator(1)];
        let mut bytes = encode_intl(&t);
        // The `numeric` byte follows the four leading strings; find the
        // first 0x00 after the "default" text and poke it to 7.
        let at = bytes.windows(7).position(|w| w == b"default").unwrap() + 7;
        bytes[at] = 7;
        assert!(decode_intl(&bytes).is_err(), "boolean byte outside 0/1");
        // The intact forms round-trip.
        let mut ok = IntlTables::default();
        ok.collators = vec![collator(1), collator(4)];
        ok.segments = vec![(
            2,
            SegmentsData {
                units: vec![104, 105],
                segments: vec![(0, 2, true)],
                granularity: "word".into(),
            },
        )];
        assert_eq!(decode_intl(&encode_intl(&ok)).unwrap(), ok);
    }

    #[test]
    fn intl_bounds_refuse_crafted_iterators_and_owners() {
        use ironhorse_vm::{SegmentIteratorData, SegmentsData};
        let sym = SymbolKeyImage::default();
        let check = |intl: &IntlTables| {
            let lang = LangRows {
                wrappers: &[],
                regexps: &[],
                dates: &[],
                function_state: &EMPTY_FUNCTION_STATE,
                proxy_state: &EMPTY_PROXY_STATE,
                accessors: &[],
                intl_bound_functions: &[],
                private_elements: &EMPTY_PRIVATE_ELEMENTS,
                disposable_stacks: &[],
                generators: &[],
                promise_cluster: &EMPTY_PROMISE_CLUSTER,
                arguments_brands: &[],
                temporal: &EMPTY_TEMPORAL,
                intl,
            };
            check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &[], &[], &[], &lang, &[], 0, &sym, 4, 64, &[])
        };
        let segs = |owner: u32| {
            (
                owner,
                SegmentsData {
                    units: vec![104, 105],
                    segments: vec![(0, 2, true)],
                    granularity: "word".into(),
                },
            )
        };
        // An owner past the arena.
        let mut t = IntlTables::default();
        t.segments = vec![segs(9)];
        assert!(check(&t).is_err(), "owner past the arena");
        // An iterator naming an instance with NO segments row.
        let mut t = IntlTables::default();
        t.segments = vec![segs(1)];
        t.segment_iterators = vec![(
            2,
            SegmentIteratorData { segments_inst: ironhorse_vm::value::SlotIndex(3), pos: 0 },
        )];
        assert!(check(&t).is_err(), "iterator names no covering segments row");
        // A cursor past the precomputed list.
        let mut t = IntlTables::default();
        t.segments = vec![segs(1)];
        t.segment_iterators = vec![(
            2,
            SegmentIteratorData { segments_inst: ironhorse_vm::value::SlotIndex(1), pos: 5 },
        )];
        assert!(check(&t).is_err(), "cursor past the list");
        // The covered form passes (pos == len is the exhausted cursor).
        let mut t = IntlTables::default();
        t.segments = vec![segs(1)];
        t.segment_iterators = vec![(
            2,
            SegmentIteratorData { segments_inst: ironhorse_vm::value::SlotIndex(1), pos: 1 },
        )];
        assert!(check(&t).is_ok(), "a covering row with an in-range cursor passes");
    }

    #[test]
    fn iterator_decode_refuses_crafted_rows() {
        fn row(owner: u32) -> IteratorRow {
            IteratorRow {
                owner,
                kind: 0,
                iterable: 1,
                index: 0,
                done: false,
                result: 2,
                enum_keys: Vec::new(),
                str_bytes: Vec::new(),
            }
        }
        // Owners not strictly ascending.
        assert!(decode_iterators(&encode_iterators(&[row(5), row(3)])).is_err());
        // Unknown kind.
        let mut bad = row(1);
        bad.kind = 10;
        assert!(decode_iterators(&encode_iterators(&[bad])).is_err());
        // A string cursor splitting a UTF-16 unit, and one past its text.
        let mut odd = row(1);
        odd.kind = 4;
        odd.str_bytes = vec![0, 97, 0, 98];
        odd.index = 1;
        assert!(decode_iterators(&encode_iterators(&[odd.clone()])).is_err());
        odd.index = 6;
        assert!(decode_iterators(&encode_iterators(&[odd])).is_err());
        // A RegExp String Iterator must carry a matcher, an arena anchor, an
        // even-sized UTF-16 payload, and only its two mode bits in `index`.
        let mut regexp = row(1);
        regexp.kind = 9;
        regexp.index = 4;
        assert!(decode_iterators(&encode_iterators(&[regexp.clone()])).is_err());
        regexp.index = 3;
        regexp.str_bytes = vec![0];
        assert!(decode_iterators(&encode_iterators(&[regexp])).is_err());
        let mut regexp = row(1);
        regexp.kind = 9;
        regexp.iterable = u32::MAX;
        assert!(decode_iterators(&encode_iterators(&[regexp])).is_err());
        let mut regexp = row(1);
        regexp.kind = 9;
        regexp.enum_keys.push((1, 0));
        assert!(decode_iterators(&encode_iterators(&[regexp])).is_err());
        // A for-in cursor past its key list.
        let mut over = row(1);
        over.kind = 3;
        over.enum_keys = vec![(0, 0)];
        over.index = 2;
        assert!(decode_iterators(&encode_iterators(&[over])).is_err());
        // The intact forms round-trip.
        let mut s = row(3);
        s.kind = 4;
        s.iterable = u32::MAX;
        s.str_bytes = vec![0, 97, 0, 98];
        s.index = 2;
        let ok = vec![row(1), s];
        assert_eq!(decode_iterators(&encode_iterators(&ok)).unwrap(), ok);
    }

    #[test]
    fn iterator_bounds_refuse_crafted_cursors() {
        let sym = SymbolKeyImage::default();
        let check = |rows: &[IteratorRow], colls: &[CollectionImage], names_len: usize| {
            check_image_slot_bounds(
                &[], &[], &[], colls, &[], &[], &[], &[], &[], &LangRows::EMPTY, rows, names_len,
                &sym, 4, 64, &[],
            )
        };
        let coll = CollectionImage {
            owner: 1,
            kind: 0,
            table_length: 8,
            entries: vec![(Slot::integer(1), Slot::integer(2))],
        };
        let cursor = |iterable: u32, index: u32| IteratorRow {
            owner: 2,
            kind: 5,
            iterable,
            index,
            done: false,
            result: 3,
            enum_keys: Vec::new(),
            str_bytes: Vec::new(),
        };
        // A collection cursor naming an instance with NO covering row.
        assert!(check(&[cursor(0, 0)], std::slice::from_ref(&coll), 0).is_err());
        // A cursor past the compacted live list.
        assert!(check(&[cursor(1, 2)], std::slice::from_ref(&coll), 0).is_err());
        // The exhausted cursor (index == live count) passes.
        assert!(check(&[cursor(1, 1)], std::slice::from_ref(&coll), 0).is_ok());
        // A for-in key id outside the restored name table.
        let forin = IteratorRow {
            owner: 2,
            kind: 3,
            iterable: 1,
            index: 0,
            done: false,
            result: 3,
            enum_keys: vec![(7, 0)],
            str_bytes: Vec::new(),
        };
        assert!(check(std::slice::from_ref(&forin), &[], 3).is_err());
        assert!(check(std::slice::from_ref(&forin), &[], 7).is_ok());
        // An out-of-arena owner/result.
        let mut oob = cursor(1, 0);
        oob.result = 9;
        assert!(check(&[oob], std::slice::from_ref(&coll), 0).is_err());
    }

    #[test]
    fn image_bounds_reject_out_of_arena_indices() {
        // Wave 4 closed the three side tables; wave 5 showed the class is
        // wider — a container with NO side table at all panicked the
        // collector via an unchecked `marks[i]`. Each arm below is a
        // shape a reviewer actually crafted and reached a release panic
        // (or an abort) with. slot_count = 4, chunk_len = 64 throughout.
        let ok = |heap: &[Slot], stack: &[Slot]| {
            check_image_slot_bounds(heap, stack, &[], &[], &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[])
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
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &bad_desc, &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[]).is_err());
        // A symbol-key descriptor beyond the arena is refused the same way.
        let bad_sym = SymbolKeyImage {
            next_id: u16::MAX - 1,
            pairs: vec![(u16::MAX, 4)],
        };
        assert!(check_image_slot_bounds(&[], &[], &[], &[], &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &bad_sym, 4, 64, &[]).is_err());
        let bad_owner = [ArrayImage { owner: 9, length: 0, items: vec![] }];
        assert!(check_image_slot_bounds(&[], &[], &bad_owner, &[], &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[]).is_err());
        let bad_ref = [ArrayImage { owner: 1, length: 1, items: vec![(0, refd(9))] }];
        assert!(check_image_slot_bounds(&[], &[], &bad_ref, &[], &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[]).is_err());
        // Collections were passed `&[]` in every wave-4 case, so that
        // whole branch never executed (wave 5, llvm-cov). Exercise both
        // the key and the value side.
        let bad_key = [CollectionImage {
            owner: 1,
            kind: 0,
            table_length: 0,
            entries: vec![(refd(9), Slot::undefined())],
        }];
        assert!(check_image_slot_bounds(&[], &[], &[], &bad_key, &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[]).is_err());
        let bad_val = [CollectionImage {
            owner: 1,
            kind: 0,
            table_length: 0,
            entries: vec![(Slot::undefined(), refd(9))],
        }];
        assert!(check_image_slot_bounds(&[], &[], &[], &bad_val, &[], &[], &[], &[], &[], &LangRows::EMPTY, &[], 0, &SymbolKeyImage::default(), 4, 64, &[]).is_err());

        // --- in-bounds and NULL pass ---
        assert!(ok(&[refd(3)], &[refd(0)]).is_ok(), "in-bounds indices pass");
        assert!(
            ok(&[refd(SlotIndex::NULL.0)], &[]).is_ok(),
            "a NULL reference is an absence, not an out-of-arena index",
        );
        let good_chunk = Slot::of(Kind::String, Payload::String(ChunkOffset(8)));
        assert!(ok(&[good_chunk], &[]).is_ok(), "an in-range chunk offset passes");
    }

    /// Review findings 2+3 (free-record hygiene): a record on the free
    /// list is opaque dead bytes — the sweep does not scrub it and
    /// chunk compaction remaps MARKED slots only, so an honest post-GC
    /// image legitimately holds freed records whose stale chunk
    /// offsets and references sit outside the arenas. Refusing those
    /// refuses honest machines. The dual: a side-table row whose OWNER
    /// is free can only be crafted (the sweep drops rows keyed by
    /// every index it frees), and restoring one would attach exotic
    /// state to a slot a later allocation reuses.
    #[test]
    fn free_records_are_opaque_and_free_owners_are_refused() {
        let sym = SymbolKeyImage::default();
        let gate = |heap: &[Slot], errors: &[ErrorImage], free: &[u32]| {
            check_image_slot_bounds(
                heap, &[], &[], &[], &[], errors, &[], &[], &[], &LangRows::EMPTY, &[], 0, &sym,
                4, 64, free,
            )
        };
        // A stale chunk offset AND a dangling reference on freed
        // records: opaque, accepted.
        let stale_chunk = Slot::of(Kind::String, Payload::String(ChunkOffset(0xFFFF_0000)));
        let stale_ref = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(9)));
        assert!(
            gate(&[Slot::undefined(), stale_chunk, stale_ref, Slot::undefined()], &[], &[1, 2]).is_ok(),
            "freed records are opaque: stale bytes must not refuse an honest post-GC image"
        );
        // The SAME records live: refused (the wave-5 rule unchanged).
        assert!(
            gate(&[Slot::undefined(), stale_chunk, stale_ref, Slot::undefined()], &[], &[]).is_err(),
            "live records keep the wave-5 refusals"
        );
        // A side-table row owned by a free slot: refused by name.
        let row = [ErrorImage { owner: 1, name: "Error".to_string(), message: None, frames: Vec::new() }];
        assert!(
            matches!(
                gate(&[Slot::undefined(); 4], &row, &[1]),
                Err(SnapshotError::Corrupt("side table names a free slot"))
            ),
            "a free-owned side-table row can only be crafted"
        );
        // And the same row live-owned still passes.
        assert!(gate(&[Slot::undefined(); 4], &row, &[]).is_ok());
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
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: TemporalImage::default(),
            intl: IntlTables::default(),
            iterators: Vec::new(),
            name_floor: None,
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
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: TemporalImage::default(),
            intl: IntlTables::default(),
            iterators: Vec::new(),
            name_floor: None,
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

        // The stack is EMPTY: `read_machine` enforces quiescence (a
        // populated STAC cannot come from an honest writer — review
        // finding 5), and honest writers only ever persist between
        // cranks. The heap graph above already exercises reference,
        // closure, and string payload round-trips.
        let stack: Vec<Slot> = Vec::new();
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
            // Empty by the quiescence gate (review finding 5).
            stack: vec![],
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
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: TemporalImage::default(),
            intl: IntlTables::default(),
            iterators: Vec::new(),
            name_floor: None,
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
