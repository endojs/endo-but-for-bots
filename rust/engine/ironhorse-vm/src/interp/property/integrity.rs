//! Property integrity operations.
use crate::interp::*;

/// Preserve the outer walk's state when a proxy callback hardens another graph.
struct HardenGuard {
    intrinsics: std::rc::Rc<crate::Intrinsics>,
    previous: bool,
}

impl HardenGuard {
    fn enter(intrinsics: &std::rc::Rc<crate::Intrinsics>) -> Self {
        Self {
            previous: intrinsics.hardening.replace(true),
            intrinsics: intrinsics.clone(),
        }
    }
}

impl Drop for HardenGuard {
    fn drop(&mut self) {
        self.intrinsics.hardening.set(self.previous);
    }
}

/// Clear `XS_DONT_MARSHALL_FLAG` from every instance marked at or after `base`
/// in `Intrinsics::harden_marks`, and drop those entries.
///
/// The marks a walk places are PROVISIONAL until the OUTERMOST walk completes.
/// XS instead scopes the undo to one walk's own worklist (`fx_harden`'s
/// `mxCatch`), which is coherent while only one walk exists -- and a Proxy trap
/// reached from the freeze can always arrange a second, since the trap runs
/// arbitrary guest code, `harden()` included.
///
/// Under re-entry a mark means less than a nested walk reads into it. The outer
/// walk has queued an instance and not yet frozen it; the nested walk skips
/// that instance as already hardened, completes, and marks its OWN roots. When
/// the outer walk then fails and undoes only its own marks, what is left is a
/// root carrying a mark that promises a freeze nobody performed: every later
/// `harden()` -- and every `lockdown()` root that reaches it -- short-circuits
/// on it. `a_nested_harden_cannot_inherit_an_unfinished_walks_marks` and
/// `lockdown_refreezes_an_intrinsic_a_failed_nested_walk_marked` measure both
/// ends of that. So a failing walk revokes every mark placed under it,
/// including those of walks that completed inside it and relied on it.
///
/// Revoking rather than withholding is what keeps re-entry TERMINATING: a
/// nested `harden()` on an instance the running walk has already queued still
/// returns immediately, as it does on XS. Withholding the mark until the walk
/// ended was measured against `a_trap_that_hardens_the_walks_own_root_
/// terminates` -- each nested call starts a fresh walk that re-enters the same
/// trap, and the engine halts with `ReentryLimit { depth: 2062, limit: 2048 }`.
///
/// The recorded indices are only read while a walk is running or by the sweep
/// at the top of the next walk, and no collection can run in between without
/// the machine first going quiescent. If one does -- the abnormal-unwind case
/// -- the worst a recycled index costs is a cleared memo on an unrelated
/// object, which the next `harden()` of it re-earns.
///
/// § Oracle divergences in `designs/ironhorse-native-lockdown.md` carries the
/// departure.
fn revoke_harden_marks(
    slots: &mut crate::value::SlotArena,
    intrinsics: &crate::Intrinsics,
    base: usize,
) {
    // Take the entries out from under the borrow before touching the arena:
    // a `for` over the `borrow_mut()` temporary would hold it for the loop.
    let revoked = intrinsics.harden_marks.borrow_mut().split_off(base);
    for inst in revoked {
        slots.get_mut(inst).flag &= !XS_DONT_MARSHALL_FLAG;
    }
}

impl Interp {
    /// The global `harden(x)` (`fx_harden` + `fx_hardenFreezeAndTraverse` +
    /// `fx_hardenQueue`, `xsLockdown.c`): the transitive freeze worklist over
    /// the slot arena. Prevent extensions and stamp every own data property
    /// non-writable/non-configurable (accessors non-configurable) on each
    /// reached instance, then queue its prototype and every reference-valued
    /// own property, marking each reached instance `XS_DONT_MARSHALL_FLAG` so
    /// the graph is walked once. Returns `x` (the argument). A non-reference
    /// argument, an already-hardened object, and `harden()` with no argument
    /// pass through per XS. A mark is PROVISIONAL until the outermost walk
    /// completes, so a walk that fails revokes the marks of every walk nested
    /// inside it as well -- see [`revoke_harden_marks`].
    /// `xsLockdown.c` calls no `mxMeter`, so the cost is
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
        let intrinsics = self.realm.intrinsics().clone();
        // An OUTERMOST walk starts from no provisional marks. Finding some
        // means an earlier walk left the machine without running the revoke
        // below -- a Rust panic a supervisor caught while keeping the
        // interpreter, the one unwind no cleanup of ours reaches. They are not
        // evidence of a completed freeze, so drop them before the
        // short-circuit that would trust them.
        let nested = intrinsics.hardening.get();
        if !nested {
            revoke_harden_marks(&mut self.slots, &intrinsics, 0);
        }
        // Already hardened: XS short-circuits (`slot->flag & flag`).
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
            return Ok(arg0);
        }
        let _guard = HardenGuard::enter(&intrinsics);
        let base = intrinsics.harden_marks.borrow().len();
        let mut list: Vec<crate::value::SlotIndex> = Vec::new();
        self.harden_enqueue(inst, &mut list);
        let mut i = 0;
        while i < list.len() {
            if let Err(halt) = self.harden_freeze_and_traverse(code, list[i], &mut list) {
                // `fx_harden` clears the visited/hardened bit from every item
                // accumulated in its worklist when any proxy trap or property
                // definition fails. A later harden attempt must retry rather
                // than short-circuit a partially frozen graph. This revokes
                // the marks of any walk that COMPLETED inside this one too --
                // see `revoke_harden_marks` for why their completion was
                // conditional on this walk's.
                revoke_harden_marks(&mut self.slots, &intrinsics, base);
                return Err(halt);
            }
            i += 1;
        }
        if !nested {
            // The outermost walk completed, so every mark placed under it --
            // this walk's and any nested walk's -- is now what it says.
            intrinsics.harden_marks.borrow_mut().clear();
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
        // Provisional until the outermost walk completes: `revoke_harden_marks`.
        self.realm.intrinsics().harden_marks.borrow_mut().push(inst);
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
