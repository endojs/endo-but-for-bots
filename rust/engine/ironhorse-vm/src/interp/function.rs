//! Function identity, prototypes, bound functions, and instance creation.
use super::*;

impl Interp {
    /// The native-method identity of a function instance, if it is one.
    #[inline]
    pub(super) fn method_of(&self, f: crate::value::SlotIndex) -> Option<NativeMethod> {
        self.functions.get(&f).and_then(|fi| fi.method)
    }

    /// The `.prototype` object of a constructor instance, if it is one. A
    /// guest may reassign a plain constructor function's writable own
    /// `prototype` property, so the own slot (when the program names
    /// `prototype` — see [`Self::prototype_key_id`]) outranks the boot-time
    /// [`Self::ctor_prototype`] record; a reassignment to a non-object means
    /// instances chain to `%Object.prototype%` (`fxGetPrototypeFromConstructor`).
    #[inline]
    pub(super) fn prototype_of(
        &self,
        ctor: crate::value::SlotIndex,
    ) -> Option<crate::value::SlotIndex> {
        if let Some(pid) = self.prototype_key_id {
            if let Some(p) = self.find_property(ctor, pid) {
                let s = self.slots.get(p);
                if s.kind == Kind::Reference {
                    if let Payload::Reference(r) = s.value {
                        return Some(r);
                    }
                }
                return None;
            }
        }
        self.ctor_prototype.get(&ctor).copied()
    }

    /// `GetPrototypeFromConstructor(constructor, intrinsicDefaultProto)`:
    /// perform the observable ordinary `Get(constructor, "prototype")`, then
    /// use the intrinsic fallback unless that value is an object. This differs
    /// from [`Self::prototype_of`], which is a non-observable cache lookup used
    /// by internal boot plumbing; native construction must run Proxy/accessor
    /// behavior and propagate abrupt completion.
    pub(super) fn get_prototype_from_constructor(
        &mut self,
        code: &[u8],
        constructor: crate::value::SlotIndex,
        fallback: crate::value::SlotIndex,
    ) -> Result<crate::value::SlotIndex, Step> {
        let id = self.intern_static_key("prototype");
        let receiver = Slot::of(Kind::Reference, Payload::Reference(constructor));
        let value = self.mop_get(code, constructor, id, receiver)?;
        Ok(match value {
            Slot {
                kind: Kind::Reference,
                value: Payload::Reference(prototype),
                ..
            } => prototype,
            _ => fallback,
        })
    }

    /// The `[[Prototype]]` of a derived class's prototype object
    /// (ClassDefinitionEvaluation, XS's `fxRunExtends`). The heritage must be
    /// a constructor — a Proxy or bound function over one included — and its
    /// `prototype`, read with an observable `Get`, must be an object or `null`.
    ///
    /// The previous check accepted any function and read `prototype` from the
    /// property cache, so `class C extends F {}` with `F.prototype = 3` built a
    /// class whose instances silently inherited from nothing, where XS and V8
    /// throw a TypeError, and a Proxy over a constructor was refused.
    pub(super) fn class_heritage_prototype(
        &mut self,
        code: &[u8],
        heritage: Slot,
    ) -> Result<crate::value::SlotIndex, Step> {
        if heritage.kind == Kind::Null {
            return Ok(crate::value::SlotIndex::NULL);
        }
        let constructor = match heritage.value {
            Payload::Reference(constructor)
                if heritage.kind == Kind::Reference && self.slot_is_constructor(constructor) =>
            {
                constructor
            }
            _ => {
                return Err(
                    self.catchable_type_error_msg("extends: class is not a constructor".into())
                )
            }
        };
        let id = self.intern_static_key("prototype");
        match self.mop_get(code, constructor, id, heritage)? {
            Slot {
                kind: Kind::Null, ..
            } => Ok(crate::value::SlotIndex::NULL),
            Slot {
                kind: Kind::Reference,
                value: Payload::Reference(prototype),
                ..
            } => Ok(prototype),
            _ => {
                Err(self
                    .catchable_type_error_msg("extends: class prototype is not an object".into()))
            }
        }
    }

    /// `GetPrototypeFromConstructor(newTarget, …)` for an object a native
    /// constructor creates, when a derived constructor's `super()` or a
    /// `Reflect.construct` names the `new.target`.
    ///
    /// `None` keeps the intrinsic prototype the constructor allocates with.
    /// That is the answer when `newTarget.prototype` is not an object, and the
    /// answer for a direct `new`, whose `new.target` is the native itself: its
    /// `prototype` is a non-writable, non-configurable data property holding
    /// that intrinsic, so the read observes nothing and is skipped, leaving the
    /// meter of every plain `new Map()` as it was.
    ///
    /// The read itself is observable — a getter, or a Proxy `new.target`'s
    /// `get` trap — so call this at the step where the specification and XS's
    /// `fxGetPrototypeFromConstructor` perform it, then give the new object
    /// the prototype with [`Self::adopt_prototype`] once it exists.
    pub(super) fn derived_construct_prototype(
        &mut self,
        code: &[u8],
        new_target: Option<crate::value::SlotIndex>,
        derived: bool,
    ) -> Result<Option<crate::value::SlotIndex>, Step> {
        let Some(target) = new_target.filter(|_| derived) else {
            return Ok(None);
        };
        let id = self.intern_static_key("prototype");
        let receiver = Slot::of(Kind::Reference, Payload::Reference(target));
        Ok(match self.mop_get(code, target, id, receiver)? {
            Slot {
                kind: Kind::Reference,
                value: Payload::Reference(prototype),
                ..
            } => Some(prototype),
            _ => None,
        })
    }

    /// Give a just-created native instance the prototype
    /// [`Self::derived_construct_prototype`] chose, if it chose one. The
    /// instance keeps every internal slot its side tables hold, so a Map
    /// subclass instance is still a Map and an Array subclass instance is
    /// still an exotic Array.
    pub(super) fn adopt_prototype(
        &mut self,
        object: Slot,
        prototype: Option<crate::value::SlotIndex>,
    ) -> Slot {
        if let (Some(prototype), Payload::Reference(instance)) = (prototype, object.value) {
            if object.kind == Kind::Reference {
                self.slots.get_mut(instance).value = Payload::Reference(prototype);
            }
        }
        object
    }

    /// ECMAScript `InstanceofOperator(O, C)`. The right operand must be an
    /// object; its `@@hasInstance` method is read through the full MOP and, if
    /// present, called with `C` as `this` and `O` as its sole argument.
    /// Otherwise `C` must be callable and falls through to
    /// [`Self::ordinary_has_instance`].
    ///
    /// `OrdinaryHasInstance` on a bound function is a tail call of
    /// `InstanceofOperator` on its target (step 2), so a chain of bound
    /// functions with no `@@hasInstance` is walked here as a loop: one tick and
    /// one `@@hasInstance` Get per layer, in the recursion's order (its second
    /// callability check per layer was pure and is not repeated). The walk was
    /// never charged against the native-recursion budget, so a loop keeps
    /// acceptance unchanged while its host stack stays flat at any depth
    /// (STACK-DEPTH-REFACTOR.md B2).
    pub(super) fn instanceof_operator(
        &mut self,
        code: &[u8],
        value: Slot,
        constructor: Slot,
    ) -> Result<bool, Step> {
        let mut constructor = constructor;
        loop {
            let ctor = match constructor.value {
                Payload::Reference(ctor) if constructor.kind == Kind::Reference => ctor,
                _ => {
                    return Err(self.catchable_type_error_msg(
                        match constructor.kind {
                            Kind::Undefined => "cannot coerce undefined to object",
                            Kind::Null => "cannot coerce null to object",
                            _ => "call: not a function",
                        }
                        .into(),
                    ))
                }
            };
            self.meter.tick_raw(INSTANCEOF_METERING);
            let has_instance_id = self
                .well_known_symbol_property_id("hasInstance")
                .expect("well-known hasInstance symbol");
            let method = self.mop_get(code, ctor, has_instance_id, constructor)?;
            if method.kind != Kind::Undefined && method.kind != Kind::Null {
                if !self.is_callable_value(method) {
                    return Err(self.catchable_type_error_msg("call: not a function".into()));
                }
                let result = self.invoke_value(code, method, constructor, &[value])?;
                return Ok(self.truthy(&result));
            }
            if !self.is_callable_value(constructor) {
                return Err(self.catchable_type_error_msg("call: not a function".into()));
            }
            // `ordinary_has_instance`'s own bound step, taken here in place:
            // `constructor` is a callable reference, so its checks before that
            // step pass, and they only read.
            if let Some(target) = self.bound_target(ctor) {
                constructor = Slot::of(Kind::Reference, Payload::Reference(target));
                continue;
            }
            return self.ordinary_has_instance(code, constructor, value);
        }
    }

    /// The `[[BoundTargetFunction]]` of a bound function exotic, `None` for
    /// any other object.
    fn bound_target(&self, ctor: crate::value::SlotIndex) -> Option<crate::value::SlotIndex> {
        self.bound_functions.get(&ctor).map(|bound| bound.target)
    }

    /// ECMAScript `OrdinaryHasInstance(C, O)`, including bound-function
    /// recursion, the primitive-left short circuit, observable `.prototype`
    /// access, and proxy-aware `[[GetPrototypeOf]]` traversal.
    pub(super) fn ordinary_has_instance(
        &mut self,
        code: &[u8],
        constructor: Slot,
        value: Slot,
    ) -> Result<bool, Step> {
        if !self.is_callable_value(constructor) {
            return Ok(false);
        }
        let ctor = match constructor.value {
            Payload::Reference(ctor) => ctor,
            _ => return Ok(false),
        };
        if let Some(target) = self.bound_target(ctor) {
            let target = Slot::of(Kind::Reference, Payload::Reference(target));
            return self.instanceof_operator(code, value, target);
        }
        let mut object = match value.value {
            Payload::Reference(object) if value.kind == Kind::Reference => object,
            _ => return Ok(false),
        };
        self.meter.tick_raw(INSTANCEOF_OBJECT_METERING);
        let prototype_id = self.intern_static_key("prototype");
        let prototype = self.mop_get(code, ctor, prototype_id, constructor)?;
        let target = match prototype.value {
            Payload::Reference(target) if prototype.kind == Kind::Reference => target,
            _ => return Err(self.catchable_type_error_msg("this.prototype: not an object".into())),
        };
        let mut proxy_steps = 0;
        loop {
            self.charge_proxy_chain_step(object, &mut proxy_steps)?;
            let parent = self.mop_get_prototype(code, object)?;
            match (parent.kind, parent.value) {
                (Kind::Reference, Payload::Reference(parent)) => {
                    if parent == target {
                        return Ok(true);
                    }
                    object = parent;
                }
                (Kind::Null, _) => return Ok(false),
                _ => {
                    return Err(self.catchable_type_error_msg(
                        "instanceof: prototype chain contains a non-object".into(),
                    ))
                }
            }
        }
    }

    /// An instance slot's prototype (its payload reference), or `NULL`.
    #[inline]
    pub(super) fn instance_prototype(
        &self,
        inst: crate::value::SlotIndex,
    ) -> crate::value::SlotIndex {
        if inst.is_null() || inst.0 >= self.slots.capacity() {
            return crate::value::SlotIndex::NULL;
        }
        match self.slots.get(inst).value {
            Payload::Reference(p) => p,
            _ => crate::value::SlotIndex::NULL,
        }
    }

    /// The native identity of a function instance, if it is an intrinsic.
    #[inline]
    pub(super) fn native_of(&self, f: crate::value::SlotIndex) -> Option<Native> {
        self.functions.get(&f).and_then(|fi| fi.native)
    }

    /// Allocate a fresh user-function instance (`fxNewFunctionInstance` +
    /// `fxDefaultFunctionPrototype`, driven by `constructor_function`).
    /// The instance is a real arena object; its body range and closures are
    /// recorded in [`Self::functions`] by the following `code` /
    /// `function_environment` opcodes. Meters the measured allocation
    /// cluster [`FUNCTION_DEFINE_METERING`].
    pub(super) fn new_function(&mut self, name: u16) -> crate::value::SlotIndex {
        self.meter.tick_raw(FUNCTION_DEFINE_METERING);
        // `fxNewFunctionInstance` runs `fxRenameFunction`; naming the
        // instance with a real id (an inferred `var f = function(){}` or a
        // `function g(){}` declaration — anything but `XS_NO_ID` = 0)
        // costs two additional built-in steps (`mxMeterOne`) over the
        // anonymous case folded into [`FUNCTION_DEFINE_METERING`]. Measured
        // against the pin as exactly `2 * XS_BUILTIN_METERING` = 32768 raw,
        // independent of the name's length (the name symbol's string chunk
        // is interned at parse time, outside the run-only meter).
        if name != crate::value::XS_NO_ID {
            self.meter.tick_builtin_some(2);
        }
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        // Recover the function's own name (for `Function.prototype.toString`):
        // a real name id indexes the program's symbol names; `XS_NO_ID` is
        // anonymous.
        let fname = if name != crate::value::XS_NO_ID {
            self.symbol_names
                .get(name as usize - 1)
                .cloned()
                .unwrap_or_default()
        } else {
            SymbolName::default()
        };
        // Intern the `.name` chunk once, unmetered: XS builds the function's
        // `name` string chunk at `fxNewFunctionName` (folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster), so a later `f.name` read is a
        // free own-property read — ironhorse mirrors that by pre-interning here.
        let name_chunk = self.chunks.alloc(&units_to_be16(&fname.to_units()));
        let global_env = self.capture_global_environment();
        self.functions.insert(
            f,
            FuncInfo {
                global_env,
                name: fname.to_string(),
                name_chunk,
                ..FuncInfo::default()
            },
        );
        // `fxDefaultFunctionPrototype`: a `constructor_function` gets a default
        // `.prototype` object (chaining to %Object.prototype%) that a later
        // `new f()` uses as the instance prototype and `instanceof` tests
        // against. Its allocation is already folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster, so it is created unmetered here.
        let proto = self.slots.alloc(Slot::instance(self.object_proto));
        // `fxDefaultFunctionPrototype` also installs `prototype.constructor`
        // (the spec back-reference, `{writable, enumerable:false,
        // configurable}`). Its slot is folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster, so it is written unmetered —
        // and only when the program names `constructor` (otherwise the property
        // is unobservable and non-`constructor` programs stay byte-identical).
        if let Some(cid) = self.constructor_id {
            self.set_own_unmetered_with_flag(
                proto,
                cid,
                Slot::of(Kind::Reference, Payload::Reference(f)),
                XS_DONT_ENUM_FLAG,
            );
        }
        self.ctor_prototype.insert(f, proto);
        f
    }

    /// Install a constructor function's own `prototype` data property
    /// (`fxDefaultFunctionPrototype`'s `{writable, enumerable: false,
    /// configurable: false}` slot) pointing at its [`Self::ctor_prototype`]
    /// object, so `T.prototype` reads, `T.prototype.m = …` augmentation, and
    /// `T.prototype = …` reassignment all resolve the SAME object `new T()`
    /// chains instances to. Gated on the program naming `prototype` (like the
    /// `prototype.constructor` back-reference), unmetered on both sides.
    pub(super) fn install_own_function_prototype(&mut self, f: crate::value::SlotIndex) {
        if let (Some(pid), Some(&proto)) = (self.prototype_key_id, self.ctor_prototype.get(&f)) {
            self.set_own_unmetered_with_flag(
                f,
                pid,
                Slot::of(Kind::Reference, Payload::Reference(proto)),
                XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG,
            );
        }
    }

    /// Define a generator function (`XS_CODE_GENERATOR_FUNCTION` →
    /// `fxNewGeneratorFunctionInstance`). Like [`Self::new_function`] but the
    /// function's `.prototype` object chains to `%GeneratorPrototype%` (so a
    /// generator instance resolves `next`/`return`/`throw`) rather than to
    /// `%Object.prototype%`. XS builds this prototype as an explicit
    /// `fxNewObjectInstance` + a `_prototype` property slot on top of the base
    /// function instance; that extra allocation cluster over the plain
    /// `function` define is the calibrated [`GENERATOR_FUNCTION_EXTRA_METERING`].
    pub(super) fn new_generator_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_function(name);
        // Re-chain the function instance's own `[[Prototype]]` to
        // `%GeneratorFunction.prototype%` (XS's `mxGeneratorFunctionPrototype`)
        // rather than `%Function.prototype%`, so `(function*(){}).constructor`
        // resolves `%GeneratorFunction%` (and its `.name` is
        // `"GeneratorFunction"`), matching XS. The intermediate prototype is a
        // single boot object, so this is a slot re-point, not a per-instance
        // allocation — no metering delta.
        self.slots.get_mut(f).value = Payload::Reference(self.generator_function_proto);
        // Re-chain the default `.prototype` object to `%GeneratorPrototype%`
        // and account XS's extra generator-prototype allocation.
        self.meter.tick_raw(GENERATOR_FUNCTION_EXTRA_METERING);
        if let Some(&proto) = self.ctor_prototype.get(&f) {
            if let Payload::Reference(_) | Payload::None = self.slots.get(proto).value {
                let s = self.slots.get_mut(proto);
                s.value = Payload::Reference(self.generator_proto);
            }
        }
        // Mark the function as a generator so a bare call is understood (the
        // body's `START_GENERATOR` is what actually produces the instance).
        self.functions.update(&f, |info| {
            info.is_generator = true;
        });
        f
    }

    /// Allocate a generator instance (`fxNewGeneratorInstance`) chained to
    /// `proto` (the generator function's `.prototype`) and record its
    /// suspended-start activation snapshot in the `generators` side table.
    /// XS allocates the instance slot plus two internal property slots (the
    /// `XS_STACK_KIND` saved-stack holder and the resume-state integer); that
    /// three-`fxNewSlot` cluster is the calibrated
    /// [`GENERATOR_START_METERING`].
    pub(super) fn new_generator_instance(
        &mut self,
        proto: crate::value::SlotIndex,
        resume_pc: usize,
    ) -> crate::value::SlotIndex {
        self.meter.tick_raw(GENERATOR_START_METERING);
        let inst = self.slots.alloc(Slot::instance(proto));
        // Snapshot the current (freshly-entered) frame. At `START_GENERATOR`
        // the value stack holds nothing above the frame base (`begin` set up
        // `locals`, not temporaries), so `stack_slice` is empty; on the first
        // `.next` the body runs from `resume_pc`.
        let frame = self.fresh_activation(resume_pc);
        self.generators.insert(
            inst,
            GeneratorData {
                state: GeneratorState::SuspendedStart,
                frame: Some(frame),
            },
        );
        inst
    }

    pub(super) fn new_async_generator_instance(
        &mut self,
        proto: crate::value::SlotIndex,
        resume_pc: usize,
    ) -> crate::value::SlotIndex {
        self.meter.tick_raw(GENERATOR_START_METERING);
        let inst = self.slots.alloc(Slot::instance(proto));
        let frame = self.fresh_activation(resume_pc);
        self.async_generators.insert(
            inst,
            AsyncGeneratorData {
                state: AsyncGeneratorState::SuspendedStart,
                frame: Some(frame),
                requests: std::collections::VecDeque::new(),
                active: None,
            },
        );
        inst
    }

    /// Define an async function (`XS_CODE_ASYNC_FUNCTION` →
    /// `fxNewFunctionInstance`). Like [`Self::new_function`] but the function
    /// instance's own `[[Prototype]]` chains to `%AsyncFunction.prototype%`
    /// (XS's `mxAsyncFunctionPrototype`) rather than `%Function.prototype%`, and
    /// it has **no** own `.prototype`/`constructor` pair (async functions are
    /// not constructors). The body leads with `START_ASYNC`. Metering: XS runs
    /// the *same* `fxNewFunctionInstance` as a plain function and skips
    /// `fxDefaultFunctionPrototype`, so the define cost equals `new_function`'s
    /// (the spurious `ctor_prototype` object ironhorse's `new_function` allocates is
    /// unmetered and dropped here) — the calibrated delta is ~0.
    pub(super) fn new_async_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_function(name);
        // Re-chain the function instance's `[[Prototype]]` to
        // `%AsyncFunction.prototype%` (XS's `fxNewFunctionInstance` prototype).
        self.slots.get_mut(f).value = Payload::Reference(self.async_function_proto);
        // No own `.prototype`: drop the default-prototype object `new_function`
        // built (unmetered materialization on both sides).
        self.ctor_prototype.remove(&f);
        // An async function is not a constructor, so XS's `XS_CODE_ASYNC_FUNCTION`
        // → `fxNewFunctionInstance` skips the `fxDefaultFunctionPrototype`
        // `.prototype` object `new_function`'s calibrated
        // [`FUNCTION_DEFINE_METERING`] cluster includes. Back that allocation
        // out — the calibrated define delta vs a plain function.
        self.meter.untick_raw(ASYNC_FUNCTION_DEFINE_DELTA);
        f
    }

    pub(super) fn new_async_generator_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_generator_function(name);
        self.slots.get_mut(f).value = Payload::Reference(self.async_generator_function_proto);
        if let Some(&proto) = self.ctor_prototype.get(&f) {
            self.slots.get_mut(proto).value = Payload::Reference(self.async_generator_proto);
        }
        // Like an async function, an async generator is not constructable.
        self.functions.update(&f, |info| {
            info.is_generator = true;
        });
        f
    }

    /// Allocate an async-function instance (`fxNewAsyncInstance`) for a
    /// `START_ASYNC`: an internal instance holding the suspended activation, the
    /// result promise, and the four resolving/await functions. ironhorse materializes
    /// the result promise + its resolve/reject pair (the sub-clusters this meters
    /// explicitly) and records the `resume_pc`-cursored frame snapshot in the
    /// `async_instances` table, cloning the current (freshly-entered) activation
    /// exactly like [`Self::new_generator_instance`] — a **clone**, not a take,
    /// so the driver frame survives for `START_ASYNC`'s own `leave_call`. The
    /// remaining allocation cluster (instance/stack/state/await-function slots +
    /// frame residual) is the calibrated [`ASYNC_INSTANCE_METERING`].
    pub(super) fn new_async_instance(&mut self, resume_pc: usize) -> crate::value::SlotIndex {
        self.meter.tick_raw(ASYNC_INSTANCE_METERING);
        // The result promise + its resolve/reject resolving pair (XS's
        // `fxNewPromiseInstance` + `fxPushPromiseFunctions`, metered by the
        // helpers).
        let result_promise = self.new_promise_instance();
        let (resolve_fn, reject_fn) = self.make_resolving_functions(result_promise);
        let inst = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        // Snapshot the current (freshly-entered) frame. Like `START_GENERATOR`,
        // the value stack holds nothing above the frame base at `START_ASYNC`
        // (`begin` set up `locals`, not temporaries), so `stack_slice` is empty;
        // `step_async` runs the body from `resume_pc`.
        let frame = self.fresh_activation(resume_pc);
        self.async_instances.insert(
            inst,
            AsyncData {
                frame: Some(frame),
                result_promise,
                resolve_fn,
                reject_fn,
                done: false,
            },
        );
        inst
    }

    /// Insert an own data property onto a freshly-built boot instance (the
    /// exec result array's `index`/`input`/`groups`) as a single linked
    /// `fxNewSlot`, without the property-table-growth cost `instance_put`
    /// charges (the slot alloc is metered by the caller, mirroring XS's
    /// `resultItem = resultItem->next = fxNewSlot`).
    pub(super) fn instance_put_raw(&mut self, inst: crate::value::SlotIndex, id: u16, value: Slot) {
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// Whether a slot is a callable value (a reference to a modeled function —
    /// user, native, bound, or promise resolving function). XS's `fxIsCallable`.
    pub(super) fn is_callable_value(&self, v: Slot) -> bool {
        matches!(v.value, Payload::Reference(r) if v.kind == Kind::Reference && self.slot_is_callable(r))
    }

    /// The constructor a `super(...)` in the running function calls (XS's
    /// `XS_CODE_SUPER`): the derived constructor's [[Prototype]]. An arrow
    /// function has no [[Construct]] and no class of its own, so from one XS
    /// takes the class its home object's own `constructor` names, and its
    /// [[Prototype]]. `NULL` when there is none; the caller throws.
    pub(super) fn super_parent(&self) -> crate::value::SlotIndex {
        let function = if self.slot_is_constructor(self.cur_func) {
            self.cur_func
        } else {
            let home = self
                .functions
                .get(&self.cur_func)
                .map(|info| info.home)
                .unwrap_or(crate::value::SlotIndex::NULL);
            if home.is_null() {
                return crate::value::SlotIndex::NULL;
            }
            let Some(&id) = self.symbol_ids.get("constructor") else {
                return crate::value::SlotIndex::NULL;
            };
            match self
                .find_property(home, id)
                .map(|property| self.slots.get(property))
            {
                Some(Slot {
                    kind: Kind::Reference,
                    value: Payload::Reference(class),
                    ..
                }) => class,
                _ => return crate::value::SlotIndex::NULL,
            }
        };
        self.instance_prototype(function)
    }

    /// `IsConstructor(v)` (ECMA-262 7.2.4). A bound/proxy callable follows its
    /// target. Native prototype methods and `eval` have no `[[Construct]]`.
    /// `Symbol` and `BigInt` do — the specification makes them constructors
    /// whose construction throws, so `Reflect.construct(Symbol, [])`, an
    /// `extends Symbol` class's `super()` and `Array.of.call(BigInt)` reach
    /// that TypeError (`new: Symbol` or `new: BigInt`, as XS says) rather than
    /// "not a constructor", and either can be a `new.target`. A user function
    /// has it only when its constructor opcode retained a default-prototype
    /// link; generator functions use that link for their generator instances
    /// but are themselves non-constructable.
    pub(super) fn is_constructor_value(&self, v: Slot) -> bool {
        matches!(v.value, Payload::Reference(r) if v.kind == Kind::Reference && self.slot_is_constructor(r))
    }

    pub(super) fn slot_is_constructor(&self, r: crate::value::SlotIndex) -> bool {
        // Follow proxy and bound-function targets in a loop: both chains are
        // acyclic (each wrapper's target already exists when the wrapper is
        // minted) but a guest can make them a million links long.
        let mut r = r;
        loop {
            if let Some(data) = self.proxies.get(&r) {
                if data.revoked {
                    return false;
                }
                r = data.target;
                continue;
            }
            if let Some(data) = self.bound_functions.get(&r) {
                r = data.target;
                continue;
            }
            break;
        }
        match self.functions.get(&r) {
            Some(fi) if fi.method.is_some() => false,
            Some(fi) if fi.native.is_some() => {
                !matches!(fi.native, Some(Native::Host | Native::Eval))
            }
            Some(fi) => !fi.is_generator && self.ctor_prototype.contains_key(&r),
            None => false,
        }
    }

    /// Whether a heap instance has `[[Call]]`: a function instance, or a live
    /// proxy whose target is (recursively) callable (ECMA-262 10.5.12 gates
    /// `[[Call]]` on the target being callable).
    pub(super) fn slot_is_callable(&self, r: crate::value::SlotIndex) -> bool {
        // Follow proxy targets in a loop (see `slot_is_constructor`).
        let mut r = r;
        loop {
            if self.functions.contains_key(&r) {
                return true;
            }
            match self.proxies.get(&r) {
                Some(data) if !data.revoked => r = data.target,
                _ => return false,
            }
        }
    }

    /// `Function.prototype.bind(thisArg, ...boundArgs)`
    /// (`fx_Function_prototype_bind`): create a bound function. The receiver
    /// (`this`, at `base`) must be a modeled function; `thisArg` is arg 0 and the
    /// bound arguments are args `1..argc`. The bound function's `.length` is
    /// the target's own `.length` minus the bound-arg count (floored at 0),
    /// its `.name` is `"bound "` + the target's name; calling it invokes the
    /// target with the bound `this` + bound args prepended through
    /// [`Self::invoke_value`].
    pub(super) fn make_bound_function(&mut self, base: usize, argc: usize) -> Result<Slot, Step> {
        let this = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // Any callable may be bound. User functions use the ordinary bound
        // trampoline; the canonical bound `Function.prototype.call` native
        // shape is handled directly by the call opcode. A **native** receiver
        // (native constructor/method) is equally in `functions`, so it binds
        // through the same record — its bound call re-dispatches the native.
        // `Function.prototype.bind` step 2 (ECMA-262 20.2.3.2): if the target
        // is **not callable**, throw a TypeError (catchable). A callable proxy
        // is bindable per spec, but a bound-of-proxy call is not yet modeled,
        // so keep the honest skip rather than throw wrongly.
        let target = match this.value {
            Payload::Reference(r) if self.functions.contains_key(&r) => r,
            Payload::Reference(r) if self.slot_is_callable(r) => {
                return Err(Step::Host(Halt::NotImplemented(
                    "bind:non-user-function-receiver",
                )));
            }
            _ => return Err(self.catchable_type_error_msg("this: not a Function instance".into())),
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let nbound = argc.saturating_sub(1) as u32;
        // The bound-function creation cluster (instance + CODE/HOME + the three
        // internal property slots + the length/name properties). When there
        // are bound arguments, XS additionally builds an Array for them
        // (`fxNewArrayInstance` + a `fxNewSlot` per arg + `fxCacheArray`);
        // with none, `_boundArguments` is a null property (no array).
        let args_meter = if nbound >= 1 {
            BIND_CREATE_ARGS_ARRAY + nbound as u64 * BIND_CREATE_PER_ARG
        } else {
            0
        };
        self.charge_and_check(BIND_CREATE_METERING + args_meter)?;
        // Bound leading arguments: args 1..argc (arg 0 is `thisArg`).
        let bound_args: Vec<Slot> = if argc >= 2 {
            Self::fill_scratch(
                self.reserve_scratch(argc - 1)?,
                (1..argc).map(|i| {
                    self.stack
                        .get(base + 4 + i)
                        .copied()
                        .unwrap_or_else(Slot::undefined)
                }),
            )
        } else {
            Vec::new()
        };
        // Bound `.length` = max(0, target.length - boundArgs) and bound `.name`
        // = "bound " + target.name (XS reads the target's own `length`/`name`).
        let target_arity = self.functions.get(&target).map(|fi| fi.arity).unwrap_or(0);
        let bound_len = target_arity.saturating_sub(nbound);
        let name_length = self
            .functions
            .get(&target)
            .map(|info| self.str_content(info.name_chunk).len() / 2)
            .unwrap_or(0);
        let mut bound_units = self.reserve_work_scratch(name_length + 6)?;
        bound_units.extend("bound ".encode_utf16());
        if let Some(info) = self.functions.get(&target) {
            bound_units.extend(self.str_units(info.name_chunk));
        }
        let bound_name = SymbolName::from_units(&bound_units).to_string();
        let inst = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.chunks.alloc(&units_to_be16(&bound_units));
        // Register in `functions` (native/method None) so `.length`/`.name`
        // read back the bound values through the ordinary GET_PROPERTY arm.
        self.functions.insert(
            inst,
            FuncInfo {
                name: bound_name,
                name_chunk,
                arity: bound_len,
                ..FuncInfo::default()
            },
        );
        self.bound_functions.insert(
            inst,
            BoundData {
                target,
                this_arg,
                args: bound_args,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// `OrdinarySetWithOwnDescriptor` for a **writable data** ownDesc against a
    /// distinct `receiver` (ECMA-262 10.1.9.2 steps 3.a–3.e): the integer-
    /// indexed `[[Set]]`'s valid-index-but-receiver-differs continuation. The
    /// value is stored on the receiver (never on the source view, never
    /// coerced through the source's element type). Both the existing-property
    /// probe and the final definition use the receiver's full internal-method
    /// dispatch, preserving Array, String, TypedArray, and Proxy exotics.
    pub(super) fn set_data_on_receiver(
        &mut self,
        code: &[u8],
        receiver: Slot,
        key: Slot,
        value: Slot,
    ) -> Result<bool, Step> {
        let robj = match receiver.value {
            Payload::Reference(r) if receiver.kind == Kind::Reference => r,
            _ => return Ok(false),
        };
        let id = self.to_property_id(code, key)?;
        match self.mop_get_own_property(code, robj, id)? {
            Some(existing) => {
                if existing.is_accessor() || existing.writable == Some(false) {
                    return Ok(false);
                }
                let desc = OrdinaryDescriptor {
                    value: Some(value),
                    ..OrdinaryDescriptor::default()
                };
                self.mop_define_own_property(code, robj, id, desc)
            }
            None => {
                let desc = OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                self.mop_define_own_property(code, robj, id, desc)
            }
        }
    }
}
