//! Realm-owned state, separate from the machine's heap and intrinsic graph.
use super::*;

/// A global environment and its host evaluation policy within an interpreter.
/// Heap coordinates and property-key identities belong to the owning machine.
pub struct Realm {
    pub(super) global_obj: crate::value::SlotIndex,
    pub(super) global_props: std::collections::HashMap<u16, crate::value::SlotIndex>,
    pub(super) owner: Option<std::rc::Weak<()>>,
    pub(super) intrinsic_permit: Option<std::collections::BTreeSet<SymbolName>>,
    pub(super) unhandled_rejection: Option<crate::value::SlotIndex>,
    pub(super) source_compiler: Option<std::rc::Rc<dyn SourceCompiler>>,
}

impl Realm {
    pub(super) fn new(global_obj: crate::value::SlotIndex) -> Self {
        Self {
            global_obj,
            global_props: Default::default(),
            source_compiler: None,
            intrinsic_permit: None,
            owner: None,
            unhandled_rejection: None,
        }
    }
}

impl Interp {
    pub(crate) fn intrinsics_are_frozen(&self) -> bool {
        self.intrinsics_frozen
    }

    /// Build the complete intrinsic graph before any guest can observe it.
    /// Program-local symbol operands will be relinked to this machine table.
    pub(crate) fn new_shared_realm_machine() -> Self {
        let mut machine = Self::new();
        let mut names: Vec<SymbolName> = crate::default_keys::DEFAULT_KEYS
            .iter()
            .copied()
            .chain(machine.intrinsics.keys().copied())
            .chain(machine.proto_methods.iter().map(|(_, name, _)| *name))
            .chain(machine.proto_data.iter().map(|(_, name, _)| *name))
            .chain(machine.proto_value_data.iter().map(|(_, name, _)| *name))
            .map(SymbolName::from)
            .collect();
        names.sort();
        names.dedup();
        machine.link_intrinsics(&names);
        // Before guest execution every allocated instance is primordial, except
        // the host global and the engine's writable tagged-template cache.
        // Enumerating the arena also includes non-global async/generator and
        // iterator families with no forward edge from a named constructor.
        let roots: Vec<_> = (0..machine.slots.capacity())
            .map(crate::value::SlotIndex)
            .filter(|&root| root != machine.realm.global_obj && root != machine.template_cache)
            .filter(|&root| machine.slots.get(root).kind == Kind::Instance)
            .collect();
        for root in roots {
            machine
                .do_harden(&[], Slot::of(Kind::Reference, Payload::Reference(root)))
                .expect("pristine intrinsic graph must admit transitive freezing");
        }
        machine.intrinsics_frozen = true;
        machine.meter = Meter::new();
        machine
    }
}

impl Realm {
    /// This realm's actual global object, in its owning machine's arena.
    pub fn global_object(&self) -> crate::value::SlotIndex {
        self.global_obj
    }
}

impl Interp {
    pub(crate) fn activate_realm(&mut self, target: crate::value::SlotIndex) -> Result<(), Halt> {
        if target == self.realm.global_obj {
            return Ok(());
        }
        if !self.is_quiescent() {
            return Err(Halt::RealmBusy);
        }
        let realm = self
            .inactive_realms
            .remove(&target)
            .ok_or(Halt::RealmBusy)?;
        let old = std::mem::replace(&mut self.realm, realm);
        self.inactive_realms.insert(old.global_obj, old);
        Ok(())
    }

    pub(crate) fn create_realm(
        &mut self,
        permit: Option<std::collections::BTreeSet<SymbolName>>,
        owner: std::rc::Weak<()>,
    ) -> Result<crate::value::SlotIndex, Halt> {
        if !self.is_quiescent() {
            return Err(Halt::RealmBusy);
        }
        let global = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        let mut realm = Realm::new(global);
        realm.intrinsic_permit = permit;
        realm.owner = Some(owner);
        let old = std::mem::replace(&mut self.realm, realm);
        self.inactive_realms.insert(old.global_obj, old);
        let names = self.symbol_names.to_vec();
        self.install_intrinsic_bindings(&names, 0, false, |_| true);
        Ok(global)
    }

    pub(crate) fn set_realm_meter(
        &mut self,
        meter: Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) {
        self.meter = meter;
        self.n_dispatched = 0;
        self.meter_host = host;
    }

    pub(crate) fn detach_realm_host(&mut self) -> Option<Box<dyn FnMut(u64) -> bool>> {
        self.meter_host.take()
    }

    pub(crate) fn detach_realm_compiler(&mut self) -> Option<std::rc::Rc<dyn SourceCompiler>> {
        self.realm.source_compiler.take()
    }

    pub(crate) fn take_realm_meter(&mut self) -> (Meter, Option<Box<dyn FnMut(u64) -> bool>>) {
        (std::mem::take(&mut self.meter), self.meter_host.take())
    }

    pub(crate) fn realm_symbol(&mut self, name: SymbolName) -> Result<u16, Halt> {
        if !self.symbol_ids.contains_key(&name) && !self.has_guest_key_capacity(1) {
            return Err(Halt::HeapExhausted);
        }
        Ok(self.intern_program_symbol(name))
    }

    pub(crate) fn relink_unlinked_realm_program(&mut self, code: &[u8]) -> Result<Vec<u8>, Halt> {
        let (site_order, accesses) = Self::template_site_accesses(code)
            .map_err(|_| Halt::Decode(DecodeError::InvalidSymbols))?;
        let mut new_names = std::collections::BTreeSet::new();
        crate::opcode::remap_ids(code, |id| {
            if id != 0 {
                let name = SymbolName::from(format!("\0bytecode-id-{id}"));
                if !self.symbol_ids.contains_key(&name) {
                    new_names.insert(name);
                }
            }
            Some(id)
        })
        .ok_or(Halt::Decode(DecodeError::InvalidSymbols))?;
        if !self.has_guest_key_capacity(new_names.len() + site_order.len()) {
            return Err(Halt::HeapExhausted);
        }
        let mut remapped = crate::opcode::remap_ids(code, |id| {
            if id == 0 {
                Some(0)
            } else {
                self.realm_symbol(SymbolName::from(format!("\0bytecode-id-{id}")))
                    .ok()
            }
        })
        .ok_or(Halt::Decode(DecodeError::InvalidSymbols))?;
        self.apply_template_site_ids(&mut remapped, site_order, accesses)
            .map_err(|_| Halt::Decode(DecodeError::InvalidSymbols))?;
        Ok(remapped)
    }

    /// Read-only identity inspection; getters and guest coercions never run.
    pub(crate) fn realm_global_identity(
        &self,
        realm: crate::value::SlotIndex,
        name: &str,
    ) -> Option<crate::value::SlotIndex> {
        let realm = if realm == self.realm.global_obj {
            &self.realm
        } else {
            self.inactive_realms.get(&realm)?
        };
        let id = self.symbol_ids.get(name)?;
        let prop = self.slots.get(*realm.global_props.get(id)?);
        if prop.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            return None;
        }
        match prop.value {
            Payload::Reference(reference) if prop.kind == Kind::Reference => Some(reference),
            _ => None,
        }
    }
}

impl Interp {
    /// Drop unreachable host realms at an idle boundary. An orphaned failed
    /// Realm has no future caller; discard its queued work before establishing
    /// a clean boundary, without ever running it against a sibling global.
    pub(crate) fn reap_realms(&mut self) -> Result<(), Halt> {
        self.inactive_realms.retain(|_, realm| {
            realm
                .owner
                .as_ref()
                .is_none_or(|owner| owner.strong_count() != 0)
        });
        self.identity_roots
            .retain(|_, owner| owner.strong_count() != 0);
        if self
            .realm
            .owner
            .as_ref()
            .is_some_and(|owner| owner.strong_count() == 0)
        {
            self.promise_jobs.clear();
            self.pending_rejections.clear();
            self.set_realm_meter(Meter::new(), None);
            let result = self.run_promise_jobs();
            if !result.completed {
                return Err(result.halt);
            }
            let root = self
                .inactive_realms
                .iter()
                .find_map(|(id, realm)| realm.owner.is_none().then_some(*id))
                .expect("machine root Realm");
            self.realm = self.inactive_realms.remove(&root).unwrap();
        }
        Ok(())
    }

    pub(crate) fn pin_identity(&mut self, object: crate::SlotIndex) -> std::rc::Rc<()> {
        if let Some(lease) = self
            .identity_roots
            .get(&object)
            .and_then(std::rc::Weak::upgrade)
        {
            return lease;
        }
        let lease = std::rc::Rc::new(());
        self.identity_roots
            .insert(object, std::rc::Rc::downgrade(&lease));
        lease
    }

    pub(crate) fn realm_context(&self, id: crate::SlotIndex) -> Option<&Realm> {
        if self.realm.global_obj == id {
            Some(&self.realm)
        } else {
            self.inactive_realms.get(&id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlinked_template_sites_are_unique_across_compilations() {
        let mut machine = Interp::new_shared_realm_machine();
        let code = [
            Opcode::XS_CODE_TEMPLATE_CACHE as u8,
            Opcode::XS_CODE_GET_PROPERTY as u8,
            1,
            0,
        ];
        let first = machine.relink_unlinked_realm_program(&code).unwrap();
        let second = machine.relink_unlinked_realm_program(&code).unwrap();
        assert_ne!(&first[2..4], &second[2..4]);
        let ordinary = machine
            .realm_symbol(SymbolName::from("\0bytecode-id-1"))
            .unwrap();
        assert_ne!(&first[2..4], ordinary.to_le_bytes().as_slice());
    }

    #[test]
    fn raw_template_admission_preserves_the_reserved_key_space() {
        let mut machine = Interp::new_shared_realm_machine();
        let code = [
            Opcode::XS_CODE_TEMPLATE_CACHE as u8,
            Opcode::XS_CODE_GET_PROPERTY as u8,
            1,
            0,
        ];
        machine.next_symbol_key_id = (machine.symbol_names.len() + PROPERTY_KEY_RESERVE + 1) as u16;
        let before = machine.symbol_names.to_vec();
        assert_eq!(
            machine.relink_unlinked_realm_program(&code),
            Err(Halt::HeapExhausted)
        );
        assert_eq!(machine.symbol_names.as_slice(), before.as_slice());
    }

    #[test]
    fn complete_primordial_graph_admits_freezing() {
        let mut machine = Interp::new_shared_realm_machine();
        assert!(machine
            .stored_unpersistable_row()
            .unwrap()
            .contains("shared Realm"));
        assert!(machine
            .stored_unpersistable_row_at_checkpoint()
            .unwrap()
            .contains("shared Realm"));
        let roots: Vec<_> = machine.intrinsics.values().copied().collect();
        for root in roots {
            assert!(machine.test_integrity_level(&[], root, true).unwrap());
        }
        assert!(!machine
            .test_integrity_level(&[], machine.realm.global_obj, true)
            .unwrap());
    }
}
