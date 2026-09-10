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
        // Already hardened: XS short-circuits (`slot->flag & flag`).
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
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
                }
                return Err(halt);
            }
            i += 1;
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
        if self.mop_is_extensible(code, inst)? {
            return Ok(false);
        }
        self.meter.tick_raw(INTEGRITY_QUERY_KEYS_BASE_METERING);
        for key in self.mop_own_keys(code, inst)? {
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
        Ok(true)
    }
}
