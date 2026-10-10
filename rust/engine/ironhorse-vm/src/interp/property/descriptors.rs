//! Property descriptors operations.
use crate::interp::*;

impl Interp {
    /// Add one field of a synthesized property descriptor object (an own
    /// enumerable data property `name = value`), charging the same slot weight
    /// on ordinary and Proxy descriptor paths. The field name resolves
    /// through the global intern table so `descriptor.value` (etc.) reads back
    /// under the same id the program's `.value` access uses.
    pub(in crate::interp) fn define_descriptor_field(
        &mut self,
        inst: crate::value::SlotIndex,
        name: &'static str,
        value: Slot,
    ) {
        self.meter.tick_slot_alloc();
        let id = self.intern_static_key(name);
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// Add one own enumerable data property with a **key slot** (string or
    /// symbol) — the symbol-keyed analogue of [`Self::define_descriptor_field`].
    pub(in crate::interp) fn define_descriptor_field_slot(
        &mut self,
        inst: crate::value::SlotIndex,
        key: Slot,
        value: Slot,
    ) {
        let id = match self.to_property_id(&[], key) {
            Ok(id) => id,
            Err(_) => return,
        };
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// `ValidateAndApplyPropertyDescriptor(undefined, P, extensible, Desc,
    /// current)` reduced to its boolean validity result (ECMA-262 10.1.6.3 with
    /// `O` undefined — `IsCompatiblePropertyDescriptor`). `Desc` is a completed
    /// descriptor; `current` is the target's own descriptor (or `None`).
    pub(in crate::interp) fn is_compatible_descriptor(
        &mut self,
        extensible: bool,
        desc: &OrdinaryDescriptor,
        current: Option<&OrdinaryDescriptor>,
    ) -> bool {
        self.meter.tick_builtin(); // ordinary and Proxy descriptor invariant work
        let current = match current {
            None => return extensible,
            Some(c) => c,
        };
        if current.configurable == Some(false) {
            if desc.configurable == Some(true) {
                return false;
            }
            if desc.enumerable.is_some() && desc.enumerable != current.enumerable {
                return false;
            }
            let desc_generic = !desc.is_accessor() && !desc.is_data();
            if desc_generic {
                return true;
            }
            if desc.is_accessor() != current.is_accessor() {
                return false;
            }
            if current.is_accessor() {
                if let Some(g) = desc.get {
                    if !self.same_value(g, current.get.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
                if let Some(s) = desc.set {
                    if !self.same_value(s, current.set.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
            } else if current.writable == Some(false) {
                if desc.writable == Some(true) {
                    return false;
                }
                if let Some(v) = desc.value {
                    if !self.same_value(v, current.value.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
            }
        }
        true
    }

    pub(in crate::interp) fn descriptor_from_object(
        &mut self,
        code: &[u8],
        descriptor: crate::value::SlotIndex,
    ) -> Result<OrdinaryDescriptor, Step> {
        let mut out = OrdinaryDescriptor::default();
        for name in [
            "enumerable",
            "configurable",
            "value",
            "writable",
            "get",
            "set",
        ] {
            // ToPropertyDescriptor performs HasProperty for all six standard
            // names even when the current program has never mentioned one.
            // Intern each key here rather than letting the symbol table's
            // incidental contents suppress observable Proxy traps.
            let id = self.intern_static_key(name);
            if !self.mop_has(code, descriptor, id)? {
                continue;
            }
            let receiver = Slot::of(Kind::Reference, Payload::Reference(descriptor));
            let value = self.mop_get(code, descriptor, id, receiver)?;
            match name {
                // ToBoolean via `truthy`, not the bare `to_boolean`: an
                // attribute given as `""` or `0n` is falsy, and only the
                // machine can read the string/bigint payload to know it.
                "enumerable" => out.enumerable = Some(self.truthy(&value)),
                "configurable" => out.configurable = Some(self.truthy(&value)),
                "value" => out.value = Some(value),
                "writable" => out.writable = Some(self.truthy(&value)),
                "get" => out.get = Some(value),
                "set" => out.set = Some(value),
                _ => unreachable!(),
            }
        }
        // XS fxDescriptorToSlot reads every field before validating getter
        // and setter combinations, so later accessors can still throw first.
        for (name, accessor) in [("get", out.get), ("set", out.set)] {
            if let Some(value) = accessor {
                if out.value.is_some() {
                    return Err(self.catchable_type_error_msg(format!(
                        "descriptor: {name} and value properties"
                    )));
                }
                if out.writable.is_some() {
                    return Err(self.catchable_type_error_msg(format!(
                        "descriptor: {name} and writable properties"
                    )));
                }
                if value.kind == Kind::Null {
                    return Err(
                        self.catchable_type_error_msg("cannot coerce null to object".into())
                    );
                }
                if value.kind != Kind::Undefined && !self.is_callable_value(value) {
                    return Err(
                        self.catchable_type_error_msg(format!("descriptor.{name}: not a function"))
                    );
                }
            }
        }
        Ok(out)
    }

    pub(in crate::interp) fn define_properties_from_object(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        descriptors: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(descriptors));
        let keys = self.mop_own_keys(code, descriptors)?;
        let mut pending = self.reserve_scratch(keys.len())?;
        for key in keys {
            let id = self.to_property_id(code, key)?;
            let enumerable = self
                .mop_get_own_property(code, descriptors, id)?
                .is_some_and(|descriptor| descriptor.enumerable == Some(true));
            if !enumerable {
                continue;
            }
            let value = self.mop_get(code, descriptors, id, receiver)?;
            let descriptor_object = match value.value {
                Payload::Reference(object) if value.kind == Kind::Reference => object,
                _ => return Err(self.catchable_type_error_msg("descriptor: not an object".into())),
            };
            pending.push((id, self.descriptor_from_object(code, descriptor_object)?));
        }
        for (id, descriptor) in pending {
            if !self.mop_define_own_property(code, target, id, descriptor)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(in crate::interp) fn alloc_descriptor_instance(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_slot_alloc();
        self.slots.alloc(Slot::instance(self.object_proto))
    }

    pub(in crate::interp) fn descriptor_object(&mut self, descriptor: OrdinaryDescriptor) -> Slot {
        let object = self.alloc_descriptor_instance();
        if descriptor.is_accessor() {
            self.define_descriptor_field(
                object,
                "get",
                descriptor.get.unwrap_or_else(Slot::undefined),
            );
            self.define_descriptor_field(
                object,
                "set",
                descriptor.set.unwrap_or_else(Slot::undefined),
            );
        } else {
            self.define_descriptor_field(
                object,
                "value",
                descriptor.value.unwrap_or_else(Slot::undefined),
            );
            self.define_descriptor_field(
                object,
                "writable",
                Slot::boolean(descriptor.writable.unwrap_or(false)),
            );
        }
        self.define_descriptor_field(
            object,
            "enumerable",
            Slot::boolean(descriptor.enumerable.unwrap_or(false)),
        );
        self.define_descriptor_field(
            object,
            "configurable",
            Slot::boolean(descriptor.configurable.unwrap_or(false)),
        );
        Slot::of(Kind::Reference, Payload::Reference(object))
    }
}
