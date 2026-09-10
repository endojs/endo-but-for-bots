//! VM image conversion, restore repair, and persistence admission.
//! The snapshot crate owns wire formats and store orchestration.
use super::*;

/// A VM restore refusal, identifying the persisted row and violated invariant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RestoreError {
    pub row: &'static str,
    pub reason: &'static str,
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.row, self.reason)
    }
}

impl std::error::Error for RestoreError {}

// Validate only chains reconstruction is about to traverse. In particular, do
// not materialize every lazy arena page just to rebuild boot metadata. Completed
// tails are shared across owners, just as the derived property index permits.
pub(super) fn validate_restore_chain(
    slots: &SlotArena,
    owner: crate::value::SlotIndex,
    complete: &mut std::collections::HashSet<crate::value::SlotIndex>,
) -> Result<(), RestoreError> {
    let refuse = |reason| RestoreError {
        row: "property_chain",
        reason,
    };
    if owner.is_null() || owner.0 >= slots.capacity() || slots.is_free_index(owner) {
        return Err(refuse("owner is not a live slot"));
    }
    let instance = slots.get(owner);
    if instance.kind != Kind::Instance || !matches!(instance.value, Payload::Reference(_)) {
        return Err(refuse("owner is not an instance"));
    }
    let mut current = instance.next;
    let mut path = std::collections::HashSet::new();
    while !current.is_null() && !complete.contains(&current) {
        if current.0 >= slots.capacity() || slots.is_free_index(current) {
            return Err(refuse("property link is not a live slot"));
        }
        if current == owner || !path.insert(current) {
            return Err(refuse("cyclic property chain"));
        }
        current = slots.get(current).next;
    }
    complete.extend(path);
    Ok(())
}

impl Interp {
    pub(super) fn validate_restore_owner(
        &self,
        owner: u32,
        row: &'static str,
    ) -> Result<(), RestoreError> {
        let index = crate::value::SlotIndex(owner);
        if index.is_null() || owner >= self.slots.capacity() || self.slots.is_free_index(index) {
            return Err(RestoreError {
                row,
                reason: "owner is not a live slot",
            });
        }
        let instance = self.slots.get(index);
        if instance.kind != Kind::Instance || !matches!(instance.value, Payload::Reference(_)) {
            return Err(RestoreError {
                row,
                reason: "owner is not an instance",
            });
        }
        Ok(())
    }

    fn validate_restore_owners(
        &self,
        owners: impl IntoIterator<Item = u32>,
        row: &'static str,
    ) -> Result<(), RestoreError> {
        let mut previous = None;
        for owner in owners {
            self.validate_restore_owner(owner, row)?;
            if previous.is_some_and(|prior| owner <= prior) {
                return Err(RestoreError {
                    row,
                    reason: "owners are not strictly ascending",
                });
            }
            previous = Some(owner);
        }
        Ok(())
    }

    /// Check value shape and coordinates without loading chunk contents.
    /// Returns the primitive whose chunk needs content validation, if any;
    /// a Symbol's String descriptor is that primitive rather than the Symbol.
    fn validate_restore_value_shape(
        &self,
        value: Slot,
        row: &'static str,
    ) -> Result<Option<Slot>, RestoreError> {
        let malformed = || RestoreError {
            row,
            reason: "invalid guest value",
        };
        let primitive = match (value.kind, value.value) {
            (Kind::Undefined | Kind::Null, Payload::None)
            | (Kind::Boolean, Payload::Boolean(_))
            | (Kind::Integer, Payload::Integer(_))
            | (Kind::Number, Payload::Number(_)) => return Ok(None),
            (Kind::Reference, Payload::Reference(index)) => {
                self.validate_restore_owner(index.0, row)?;
                return Ok(None);
            }
            (Kind::String, Payload::String(_)) | (Kind::BigInt, Payload::BigInt(_)) => value,
            (Kind::Symbol, Payload::Reference(index)) => {
                if index.is_null()
                    || index.0 >= self.slots.capacity()
                    || self.slots.is_free_index(index)
                {
                    return Err(malformed());
                }
                let descriptor = self.slots.get(index);
                match (descriptor.kind, descriptor.value) {
                    (Kind::Undefined, Payload::None) => return Ok(None),
                    (Kind::String, Payload::String(_)) => descriptor,
                    _ => return Err(malformed()),
                }
            }
            _ => return Err(malformed()),
        };
        let off = primitive.chunk_ref().ok_or_else(malformed)?;
        if off.is_null()
            || (off.0 as usize) < crate::value::CHUNK_HEADER
            || (off.0 as usize) > self.chunks.byte_size()
        {
            return Err(malformed());
        }
        Ok(Some(primitive))
    }

    fn validate_restore_values(
        &self,
        values: impl IntoIterator<Item = Slot>,
        row: &'static str,
    ) -> Result<(), RestoreError> {
        let malformed = || RestoreError {
            row,
            reason: "invalid guest value",
        };
        let mut chunks = Vec::new();
        for value in values {
            if let Some(primitive) = self.validate_restore_value_shape(value, row)? {
                let off = primitive.chunk_ref().ok_or_else(malformed)?;
                chunks.push((off, primitive.kind));
            }
        }
        // One header walk for the batch, rather than rescanning the arena
        // for every boxed String, BigInt, or Symbol description.
        let offsets: Vec<_> = chunks.iter().map(|&(off, _)| off).collect();
        self.chunks
            .validate_references(&offsets)
            .map_err(|_| malformed())?;
        for (off, kind) in chunks {
            let bytes = self.chunks.payload(off);
            match kind {
                Kind::String if bytes.len().is_multiple_of(2) => {}
                Kind::BigInt
                    if bytes.len() >= 5 && (bytes.len() - 1).is_multiple_of(4) && bytes[0] <= 1 =>
                {
                    let high_is_zero = bytes[bytes.len() - 4..].iter().all(|&byte| byte == 0);
                    if high_is_zero && (bytes.len() > 5 || bytes[0] != 0) {
                        return Err(malformed());
                    }
                }
                _ => return Err(malformed()),
            }
        }
        Ok(())
    }

    // --- Snapshot surface -----------------------------------------------
    //
    // The narrow, engine-side conversion primitives the `ironhorse-snapshot`
    // `Machine`-level `write_snapshot_to_file`/`from_snapshot_file`/
    // `suspend_to_cas` surface builds on: read the serializable projection
    // of a live machine (the index arenas plus the value stack, program
    // symbol names, and metering state), and reinstate one on restore.
    // The atom *format* stays in `ironhorse-snapshot` (which owns the `XS_M`
    // grammar); the `Interp`↔image conversion stays here in the engine
    // (design § Snapshots — image.rs's contract). The rich per-instance
    // side tables enumerated `Pending` in `ironhorse_snapshot::sidetable` are
    // the honest remainder: this surface round-trips a machine whose
    // reachable state is confined to the carried atoms — the between-crank
    // quiescent contract documented on the snapshot crate.

    /// The interpreter's live value stack (the `STAC` atom source). At
    /// machine quiescence — between top-level `run` cranks, the only point
    /// a snapshot is taken — this is empty; it is carried for completeness
    /// and so a mid-drain image is not silently lossy.
    pub fn stack_slots(&self) -> &[Slot] {
        &self.stack
    }

    /// The program symbol name table (the `NAME` atom source), id-ordered
    /// (`symbol_names[id - 1]`), as decoded from the program's XS symbols
    /// atom at [`Self::link_intrinsics`].
    pub fn program_symbol_names(&self) -> &[SymbolName] {
        &self.symbol_names
    }

    /// The machine's serializable metering state (design row 6): the
    /// counters a suspend carries so a resume continues the meter exactly.
    pub fn meter_state(&self) -> crate::meter::MeterState {
        self.meter.state()
    }

    /// Reinstate the serializable state decoded from a snapshot image:
    /// the index arenas, the value stack, the program symbol names, and
    /// the metering state. The boot-derived intrinsics and prototype
    /// tables remain those a fresh [`Interp::new`] built — their slot
    /// indices are deterministic, so they still address the restored
    /// arena's identical boot region — and the un-metered/armed distinction
    /// rides in the restored [`crate::meter::MeterState`]. A machine
    /// restored this way continues a following crank identically to one
    /// that never suspended, for the covered (arena + meter) surface.
    pub(super) fn restore_snapshot_state(
        &mut self,
        slots: SlotArena,
        chunks: ChunkArena,
        stack: Vec<Slot>,
        symbol_names: Vec<SymbolName>,
        meter: crate::meter::MeterState,
    ) -> Result<(), RestoreError> {
        let refuse = |reason| RestoreError {
            row: "snapshot_state",
            reason,
        };
        // Slot collection reuses records but never shrinks the arena below
        // its deterministic boot footprint. Boot-derived indices must remain
        // addressable before rebuilding any prototype accessor metadata.
        if slots.capacity() < self.boot_slot_count {
            return Err(refuse("slot arena is smaller than the boot footprint"));
        }
        if !stack.is_empty() {
            return Err(refuse("a quiescent restore requires an empty value stack"));
        }
        if symbol_names.len() > usize::from(u16::MAX) {
            return Err(refuse("name table exceeds the property ID space"));
        }
        if slots.is_free_index(self.global_obj) {
            return Err(refuse("global root is a free slot"));
        }
        let global = slots.get(self.global_obj);
        if global.kind != Kind::Instance || !matches!(global.value, Payload::Reference(_)) {
            return Err(refuse("global root is not an instance"));
        }
        validate_restore_chain(&slots, self.global_obj, &mut Default::default())?;
        self.slots = slots;
        self.chunks = chunks;
        self.stack = stack;
        self.meter.restore(meter);
        // SymbolTables ledger row: only `symbol_names` is serialized; the
        // inverse `symbol_ids` and the
        // name-keyed lookup-id caches are *derived* from it — `link_intrinsics`
        // computes them at boot and never persists them, so restore re-derives
        // them here by the identical pure derivation. Without this a resumed
        // machine's `symbol_ids` stays empty and every name lookup misses.
        // (Consumes `symbol_names`, so this both sets the forward table and
        // rebuilds the rest.)
        self.bind_program_symbols(&symbol_names);
        // The installed-names floor defaults to the full
        // restored table — the conservative choice when no floor
        // traveled (a pre-schema-12 store or container): no partial
        // install pass may then touch any restored id, which can never
        // clobber or resurrect a guest edit. When the snapshot carries
        // the live floor (the `NFLR` atom / small-state section), the
        // resume path narrows this via
        // [`Self::restore_installed_names_floor`], so names interned
        // DURING the last install pass stay lazily installable exactly
        // as they were live (the `ListFormat.prototype.format` case).
        self.installed_names_len = self.symbol_names.len();
        // GlobalProps ledger row: the global object's own-property slots
        // (intrinsic bindings and runtime-materialized `var`/sloppy globals
        // alike) round-trip *inside* the restored slot arena — they are linked
        // into `global_obj`'s property chain — but the `global_props` fast-index
        // that `resolve_get`/`resolve_set` consult is a HashMap, not arena
        // state, and boot leaves it empty. Rebuild it by walking the restored
        // chain, so a global created in an earlier crank resolves after resume.
        self.rebuild_global_props();
        // Accessors ledger row, the boot-seeded half: a `proto_accessors`
        // install's PROPERTY slot travels in the arena but its side-table
        // getter entry does not; re-derive it from the boot seeds (the
        // persist gate admits no other entry at a seed key).
        self.rebuild_boot_accessors()?;
        Ok(())
    }

    /// The installed-names floor: ids at or below it keep
    /// their existing binding on partial install passes; ids above it —
    /// names interned during an install pass (the Intl member keys, the
    /// `format` accessor key) or by the guest — are re-considered,
    /// create-only, by the next growing relink. Real machine state: a
    /// resumed machine must adopt the live machine's floor, not the
    /// restored table's length, or a boot name interned during the last
    /// install pass can never lazily install after resume (the
    /// `ListFormat.prototype.format` divergence the Intl carry twins
    /// caught — the continuous machine installs it at its next growing
    /// relink; a full-table floor refuses it forever).
    pub fn installed_names_floor(&self) -> u32 {
        self.installed_names_len as u32
    }

    /// Adopt a persisted installed-names floor (the `NFLR` atom /
    /// small-state section). `false` — failing the caller's decode
    /// closed — for a floor past the restored name table, which honest
    /// suspension cannot produce.
    pub(super) fn restore_installed_names_floor(&mut self, floor: u32) -> bool {
        if floor as usize > self.symbol_names.len() {
            return false;
        }
        self.installed_names_len = floor as usize;
        true
    }

    /// The first id past this machine's name table. Since the id-space
    /// unification a runtime-interned STRING key appends INTO the table
    /// (`append_name_key`), so every id at or above this floor is a
    /// SYMBOL-key id (minted top-down from `u16::MAX - 1` by `o[sym]` /
    /// `Object.defineProperty(o, sym, …)`).
    pub fn first_runtime_intern_id(&self) -> u16 {
        (self.symbol_names.len() as u16).saturating_add(1)
    }

    /// Whether this machine has ever MINTED a symbol-key property id.
    /// `intern_symbol_key` lowers the top-down counter and nothing raises
    /// it, so this is cheap and monotone.
    ///
    /// String keys do not count: a runtime-interned NAME appends to the
    /// persisted name table (`append_name_key`), so its id→name map
    /// round-trips every snapshot. Symbol keys travel too now — the map
    /// plus this counter ride the SYMB atom
    /// ([`Self::symbol_key_table`] / [`Self::restore_symbol_key_table`])
    /// — so minting is no longer a persistence hazard either; this
    /// remains as the cheap pre-check that lets
    /// [`Self::stored_runtime_intern`] skip its O(heap) walk, and as a
    /// test witness that a fixture minted a key. Minting can happen on a
    /// lookup; only [`Self::stored_runtime_intern`] proves an id was stored.
    pub fn may_hold_runtime_interns(&self) -> bool {
        self.next_symbol_key_id != u16::MAX - 1
    }

    /// The first SYMBOL-KEY property id this machine actually STORES —
    /// in a live heap slot, on the value stack, or in a side table — or
    /// `None` if it stores none. (Ids past the name table are symbol-key
    /// ids: string keys always live IN the table since the id-space
    /// unification, so nothing else occupies that range.)
    ///
    /// Historically this was the persistence gate for the id-space hazard
    /// because the symbol-key map did not travel, so a store refused
    /// any machine that stored such an id. The map and its counter now
    /// ride the SYMB atom, so the gate is gone; this survives as a TEST
    /// WITNESS (`side_table_ledger.rs` uses it to prove a fixture stored
    /// a symbol-key id before checkpointing) and as the live-side
    /// counterpart of the image-side audit
    /// (`MachineImage::stored_unregistered_key_id`, which refuses a
    /// STORED id that maps to nothing in either table — torn or crafted
    /// bytes, not honest minting).
    ///
    /// A slot on the FREE LIST is skipped: its record is stale, nothing
    /// reaches it, and its id names nothing. Counting it would refuse a
    /// machine whose only offending key the collector has already
    /// reclaimed.
    ///
    /// Cost is O(heap) when it walks, and on a lazily-attached machine
    /// the walk faults every page in — but it walks only when this
    /// machine has actually minted an id, so a program that never
    /// interned (every boot machine, and every program using static keys
    /// only) pays one comparison.
    pub fn stored_runtime_intern(&self) -> Option<u16> {
        if !self.may_hold_runtime_interns() {
            return None;
        }
        let floor = self.first_runtime_intern_id();
        let over = |s: &Slot| s.stored_key_id().filter(|&id| id >= floor);
        for i in 0..self.slots.capacity() {
            let idx = crate::value::SlotIndex(i);
            if self.slots.is_free_index(idx) {
                continue;
            }
            if let Some(id) = over(&self.slots.get(idx)) {
                return Some(id);
            }
        }
        // Map iteration order cannot determine the witness. The roster scan
        // returns the minimum across the historical stack and table holders,
        // independently locked by runtime_key_registry.rs.
        self.runtime_key_tail_min(&over)
    }

    /// Quiescent snapshot of the `arrays` side table (side-table
    /// ledger, `Arrays` row), ascending by owning slot for canonical
    /// serialization: `(owner slot, spec length, items ascending by
    /// index)`. Item values are ordinary [`Slot`]s — their slot/chunk
    /// references round-trip with the arenas.
    pub fn arrays_snapshot(&self) -> Vec<ArraySnapshot> {
        let mut out: Vec<ArraySnapshot> = self
            .arrays
            .iter()
            .map(|(owner, a)| {
                (
                    owner.0,
                    a.length,
                    a.items().iter().map(|(i, s)| (*i, *s)).collect(),
                )
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _)| *owner);
        out
    }

    /// Quiescent snapshot of the `collections` side table (ledger
    /// `Collections` row), ascending by owning slot: `(owner slot,
    /// kind code, table_length, entries in insertion order)`.
    /// Tombstones (deleted entries whose physical index a live
    /// iterator cursor may still hold) are COMPACTED out: live-entry
    /// order, `size`, and the rehash geometry (`table_length`) are the
    /// observables, and all survive compaction unchanged. Iterator
    /// cursors round-trip alongside (the `ITER` row, store schema 13)
    /// as live-entry ORDINALS — [`Self::iterators_snapshot`] performs
    /// the matching translation, so a resumed cursor addresses exactly
    /// the entries this compaction keeps.
    pub fn collections_snapshot(&self) -> Vec<CollectionSnapshot> {
        let mut out: Vec<CollectionSnapshot> = self
            .collections
            .iter()
            .map(|(owner, c)| {
                (
                    owner.0,
                    c.kind.code(),
                    c.table_length,
                    c.live_entries().copied().collect(),
                )
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _)| *owner);
        out
    }

    /// The first live function backed by an owned code segment.
    ///
    /// The legacy name predates top-level crank-code retention, when only
    /// eval/dynamic-Function bodies entered `func_segments`. Both top-level
    /// and dynamic segments now persist in the atomic function snapshot.
    pub fn live_dynamic_segment_function(&self) -> Option<u32> {
        if self.func_segments.is_empty() {
            return None;
        }
        // Deterministic witness: the minimum live slot,
        // not whichever HashMap order surfaces first.
        self.func_segments
            .keys()
            .filter(|f| !self.slots.is_free_index(**f))
            .map(|f| f.0)
            .min()
    }

    /// A reason this machine cannot be faithfully restored, or `None`.
    /// Refuses the test262 host, reactions needing unpersisted async state,
    /// live async generators, and references to native functions that restore
    /// cannot reconstruct. Guest functions, proxies and accessors have carried
    /// state and are not categorically refused.
    /// The heap and roster-generated persistence holders are checked against
    /// `non_persisting_functions`; free-listed owners are skipped.
    /// `pending_row_gates.rs` and `persist_gates.rs` exercise these refusals.
    pub fn stored_unpersistable_row(&self) -> Option<&'static str> {
        self.stored_unpersistable_row_inner(false)
    }

    /// The checkpoint form: identical, except the heap walk covers only
    /// the pages this crank DIRTIED, keeping the per-crank cost O(dirty)
    /// as the site requires.
    ///
    /// Sound by induction. `begin_store_session` audits the whole heap,
    /// and a reference can only enter a page by being WRITTEN there,
    /// which dirties the page — so every stored reference was audited by
    /// the checkpoint that followed its write. A slot's persistability
    /// never changes under it either: a slot is a boot native, a guest
    /// function, or a runtime-minted native for as long as it lives, and
    /// a freed slot reused for a fresh native has no live reference to
    /// the old one. The side tables are walked in FULL regardless —
    /// they are small state, re-serialized on every checkpoint anyway.
    pub fn stored_unpersistable_row_at_checkpoint(&self) -> Option<&'static str> {
        self.stored_unpersistable_row_inner(true)
    }

    pub(super) fn stored_unpersistable_row_inner(
        &self,
        dirty_heap_only: bool,
    ) -> Option<&'static str> {
        // The test262 `$262` host ([`Self::install_test262_host`]):
        // harness-only, minted above `boot_slot_count`, carried by no
        // atom, and re-derived by nothing on the resume path — restore
        // boots a DEFAULT machine, which installs no host at all.
        //
        // Refused on the host's PRESENCE rather than left to the
        // doomed-set walk below, because that walk cannot see the whole
        // defect. It refuses a machine that STORED the native (`var f =
        // $262.detachArrayBuffer`) or called it, but a guest that only
        // OBSERVES the binding (`typeof $262`) stores no function
        // reference: the walk finds nothing, the checkpoint succeeds,
        // and the resumed machine silently has no `$262` for a later
        // crank to name. Presence is also the honest question — a
        // machine carrying the conformance host IS a conformance
        // machine, and conformance machines do not persist. That
        // invariant used to live in prose on `install_test262_host`
        // ("the harness never checkpoints"); this is the enforcement.
        //
        // Costs one hash lookup on a table every machine has, so it
        // leads: a default machine (no `$262`) falls straight through.
        if self.intrinsics.contains_key("$262") {
            return Some("a test262 `$262` host object, which no snapshot carries");
        }
        // A pending reaction whose KIND names suspended async machinery
        // (an `await`'s resumption, an async generator's, an
        // `Array.fromAsync` step) points at instance rows the image
        // does not carry yet (`async_generators`/`from_async` are Pending).
        // Ordinary async functions carry their frames in ASYN. Every
        // RESUMABLE async suspension is anchored by exactly such a
        // reaction on a live promise — an unanchored instance is
        // unreachable and swept — so refusing by kind here is the whole
        // gate for those rows, checked before the doomed-set early
        // return below because it is independent of function slots. The
        // side tables are walked in full in both variants, as below.
        let async_reaction = self
            .promises
            .values()
            .flat_map(|p| p.reactions.iter())
            .any(|r| {
                !matches!(
                    r.kind,
                    ReactionKind::User
                        | ReactionKind::AsyncAwait(_)
                        | ReactionKind::FinallyReturn
                        | ReactionKind::FinallyAwait(_)
                        | ReactionKind::Combine(_, _)
                        | ReactionKind::CombineDirect(_, _)
                )
            });
        if async_reaction {
            return Some("a promise reaction that would resume a non-persisted async frame");
        }
        // Async generator rows do not persist. A live instance needs its row
        // in every state: between yields it can resume without a pending
        // reaction, and after completion next/return/throw must still observe
        // completion. Losing the row would leave an ordinary object behind.
        // Free-listed owners have no live instance to restore.
        if self
            .async_generators
            .keys()
            .any(|owner| !self.slots.is_free_index(*owner))
        {
            return Some("an async generator whose state does not yet persist");
        }

        // Compute the functions restore cannot reconstruct before walking
        // their holders. Most machines have none, so this skips the heap and
        // roster-generated holder checks without changing the early gates.
        let doomed = self.non_persisting_functions();
        if doomed.is_empty() {
            return None;
        }
        let names = |slot: &Slot| -> bool {
            matches!(slot.value, Payload::Reference(f) if doomed.contains(&f.0))
        };

        // The heap itself, which carries every ordinary property, every
        // global, and every closure capture.
        let mut page_hit = false;
        if dirty_heap_only {
            for page in self.slots.dirty_pages() {
                let start = page.saturating_mul(crate::value::SLOTS_PER_PAGE);
                let end = start
                    .saturating_add(crate::value::SLOTS_PER_PAGE)
                    .min(self.slots.capacity());
                for i in start..end {
                    let idx = crate::value::SlotIndex(i);
                    if !self.slots.is_free_index(idx) && names(&self.slots.get(idx)) {
                        page_hit = true;
                        break;
                    }
                }
                if page_hit {
                    break;
                }
            }
        } else {
            for i in 0..self.slots.capacity() {
                let idx = crate::value::SlotIndex(i);
                if !self.slots.is_free_index(idx) && names(&self.slots.get(idx)) {
                    page_hit = true;
                    break;
                }
            }
        }
        if page_hit {
            return Some("a stored reference to a non-persisted native function");
        }

        if self.persisted_holders_contain(&names, &|i| doomed.contains(&i)) {
            return Some("a stored reference to a non-persisted native function");
        }
        None
    }

    /// Whether restore has a reconstruction recipe for this function slot.
    /// Boot natives, proxy revokers, Intl bound natives, promise resolving
    /// functions and guest bytecode functions have such recipes. `CopyObject`
    /// is an execution-only helper and is rejected even in a recycled boot slot;
    /// an index below `boot_slot_count` alone cannot establish its ownership.
    pub(super) fn function_persists(&self, function: crate::value::SlotIndex) -> bool {
        // This execution helper has no persisted reconstruction recipe. Its
        // slot can be a recycled boot slot after GC, so index alone is not
        // evidence that a native belongs to the boot image.
        if self
            .functions
            .get(&function)
            .is_some_and(|info| matches!(info.method, Some(NativeMethod::CopyObject)))
        {
            return false;
        }
        if function.0 < self.boot_slot_count || self.proxy_revokers.contains_key(&function) {
            return true;
        }
        if self.collator_compare_functions.contains_key(&function)
            || self.number_format_bound_functions.contains_key(&function)
            || self.promise_functions.contains_key(&function)
        {
            return true;
        }
        self.functions
            .get(&function)
            .is_some_and(|info| info.native.is_none() && info.method.is_none())
    }

    /// Function slots rejected by [`Self::function_persists`], including
    /// execution-only helpers that may occupy recycled boot indices.
    /// Usually empty; holders of these slots prevent faithful restoration.
    pub(super) fn non_persisting_functions(&self) -> std::collections::BTreeSet<u32> {
        self.functions
            .keys()
            .filter(|f| !self.function_persists(**f))
            .map(|f| f.0)
            .collect()
    }

    /// Resolve a deterministic boot accessor key without creating any state.
    /// Restore has already rebuilt both key tables before accessor seeds are
    /// re-derived, so a missing id means the property was never installed.
    pub(super) fn boot_accessor_key_id(&self, key: ProtoAccessorKey) -> Option<u16> {
        match key {
            ProtoAccessorKey::String(name) => self.symbol_ids.get(name).copied(),
            ProtoAccessorKey::WellKnownSymbol(name) => {
                let descriptor = self
                    .well_known_symbols
                    .iter()
                    .find_map(|(candidate, value)| (*candidate == name).then_some(value.value))?;
                match descriptor {
                    Payload::Reference(descriptor) => self.symbol_key_ids.get(&descriptor).copied(),
                    _ => None,
                }
            }
        }
    }

    /// Whether an `accessors` entry is exactly a boot
    /// [`Self::proto_accessors`] seed: seed proto and resolved seed key, and
    /// the seed getter/setter (by slot identity).
    pub(super) fn is_boot_seed_accessor(
        &self,
        owner: crate::value::SlotIndex,
        id: u16,
        data: &AccessorData,
    ) -> bool {
        let getter = match data.get {
            Some(Slot {
                value: Payload::Reference(g),
                ..
            }) => g,
            _ => return false,
        };
        self.proto_accessors
            .iter()
            .any(|&(proto, key, seed_getter, seed_setter, _)| {
                let setter_matches = match (data.set, seed_setter) {
                    (None, None) => true,
                    (
                        Some(Slot {
                            value: Payload::Reference(actual),
                            ..
                        }),
                        Some(expected),
                    ) => actual == expected,
                    _ => false,
                };
                proto == owner
                    && seed_getter == getter
                    && setter_matches
                    && self.boot_accessor_key_id(key) == Some(id)
            })
    }

    /// Re-derive the boot-seeded prototype accessor entries after a
    /// restore (the `RebuiltAtRestore` pattern, like
    /// [`Self::rebuild_global_props`]): the accessor PROPERTY slot
    /// travels in the arena, but its getter/setter pair lives in the
    /// `accessors` side table, which does not. Every seed's getter is
    /// a boot-minted native at a deterministic boot slot, so the entry
    /// is a pure function of boot structure plus the restored arena —
    /// and the persist gate refused any heap whose entry at a seed key
    /// was NOT exactly the seed, so an accessor-flagged property at a
    /// seed key can only mean the boot accessor. A guest deletion or
    /// data-property redefinition leaves no accessor-flagged slot and
    /// rebuilds nothing.
    pub(super) fn rebuild_boot_accessors(&mut self) -> Result<(), RestoreError> {
        let mut complete = std::collections::HashSet::new();
        for &(proto, key, ..) in &self.proto_accessors {
            if self.boot_accessor_key_id(key).is_some() {
                validate_restore_chain(&self.slots, proto, &mut complete)?;
            }
        }
        let seeds = std::mem::take(&mut self.proto_accessors);
        for &(proto, key, getter, setter, _) in &seeds {
            let Some(pid) = self.boot_accessor_key_id(key) else {
                continue;
            };
            let Some(p) = self.find_property(proto, pid) else {
                continue;
            };
            if self.slots.get(p).flag & (XS_GETTER_FLAG | XS_SETTER_FLAG)
                != (XS_GETTER_FLAG | XS_SETTER_FLAG)
            {
                continue;
            }
            self.accessors.insert(
                (proto, pid),
                AccessorData {
                    get: Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    set: setter
                        .map(|function| Slot::of(Kind::Reference, Payload::Reference(function))),
                },
            );
        }
        self.proto_accessors = seeds;
        Ok(())
    }

    /// Quiescent snapshot of the `error_data` side table (ledger
    /// `ErrorData` row, the `ERRD` atom), ascending by owning slot:
    /// `(owner slot, error name, optional message)`. The name is the
    /// construction-time constructor name and the message half is
    /// `None` (bare-name render) or the recorded text — exactly what
    /// the abort-value render consults, so a resumed `throw e`
    /// stringifies as the uninterrupted machine's would.
    pub fn errors_snapshot(&self) -> Vec<(u32, &'static str, Option<SymbolName>, Vec<String>)> {
        let mut out: Vec<(u32, &'static str, Option<SymbolName>, Vec<String>)> = self
            .error_data
            .iter()
            .map(|(owner, info)| {
                (
                    owner.0,
                    info.name,
                    info.message
                        .as_ref()
                        .map(|units| SymbolName::from_units(units)),
                    info.frames.clone(),
                )
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _)| *owner);
        out
    }

    /// Reinstate the `error_data` side table from a snapshot (the exact
    /// inverse of [`Self::errors_snapshot`]). Runs on a freshly
    /// restored machine whose table is empty. Every owner and constructor
    /// name is validated before any table entry changes.
    pub(super) fn restore_error_data(
        &mut self,
        rows: Vec<(u32, String, Option<SymbolName>, Vec<String>)>,
    ) -> Result<(), RestoreError> {
        self.validate_restore_owners(rows.iter().map(|row| row.0), "Errors")?;
        let mut prepared = Vec::with_capacity(rows.len());
        for (owner, name, message, frames) in rows {
            let name = error_name_static(&name).ok_or(RestoreError {
                row: "Errors",
                reason: "unknown error constructor name",
            })?;
            prepared.push((
                crate::value::SlotIndex(owner),
                ErrorInfo {
                    name,
                    message: message.map(|text| text.to_units()),
                    frames,
                },
            ));
        }
        self.error_data.extend(prepared);
        Ok(())
    }

    /// Quiescent snapshot of the `array_buffers` side table (ledger
    /// `ArrayBuffers` row, the `ABUF` atom), ascending by owning slot:
    /// `(owner slot, backing chunk offset, byte length, flags)`. The
    /// backing BYTES travel with the chunk arena (`BLOC`); this row is
    /// the geometry that makes them readable. Flags fold the two
    /// satellite brand sets in: bit 0 = detached
    /// ([`Self::detached_buffers`]), bit 1 = shared
    /// ([`Self::shared_buffers`]).
    pub fn array_buffers_snapshot(&self) -> Vec<(u32, u32, u32, u8)> {
        let mut out: Vec<(u32, u32, u32, u8)> = self
            .array_buffers
            .iter()
            .map(|(owner, b)| {
                let flags = u8::from(self.detached_buffers.contains(owner))
                    | (u8::from(self.shared_buffers.contains(owner)) << 1);
                (owner.0, b.data.0, b.length, flags)
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _)| *owner);
        out
    }

    /// Quiescent snapshot of the `typed_arrays` side table (ledger
    /// `TypedArrays` row, the `TARR` atom), ascending by owning slot:
    /// `(owner slot, element kind, buffer slot, byte offset, element
    /// length)`. `kind` indexes [`TYPED_ARRAY_TYPES`].
    pub fn typed_arrays_snapshot(&self) -> Vec<(u32, u8, u32, u32, u32)> {
        let mut out: Vec<(u32, u8, u32, u32, u32)> = self
            .typed_arrays
            .iter()
            .map(|(owner, t)| (owner.0, t.kind, t.buffer.0, t.offset, t.length))
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _, _)| *owner);
        out
    }

    /// Quiescent snapshot of the `data_views` side table (ledger
    /// `DataViews` row, the `DVIW` atom), ascending by owning slot:
    /// `(owner slot, buffer slot, byte offset, byte length)`.
    pub fn data_views_snapshot(&self) -> Vec<(u32, u32, u32, u32)> {
        let mut out: Vec<(u32, u32, u32, u32)> = self
            .data_views
            .iter()
            .map(|(owner, d)| (owner.0, d.buffer.0, d.offset, d.size))
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _)| *owner);
        out
    }

    /// Reinstate the typed-array family from a snapshot (the exact
    /// inverse of the three `*_snapshot` views above). Runs on a
    /// freshly restored machine whose tables are empty, AFTER the
    /// arenas are in place (the buffer extents are validated against
    /// the restored chunk arena). Validates every row — an unknown
    /// element kind, a flags byte outside the two brand bits, a NULL
    /// or out-of-arena backing extent, a view naming a buffer with no
    /// row, or live view geometry past its buffer's length — before any
    /// family table changes. Detached buffers retain their views' former geometry
    /// because the observable accessors project those views as zero-length.
    pub(super) fn restore_typed_array_family(
        &mut self,
        buffers: Vec<(u32, u32, u32, u8)>,
        views: Vec<(u32, u8, u32, u32, u32)>,
        data_views: Vec<(u32, u32, u32, u32)>,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "TypedArrayFamily";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owners(buffers.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(views.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(data_views.iter().map(|row| row.0), ROW)?;
        let mut owners = std::collections::HashSet::new();
        for owner in buffers
            .iter()
            .map(|row| row.0)
            .chain(views.iter().map(|row| row.0))
            .chain(data_views.iter().map(|row| row.0))
        {
            if !owners.insert(owner) {
                return Err(refuse("owner has multiple buffer-family brands"));
            }
        }
        for &(_, data, length, flags) in &buffers {
            if flags > 0b11 {
                return Err(refuse("unknown buffer flags"));
            }
            let stored_length = self
                .chunks
                .restored_payload_len(crate::value::ChunkOffset(data))
                .map_err(refuse)?;
            if if flags & 1 != 0 {
                length != 0
            } else {
                length as usize != stored_length
            } {
                return Err(refuse("buffer length disagrees with backing state"));
            }
        }
        let buffer_state = |owner| {
            buffers
                .binary_search_by_key(&owner, |row| row.0)
                .ok()
                .map(|index| (buffers[index].2, buffers[index].3))
                .ok_or_else(|| refuse("view has no buffer row"))
        };
        for &(_, kind, buffer, offset, length) in &views {
            let ty = TYPED_ARRAY_TYPES
                .get(kind as usize)
                .ok_or_else(|| refuse("unknown typed-array kind"))?;
            let (buffer_length, flags) = buffer_state(buffer)?;
            if offset % (1u32 << ty.shift) != 0 {
                return Err(refuse("typed-array offset is not aligned"));
            }
            let end = u64::from(offset) + (u64::from(length) << ty.shift);
            if flags & 1 == 0 && end > u64::from(buffer_length) {
                return Err(refuse("typed-array range exceeds buffer"));
            }
        }
        for &(_, buffer, offset, size) in &data_views {
            let (buffer_length, flags) = buffer_state(buffer)?;
            if flags & 1 == 0 && u64::from(offset) + u64::from(size) > u64::from(buffer_length) {
                return Err(refuse("data-view range exceeds buffer"));
            }
        }
        for (owner, data, length, flags) in buffers {
            let owner = crate::value::SlotIndex(owner);
            self.array_buffers.insert(
                owner,
                ArrayBufferData {
                    data: crate::value::ChunkOffset(data),
                    length,
                },
            );
            if flags & 1 != 0 {
                self.detached_buffers.insert(owner);
            }
            if flags & 2 != 0 {
                self.shared_buffers.insert(owner);
            }
        }
        for (owner, kind, buffer, offset, length) in views {
            self.typed_arrays.insert(
                crate::value::SlotIndex(owner),
                TypedArrayData {
                    kind,
                    buffer: crate::value::SlotIndex(buffer),
                    offset,
                    length,
                },
            );
        }
        for (owner, buffer, offset, size) in data_views {
            self.data_views.insert(
                crate::value::SlotIndex(owner),
                DataViewData {
                    buffer: crate::value::SlotIndex(buffer),
                    offset,
                    size,
                },
            );
        }
        Ok(())
    }

    /// Quiescent snapshot of the `wrapper_data` side table (ledger
    /// `WrapperData` row, the `WRAP` atom), ascending by owning slot:
    /// each primitive wrapper instance's boxed value. The value is an
    /// ordinary [`Slot`] — its chunk reference (a boxed String)
    /// round-trips with the arenas.
    pub fn wrappers_snapshot(&self) -> Vec<(u32, Slot)> {
        let mut out: Vec<(u32, Slot)> = self
            .wrapper_data
            .iter()
            .map(|(owner, v)| (owner.0, *v))
            .collect();
        out.sort_unstable_by_key(|(owner, _)| *owner);
        out
    }

    /// Reinstate the `wrapper_data` side table from a snapshot (the
    /// exact inverse of [`Self::wrappers_snapshot`]). Validate owners and
    /// primitive representations before installing any row.
    pub(super) fn restore_wrapper_data(
        &mut self,
        rows: Vec<(u32, Slot)>,
    ) -> Result<(), RestoreError> {
        self.validate_restore_owners(rows.iter().map(|&(owner, _)| owner), "Wrappers")?;
        if rows.iter().any(|(_, value)| {
            !matches!(
                value.kind,
                Kind::Boolean
                    | Kind::Integer
                    | Kind::Number
                    | Kind::String
                    | Kind::BigInt
                    | Kind::Symbol
            )
        }) {
            return Err(RestoreError {
                row: "Wrappers",
                reason: "invalid boxed primitive",
            });
        }
        self.validate_restore_values(rows.iter().map(|&(_, value)| value), "Wrappers")?;
        for (owner, value) in rows {
            self.wrapper_data
                .insert(crate::value::SlotIndex(owner), value);
        }
        Ok(())
    }

    /// Quiescent snapshot of the `regexps` side table (ledger `RegExps`
    /// row, the `REGX` atom), ascending by owning slot. The compiled program
    /// does not travel — it is a pure function of `(source, flags)` and the
    /// restore recompiles it. The final numeric field preserves the schema-11
    /// wire shape for old readers; the authoritative `lastIndex` value and
    /// attributes now ride the ordinary heap property.
    pub fn regexps_snapshot(&self) -> Vec<(u32, SymbolName, String, u64)> {
        let mut out: Vec<(u32, SymbolName, String, u64)> = self
            .regexps
            .iter()
            .map(|(owner, r)| {
                let last_index = self
                    .last_index_id
                    .and_then(|id| self.find_property(*owner, id))
                    .and_then(|property| numeric_of(&self.slots.get(property)))
                    .unwrap_or(r.last_index);
                (
                    owner.0,
                    SymbolName::from_units(&r.source),
                    r.flags.clone(),
                    last_index.to_bits(),
                )
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _, _)| *owner);
        out
    }

    /// Reinstate the `regexps` side table from a snapshot, recompiling each
    /// program from its persisted `(source, flags)`. A schema-11 snapshot has
    /// no heap `lastIndex` property, so materialize it from the legacy numeric
    /// field. A newer snapshot must carry the standard non-enumerable,
    /// non-configurable data descriptor; reject any other shape.
    pub(super) fn restore_regexps(
        &mut self,
        rows: Vec<(u32, SymbolName, String, u64)>,
    ) -> Result<(), RestoreError> {
        self.validate_restore_owners(rows.iter().map(|row| row.0), "RegExps")?;
        let id = self.symbol_ids.get("lastIndex").copied();
        let mut prepared = Vec::with_capacity(rows.len());
        for (owner, source, flags, last_index_bits) in rows {
            let source = source.to_units();
            let program = ironhorse_regexp::compile_units_checked(&source, &flags, u64::MAX, None)
                .result
                .map_err(|_| RestoreError {
                    row: "RegExps",
                    reason: "invalid pattern or flags",
                })?;
            let owner = crate::value::SlotIndex(owner);
            let missing = match id.and_then(|id| self.ordinary_get_own_descriptor(owner, id)) {
                Some(descriptor)
                    if descriptor.is_data()
                        && descriptor.enumerable == Some(false)
                        && descriptor.configurable == Some(false) =>
                {
                    false
                }
                Some(_) => {
                    return Err(RestoreError {
                        row: "RegExps",
                        reason: "invalid lastIndex descriptor",
                    })
                }
                None => true,
            };
            prepared.push((
                owner,
                missing,
                RegExpData {
                    program,
                    source,
                    flags,
                    last_index: f64::from_bits(last_index_bits),
                },
            ));
        }
        if id.is_none()
            && prepared.iter().any(|(_, missing, _)| *missing)
            && self.symbol_names.len().saturating_add(1) >= usize::from(self.next_symbol_key_id)
        {
            return Err(RestoreError {
                row: "RegExps",
                reason: "no name ID available for lastIndex",
            });
        }
        for (owner, missing, data) in prepared {
            if missing {
                let id = self.regexp_last_index_id();
                self.set_own_unmetered_with_flag(
                    owner,
                    id,
                    Self::slot_from_number(data.last_index),
                    XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG,
                );
            }
            self.regexps.insert(owner, data);
        }
        Ok(())
    }

    /// Quiescent snapshot of the `arguments_objects` brand set (the
    /// `ARGB` atom — the satellite the `Arrays` row's coverage note
    /// called out as NOT traveling), ascending owners.
    pub fn arguments_brands_snapshot(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self.arguments_objects.iter().map(|o| o.0).collect();
        out.sort_unstable();
        out
    }

    /// Reinstate the arguments-exotic brand set.
    pub(super) fn restore_arguments_brands(
        &mut self,
        owners: Vec<u32>,
    ) -> Result<(), RestoreError> {
        self.validate_restore_owners(owners.iter().copied(), "ArgumentsBrands")?;
        for owner in owners {
            self.arguments_objects
                .insert(crate::value::SlotIndex(owner));
        }
        Ok(())
    }

    /// Upgrade semantic boot dependencies and object layouts that changed
    /// without changing the snapshot container schema.
    ///
    /// `join` is safe to install only when its name lies above the restored
    /// installed-name floor (or is absent): that proves no earlier install pass
    /// could have created it. If its id is at or below the floor, a missing
    /// `%Array.prototype%.join` may be a deliberate guest deletion and is left
    /// alone.
    ///
    /// A current guest can intentionally select `%Array.prototype%` or delete
    /// its own `@@iterator`, producing the exact legacy shape. The marker
    /// identifies snapshots written after this migration existed; among older
    /// snapshots, the persisted `join` install floor distinguishes the legacy
    /// arguments representation from the corrected intermediate one. Custom
    /// prototypes and own iterator overrides remain untouched while the old
    /// default representation gains `%Object.prototype%` and the standard own
    /// iterator.
    pub fn migrate_restored_layout(&mut self) {
        let marker_free = !self.symbol_key_ids.contains_key(&self.template_cache);
        // Raw-bytecode machines have no property-name table and therefore no
        // linked language layout to migrate. Minting any marker would still
        // change their otherwise table-free state and break byte-identical
        // unlinked snapshot round trips.
        if self.symbol_names.is_empty() || !marker_free {
            return;
        }

        // The corrected arguments representation predates the hidden marker,
        // but it landed together with the implicit Array `join` dependency.
        // Those intermediate snapshots therefore have `join` at or below the
        // persisted install floor even when the guest later deleted the
        // property. Only a marker-free snapshot that had never considered
        // `join` is old enough for the arguments-layout rewrite. This avoids
        // treating a current-layout guest-selected Array prototype and deleted
        // own iterator as legacy state.
        let join_was_considered = self
            .symbol_ids
            .get("join")
            .is_some_and(|id| *id as usize <= self.installed_names_len);
        let legacy_arguments = !join_was_considered;

        // Before standard globals became non-enumerable, an untouched
        // intrinsic binding had the exact old default descriptor: its value
        // was the realm intrinsic and all three attribute bits were clear.
        // Upgrade only that unambiguous shape. A guest replacement or any
        // writable/configurable edit is retained, while an already
        // non-enumerable property already has the desired result.
        let legacy_globals: Vec<_> = self
            .intrinsics
            .iter()
            .filter_map(|(name, &intrinsic)| {
                self.symbol_ids
                    .get(*name)
                    .copied()
                    .map(|id| (id, intrinsic))
            })
            .collect();
        for (id, intrinsic) in legacy_globals {
            let Some(&property) = self.global_props.get(&id) else {
                continue;
            };
            let slot = self.slots.get_mut(property);
            if slot.flag == 0
                && slot.kind == Kind::Reference
                && slot.value == Payload::Reference(intrinsic)
            {
                slot.flag |= XS_DONT_ENUM_FLAG;
            }
        }
        if let Some(&id) = self.symbol_ids.get("globalThis") {
            if let Some(&property) = self.global_props.get(&id) {
                let slot = self.slots.get_mut(property);
                if slot.flag == 0
                    && slot.kind == Kind::Reference
                    && slot.value == Payload::Reference(self.global_obj)
                {
                    slot.flag |= XS_DONT_ENUM_FLAG;
                }
            }
        }

        if !join_was_considered {
            self.intern_static_key_unmetered("join");
        }
        self.intern_symbol_key_reserved(self.template_cache);
        if !join_was_considered {
            // The appended name id is above the restored floor. The ordinary
            // create-only pending pass installs `join` and advances the floor
            // without touching any already-considered guest property.
            self.install_pending_intrinsics();
        }

        if !legacy_arguments || self.arguments_objects.is_empty() {
            return;
        }
        let iterator_id = self.well_known_symbol_property_id("iterator");
        let values = self
            .proto_methods
            .iter()
            .find(|(holder, name, _)| *holder == self.array_proto && *name == "values")
            .map(|(_, _, method)| *method);
        let mut owners: Vec<_> = self.arguments_objects.iter().copied().collect();
        owners.sort_unstable_by_key(|owner| owner.0);
        for owner in owners {
            if self.instance_prototype(owner) == self.array_proto {
                self.slots.get_mut(owner).value = Payload::Reference(self.object_proto);
            }
            let (Some(iterator_id), Some(values)) = (iterator_id, values) else {
                continue;
            };
            if self
                .ordinary_get_own_descriptor(owner, iterator_id)
                .is_none()
            {
                self.set_own_unmetered_with_flag(
                    owner,
                    iterator_id,
                    Slot::of(Kind::Reference, Payload::Reference(values)),
                    XS_DONT_ENUM_FLAG,
                );
            }
        }
    }

    /// Quiescent snapshot of Date `[[DateValue]]` records, ascending by
    /// owning slot and carrying each IEEE-754 value as raw bits.
    ///
    /// `%Date.prototype%` is not branded with `[[DateValue]]`; only Date
    /// instances appear in this table.
    pub fn dates_snapshot(&self) -> Vec<(u32, u64)> {
        let mut out: Vec<(u32, u64)> = self
            .dates
            .iter()
            .map(|(owner, value)| (owner.0, value.to_bits()))
            .collect();
        out.sort_unstable_by_key(|(owner, _)| *owner);
        out
    }

    /// Reinstate validated Date `[[DateValue]]` records. Snapshots written
    /// before `%Date.prototype%` lost its incorrect Date brand can contain a
    /// row for that boot object; drop it as a semantic migration so restoring
    /// the legacy representation cannot reintroduce the obsolete brand.
    /// Reject non-live/non-instance owners, nonascending owners, and values
    /// outside TimeClip's output domain before changing any table entry.
    pub(super) fn restore_dates(&mut self, rows: Vec<(u32, u64)>) -> Result<(), RestoreError> {
        self.validate_restore_owners(rows.iter().map(|&(owner, _)| owner), "Dates")?;
        for &(_, value_bits) in &rows {
            let value = f64::from_bits(value_bits);
            if !value.is_nan() && value_bits != time_clip(value).to_bits() {
                return Err(RestoreError {
                    row: "Dates",
                    reason: "value is outside the TimeClip domain",
                });
            }
        }
        for (owner, value_bits) in rows {
            let owner = crate::value::SlotIndex(owner);
            if owner != self.date_proto {
                self.dates.insert(owner, f64::from_bits(value_bits));
            }
        }
        Ok(())
    }

    /// The shared canonical mapping for function rows and saved-handler rows.
    /// Exporters can be called independently, so each derives the same ordering
    /// from the authoritative surviving guest functions.
    pub(super) fn snapshot_code_segment_remap(&self) -> std::collections::BTreeMap<usize, u32> {
        let referenced: std::collections::BTreeSet<usize> = self
            .functions
            .iter()
            .filter(|(_, info)| {
                info.native.is_none() && info.method.is_none() && info.body_start.is_some()
            })
            .map(|(owner, _)| {
                *self
                    .func_segments
                    .get(owner)
                    .expect("every guest bytecode function owns a code segment")
            })
            .collect();
        referenced
            .into_iter()
            .enumerate()
            .map(|(new, old)| (old, new as u32))
            .collect()
    }

    /// Snapshot the atomic guest-callability cluster.
    pub fn function_state_snapshot(&self) -> FunctionStateSnapshot {
        let mut owners = std::collections::BTreeSet::new();
        for (owner, info) in &self.functions {
            if info.native.is_none() && info.method.is_none() {
                owners.insert(owner.0);
            }
        }

        let segment_remap = self.snapshot_code_segment_remap();
        let segments = segment_remap
            .keys()
            .map(|old| self.code_segments[*old].to_vec())
            .collect();

        let mut functions: Vec<FunctionRow> = owners
            .iter()
            .map(|owner| {
                let owner = crate::value::SlotIndex(*owner);
                let info = &self.functions[&owner];
                let segment = info
                    .body_start
                    .map(|_| segment_remap[&self.func_segments[&owner]]);
                FunctionRow {
                    owner: owner.0,
                    segment,
                    body_start: info.body_start.map(|v| v as u64),
                    body_len: info.body_len as u64,
                    closures: info.closures.0,
                    name: info.name.clone(),
                    arity: info.arity,
                    name_chunk: info.name_chunk.0,
                    is_generator: info.is_generator,
                    home: info.home.0,
                    class_derived: info.class_derived,
                }
            })
            .collect();
        functions.sort_unstable_by_key(|row| row.owner);

        let mut bound_functions: Vec<BoundFunctionRow> = self
            .bound_functions
            .iter()
            .filter(|(owner, _)| owners.contains(&owner.0))
            .map(|(owner, data)| BoundFunctionRow {
                owner: owner.0,
                target: data.target.0,
                this_arg: data.this_arg,
                args: data.args.clone(),
            })
            .collect();
        bound_functions.sort_unstable_by_key(|row| row.owner);

        let mut ctor_prototypes: Vec<(u32, u32)> = self
            .ctor_prototype
            .iter()
            .filter(|(owner, _)| owners.contains(&owner.0))
            .map(|(owner, prototype)| (owner.0, prototype.0))
            .collect();
        ctor_prototypes.sort_unstable();

        let mut deleted_meta: Vec<(u32, u16)> = self
            .deleted_fn_meta
            .iter()
            .map(|(owner, id)| (owner.0, *id))
            .collect();
        deleted_meta.sort_unstable();

        let mut native_names: Vec<_> = self
            .functions
            .iter()
            .filter(|(owner, info)| {
                owner.0 < self.boot_slot_count
                    && self.function_persists(**owner)
                    && (info.native.is_some() || info.method.is_some())
                    && !self.proxy_revokers.contains_key(owner)
                    && !self.promise_functions.contains_key(owner)
                    && !self.collator_compare_functions.contains_key(owner)
                    && !self.number_format_bound_functions.contains_key(owner)
            })
            .map(|(owner, info)| (owner.0, info.name_chunk.0))
            .collect();
        native_names.sort_unstable();
        FunctionStateSnapshot {
            native_names: Some(native_names),
            segments,
            functions,
            bound_functions,
            ctor_prototypes,
            deleted_meta,
        }
    }

    pub(super) fn native_names_are_valid(&self, rows: Option<&[(u32, u32)]>) -> bool {
        let Some(rows) = rows else {
            return true;
        };
        if self
            .validate_restore_owners(rows.iter().map(|row| row.0), "NativeNames")
            .is_err()
            || rows.iter().any(|(owner, offset)| {
                *owner >= self.boot_slot_count
                    || !self
                        .functions
                        .get(&crate::value::SlotIndex(*owner))
                        .is_some_and(|info| info.native.is_some() || info.method.is_some())
                    || *offset == u32::MAX
                    || (*offset as usize) < crate::value::CHUNK_HEADER
                    || (*offset as usize) > self.chunks.byte_size()
            })
        {
            return false;
        }
        let offsets: Vec<_> = rows
            .iter()
            .map(|&(_, offset)| crate::value::ChunkOffset(offset))
            .collect();
        self.chunks.validate_references(&offsets).is_ok()
            && offsets
                .iter()
                .all(|&offset| self.chunks.payload(offset).len().is_multiple_of(2))
    }

    /// Restore the authoritative surviving boot-native name table before
    /// runtime function clusters, which may reuse collected boot slot indices.
    /// The native implementation stays boot-derived; only chunk locations travel.
    pub(super) fn restore_native_names(&mut self, rows: Option<&[(u32, u32)]>) -> bool {
        if !self.native_names_are_valid(rows) {
            return false;
        }
        let Some(rows) = rows else {
            return true;
        };
        let owners: std::collections::BTreeSet<_> = rows.iter().map(|(owner, _)| *owner).collect();
        self.functions.retain(|owner, info| {
            owner.0 >= self.boot_slot_count
                || (info.native.is_none() && info.method.is_none())
                || owners.contains(&owner.0)
        });
        for &(owner, offset) in rows {
            self.functions
                .update(&crate::value::SlotIndex(owner), |info| {
                    info.name_chunk = crate::value::ChunkOffset(offset);
                })
                .unwrap();
        }
        true
    }

    /// Restore a validated atomic guest-callability cluster.
    pub(super) fn restore_function_state(
        &mut self,
        state: FunctionStateSnapshot,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "Functions";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owners(state.functions.iter().map(|row| row.owner), ROW)?;
        self.validate_restore_owners(state.bound_functions.iter().map(|row| row.owner), ROW)?;
        self.validate_restore_owners(state.ctor_prototypes.iter().map(|row| row.0), ROW)?;
        if state.deleted_meta.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(refuse("deleted metadata keys are not strictly ascending"));
        }
        for &(owner, id) in &state.deleted_meta {
            self.validate_restore_owner(owner, ROW)?;
            if id == 0 || usize::from(id) > self.symbol_names.len() {
                return Err(refuse("deleted metadata key is outside the name table"));
            }
        }
        let mut values = Vec::new();
        for row in &state.functions {
            if row.home != u32::MAX {
                self.validate_restore_owner(row.home, ROW)?;
            }
            if row.closures != u32::MAX {
                let closures = crate::value::SlotIndex(row.closures);
                if closures.0 >= self.slots.capacity() || self.slots.is_free_index(closures) {
                    return Err(refuse("closures is not a live slot"));
                }
                let env = self.slots.get(closures);
                // Environment instances use None for a null enclosing scope.
                if env.kind != Kind::Instance
                    || !matches!(env.value, Payload::None | Payload::Reference(_))
                {
                    return Err(refuse("closures is not an environment instance"));
                }
            }
            if row.name_chunk != u32::MAX {
                values.push(Slot::of(
                    Kind::String,
                    Payload::String(crate::value::ChunkOffset(row.name_chunk)),
                ));
            }
        }
        for row in &state.bound_functions {
            self.validate_restore_owner(row.target, ROW)?;
            values.push(row.this_arg);
            values.extend_from_slice(&row.args);
        }
        for &(_, prototype) in &state.ctor_prototypes {
            self.validate_restore_owner(prototype, ROW)?;
        }
        self.validate_restore_values(values, ROW)?;
        if !self.native_names_are_valid(state.native_names.as_deref()) {
            return Err(refuse("invalid native name rows"));
        }
        // Validate against the metadata that will remain after native pruning.
        let existing_function = |owner: crate::value::SlotIndex| {
            self.functions.get(&owner).is_some_and(|info| {
                owner.0 >= self.boot_slot_count
                    || (info.native.is_none() && info.method.is_none())
                    || state.native_names.as_ref().is_none_or(|rows| {
                        rows.binary_search_by_key(&owner.0, |(id, _)| *id).is_ok()
                    })
            })
        };
        let function_owners: std::collections::BTreeSet<u32> =
            state.functions.iter().map(|row| row.owner).collect();
        let bound_owners: std::collections::BTreeSet<u32> =
            state.bound_functions.iter().map(|row| row.owner).collect();

        let mut referenced_segments = std::collections::BTreeSet::new();
        for row in &state.functions {
            let owner = crate::value::SlotIndex(row.owner);
            if existing_function(owner) {
                return Err(refuse("function owner already has metadata"));
            }
            match (row.segment, row.body_start) {
                (Some(segment), Some(start)) => {
                    let Some(code) = state.segments.get(segment as usize) else {
                        return Err(refuse("body names no segment"));
                    };
                    let Some(end) = start.checked_add(row.body_len) else {
                        return Err(refuse("body range overflow"));
                    };
                    if end > code.len() as u64 {
                        return Err(refuse("body range outside segment"));
                    }
                    let mut pc = start as usize;
                    while pc < end as usize {
                        let len = crate::instruction_len(code, pc)
                            .ok_or_else(|| refuse("malformed body bytecode"))?;
                        pc += len;
                    }
                    if pc != end as usize {
                        return Err(refuse("body instruction crosses its range"));
                    }
                    referenced_segments.insert(segment);
                }
                (None, None) if bound_owners.contains(&row.owner) => {
                    if row.body_len != 0 {
                        return Err(refuse("bound function has a nonzero body length"));
                    }
                }
                _ => return Err(refuse("body and segment disagree")),
            }
        }
        if referenced_segments.len() != state.segments.len() {
            return Err(refuse("segments are not densely referenced"));
        }
        for row in &state.bound_functions {
            if !function_owners.contains(&row.owner)
                || (!function_owners.contains(&row.target)
                    && !existing_function(crate::value::SlotIndex(row.target)))
            {
                return Err(refuse("bound target has no function metadata"));
            }
        }
        if state
            .ctor_prototypes
            .iter()
            .any(|(owner, _)| !function_owners.contains(owner))
        {
            return Err(refuse("constructor owner has no function row"));
        }

        if !self.restore_native_names(state.native_names.as_deref()) {
            return Err(refuse("invalid native name rows"));
        }
        *self.code_segments = state.segments.into_iter().map(std::rc::Rc::from).collect();
        self.func_segments.clear();
        for row in state.functions {
            let owner = crate::value::SlotIndex(row.owner);
            if let Some(segment) = row.segment {
                self.func_segments.insert(owner, segment as usize);
            }
            self.functions.insert(
                owner,
                FuncInfo {
                    body_start: row.body_start.map(|v| v as usize),
                    body_len: row.body_len as usize,
                    closures: crate::value::SlotIndex(row.closures),
                    native: None,
                    method: None,
                    name: row.name,
                    arity: row.arity,
                    name_chunk: crate::value::ChunkOffset(row.name_chunk),
                    is_generator: row.is_generator,
                    home: crate::value::SlotIndex(row.home),
                    class_derived: row.class_derived,
                },
            );
        }
        for row in state.bound_functions {
            self.bound_functions.insert(
                crate::value::SlotIndex(row.owner),
                BoundData {
                    target: crate::value::SlotIndex(row.target),
                    this_arg: row.this_arg,
                    args: row.args,
                },
            );
        }
        for (owner, prototype) in state.ctor_prototypes {
            self.ctor_prototype.insert(
                crate::value::SlotIndex(owner),
                crate::value::SlotIndex(prototype),
            );
        }
        for (owner, id) in state.deleted_meta {
            self.deleted_fn_meta
                .insert((crate::value::SlotIndex(owner), id));
        }
        Ok(())
    }

    pub fn proxy_state_snapshot(&self) -> ProxyStateSnapshot {
        let mut proxies: Vec<ProxyRow> = self
            .proxies
            .iter()
            .map(|(owner, data)| ProxyRow {
                owner: owner.0,
                target: data.target.0,
                handler: data.handler.0,
                revoked: data.revoked,
            })
            .collect();
        proxies.sort_unstable_by_key(|row| row.owner);

        let mut revokers: Vec<ProxyRevokerRow> = self
            .proxy_revokers
            .iter()
            .map(|(owner, proxy)| {
                let info = &self.functions[owner];
                ProxyRevokerRow {
                    owner: owner.0,
                    proxy: proxy.0,
                    name_chunk: info.name_chunk.0,
                }
            })
            .collect();
        revokers.sort_unstable_by_key(|row| row.owner);
        ProxyStateSnapshot { proxies, revokers }
    }

    pub(super) fn restore_proxy_state(
        &mut self,
        state: ProxyStateSnapshot,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "Proxies";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owners(state.proxies.iter().map(|row| row.owner), ROW)?;
        self.validate_restore_owners(state.revokers.iter().map(|row| row.owner), ROW)?;
        let proxy_owners: std::collections::BTreeSet<u32> =
            state.proxies.iter().map(|row| row.owner).collect();
        for row in &state.proxies {
            if row.revoked {
                if row.target != u32::MAX || row.handler != u32::MAX {
                    return Err(refuse("revoked proxy retains target or handler"));
                }
            } else {
                self.validate_restore_owner(row.target, ROW)?;
                self.validate_restore_owner(row.handler, ROW)?;
            }
        }
        let mut names = Vec::new();
        for row in &state.revokers {
            if !proxy_owners.contains(&row.proxy) {
                return Err(refuse("revoker names no proxy row"));
            }
            if proxy_owners.contains(&row.owner)
                || self
                    .functions
                    .contains_key(&crate::value::SlotIndex(row.owner))
            {
                return Err(refuse("revoker owner already has callable metadata"));
            }
            if row.name_chunk != u32::MAX {
                names.push(Slot::of(
                    Kind::String,
                    Payload::String(crate::value::ChunkOffset(row.name_chunk)),
                ));
            }
        }
        self.validate_restore_values(names, ROW)?;
        for row in state.proxies {
            self.proxies.insert(
                crate::value::SlotIndex(row.owner),
                ProxyData {
                    target: crate::value::SlotIndex(row.target),
                    handler: crate::value::SlotIndex(row.handler),
                    revoked: row.revoked,
                },
            );
        }
        for row in state.revokers {
            let owner = crate::value::SlotIndex(row.owner);
            self.functions.insert(
                owner,
                FuncInfo {
                    method: Some(NativeMethod::ProxyRevoke),
                    name_chunk: crate::value::ChunkOffset(row.name_chunk),
                    ..FuncInfo::default()
                },
            );
            self.proxy_revokers
                .insert(owner, crate::value::SlotIndex(row.proxy));
        }
        Ok(())
    }

    /// Snapshot guest accessor getter/setter mappings. Exact boot seeds are
    /// re-derived and omitted.
    pub fn accessors_snapshot(&self) -> Vec<AccessorRow> {
        let mut rows: Vec<AccessorRow> = self
            .accessors
            .iter()
            .filter(|((owner, id), data)| !self.is_boot_seed_accessor(*owner, *id, data))
            .map(|((owner, id), data)| AccessorRow {
                owner: owner.0,
                id: *id,
                get: data.get,
                set: data.set,
            })
            .collect();
        rows.sort_unstable_by_key(|row| (row.owner, row.id));
        rows
    }

    pub(super) fn restore_accessors(&mut self, rows: Vec<AccessorRow>) -> Result<(), RestoreError> {
        const ROW: &str = "Accessors";
        if rows
            .windows(2)
            .any(|pair| (pair[0].owner, pair[0].id) >= (pair[1].owner, pair[1].id))
        {
            return Err(RestoreError {
                row: ROW,
                reason: "keys are not strictly ascending",
            });
        }
        for row in &rows {
            self.validate_restore_owner(row.owner, ROW)?;
            if row.id == 0 {
                return Err(RestoreError {
                    row: ROW,
                    reason: "property key is not registered",
                });
            }
            for value in [row.get, row.set].into_iter().flatten() {
                self.validate_restore_value_shape(value, ROW)?;
                if value.kind != Kind::Reference
                    || !matches!(value.value, Payload::Reference(function) if self.functions.contains_key(&function))
                {
                    return Err(RestoreError {
                        row: ROW,
                        reason: "getter or setter is not callable",
                    });
                }
            }
        }
        for row in rows {
            self.accessors.insert(
                (crate::value::SlotIndex(row.owner), row.id),
                AccessorData {
                    get: row.get,
                    set: row.set,
                },
            );
        }
        Ok(())
    }

    pub fn intl_bound_functions_snapshot(&self) -> Vec<IntlBoundFunctionRow> {
        let mut rows = Vec::new();
        for (function, owner) in &self.collator_compare_functions {
            let info = &self.functions[function];
            rows.push(IntlBoundFunctionRow {
                kind: 0,
                function: function.0,
                owner: owner.0,
                name: info.name.clone(),
                name_chunk: info.name_chunk.0,
                arity: info.arity,
            });
        }
        for (function, owner) in &self.number_format_bound_functions {
            let info = &self.functions[function];
            rows.push(IntlBoundFunctionRow {
                kind: 1,
                function: function.0,
                owner: owner.0,
                name: info.name.clone(),
                name_chunk: info.name_chunk.0,
                arity: info.arity,
            });
        }
        rows.sort_unstable_by_key(|row| row.function);
        rows
    }

    pub(super) fn restore_intl_bound_functions(
        &mut self,
        rows: Vec<IntlBoundFunctionRow>,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "IntlBoundFunctions";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owners(rows.iter().map(|row| row.function), ROW)?;
        for row in &rows {
            self.validate_restore_owner(row.owner, ROW)?;
            if self
                .functions
                .contains_key(&crate::value::SlotIndex(row.function))
            {
                return Err(refuse("function owner already has metadata"));
            }
            let owner = crate::value::SlotIndex(row.owner);
            match row.kind {
                0 if self.collators.contains_key(&owner) => {}
                1 if self.number_formats.contains_key(&owner) => {}
                _ => return Err(refuse("owner has no matching Intl row")),
            }
        }
        self.validate_restore_values(
            rows.iter()
                .filter(|row| row.name_chunk != u32::MAX)
                .map(|row| {
                    Slot::of(
                        Kind::String,
                        Payload::String(crate::value::ChunkOffset(row.name_chunk)),
                    )
                }),
            ROW,
        )?;

        for row in rows {
            let function = crate::value::SlotIndex(row.function);
            let owner = crate::value::SlotIndex(row.owner);
            let method = match row.kind {
                0 if self.collators.contains_key(&owner) => NativeMethod::CollatorCompare,
                1 if self.number_formats.contains_key(&owner) => {
                    NativeMethod::NumberFormatBoundFormat
                }
                _ => unreachable!("Intl owner was validated before restore"),
            };
            self.functions.insert(
                function,
                FuncInfo {
                    method: Some(method),
                    name: row.name,
                    name_chunk: crate::value::ChunkOffset(row.name_chunk),
                    arity: row.arity,
                    ..FuncInfo::default()
                },
            );
            if row.kind == 0 {
                self.collator_compare_functions.insert(function, owner);
            } else {
                self.number_format_bound_functions.insert(function, owner);
                self.number_formats.get_mut(&owner).unwrap().bound_format = Some(function);
            }
        }
        Ok(())
    }

    pub fn private_elements_snapshot(&self) -> PrivateElementSnapshot {
        let mut values: Vec<PrivateValueRow> = self
            .private_values
            .iter()
            .map(|((receiver, brand), value)| PrivateValueRow {
                receiver: receiver.0,
                brand: brand.0,
                value: *value,
            })
            .collect();
        values.sort_unstable_by_key(|row| (row.receiver, row.brand));
        let mut accessors: Vec<PrivateAccessorRow> = self
            .private_accessors
            .iter()
            .map(|((receiver, brand), data)| PrivateAccessorRow {
                receiver: receiver.0,
                brand: brand.0,
                get: data.get,
                set: data.set,
            })
            .collect();
        accessors.sort_unstable_by_key(|row| (row.receiver, row.brand));
        PrivateElementSnapshot { values, accessors }
    }

    pub(super) fn restore_private_elements(
        &mut self,
        state: PrivateElementSnapshot,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "PrivateElements";
        let refuse = |reason| RestoreError { row: ROW, reason };
        let value_keys: Vec<_> = state
            .values
            .iter()
            .map(|row| (row.receiver, row.brand))
            .collect();
        let accessor_keys: Vec<_> = state
            .accessors
            .iter()
            .map(|row| (row.receiver, row.brand))
            .collect();
        for keys in [&value_keys, &accessor_keys] {
            if keys.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(refuse("keys are not strictly ascending"));
            }
            for &(receiver, brand) in keys {
                self.validate_restore_owner(receiver, ROW)?;
                // A private brand is a captured binding cell, not an object.
                // Its value may still be uninitialized; only its live identity
                // participates in private-element lookup.
                let brand = crate::value::SlotIndex(brand);
                if brand.is_null()
                    || brand.0 >= self.slots.capacity()
                    || self.slots.is_free_index(brand)
                {
                    return Err(refuse("brand is not a live slot"));
                }
            }
        }
        if accessor_keys
            .iter()
            .any(|key| value_keys.binary_search(key).is_ok())
        {
            return Err(refuse("key has both value and accessor rows"));
        }
        self.validate_restore_values(
            state.values.iter().map(|row| row.value).chain(
                state
                    .accessors
                    .iter()
                    .flat_map(|row| [row.get, row.set].into_iter().flatten()),
            ),
            ROW,
        )?;
        for row in &state.accessors {
            for value in [row.get, row.set].into_iter().flatten() {
                if value.kind != Kind::Reference {
                    return Err(refuse("getter or setter is not callable"));
                }
                let Payload::Reference(function) = value.value else {
                    return Err(refuse("getter or setter is not callable"));
                };
                if !self.functions.contains_key(&function) {
                    return Err(refuse("getter or setter is not callable"));
                }
            }
        }
        for row in state.values {
            self.private_values.insert(
                (
                    crate::value::SlotIndex(row.receiver),
                    crate::value::SlotIndex(row.brand),
                ),
                row.value,
            );
        }
        for row in state.accessors {
            self.private_accessors.insert(
                (
                    crate::value::SlotIndex(row.receiver),
                    crate::value::SlotIndex(row.brand),
                ),
                AccessorData {
                    get: row.get,
                    set: row.set,
                },
            );
        }
        Ok(())
    }

    pub fn disposable_stacks_snapshot(&self) -> Vec<DisposableStackRow> {
        let mut rows: Vec<DisposableStackRow> = self
            .disposable_stacks
            .iter()
            .map(|(owner, data)| DisposableStackRow {
                owner: owner.0,
                disposed: data.disposed,
                asynchronous: data.asynchronous,
                records: data
                    .records
                    .iter()
                    .map(|record| DisposalRecordRow {
                        resource: record.resource,
                        method: record.method,
                        pass_resource: record.pass_resource,
                    })
                    .collect(),
            })
            .collect();
        rows.sort_unstable_by_key(|row| row.owner);
        rows
    }

    /// Validate and restore retained disposal records as one batch.
    /// Method references must name live instances; their callable identity is
    /// a cross-table obligation involving restored functions and proxies.
    pub(super) fn restore_disposable_stacks(
        &mut self,
        rows: Vec<DisposableStackRow>,
    ) -> Result<(), RestoreError> {
        self.validate_restore_owners(rows.iter().map(|row| row.owner), "DisposableStacks")?;
        for row in &rows {
            if row.disposed && !row.records.is_empty() {
                return Err(RestoreError {
                    row: "DisposableStacks",
                    reason: "disposed stack retains records",
                });
            }
            for record in &row.records {
                if record.method.kind != Kind::Reference {
                    return Err(RestoreError {
                        row: "DisposableStacks",
                        reason: "disposal method is not a reference",
                    });
                }
            }
        }
        self.validate_restore_values(
            rows.iter().flat_map(|row| {
                row.records
                    .iter()
                    .flat_map(|record| [record.resource, record.method])
            }),
            "DisposableStacks",
        )?;
        for row in rows {
            self.disposable_stacks.insert(
                crate::value::SlotIndex(row.owner),
                DisposableStackData {
                    disposed: row.disposed,
                    asynchronous: row.asynchronous,
                    records: row
                        .records
                        .into_iter()
                        .map(|record| DisposalRecord {
                            resource: record.resource,
                            method: record.method,
                            pass_resource: record.pass_resource,
                        })
                        .collect(),
                },
            );
        }
        Ok(())
    }

    pub(super) fn saved_frame_snapshot(
        &self,
        frame: &SavedFrame,
        segment_remap: &std::collections::BTreeMap<usize, u32>,
    ) -> SavedFrameRow {
        let sorted_map = |map: &std::collections::HashMap<u16, usize>| {
            let mut rows: Vec<(u16, u64)> =
                map.iter().map(|(id, index)| (*id, *index as u64)).collect();
            rows.sort_unstable();
            rows
        };
        SavedFrameRow {
            locals: frame.locals.clone(),
            id_map: sorted_map(&frame.id_map),
            args: frame.args.clone(),
            this_val: frame.this_val,
            env: frame.env,
            cur_func: frame.cur_func.0,
            cur_target: frame.cur_target,
            target_func: frame.target_func.0,
            strict: frame.strict,
            result: frame.result,
            stack_slice: frame.stack_slice.clone(),
            jumps: frame
                .jumps
                .iter()
                .map(|jump| SavedJumpRow {
                    target_pc: jump.target_pc as u64,
                    segment: jump
                        .segment
                        .or_else(|| self.func_segments.get(&frame.cur_func).copied())
                        .map(|segment| segment_remap[&segment]),
                    stack_offset: jump.stack_offset as u64,
                    locals_len: jump.locals_len as u64,
                    id_map: sorted_map(&jump.id_map),
                    call_depth_offset: jump.call_depth_offset as u64,
                    env: jump.env,
                    flag: jump.flag,
                })
                .collect(),
            resume_pc: frame.resume_pc as u64,
        }
    }

    fn validate_restore_frame(&self, frame: &SavedFrameRow) -> Result<(), RestoreError> {
        const ROW: &str = "SavedFrame";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owner(frame.cur_func, ROW)?;
        if frame.target_func != u32::MAX {
            self.validate_restore_owner(frame.target_func, ROW)?;
        }
        let scope = |entries: &[(u16, u64)], length: u64| -> Result<(), RestoreError> {
            if entries.windows(2).any(|pair| pair[0].0 >= pair[1].0)
                || entries.iter().any(|&(id, index)| {
                    id == 0 || usize::from(id) > self.symbol_names.len() || index >= length
                })
            {
                return Err(refuse("invalid scope map"));
            }
            Ok(())
        };
        scope(&frame.id_map, frame.locals.len() as u64)?;
        for jump in &frame.jumps {
            if jump.flag != 1
                || jump.call_depth_offset != 0
                || jump.stack_offset > frame.stack_slice.len() as u64
                || jump.locals_len > frame.locals.len() as u64
            {
                return Err(refuse("invalid saved handler shape"));
            }
            scope(&jump.id_map, jump.locals_len)?;
        }
        for value in frame
            .locals
            .iter()
            .chain(&frame.args)
            .chain(&frame.stack_slice)
            .copied()
            .chain([frame.this_val, frame.result])
        {
            match (value.kind, value.value) {
                (Kind::Uninitialized, Payload::None) => {}
                (Kind::Closure, Payload::Reference(cell)) => {
                    if cell.is_null()
                        || cell.0 >= self.slots.capacity()
                        || self.slots.is_free_index(cell)
                    {
                        return Err(refuse("closure cell is not live"));
                    }
                }
                _ => {
                    self.validate_restore_value_shape(value, ROW)?;
                }
            }
        }
        for env in std::iter::once(frame.env).chain(frame.jumps.iter().map(|jump| jump.env)) {
            match (env.kind, env.value) {
                (Kind::Undefined, Payload::None) => {}
                (Kind::Reference, Payload::Reference(owner)) => {
                    if owner.is_null()
                        || owner.0 >= self.slots.capacity()
                        || self.slots.is_free_index(owner)
                    {
                        return Err(refuse("environment is not live"));
                    }
                    let instance = self.slots.get(owner);
                    if instance.kind != Kind::Instance
                        || !matches!(instance.value, Payload::None | Payload::Reference(_))
                    {
                        return Err(refuse("environment is not an instance"));
                    }
                }
                _ => return Err(refuse("invalid environment value")),
            }
        }
        Ok(())
    }

    pub(super) fn restore_saved_frame(
        &self,
        row: SavedFrameRow,
    ) -> Result<SavedFrame, RestoreError> {
        self.validate_restore_frame(&row)?;
        let convert = || {
            let map = |rows: Vec<(u16, u64)>| -> Option<std::collections::HashMap<u16, usize>> {
                rows.into_iter()
                    .map(|(id, index)| Some((id, usize::try_from(index).ok()?)))
                    .collect()
            };
            Some(SavedFrame {
                locals: row.locals,
                id_map: std::rc::Rc::new(map(row.id_map)?),
                args: row.args,
                this_val: row.this_val,
                env: row.env,
                cur_func: crate::value::SlotIndex(row.cur_func),
                cur_target: row.cur_target,
                target_func: crate::value::SlotIndex(row.target_func),
                strict: row.strict,
                result: row.result,
                stack_slice: row.stack_slice,
                jumps: row
                    .jumps
                    .into_iter()
                    .map(|jump| {
                        Some(SavedJump {
                            target_pc: usize::try_from(jump.target_pc).ok()?,
                            // Legacy rows still resolve through cur_func at resume.
                            segment: jump.segment.map(|segment| segment as usize),
                            stack_offset: usize::try_from(jump.stack_offset).ok()?,
                            locals_len: usize::try_from(jump.locals_len).ok()?,
                            id_map: std::rc::Rc::new(map(jump.id_map)?),
                            call_depth_offset: usize::try_from(jump.call_depth_offset).ok()?,
                            env: jump.env,
                            flag: jump.flag,
                        })
                    })
                    .collect::<Option<Vec<_>>>()?,
                resume_pc: usize::try_from(row.resume_pc).ok()?,
            })
        };
        convert().ok_or(RestoreError {
            row: "SavedFrame",
            reason: "frame coordinates exceed the host index range",
        })
    }

    pub fn generators_snapshot(&self) -> Vec<GeneratorRow> {
        let segment_remap = if self.generators.values().any(|data| {
            data.frame
                .as_ref()
                .is_some_and(|frame| !frame.jumps.is_empty())
        }) {
            self.snapshot_code_segment_remap()
        } else {
            Default::default()
        };
        let mut rows: Vec<GeneratorRow> = self
            .generators
            .iter()
            .map(|(owner, data)| GeneratorRow {
                owner: owner.0,
                state: match data.state {
                    GeneratorState::SuspendedStart => 0,
                    GeneratorState::SuspendedYield => 1,
                    GeneratorState::Completed => 2,
                    GeneratorState::Executing => 3,
                },
                frame: data
                    .frame
                    .as_ref()
                    .map(|frame| self.saved_frame_snapshot(frame, &segment_remap)),
            })
            .collect();
        rows.sort_unstable_by_key(|row| row.owner);
        rows
    }

    pub(super) fn restore_generators(
        &mut self,
        rows: Vec<GeneratorRow>,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "Generators";
        self.validate_restore_owners(rows.iter().map(|row| row.owner), ROW)?;
        let mut prepared = Vec::with_capacity(rows.len());
        for row in rows {
            let state = match row.state {
                0 => GeneratorState::SuspendedStart,
                1 => GeneratorState::SuspendedYield,
                2 => GeneratorState::Completed,
                _ => {
                    return Err(RestoreError {
                        row: ROW,
                        reason: "invalid generator state",
                    })
                }
            };
            if (state == GeneratorState::Completed) != row.frame.is_none() {
                return Err(RestoreError {
                    row: ROW,
                    reason: "state and frame disagree",
                });
            }
            let frame = row
                .frame
                .map(|frame| self.restore_saved_frame(frame))
                .transpose()?;
            prepared.push((
                crate::value::SlotIndex(row.owner),
                GeneratorData { state, frame },
            ));
        }
        for (owner, data) in prepared {
            self.generators.insert(owner, data);
        }
        Ok(())
    }

    /// Quiescent snapshot of the promise cluster (ledger rows
    /// `Promises`/`PromiseFunctions`/`PromiseGuards`/`Combinators`, the
    /// `PRMS` atom). Promise and resolving-function rows ascend by
    /// owner slot; the two index arenas are emitted COMPACTED (see
    /// [`PromiseClusterSnapshot`]) so the encoding is canonical and
    /// every emitted entry is provably live. Free-listed owners are
    /// skipped, as everywhere: a swept instance's stale row names
    /// nothing.
    ///
    /// AsyncAwait reactions name the suspended frames carried alongside
    /// PRMS in ASYN. Async-generator and Array.fromAsync reactions still
    /// refuse at the persistence boundary.
    pub fn promise_cluster_snapshot(&self) -> PromiseClusterSnapshot {
        let mut promises: Vec<(crate::value::SlotIndex, &PromiseData)> = self
            .promises
            .iter()
            .filter(|(owner, _)| !self.slots.is_free_index(**owner))
            .map(|(owner, data)| (*owner, data))
            .collect();
        promises.sort_unstable_by_key(|(owner, _)| owner.0);
        let mut functions: Vec<(crate::value::SlotIndex, &PromiseFnData)> = self
            .promise_functions
            .iter()
            .filter(|(owner, _)| !self.slots.is_free_index(**owner))
            .map(|(owner, data)| (*owner, data))
            .collect();
        functions.sort_unstable_by_key(|(owner, _)| owner.0);

        // The live-index sets, exactly `compact_reaction_arenas`' rule
        // over the rows being emitted (the job queue, its other holder,
        // is empty at every persistable boundary).
        let live_guards: std::collections::BTreeSet<usize> = functions
            .iter()
            .filter_map(|(_, d)| is_promise_resolving_guard(d.guard).then_some(d.guard))
            .collect();
        let live_comb: std::collections::BTreeSet<u32> = promises
            .iter()
            .flat_map(|(_, p)| p.reactions.iter())
            .filter_map(|r| match r.kind {
                ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => Some(ci),
                _ => None,
            })
            .collect();
        let guard_map: std::collections::HashMap<usize, u32> = live_guards
            .iter()
            .enumerate()
            .map(|(new, &old)| (old, new as u32))
            .collect();
        let comb_map: std::collections::HashMap<u32, u32> = live_comb
            .iter()
            .enumerate()
            .map(|(new, &old)| (old, new as u32))
            .collect();

        let segment_remap = if self.async_instances.values().any(|data| {
            !data.done
                && data
                    .frame
                    .as_ref()
                    .is_some_and(|frame| !frame.jumps.is_empty())
        }) {
            self.snapshot_code_segment_remap()
        } else {
            Default::default()
        };
        let mut async_instances: Vec<_> = self
            .async_instances
            .iter()
            .filter(|(owner, data)| !self.slots.is_free_index(**owner) && !data.done)
            .filter_map(|(owner, data)| {
                data.frame.as_ref().map(|frame| AsyncRow {
                    owner: owner.0,
                    frame: self.saved_frame_snapshot(frame, &segment_remap),
                    result_promise: data.result_promise.0,
                    resolve: data.resolve_fn,
                    reject: data.reject_fn,
                })
            })
            .collect();
        async_instances.sort_unstable_by_key(|row| row.owner);
        PromiseClusterSnapshot {
            async_instances,
            promises: promises
                .into_iter()
                .map(|(owner, data)| PromiseRow {
                    owner: owner.0,
                    state: match data.state {
                        PromiseState::Pending => 0,
                        PromiseState::Fulfilled => 1,
                        PromiseState::Rejected => 2,
                    },
                    result: data.result,
                    ever_handled: data.ever_handled,
                    reactions: data
                        .reactions
                        .iter()
                        .map(|r| {
                            let (kind, a, b) = match r.kind {
                                ReactionKind::User => (0, 0, 0),
                                ReactionKind::FinallyReturn => (1, 0, 0),
                                ReactionKind::Combine(ci, elem) => (2, comb_map[&ci], elem),
                                ReactionKind::CombineDirect(ci, elem) => (12, comb_map[&ci], elem),
                                ReactionKind::AsyncAwait(i) => (3, i.0, 0),
                                ReactionKind::AsyncGeneratorAwait(i) => (4, i.0, 0),
                                ReactionKind::AsyncGeneratorYield(i) => (5, i.0, 0),
                                ReactionKind::AsyncGeneratorReturn(i) => (6, i.0, 0),
                                ReactionKind::FromAsyncNext(fa) => (7, fa, 0),
                                ReactionKind::FromAsyncElem(fa) => (8, fa, 0),
                                ReactionKind::FromAsyncMap(fa) => (9, fa, 0),
                                ReactionKind::FromAsyncClose(fa) => (10, fa, 0),
                                ReactionKind::FinallyAwait(rejected) => (11, rejected as u32, 0),
                            };
                            PromiseReactionRow {
                                on_fulfilled: r.on_fulfilled,
                                on_rejected: r.on_rejected,
                                resolve: r.resolve,
                                reject: r.reject,
                                kind,
                                a,
                                b,
                            }
                        })
                        .collect(),
                })
                .collect(),
            functions: functions
                .into_iter()
                .map(|(owner, data)| PromiseFnRow {
                    function: owner.0,
                    promise: data.promise.0,
                    reject: data.reject,
                    guard: match data.guard {
                        PROMISE_CAPABILITY_EXECUTOR_GUARD => u32::MAX,
                        PROMISE_FINALLY_HANDLER_GUARD => u32::MAX - 1,
                        PROMISE_FINALLY_VALUE_GUARD => u32::MAX - 2,
                        guard => guard_map[&guard],
                    },
                    name_chunk: self.functions[&owner].name_chunk.0,
                })
                .collect(),
            guards: live_guards
                .iter()
                .map(|&old| self.promise_guards[old])
                .collect(),
            combinators: live_comb
                .iter()
                .map(|&old| {
                    let c = &self.combinators[old as usize];
                    CombinatorRow {
                        kind: match c.kind {
                            CombinatorKind::All => 0,
                            CombinatorKind::AllSettled => 1,
                            CombinatorKind::Race => 2,
                            CombinatorKind::Any => 3,
                        },
                        resolve: c.resolve,
                        reject: c.reject,
                        remaining: c.remaining,
                        results: c.results.0,
                    }
                })
                .collect(),
        }
    }

    /// Restore a validated promise cluster onto a fresh boot machine.
    /// Rebuilds each resolving function's `FuncInfo` exactly as
    /// [`Self::make_resolving_functions`] minted it — the same
    /// resurrect-the-native pattern as
    /// [`Self::restore_intl_bound_functions`] — and refuses a function
    /// slot boot already owns (the reverse collision, a cluster row at
    /// a guest function's slot, is refused by `restore_function_state`
    /// running after this verb). The cross-checks the decoder already
    /// proved are re-validated belt-and-braces, as everywhere.
    pub(super) fn restore_promise_cluster(&mut self, snap: PromiseClusterSnapshot) -> bool {
        let owners: std::collections::BTreeSet<u32> =
            snap.promises.iter().map(|row| row.owner).collect();
        // Per-combinator results-Array length, for the element-index
        // bound below (the bulk side tables restore before this verb,
        // so the rows are in hand). Capability callability is checked
        // after retained function state has restored.
        let mut results_lengths = Vec::with_capacity(snap.combinators.len());
        for c in &snap.combinators {
            if c.kind > 3 || c.resolve.kind != Kind::Reference || c.reject.kind != Kind::Reference {
                return false;
            }
            match self.arrays.get(&crate::value::SlotIndex(c.results)) {
                // `remaining` starts at the element count (the results
                // Array's preset length) and only decrements — and a
                // race never decrements it at all.
                Some(data)
                    if c.remaining <= data.length
                        && (c.kind != 2 || c.remaining == data.length) =>
                {
                    results_lengths.push(data.length)
                }
                _ => return false,
            }
        }
        let mut elem_seen = std::collections::BTreeSet::<(u32, u32)>::new();
        let mut comb_pending = vec![0u32; snap.combinators.len()];
        // Capability slots may be arbitrary callbacks supplied by a custom
        // species constructor. Their callability is checked after retained
        // function state has been restored.
        let capability_ok = |resolve: &Slot, reject: &Slot| -> bool {
            resolve.kind == Kind::Reference && reject.kind == Kind::Reference
        };
        let direct_pair_ok = |owner: u32, resolve: &Slot, reject: &Slot| -> bool {
            let row_for = |slot: &Slot| match slot.value {
                Payload::Reference(function) if slot.kind == Kind::Reference => snap
                    .functions
                    .binary_search_by_key(&function.0, |row| row.function)
                    .ok()
                    .map(|index| &snap.functions[index]),
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
        for row in &snap.promises {
            let state = match row.state {
                0 => PromiseState::Pending,
                1 => PromiseState::Fulfilled,
                2 => PromiseState::Rejected,
                _ => return false,
            };
            // Settlement drains reactions into the job queue, and the
            // quiescence gate requires that queue empty — a settled row
            // that still holds reactions cannot be honest.
            if state != PromiseState::Pending && !row.reactions.is_empty() {
                return false;
            }
            let reactions: Option<Vec<PromiseReaction>> = row
                .reactions
                .iter()
                .map(|r| {
                    let kind = match r.kind {
                        0 if capability_ok(&r.resolve, &r.reject) && r.a == 0 && r.b == 0 => {
                            ReactionKind::User
                        }
                        1 if capability_ok(&r.resolve, &r.reject)
                            && r.a == 0
                            && r.b == 0
                            && r.on_rejected.kind == Kind::Reference =>
                        {
                            ReactionKind::FinallyReturn
                        }
                        3 if r.b == 0
                            && [r.on_fulfilled, r.on_rejected, r.resolve, r.reject]
                                .iter()
                                .all(|slot| slot.kind == Kind::Undefined) =>
                        {
                            ReactionKind::AsyncAwait(crate::value::SlotIndex(r.a))
                        }
                        11 if capability_ok(&r.resolve, &r.reject)
                            && r.a <= 1
                            && r.b == 0
                            && r.on_rejected.kind == Kind::Undefined =>
                        {
                            ReactionKind::FinallyAwait(r.a != 0)
                        }
                        // The element index must sit inside the results
                        // Array's carried length (the creation preset —
                        // `array_set_dense` would grow past it and the
                        // `any` aggregate walk iterates `0..length`),
                        // each `(combinator, element)` pair appears at
                        // most once (a duplicate would count one
                        // element twice at the drain), and a queued
                        // native element reaction carries NO callback slots.
                        2 if (r.a as usize) < snap.combinators.len()
                            && r.b < results_lengths[r.a as usize]
                            && [r.on_fulfilled, r.on_rejected, r.resolve, r.reject]
                                .iter()
                                .all(|slot| slot.kind == Kind::Undefined)
                            && elem_seen.insert((r.a, r.b)) =>
                        {
                            comb_pending[r.a as usize] += 1;
                            ReactionKind::Combine(r.a, r.b)
                        }
                        // A direct element callback is a private promise whose
                        // carried resolving pair must name this exact owner.
                        12 if (r.a as usize) < snap.combinators.len()
                            && r.b < results_lengths[r.a as usize]
                            && r.on_fulfilled.kind == Kind::Undefined
                            && r.on_rejected.kind == Kind::Undefined
                            && direct_pair_ok(row.owner, &r.resolve, &r.reject)
                            && elem_seen.insert((r.a, r.b)) =>
                        {
                            comb_pending[r.a as usize] += 1;
                            ReactionKind::CombineDirect(r.a, r.b)
                        }
                        // The async-flavored kinds name machinery no
                        // atom carries yet; the decoder refuses them
                        // and so does this verb — as it does the
                        // crafted shapes above.
                        _ => return None,
                    };
                    Some(PromiseReaction {
                        on_fulfilled: r.on_fulfilled,
                        on_rejected: r.on_rejected,
                        resolve: r.resolve,
                        reject: r.reject,
                        kind,
                    })
                })
                .collect();
            let Some(reactions) = reactions else {
                return false;
            };
            self.promises.insert(
                crate::value::SlotIndex(row.owner),
                PromiseData {
                    state,
                    result: row.result,
                    reactions,
                    ever_handled: row.ever_handled,
                },
            );
        }
        if snap
            .combinators
            .iter()
            .zip(comb_pending)
            .any(|(c, pending)| c.kind != 2 && c.remaining < pending)
        {
            return false;
        }
        // Guard coherence, the decoder's rule re-proved: one resolving
        // pair (or its surviving half) per guard, one promise per pair.
        let mut guard_rows: Vec<Option<(u32, u8)>> = vec![None; snap.guards.len()];
        let mut runtime_homes = std::collections::BTreeSet::new();
        for row in &snap.functions {
            let function = crate::value::SlotIndex(row.function);
            if self.functions.contains_key(&function) {
                return false;
            }
            if row.guard == u32::MAX - 1 || row.guard == u32::MAX - 2 {
                let home = crate::value::SlotIndex(row.promise);
                let required: &[&str] = if row.guard == u32::MAX - 1 {
                    &["[[PromiseFinallyHandler]]", "[[PromiseFinallyConstructor]]"]
                } else {
                    &["[[PromiseFinallyValue]]"]
                };
                if row.promise == row.function
                    || !runtime_homes.insert(row.promise)
                    || required.iter().any(|name| {
                        self.symbol_ids
                            .get(*name)
                            .and_then(|id| self.find_property(home, *id))
                            .is_none()
                    })
                {
                    return false;
                }
                let (method, guard, arity) = if row.guard == u32::MAX - 1 {
                    (
                        NativeMethod::PromiseFinallyHandler,
                        PROMISE_FINALLY_HANDLER_GUARD,
                        1,
                    )
                } else {
                    (
                        NativeMethod::PromiseFinallyValue,
                        PROMISE_FINALLY_VALUE_GUARD,
                        0,
                    )
                };
                self.functions.insert(
                    function,
                    FuncInfo {
                        method: Some(method),
                        name_chunk: crate::value::ChunkOffset(row.name_chunk),
                        arity,
                        ..FuncInfo::default()
                    },
                );
                self.promise_functions.insert(
                    function,
                    PromiseFnData {
                        promise: home,
                        reject: row.reject,
                        guard,
                    },
                );
                continue;
            }
            if row.guard == u32::MAX {
                let home = crate::value::SlotIndex(row.promise);
                let resolve_id = self.symbol_ids.get("[[PromiseCapabilityResolve]]").copied();
                let reject_id = self.symbol_ids.get("[[PromiseCapabilityReject]]").copied();
                if row.reject
                    || row.promise == row.function
                    || !runtime_homes.insert(row.promise)
                    || resolve_id
                        .and_then(|id| self.find_property(home, id))
                        .is_none()
                    || reject_id
                        .and_then(|id| self.find_property(home, id))
                        .is_none()
                {
                    return false;
                }
                // A fresh executor has two internal never-called sentinels;
                // a called executor has neither. A mixed pair is not reachable.
                let resolve = self.boot_chain_get(home, resolve_id.expect("checked field"));
                let reject = self.boot_chain_get(home, reject_id.expect("checked field"));
                if (resolve.kind == Kind::Uninitialized) != (reject.kind == Kind::Uninitialized) {
                    return false;
                }
                self.functions.insert(
                    function,
                    FuncInfo {
                        method: Some(NativeMethod::PromiseCapabilityExecutor),
                        name_chunk: crate::value::ChunkOffset(row.name_chunk),
                        arity: 2,
                        ..FuncInfo::default()
                    },
                );
                self.promise_functions.insert(
                    function,
                    PromiseFnData {
                        promise: crate::value::SlotIndex(row.promise),
                        reject: false,
                        guard: PROMISE_CAPABILITY_EXECUTOR_GUARD,
                    },
                );
                continue;
            }
            if !owners.contains(&row.promise) {
                return false;
            }
            let Some(entry) = guard_rows.get_mut(row.guard as usize) else {
                return false;
            };
            let polarity = 1u8 << (row.reject as u8);
            match entry {
                None => *entry = Some((row.promise, polarity)),
                Some((promise, mask)) => {
                    if *promise != row.promise || *mask & polarity != 0 {
                        return false;
                    }
                    *mask |= polarity;
                }
            }
            self.functions.insert(
                function,
                FuncInfo {
                    method: Some(if row.reject {
                        NativeMethod::PromiseRejectFunction
                    } else {
                        NativeMethod::PromiseResolveFunction
                    }),
                    name_chunk: crate::value::ChunkOffset(row.name_chunk),
                    arity: 1,
                    ..FuncInfo::default()
                },
            );
            self.promise_functions.insert(
                function,
                PromiseFnData {
                    promise: crate::value::SlotIndex(row.promise),
                    reject: row.reject,
                    guard: row.guard as usize,
                },
            );
        }
        for row in snap.async_instances {
            if self
                .async_instances
                .contains_key(&crate::value::SlotIndex(row.owner))
                || !owners.contains(&row.result_promise)
            {
                return false;
            }
            let Ok(frame) = self.restore_saved_frame(row.frame) else {
                return false;
            };
            self.async_instances.insert(
                crate::value::SlotIndex(row.owner),
                AsyncData {
                    frame: Some(frame),
                    result_promise: crate::value::SlotIndex(row.result_promise),
                    resolve_fn: row.resolve,
                    reject_fn: row.reject,
                    done: false,
                },
            );
        }
        *self.promise_guards = snap.guards;
        *self.combinators = snap
            .combinators
            .iter()
            .map(|c| CombinatorState {
                kind: match c.kind {
                    0 => CombinatorKind::All,
                    1 => CombinatorKind::AllSettled,
                    2 => CombinatorKind::Race,
                    _ => CombinatorKind::Any,
                },
                resolve: c.resolve,
                reject: c.reject,
                remaining: c.remaining,
                results: crate::value::SlotIndex(c.results),
            })
            .collect();
        true
    }

    /// Validate capability callbacks after all persisted function populations
    /// have been restored. Promise rows install before `FUNC` so bound/user
    /// callbacks can refer back to runtime-minted resolving functions; this
    /// second pass closes that intentional restore-order cycle.
    pub fn restored_promise_capabilities_are_valid(&self) -> bool {
        let reactions_valid = self.promises.values().all(|promise| {
            promise
                .reactions
                .iter()
                .all(|reaction| match reaction.kind {
                    ReactionKind::User | ReactionKind::FinallyAwait(_) => {
                        self.is_callable_value(reaction.resolve)
                            && self.is_callable_value(reaction.reject)
                    }
                    ReactionKind::FinallyReturn => {
                        self.is_callable_value(reaction.resolve)
                            && self.is_callable_value(reaction.reject)
                            && self.is_constructor_value(reaction.on_rejected)
                    }
                    ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => {
                        self.combinators.get(ci as usize).is_some_and(|c| {
                            self.is_callable_value(c.resolve) && self.is_callable_value(c.reject)
                        })
                    }
                    _ => true,
                })
        });
        let mut awaited = std::collections::BTreeSet::new();
        for promise in self.promises.values() {
            for reaction in &promise.reactions {
                if let ReactionKind::AsyncAwait(owner) = reaction.kind {
                    if !self.async_instances.contains_key(&owner) || !awaited.insert(owner.0) {
                        return false;
                    }
                }
            }
        }
        reactions_valid && self.async_instances.iter().all(|(owner, a)| {
            let function = |slot: Slot| match slot.value {
                Payload::Reference(f) => self.promise_functions.get(&f),
                _ => None,
            };
            let pair = matches!((function(a.resolve_fn), function(a.reject_fn)), (Some(r), Some(j))
                    if r.promise == a.result_promise && j.promise == a.result_promise
                        && !r.reject && j.reject && r.guard == j.guard
                        && self.promise_guards.get(r.guard) == Some(&false));
            pair && awaited.contains(&owner.0)
                && self.is_callable_value(a.resolve_fn)
                && self.is_callable_value(a.reject_fn)
                && a.frame
                    .as_ref()
                    .is_some_and(|f| self.functions.contains_key(&f.cur_func))
        }) && self.promise_functions.values().all(|data| {
            if data.guard != PROMISE_FINALLY_HANDLER_GUARD {
                return true;
            }
            let Some(&handler_id) = self.symbol_ids.get("[[PromiseFinallyHandler]]") else {
                return false;
            };
            let Some(&constructor_id) = self.symbol_ids.get("[[PromiseFinallyConstructor]]") else {
                return false;
            };
            self.is_callable_value(self.boot_chain_get(data.promise, handler_id))
                && self.is_constructor_value(self.boot_chain_get(data.promise, constructor_id))
        })
    }

    /// Quiescent snapshot of the four Temporal record tables (ledger
    /// `TemporalRecords` row, the `TMPR` atom), each ascending by
    /// owner: instants `(owner, epochNanoseconds)`, durations
    /// `(owner, the ten field values)`, plains `(owner, kind,
    /// year, [month, day, hour, minute, second, ms, µs, ns])`, zoneds
    /// `(owner, epochNanoseconds, timeZone, offsetNs)`.
    #[allow(clippy::type_complexity)]
    pub fn temporal_snapshot(
        &self,
    ) -> (
        Vec<(u32, i128)>,
        Vec<(u32, [i64; 10])>,
        Vec<(u32, u8, i64, [u32; 8])>,
        Vec<(u32, i128, String, i64)>,
    ) {
        let mut instants: Vec<(u32, i128)> = self
            .temporal_instants
            .iter()
            .map(|(o, r)| (o.0, r.epoch_nanoseconds))
            .collect();
        instants.sort_unstable_by_key(|(o, _)| *o);
        let mut durations: Vec<(u32, [i64; 10])> = self
            .temporal_durations
            .iter()
            .map(|(o, r)| (o.0, r.fields()))
            .collect();
        durations.sort_unstable_by_key(|(o, _)| *o);
        let mut plains: Vec<(u32, u8, i64, [u32; 8])> = self
            .temporal_plains
            .iter()
            .map(|(o, r)| {
                (
                    o.0,
                    r.kind,
                    r.year,
                    [
                        r.month,
                        r.day,
                        r.hour,
                        r.minute,
                        r.second,
                        r.millisecond,
                        r.microsecond,
                        r.nanosecond,
                    ],
                )
            })
            .collect();
        plains.sort_unstable_by_key(|(o, _, _, _)| *o);
        let mut zoneds: Vec<(u32, i128, String, i64)> = self
            .temporal_zoneds
            .iter()
            .map(|(o, r)| (o.0, r.epoch_nanoseconds, r.time_zone.clone(), r.offset_ns))
            .collect();
        zoneds.sort_unstable_by_key(|(o, _, _, _)| *o);
        (instants, durations, plains, zoneds)
    }

    /// Reinstate the four Temporal record tables. A plain record's
    /// `kind` outside the engine's discriminants (0..=4) can only be
    /// crafted bytes — the consuming natives match on it — so the
    /// Every row is checked before any record table changes.
    #[allow(clippy::type_complexity)]
    pub(super) fn restore_temporal_records(
        &mut self,
        instants: Vec<(u32, i128)>,
        durations: Vec<(u32, [i64; 10])>,
        plains: Vec<(u32, u8, i64, [u32; 8])>,
        zoneds: Vec<(u32, i128, String, i64)>,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "TemporalRecords";
        self.validate_restore_owners(instants.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(durations.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(plains.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(zoneds.iter().map(|row| row.0), ROW)?;
        if plains.iter().any(|row| row.1 > 4) {
            return Err(RestoreError {
                row: ROW,
                reason: "unknown plain-record kind",
            });
        }

        for (owner, epoch_nanoseconds) in instants {
            self.temporal_instants.insert(
                crate::value::SlotIndex(owner),
                TemporalInstantRecord { epoch_nanoseconds },
            );
        }
        for (owner, f) in durations {
            self.temporal_durations.insert(
                crate::value::SlotIndex(owner),
                TemporalDurationRecord {
                    years: f[0],
                    months: f[1],
                    weeks: f[2],
                    days: f[3],
                    hours: f[4],
                    minutes: f[5],
                    seconds: f[6],
                    milliseconds: f[7],
                    microseconds: f[8],
                    nanoseconds: f[9],
                },
            );
        }
        for (owner, kind, year, f) in plains {
            self.temporal_plains.insert(
                crate::value::SlotIndex(owner),
                TemporalPlainRecord {
                    kind,
                    year,
                    month: f[0],
                    day: f[1],
                    hour: f[2],
                    minute: f[3],
                    second: f[4],
                    millisecond: f[5],
                    microsecond: f[6],
                    nanosecond: f[7],
                },
            );
        }
        for (owner, epoch_nanoseconds, time_zone, offset_ns) in zoneds {
            self.temporal_zoneds.insert(
                crate::value::SlotIndex(owner),
                TemporalZonedRecord {
                    epoch_nanoseconds,
                    time_zone,
                    offset_ns,
                },
            );
        }
        Ok(())
    }

    /// Quiescent snapshot of the nine Intl DATA record tables (ledger
    /// `IntlRecords` row, the `INTL` atom), each ascending by owning
    /// slot. The `NumberFormatData::bound_format` cache is STRIPPED to
    /// `None` on the way out: the minted bound function is a
    /// `functions` (`FuncInfo`) row that does not travel, and the
    /// `format` getter re-mints on a cache miss, so a first
    /// post-resume read behaves exactly like a first access. The
    /// bound-function LINK tables ride the same reasoning and are not
    /// emitted at all (see [`IntlTables`]).
    pub fn intl_snapshot(&self) -> IntlTables {
        fn sorted<T: Clone>(
            m: &std::collections::HashMap<crate::value::SlotIndex, T>,
        ) -> Vec<(u32, T)> {
            let mut v: Vec<(u32, T)> = m.iter().map(|(o, r)| (o.0, r.clone())).collect();
            v.sort_unstable_by_key(|(o, _)| *o);
            v
        }
        let mut number_formats = sorted(&self.number_formats);
        for (_, r) in &mut number_formats {
            r.bound_format = None;
        }
        IntlTables {
            locales: sorted(&self.locales),
            collators: sorted(&self.collators),
            list_formats: sorted(&self.list_formats),
            plural_rules: sorted(&self.plural_rules),
            number_formats,
            segmenters: sorted(&self.segmenters),
            segments: sorted(&self.segments),
            segment_iterators: sorted(&self.segment_iterators),
            date_time_formats: sorted(&self.date_time_formats),
        }
    }

    /// Reinstate the nine Intl record tables. Refuse structure only crafted
    /// bytes can hold: a segments record whose boundaries lie outside
    /// its input (or out of order), or a segment iterator naming an
    /// instance with no segments record or a cursor past its list.
    /// Unrecognized option STRINGS are not refused: every consuming
    /// match has a fallback arm, so the worst a forged string yields
    /// is a wrong rendering, never unsafety (`forbid(unsafe_code)`).
    pub(super) fn restore_intl(&mut self, t: IntlTables) -> Result<(), RestoreError> {
        const ROW: &str = "Intl";
        self.validate_restore_owners(t.locales.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.collators.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.list_formats.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.plural_rules.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.number_formats.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.segmenters.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.segments.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.segment_iterators.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(t.date_time_formats.iter().map(|row| row.0), ROW)?;
        if t.number_formats
            .iter()
            .any(|(_, row)| row.bound_format.is_some())
        {
            return Err(RestoreError {
                row: ROW,
                reason: "bound-format links must use the dedicated row set",
            });
        }

        for (_, r) in &t.segments {
            let mut prev = 0usize;
            for &(start, end, _) in &r.segments {
                if start < prev || end < start || end > r.units.len() {
                    return Err(RestoreError {
                        row: ROW,
                        reason: "invalid segment boundaries or cursor",
                    });
                }
                prev = start;
            }
        }
        for (_, r) in &t.segment_iterators {
            match t
                .segments
                .binary_search_by_key(&r.segments_inst.0, |(o, _)| *o)
            {
                Ok(k) => {
                    if r.pos > t.segments[k].1.segments.len() {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "invalid segment boundaries or cursor",
                        });
                    }
                }
                Err(_) => {
                    return Err(RestoreError {
                        row: ROW,
                        reason: "iterator has no segments row",
                    })
                }
            }
        }
        fn install<T>(
            m: &mut std::collections::HashMap<crate::value::SlotIndex, T>,
            rows: Vec<(u32, T)>,
        ) {
            for (owner, r) in rows {
                m.insert(crate::value::SlotIndex(owner), r);
            }
        }
        for (owner, row) in t.locales {
            self.locales.insert(crate::value::SlotIndex(owner), row);
        }
        for (owner, row) in t.collators {
            self.collators.insert(crate::value::SlotIndex(owner), row);
        }
        install(&mut self.list_formats, t.list_formats);
        install(&mut self.plural_rules, t.plural_rules);
        install(&mut self.number_formats, t.number_formats);
        install(&mut self.segmenters, t.segmenters);
        install(&mut self.segments, t.segments);
        install(&mut self.segment_iterators, t.segment_iterators);
        install(&mut self.date_time_formats, t.date_time_formats);
        Ok(())
    }

    /// Quiescent snapshot of the built-in iterator cursors (ledger
    /// `Iterators` row, the `ITER` atom), ascending by owning slot.
    /// Free-listed owners are skipped (a swept cursor's row names
    /// nothing, and its collection may be gone). Two normalizations
    /// at the boundary (see [`IteratorRow`]): a collection cursor's
    /// physical entry index becomes the live-entry ORDINAL — matching
    /// the `COLL` row's tombstone compaction — and a stale cursor
    /// (its collection's clear-generation moved) emits `done: true`,
    /// exactly the latch its next `next()` would have set.
    pub fn iterators_snapshot(&self) -> Vec<IteratorRow> {
        let mut out: Vec<IteratorRow> = Vec::new();
        for (owner, st) in &self.iterators {
            if self.slots.is_free_index(*owner) {
                continue;
            }
            let (index, done) = if (5..=7).contains(&st.kind) {
                let Some(c) = self.collections.get(&st.iterable) else {
                    continue;
                };
                let stale = c.generation() != st.generation;
                let ordinal = c.entries()[..(st.index as usize).min(c.entries().len())]
                    .iter()
                    .filter(|e| e.is_some())
                    .count() as u32;
                (ordinal, st.done || stale)
            } else {
                (st.index, st.done)
            };
            out.push(IteratorRow {
                owner: owner.0,
                kind: st.kind,
                iterable: st.iterable.0,
                index,
                done,
                result: st.result.0,
                enum_keys: st.enum_keys.as_ref().clone(),
                str_bytes: st.str_bytes.as_ref().clone(),
            });
        }
        out.sort_unstable_by_key(|r| r.owner);
        out
    }

    /// Reinstate the built-in iterator cursors. Refuse structure only crafted
    /// bytes can hold: an unknown kind, a collection cursor naming an
    /// instance with no restored collection (its `next()` indexes the
    /// table unconditionally) or a cursor past the live-entry list, a
    /// string cursor past its text or splitting a UTF-16 unit, or a
    /// RegExp String Iterator with invalid mode bits or malformed UTF-16, or
    /// a for-in cursor past its key list or holding a key id outside the
    /// restored name table.
    pub(super) fn restore_iterators(&mut self, rows: Vec<IteratorRow>) -> Result<(), RestoreError> {
        const ROW: &str = "Iterators";
        self.validate_restore_owners(rows.iter().map(|row| row.owner), ROW)?;
        for row in &rows {
            if row.iterable != u32::MAX {
                self.validate_restore_owner(row.iterable, ROW)?;
            }
            if row.kind == 8 {
                // Iterator.from caches the next value in an ordinary value
                // holder; unlike the other kinds, this is no result object.
                let holder = crate::value::SlotIndex(row.result);
                if holder.is_null()
                    || holder.0 >= self.slots.capacity()
                    || self.slots.is_free_index(holder)
                {
                    return Err(RestoreError {
                        row: ROW,
                        reason: "cached next holder is not live",
                    });
                }
                self.validate_restore_value_shape(self.slots.get(holder), ROW)?;
            } else if row.result != u32::MAX {
                self.validate_restore_owner(row.result, ROW)?;
            }
        }

        for r in &rows {
            if r.kind > 9 {
                return Err(RestoreError {
                    row: ROW,
                    reason: "malformed iterator state",
                });
            }
            match r.kind {
                5..=7 => {
                    let Some(c) = self.collections.get(&crate::value::SlotIndex(r.iterable)) else {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    };
                    if r.index as usize > c.entries().len() {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                }
                4 => {
                    if r.index as usize > r.str_bytes.len() || r.index % 2 != 0 {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                }
                3 => {
                    if r.index as usize > r.enum_keys.len() {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                    if r.enum_keys.iter().any(|&(id, _)| {
                        id != crate::value::XS_NO_ID && id as usize > self.symbol_names.len()
                    }) {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                }
                8 => {
                    if r.iterable == crate::value::SlotIndex::NULL.0
                        || r.result == crate::value::SlotIndex::NULL.0
                        || r.index != 0
                        || r.done
                        || !r.enum_keys.is_empty()
                        || !r.str_bytes.is_empty()
                    {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                }
                9 => {
                    if r.iterable == crate::value::SlotIndex::NULL.0
                        || r.result == crate::value::SlotIndex::NULL.0
                        || r.index > 3
                        || !r.enum_keys.is_empty()
                        || r.str_bytes.len() % 2 != 0
                    {
                        return Err(RestoreError {
                            row: ROW,
                            reason: "malformed iterator state",
                        });
                    }
                }
                _ => {}
            }
        }
        for r in rows {
            // Restored collections rebuild at clear-generation ZERO, so
            // a live carried cursor adopts zero and a retired one rides
            // its folded `done` — the equality the stale check consults
            // holds exactly as it did live.
            self.iterators.insert(
                crate::value::SlotIndex(r.owner),
                IterState {
                    iterable: crate::value::SlotIndex(r.iterable),
                    index: r.index,
                    kind: r.kind,
                    generation: 0,
                    result: crate::value::SlotIndex(r.result),
                    done: r.done,
                    enum_keys: std::rc::Rc::new(r.enum_keys),
                    str_bytes: std::rc::Rc::new(r.str_bytes),
                },
            );
        }
        Ok(())
    }

    /// The symbol-key property-id table (ledger `SYMB` row): the
    /// top-down mint counter and every `(id, descriptor slot)` pair,
    /// ascending by id. [`Self::restore_symbol_key_table`] is the exact
    /// inverse; persisting the pair of them is what lets a heap holding
    /// symbol-KEYED properties round-trip a snapshot (the stored ids
    /// re-bind to the same descriptor slots instead of aliasing).
    pub fn symbol_key_table(&self) -> (u16, Vec<(u16, u32)>) {
        let mut pairs: Vec<(u16, u32)> = self
            .symbol_key_ids
            .iter()
            .map(|(desc, &id)| (id, desc.0))
            .collect();
        pairs.sort_unstable_by_key(|&(id, _)| id);
        (self.next_symbol_key_id, pairs)
    }

    /// Reinstate the symbol-key id table from a snapshot (the ledger's
    /// SYMB row; the exact inverse of [`Self::symbol_key_table`]). Runs
    /// on a freshly restored machine whose map is empty. Validates the
    /// decoded shape — ids strictly ascending and above the counter,
    /// descriptors pairwise distinct — and returns `false` without
    /// mutating anything on a violation (the caller fails its decode
    /// closed); a well-formed table always restores fully.
    pub(super) fn restore_symbol_key_table(&mut self, next: u16, pairs: &[(u16, u32)]) -> bool {
        // The counter (and so every pair id above it) must clear the
        // name table: a symbol id equal to a table position would make
        // one id simultaneously a string key and a symbol key, and
        // `o[sym]` would read the string-keyed slot while `Object.keys`
        // dropped it — silent aliasing from crafted or torn bytes, the
        // class every sibling decoder refuses. Runs after
        // `bind_program_symbols`, so the table is
        // the persisted one.
        if next == u16::MAX || (next as usize) <= self.symbol_names.len() {
            return false;
        }
        let mut prev: Option<u16> = None;
        let mut descs = std::collections::HashSet::new();
        for &(id, desc) in pairs {
            if id == u16::MAX
                || id <= next
                || prev.is_some_and(|prev_id| id <= prev_id)
                || !descs.insert(desc)
            {
                return false;
            }
            // The template cache reserves an internal key using its rooted
            // instance identity. Every other entry is a guest Symbol descriptor.
            let valid = if desc == self.template_cache.0 {
                self.validate_restore_owner(desc, "SymbolKeys")
            } else {
                let symbol = Slot::of(
                    Kind::Symbol,
                    Payload::Reference(crate::value::SlotIndex(desc)),
                );
                self.validate_restore_value_shape(symbol, "SymbolKeys")
                    .map(|_| ())
            };
            if valid.is_err() {
                return false;
            }
            prev = Some(id);
        }
        for &(id, desc) in pairs {
            self.symbol_key_ids
                .insert(crate::value::SlotIndex(desc), id);
        }
        self.snapshot_dirt.mark(SnapshotSection::Symbols.mask());
        self.next_symbol_key_id = next;
        // `restore_snapshot_state` can rebuild only string-keyed boot
        // accessors because this table is restored afterwards. Re-run the
        // idempotent derivation now so well-known-symbol seeds (notably
        // `%Iterator.prototype%[@@toStringTag]`) regain their native pair
        // before serialized guest accessor rows are overlaid.
        self.rebuild_boot_accessors().is_ok()
    }

    /// Quiescent snapshot of the `index_props` side table (ledger
    /// `IndexProps` row), owner-ascending, items ascending by index —
    /// the order the `IDXP` encoding requires so `import ∘ export` stays
    /// the identity the CAS key rests on.
    pub fn index_props_snapshot(&self) -> Vec<IndexPropsSnapshot> {
        let mut out: Vec<IndexPropsSnapshot> = self
            .index_props
            .iter()
            .map(|(owner, props)| {
                (
                    owner.0,
                    props.length,
                    props
                        .items()
                        .iter()
                        .map(|(index, value)| (*index, *value))
                        .collect::<Vec<(u32, Slot)>>(),
                )
            })
            .collect();
        out.sort_unstable_by_key(|(owner, _, _)| *owner);
        out
    }

    /// Quiescent snapshot of the `Symbol.for` registry (ledger
    /// `SymbolRegistry` row), ascending by key bytes: `(key bytes,
    /// descriptor slot)`.
    pub fn symbol_registry_snapshot(&self) -> Vec<(Vec<u8>, u32)> {
        let mut out: Vec<(Vec<u8>, u32)> = self
            .symbol_registry
            .iter()
            .map(|(k, v)| (k.clone(), v.0))
            .collect();
        out.sort_unstable();
        out
    }

    /// Reinstate the bulk side tables and the symbol registry from a
    /// snapshot (the ledger's restore half; the exact inverse of the
    /// three `*_snapshot` views). Runs on a freshly restored machine
    /// whose tables are empty; every insert routes through the counted
    /// accessors so the side-ref page counts the partial collector
    /// reads are rebuilt in lockstep, and the registry's forward and
    /// reverse maps are repopulated pairwise. The complete batch is checked
    /// before any table changes, while content-key chunks stay unloaded.
    pub(super) fn restore_bulk_side_tables(
        &mut self,
        arrays: Vec<ArraySnapshot>,
        index_props: Vec<IndexPropsSnapshot>,
        collections: Vec<CollectionSnapshot>,
        registry: Vec<(Vec<u8>, u32)>,
    ) -> Result<(), RestoreError> {
        const ROW: &str = "BulkSideTables";
        let refuse = |reason| RestoreError { row: ROW, reason };
        self.validate_restore_owners(arrays.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(index_props.iter().map(|row| row.0), ROW)?;
        self.validate_restore_owners(collections.iter().map(|row| row.0), ROW)?;
        for (_, length, items) in arrays.iter().chain(&index_props) {
            if items.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
                return Err(refuse("item indices are not strictly ascending"));
            }
            if items.last().is_some_and(|(index, _)| index >= length) {
                return Err(refuse("length or high-water mark does not cover items"));
            }
        }
        for (_, code, length, entries) in &collections {
            let kind = crate::bulk::CollKind::from_code(*code)
                .ok_or_else(|| refuse("unknown collection kind"))?;
            if matches!(
                kind,
                crate::bulk::CollKind::WeakMap | crate::bulk::CollKind::WeakSet
            ) {
                if *length != 0 {
                    return Err(refuse("weak collection carries a hash table"));
                }
            } else {
                // The runtime doubles/halves the XS-compatible table within
                // this profile's cap; preserve its post-mutation geometry.
                const TABLE_MAX: u32 = 1024 * 1024;
                if !length.is_power_of_two()
                    || *length < MAP_MIN_TABLE_LENGTH
                    || *length > TABLE_MAX
                {
                    return Err(refuse("unreachable collection table geometry"));
                }
                let high = (length >> 1) + (length >> 2);
                if *length < TABLE_MAX && entries.len() as u64 > u64::from(high) {
                    return Err(refuse("collection size is past the grow threshold"));
                }
            }
        }
        // Content-key chunks intentionally remain lazy. This checks shapes,
        // live slot identities, and chunk coordinates, without deriving keys
        // or deduplicating the historically admitted duplicate-key entries.
        for value in arrays
            .iter()
            .chain(&index_props)
            .flat_map(|row| row.2.iter().map(|(_, value)| *value))
            .chain(
                collections
                    .iter()
                    .flat_map(|row| row.3.iter().flat_map(|(key, value)| [*key, *value])),
            )
        {
            self.validate_restore_value_shape(value, ROW)?;
        }
        if registry.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return Err(refuse("registry keys are not strictly ascending"));
        }
        let mut descriptors = std::collections::HashSet::new();
        for (key, descriptor) in &registry {
            if !key.len().is_multiple_of(2) {
                return Err(refuse("registry key is not UTF-16 bytes"));
            }
            if !descriptors.insert(*descriptor) {
                return Err(refuse("registry keys share a descriptor"));
            }
            let symbol = Slot::of(
                Kind::Symbol,
                Payload::Reference(crate::value::SlotIndex(*descriptor)),
            );
            if self.validate_restore_value_shape(symbol, ROW)?.is_none() {
                return Err(refuse("registry descriptor has no string description"));
            }
        }

        for (owner, high_water, items) in index_props {
            let owner = crate::value::SlotIndex(owner);
            for (index, value) in items {
                // Through the counted accessor, like every other restore
                // insert, so the side-ref page counts the partial collector
                // reads are rebuilt in lockstep — but UNMETERED: the guest
                // paid for this store when it built it.
                self.index_prop_store(owner, index, value);
            }
            // Restore the mark itself, after the inserts (which only raise it
            // to the greatest index they carry). A row whose items are all
            // deleted is a pure tombstone — no insert above creates its store,
            // so it must be created here or the high-water mark is lost.
            let props = self.index_props.entry(owner).or_default();
            props.length = props.length.max(high_water);
        }
        for (owner, length, items) in arrays {
            let mut a = crate::bulk::ArrayData::default();
            a.length = length;
            for (index, value) in items {
                a.insert_item(index, value, &mut self.side_refs);
            }
            self.arrays.insert(crate::value::SlotIndex(owner), a);
        }
        for (owner, kind_code, table_length, entries) in collections {
            let kind = crate::bulk::CollKind::from_code(kind_code)
                .expect("collection kind was validated before restore");
            let mut c = crate::bulk::CollectionData::new(kind, table_length);
            for (key, value) in entries {
                c.push_entry(key, value, &mut self.side_refs);
            }
            self.collections.insert(crate::value::SlotIndex(owner), c);
        }
        for (key, descriptor) in registry {
            let desc = crate::value::SlotIndex(descriptor);
            self.symbol_registry.insert(key.clone(), desc);
            self.symbol_registry_keys.insert(desc, key);
        }
        Ok(())
    }

    /// Rebuild the [`Self::global_props`] id→slot fast index by walking the
    /// restored global object's own-property list. `create_global_property`
    /// is the *only* writer of `global_props` (a runtime `globalThis.x = 1`
    /// create and a `delete globalThis.x` route their fast-index mutation
    /// through it and `global_props.remove` respectively), and every insert
    /// links its entry into `global_obj`'s property chain, so the chain and
    /// the map stay one-to-one — walking the chain reconstructs the map
    /// exactly. Used at restore, where the arena round-trips the chain but the
    /// map (plain side-table state, not arena-resident) must be re-derived.
    ///
    /// Initial adoption validates this chain before installing the arenas.
    pub(super) fn rebuild_global_props(&mut self) {
        self.global_props.clear();
        let mut cur = self.slots.get(self.global_obj).next;
        while !cur.is_null() {
            let s = self.slots.get(cur);
            self.global_props.insert(s.id, cur);
            cur = s.next;
        }
    }

    /// Whether the machine stands at a QUIESCENT crank boundary — the
    /// precondition every persist verb requires.
    ///
    /// Quiescence is a LIFECYCLE property first and a table-emptiness
    /// property second. The first conjunct is the `last_crank_completed`
    /// latch: the most recent crank ran to its own `END` and drained its job
    /// queue. A crank that HALTED may leave pending microtasks, a
    /// populated call stack, live handlers, a set exception, and a
    /// mid-frame value stack — the table conjuncts below see those — but
    /// a crank halted at a top-level meter check, at the dispatch
    /// ceiling, or at a decode fault leaves every table empty and is a
    /// halt all the same: its boundary registers were never cleared, so
    /// a checkpoint there would root pages a resumed twin frees and the
    /// two would fork at their next collection while answering every
    /// crank identically. The managed
    /// lifecycle rewinds halted cranks; this is the seam-level gate for
    /// every other caller.
    ///
    /// A completion value the oracle harness's `String(result)` cannot
    /// coerce (a Symbol, a null-prototype object) is NOT a halt in this
    /// sense: [`Self::run`] reports it `completed` with the harness's
    /// `TypeError` beside it in [`RunOutcome::coercion_error`], the
    /// registers clear, and the machine is quiescent. Only the
    /// differential harness folds that into an abort
    /// ([`RunOutcome::host_coerced`]).
    pub fn is_quiescent(&self) -> bool {
        self.fields_are_quiescent()
    }

    /// Sections changed relative to this session's durable acknowledgement.
    pub fn snapshot_dirty_sections(
        &self,
        baseline: &crate::SnapshotBaseline,
    ) -> crate::SnapshotDirty {
        if !std::rc::Rc::ptr_eq(&baseline.identity, &self.snapshot_baseline_identity) {
            return crate::SnapshotDirty::all();
        }
        let same = std::rc::Rc::ptr_eq(&baseline.arena, &self.slots.snapshot_dirt);
        self.snapshot_dirt.mark(
            self.slots.snapshot_dirt.sections(same)
                | SnapshotSection::Stack.mask()
                | SnapshotSection::Meter.mask()
                | SnapshotSection::NameFloor.mask(),
        );
        self.snapshot_dirt.snapshot()
    }

    /// Observe the current identity without acknowledging restore-time changes.
    pub fn snapshot_baseline(&self) -> crate::SnapshotBaseline {
        crate::SnapshotBaseline {
            identity: self.snapshot_baseline_identity.clone(),
            arena: self.slots.snapshot_dirt.clone(),
        }
    }

    /// Acknowledge a detached or twin-store commit conservatively: pages
    /// whose lazy backing is stale remain resident and unevictable.
    pub fn acknowledge_arena_commit(&mut self) {
        self.slots.clear_dirty_after_commit(false);
        self.chunks.clear_dirty_after_commit(false);
    }

    /// Check the store session's backing authority before committing bytes.
    /// This exposes no authority and does not read or mutate any heap page.
    pub fn check_backing_authority(
        &self,
        authority: &crate::BackingCommitAuthority,
    ) -> Result<(), &'static str> {
        if !authority.authorizes(&self.slots, &self.chunks) {
            return Err("commit authority does not match the machine's backing");
        }
        Ok(())
    }

    /// Acknowledge a commit to the pinned backing and advance its geometry.
    /// The store adapter must update its page source to the committed state
    /// first. Only the authority minted with these arenas can authorize this.
    /// A capability for any other pair is refused before changing metadata.
    pub fn acknowledge_backing_commit(
        &mut self,
        authority: &mut crate::BackingCommitAuthority,
    ) -> Result<(), &'static str> {
        self.check_backing_authority(authority)?;
        self.slots.clear_dirty_after_commit(true);
        self.chunks.clear_dirty_after_commit(true);
        self.slots.advance_backing(self.chunks.byte_size() as u64);
        self.chunks.advance_backing();
        Ok(())
    }

    /// Call after durable commit. Invalidates older tokens
    /// so an unrelated caller cannot clear another session's outstanding dirt.
    pub fn acknowledge_snapshot(&mut self) -> crate::SnapshotBaseline {
        self.snapshot_baseline_identity = std::rc::Rc::new(());
        self.snapshot_dirt.clear();
        self.slots.snapshot_dirt.clear();
        crate::SnapshotBaseline {
            identity: self.snapshot_baseline_identity.clone(),
            arena: self.slots.snapshot_dirt.clone(),
        }
    }
}
