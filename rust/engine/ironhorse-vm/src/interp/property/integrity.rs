//! Property integrity operations.
use crate::interp::*;

impl Interp {
    /// The global `harden(x)` (`fx_harden` + `fx_hardenFreezeAndTraverse` +
    /// `fx_hardenQueue`, `xsLockdown.c`): the transitive freeze worklist over
    /// the slot arena. Prevent extensions and stamp every own data property
    /// non-writable/non-configurable (accessors non-configurable) on each
    /// reached instance, then queue its prototype and every reference-valued
    /// own property, marking each reached instance `XS_DONT_MARSHALL_FLAG` so
    /// the graph is walked once. Returns `x` (the argument). A non-reference
    /// argument, an already-hardened object, and `harden()` with no argument
    /// pass through per XS. `xsLockdown.c` calls no `mxMeter`, so the cost is
    /// the allocation constants; computron parity over a transitive walk into
    /// ironhorse's sparse intrinsics is structurally unavailable, so the corpus is
    /// result-gated (the freeze *result* is faithful).
    pub(in crate::interp) fn do_harden(&mut self, code: &[u8], arg0: Slot) -> Result<Slot, Step> {
        if arg0.kind != Kind::Reference {
            return Ok(arg0);
        }
        let inst = match arg0.value {
            Payload::Reference(i) => i,
            _ => return Ok(arg0),
        };
        // Already hardened: XS short-circuits (`slot->flag & flag`). The
        // resident cache is derived only; a restored arena rebuilds this bit
        // from the authoritative persisted instance flag on first use.
        if self
            .slots
            .cached_integrity(inst)
            .is_some_and(|(state, _, _)| state & INTEGRITY_HARDENED != 0)
        {
            return Ok(arg0);
        }
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
            self.slots.cache_integrity(inst, INTEGRITY_HARDENED, 0, 0);
            return Ok(arg0);
        }
        let mut list: Vec<crate::value::SlotIndex> = Vec::new();
        self.harden_enqueue(inst, &mut list);
        let mut i = 0;
        while i < list.len() {
            if let Err(halt) = self.harden_freeze_and_traverse(code, list[i], &mut list) {
                // `fx_harden` clears the visited/hardened bit from every item
                // accumulated in its worklist when any proxy trap or property
                // definition fails. A later harden attempt must retry rather
                // than short-circuit a partially frozen graph.
                for &queued in &list {
                    self.slots.get_mut(queued).flag &= !XS_DONT_MARSHALL_FLAG;
                    self.slots.clear_cached_integrity(queued);
                }
                return Err(halt);
            }
            i += 1;
        }
        for &queued in &list {
            let (own_property_count, own_keys_metering) = self
                .slots
                .cached_integrity(queued)
                .map_or((0, 0), |(_, count, metering)| (count, metering));
            self.slots.cache_integrity(
                queued,
                INTEGRITY_HARDENED,
                own_property_count,
                own_keys_metering,
            );
        }
        Ok(arg0)
    }

    /// `fx_hardenQueue`: mark `inst` hardened (`XS_DONT_MARSHALL_FLAG`, the
    /// visited set) and push it onto the worklist, skipping an already-marked
    /// instance. XS marks the instance during processing and checks the mark at
    /// enqueue; marking at enqueue is behaviorally identical (the mark is only a
    /// visited set — the freeze still happens in `harden_freeze_and_traverse`)
    /// and makes the Vec-backed walk terminate without duplicate entries.
    pub(in crate::interp) fn harden_enqueue(
        &mut self,
        inst: crate::value::SlotIndex,
        list: &mut Vec<crate::value::SlotIndex>,
    ) {
        if inst.is_null() {
            return;
        }
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
            return;
        }
        self.slots.get_mut(inst).flag |= XS_DONT_MARSHALL_FLAG;
        self.meter.tick_raw(HARDEN_QUEUE_ITEM_METERING);
        list.push(inst);
    }

    /// `fx_hardenFreezeAndTraverse`: freeze one instance and queue its
    /// referents. Both passes route through the full internal-method seam, so
    /// Proxy traps and exotic own properties are observed exactly where XS
    /// observes them. XS deliberately skips integer-indexed TypedArray
    /// elements: their descriptors cannot be made non-writable, while the
    /// receiver itself and any ordinary expandos are still hardened.
    pub(in crate::interp) fn harden_freeze_and_traverse(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        list: &mut Vec<crate::value::SlotIndex>,
    ) -> Result<(), Step> {
        if self.fused_integrity_object(inst) {
            return self.harden_fused_ordinary(inst, list);
        }
        self.meter.tick_raw(HARDEN_OBJECT_BASE_METERING);
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let skip_indexes = self.typed_arrays.contains_key(&inst);
        for key in self.mop_own_keys(code, inst)? {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            // Stamping flags OBSERVES the key set and rewrites existing
            // entries; it creates no name. `set_integrity_level` was taught
            // this and `harden` — which is the entry point a SES-shaped
            // engine actually calls — has its OWN loop, so it was left
            // minting a name per key: `Object.freeze(bigArray)` completed
            // while `harden(bigArray)`, the same freeze, still poisoned the
            // machine.
            let read_key = self.to_read_key(code, key)?;
            if skip_indexes && self.read_key_is_index(read_key) {
                continue;
            }
            let Some(current) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            let frozen = if current.is_accessor() {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            } else {
                OrdinaryDescriptor {
                    writable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            // The descriptor read can run a proxy trap that names this index.
            let read_key = self.refresh_read_key(read_key);
            if !self.mop_define_own_property_read(code, inst, read_key, frozen)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }

        let keys = self.mop_own_keys(code, inst)?;
        let proto = self.mop_get_prototype(code, inst)?;
        if let Payload::Reference(proto) = proto.value {
            self.harden_enqueue(proto, list);
        }
        for key in keys {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            let read_key = self.to_read_key(code, key)?;
            let Some(descriptor) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            if let Some(value) = descriptor.value {
                if let Payload::Reference(referent) = value.value {
                    self.harden_enqueue(referent, list);
                }
            } else {
                for function in [descriptor.get, descriptor.set].into_iter().flatten() {
                    if let Payload::Reference(function) = function.value {
                        self.harden_enqueue(function, list);
                    }
                }
            }
        }
        Ok(())
    }

    /// Whether an instance's complete visible own-property surface is the
    /// authoritative named slot chain. Functions synthesize own descriptors;
    /// ordinary numeric properties live in a side store. Both retain the full
    /// MOP path, as do every Proxy and exotic object kind.
    fn fused_integrity_object(&self, inst: crate::value::SlotIndex) -> bool {
        self.is_ordinary_object(inst)
            && !self.functions.contains_key(&inst)
            && !self.index_props.contains_key(&inst)
    }

    /// The exact release-versioned charge of materializing one ordinary
    /// `[[OwnPropertyKeys]]` result. The fused/cache paths omit those temporary
    /// key strings, but the public meter must remain bit-identical.
    fn fused_own_keys_metering(&self, properties: &[crate::value::SlotIndex]) -> Result<u64, Step> {
        let mut total = 0u64;
        for &property in properties {
            total = total
                .checked_add(crate::meter::BUILTIN_METERING)
                .ok_or(Step::Host(Halt::MeterAbort))?;
            let id = self.slots.get(property).id;
            if self.is_symbol_key_id(id) {
                continue;
            }
            let name = self
                .symbol_names
                .get(usize::from(id).wrapping_sub(1))
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "fused-ownKeys:unknown-key",
                )))?;
            let units = name
                .as_bytes()
                .iter()
                .filter(|byte| **byte & 0xc0 != 0x80)
                .count();
            total = total
                .checked_add(string_chunk_cost(units as u64))
                .ok_or(Step::Host(Halt::MeterAbort))?;
        }
        Ok(total)
    }

    fn charge_fused_own_keys(&mut self, metering: u64) -> Result<(), Step> {
        if metering == 0 {
            Ok(())
        } else {
            self.charge_and_check(metering)
        }
    }

    /// Freeze and discover referents for an ordinary non-Proxy object in one
    /// authoritative slot-chain walk. The two historical own-key passes are
    /// still charged in their original order, preserving deterministic meter
    /// receipts while avoiding their host allocations and descriptor routing.
    fn harden_fused_ordinary(
        &mut self,
        inst: crate::value::SlotIndex,
        list: &mut Vec<crate::value::SlotIndex>,
    ) -> Result<(), Step> {
        self.meter.tick_raw(HARDEN_OBJECT_BASE_METERING);
        self.materialize_intrinsic_own_surface(inst);
        self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG;

        let properties = self.own_property_slots(inst);
        let own_keys_metering = self.fused_own_keys_metering(&properties)?;
        self.charge_fused_own_keys(own_keys_metering)?;
        let mut referents = self.reserve_scratch(properties.len())?;
        for &property in &properties {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            let slot = self.slots.get(property);
            if slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
                let accessor = self
                    .accessors
                    .get(&(inst, slot.id))
                    .copied()
                    .unwrap_or_default();
                let getter = accessor.get.and_then(|function| match function.value {
                    Payload::Reference(referent) => Some(referent),
                    _ => None,
                });
                let setter = accessor.set.and_then(|function| match function.value {
                    Payload::Reference(referent) => Some(referent),
                    _ => None,
                });
                self.push_prepaid_scratch(&mut referents, (getter, setter))?;
                self.slots.get_mut(property).flag |= XS_DONT_DELETE_FLAG;
            } else {
                let referent = match slot.value {
                    Payload::Reference(referent) => Some(referent),
                    _ => None,
                };
                self.push_prepaid_scratch(&mut referents, (referent, None))?;
                self.slots.get_mut(property).flag |= XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG;
            }
        }

        // The second historical ownKeys pass precedes prototype/property
        // queuing. Repeat its charges without rebuilding the key list.
        self.charge_fused_own_keys(own_keys_metering)?;
        let prototype = self.instance_prototype(inst);
        self.harden_enqueue(prototype, list);
        let edge_capacity = properties
            .len()
            .checked_mul(3)
            .and_then(|count| count.checked_add(1))
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        let mut gc_edges = self.reserve_scratch(edge_capacity)?;
        for property in properties.iter().copied() {
            self.push_prepaid_scratch(&mut gc_edges, property)?;
        }
        if !prototype.is_null() {
            self.push_prepaid_scratch(&mut gc_edges, prototype)?;
        }
        for (first, second) in referents {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            for referent in [first, second].into_iter().flatten() {
                self.harden_enqueue(referent, list);
                self.push_prepaid_scratch(&mut gc_edges, referent)?;
            }
        }
        self.slots.cache_hardened_edges(inst, &properties, gc_edges);
        self.slots.cache_integrity(
            inst,
            INTEGRITY_SEALED | INTEGRITY_FROZEN,
            properties.len() as u32,
            own_keys_metering,
        );
        Ok(())
    }

    /// The global `petrify(x)` (`fx_petrify`, `xsLockdown.c`): a *single*-object
    /// freeze (non-transitive, no prototype walk). Prevent extensions and stamp
    /// every configurable own property non-writable/non-configurable. XS skips
    /// immutable String indices and integer-indexed TypedArray elements, and
    /// separately marks mutable internal data read-only; IronHorse persists
    /// that state on the instance head because its internal data is side-table
    /// backed. Returns `x`.
    pub(in crate::interp) fn do_petrify(&mut self, code: &[u8], arg0: Slot) -> Result<Slot, Step> {
        if arg0.kind != Kind::Reference {
            return Ok(arg0);
        }
        let inst = match arg0.value {
            Payload::Reference(i) => i,
            _ => return Ok(arg0),
        };
        self.meter.tick_raw(PETRIFY_OBJECT_BASE_METERING);
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let skip_indexes = self.typed_arrays.contains_key(&inst)
            || self
                .wrapper_data
                .get(&inst)
                .is_some_and(|value| value.kind == Kind::String);
        for key in self.mop_own_keys(code, inst)? {
            self.meter.tick_raw(PETRIFY_PER_KEY_METERING);
            // The same observation-only stamp as `harden` above, and the same
            // reason it must not mint: `petrify` is `harden`'s single-object
            // half and reaches every key of the object it is handed.
            let read_key = self.to_read_key(code, key)?;
            if skip_indexes && self.read_key_is_index(read_key) {
                continue;
            }
            let Some(current) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            let frozen = if current.is_accessor() {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            } else {
                OrdinaryDescriptor {
                    writable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            let read_key = self.refresh_read_key(read_key);
            if !self.mop_define_own_property_read(code, inst, read_key, frozen)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }
        if self.array_buffers.contains_key(&inst)
            || self.dates.contains_key(&inst)
            || self.collections.contains_key(&inst)
        {
            self.slots.get_mut(inst).flag |= XS_DONT_MODIFY_FLAG;
        }
        Ok(arg0)
    }

    /// `SetIntegrityLevel(O, sealed|frozen)` (ECMA-262 7.3.15). The own-key
    /// list is captured after preventing extensions; every key is then routed
    /// through the receiver's `[[GetOwnProperty]]` / `[[DefineOwnProperty]]`
    /// methods so arrays, TypedArrays, and proxies retain their exotic rules.
    pub(in crate::interp) fn set_integrity_level(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        frozen: bool,
    ) -> Result<(), Step> {
        self.meter.tick_raw(INTEGRITY_APPLY_KEYS_BASE_METERING);
        if self.fused_integrity_object(inst) {
            self.materialize_intrinsic_own_surface(inst);
            self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG;
            let properties = self.own_property_slots(inst);
            let own_keys_metering = self.fused_own_keys_metering(&properties)?;
            self.charge_fused_own_keys(own_keys_metering)?;
            for property in &properties {
                self.meter.tick_raw(INTEGRITY_APPLY_PER_KEY_METERING);
                let accessor =
                    self.slots.get(*property).flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0;
                let slot = self.slots.get_mut(*property);
                slot.flag |= XS_DONT_DELETE_FLAG;
                if frozen && !accessor {
                    slot.flag |= XS_DONT_SET_FLAG;
                }
            }
            let state = INTEGRITY_SEALED | if frozen { INTEGRITY_FROZEN } else { 0 };
            self.slots
                .cache_integrity(inst, state, properties.len() as u32, own_keys_metering);
            return Ok(());
        }
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let keys = self.mop_own_keys(code, inst)?;
        let proxy = self.proxies.contains_key(&inst);
        for key in keys {
            self.meter.tick_raw(INTEGRITY_APPLY_PER_KEY_METERING);
            // Stamping flags OBSERVES the key set and rewrites existing
            // entries; it creates no name, so an index is not minted.
            let key = self.to_read_key(code, key)?;
            let current = if frozen || !proxy {
                self.mop_get_own_property_read(code, inst, key)?
            } else {
                None
            };
            // String-exotic indices and `length` are already frozen. Avoid
            // manufacturing ordinary shadow properties for those synthetic
            // descriptors; proxies still receive every mandated define trap.
            if !proxy
                && current.as_ref().is_some_and(|descriptor| {
                    descriptor.configurable == Some(false)
                        && (!frozen
                            || descriptor.is_accessor()
                            || descriptor.writable == Some(false))
                })
            {
                continue;
            }
            let desc = if frozen {
                match current {
                    None => continue,
                    Some(descriptor) if descriptor.is_accessor() => OrdinaryDescriptor {
                        configurable: Some(false),
                        ..OrdinaryDescriptor::default()
                    },
                    Some(_) => OrdinaryDescriptor {
                        configurable: Some(false),
                        writable: Some(false),
                        ..OrdinaryDescriptor::default()
                    },
                }
            } else {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            // The descriptor read above can run a proxy trap that names this
            // index; refresh before the define.
            let key = self.refresh_read_key(key);
            if !self.mop_define_own_property_read(code, inst, key, desc)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }
        Ok(())
    }

    /// `TestIntegrityLevel(O, sealed|frozen)` (ECMA-262 7.3.16).
    pub(in crate::interp) fn test_integrity_level(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        frozen: bool,
    ) -> Result<bool, Step> {
        self.meter.tick_raw(IS_EXTENSIBLE_RESIDUAL_METERING);
        let requested = if frozen {
            INTEGRITY_FROZEN
        } else {
            INTEGRITY_SEALED
        };
        if let Some((state, own_property_count, own_keys_metering)) =
            self.slots.cached_integrity(inst)
        {
            if state & requested != 0 {
                self.meter.tick_raw(INTEGRITY_QUERY_KEYS_BASE_METERING);
                self.charge_fused_own_keys(own_keys_metering)?;
                for _ in 0..own_property_count {
                    self.meter.tick_raw(INTEGRITY_QUERY_PER_KEY_METERING);
                }
                return Ok(true);
            }
        }
        if self.mop_is_extensible(code, inst)? {
            return Ok(false);
        }
        self.meter.tick_raw(INTEGRITY_QUERY_KEYS_BASE_METERING);
        let keys = self.mop_own_keys(code, inst)?;
        let own_property_count = keys.len() as u32;
        for key in keys {
            self.meter.tick_raw(INTEGRITY_QUERY_PER_KEY_METERING);
            let key = self.to_read_key(code, key)?;
            if let Some(descriptor) = self.mop_get_own_property_read(code, inst, key)? {
                if descriptor.configurable != Some(false)
                    || (frozen && descriptor.is_data() && descriptor.writable == Some(true))
                {
                    return Ok(false);
                }
            }
        }
        if self.fused_integrity_object(inst) {
            let state = INTEGRITY_SEALED | if frozen { INTEGRITY_FROZEN } else { 0 };
            let properties = self.own_property_slots(inst);
            let own_keys_metering = self.fused_own_keys_metering(&properties)?;
            self.slots
                .cache_integrity(inst, state, own_property_count, own_keys_metering);
        }
        Ok(true)
    }
}
