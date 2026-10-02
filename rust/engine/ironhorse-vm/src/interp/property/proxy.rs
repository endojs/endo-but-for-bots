//! Property proxy operations.
use crate::interp::*;

use super::HasLevels;

impl Interp {
    // =====================================================================
    // Proxy (ECMA-262 10.5) — exotic behavior over the object MOP.
    //
    // A proxy is a `Kind::Instance` slot recorded in `self.proxies`. Its
    // thirteen internal methods dispatch here: each looks up the handler trap
    // (`GetMethod`), and — trap absent — forwards to the target's corresponding
    // internal method, so a proxy over a proxy (or over an ordinary object)
    // composes: a loop takes each further Proxy layer (`forwarding_loop`), and
    // a target that is not a Proxy goes through the `mop_*` dispatchers below
    // (STACK-DEPTH-REFACTOR.md B1). Every trap enforces the
    // spec's target-consistency invariants, throwing a realm-local, catchable
    // `TypeError` on violation. All ordinary/`Object.*`/`Reflect.*`/syntax
    // property operations route through the same `mop_*` seam so a trap cannot
    // be bypassed.
    // =====================================================================

    /// `new Proxy(target, handler)` / `Proxy.revocable` core: validate both
    /// operands are objects and mint the exotic (ECMA-262 10.5.1
    /// ProxyCreate). Returns the proxy reference slot.
    pub(in crate::interp) fn make_proxy(
        &mut self,
        target: Slot,
        handler: Slot,
    ) -> Result<Slot, Step> {
        let target_inst = match target.value {
            Payload::Reference(t) if target.kind == Kind::Reference => t,
            _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
        };
        let handler_inst = match handler.value {
            Payload::Reference(h) if handler.kind == Kind::Reference => h,
            _ => return Err(self.catchable_type_error_msg("handler: not an object".into())),
        };
        // A proxy instance has no identity prototype of its own (null proto);
        // its `[[Get]]`/`[[GetPrototypeOf]]` come from the traps/target.
        let inst = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        self.proxies.insert(
            inst,
            ProxyData {
                target: target_inst,
                handler: handler_inst,
                revoked: false,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// The `(target, handler)` pair of a live proxy, or a `TypeError` if it has
    /// been revoked (every trap begins with this check, ECMA-262 10.5.*).
    pub(in crate::interp) fn proxy_target_handler(
        &mut self,
        proxy: crate::value::SlotIndex,
        name: &'static str,
    ) -> Result<(crate::value::SlotIndex, crate::value::SlotIndex), Step> {
        self.meter.tick_raw(PROXY_INTERNAL_METHOD_METERING);
        self.meter.tick_builtin(); // target/handler validity check
        match self.proxies.get(&proxy) {
            Some(data) if !data.revoked => Ok((data.target, data.handler)),
            _ => Err(self.catchable_type_error_msg(format!("(proxy).{name}: no handler"))),
        }
    }

    /// `GetMethod(handler, name)` (ECMA-262 7.3.11): the trap function, `None`
    /// when it is `undefined`/`null`, a `TypeError` when present-but-uncallable.
    pub(in crate::interp) fn proxy_trap(
        &mut self,
        code: &[u8],
        handler: crate::value::SlotIndex,
        name: &'static str,
    ) -> Result<Option<Slot>, Step> {
        let id = self.intern_static_key(name);
        let hslot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let m = self.mop_get(code, handler, id, hslot)?;
        if m.kind == Kind::Undefined || m.kind == Kind::Null {
            return Ok(None);
        }
        if !self.is_callable_value(m) {
            return Err(self.catchable_type_error_msg(format!("(proxy).{name}: not a function")));
        }
        Ok(Some(m))
    }

    /// `CreateListFromArrayLike(value, «String, Symbol»)` (ECMA-262 7.3.18) —
    /// read `length`, then each indexed element, rejecting a non-string/symbol.
    pub(in crate::interp) fn proxy_key_list(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Vec<Slot>, Step> {
        let inst = match value.value {
            Payload::Reference(i) if value.kind == Kind::Reference => i,
            _ if value.kind == Kind::Null => {
                return Err(self.catchable_type_error_msg("cannot coerce null to object".into()))
            }
            _ if value.kind == Kind::Undefined => {
                return Err(
                    self.catchable_type_error_msg("cannot coerce undefined to object".into())
                )
            }
            // The pinned XS boxes other primitives here; retain the ECMA
            // object requirement until that semantic divergence is resolved.
            _ => {
                return Err(self.catchable_type_error_msg("Proxy: target must be an object".into()))
            }
        };
        let length = self.arraylike_length(code, inst, value)?;
        let len = self.to_length_value(code, length)?;
        let mut out = Vec::new();
        for i in 0..len {
            self.meter.tick_builtin();
            if self.check_meter() == MeterCheck::Abort {
                return Err(Step::Host(Halt::MeterAbort));
            }
            let element = self.arraylike_index(code, inst, i, value)?;
            if element.kind != Kind::String && element.kind != Kind::Symbol {
                return Err(self.catchable_type_error_msg(
                    "(proxy).ownKeys: key is neither string nor symbol".into(),
                ));
            }
            out.push(element);
        }
        Ok(out)
    }

    // -------------------------- the thirteen traps -----------------------

    /// `[[GetPrototypeOf]]` (ECMA-262 10.5.1).
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_prototype(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_get_prototype_step(code, proxy),
            |vm, target| vm.mop_get_prototype(code, target),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_get_prototype`].
    pub(in crate::interp) fn proxy_get_prototype_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<ProxyStep<Slot>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "getPrototypeOf")?;
        // Inline GetMethod here because its non-callable rejection has a
        // distinct XS meter outcome from a throwing getter. Other proxy traps
        // continue to share `proxy_trap`.
        let trap_id = self.intern_static_key("getPrototypeOf");
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let trap = self.mop_get(code, handler, trap_id, handler_slot)?;
        if trap.kind == Kind::Undefined || trap.kind == Kind::Null {
            self.charge_and_check(if self.proxies.contains_key(&target) {
                PROXY_GET_PROTOTYPE_FORWARD_PROXY_METERING
            } else {
                PROXY_GET_PROTOTYPE_FORWARD_TARGET_METERING
            })?;
            return Ok(ProxyStep::Forward(target));
        }
        self.proxy_get_prototype_trapped(code, target, handler, trap)
            .map(ProxyStep::Done)
    }

    /// The trap-present half of [`Self::proxy_get_prototype_step`]: the
    /// method's callability, the call and its invariant checks.
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_prototype_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
    ) -> Result<Slot, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        if !self.is_callable_value(trap) {
            self.meter
                .untick_raw(PROXY_GET_PROTOTYPE_NONCALLABLE_CREDIT);
            return Err(
                self.catchable_type_error_msg("(proxy).getPrototypeOf: not a function".into())
            );
        };
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = match self.invoke_value(code, trap, handler_slot, &[target_slot]) {
            Ok(result) => result,
            Err(error) => {
                self.meter.tick_raw(PROXY_GET_PROTOTYPE_THROW_METERING);
                return Err(error);
            }
        };
        if result.kind != Kind::Reference && result.kind != Kind::Null {
            self.meter.tick_raw(PROXY_GET_PROTOTYPE_PRIMITIVE_METERING);
            return Err(self.catchable_type_error_msg(
                "(proxy).getPrototypeOf: neither object nor null".into(),
            ));
        }
        if self.mop_is_extensible(code, target)? {
            self.meter.tick_raw(PROXY_GET_PROTOTYPE_TRAP_METERING);
            return Ok(result);
        }
        let target_proto = self.mop_get_prototype(code, target)?;
        if !self.same_value(result, target_proto) {
            self.meter
                .tick_raw(PROXY_GET_PROTOTYPE_INVARIANT_REJECT_METERING);
            return Err(self.catchable_type_error_msg(
                "(proxy).getPrototypeOf: different prototype for non-extensible object".into(),
            ));
        }
        self.meter
            .tick_raw(PROXY_GET_PROTOTYPE_FIXED_SUCCESS_METERING);
        Ok(result)
    }

    /// `[[SetPrototypeOf]]` (ECMA-262 10.5.2).
    #[inline(never)]
    pub(in crate::interp) fn proxy_set_prototype(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        proto: Slot,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_set_prototype_step(code, proxy, proto),
            |vm, target| vm.mop_set_prototype(code, target, proto),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_set_prototype`].
    pub(in crate::interp) fn proxy_set_prototype_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        proto: Slot,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "setPrototypeOf")?;
        match self.proxy_trap(code, handler, "setPrototypeOf")? {
            Some(trap) => self
                .proxy_set_prototype_trapped(code, target, handler, trap, proto)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of [`Self::proxy_set_prototype`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_set_prototype_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        proto: Slot,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, proto])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        if self.mop_is_extensible(code, target)? {
            return Ok(true);
        }
        let target_proto = self.mop_get_prototype(code, target)?;
        if !self.same_value(proto, target_proto) {
            return Err(self.catchable_type_error_msg(
                "(proxy).setPrototypeOf: true for non-extensible object with different prototype"
                    .into(),
            ));
        }
        Ok(true)
    }

    /// `[[IsExtensible]]` (ECMA-262 10.5.3).
    #[inline(never)]
    pub(in crate::interp) fn proxy_is_extensible(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_is_extensible_step(code, proxy),
            |vm, target| vm.mop_is_extensible(code, target),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_is_extensible`].
    pub(in crate::interp) fn proxy_is_extensible_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "isExtensible")?;
        match self.proxy_trap(code, handler, "isExtensible")? {
            Some(trap) => self
                .proxy_is_extensible_trapped(code, target, handler, trap)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant check of [`Self::proxy_is_extensible`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_is_extensible_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let boolean = self.truthy(&result);
        let target_result = self.mop_is_extensible(code, target)?;
        if boolean != target_result {
            return Err(self.catchable_type_error_msg(
                if boolean {
                    "(proxy).isExtensible: true for non-extensible object"
                } else {
                    "(proxy).isExtensible: false for extensible object"
                }
                .into(),
            ));
        }
        Ok(boolean)
    }

    /// `[[PreventExtensions]]` (ECMA-262 10.5.4).
    #[inline(never)]
    pub(in crate::interp) fn proxy_prevent_extensions(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_prevent_extensions_step(code, proxy),
            |vm, target| vm.mop_prevent_extensions(code, target),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_prevent_extensions`].
    pub(in crate::interp) fn proxy_prevent_extensions_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "preventExtensions")?;
        match self.proxy_trap(code, handler, "preventExtensions")? {
            Some(trap) => self
                .proxy_prevent_extensions_trapped(code, target, handler, trap)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant check of [`Self::proxy_prevent_extensions`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_prevent_extensions_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let boolean = self.truthy(&result);
        if boolean && self.mop_is_extensible(code, target)? {
            return Err(self.catchable_type_error_msg(
                "(proxy).preventExtensions: true for extensible object".into(),
            ));
        }
        Ok(boolean)
    }

    /// `[[GetOwnProperty]]` (ECMA-262 10.5.5).
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_own_property(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_get_own_property_step(code, proxy, ReadKey::Id(id)),
            |vm, target| vm.mop_get_own_property(code, target, id),
        )
    }

    /// One layer of `[[GetOwnProperty]]` for either spelling of the key, for
    /// the forwarding loops of [`Self::proxy_get_own_property`] and
    /// [`Self::uninterned_index_proxy_own_descriptor`].
    pub(in crate::interp) fn proxy_get_own_property_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
    ) -> Result<ProxyStep<Option<OrdinaryDescriptor>>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "getOwnPropertyDescriptor")?;
        match self.proxy_trap(code, handler, "getOwnPropertyDescriptor")? {
            Some(trap) => self
                .proxy_get_own_property_trapped(code, target, handler, trap, key)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The `getOwnPropertyDescriptor` trap call and its invariant checks,
    /// shared by the id-keyed path and by
    /// [`Self::uninterned_index_proxy_own_descriptor`]. The trap is passed in
    /// ALREADY RESOLVED: looking it up a second time would re-run a handler's
    /// accessor and double-meter the lookup.
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_own_property_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(key_id)?;
        let trap_result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        if trap_result.kind != Kind::Undefined && trap_result.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("descriptor: not an object".into()));
        }
        // The trap may have named this index mid-flight (see
        // `refresh_read_key`); a stale `Index` would miss the very property
        // the invariant check exists to find.
        let key_id = self.refresh_read_key(key_id);
        let target_desc = self.mop_get_own_property_read(code, target, key_id)?;
        if trap_result.kind == Kind::Undefined {
            match target_desc {
                None => return Ok(None),
                Some(d) => {
                    if d.configurable == Some(false) {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: no descriptor for non-configurable property".into()));
                    }
                    if !self.mop_is_extensible(code, target)? {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: no descriptor for existent property of non-extensible object".into()));
                    }
                    return Ok(None);
                }
            }
        }
        let obj = match trap_result.value {
            Payload::Reference(o) => o,
            _ => return Err(self.catchable_type_error_msg("descriptor: not an object".into())),
        };
        let result_desc = self.descriptor_from_object(code, obj)?;
        let result_desc = complete_descriptor(result_desc);
        let extensible = self.mop_is_extensible(code, target)?;
        if !self.is_compatible_descriptor(extensible, &result_desc, target_desc.as_ref()) {
            let message = if target_desc.is_some() {
                "(proxy).getOwnPropertyDescriptor: incompatible descriptor for existent property"
            } else {
                "(proxy).getOwnPropertyDescriptor: descriptor for non-existent property of non-extensible object"
            };
            return Err(self.catchable_type_error_msg(message.into()));
        }
        if result_desc.configurable == Some(false) {
            match &target_desc {
                None => return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: non-configurable descriptor for non-existent property".into())),
                Some(d) if d.configurable != Some(false) => return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: non-configurable descriptor for configurable property".into())),
                Some(d) => {
                    // A non-configurable non-writable target data property may
                    // not be reported writable.
                    if result_desc.is_data()
                        && result_desc.writable == Some(false)
                        && d.is_data()
                        && d.writable == Some(true)
                    {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: true with non-writable descriptor for non-configurable writable property".into()));
                    }
                }
            }
        }
        Ok(Some(result_desc))
    }

    /// `[[DefineOwnProperty]]` (ECMA-262 10.5.6).
    #[inline(never)]
    pub(in crate::interp) fn proxy_define_own_property(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_define_own_property_step(code, proxy, id, desc),
            |vm, target| vm.mop_define_own_property(code, target, id, desc),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_define_own_property`].
    pub(in crate::interp) fn proxy_define_own_property_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "defineProperty")?;
        match self.proxy_trap(code, handler, "defineProperty")? {
            Some(trap) => self
                .proxy_define_own_property_trapped(code, target, handler, trap, id, desc)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of
    /// [`Self::proxy_define_own_property`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_define_own_property_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.property_key_slot(id)?;
        let desc_obj = self.descriptor_object(desc);
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key, desc_obj])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        let target_desc = self.mop_get_own_property(code, target, id)?;
        let extensible = self.mop_is_extensible(code, target)?;
        let setting_config_false = desc.configurable == Some(false);
        match &target_desc {
            None => {
                if !extensible {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with descriptor for non-existent property of non-extensible object".into()));
                }
                if setting_config_false {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-configurable descriptor for non-existent property".into()));
                }
            }
            Some(d) => {
                if !self.is_compatible_descriptor(extensible, &desc, Some(d)) {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with incompatible descriptor for existent property".into()));
                }
                if setting_config_false && d.configurable != Some(false) {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-configurable descriptor for configurable property".into()));
                }
                if d.is_data()
                    && d.configurable == Some(false)
                    && d.writable == Some(true)
                    && desc.writable == Some(false)
                {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-writable descriptor for non-configurable writable property".into()));
                }
            }
        }
        Ok(true)
    }

    /// `[[HasProperty]]` (ECMA-262 10.5.7).
    #[inline(never)]
    pub(in crate::interp) fn proxy_has(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        // The forwarding loop of `forwarding_loop`, written out because the
        // recursion's re-entry for a target, `mop_has`, first walks the
        // target's ordinary levels: a Proxy past them is the next layer.
        self.with_forwarding_walk(|vm, held| {
            let mut proxy = proxy;
            loop {
                let target = match vm.proxy_has_step(code, proxy, id)? {
                    ProxyStep::Done(found) => return Ok(found),
                    ProxyStep::Forward(target) => target,
                };
                vm.forwarding_hop(held)?;
                match vm.mop_has_ordinary_levels(code, target, id)? {
                    HasLevels::Answered(found, _) => return Ok(found),
                    HasLevels::Proxy(next, _) => proxy = next,
                }
            }
        })
    }

    /// One layer of the forwarding loop of [`Self::proxy_has`].
    pub(in crate::interp) fn proxy_has_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "has")?;
        match self.proxy_trap(code, handler, "has")? {
            Some(trap) => self
                .proxy_has_trapped(code, target, handler, trap, id)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of [`Self::proxy_has`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_has_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        id: u16,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.property_key_slot(id)?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        let boolean = self.truthy(&result);
        if !boolean {
            if let Some(d) = self.mop_get_own_property(code, target, id)? {
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

    /// `[[Get]]` (ECMA-262 10.5.8).
    pub(in crate::interp) fn proxy_get(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        self.proxy_get_with_metering(
            code,
            proxy,
            ReadKey::Id(id),
            receiver,
            GetMetering::default(),
        )
    }

    #[inline(never)]
    pub(in crate::interp) fn proxy_get_with_metering(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        mut metering: GetMetering,
    ) -> Result<Slot, Step> {
        let target = match self.proxy_get_step(code, proxy, key, receiver, metering)? {
            ProxyStep::Done(result) => return Ok(result),
            ProxyStep::Forward(target) => target,
        };
        // A forward past the Array Iterator's trap turns on the target's
        // forwarded metering for the rest of the walk.
        metering.forwarded_target |= metering.proxy_trap != 0;
        if !self.proxies.contains_key(&target) {
            return self.mop_get_with_proxy_metering(
                code,
                target,
                key,
                receiver,
                metering.proxy_trap,
                metering.terminal_wrapper,
                metering.forwarded_target,
                metering.after_active_trap,
            );
        }
        self.proxy_get_forwarded(code, target, key, receiver, metering)
    }

    /// The rest of [`Self::proxy_get_with_metering`] when its target is
    /// another Proxy: the forwarding loop of `forwarding_loop`, written out
    /// for the forwarded metering, and out of line so that one Proxy over an
    /// ordinary target (a Proxy in a prototype cycle) keeps the single
    /// layer's frame.
    #[inline(never)]
    fn proxy_get_forwarded(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        metering: GetMetering,
    ) -> Result<Slot, Step> {
        self.with_forwarding_walk(|vm, held| {
            let mut proxy = proxy;
            let mut metering = metering;
            loop {
                // The unit `mop_get_with_proxy_metering(proxy)` charged.
                vm.forwarding_hop(held)?;
                let target = match vm.proxy_get_step(code, proxy, key, receiver, metering)? {
                    ProxyStep::Done(result) => return Ok(result),
                    ProxyStep::Forward(target) => target,
                };
                metering.forwarded_target |= metering.proxy_trap != 0;
                if !vm.proxies.contains_key(&target) {
                    return vm.mop_get_with_proxy_metering(
                        code,
                        target,
                        key,
                        receiver,
                        metering.proxy_trap,
                        metering.terminal_wrapper,
                        metering.forwarded_target,
                        metering.after_active_trap,
                    );
                }
                proxy = target;
            }
        })
    }

    /// The Proxy leg of [`Interp::get_legs`] (STACK-DEPTH-REFACTOR.md B1,
    /// B9): [`Self::proxy_get_with_metering`]'s layer and forwarding loop,
    /// charging each forwarded-to Proxy the unit `mop_get_with_proxy_metering`
    /// charged it, into `held`. Ends with the trap's result, or at the first
    /// target that is not a Proxy, with the forward's metering for it. Out of
    /// line, so that a trap it calls runs under its frame and the loop's
    /// small one alone.
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_leg(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        mut metering: GetMetering,
        held: &mut usize,
    ) -> Result<GetLeg, Step> {
        let mut proxy = proxy;
        loop {
            let target = match self.proxy_get_step(code, proxy, key, receiver, metering)? {
                ProxyStep::Done(result) => return Ok(GetLeg::Value(result)),
                ProxyStep::Forward(target) => target,
            };
            // A forward past the Array Iterator's trap turns on the target's
            // forwarded metering for the rest of the walk.
            metering.forwarded_target |= metering.proxy_trap != 0;
            if !self.proxies.contains_key(&target) {
                return Ok(GetLeg::Target(target, metering));
            }
            // The unit `mop_get_with_proxy_metering(target)` charged.
            self.forwarding_hop(held)?;
            proxy = target;
        }
    }

    /// One layer of the forwarding loop of [`Self::proxy_get_with_metering`],
    /// and of [`Self::proxy_get_leg`]'s.
    /// A forward past the Array Iterator's trap charges its residual here;
    /// the loop then meters the target as forwarded
    /// (`forwarded_target || proxy_trap != 0`), as the recursive shape passed
    /// down. `metering.after_active_trap` reaches only the terminal.
    pub(in crate::interp) fn proxy_get_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        metering: GetMetering,
    ) -> Result<ProxyStep<Slot>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "get")?;
        match self.proxy_trap(code, handler, "get")? {
            Some(trap) => self
                .proxy_get_trapped(code, target, handler, trap, key, receiver, metering)
                .map(ProxyStep::Done),
            None => {
                if metering.proxy_trap != 0 {
                    self.meter.tick_raw(ARRAY_ITERATOR_PROXY_FORWARD_METERING);
                }
                Ok(ProxyStep::Forward(target))
            }
        }
    }

    /// The `get` trap call of `[[Get]]` (ECMA-262 10.5.8 steps 7-10) and its
    /// non-configurable-target invariant checks, shared by the id-keyed read
    /// and by the index-keyed read of [`Self::uninterned_index_get`], whose key
    /// has no id.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    pub(in crate::interp) fn proxy_get_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
        receiver: Slot,
        metering: GetMetering,
    ) -> Result<Slot, Step> {
        let GetMetering {
            proxy_trap: proxy_trap_metering,
            terminal_wrapper: meter_terminal_wrapper,
            forwarded_target: meter_forwarded_target,
            ..
        } = metering;
        if meter_forwarded_target {
            self.charge_and_check(
                if proxy_trap_metering == ARRAY_ITERATOR_PROXY_VALUE_METERING {
                    ARRAY_ITERATOR_PROXY_VALUE_FORWARD_ACTIVE_METERING
                } else {
                    ARRAY_ITERATOR_PROXY_FORWARD_ACTIVE_METERING
                },
            )?;
        }
        self.charge_and_check(proxy_trap_metering)?;
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        // Built here, after the trap's metering, so the id-keyed read keeps
        // the order it had before this arm was shared. An index with no id
        // spells its own key, exactly as XS's `fxKeyAt` does for `XS_NO_ID`.
        let key = self.read_key_slot(key_id)?;
        let saved_context = self.array_iterator_proxy_get_context;
        // Installed for an INDEX key as well as an id. It used to be id-only,
        // on the invariant that "the uninterned-index arm always meters zero"
        // — true while every ordinary object's index property carried an
        // interned name, so an Array Iterator read of one arrived here as an
        // `Id`. With those properties kept by index that read is index-keyed,
        // and skipping the residual made
        // `Array.prototype.values.call(new Proxy(new Proxy({length:1,0:7},{}),
        // {get(t,k,r){return Reflect.get(t,k,r)}}))` cost four computrons less
        // than the oracle charges.
        if proxy_trap_metering != 0 && self.proxies.contains_key(&target) {
            self.array_iterator_proxy_get_context = Some(ArrayIteratorProxyGetContext {
                target,
                key: key_id,
                trap_metering: proxy_trap_metering,
                meter_terminal_wrapper,
            });
        }
        let trap_result =
            self.invoke_value(code, trap, handler_slot, &[target_slot, key, receiver]);
        self.array_iterator_proxy_get_context = saved_context;
        let trap_result = trap_result?;
        // Ask the target by INDEX when the table still has no name for it: an
        // array / TypedArray / String-wrapper / proxy target answers out of
        // its side table, so `new Proxy([], handler)[i]` needs no name. But
        // the trap has just run and may itself have NAMED this index —
        // promoting it to an ordinary slot the index arm cannot see — so
        // refresh first, or the invariant check is silently skipped.
        let key_id = self.refresh_read_key(key_id);
        if let Some(d) = self.mop_get_own_property_read(code, target, key_id)? {
            if d.configurable == Some(false) {
                if d.is_data()
                    && d.writable == Some(false)
                    && !self.same_value(trap_result, d.value.unwrap_or_else(Slot::undefined))
                {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).get: different value for non-configurable, non-writable property"
                            .into(),
                    ));
                }
                if d.is_accessor()
                    && d.get.map(|g| g.kind == Kind::Undefined).unwrap_or(true)
                    && trap_result.kind != Kind::Undefined
                {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).get: different getter for non-configurable property".into(),
                    ));
                }
            }
        }
        Ok(trap_result)
    }

    /// `[[Set]]` (ECMA-262 10.5.9).
    #[inline(never)]
    pub(in crate::interp) fn proxy_set(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_set_step(code, proxy, id, value, receiver),
            |vm, target| vm.set_from(code, target, id, value, receiver),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_set`], and the step
    /// of `proxy_set_leg` (STACK-DEPTH-REFACTOR.md B9). Expanded in both, as
    /// it was in the first alone: a frame of its own would sit on every level
    /// of a nest through a `set` trap.
    #[inline(always)]
    pub(in crate::interp) fn proxy_set_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "set")?;
        match self.proxy_trap(code, handler, "set")? {
            Some(trap) => self
                .proxy_set_trapped(
                    code,
                    target,
                    handler,
                    trap,
                    ReadKey::Id(id),
                    value,
                    receiver,
                )
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of [`Self::proxy_set`], for either
    /// spelling of the key: an index the table has never named reaches the
    /// trap as the string `fxKeyAt` would spell, without minting a name.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    pub(in crate::interp) fn proxy_set_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key: ReadKey,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key_slot = self.read_key_slot(key)?;
        let result = self.invoke_value(
            code,
            trap,
            handler_slot,
            &[target_slot, key_slot, value, receiver],
        )?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        let key = self.refresh_read_key(key);
        if let Some(d) = self.mop_get_own_property_read(code, target, key)? {
            if d.configurable == Some(false) {
                if d.is_data()
                    && d.writable == Some(false)
                    && !self.same_value(value, d.value.unwrap_or_else(Slot::undefined))
                {
                    return Err(self.catchable_type_error_msg("(proxy).set: true for non-configurable, non-writable property with different value".into()));
                }
                if d.is_accessor() && d.set.map(|s| s.kind == Kind::Undefined).unwrap_or(true) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).set: true for non-configurable property with different setter"
                            .into(),
                    ));
                }
            }
        }
        Ok(true)
    }

    /// `[[Delete]]` (ECMA-262 10.5.10).
    #[inline(never)]
    pub(in crate::interp) fn proxy_delete(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_delete_step(code, proxy, ReadKey::Id(id)),
            |vm, target| vm.mop_delete(code, target, id),
        )
    }

    /// One layer of `[[Delete]]` for either spelling of the key, for the
    /// forwarding loops of [`Self::proxy_delete`] and
    /// [`Self::uninterned_index_proxy_delete`].
    pub(in crate::interp) fn proxy_delete_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
    ) -> Result<ProxyStep<bool>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "deleteProperty")?;
        match self.proxy_trap(code, handler, "deleteProperty")? {
            Some(trap) => self
                .proxy_delete_trapped(code, target, handler, trap, key)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The `deleteProperty` trap call and its invariant checks, shared by the
    /// id-keyed path and by [`Self::uninterned_index_proxy_delete`]. The trap
    /// arrives ALREADY RESOLVED, for the same reason as
    /// [`Self::proxy_get_own_property_trapped`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_delete_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(key_id)?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        // The trap may have named this index mid-flight (see
        // `refresh_read_key`); a stale `Index` would miss the very property
        // the invariant check exists to find.
        let key_id = self.refresh_read_key(key_id);
        let target_desc = self.mop_get_own_property_read(code, target, key_id)?;
        match target_desc {
            None => Ok(true),
            Some(d) => {
                if d.configurable == Some(false) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).deleteProperty: true for non-configurable property".into(),
                    ));
                }
                if !self.mop_is_extensible(code, target)? {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).deleteProperty: true for non-extensible object".into(),
                    ));
                }
                Ok(true)
            }
        }
    }

    /// `[[OwnPropertyKeys]]` (ECMA-262 10.5.11).
    #[inline(never)]
    pub(in crate::interp) fn proxy_own_keys(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<Vec<Slot>, Step> {
        self.forwarding_loop(
            proxy,
            |vm, proxy| vm.proxy_own_keys_step(code, proxy),
            |vm, target| vm.mop_own_keys(code, target),
        )
    }

    /// One layer of the forwarding loop of [`Self::proxy_own_keys`].
    pub(in crate::interp) fn proxy_own_keys_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<ProxyStep<Vec<Slot>>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "ownKeys")?;
        match self.proxy_trap(code, handler, "ownKeys")? {
            Some(trap) => self
                .proxy_own_keys_trapped(code, target, handler, trap)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and invariant checks of [`Self::proxy_own_keys`].
    #[inline(never)]
    pub(in crate::interp) fn proxy_own_keys_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
    ) -> Result<Vec<Slot>, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let trap_result_array = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let trap_keys = self.proxy_key_list(code, trap_result_array)?;
        // The invariant checks below only COMPARE key sets; they create
        // nothing. Naming each key to compare it made
        // `Object.getOwnPropertyNames(new Proxy(bigArray, {ownKeys}))` — and
        // the object spread that reaches the same trap — spend one id per
        // element of the target, which walks the `u16` space into the
        // saturation guard that poisons the machine.
        //
        // No duplicate keys allowed in the trap result.
        let mut seen: Vec<ReadKey> = self.reserve_scratch(trap_keys.len())?;
        for k in &trap_keys {
            let key = self.to_read_key(code, *k)?;
            self.charge_builtin_work(seen.len() as u64)?;
            if seen.contains(&key) {
                return Err(self.catchable_type_error_msg("(proxy).ownKeys: duplicate key".into()));
            }
            seen.push(key);
        }
        let extensible = self.mop_is_extensible(code, target)?;
        let target_keys = self.mop_own_keys(code, target)?;
        let mut target_configurable: Vec<ReadKey> = Vec::new();
        let mut target_nonconfigurable: Vec<ReadKey> = Vec::new();
        for tk in &target_keys {
            self.meter.tick_builtin();
            let key = self.to_read_key(code, *tk)?;
            match self.mop_get_own_property_read(code, target, key)? {
                Some(d) if d.configurable == Some(false) => target_nonconfigurable.push(key),
                _ => target_configurable.push(key),
            }
        }
        if extensible && target_nonconfigurable.is_empty() {
            return Ok(trap_keys);
        }
        // Every descriptor read above could have run a trap that names an
        // index, so an `Index` captured before one of them and an `Id` derived
        // after it can be the same property spelled two ways. Canonicalize
        // both sides HERE, at the point of comparison — after the last guest
        // code that could have changed the answer, and before the first
        // equality test that depends on it.
        for key in seen
            .iter_mut()
            .chain(&mut target_nonconfigurable)
            .chain(&mut target_configurable)
        {
            *key = self.refresh_read_key(*key);
        }
        let mut unchecked = seen.clone();
        for tid in &target_nonconfigurable {
            self.charge_builtin_work(unchecked.len() as u64)?;
            match unchecked.iter().position(|u| u == tid) {
                Some(pos) => {
                    unchecked.remove(pos);
                }
                None => {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).ownKeys: no key for non-configurable property".into(),
                    ))
                }
            }
        }
        if extensible {
            return Ok(trap_keys);
        }
        for tid in &target_configurable {
            self.charge_builtin_work(unchecked.len() as u64)?;
            match unchecked.iter().position(|u| u == tid) {
                Some(pos) => {
                    unchecked.remove(pos);
                }
                None => {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).ownKeys: no key for property of non-extensible object".into(),
                    ))
                }
            }
        }
        if !unchecked.is_empty() {
            return Err(self.catchable_type_error_msg(
                "(proxy).ownKeys: key for non-existent property of non-extensible object".into(),
            ));
        }
        Ok(trap_keys)
    }

    /// What forwarding `[[Call]]` to `target` costs, by the kind of callable
    /// it is.
    fn proxy_call_forward_metering(&self, target: crate::value::SlotIndex) -> u64 {
        if self.proxies.contains_key(&target) {
            PROXY_CALL_FORWARD_PROXY_METERING
        } else if self.bound_functions.contains_key(&target) {
            PROXY_CALL_FORWARD_BOUND_METERING
        } else if self.native_of(target).is_some() {
            PROXY_CALL_FORWARD_NATIVE_METERING
        } else if let Some(method) = self.method_of(target) {
            if matches!(
                method,
                NativeMethod::CollForEach
                    | NativeMethod::CollEntries
                    | NativeMethod::CollKeys
                    | NativeMethod::CollValues
                    | NativeMethod::CollClear
            ) {
                PROXY_CALL_FORWARD_METHOD_METERING
            } else {
                PROXY_CALL_FORWARD_NATIVE_METERING
            }
        } else {
            PROXY_CALL_FORWARD_USER_METERING
        }
    }

    /// One layer of `[[Call]]`: the forward's classification charge, or the
    /// trap's tick and its argument array, in the order the recursive shape
    /// made them. `invoke_value` takes the result as its next turn.
    pub(in crate::interp) fn proxy_call_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        this: Slot,
        args: &[Slot],
    ) -> Result<ProxyCall, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "apply")?;
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let trap = match self.proxy_trap(code, handler, "apply")? {
            Some(t) => t,
            None => {
                self.charge_and_check(self.proxy_call_forward_metering(target))?;
                return Ok(ProxyCall::Forward(target));
            }
        };
        self.meter.tick_raw(PROXY_CALL_TRAP_METERING);
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let arg_array = self.array_from_slots(args);
        Ok(ProxyCall::Trap {
            trap,
            handler: handler_slot,
            args: [target_slot, this, arg_array],
        })
    }

    /// `[[Construct]]` (ECMA-262 10.5.13). A light frame of the
    /// native-recursion budget, like `[[Call]]` ([`Self::proxy_run_call`]).
    ///
    /// A Proxy has [[Construct]] only when its target does (ProxyCreate step
    /// 7), so `new` on one whose target is not a constructor throws before
    /// any trap runs, with XS's message (XS sets `XS_CAN_CONSTRUCT_FLAG` from
    /// the target when it creates the Proxy).
    #[inline(never)]
    pub(in crate::interp) fn proxy_construct(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        if self.proxy_construct_refused(proxy) {
            return Err(self.catchable_type_error_msg("new: proxy is not a constructor".into()));
        }
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.proxy_construct_inner(code, proxy, args, new_target)
        })
    }

    /// Whether `new` on `proxy` throws before any trap: its innermost target
    /// is not a constructor. A revoked layer has lost its target, so it is
    /// not refused here and its construct step throws the revocation error.
    /// (XS keeps the capability through revocation: there, `new` on a revoked
    /// Proxy over an arrow still says "new: proxy is not a constructor".)
    #[inline(never)]
    pub(in crate::interp) fn proxy_construct_refused(
        &self,
        proxy: crate::value::SlotIndex,
    ) -> bool {
        let mut current = proxy;
        while let Some(data) = self.proxies.get(&current) {
            if data.revoked {
                return false;
            }
            current = data.target;
        }
        !self.slot_is_constructor(current)
    }

    pub(in crate::interp) fn proxy_construct_inner(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        match self.proxy_construct_step(code, proxy, args, new_target)? {
            ProxyStep::Forward(target) => self.construct_value(
                code,
                Slot::of(Kind::Reference, Payload::Reference(target)),
                args,
                new_target,
            ),
            ProxyStep::Done(result) => Ok(result),
        }
    }

    /// One layer of `[[Construct]]`, for the forwarding loop of
    /// `construct_value`.
    pub(in crate::interp) fn proxy_construct_step(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<ProxyStep<Slot>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "construct")?;
        match self.proxy_trap(code, handler, "construct")? {
            Some(trap) => self
                .proxy_construct_trapped(code, target, handler, trap, args, new_target)
                .map(ProxyStep::Done),
            None => Ok(ProxyStep::Forward(target)),
        }
    }

    /// The trap call and result check of `[[Construct]]`.
    #[inline(never)]
    pub(in crate::interp) fn proxy_construct_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let arg_array = self.array_from_slots(args);
        let result = self.invoke_value(
            code,
            trap,
            handler_slot,
            &[target_slot, arg_array, new_target],
        )?;
        if result.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("(proxy).construct: not an object".into()));
        }
        Ok(result)
    }
}
