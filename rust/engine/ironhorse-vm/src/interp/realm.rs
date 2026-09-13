//! The single Realm and the machine's compartment environments.
use super::*;

/// The machine's single Realm: shared primordials and its default environment.
/// The default environment is also the start compartment's environment.
pub struct Realm {
    intrinsics: std::rc::Rc<crate::Intrinsics>,
    default_global: crate::SlotIndex,
}
impl Realm {
    pub(super) fn new(default_global: crate::SlotIndex) -> Self {
        Self {
            intrinsics: Default::default(),
            default_global,
        }
    }
    pub fn intrinsics(&self) -> &std::rc::Rc<crate::Intrinsics> {
        &self.intrinsics
    }
    pub fn global_object(&self) -> crate::SlotIndex {
        self.default_global
    }
}

/// A global environment and its host evaluation policy within an interpreter.
/// Heap coordinates and property-key identities belong to the owning machine.
pub struct CompartmentEnvironment {
    pub(super) global_obj: crate::value::SlotIndex,
    pub(super) modules: std::rc::Rc<std::cell::RefCell<crate::ModuleGraph>>,
    pub(super) binding_names: std::collections::BTreeSet<u16>,
    pub(super) global_props: std::collections::HashMap<u16, crate::value::SlotIndex>,
    pub(super) owner: Option<std::rc::Weak<()>>,
    pub(super) intrinsic_permit: Option<std::collections::BTreeSet<SymbolName>>,
    pub(super) unhandled_rejection: Option<crate::value::SlotIndex>,
    pub(super) compiler_required: bool,
    pub(super) shared_compiler: Option<std::rc::Weak<dyn SourceCompiler>>,
    pub(super) source_compiler: Option<std::rc::Rc<dyn SourceCompiler>>,
}

impl CompartmentEnvironment {
    pub(super) fn new(global_obj: crate::value::SlotIndex) -> Self {
        Self {
            global_obj,
            global_props: Default::default(),
            binding_names: Default::default(),
            modules: Default::default(),
            source_compiler: None,
            shared_compiler: None,
            compiler_required: false,
            intrinsic_permit: None,
            owner: None,
            unhandled_rejection: None,
        }
    }
}

impl Interp {
    pub(crate) fn set_default_compiler(&mut self, compiler: &std::rc::Rc<dyn SourceCompiler>) {
        self.environment_context_mut(self.realm.global_object())
            .unwrap()
            .compiler_required = true;
        self.environment_context_mut(self.realm.global_object())
            .expect("default environment")
            .shared_compiler = Some(std::rc::Rc::downgrade(compiler));
    }

    pub(crate) fn set_shared_compiler(&mut self, compiler: &std::rc::Rc<dyn SourceCompiler>) {
        self.environment.compiler_required = true;
        self.environment.shared_compiler = Some(std::rc::Rc::downgrade(compiler));
    }

    pub(super) fn compartment_evaluator(&mut self, original: crate::SlotIndex) -> crate::SlotIndex {
        let Some(mut info) = self.functions.get(&original).cloned() else {
            return original;
        };
        if !self.shared_compartments
            || !matches!(info.native, Some(Native::Eval | Native::Function))
        {
            return original;
        }
        info.global_env = self.environment.global_obj;
        let function = self.slots.alloc(Slot::instance(self.function_proto));
        self.functions.insert(function, info);
        if let Some(proto) = self.ctor_prototype.get(&original).copied() {
            self.ctor_prototype.insert(function, proto);
            if let Some(id) = self.prototype_key_id {
                self.set_own_unmetered_with_flag(
                    function,
                    id,
                    Slot::of(Kind::Reference, Payload::Reference(proto)),
                    XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG,
                );
            }
        }
        function
    }

    pub(crate) fn realm(&self) -> &std::rc::Rc<Realm> {
        &self.realm
    }

    /// Build the complete intrinsic graph before any guest can observe it.
    /// Program-local symbol operands will be relinked to this machine table.
    pub(crate) fn new_shared_realm_machine() -> Self {
        Self::new_shared_realm_machine_with_permit(None)
    }

    pub(crate) fn new_shared_realm_machine_with_permit(permit: Option<&[String]>) -> Self {
        let mut machine = Self::new();
        machine.set_intrinsic_permit(permit);
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
            .filter(|&root| {
                root != machine.environment.global_obj && root != machine.template_cache
            })
            .filter(|&root| machine.slots.get(root).kind == Kind::Instance)
            .collect();
        for &root in &roots {
            machine
                .do_harden(&[], Slot::of(Kind::Reference, Payload::Reference(root)))
                .expect("pristine intrinsic graph must admit transitive freezing");
        }
        machine.realm = std::rc::Rc::new(Realm {
            intrinsics: std::rc::Rc::new(crate::Intrinsics {
                roots,
                locked_down: true,
            }),
            default_global: machine.environment.global_obj,
        });
        machine
            .environment
            .binding_names
            .extend(machine.environment.global_props.keys().copied());
        machine.shared_compartments = true;
        for info in machine.functions.values_mut() {
            if matches!(
                info.native,
                Some(
                    Native::Eval
                        | Native::Function
                        | Native::GeneratorFunction
                        | Native::AsyncFunction
                        | Native::AsyncGeneratorFunction
                )
            ) {
                info.global_env = machine.environment.global_obj;
            }
        }
        machine.meter = Meter::new();
        machine
    }
}

impl CompartmentEnvironment {
    /// This realm's actual global object, in its owning machine's arena.
    pub fn global_object(&self) -> crate::value::SlotIndex {
        self.global_obj
    }
}

impl Interp {
    pub(super) fn capture_global_environment(&self) -> crate::SlotIndex {
        if self.shared_compartments {
            self.environment.global_obj
        } else {
            crate::SlotIndex::NULL
        }
    }

    pub(super) fn switch_environment(&mut self, target: crate::SlotIndex) {
        if target.is_null() || target == self.environment.global_obj {
            return;
        }
        let environment = self
            .inactive_environments
            .remove(&target)
            .expect("captured compartment environment must remain reachable");
        let old = std::mem::replace(&mut self.environment, environment);
        self.inactive_environments.insert(old.global_obj, old);
    }

    pub(crate) fn current_environment_id(&self) -> crate::SlotIndex {
        self.environment.global_obj
    }

    pub(crate) fn activate_environment(&mut self, target: crate::SlotIndex) -> Result<(), Halt> {
        self.switch_environment(target);
        Ok(())
    }

    pub(crate) fn create_environment(
        &mut self,
        permit: Option<std::collections::BTreeSet<SymbolName>>,
        owner: std::rc::Weak<()>,
        modules: std::rc::Rc<std::cell::RefCell<crate::ModuleGraph>>,
    ) -> Result<crate::value::SlotIndex, Halt> {
        let previous = self.environment.global_obj;
        let installing = self.installing_intrinsics;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let global = self
                .slots
                .alloc(Slot::instance(crate::value::SlotIndex::NULL));
            let mut realm = CompartmentEnvironment::new(global);
            realm.intrinsic_permit = permit;
            realm.owner = Some(owner);
            realm.modules = modules;
            let old = std::mem::replace(&mut self.environment, realm);
            self.inactive_environments.insert(old.global_obj, old);
            let names = self.symbol_names.to_vec();
            self.install_intrinsic_bindings(&names, 0, false, |_| true);
            self.environment
                .binding_names
                .extend(self.environment.global_props.keys().copied());
            global
        }));
        match result {
            Ok(global) => Ok(global),
            Err(payload) => {
                self.installing_intrinsics = installing;
                let partial = self.environment.global_obj;
                if partial != previous {
                    self.switch_environment(previous);
                    self.inactive_environments.remove(&partial);
                    let evaluators: Vec<_> = self
                        .functions
                        .iter()
                        .filter(|(_, f)| f.global_env == partial)
                        .map(|(id, _)| *id)
                        .collect();
                    for evaluator in evaluators {
                        self.functions.remove(&evaluator);
                        self.ctor_prototype.remove(&evaluator);
                    }
                }
                if payload.is::<crate::value::HeapExhausted>() {
                    Err(Halt::HeapExhausted)
                } else {
                    std::panic::resume_unwind(payload)
                }
            }
        }
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
        self.environment.source_compiler.take()
    }

    pub(crate) fn take_realm_meter(&mut self) -> (Meter, Option<Box<dyn FnMut(u64) -> bool>>) {
        (std::mem::take(&mut self.meter), self.meter_host.take())
    }

    pub(crate) fn environment_symbol(&mut self, name: SymbolName) -> Result<u16, Halt> {
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
                self.environment_symbol(SymbolName::from(format!("\0bytecode-id-{id}")))
                    .ok()
            }
        })
        .ok_or(Halt::Decode(DecodeError::InvalidSymbols))?;
        self.apply_template_site_ids(&mut remapped, site_order, accesses)
            .map_err(|_| Halt::Decode(DecodeError::InvalidSymbols))?;
        Ok(remapped)
    }

    /// Read-only identity inspection; getters and guest coercions never run.
    pub(crate) fn environment_global_identity(
        &self,
        realm: crate::value::SlotIndex,
        name: &str,
    ) -> Option<crate::value::SlotIndex> {
        let realm = if realm == self.environment.global_obj {
            &self.environment
        } else {
            self.inactive_environments.get(&realm)?
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
    /// Host entry abandons the previous failed activation, never queued jobs.
    /// Native reentry remains excluded by the outer Machine borrow.
    pub(crate) fn reap_environments(&mut self) -> Result<(), Halt> {
        if self.gc_failed {
            return Err(Halt::EngineInvariant("gc:previous-collection-failed"));
        }
        self.reset_activation();
        self.identity_roots
            .retain(|_, owner| owner.strong_count() != 0);
        Ok(())
    }

    pub(crate) fn discard_promise_jobs(&mut self) {
        self.reset_activation();
        self.promise_jobs.clear();
        self.pending_rejections.clear();
    }

    pub(crate) fn prepare_collection(&mut self) -> Result<(), Halt> {
        self.reap_environments()?;
        self.switch_environment(self.realm.global_object());
        Ok(())
    }

    pub(crate) fn live_environment_ids(&self) -> std::collections::HashSet<crate::SlotIndex> {
        self.inactive_environments
            .keys()
            .copied()
            .chain(std::iter::once(self.environment.global_obj))
            .collect()
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

    pub(super) fn environment_context_mut(
        &mut self,
        id: crate::SlotIndex,
    ) -> Option<&mut CompartmentEnvironment> {
        if self.environment.global_obj == id {
            Some(&mut self.environment)
        } else {
            self.inactive_environments.get_mut(&id)
        }
    }

    pub(crate) fn rejection_values(&self) -> Vec<(crate::SlotIndex, crate::SlotIndex, Slot)> {
        let mut reports: Vec<_> = std::iter::once(&self.environment)
            .chain(self.inactive_environments.values())
            .filter_map(|environment| {
                environment.unhandled_rejection.map(|promise| {
                    (
                        environment.global_obj,
                        promise,
                        self.promises[&promise].result,
                    )
                })
            })
            .collect();
        reports.sort_by_key(|(environment, _, _)| environment.0);
        reports
    }

    pub(crate) fn acknowledge_rejections(&mut self) {
        self.environment.unhandled_rejection = None;
        for environment in self.inactive_environments.values_mut() {
            environment.unhandled_rejection = None;
        }
    }

    pub(crate) fn root_value(
        &mut self,
        mut value: Slot,
    ) -> Result<(crate::SlotIndex, std::rc::Rc<()>), Halt> {
        value.next = crate::SlotIndex::NULL;
        value.flag = 0;
        value.id = 0;
        let root = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.slots.alloc(value)
        })) {
            Ok(root) => root,
            Err(payload) if payload.is::<crate::value::HeapExhausted>() => {
                return Err(Halt::HeapExhausted)
            }
            Err(payload) => std::panic::resume_unwind(payload),
        };
        let lease = self.pin_identity(root);
        Ok((root, lease))
    }

    pub(crate) fn global_value_root(
        &mut self,
        environment: crate::SlotIndex,
        name: &str,
    ) -> Option<(crate::SlotIndex, std::rc::Rc<()>)> {
        let id = *self.symbol_ids.get(name)?;
        let global = self.environment_context(environment)?.global_obj;
        let prop = self.find_property(global, id)?;
        let value = self.slots.get(prop);
        if value.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            return None;
        }
        self.root_value(value).ok()
    }

    pub(crate) fn rooted_value(&self, root: crate::SlotIndex) -> Slot {
        self.slots.get(root)
    }

    pub(crate) fn environment_context(
        &self,
        id: crate::SlotIndex,
    ) -> Option<&CompartmentEnvironment> {
        if self.environment.global_obj == id {
            Some(&self.environment)
        } else {
            self.inactive_environments.get(&id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_context_associations_are_derived_without_wire_fields() {
        let mut machine = Interp::new();
        let (code, symbols) = ironhorse_compile::compile_atoms("var release; var p = new Promise(r => release = r); async function f(){await p} f(); function* g(){yield 1} var it = g(); 0").unwrap();
        machine.link_intrinsics(&crate::parse_symbols(&symbols));
        assert!(machine.run(&code).completed);
        assert!(machine
            .functions
            .values()
            .all(|function| function.global_env.is_null()));
        assert!(machine
            .promises
            .values()
            .all(|promise| promise.global_env.is_null()));
        let frames: Vec<_> = machine
            .async_instances
            .values()
            .filter_map(|row| row.frame.as_ref())
            .chain(
                machine
                    .generators
                    .values()
                    .filter_map(|row| row.frame.as_ref()),
            )
            .collect();
        assert!(frames.len() >= 2);
        assert!(frames.iter().all(|frame| frame.global_env.is_null()));
        assert!(!machine.shared_compartments);
        assert!(machine.inactive_environments.is_empty());
    }

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
            .environment_symbol(SymbolName::from("\0bytecode-id-1"))
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
        assert_eq!(machine.stored_unpersistable_row(), None);
        assert_eq!(machine.stored_unpersistable_row_at_checkpoint(), None);
        let roots: Vec<_> = machine.intrinsics.values().copied().collect();
        for root in roots {
            assert!(machine.test_integrity_level(&[], root, true).unwrap());
        }
        assert!(!machine
            .test_integrity_level(&[], machine.environment.global_obj, true)
            .unwrap());
    }
}
