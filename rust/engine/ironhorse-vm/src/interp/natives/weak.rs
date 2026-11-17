//! `WeakRef` and `FinalizationRegistry` (`xsMapSet.c`): construction, the
//! three prototype methods, and the job-boundary cleanup that runs a
//! registry's callback for the cells whose targets a collection found dead.
//!
//! The pinned XS holds only objects weakly (`fxCanBeHeldWeakly` admits a
//! symbol only under `mxKeysGarbageCollection`, which the oracle build does
//! not define), and ironhorse's `WeakMap`/`WeakSet` already follow that, so a
//! symbol target or token is "not an object" here too. Metering is
//! allocation-driven, as every `xsMapSet.c` built-in's is (no `mxMeter`
//! call): each `fxNewSlot` the C body performs is a `tick_slot_alloc`, and
//! the constructors carry the calibrated `fxNewWeakMapInstance` host-frame
//! residual (the same `fxGetPrototypeFromConstructor` + host frame shape).
//! XS's `fxKeepDuringJobs` list entry is charged as the slot it allocates
//! on every construction and successful `deref`, without modelling the
//! list's deduplication: the list exists so a dereferenced target survives
//! its job, which the quiescent-only collector guarantees by construction.
use super::super::*;

impl Interp {
    /// `fxCanBeHeldWeakly`: the instance a value names when it can be a
    /// weak target or token, else `None`.
    fn weakly_holdable(&self, value: Slot) -> Option<crate::value::SlotIndex> {
        match value.value {
            Payload::Reference(r) if value.kind == Kind::Reference => Some(r),
            _ => None,
        }
    }

    /// `new WeakRef(target)` / `new FinalizationRegistry(callback)`.
    pub(in crate::interp) fn construct_weak_native(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        has_target: bool,
        code: &[u8],
        new_target: Option<crate::value::SlotIndex>,
        derived_native_construct: bool,
    ) -> Result<Slot, Step> {
        let name = native.display_name();
        if !has_target {
            return Err(self.catchable_type_error_msg(format!("call: {name}")));
        }
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        match native {
            Native::WeakRef => {
                if argc < 1 {
                    return Err(self.catchable_type_error_msg("no target".into()));
                }
                let Some(target) = self.weakly_holdable(arg0) else {
                    return Err(self.catchable_type_error_msg("target: not an object".into()));
                };
                let proto = self
                    .derived_construct_prototype(code, new_target, derived_native_construct)?
                    .unwrap_or(self.weak_ref_proto);
                self.meter.tick_raw(WEAK_CTOR_FRAME_METERING);
                self.meter.tick_slot_alloc(); // instance
                self.meter.tick_slot_alloc(); // the XS_WEAK_REF_KIND property
                self.meter.tick_slot_alloc(); // the fxKeepDuringJobs entry
                let inst = self.slots.alloc(Slot::instance(proto));
                self.weak_refs.insert(inst, WeakRefData { target });
                Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
            }
            Native::FinalizationRegistry => {
                if argc < 1 {
                    return Err(self.catchable_type_error_msg("no callback".into()));
                }
                if !self.is_callable_value(arg0) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let proto = self
                    .derived_construct_prototype(code, new_target, derived_native_construct)?
                    .unwrap_or(self.finalization_registry_proto);
                self.meter.tick_raw(WEAK_CTOR_FRAME_METERING);
                self.meter.tick_slot_alloc(); // instance
                self.meter.tick_slot_alloc(); // the internal closure property
                self.meter.tick_slot_alloc(); // the XS_FINALIZATION_REGISTRY_KIND slot
                self.meter.tick_slot_alloc(); // the callback copy
                let inst = self.slots.alloc(Slot::instance(proto));
                self.finalization_registries.insert(
                    inst,
                    FinalizationRegistryData {
                        callback: arg0,
                        cells: Vec::new(),
                        changed: false,
                    },
                );
                Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "weak:unexpected-constructor",
            ))),
        }
    }

    /// `fxCheckFinalizationRegistryInstance`, preceded by the
    /// `mxIsReference(mxThis)` check both methods perform first. XS's
    /// "read-only FinalizationRegistry instance" branch keys on a mark bit
    /// that neither `harden` nor `petrify` sets (`fx_petrify` stamps only
    /// buffer, date and collection internals), so a registry is never
    /// read-only here either.
    fn finalization_registry_receiver(
        &mut self,
        this: Slot,
    ) -> Result<crate::value::SlotIndex, Step> {
        let Some(inst) = self.weakly_holdable(this) else {
            return Err(self.catchable_type_error_msg("this: not an object".into()));
        };
        if !self.finalization_registries.contains_key(&inst) {
            return Err(
                self.catchable_type_error_msg("this: not a FinalizationRegistry instance".into())
            );
        }
        Ok(inst)
    }

    /// `WeakRef.prototype.deref` and the two `FinalizationRegistry.prototype`
    /// methods. Arguments sit at `stack[base + 4 ..]`.
    pub(in crate::interp) fn call_weak_method(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let arg = |interp: &Self, i: usize| {
            interp
                .stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        match m {
            NativeMethod::WeakRefDeref => {
                let inst = match self.weakly_holdable(this) {
                    Some(inst) if self.weak_refs.contains_key(&inst) => inst,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this is no WeakRef instance".into())
                        )
                    }
                };
                let target = self.weak_refs[&inst].target;
                if target.is_null() {
                    return Ok(Slot::undefined());
                }
                self.meter.tick_slot_alloc(); // the fxKeepDuringJobs entry
                Ok(Slot::of(Kind::Reference, Payload::Reference(target)))
            }
            NativeMethod::FinalizationRegistryRegister => {
                let inst = self.finalization_registry_receiver(this)?;
                if argc < 1 {
                    return Err(self.catchable_type_error_msg("no target".into()));
                }
                let target_value = arg(self, 0);
                let Some(target) = self.weakly_holdable(target_value) else {
                    return Err(self.catchable_type_error_msg("target: not an object".into()));
                };
                let holdings = if argc > 1 {
                    let holdings = arg(self, 1);
                    if self.same_value(target_value, holdings) {
                        return Err(self
                            .catchable_type_error_msg("target and holdings are the same".into()));
                    }
                    holdings
                } else {
                    Slot::undefined()
                };
                let token = if argc > 2 {
                    let token = arg(self, 2);
                    if token.kind == Kind::Undefined {
                        crate::value::SlotIndex::NULL
                    } else {
                        match self.weakly_holdable(token) {
                            Some(token) => token,
                            None => {
                                return Err(
                                    self.catchable_type_error_msg("token: not an object".into())
                                )
                            }
                        }
                    }
                } else {
                    crate::value::SlotIndex::NULL
                };
                let registry = self.finalization_registries.get_mut(&inst).unwrap();
                // The holdings slot and the XS_FINALIZATION_CELL_KIND slot,
                // plus the `mxFinalizationRegistries` closure linking a
                // registry that gains its first cell.
                let first_cell = registry.cells.is_empty();
                registry.cells.push(FinalizationCell {
                    target,
                    holdings,
                    token,
                });
                self.meter.tick_slot_alloc();
                self.meter.tick_slot_alloc();
                if first_cell {
                    self.meter.tick_slot_alloc();
                }
                Ok(Slot::undefined())
            }
            NativeMethod::FinalizationRegistryUnregister => {
                let inst = self.finalization_registry_receiver(this)?;
                if argc < 1 {
                    return Err(self.catchable_type_error_msg("no token".into()));
                }
                let Some(token) = self.weakly_holdable(arg(self, 0)) else {
                    return Err(self.catchable_type_error_msg("token: not an object".into()));
                };
                let registry = self.finalization_registries.get_mut(&inst).unwrap();
                let before = registry.cells.len();
                registry
                    .cells
                    .retain(|cell| cell.token.is_null() || cell.token != token);
                Ok(Slot::boolean(registry.cells.len() != before))
            }
            _ => Err(Step::Host(Halt::EngineInvariant("weak:unexpected-method"))),
        }
    }

    /// Whether a sweep flagged a registry whose cleanup callbacks have not
    /// all run: true from the sweep that killed a registered target until
    /// the notification, the operator's [`Interp::notify_finalizations`] or
    /// the end of the next completed crank's drain, and after a callback's
    /// throw left dead cells behind.
    pub fn finalization_cleanup_pending(&self) -> bool {
        self.finalization_registries
            .values()
            .any(|registry| registry.changed)
    }

    /// `fxCleanupFinalizationRegistries` (`fxEndJob`): for every registry a
    /// collection flagged, run its callback once per cell whose target died,
    /// in registration order, removing each cell before the call. A throw
    /// propagates as the job's (XS's `mxCatch` restores the flag and
    /// `fxJump`s), leaving the remaining dead cells for the next boundary.
    /// Registries are visited in instance order, so the sequence of calls
    /// is fixed rather than a `HashMap`'s.
    pub(in crate::interp) fn cleanup_finalization_registries(
        &mut self,
        code: &[u8],
    ) -> Result<(), Step> {
        let mut changed: Vec<crate::value::SlotIndex> = self
            .finalization_registries
            .iter()
            .filter(|(_, registry)| registry.changed)
            .map(|(owner, _)| *owner)
            .collect();
        if changed.is_empty() {
            return Ok(());
        }
        changed.sort_unstable_by_key(|owner| owner.0);
        for owner in changed {
            loop {
                // Re-read each turn: the callback may `register`,
                // `unregister`, or run a nested cleanup on this registry.
                let Some(registry) = self.finalization_registries.get_mut(&owner) else {
                    break;
                };
                let Some(dead) = registry.cells.iter().position(|cell| cell.target.is_null())
                else {
                    registry.changed = false;
                    break;
                };
                let cell = registry.cells.remove(dead);
                let callback = registry.callback;
                self.run_callback(code, callback, Slot::undefined(), &[cell.holdings])?;
            }
        }
        Ok(())
    }
}
