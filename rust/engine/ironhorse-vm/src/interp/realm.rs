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
    /// Which intrinsic names may be BOUND as globals in this environment --
    /// the live filter, and the authority: `interp/link.rs` consults exactly
    /// this, at initial linking and at every later relink. `None` binds the
    /// standard set; `Some(list)` binds only those names, plus `globalThis`.
    ///
    /// It is per-environment, and environments DO NOT INHERIT. Each
    /// compartment creates its own environment and `create_environment`
    /// assigns this outright, so a compartment declaring `None` is
    /// unrestricted however narrow the machine's start realm is, and one
    /// declaring a list may name something the start realm omitted
    /// (`tests/realms.rs`). A machine-wide list looks like a ceiling and is
    /// not one.
    ///
    /// The mechanism is the whole of it, and it is small: the binding is
    /// created or it is not. Nothing leaves the intrinsic graph, so every
    /// denied intrinsic stays reachable by any route that is not a bare name
    /// -- `({}).constructor.constructor` still reaches `Function` under
    /// `Some(vec![])`. This is not SES's `permits.js`, which governs which
    /// PROPERTIES of intrinsics survive lockdown and is enforced by deletion.
    pub(super) global_names: Option<std::collections::BTreeSet<SymbolName>>,
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
            global_names: None,
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

    /// Perform the freeze [`Self::new_shared_realm_machine_configured`] skipped.
    /// Idempotent: a graph already locked down is left alone, as `fx_lockdown`
    /// is NOT (it throws `TypeError("lockdown already called")`,
    /// `xsLockdown.c:90-92`) -- this is the embedder's operation, not the
    /// guest's, and an embedder that cannot tell is the one calling it twice.
    ///
    /// NOT atomic. The roots are hardened in sequence, so a refusal partway
    /// through returns `Err` with the earlier roots already frozen while
    /// `locked_down` stays false -- that flag reporting false does not mean
    /// the graph is still fully mutable. Retrying is the supported recovery,
    /// and completes the freeze.
    pub(crate) fn lock_down_intrinsics(&mut self) -> Result<(), crate::Halt> {
        if self.realm.intrinsics().locked_down.get() {
            return Ok(());
        }
        let roots = self.realm.intrinsics().roots.clone();
        for root in roots {
            // Unlike the construction-time freeze this can legitimately fail:
            // the graph has been reachable by a guest, which may have made an
            // intrinsic non-extensible or installed a Proxy that refuses the
            // definition. `do_harden` rolls its own worklist back on the way
            // out, so no SINGLE root is left partly frozen -- but the roots
            // are hardened one at a time, so a refusal at root `k` returns
            // with roots `0..k` already transitively frozen and `locked_down`
            // still false. A later successful call completes the freeze: the
            // roots already done are idempotent no-ops on the retry.
            self.do_harden(&[], Slot::of(Kind::Reference, Payload::Reference(root)))
                .map_err(|step| match step {
                    Step::Host(halt) => halt,
                    _ => crate::Halt::Refused("lockdown:intrinsic-graph"),
                })?;
        }
        self.realm.intrinsics().locked_down.set(true);
        Ok(())
    }

    /// The guest `lockdown()` (`fx_lockdown`, `xsLockdown.c:74-205`), bound by
    /// [`Self::create_hardened_globals`] as [`NativeMethod::GlobalLockdown`].
    ///
    /// Three of `fx_lockdown`'s five steps, in XS's order. The two that are
    /// absent presuppose a guest `Compartment`, which ironhorse does not have:
    /// the compartment-global template (`:105-119`, `:139`) and the `Math`
    /// duplicate that is pulled into it (`:130-137`). `Date`'s half of step 4
    /// survives as `Date.prototype.constructor`, which step 2 below covers;
    /// `Math.random` is not implemented on ironhorse, so there is nothing
    /// there to secure. `designs/ironhorse-native-lockdown.md` § Scope
    /// boundary states both, and what they cost.
    ///
    /// **The direct write is the contract, not the order.** An earlier revision
    /// of this comment said "rewire, then harden" was load-bearing. Mutation
    /// testing refuted it: inverting the two steps changes no observable
    /// behaviour and fails no test. The reason is
    /// [`Self::force_locked_down_constructor`], which assigns the slot rather
    /// than defining the property, so a frozen `Function.prototype` is no
    /// obstacle whenever the write happens.
    ///
    /// The order IS load-bearing for a JS implementation, which is why the
    /// claim was plausible: `do_harden` walks prototype chains, so after any
    /// harden `Function.prototype.constructor` is
    /// `{writable: false, configurable: false}` and `[[DefineOwnProperty]]`
    /// must refuse it -- exactly how the SES shim's `lockdown()` fails on
    /// ironhorse, with `TypeError: invalid descriptor` out of
    /// `tame-function-constructors.js`. XS sidesteps that by writing the slot
    /// (`fx_lockdown_aux`, `:52`), and so does this. `lockdown_still_rewires_a_
    /// prototype_the_guest_has_already_hardened` is the test, and what it
    /// guards is the write path: replace it with an ordinary define and that
    /// test goes red.
    pub(super) fn do_lockdown(&mut self, code: &[u8]) -> Result<Slot, Step> {
        // Step 1, idempotence (`:88-92`). XS throws; the HOST-side
        // [`Self::lock_down_intrinsics`] deliberately does not, because it is
        // the embedder's operation and an embedder that cannot tell whether it
        // has run is the one calling it twice. A guest can tell, so the guest
        // boundary takes XS's answer. The two share one flag and differ only
        // here; `designs/ironhorse-native-lockdown.md` § Decisions, as taken
        // records the split as deliberate.
        if self.realm.intrinsics().locked_down.get() {
            return Err(self.catchable_type_error_msg("lockdown already called".into()));
        }

        // **No compartment check here: neither SES nor XS has one.** An
        // earlier revision refused when
        // `environment.global_obj != realm.global_object()`. That was both
        // unfaithful (SES puts `lockdown` on every global and relies on
        // idempotence) and unsound (it read the AMBIENT environment, which a
        // guest steers by queueing a promise job -- measured
        // `LOCKED AFTER JOB = true`). The invariant now lives in
        // `new_shared_realm_machine_configured`: a machine that can hold
        // compartments is already locked down, so a compartment's call meets
        // step 1 above, and an unfrozen machine does not bind `lockdown` at
        // all.

        // Step 2, poison the function-family constructors (`:94-103`, `:127`).
        // XS calls `fx_lockdown_aux` six times; five of those prototypes exist
        // here (`Compartment.prototype` does not), and the `length` each
        // inert constructor carries is the one the constructor it replaces
        // carried -- 1 for the function family, 7 for `Date`.
        //
        // These are collected rather than hardened inline: they are minted
        // AFTER the root enumeration below took its snapshot, so step 5 would
        // not otherwise reach them, and an inert constructor left mutable
        // would be a writable edge out of a realm that claims to be frozen.
        let mut minted = Vec::new();
        for (prototype, arity) in [
            (self.async_function_proto, 1),
            (self.async_generator_function_proto, 1),
            (self.function_proto, 1),
            (self.generator_function_proto, 1),
            (self.date_proto, 7),
        ] {
            if prototype == crate::value::SlotIndex::NULL {
                continue;
            }
            minted.push((
                prototype,
                self.install_locked_down_constructor(prototype, arity),
            ));
        }

        // Step 5, harden (`:141-200`). XS walks an enumerated list of
        // intrinsics; ironhorse hardens every primordial instance, which is
        // wider, and is the same set
        // [`Self::new_shared_realm_machine_configured`] freezes when it
        // freezes at construction.
        //
        // A shared-realm machine already carries that enumeration in
        // `Intrinsics::roots`. A plain `Interp::new()` machine -- what
        // `endot-ih`, `ironhorse-xst` and the conformance harness run -- does
        // not: `Realm::new` gives it an empty one. Deriving it here from
        // `boot_slot_count` rather than from `slots.capacity()` is the whole
        // difference between "freeze the primordials" and "freeze every object
        // the guest has allocated so far", because by the time a guest calls
        // `lockdown()` the arena is full of guest objects and the
        // construction-time filter no longer discriminates.
        let mut roots = self.realm.intrinsics().roots.clone();
        if roots.is_empty() {
            roots = (0..self.boot_slot_count)
                .map(crate::value::SlotIndex)
                .filter(|&root| root != self.environment.global_obj && root != self.template_cache)
                .filter(|&root| self.slots.get(root).kind == Kind::Instance)
                .collect();
        }
        roots.extend(minted.iter().map(|&(_, inert)| inert));
        for root in roots {
            // Not atomic, exactly as `lock_down_intrinsics` documents: the
            // roots are hardened one at a time, so a refusal at root `k`
            // returns with `0..k` already frozen and `locked_down` still
            // false. A guest that catches this TypeError is holding a realm
            // that is partly frozen AND still reports itself unlocked. XS has
            // the same shape -- its harden calls are a straight-line sequence
            // with no rollback -- so this is fidelity rather than an
            // oversight, and calling `lockdown()` again completes the freeze
            // because a hardened root is idempotent on the retry.
            self.do_harden(code, Slot::of(Kind::Reference, Payload::Reference(root)))?;
        }

        // Re-assert step 2 after step 5, because step 5 can run GUEST CODE.
        //
        // `do_harden` walks the roots through the MOP -- `mop_prevent_extensions`,
        // `mop_own_keys`, `mop_get_own_property_read` -- and every one of those
        // enters a Proxy trap. A guest that hangs a proxy off a root hardened
        // EARLY (`Object.prototype` is the lowest-indexed one) gets its trap
        // called while `Function.prototype` is still writable, and
        // `Object.defineProperty(Function.prototype, 'constructor', {value: Function})`
        // from inside that trap puts the real evaluator back. `lockdown()` then
        // completes, reports success, and leaves the reach open permanently --
        // measured, before this loop existed, as
        // `lockdown=returned undefined | reach=returned 2`.
        //
        // The re-assert closes the window rather than trying to police it: no
        // ordering of steps 2 and 5 can help, because the guest code runs
        // BETWEEN them by construction. `set_own_unmetered_with_flag` ignores
        // the descriptor it overwrites, so this works on the now-frozen
        // prototype and is idempotent when nothing interfered -- which is the
        // ordinary case, where it rewrites the same reference over itself.
        //
        // The flag is re-read here, so the property keeps the non-writable,
        // non-configurable shape step 5 just gave it.
        for (prototype, inert) in minted {
            self.force_locked_down_constructor(prototype, inert);
        }
        self.realm.intrinsics().locked_down.set(true);
        Ok(Slot::undefined())
    }

    /// `fx_lockdown_aux` (`xsLockdown.c:52-72`): replace `prototype`'s
    /// `constructor` with an inert stand-in that throws on call AND on
    /// construct, carrying `length` = `arity` and a `prototype` property
    /// pointing back at `prototype`. Returns the instance it minted.
    ///
    /// The write goes through `set_own_unmetered_with_flag`, which overwrites
    /// a property's kind, value and flag without consulting the descriptor it
    /// is replacing. That is deliberate and it is the point of the function:
    /// XS assigns the slot directly (`slot->kind = constructor->kind`),
    /// bypassing `[[DefineOwnProperty]]`, so the step still works on a
    /// prototype a guest has already frozen. Nothing reaches this path except
    /// `lockdown()` itself.
    ///
    /// The existing property's FLAG is preserved, because XS writes only kind
    /// and value. So `Function.prototype.constructor` stays
    /// `{writable: true, enumerable: false, configurable: true}` across the
    /// rewiring and becomes non-writable only when step 5 hardens it -- which
    /// is the order a `verifyProperty` case observes.
    ///
    /// **Except the accessor bits, which must be cleared.** "Preserve the flag"
    /// is the right rule only because of how XS represents an accessor: there
    /// it is `slot->kind == XS_ACCESSOR_KIND` with the getter and setter IN the
    /// slot value, so `fx_lockdown_aux`'s `slot->kind = constructor->kind;
    /// slot->value = constructor->value;` (`xsLockdown.c:65-66`) converts an
    /// accessor into a data property as a side effect of the assignment.
    /// Ironhorse keeps accessorness in the flag byte
    /// (`XS_GETTER_FLAG|XS_SETTER_FLAG`) with the callables in the `accessors`
    /// side table, so preserving the flag verbatim preserves ACCESSORNESS while
    /// writing a data payload underneath -- a slot that reads as a getter and
    /// holds a reference.
    ///
    /// That is not a cosmetic mismatch. `ordinary_get` consults the side table
    /// first, so a guest that runs
    /// `Object.defineProperty(Function.prototype, 'constructor', {get: ...})`
    /// before `lockdown()` keeps its evaluator: the getter still answers, the
    /// inert constructor is never seen, and `lockdown()` returns normally and
    /// reports success. Three lines of setup defeated the entire operation
    /// until adversarial review found it; `lockdown_poisons_an_accessor_constructor`
    /// is the regression test.
    fn install_locked_down_constructor(
        &mut self,
        prototype: crate::value::SlotIndex,
        arity: u32,
    ) -> crate::value::SlotIndex {
        let inert = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.alloc_str_text("");
        self.functions.insert(
            inert,
            FuncInfo {
                native: Some(Native::LockedDownConstructor),
                name_chunk,
                arity,
                ..FuncInfo::default()
            },
        );
        // `ctor_prototype` plus the own `prototype` property are what make an
        // instance answer `instanceof` and `new`; `slot_is_constructor` reads
        // `native.is_some()`, so the entry here is for the prototype lookup
        // rather than for constructability.
        self.ctor_prototype.insert(inert, prototype);
        let prototype_id = self.intern_static_key_unmetered("prototype");
        self.prototype_key_id.get_or_insert(prototype_id);
        // XS_GET_ONLY (`xsAll.h:2126`), the flags `fx_lockdown_aux` passes to
        // `fxNextSlotProperty`.
        self.set_own_unmetered_with_flag(
            inert,
            prototype_id,
            Slot::of(Kind::Reference, Payload::Reference(prototype)),
            XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG,
        );

        self.force_locked_down_constructor(prototype, inert);
        inert
    }

    /// Write `prototype.constructor = inert` through the privileged path,
    /// whatever is currently there. Used to install the stand-in and again
    /// after step 5 has run (and possibly run guest code) -- see the re-assert
    /// loop in [`Self::do_lockdown`].
    ///
    /// The current flag is preserved minus the accessor bits, so the property
    /// keeps whatever writable/enumerable/configurable shape it has at the
    /// moment of the call, and a stale `accessors` row can never outrank the
    /// data value this writes.
    ///
    /// **When the property is ABSENT the default is `0`, not `XS_DONT_ENUM_FLAG`.**
    /// A guest can run `delete Function.prototype.constructor` before
    /// `lockdown()`, and then step 2 CREATES the property rather than
    /// rewriting one. XS reaches that case through
    /// `mxBehaviorSetProperty(..., XS_OWN)` -> `fxOrdinarySetProperty`
    /// (`xsType.c`), whose creation branch allocates with `fxNewSlot`, and a
    /// fresh XS slot carries no flags at all. So XS's re-created `constructor`
    /// is ENUMERABLE, and stays enumerable through step 5 (hardening clears
    /// writable and configurable, not enumerable). Measured against the oracle:
    /// `delete Function.prototype.constructor; lockdown()` leaves
    /// `e=true w=false c=false` on XS. Defaulting to `XS_DONT_ENUM_FLAG` here
    /// gave `e=false` and was a real divergence;
    /// `a_deleted_constructor_is_recreated_enumerable` is the regression test.
    fn force_locked_down_constructor(
        &mut self,
        prototype: crate::value::SlotIndex,
        inert: crate::value::SlotIndex,
    ) {
        let constructor_id = self.intern_static_key_unmetered("constructor");
        self.constructor_id.get_or_insert(constructor_id);
        // **Materialize first, or "absent" means the wrong thing.** Prototype
        // members are installed LAZILY: `boot.rs` records them in
        // `proto_methods`/`proto_data` and
        // [`Self::materialize_intrinsic_own_surface`] installs them on demand,
        // driven from `mop_own_keys`. On a pristine realm nothing has asked for
        // `Function.prototype.constructor` yet, so `find_property` answers
        // `None` for a property that DOES exist in the spec sense and is about
        // to be installed with `XS_DONT_ENUM_FLAG`.
        //
        // Without this call the fallback below fires in the COMMON case rather
        // than the deleted one, and the realm ends up with an ENUMERABLE
        // `constructor` on every function-family prototype. Measured against
        // the oracle before the fix: `Object.keys(Function.prototype)` was
        // `["constructor"]` here against XS's `[]`, `for (k in function(){})`
        // yielded `constructor`, and `Object.assign({}, Function.prototype)`
        // threw where XS returns. That is a worse bug than the one the `0`
        // default was introduced to fix, and it was introduced by fixing it.
        //
        // This is boot work and it refuses a sealed object, so on the
        // post-step-5 re-assert (where the prototype is frozen) it is a no-op —
        // and it must be, because by then the property exists and the flag read
        // finds it.
        self.materialize_intrinsic_own_surface(prototype);
        let flag = self
            .find_property(prototype, constructor_id)
            .map_or(0, |p| self.slots.get(p).flag)
            & !(XS_GETTER_FLAG | XS_SETTER_FLAG);
        self.accessors.remove(&(prototype, constructor_id));
        self.set_own_unmetered_with_flag(
            prototype,
            constructor_id,
            Slot::of(Kind::Reference, Payload::Reference(inert)),
            flag,
        );
    }

    pub(crate) fn realm(&self) -> &std::rc::Rc<Realm> {
        &self.realm
    }

    /// Build the complete intrinsic graph before any guest can observe it.
    /// Program-local symbol operands will be relinked to this machine table.
    pub(crate) fn new_shared_realm_machine() -> Self {
        Self::new_shared_realm_machine_with_global_names(None)
    }

    pub(crate) fn new_shared_realm_machine_with_global_names(
        global_names: Option<&[String]>,
    ) -> Self {
        Self::new_shared_realm_machine_configured(global_names, true)
    }

    /// `freeze = false` builds the shared realm and leaves its intrinsic graph
    /// MUTABLE, for a guest that brings its own `lockdown()` -- the `ses` shim
    /// repairs intrinsics before freezing them, and cannot do that to a graph
    /// already frozen (`tests/ses_boot_intrinsics.rs`). Nothing else differs:
    /// the roots are still enumerated, so [`Self::lock_down_intrinsics`] can
    /// perform the same freeze later, and `Intrinsics::is_locked_down` reports
    /// which state the graph is in.
    ///
    /// The window this opens is real. Until the freeze happens the primordials
    /// are shared and writable, so two compartments of the same machine can
    /// signal through them. A caller that takes this path is responsible for
    /// locking down -- by guest `lockdown()` or by
    /// [`Self::lock_down_intrinsics`] -- before it admits a second
    /// compartment. SES has the same window before its own `lockdown()` and
    /// the same rule about it.
    pub(crate) fn new_shared_realm_machine_configured(
        global_names: Option<&[String]>,
        freeze: bool,
    ) -> Self {
        let mut machine = Self::new();
        machine.set_global_names(global_names);
        // **An unfrozen machine does not bind the engine's `lockdown`.**
        //
        // `freeze == false` means exactly one thing: the host intends the SES
        // shim to lock this realm down, which is why the graph is left mutable
        // (`repairIntrinsics` cannot repair an already-frozen graph). The shim
        // installs its own `globalThis.lockdown` when it evaluates, so the
        // engine's would be overwritten anyway -- and until it is, it is a
        // realm-wide mutation reachable from any compartment of a machine that
        // by construction has not locked down yet.
        //
        // That is the whole of the compartment problem, and this is where it
        // belongs. In SES a compartment DOES see `lockdown` -- `permits.js`
        // lists it in `universalPropertyNames`, "properties of all global
        // objects" -- and it is powerless there only because a compartment
        // cannot exist before lockdown has run, so the call meets the
        // idempotence check. XS has the same shape from the other side:
        // `fx_lockdown` itself builds `mxCompartmentGlobal` (`:139`).
        // A frozen machine reproduces that faithfully, because `locked_down`
        // is already true when its first compartment is made. An unfrozen one
        // cannot, so it does not offer the operation at all.
        //
        // A plain `Interp::new()` -- `endot-ih`, `ironhorse-xst`, the
        // conformance harness, `packages/thixotrope` -- is untouched by this
        // and keeps its guest `lockdown`; it has no compartments to protect it
        // from.
        if !freeze {
            machine.intrinsics.remove("lockdown");
        }
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
        if freeze {
            for &root in &roots {
                machine
                    .do_harden(&[], Slot::of(Kind::Reference, Payload::Reference(root)))
                    .expect("pristine intrinsic graph must admit transitive freezing");
            }
        }
        machine.realm = std::rc::Rc::new(Realm {
            intrinsics: std::rc::Rc::new(crate::Intrinsics {
                roots,
                locked_down: std::cell::Cell::new(freeze),
            }),
            default_global: machine.environment.global_obj,
        });
        machine
            .environment
            .binding_names
            .extend(machine.environment.global_props.keys().copied());
        machine.shared_compartments = true;
        // NO evaluator is pinned to the default global environment.
        //
        // `link_intrinsics` routes every global binding through
        // `compartment_evaluator`, which mints each compartment a copy of
        // `eval` and `Function` homed to its own global. That copy is not the
        // only way to reach an evaluator. The ORIGINAL stays reachable through
        // any object's prototype chain --
        // `({}).constructor.constructor`, `(function(){}).constructor` -- and
        // `%GeneratorFunction%`, `%AsyncFunction%` and
        // `%AsyncGeneratorFunction%` have no global binding at all
        // (`boot.rs:1153`), so they are reachable ONLY that way.
        //
        // A `global_env` set here is therefore observed, not overwritten:
        // `call_native` (`invoke.rs:171`, the switch at `:186`) switches to it before running
        // `create_dynamic_function`. Pinning it to the default global let a
        // compartment compile against the default realm in both directions --
        // `({}).constructor.constructor('return answer')()` read the default
        // `answer` where `Function('return answer')()` read its own, and an
        // assignment in such a body defined its global ON the default realm.
        //
        // Left NULL, `switch_environment` no-ops (`:201-203`) and the dynamic
        // function is created in whichever environment called for it. That is
        // the only answer that is not arbitrary here: compartments share one
        // realm and one frozen intrinsic graph, so a shared evaluator has no
        // realm of its own to belong to. XS instead replaces the
        // function-family prototypes' `.constructor` with a throwing stub
        // (`fx_lockdown_aux`, `xsLockdown.c:52`), which is correct only after
        // a guest calls `lockdown()` -- something ironhorse has no equivalent
        // of, since it freezes at construction.
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
        global_names: Option<std::collections::BTreeSet<SymbolName>>,
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
            realm.global_names = global_names;
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
