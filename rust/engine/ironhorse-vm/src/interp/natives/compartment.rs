//! The guest `Compartment` constructor and its prototype members.
//!
//! `fx_Compartment` (`xsModule.c:2864`), scoped in
//! `designs/ironhorse-guest-compartment.md`. Phase 1 is the non-module
//! surface: construction with `globals`/`globalLexicals`/`modules`/`name`
//! option validation, `evaluate`, and the `globalThis` getter. Module loading
//! (`import`, `importNow`, and real `resolveHook`/`importHook` callables) is
//! phase 2 and is gated on threading a referrer through
//! [`crate::ModuleGraph::resolve`], which takes one argument today.
use super::super::*;

/// The `modules` option's per-entry descriptor keys. An own enumerable entry
/// of `modules` must be an object carrying at least one of these, or
/// construction is a `TypeError` -- which is what
/// `test/Compartment/constructor/modules-types.js` checks with `{}`, `[]` and
/// a key-less `Proxy`, all of which are objects and none of which describe a
/// module.
///
/// The list is the union of the descriptor shapes the corpus exercises and the
/// ones `packages/ses/src/module-load.js` recognizes. Phase 1 validates the
/// shape and stores nothing: the entries are not loadable until phase 2 builds
/// the graph, and accepting a descriptor now that nothing can later resolve
/// would be worse than refusing it.
const MODULE_DESCRIPTOR_KEYS: [&str; 6] = [
    "source",
    "namespace",
    "record",
    "specifier",
    "compartment",
    "archive",
];

impl Interp {
    /// `new Compartment(options)`.
    ///
    /// **Arity, not value, decides whether options were supplied.**
    /// `new Compartment()` is the default compartment; `new Compartment(undefined)`
    /// is a `TypeError`, as are `null`, a boolean, a number, a string and a
    /// symbol. `test/Compartment/constructor/options-type.js` pins exactly
    /// that pair, so this reads `argc` rather than testing `arg0` for
    /// `undefined`.
    ///
    /// Each recognized option is read by PRESENCE
    /// ([`Self::mop_has`]), not by truthiness: `{ globals: undefined }` is a
    /// `TypeError` while `{}` is not (`constructor/globals-types.js`). That is
    /// the same discrimination `Error`'s `cause` option gets.
    ///
    /// Metering is allocation-driven -- one `tick_slot_alloc` per slot this
    /// actually allocates -- rather than a calibrated frame constant. XS's own
    /// compartment path is not oracle-measured here, so inventing a constant in
    /// `ironhorse-meter` would assert a calibration nobody performed; the
    /// divergence is recorded rather than papered over.
    pub(in crate::interp) fn construct_compartment(
        &mut self,
        code: &[u8],
        argc: usize,
        options: Slot,
    ) -> Result<Slot, Step> {
        let options = if argc == 0 {
            None
        } else {
            match options.value {
                Payload::Reference(inst) if options.kind == Kind::Reference => Some(inst),
                _ => {
                    return Err(self.catchable_type_error_msg(
                        "new Compartment: options is not an object".into(),
                    ))
                }
            }
        };

        // Read every option in the CALLING environment, before the new one
        // exists: an endowment getter is guest code and must run where the
        // guest that supplied it lives, and a `TypeError` from a later option
        // must not leave a half-built environment behind.
        let mut endowments: Vec<(u16, Slot)> = Vec::new();
        let mut lexicals: Vec<(u16, Slot, bool)> = Vec::new();
        if let Some(inst) = options {
            if let Some(globals) = self.compartment_option_object(code, inst, "globals")? {
                endowments = self.compartment_own_enumerable(code, globals)?;
            }
            if let Some(lexical) = self.compartment_option_object(code, inst, "globalLexicals")? {
                lexicals = self.compartment_own_enumerable_writable(code, lexical)?;
            }
            if let Some(modules) = self.compartment_option_object(code, inst, "modules")? {
                self.assert_module_map(code, modules)?;
            }
            // `name` is read and discarded in phase 1: the option is observable
            // as read (a getter runs) but ironhorse has no guest-visible
            // compartment name. `CompartmentOptions::name` is the host-side
            // home for it.
            let name_id = self.intern_static_key_unmetered("name");
            if self.mop_has(code, inst, name_id)? {
                let this = Slot::of(Kind::Reference, Payload::Reference(inst));
                let _ = self.mop_get(code, inst, name_id, this)?;
            }
        }
        // Phase 1 has no lexical scope to bind these into. Validated above and
        // dropped here rather than silently honoured-in-part: a compartment
        // that accepted `globalLexicals` and then resolved none of them would
        // read as working.
        let _ = lexicals;

        let previous = self.current_environment_id();
        // A machine with a guest compartment IS a machine whose compartments
        // share one realm, whatever built it. `Machine` sets this at
        // construction (`new_shared_realm_machine_configured`); a default
        // `Interp::new()` could not have had a compartment before this
        // constructor existed, and now can. Setting it is what makes
        // `compartment_evaluator` mint this environment its own `eval`,
        // `Function` and `Compartment` -- which
        // `prototype/globalThis/defaults.js` observes by identity.
        self.shared_compartments = true;
        let lease = std::rc::Rc::new(());
        let modules = std::rc::Rc::new(std::cell::RefCell::new(crate::ModuleGraph::default()));
        // `global_names: None` -- the standard set. A guest compartment has no
        // way to name a narrower list, and `global_names` is not attenuation
        // in any case (see `CompartmentEnvironment::global_names`).
        let global = self
            .create_environment(None, std::rc::Rc::downgrade(&lease), modules)
            .map_err(Step::Host)?;
        // `create_environment` leaves the NEW environment active. Everything
        // below that touches the compartment's globals must happen here, and
        // the switch back must happen on every path out.
        let result = (|vm: &mut Self| -> Result<(), Step> {
            vm.meter.tick_slot_alloc(); // the compartment's global object
            vm.inherit_compiler(previous);
            for (id, value) in endowments {
                vm.meter.tick_slot_alloc(); // the global property
                if !vm.define_global_id(id, value) {
                    return Err(vm.catchable_type_error_msg(
                        "new Compartment: global definition rejected".into(),
                    ));
                }
            }
            Ok(())
        })(self);
        self.switch_environment(previous);
        result?;

        self.meter.tick_slot_alloc(); // the instance
        let instance = self.slots.alloc(Slot::instance(self.compartment_proto));
        self.guest_compartments
            .insert(instance, GuestCompartmentData { global, lease });
        Ok(Slot::of(Kind::Reference, Payload::Reference(instance)))
    }

    /// Give a freshly created compartment the calling environment's compiler,
    /// so `evaluate` inside it reaches the same source-compilation service the
    /// guest that created it was running under.
    ///
    /// Without this a guest compartment's `evaluate` is
    /// `Halt::NotImplemented("eval:no-compiler")` -- a host-shaped refusal for
    /// a purely guest-side operation. The host `Compartment` API installs a
    /// compiler explicitly (`Compartment::set_source_compiler`); a guest
    /// compartment has no embedder to ask, so it inherits.
    fn inherit_compiler(&mut self, previous: crate::value::SlotIndex) {
        let inherited = self.environment_context_mut(previous).and_then(|env| {
            env.source_compiler
                .as_ref()
                .map(std::rc::Rc::downgrade)
                .or_else(|| env.shared_compiler.clone())
        });
        if let Some(compiler) = inherited {
            self.environment.compiler_required = true;
            self.environment.shared_compiler = Some(compiler);
        }
    }

    /// Read one option by presence and require it to be an object.
    ///
    /// `Ok(None)` means the key is absent, which is always allowed;
    /// `Ok(Some(inst))` is the object. A present non-object -- `undefined`
    /// included -- is a `TypeError`.
    fn compartment_option_object(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
    ) -> Result<Option<crate::value::SlotIndex>, Step> {
        let id = self.intern_static_key_unmetered(name);
        if !self.mop_has(code, options, id)? {
            return Ok(None);
        }
        let this = Slot::of(Kind::Reference, Payload::Reference(options));
        let value = self.mop_get(code, options, id, this)?;
        match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => Ok(Some(inst)),
            _ => {
                Err(self
                    .catchable_type_error_msg(format!("new Compartment: {name} is not an object")))
            }
        }
    }

    /// The own enumerable STRING-keyed properties of an option object, read
    /// once each, in own-key order.
    ///
    /// Inherited, non-enumerable and symbol-keyed properties are never read --
    /// `constructor/globals-properties.js` counts exactly that with its
    /// `neverCount`, using a prototype accessor, a non-enumerable accessor and
    /// a `Symbol()` key. A getter among the copied keys runs ONCE per
    /// compartment (`getterCount === 2` across two constructions), and the
    /// source object's setter never runs (`setterCount === 0`) because the
    /// value is copied into the new global rather than aliased.
    fn compartment_own_enumerable(
        &mut self,
        code: &[u8],
        source: crate::value::SlotIndex,
    ) -> Result<Vec<(u16, Slot)>, Step> {
        let mut out = Vec::new();
        for key in self.mop_own_keys(code, source)? {
            if key.kind == Kind::Symbol {
                continue;
            }
            let read = self.to_read_key(code, key)?;
            let Some(descriptor) = self.mop_get_own_property_read(code, source, read)? else {
                continue;
            };
            if descriptor.enumerable != Some(true) {
                continue;
            }
            let read = self.refresh_read_key(read);
            let this = Slot::of(Kind::Reference, Payload::Reference(source));
            let value = self.mop_get_read(code, source, read, this)?;
            let read = self.refresh_read_key(read);
            let id = self.read_key_intern(read)?;
            out.push((id, value));
        }
        Ok(out)
    }

    /// As [`Self::compartment_own_enumerable`], plus each name's writability
    /// taken from the source descriptor -- `fx_Compartment`'s `globalLexicals`
    /// reading (`xsModule.c:3030`), where a non-writable source property
    /// becomes a `const` binding in the compartment.
    ///
    /// An accessor property is writable when it has a setter. The VALUE is
    /// still the getter's result, read once, so the compartment's copy is a
    /// plain binding and not a live alias.
    fn compartment_own_enumerable_writable(
        &mut self,
        code: &[u8],
        source: crate::value::SlotIndex,
    ) -> Result<Vec<(u16, Slot, bool)>, Step> {
        let mut out = Vec::new();
        for key in self.mop_own_keys(code, source)? {
            if key.kind == Kind::Symbol {
                continue;
            }
            let read = self.to_read_key(code, key)?;
            let Some(descriptor) = self.mop_get_own_property_read(code, source, read)? else {
                continue;
            };
            if descriptor.enumerable != Some(true) {
                continue;
            }
            let writable = if descriptor.is_accessor() {
                descriptor.set.is_some()
            } else {
                descriptor.writable == Some(true)
            };
            let read = self.refresh_read_key(read);
            let this = Slot::of(Kind::Reference, Payload::Reference(source));
            let value = self.mop_get_read(code, source, read, this)?;
            let read = self.refresh_read_key(read);
            let id = self.read_key_intern(read)?;
            out.push((id, value, writable));
        }
        Ok(out)
    }

    /// Every own enumerable entry of the `modules` option must describe a
    /// module. See [`MODULE_DESCRIPTOR_KEYS`].
    fn assert_module_map(
        &mut self,
        code: &[u8],
        modules: crate::value::SlotIndex,
    ) -> Result<(), Step> {
        for key in self.mop_own_keys(code, modules)? {
            if key.kind == Kind::Symbol {
                continue;
            }
            let read = self.to_read_key(code, key)?;
            let Some(descriptor) = self.mop_get_own_property_read(code, modules, read)? else {
                continue;
            };
            if descriptor.enumerable != Some(true) {
                continue;
            }
            let read = self.refresh_read_key(read);
            let this = Slot::of(Kind::Reference, Payload::Reference(modules));
            let value = self.mop_get_read(code, modules, read, this)?;
            let entry = match value.value {
                Payload::Reference(inst) if value.kind == Kind::Reference => inst,
                _ => {
                    return Err(self.catchable_type_error_msg(
                        "new Compartment: module descriptor is not an object".into(),
                    ))
                }
            };
            let mut recognized = false;
            for name in MODULE_DESCRIPTOR_KEYS {
                let id = self.intern_static_key_unmetered(name);
                if self.mop_has(code, entry, id)? {
                    recognized = true;
                    break;
                }
            }
            if !recognized {
                return Err(self.catchable_type_error_msg(
                    "new Compartment: unrecognized module descriptor".into(),
                ));
            }
        }
        Ok(())
    }

    /// The branded receiver of a `Compartment.prototype` member, or a
    /// `TypeError`.
    ///
    /// Membership in [`Interp::guest_compartments`] is the brand, exactly as
    /// `collections` brands a `Map`. Duck-typing would let
    /// `Compartment.prototype.evaluate.call({})` reach the environment switch.
    fn compartment_of(
        &mut self,
        this: Slot,
        member: &'static str,
    ) -> Result<crate::value::SlotIndex, Step> {
        match this.value {
            Payload::Reference(inst)
                if this.kind == Kind::Reference && self.guest_compartments.contains_key(&inst) =>
            {
                Ok(inst)
            }
            _ => Err(self.catchable_type_error_msg(format!(
                "Compartment.prototype.{member}: not a compartment"
            ))),
        }
    }

    /// `get Compartment.prototype.globalThis`.
    pub(in crate::interp) fn compartment_global_this(&mut self, this: Slot) -> Result<Slot, Step> {
        let instance = self.compartment_of(this, "globalThis")?;
        let global = self.guest_compartments[&instance].global;
        Ok(Slot::of(Kind::Reference, Payload::Reference(global)))
    }

    /// `Compartment.prototype.evaluate(source)`: compile and run `source` as a
    /// Script in the receiver's environment.
    ///
    /// The environment is switched for the duration and restored on BOTH
    /// paths, so a guest exception surfaces in the calling compartment with
    /// its own environment intact. A non-string argument is coerced, as
    /// `eval`'s is not -- `evaluate` is not `eval`, and XS coerces.
    pub(in crate::interp) fn compartment_evaluate(
        &mut self,
        code: &[u8],
        this: Slot,
        source: Slot,
    ) -> Result<Slot, Step> {
        let instance = self.compartment_of(this, "evaluate")?;
        let global = self.guest_compartments[&instance].global;
        let units = self.to_string_units(code, source)?;
        let previous = self.current_environment_id();
        self.activate_environment(global).map_err(Step::Host)?;
        // Compartment source is always strict: `fxPrepareCompartmentFunction`
        // compiles the compartment's evaluators in strict mode, and every
        // corpus case that reaches `evaluate` is `onlyStrict`.
        let result = self.eval_source(&units, true);
        self.switch_environment(previous);
        result
    }
}
