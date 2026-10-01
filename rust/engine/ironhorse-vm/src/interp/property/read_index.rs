//! Property read index operations.
use crate::interp::*;

use super::HasLevels;

/// Where the ordinary levels of an index-keyed `[[Get]]` end: an answer, or
/// a Proxy whose own internal method takes over.
enum IndexLevels {
    Answered(Slot),
    Proxy(crate::value::SlotIndex),
}

impl Interp {
    /// `[[Get]]` of an index key whose canonical name the key table has never
    /// held, with `receiver` as the `[[Get]]` receiver.
    ///
    /// An ordinary own property exists only under a name that was interned to
    /// define it, so no ordinary slot anywhere on the chain can answer to an
    /// uninterned name. Only the receivers that resolve an index WITHOUT
    /// consulting the name table can: a TypedArray element, an array item, a
    /// String-wrapper unit, and a Proxy's `get` trap — which is handed the key
    /// as a string, and so is the one place the key is worth building at all.
    /// Every other object on the chain falls through to its prototype, and the
    /// end of the chain is `undefined`, minting nothing.
    pub(in crate::interp) fn uninterned_index_get(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        // Charged against the native-recursion budget like every other MOP
        // entry point: forwarding down a chain of untrapped proxies charges
        // one unit per layer ([`Self::uninterned_index_proxy_get`]), and an
        // unbudgeted chain would run without bound instead of halting with
        // `ReentryLimit`.
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.uninterned_index_get_inner(code, inst, index, receiver)
        })
    }

    pub(in crate::interp) fn uninterned_index_get_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        match self.uninterned_index_get_levels(code, inst, index, receiver)? {
            IndexLevels::Answered(value) => Ok(value),
            IndexLevels::Proxy(proxy) => {
                self.uninterned_index_proxy_get(code, proxy, index, receiver)
            }
        }
    }

    /// The ordinary levels of the index-keyed `[[Get]]` from `inst`: the
    /// Array Iterator's residual context, then the chain up to the answer or
    /// the first Proxy.
    fn uninterned_index_get_levels(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<IndexLevels, Step> {
        // The Array Iterator's residual for a trap already taken, exactly as
        // `mop_get` charges it for an id-keyed read. An ordinary object's
        // index property has no name, so this arm — not that one — is where
        // the iterator's read of one lands.
        //
        // The context is only ever installed against a Proxy target, so the
        // delegation below takes `proxy_get_with_metering` and cannot come
        // back through the `ReadKey::Index` arm that would re-enter here.
        if let Some(context) = self
            .array_iterator_proxy_get_context
            .filter(|context| context.target == inst)
            .filter(|context| self.refresh_read_key(context.key) == ReadKey::Index(index))
        {
            return self
                .mop_get_with_proxy_metering(
                    code,
                    inst,
                    ReadKey::Index(index),
                    receiver,
                    context.trap_metering,
                    context.meter_terminal_wrapper,
                    false,
                    true,
                )
                .map(IndexLevels::Answered);
        }
        let mut cur = inst;
        while !cur.is_null() {
            if self.proxies.contains_key(&cur) {
                return Ok(IndexLevels::Proxy(cur));
            }
            if let Some(&ta) = self.typed_arrays.get(&cur) {
                // The integer-indexed exotic `[[Get]]` answers for the whole
                // read, at the receiver or through a prototype, and never
                // continues up the chain (ECMA-262 10.4.5.4).
                return Ok(IndexLevels::Answered(
                    self.ta_indexed_element_get(ta, f64::from(index)),
                ));
            }
            if let Some(item) = self
                .arrays
                .get(&cur)
                .and_then(|a| a.items().get(&index).copied())
            {
                return Ok(IndexLevels::Answered(self.array_item_value(cur, item)));
            }
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            }) = self.wrapper_data.get(&cur).copied()
            {
                let unit = self.string_index_get(off, index);
                if unit.kind != Kind::Undefined {
                    return Ok(IndexLevels::Answered(unit));
                }
            }
            // An ordinary object at this chain level answers from its index
            // store. Only a data property can live there, so this is the
            // value, not a descriptor to interpret.
            if let Some(item) = self.index_prop_item(cur, index) {
                return Ok(IndexLevels::Answered(Slot::of(item.kind, item.value)));
            }
            cur = self.instance_prototype(cur);
        }
        Ok(IndexLevels::Answered(Slot::undefined()))
    }

    /// The Proxy arm of [`Self::uninterned_index_get`]: `[[Get]]` (ECMA-262
    /// 10.5.8) of an index key the name table has no id for.
    ///
    /// The trap must still be CALLED, and it is handed the key as a string —
    /// built from the index, exactly as XS's `fxKeyAt` builds one for
    /// `XS_NO_ID`, so the trap sees the canonical numeric string without the
    /// engine minting a key id for it. A proxy that traps nothing forwards to
    /// its target with the key still unbuilt.
    ///
    /// The recursion's re-entry for a target, [`Self::uninterned_index_get`],
    /// runs the Array Iterator's context check and the target's ordinary
    /// levels first, so the walk is [`Self::forwarding_levels_loop`]'s: a
    /// Proxy past them is the next layer.
    #[inline(never)]
    pub(in crate::interp) fn uninterned_index_proxy_get(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        self.forwarding_levels_loop(
            proxy,
            |vm, proxy| {
                vm.proxy_get_step(
                    code,
                    proxy,
                    ReadKey::Index(index),
                    receiver,
                    GetMetering::default(),
                )
            },
            |vm, target| {
                Ok(
                    match vm.uninterned_index_get_levels(code, target, index, receiver)? {
                        IndexLevels::Answered(value) => ProxyStep::Done(value),
                        IndexLevels::Proxy(next) => ProxyStep::Forward(next),
                    },
                )
            },
        )
    }

    /// Whether `o` has an OWN property at `index` whose name the table has
    /// never held — [`Self::object_own_property_present`] with the index known
    /// directly instead of derived from the key's name. Every arm that reaches
    /// for `find_property` there is `false` here: an ordinary own slot only
    /// exists under a name that was interned to define it.
    pub(in crate::interp) fn uninterned_index_own_present(
        &mut self,
        code: &[u8],
        o: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&o) {
            return Ok(self
                .uninterned_index_own_descriptor(code, o, index)?
                .is_some());
        }
        if let Some(&ta) = self.typed_arrays.get(&o) {
            return Ok(self.ta_valid_index(ta, f64::from(index)).is_some());
        }
        if let Some(a) = self.arrays.get(&o) {
            return Ok(a.items().contains_key(&index));
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&o).copied()
        {
            return Ok(self.string_exotic_has_own(self.str_len(off), None, Some(index)));
        }
        // An ordinary object keeps its index properties BY INDEX, so an
        // uninterned name misses them but the store does not.
        Ok(self.index_prop_item(o, index).is_some())
    }

    /// `[[HasProperty]]` of an index key the name table has no id for, plus
    /// the `fxOrdinaryHasProperty` frame count its callers meter — the same
    /// loop and the same counting rule as
    /// [`Self::mop_has_with_recursions_inner`].
    pub(in crate::interp) fn uninterned_index_has(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<(bool, u64), Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            match vm.uninterned_index_has_levels(code, inst, index)? {
                HasLevels::Answered(found, frames) => Ok((found, frames)),
                HasLevels::Proxy(proxy, frames) => {
                    Ok((vm.uninterned_index_proxy_has(code, proxy, index)?, frames))
                }
            }
        })
    }

    /// The ordinary levels of [`Self::uninterned_index_has`] from `inst`.
    fn uninterned_index_has_levels(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<HasLevels, Step> {
        let mut current = inst;
        let mut frames = 0u64;
        loop {
            if self.proxies.contains_key(&current) {
                return Ok(HasLevels::Proxy(current, frames));
            }
            if self.uninterned_index_own_present(code, current, index)? {
                return Ok(HasLevels::Answered(true, frames));
            }
            frames += 1;
            let prototype = self.instance_prototype(current);
            if prototype.is_null() {
                return Ok(HasLevels::Answered(false, frames));
            }
            current = prototype;
        }
    }

    /// `[[GetOwnProperty]]` of an index key the name table has no id for —
    /// [`Self::mop_get_own_property`] with the index known directly.
    pub(in crate::interp) fn uninterned_index_own_descriptor(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        // Budget-charged for the same reason as [`Self::uninterned_index_get`],
        // and to match `mop_get_own_property`, the id-keyed twin.
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.uninterned_index_own_descriptor_inner(code, inst, index)
        })
    }

    pub(in crate::interp) fn uninterned_index_own_descriptor_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        if self.proxies.contains_key(&inst) {
            return self.uninterned_index_proxy_own_descriptor(code, inst, index);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            return Ok(self.ta_index_own_descriptor(ta, f64::from(index)));
        }
        if let Some(descriptor) = self.exotic_index_descriptor(inst, index) {
            return Ok(Some(descriptor));
        }
        Ok(self.index_prop_descriptor(inst, index))
    }

    /// An array element's or a String wrapper's own descriptor at `index`,
    /// read without a name for the index (a program's `o[0]` interns none).
    pub(in crate::interp) fn exotic_index_descriptor(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        if let Some(item) = self
            .arrays
            .get(&inst)
            .and_then(|a| a.items().get(&index).copied())
        {
            let value = self.array_item_value(inst, item);
            return Some(OrdinaryDescriptor {
                value: Some(value),
                writable: Some(item.flag & XS_DONT_SET_FLAG == 0),
                enumerable: Some(item.flag & XS_DONT_ENUM_FLAG == 0),
                configurable: Some(item.flag & XS_DONT_DELETE_FLAG == 0),
                ..OrdinaryDescriptor::default()
            });
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            let value = self.string_index_get(off, index);
            if value.kind != Kind::Undefined {
                return Some(OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(false),
                    enumerable: Some(true),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                });
            }
        }
        None
    }

    /// `[[Delete]]` of an index key the name table has no id for —
    /// [`Self::mop_delete_inner`] with the index known directly. A delete
    /// creates nothing either, and an absent property is a vacuous `true`.
    pub(in crate::interp) fn uninterned_index_delete(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            if vm.proxies.contains_key(&inst) {
                return vm.uninterned_index_proxy_delete(code, inst, index);
            }
            if let Some(&ta) = vm.typed_arrays.get(&inst) {
                // The integer-indexed exotic `[[Delete]]` (10.4.5.7): a valid
                // index cannot be deleted; an invalid one is vacuously `true`.
                return Ok(vm.ta_valid_index(ta, f64::from(index)).is_none());
            }
            if vm.arrays.contains_key(&inst) {
                if let Some(item) = vm.arrays[&inst].items().get(&index).copied() {
                    if item.flag & XS_DONT_DELETE_FLAG != 0 {
                        return Ok(false);
                    }
                    vm.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&index, &mut vm.side_refs);
                    return Ok(true);
                }
                return Ok(true);
            }
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            }) = vm.wrapper_data.get(&inst).copied()
            {
                // String-exotic index units are non-configurable.
                if (index as usize) < vm.str_len(off) {
                    return Ok(false);
                }
            }
            // An ordinary object's index property lives in the index store.
            if let Some(item) = vm.index_prop_item(inst, index) {
                if item.flag & XS_DONT_DELETE_FLAG != 0 {
                    return Ok(false);
                }
                vm.index_prop_remove(inst, index);
            }
            // Anything else cannot hold the property, so there is nothing to
            // delete and no own slot to drop.
            Ok(true)
        })
    }

    /// The Proxy arm of [`Self::uninterned_index_has`]: `[[HasProperty]]`
    /// (ECMA-262 10.5.7) for an index key with no id. The trap is handed the
    /// key as a string; an untrapped proxy forwards with the key unbuilt.
    #[inline(never)]
    pub(in crate::interp) fn uninterned_index_proxy_has(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        // The recursion's re-entry for a target, `uninterned_index_has`, first
        // walks the target's ordinary levels.
        self.forwarding_levels_loop(
            proxy,
            |vm, proxy| vm.uninterned_index_proxy_has_step(code, proxy, index),
            |vm, target| {
                Ok(match vm.uninterned_index_has_levels(code, target, index)? {
                    HasLevels::Answered(found, _) => ProxyStep::Done(found),
                    HasLevels::Proxy(next, _) => ProxyStep::Forward(next),
                })
            },
        )
    }

    /// One layer of [`Self::uninterned_index_proxy_has`].
    fn uninterned_index_proxy_has_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "has")?;
        match self.proxy_trap(code, handler, "has")? {
            Some(trap) => self
                .uninterned_index_proxy_has_trapped(code, target, handler, trap, index)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of
    /// [`Self::uninterned_index_proxy_has`].
    #[inline(never)]
    fn uninterned_index_proxy_has_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        index: u32,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(ReadKey::Index(index))?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        let boolean = self.truthy(&result);
        if !boolean {
            // The trap may have NAMED this index, promoting it to an ordinary
            // slot the index arm cannot see; refresh or the invariant check is
            // silently skipped.
            let key_id = self.refresh_read_key(ReadKey::Index(index));
            if let Some(d) = self.mop_get_own_property_read(code, target, key_id)? {
                if d.configurable == Some(false) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for non-configurable property".into(),
                    ));
                }
                if !self.mop_is_extensible(code, target)? {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for property of not extensible object".into(),
                    ));
                }
            }
        }
        Ok(boolean)
    }

    /// The Proxy arm of [`Self::uninterned_index_own_descriptor`], which
    /// shares the step of `mop_get_own_property`, its id-keyed twin.
    #[inline(never)]
    pub(in crate::interp) fn uninterned_index_proxy_own_descriptor(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_get_own_property_step(code, proxy, ReadKey::Index(index)),
            |vm, target| vm.uninterned_index_own_descriptor(code, target, index),
        )
    }

    /// The Proxy arm of [`Self::uninterned_index_delete`].
    #[inline(never)]
    pub(in crate::interp) fn uninterned_index_proxy_delete(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_delete_step(code, proxy, ReadKey::Index(index)),
            |vm, target| vm.uninterned_index_delete(code, target, index),
        )
    }
}
