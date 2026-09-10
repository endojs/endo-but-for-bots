//! Globals, lexical environments, closure cells, and binding resolution.
use super::*;

impl Interp {
    /// Allocate a property slot for global key `id`, link it into the
    /// global object's property list, and record it in [`Self::global_props`].
    /// Does **not** meter — callers add the allocation metering at the
    /// faithful opcode site. Returns the property slot index.
    pub(super) fn create_global_property(
        &mut self,
        id: u16,
        value: (Kind, Payload),
    ) -> crate::value::SlotIndex {
        let mut prop = Slot::property(id, value.1);
        prop.kind = value.0;
        // Insert at the head of the global object's property list.
        let head = self.slots.get(self.global_obj).next;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(self.global_obj).next = idx;
        self.global_props.insert(id, idx);
        idx
    }

    /// Materialize a new own global property at run time (a hoisted
    /// `var`, or a sloppy assignment creating a global), metering the
    /// allocation exactly where `fxNewSlot`/`fxNewChunk` run:
    /// [`crate::meter::SLOT_ALLOCATION_METERING`] for the property slot
    /// plus the measured [`PROPERTY_CREATE_REMAINDER`] (the property-table
    /// growth and interned-key allocation not yet modeled as individual
    /// slots) — 536 raw total against the pin. Initialized undefined; a
    /// following `SET_VARIABLE` assigns and meters its own built-in step.
    pub(super) fn materialize_global_property(&mut self, id: u16) -> crate::value::SlotIndex {
        self.tick_property_create(id);
        self.create_global_property(id, (Kind::Undefined, Payload::None))
    }

    /// Meter one new own-property allocation: the property `fxNewSlot`
    /// ([`crate::meter::SLOT_ALLOCATION_METERING`]) plus the measured
    /// [`PROPERTY_CREATE_REMAINDER`], 536 raw total against the pin.
    ///
    /// The remainder is dominated by the interned-key `fxFindKey` →
    /// `fxNewSlot`/`fxNewChunk` allocation, which XS pays only for an atom
    /// **missing** its boot name table. A key that is one of XS's boot
    /// default keys (`gxIDStrings` — `toString`, `valueOf`, …) is
    /// pre-interned at machine creation, so creating a property under it
    /// costs only the property slot — measured against the pin as exactly
    /// 256 (the `Test262Error.prototype.toString = …` harness store).
    #[inline]
    pub(super) fn tick_property_create(&mut self, id: u16) {
        self.meter.tick_slot_alloc();
        let name = self.id_name(id);
        if !self.default_keys.contains(name.as_str()) {
            self.meter.tick_raw(PROPERTY_CREATE_REMAINDER);
        }
    }

    /// The pre-discount flat form of [`Self::tick_property_create`], for the
    /// internal materializations (the legacy `caller`/`arguments` own
    /// properties a function define installs through `instance_put`) whose
    /// costs are folded into calibrated cluster constants measured with this
    /// flat charge — discounting them would unbalance those clusters.
    #[inline]
    pub(super) fn tick_property_create_flat(&mut self) {
        self.meter.tick_slot_alloc();
        self.meter.tick_raw(PROPERTY_CREATE_REMAINDER);
    }

    /// `fxRunEvalEnvironment`'s global-hoist branch: each declared
    /// top-level `var` (a `NEW_LOCAL` name) becomes an own property of
    /// the global object. Materialize each not-yet-present name's global
    /// property in declaration order, metering the allocation. Idempotent
    /// across a re-declared name (its property is created once).
    pub(super) fn hoist_vars_to_global(&mut self) -> Result<(), Slot> {
        // Declaration order = the `locals` index the name maps to.
        let mut names: Vec<(usize, u16)> = self.id_map.iter().map(|(&id, &i)| (i, id)).collect();
        names.sort_unstable();
        let direct_variable_env = self.direct_eval_variable_environment();
        for (index, id) in names {
            // GlobalDeclarationInstantiation: a top-level **function**
            // declaration must satisfy `CanDeclareGlobalFunction`, else it is
            // a `TypeError` before any body runs. The compiler hoists a
            // function declaration's local to `null` (its placeholder) and a
            // `var` to `undefined`, so the local's kind here tells the two
            // apart with no source inspection.
            let kind = self.locals.get(index).map(|slot| slot.kind);
            let is_function_declaration = matches!(kind, Some(Kind::Null));
            if let Some(variable_env) = direct_variable_env {
                if self.has_lexical_binding_before(variable_env, id) {
                    return Err(self.internal_error(
                        "SyntaxError",
                        format!("{}: duplicate variable", self.property_debug_name(id)),
                    ));
                }
                if !self.has_function_var_binding(variable_env, id) {
                    self.append_environment_capture(variable_env, id, Slot::undefined());
                }
                continue;
            }
            // A **direct** eval's `var`/function declaration that collides with an
            // enclosing lexical binding — here the realm's global lexical
            // environment, holding the running program's top-level
            // `let`/`const`/`class` — is the direct-eval "duplicate variable"
            // early error, a catchable `SyntaxError` (EvalDeclarationInstantiation
            // step 5.d.ii.2.a.i and the direct-eval scoping). The binding lives on
            // the active declarative environment chain, which a direct eval shares
            // with its caller; an indirect eval runs in a fresh global variable
            // scope that does not see it, so it never raises this — matching XS,
            // which throws only for the direct form.
            if self.direct_eval_hoist && self.has_lexical_env_binding(id) {
                return Err(self.internal_error(
                    "SyntaxError",
                    format!("{}: duplicate variable", self.property_debug_name(id)),
                ));
            }
            if self.global_props.contains_key(&id) {
                if is_function_declaration && !self.can_declare_global_function(id) {
                    return Err(self.internal_error(
                        "TypeError",
                        format!(
                            "{}: global property not configurable and not enumerable or writable",
                            self.property_debug_name(id)
                        ),
                    ));
                }
            } else {
                // The property does not yet exist, so it must be *created* on the
                // global object. Both `CanDeclareGlobalVar` (ECMA-262 9.1.1.4.15)
                // and `CanDeclareGlobalFunction` (9.1.1.4.16) reduce, for an absent
                // name, to `IsExtensible(globalThis)`: a non-extensible global
                // (`Object.preventExtensions(this)`) cannot gain a new binding, so
                // the declaration is a `TypeError` before any body runs. At the
                // top-level program this is unobservable (nothing has run to freeze
                // the global yet); it is reached by an `eval` whose realm already
                // sealed its global. An extensible global (the overwhelming common
                // case) is unaffected, so this never perturbs an existing run.
                if !self.instance_extensible(self.global_obj) {
                    return Err(self.internal_error(
                        "TypeError",
                        format!(
                            "{}: global object not extensible",
                            self.property_debug_name(id)
                        ),
                    ));
                }
                // `CreateGlobalVarBinding` / `CreateGlobalFunctionBinding` take
                // the `D` argument as the new property's **configurable**
                // attribute. GlobalDeclarationInstantiation (a Script) passes
                // `D = false`, so a top-level declaration is non-configurable
                // and `delete globalThis.g` answers `false`;
                // EvalDeclarationInstantiation passes `D = true`, so an eval's
                // global `var` stays deletable. The sloppy implicit global from
                // an unqualified assignment (`x = 1`) is not a declaration at
                // all and is created configurable on the `SET_VARIABLE` path,
                // which does not come through here.
                let property = self.materialize_global_property(id);
                if !self.eval_program_hoist {
                    self.slots.get_mut(property).flag |= XS_DONT_DELETE_FLAG;
                }
            }
        }
        Ok(())
    }

    /// The nearest caller variable environment used by a direct eval inside a
    /// function. The compiler publishes function scopes as declarative
    /// environment instances: a `null` behavior marks the variable environment
    /// and an `undefined` behavior marks lexical/parameter layers. Object
    /// (`with`) environments carry a reference and are skipped.
    pub(super) fn direct_eval_variable_environment(&self) -> Option<crate::value::SlotIndex> {
        if !self.direct_eval_hoist || self.env.kind != Kind::Reference {
            return None;
        }
        let mut env = match self.env.value {
            Payload::Reference(env) => env,
            _ => return None,
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() && self.slots.get(behavior).kind == Kind::Null {
                return Some(env);
            }
            env = self.instance_prototype(env);
        }
        None
    }

    /// Whether a declarative lexical layer between the active environment head
    /// and `variable_env` already binds `id`. EvalDeclarationInstantiation
    /// rejects a `var`/function declaration at that collision, while parameter
    /// and older variable layers below `variable_env` remain valid targets.
    pub(super) fn has_lexical_binding_before(
        &self,
        variable_env: crate::value::SlotIndex,
        id: u16,
    ) -> bool {
        let mut env = match self.env.value {
            Payload::Reference(env) => env,
            _ => return false,
        };
        while !env.is_null() && env != variable_env {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let slot = self.slots.get(behavior);
                if slot.kind != Kind::Reference && self.environment_property(env, id).is_some() {
                    return true;
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// Whether `id` is already published in the current function's variable
    /// environment group. XS's eval-poisoned function layout has the body var
    /// layer first, then parameter bindings, then a second `null` behavior
    /// boundary. Reusing a parameter/body cell is required for `eval('var a =
    /// ...')`; walking beyond the second boundary would incorrectly reuse a
    /// binding captured from an outer function.
    pub(super) fn has_function_var_binding(
        &self,
        variable_env: crate::value::SlotIndex,
        id: u16,
    ) -> bool {
        let mut env = variable_env;
        let mut null_boundaries = 0usize;
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let slot = self.slots.get(behavior);
                if slot.kind != Kind::Reference && self.environment_property(env, id).is_some() {
                    return true;
                }
                if slot.kind == Kind::Null {
                    null_boundaries += 1;
                    if null_boundaries == 2 {
                        return false;
                    }
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// ECMA-262 § 9.1.1.4.16 `CanDeclareGlobalFunction` over this realm's
    /// global object. A name with no existing own global property can always
    /// be declared (the global object is extensible in this model); an
    /// existing property permits redeclaration as a function only if it is
    /// configurable, or a writable-and-enumerable data property. The frozen
    /// primordial value globals (`NaN`/`Infinity`/`undefined`) are none of
    /// these, so `function NaN(){}` is rejected. Accessor globals are not
    /// modeled, so every existing global here is a data property.
    pub(super) fn can_declare_global_function(&self, id: u16) -> bool {
        match self.global_props.get(&id) {
            None => true,
            Some(&prop) => {
                let flag = self.slots.get(prop).flag;
                if flag & XS_DONT_DELETE_FLAG == 0 {
                    return true; // configurable
                }
                let writable = flag & XS_DONT_SET_FLAG == 0;
                let enumerable = flag & XS_DONT_ENUM_FLAG == 0;
                writable && enumerable
            }
        }
    }

    /// Allocate a closure environment instance (`fxNewEnvironmentInstance`,
    /// driven by `function_environment`). Meters
    /// [`FUNCTION_ENVIRONMENT_METERING`]. The environment is a real arena
    /// instance so its captured cells are GC-traced.
    pub(super) fn new_environment(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_raw(FUNCTION_ENVIRONMENT_METERING);
        // `fxNewEnvironmentInstance` allocates the instance plus one
        // internal behavior slot (`XS_ENVIRONMENT_BEHAVIOR`); captured
        // closures (`store`) append after it, and `retrieve` reads them at
        // `env.next.next`. The two-slot cost is folded into
        // [`FUNCTION_DEFINE_METERING`] (calibrated on a function whose
        // `function_environment` runs), so it is not metered again here.
        // A function defined while a `with`/eval environment is active
        // captures it (XS's `FUNCTION_ENVIRONMENT` chains the new closure
        // environment's prototype to the current `mxEnvironment`), so the
        // callee's free names resolve through the enclosing `with` when it
        // runs. Outside any `with` the prototype is `NULL`, exactly as before —
        // the closure environment stays a flat declarative frame and this is
        // byte-identical to the pre-`with` engine.
        let proto = if self.env.kind == Kind::Reference {
            match self.env.value {
                Payload::Reference(r) => r,
                _ => crate::value::SlotIndex::NULL,
            }
        } else {
            crate::value::SlotIndex::NULL
        };
        let env = self.slots.alloc(Slot::instance(proto));
        let behavior = self
            .slots
            .alloc(Slot::of(Kind::Uninitialized, Payload::None));
        self.slots.get_mut(env).next = behavior;
        env
    }

    /// Insert or overwrite an own property `id = value` on `inst` **without**
    /// metering — for intrinsic-supplied properties whose cost is either an
    /// inherited prototype value (unmetered in XS) or already folded into a
    /// measured construct constant.
    pub(super) fn set_own_unmetered(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = value.kind;
            s.value = value.value;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = value;
            prop.id = id;
            prop.flag = 0;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
    }

    /// Variant used by built-ins whose spec-created own property has fixed
    /// attributes (Error `message`/`cause`, prototype methods, and the like).
    pub(super) fn set_own_unmetered_with_flag(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        flag: u8,
    ) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = value.kind;
            s.value = value.value;
            s.flag = flag;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = value;
            prop.id = id;
            prop.flag = flag;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
    }

    /// Insert an own **accessor** property `id = {get, set}` on `inst` with the
    /// standard built-in accessor attributes `{enumerable: false,
    /// configurable: true}`, without metering — the boot-time analog of
    /// [`Self::set_own_unmetered_with_flag`] for a native getter/setter pair.
    /// The property slot carries `XS_GETTER_FLAG|XS_SETTER_FLAG` (its own value
    /// blanked) and the callables live in the `accessors` side table, exactly
    /// the shape `ordinary_get_own_descriptor`/`ordinary_get` and
    /// `getOwnPropertyDescriptor` already consume.
    pub(super) fn set_own_accessor_unmetered(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        get: Option<Slot>,
        set: Option<Slot>,
    ) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        // `{enumerable: false, configurable: true}`: DONT_ENUM set, DONT_DELETE
        // clear. The getter/setter flags mark the slot an accessor.
        let flag = XS_DONT_ENUM_FLAG | XS_GETTER_FLAG | XS_SETTER_FLAG;
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = Kind::Undefined;
            s.value = Payload::None;
            s.flag = flag;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = Slot::undefined();
            prop.id = id;
            prop.flag = flag;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
        self.accessors.insert((inst, id), AccessorData { get, set });
    }

    /// Read a `*_CLOSURE_*`/`retrieve`/`store` opcode's 1-based scope index
    /// operand (`mxEnvironment - index`): a `u8` for the `_1` variant, a
    /// little-endian `u16` for `_2`.
    pub(super) fn closure_index(&self, op: Opcode, code: &[u8], pc: usize) -> usize {
        if op.size() == 2 {
            code[pc + 1] as usize
        } else {
            u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize
        }
    }

    /// The shared heap cell a closure scope slot `k` (1-based) indirects
    /// to, or `None` if the slot is out of range or not a closure.
    pub(super) fn closure_cell(&self, k: usize) -> Option<crate::value::SlotIndex> {
        let i = self.local_index(k)?;
        let s = self.locals[i];
        match (s.kind, s.value) {
            (Kind::Closure, Payload::Reference(cell)) => Some(cell),
            _ => None,
        }
    }

    /// Recover the closure-cell mapping encoded by the compiler immediately
    /// after `arguments_sloppy`. Each formal initialization is emitted as
    /// `argument i; var_closure k`; duplicate names reuse `k`, and only their
    /// last occurrence remains mapped by the arguments exotic object.
    pub(super) fn sloppy_argument_cells(
        &self,
        code: &[u8],
        mut pc: usize,
        formal_count: usize,
    ) -> Vec<Option<crate::value::SlotIndex>> {
        // The formal count is decoded from the BEGIN bytecode's u8 operand,
        // so this metadata has at most 255 entries, independent of argc.
        let mut cells = self.reserve_copy_scratch(formal_count);
        cells.resize(formal_count, None);
        let mut pending_argument = None;
        let mut initialized = 0usize;
        while pc < code.len() && initialized < formal_count {
            let Some(op) = Opcode::from_u8(code[pc]) else {
                break;
            };
            let Some(size) = crate::opcode::instruction_len(code, pc) else {
                break;
            };
            match op {
                Opcode::XS_CODE_ARGUMENT => {
                    pending_argument = code.get(pc + 1).copied().map(usize::from);
                }
                Opcode::XS_CODE_VAR_CLOSURE_1 | Opcode::XS_CODE_VAR_CLOSURE_2 => {
                    if let Some(argument) = pending_argument.take() {
                        let k = self.closure_index(op, code, pc);
                        if let Some(cell) = self.closure_cell(k) {
                            for former in &mut cells {
                                if *former == Some(cell) {
                                    *former = None;
                                }
                            }
                            if let Some(mapped) = cells.get_mut(argument) {
                                *mapped = Some(cell);
                            }
                        }
                        initialized += 1;
                    }
                }
                _ => {}
            }
            pc += size;
        }
        cells
    }

    /// Point closure scope slot `k` at a different heap cell (XS's
    /// `slot->value.closure = variable`), preserving the slot's `Closure`
    /// kind and binding id. Used by `reset_closure`/`refresh_closure` to
    /// give a per-iteration `let` binding a fresh cell.
    pub(super) fn repoint_closure(&mut self, k: usize, cell: crate::value::SlotIndex) {
        if let Some(i) = self.local_index(k) {
            self.locals[i].kind = Kind::Closure;
            self.locals[i].value = Payload::Reference(cell);
        }
    }

    /// Write value `v` through closure scope slot `k` into its shared cell
    /// (all closures capturing the binding observe the mutation).
    pub(super) fn write_closure_cell(&mut self, k: usize, v: Slot) {
        if let Some(cell) = self.closure_cell(k) {
            let c = self.slots.get_mut(cell);
            c.kind = v.kind;
            c.value = v.value;
        }
    }

    /// `XS_CODE_RETRIEVE`: import the running function's `k` captured
    /// closures from its closure environment (`functions[cur_func].closures`,
    /// whose stored closures live at `env.next.next` onward) into the frame
    /// scope, copying the closure-kind slots so they point at the same
    /// shared cells. No allocation (the cells already exist).
    pub(super) fn retrieve_closures(&mut self, k: usize) {
        let env = self
            .functions
            .get(&self.cur_func)
            .map(|f| f.closures)
            .unwrap_or(crate::value::SlotIndex::NULL);
        if env.is_null() {
            return;
        }
        // env.next = behavior slot; behavior.next = first stored closure.
        let behavior = self.slots.get(env).next;
        let mut cur = if behavior.is_null() {
            crate::value::SlotIndex::NULL
        } else {
            self.slots.get(behavior).next
        };
        for _ in 0..k {
            if cur.is_null() {
                break;
            }
            let s = self.slots.get(cur);
            let mut copy = Slot::of(s.kind, s.value);
            copy.id = s.id;
            copy.flag = s.flag;
            self.locals.push(copy);
            if s.id != 0 {
                std::rc::Rc::make_mut(&mut self.id_map).insert(s.id, self.locals.len() - 1);
            }
            cur = s.next;
        }
    }

    /// `XS_CODE_STORE`: capture scope closure `k` into the top-of-stack
    /// closure environment, appending a shared-cell reference to the
    /// environment's property list (`fxNewSlot`, metered). The stored slot
    /// keeps the same cell reference, so the captured closure and the
    /// defining frame share one cell.
    pub(super) fn store_closure(&mut self, k: usize) {
        let env = match self.stack.last() {
            Some(&Slot {
                value: Payload::Reference(e),
                ..
            }) => e,
            _ => return,
        };
        let i = match self.local_index(k) {
            Some(i) => i,
            None => return,
        };
        let src = self.locals[i];
        // fxNewSlot for the appended closure slot.
        self.meter.tick_slot_alloc();
        let mut stored = Slot::of(src.kind, src.value);
        stored.id = src.id;
        stored.flag = src.flag;
        let idx = self.slots.alloc(stored);
        // Append to the end of the environment's property chain.
        let mut tail = env;
        loop {
            let next = self.slots.get(tail).next;
            if next.is_null() {
                break;
            }
            tail = next;
        }
        self.slots.get_mut(tail).next = idx;
    }

    /// Append a lexical arrow capture to a function closure environment.
    ///
    /// Arrow captures use the same arena-backed property chain as ordinary
    /// closures, which keeps them visible to the existing snapshot and GC
    /// traversal without adding a parallel side table.
    pub(super) fn append_environment_capture(
        &mut self,
        env: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> crate::value::SlotIndex {
        self.meter.tick_slot_alloc();
        let mut stored = Slot::of(value.kind, value.value);
        stored.id = id;
        let index = self.slots.alloc(stored);

        let mut tail = env;
        loop {
            let next = self.slots.get(tail).next;
            if next.is_null() {
                break;
            }
            tail = next;
        }
        self.slots.get_mut(tail).next = index;
        index
    }

    /// Attach a module binding's shared heap cell to an initializer or
    /// evaluator closure environment. Module initializer/evaluator functions
    /// are compiled independently, but their `retrieve` opcodes must resolve
    /// the same lexical cell for each transfer record.
    pub(super) fn append_module_closure(
        &mut self,
        env: crate::value::SlotIndex,
        id: u16,
        cell: crate::value::SlotIndex,
    ) {
        self.append_environment_capture(env, id, Slot::of(Kind::Closure, Payload::Reference(cell)));
    }

    /// `XS_CODE_BEGIN_SLOPPY`'s `this` binding: an `undefined`/`null` `this`
    /// in a sloppy function frame binds to the realm global. Recorded for
    /// the `this`/method semantics that observe it; the covered call
    /// grammar (plain calls) passes `undefined`.
    /// A top-level script program's `this` binding: the realm global
    /// object (`fxRunProgram` binds the program frame's `this` to the
    /// realm global for a script; only an ES module binds `undefined`, and
    /// modules are structurally skipped). Set once at program entry so a
    /// top-level `this` opcode observes the global rather than the default
    /// `undefined`.
    pub(super) fn bind_program_this(&mut self) {
        self.this_val = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
    }

    /// `fxRunConstructor` (driven by `begin` in a construct frame): allocate
    /// the fresh `this` instance the constructor populates, and bind the
    /// frame's `this` to it. XS reads the prototype from the constructor's
    /// `.prototype` (defaulting to `%Object.prototype%`); the covered grammar
    /// reads only own properties of `this`, so ironhorse allocates the instance
    /// with a null prototype and leaves the intrinsic-prototype wiring to the
    /// object-model stage. Meters the single instance `fxNewSlot`
    /// ([`crate::meter::SLOT_ALLOCATION_METERING`], 256 raw) exactly where
    /// `fxNewHostInstance` allocates it — measured against the pin as the
    /// whole construct overhead over a plain call.
    pub(super) fn run_constructor(&mut self) {
        // `fxRunConstructor` runs `fxBeginHost`/`fxEndHost` around
        // `fxGetPrototypeFromConstructor` and then `fxNewHostInstance`. Beyond
        // the instance `fxNewSlot` ([`crate::meter::SLOT_ALLOCATION_METERING`],
        // 256 raw), the host-frame entry/exit accrues a fixed two code units
        // ([`CONSTRUCTOR_HOST_FRAME_METERING`]) — measured against the pin as
        // exactly the gap between `new f()` and a plain `f()` (131072 raw =
        // 2 × `XS_CODE_METERING`), independent of the constructor's body.
        self.meter.tick_slot_alloc();
        self.meter.tick_raw(CONSTRUCTOR_HOST_FRAME_METERING);
        // The new `this` chains to the constructor's `.prototype`
        // (fxGetPrototypeFromConstructor), defaulting to %Object.prototype% —
        // so `(new F()) instanceof F` holds. Reading the prototype is a
        // property get (unmetered), already folded into the measured cost.
        let proto = self
            .prototype_of(self.target_func)
            .unwrap_or(self.object_proto);
        let inst = self.slots.alloc(Slot::instance(proto));
        self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
    }

    pub(super) fn bind_this_sloppy(&mut self) {
        match self.this_val.kind {
            // `undefined`/`null` bind to the realm global (the sloppy default).
            Kind::Undefined | Kind::Null => {
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
            }
            // A primitive `this` in a sloppy callee is ToObject-boxed to its
            // wrapper object (XS's `fxToInstance`; ECMA-262 OrdinaryCallBindThis
            // step 5 for non-strict code). The wrapped primitive lives in the
            // wrapper side table, while String's exotic indices and length are
            // projected by the ordinary property MOP.
            Kind::Boolean => {
                let inst = self.box_primitive_to_instance(Native::Boolean, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::Integer | Kind::Number => {
                let inst = self.box_primitive_to_instance(Native::Number, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::String => {
                let inst = self.box_primitive_to_instance(Native::String, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::Symbol => {
                let inst = self.box_primitive_to_instance(Native::Symbol, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::BigInt => {
                let inst = self.box_primitive_to_instance(Native::BigInt, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            _ => {}
        }
    }

    /// Allocate a `with`/eval environment instance (XS's
    /// `fxNewEnvironmentInstance`, `xsType.c`). Two slots: an
    /// `XS_INSTANCE_KIND` head carrying `XS_EXOTIC_FLAG`, whose payload
    /// prototype is the prior environment head (`self.env` when it is a
    /// reference, else `NULL`), and a behavior slot (`instance.next`) keyed
    /// [`XS_ENVIRONMENT_BEHAVIOR_ID`] whose kind/value are copied from the
    /// `with` value on top of the stack (a `Reference` for `with(obj)`;
    /// `NULL`/`undefined` for the eval prelude). Meters exactly two
    /// `fxNewSlot` allocations (`2 × SLOT_ALLOCATION_METERING`) — no built-in
    /// step, no prototype-link to `%Object.prototype%` (an environment is not
    /// an ordinary object). Returns the head instance index.
    pub(super) fn new_environment_instance(&mut self, with_value: Slot) -> crate::value::SlotIndex {
        let proto = if self.env.kind == Kind::Reference {
            match self.env.value {
                Payload::Reference(r) => r,
                _ => crate::value::SlotIndex::NULL,
            }
        } else {
            crate::value::SlotIndex::NULL
        };
        // fxNewSlot #1: the instance head.
        let mut head = Slot::instance(proto);
        head.flag = XS_EXOTIC_FLAG;
        let inst = self.slots.alloc(head);
        self.meter.tick_slot_alloc();
        // fxNewSlot #2: the behavior slot, carrying the `with` value.
        let mut behavior = Slot::of(with_value.kind, with_value.value);
        behavior.id = XS_ENVIRONMENT_BEHAVIOR_ID;
        behavior.flag = XS_INTERNAL_FLAG;
        let behavior_idx = self.slots.alloc(behavior);
        self.meter.tick_slot_alloc();
        self.slots.get_mut(inst).next = behavior_idx;
        inst
    }

    /// `fxIsScopableSlot` (`xsRun.c`): is `id` resolvable as a scopable
    /// binding of the `with` object `obj`? True when `obj` **has** the
    /// property (own or inherited) AND it is not blocked by the object's
    /// `@@unscopables` list — `obj[@@unscopables]` being an object whose `id`
    /// property is truthy hides the binding (ECMA-262 9.1.1.2.1). Meters the
    /// host-frame `mxHasID` walk exactly (the calibrated
    /// [`WITH_SCOPABLE_BASE_METERING`] host teardown plus one
    /// `XS_CODE_METERING` per prototype level the `HasProperty` recursion
    /// descends); the `@@unscopables` consultation is charged only on a hit
    /// via [`WITH_UNSCOPABLES_GET_METERING`], matching the extra host `mxGetID`
    /// XS runs only when the property is present.
    ///
    /// Both lookups route through the complete internal-method seam
    /// (`mop_has`/`mop_get`), never the slot-chain-only `instance_*`
    /// helpers: an object environment over a Proxy must observe its `has`
    /// and `get` traps (ECMA-262 `HasBinding` on an Object Environment
    /// Record is `HasProperty` then `Get` of `@@unscopables`), and a
    /// `with` over a membrane is exactly where a chain-only walk would see
    /// through to the target. A trap may throw, so the check is fallible.
    pub(super) fn is_scopable_slot(
        &mut self,
        code: &[u8],
        obj: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        let (present, frames) = self.mop_has_with_recursions(code, obj, id)?;
        self.meter.tick_raw(WITH_SCOPABLE_HAS_METERING);
        self.charge_and_check(frames * ORDINARY_HAS_PROPERTY_FRAME_METERING)?;
        if !present {
            return Ok(false);
        }
        // Consult `obj[@@unscopables]` only when the property is present, as
        // XS does. The well-known symbol's key id is minted on first use; a
        // program that never names `Symbol.unscopables` has no object keyed by
        // it, so `unscopables` is `undefined` and never blocks.
        self.meter.tick_raw(WITH_UNSCOPABLES_GET_METERING);
        if let Some(unscopables_id) = self.well_known_symbol_property_id("unscopables") {
            let receiver = Slot::of(Kind::Reference, Payload::Reference(obj));
            let blocklist = self.mop_get(code, obj, unscopables_id, receiver)?;
            if let Payload::Reference(list) = blocklist.value {
                if blocklist.kind == Kind::Reference {
                    // A further host `mxGetID(id)` on the blocklist object.
                    self.meter.tick_raw(WITH_UNSCOPABLES_BLOCKLIST_GET_METERING);
                    let flag = self.mop_get(code, list, id, blocklist)?;
                    if self.truthy(&flag) {
                        return Ok(false);
                    }
                }
            }
        }
        Ok(true)
    }

    /// Whether `inst` is one of the exotic environment instances allocated by
    /// [`Self::new_environment_instance`]. The reserved behavior slot is the
    /// discriminator, matching XS's `XS_ENVIRONMENT_BEHAVIOR` test.
    pub(super) fn is_environment_instance(&self, inst: crate::value::SlotIndex) -> bool {
        if inst.is_null() {
            return false;
        }
        let behavior = self.slots.get(inst).next;
        !behavior.is_null() && self.slots.get(behavior).id == XS_ENVIRONMENT_BEHAVIOR_ID
    }

    /// Find an id-keyed property published on a closure environment. The
    /// behavior slot itself is internal; published closure cells begin at its
    /// `next`, exactly as `fxEnvironmentHasProperty`/`GetProperty` walk them.
    pub(super) fn environment_property(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<crate::value::SlotIndex> {
        if id == 0 || !self.is_environment_instance(inst) {
            return None;
        }
        let behavior = self.slots.get(inst).next;
        let mut property = self.slots.get(behavior).next;
        while !property.is_null() {
            let slot = self.slots.get(property);
            if slot.id == id {
                return Some(property);
            }
            property = slot.next;
        }
        None
    }

    /// `fxEnvironmentGetProperty`: return the published value, dereferencing a
    /// closure-kind property through its shared heap cell. `None` denotes an
    /// uninitialized cell (TDZ) or a missing property; resolution guarantees
    /// the latter cannot normally reach this point.
    pub(super) fn environment_get(&self, inst: crate::value::SlotIndex, id: u16) -> Option<Slot> {
        let property = self.environment_property(inst, id)?;
        let slot = self.slots.get(property);
        let value = if slot.kind == Kind::Closure {
            match slot.value {
                Payload::Reference(cell) => self.slots.get(cell),
                _ => return None,
            }
        } else {
            slot
        };
        (value.kind != Kind::Uninitialized).then(|| Slot::of(value.kind, value.value))
    }

    /// `fxEnvironmentSetProperty`: write through a published closure cell so
    /// every capturer observes the assignment, retaining TDZ and const guards.
    pub(super) fn environment_set(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> EnvironmentSet {
        let Some(property) = self.environment_property(inst, id) else {
            return EnvironmentSet::Missing;
        };
        let property_slot = self.slots.get(property);
        let target = if property_slot.kind == Kind::Closure {
            match property_slot.value {
                Payload::Reference(cell) => cell,
                _ => return EnvironmentSet::Missing,
            }
        } else {
            property
        };
        let slot = self.slots.get_mut(target);
        if slot.kind == Kind::Uninitialized {
            return EnvironmentSet::Uninitialized;
        }
        if slot.flag & XS_DONT_SET_FLAG != 0 {
            return EnvironmentSet::Const;
        }
        slot.kind = value.kind;
        slot.value = value.value;
        EnvironmentSet::Written
    }

    /// Walk the active `with`/eval environment chain (XS's
    /// `XS_CODE_EVAL_REFERENCE`/`PROGRAM_REFERENCE` `mxEnvironment` walk),
    /// returning the object a variable read/write of `name` should resolve
    /// against, or `None` when no active environment binds it (the caller then
    /// falls through to the frame scope / global object, byte-identically to
    /// the pre-`with` engine). Only **object** environments (a `with(obj)`
    /// behavior slot holding a `Reference`) are consulted with
    /// [`Self::is_scopable_slot`]. A declarative/closure environment (a
    /// null/undefined behavior slot) uses its exotic id-keyed HasProperty walk
    /// and resolves to the environment instance itself. Returns `None`
    /// immediately — and meters
    /// nothing — when no environment is active, preserving the empty-chain
    /// dispatch cost exactly. Fallible because a `with` object's `has` or
    /// `@@unscopables` lookup may run a Proxy trap or accessor that throws.
    pub(super) fn resolve_env_reference(
        &mut self,
        code: &[u8],
        name: u16,
    ) -> Result<Option<crate::value::SlotIndex>, Step> {
        if self.env.kind != Kind::Reference {
            return Ok(None);
        }
        let mut env = match self.env.value {
            Payload::Reference(r) => r,
            _ => return Ok(None),
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let beh = self.slots.get(behavior);
                if beh.kind == Kind::Reference {
                    if let Payload::Reference(obj) = beh.value {
                        if self.is_scopable_slot(code, obj, name)? {
                            return Ok(Some(obj));
                        }
                    }
                } else if self.environment_property(env, name).is_some() {
                    // `mxBehaviorHasProperty` on an environment instance is a
                    // direct id walk with no allocation or metering.
                    return Ok(Some(env));
                }
            }
            env = self.instance_prototype(env);
        }
        Ok(None)
    }

    /// Whether `name` is bound by a **declarative/closure** environment on the
    /// active chain — a lexical (`let`/`const`/`class`) binding, as opposed to a
    /// `with(obj)` object environment (whose behavior slot holds a `Reference`)
    /// or the frame scope / global object. Used by declaration instantiation to
    /// detect a direct eval's `var`/function colliding with an enclosing lexical
    /// binding (the direct-eval "duplicate variable" `SyntaxError`). Read-only
    /// and unmetered: a pure id walk over the same chain
    /// [`Self::resolve_env_reference`] consults, restricted to its
    /// declarative-environment arm.
    pub(super) fn has_lexical_env_binding(&self, name: u16) -> bool {
        if self.env.kind != Kind::Reference {
            return false;
        }
        let mut env = match self.env.value {
            Payload::Reference(r) => r,
            _ => return false,
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let beh = self.slots.get(behavior);
                // A `with(obj)` environment carries the object in its behavior
                // slot as a `Reference`; only a declarative/closure environment
                // (a null/undefined behavior) publishes lexical closure cells.
                if beh.kind != Kind::Reference && self.environment_property(env, name).is_some() {
                    return true;
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// Read a `*_LOCAL_*` opcode's 1-based scope-index operand: a `u8` for
    /// the `_1` variant (`size == 2`), a little-endian `u16` for `_2`
    /// (`size == 3`) — the wide-index form the compiler emits once a frame
    /// declares more than 255 scope slots (XS's `mxRunU1`/`mxRunU2`).
    #[inline]
    pub(super) fn local_operand(&self, op: Opcode, code: &[u8], pc: usize) -> usize {
        if op.size() == 3 {
            u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize
        } else {
            code[pc + 1] as usize
        }
    }

    /// Address a 1-based scope index `k` (XS's `mxEnvironment - index`).
    #[inline]
    pub(super) fn local_index(&self, k: usize) -> Option<usize> {
        if k == 0 || k > self.locals.len() {
            None
        } else {
            Some(k - 1)
        }
    }

    /// Read scope slot `k`; `None` if it is still uninitialized (a TDZ
    /// read) or the index is out of range.
    pub(super) fn get_local(&self, k: usize) -> Option<Slot> {
        let i = self.local_index(k)?;
        let s = self.locals[i];
        if s.kind == Kind::Uninitialized {
            None
        } else {
            Some(s)
        }
    }

    /// Write scope slot `k` from a value (kind + payload), mirroring
    /// XS's `variable->kind = ...; variable->value = ...`.
    pub(super) fn set_local(&mut self, k: usize, v: Slot) {
        if let Some(i) = self.local_index(k) {
            self.locals[i].kind = v.kind;
            self.locals[i].value = v.value;
        }
    }

    /// Resolve a name for reading: a frame local when declared (unless
    /// uninitialized), else the global object's property.
    pub(super) fn resolve_get(&self, name: u16) -> Option<Slot> {
        if let Some(&i) = self.id_map.get(&name) {
            let s = self.locals[i];
            // A closure-captured local holds a `Kind::Closure` cell indirection
            // (`store`/`retrieve`), not the value inline. Reached by name only
            // through the `with`/eval reference path (a plain access uses
            // `GET_CLOSURE` by index); dereference the shared cell so the read
            // yields the value, not the cell — TDZ if the cell is uninitialized.
            if s.kind == Kind::Closure {
                if let Payload::Reference(cell) = s.value {
                    let c = self.slots.get(cell);
                    return if c.kind == Kind::Uninitialized {
                        None
                    } else {
                        Some(Slot::of(c.kind, c.value))
                    };
                }
            }
            if s.kind == Kind::Uninitialized {
                None
            } else {
                Some(s)
            }
        } else if let Some(&idx) = self.global_props.get(&name) {
            let p = self.slots.get(idx);
            Some(Slot::of(p.kind, p.value))
        } else {
            None
        }
    }

    /// Resolve a **declared frame local** for writing. A name that is not a
    /// frame local is not this function's business: `SET_VARIABLE` handles the
    /// global arm itself, through the global object's full `[[Set]]`, so that
    /// an accessor or a non-writable descriptor installed reflectively stays
    /// binding-correct. A direct global-slot write here would bypass those
    /// descriptor checks. The caller selects this path only for names in
    /// `id_map`; all other writes must retain the global object's semantics.
    ///
    /// Returns `false` when the binding is an initialized `const` and the write
    /// must raise a TypeError instead. `CONST_LOCAL`/`CONST_CLOSURE` stamp
    /// `XS_DONT_SET_FLAG` on the local slot and on the shared closure cell, and
    /// `SET_LOCAL`/`PULL_LOCAL`/`SET_CLOSURE`/`PULL_CLOSURE` all consult it; a
    /// by-name write reaching here through `with`/eval has to observe the same
    /// guard, or `with ({}) { c = 2 }` silently rewrites a `const`.
    #[must_use]
    pub(super) fn resolve_set(&mut self, name: u16, value: Slot) -> bool {
        if let Some(&i) = self.id_map.get(&name) {
            // A closure-captured local writes through its shared `Kind::Closure`
            // cell (so the mutation is visible to every capturer), mirroring
            // `resolve_get`'s dereference. Reached by name only through the
            // `with`/eval path; a plain write uses `SET_CLOSURE` by index.
            if self.locals[i].kind == Kind::Closure {
                if let Payload::Reference(cell) = self.locals[i].value {
                    if self.slots.get(cell).flag & XS_DONT_SET_FLAG != 0 {
                        return false;
                    }
                    let c = self.slots.get_mut(cell);
                    c.kind = value.kind;
                    c.value = value.value;
                    return true;
                }
            }
            if self.locals[i].flag & XS_DONT_SET_FLAG != 0 {
                return false;
            }
            self.locals[i].kind = value.kind;
            self.locals[i].value = value.value;
        }
        true
    }
}
