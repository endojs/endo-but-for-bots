//! Promise capabilities, settlement, reaction jobs, and combinators.
use super::super::*;

impl Interp {
    /// Settle a promise through its resolve/reject function directly (the core
    /// of [`Self::call_promise_function`] without a value-stack frame): consult
    /// the pair's shared `[[AlreadyResolved]]` guard, and if fresh, trip it and
    /// settle. Used where XS calls a resolving function via `mxRunCount(1)`
    /// (async completion, the await general path) rather than from guest code.
    pub(in crate::interp) fn settle_via_function(
        &mut self,
        code: &[u8],
        f: Slot,
        value: Slot,
    ) -> Result<(), Step> {
        let fref = match f.value {
            Payload::Reference(r) => r,
            _ => return Err(Step::Host(Halt::EngineInvariant("async:bad-resolving-fn"))),
        };
        let data = match self.promise_functions.get(&fref) {
            Some(d) => *d,
            None => return Err(Step::Host(Halt::EngineInvariant("async:bad-resolving-fn"))),
        };
        if !is_promise_resolving_guard(data.guard) || data.guard >= self.promise_guards.len() {
            return Err(Step::Host(Halt::EngineInvariant(
                "async:non-resolver-as-resolver",
            )));
        }
        if self.promise_guards.get(data.guard).copied().unwrap_or(true) {
            self.meter.tick_raw(PROMISE_SETTLE_GUARDED_METERING);
            Ok(())
        } else {
            self.promise_guards[data.guard] = true;
            self.settle_promise(code, data.promise, value, data.reject)
        }
    }

    /// Reject through a native resolving function when the caller has no
    /// executable code dependency. Rejection never performs thenable
    /// assimilation, so it needs no bytecode buffer for observable property
    /// access; keeping this path explicit prevents fulfillment callers from
    /// accidentally bypassing the full `Get(resolution, "then")` operation.
    pub(in crate::interp) fn reject_via_function(
        &mut self,
        f: Slot,
        value: Slot,
    ) -> Result<(), Step> {
        let fref = match f.value {
            Payload::Reference(r) => r,
            _ => return Err(Step::Host(Halt::EngineInvariant("async:bad-resolving-fn"))),
        };
        let data = match self.promise_functions.get(&fref) {
            Some(d)
                if d.reject
                    && is_promise_resolving_guard(d.guard)
                    && d.guard < self.promise_guards.len() =>
            {
                *d
            }
            _ => return Err(Step::Host(Halt::EngineInvariant("async:bad-rejecting-fn"))),
        };
        if self.promise_guards.get(data.guard).copied().unwrap_or(true) {
            self.meter.tick_raw(PROMISE_SETTLE_GUARDED_METERING);
            Ok(())
        } else {
            self.promise_guards[data.guard] = true;
            self.finish_promise_settlement(data.promise, value, true)
        }
    }

    /// Settle an arbitrary promise capability through the callback selected by
    /// the completion. Native resolving functions retain the direct calibrated
    /// path; callbacks supplied by a custom constructor run as ordinary calls.
    fn settle_capability(
        &mut self,
        code: &[u8],
        resolve: Slot,
        reject: Slot,
        value: Slot,
        rejected: bool,
    ) -> Result<(), Step> {
        let function = if rejected { reject } else { resolve };
        let native_resolver = match function.value {
            Payload::Reference(f) if function.kind == Kind::Reference => {
                self.promise_functions.get(&f).is_some_and(|data| {
                    is_promise_resolving_guard(data.guard) && data.guard < self.promise_guards.len()
                })
            }
            _ => false,
        };
        if native_resolver {
            self.settle_via_function(code, function, value)
        } else {
            self.call_any(code, function, Slot::undefined(), &[value])?;
            Ok(())
        }
    }

    /// Allocate a fresh **pending** promise instance (XS's
    /// `fxNewPromiseInstance`): a heap instance chaining to
    /// `%Promise.prototype%`, its [`PromiseData`] in the `promises` side table,
    /// and the six `fxNewSlot`s XS charges (promise, STATUS, THENS, the
    /// THENS-holder instance, RESULT, ENVIRONMENT). The native frame residual
    /// is charged by the caller.
    pub(in crate::interp) fn new_promise_instance(&mut self) -> crate::value::SlotIndex {
        self.new_promise_instance_with_proto(self.promise_proto)
    }

    pub(in crate::interp) fn new_promise_instance_with_proto(
        &mut self,
        proto: crate::value::SlotIndex,
    ) -> crate::value::SlotIndex {
        for _ in 0..6 {
            self.meter.tick_slot_alloc();
        }
        let inst = self.slots.alloc(Slot::instance(proto));
        self.promises.insert(
            inst,
            PromiseData {
                state: PromiseState::Pending,
                result: Slot::undefined(),
                reactions: Vec::new(),
                ever_handled: false,
            },
        );
        inst
    }

    /// Build the resolve/reject function pair that settles `promise` (XS's
    /// `fxPushPromiseFunctions`): two host functions recorded in
    /// `promise_functions`, sharing a fresh `[[AlreadyResolved]]` guard (an
    /// index into [`Self::promise_guards`], the pair's shared boolean). Metered
    /// as [`PROMISE_FUNCTIONS_METERING`]. Returns `(resolve, reject)` reference
    /// slots.
    pub(in crate::interp) fn make_resolving_functions(
        &mut self,
        promise: crate::value::SlotIndex,
    ) -> (Slot, Slot) {
        // XS's `fxPushPromiseFunctions` allocates 13 `fxNewSlot`s: each of the
        // two `fxNewHostFunction`s is instance + CALLBACK + HOME + LENGTH +
        // NAME (5 slots, an empty interned name → no chunk), and the shared
        // home object is `fxNewInstance` + a boolean guard slot + a
        // promise-reference slot (3). ironhorse's model materializes only the two
        // function instances, but meters XS's full slot count.
        for _ in 0..13 {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_FUNCTIONS_METERING);
        // The pair's shared `[[AlreadyResolved]]` guard (fresh boolean = false).
        let guard = self.promise_guards.len();
        self.promise_guards.push(false);
        let fp = self.function_proto;
        // A resolving function is an anonymous, length-1 built-in (spec 27.2.1.3):
        // its `name` is the empty string and `length` is 1. Interning a real
        // empty `name` chunk (rather than the `FuncInfo::default()` NULL) is
        // required now that the function-meta reflective paths materialize/read
        // `name` — a NULL chunk would fault when read. Unmetered (the boot chunk
        // allocation is outside the guest meter), matching the pre-existing
        // `alloc_named_method("", …)` empty-name convention.
        let empty_name = self.alloc_str_text(b"");
        let resolve = self.slots.alloc(Slot::instance(fp));
        self.functions.insert(
            resolve,
            FuncInfo {
                method: Some(NativeMethod::PromiseResolveFunction),
                name_chunk: empty_name,
                arity: 1,
                ..FuncInfo::default()
            },
        );
        self.promise_functions.insert(
            resolve,
            PromiseFnData {
                promise,
                reject: false,
                guard,
            },
        );
        let reject = self.slots.alloc(Slot::instance(fp));
        self.functions.insert(
            reject,
            FuncInfo {
                method: Some(NativeMethod::PromiseRejectFunction),
                name_chunk: empty_name,
                arity: 1,
                ..FuncInfo::default()
            },
        );
        self.promise_functions.insert(
            reject,
            PromiseFnData {
                promise,
                reject: true,
                guard,
            },
        );
        (
            Slot::of(Kind::Reference, Payload::Reference(resolve)),
            Slot::of(Kind::Reference, Payload::Reference(reject)),
        )
    }

    /// Mint one anonymous `thenFinally` / `catchFinally` closure. The hidden
    /// null-prototype home keeps the callable handler and selected constructor
    /// in ordinary heap slots, while the promise-function row gives the
    /// runtime-minted native a persisted identity and records which completion
    /// it restores.
    fn make_promise_finally_handler(
        &mut self,
        on_finally: Slot,
        constructor: Slot,
        rejected: bool,
    ) -> Slot {
        for _ in 0..4 {
            self.meter.tick_slot_alloc();
        }
        let handler_id = self.intern_static_key("[[PromiseFinallyHandler]]");
        let constructor_id = self.intern_static_key("[[PromiseFinallyConstructor]]");
        let home = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        self.set_own_unmetered(home, handler_id, on_finally);
        self.set_own_unmetered(home, constructor_id, constructor);
        let function = self.alloc_named_method(NativeMethod::PromiseFinallyHandler, "", 1);
        self.promise_functions.insert(
            function,
            PromiseFnData {
                promise: home,
                reject: rejected,
                guard: PROMISE_FINALLY_HANDLER_GUARD,
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(function))
    }

    /// Mint the anonymous value thunk passed to the promise returned by
    /// `PromiseResolve(C, onFinally())`. On fulfillment it either returns the
    /// original value or throws the original reason; an awaited rejection is
    /// propagated by the receiver's `then` because no rejection handler is
    /// supplied.
    fn make_promise_finally_value(&mut self, value: Slot, rejected: bool) -> Slot {
        for _ in 0..3 {
            self.meter.tick_slot_alloc();
        }
        let value_id = self.intern_static_key("[[PromiseFinallyValue]]");
        let home = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        self.set_own_unmetered(home, value_id, value);
        let function = self.alloc_named_method(NativeMethod::PromiseFinallyValue, "", 0);
        self.promise_functions.insert(
            function,
            PromiseFnData {
                promise: home,
                reject: rejected,
                guard: PROMISE_FINALLY_VALUE_GUARD,
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(function))
    }

    /// Build a fresh promise **capability** (XS's `fxNewPromiseCapability`): a
    /// derived pending promise plus its resolve/reject pair. XS routes this
    /// through `new this.constructor(capabilityCallback)`; for the native
    /// `Promise` the observable outcome and the allocation profile are the
    /// derived promise ([`Self::new_promise_instance`]) + its resolving pair
    /// ([`Self::make_resolving_functions`]) plus the capability-specific
    /// overhead ([`PROMISE_CAPABILITY_METERING`] — the callback host function,
    /// its home object, the folded `fx_Promise` frame, and the `mxRunCount(1)`
    /// framing). Returns `(derived, resolve, reject)`.
    pub(in crate::interp) fn new_promise_capability(
        &mut self,
    ) -> (crate::value::SlotIndex, Slot, Slot) {
        // The capability-callback `fxNewHostFunction` (instance + CALLBACK +
        // HOME + LENGTH + NAME = 5 slots) and its home object built by the
        // callback body (`fxNewInstance` + resolve slot + reject slot = 3),
        // plus the folded `fx_Promise` frame ([`PROMISE_CAPABILITY_METERING`]).
        for _ in 0..8 {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_CAPABILITY_METERING);
        let derived = self.new_promise_instance();
        let (resolve, reject) = self.make_resolving_functions(derived);
        (derived, resolve, reject)
    }

    /// `NewPromiseCapability(C)` for an arbitrary constructor. The intrinsic
    /// path retains its calibrated fast representation. A custom constructor
    /// receives a real anonymous, length-2, non-constructable capability
    /// executor whose hidden home captures the supplied resolve/reject values.
    pub(in crate::interp) fn new_promise_capability_for(
        &mut self,
        code: &[u8],
        constructor: Slot,
    ) -> Result<PromiseCapability, Step> {
        if !self.is_constructor_value(constructor) {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        let intrinsic = self.intrinsics.get("Promise").copied();
        if matches!(constructor.value,
            Payload::Reference(c)
                if constructor.kind == Kind::Reference && Some(c) == intrinsic)
        {
            let (promise, resolve, reject) = self.new_promise_capability();
            return Ok(PromiseCapability {
                promise: Slot::of(Kind::Reference, Payload::Reference(promise)),
                resolve,
                reject,
            });
        }

        // The callback function (5 slots) and its hidden capability record
        // (instance + two fields) are the same eight-slot cluster charged by
        // the intrinsic capability path. The custom constructor's own work is
        // metered by `construct_value`.
        for _ in 0..8 {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_CAPABILITY_METERING);
        let resolve_id = self.intern_static_key("[[PromiseCapabilityResolve]]");
        let reject_id = self.intern_static_key("[[PromiseCapabilityReject]]");
        let home = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));

        // Both private fields always exist so snapshot validation can reject
        // unrelated objects substituted for the capture record. An internal
        // sentinel distinguishes never-called from explicitly captured undefined.
        self.set_own_unmetered(home, resolve_id, Slot::uninitialized());
        self.set_own_unmetered(home, reject_id, Slot::uninitialized());

        let empty_name = self.alloc_str_text(b"");
        let function = self.slots.alloc(Slot::instance(self.function_proto));
        self.functions.insert(
            function,
            FuncInfo {
                method: Some(NativeMethod::PromiseCapabilityExecutor),
                name_chunk: empty_name,
                arity: 2,
                ..FuncInfo::default()
            },
        );
        self.promise_functions.insert(
            function,
            PromiseFnData {
                promise: home,
                reject: false,
                guard: PROMISE_CAPABILITY_EXECUTOR_GUARD,
            },
        );
        let executor = Slot::of(Kind::Reference, Payload::Reference(function));
        let promise = self.construct_value(code, constructor, &[executor], constructor)?;
        if self
            .mop_get(
                code,
                home,
                resolve_id,
                Slot::of(Kind::Reference, Payload::Reference(home)),
            )?
            .kind
            == Kind::Uninitialized
        {
            return Err(self.catchable_type_error_msg("executor not called".into()));
        }
        let resolve = self.mop_get(
            code,
            home,
            resolve_id,
            Slot::of(Kind::Reference, Payload::Reference(home)),
        )?;
        let reject = self.mop_get(
            code,
            home,
            reject_id,
            Slot::of(Kind::Reference, Payload::Reference(home)),
        )?;
        for (name, function) in [("resolve", resolve), ("reject", reject)] {
            if function.kind != Kind::Reference {
                return Err(self.catchable_type_error_msg(format!("{name}: not an object")));
            }
            if !self.is_callable_value(function) {
                return Err(self.catchable_type_error_msg(format!("{name}: not a function")));
            }
        }
        Ok(PromiseCapability {
            promise,
            resolve,
            reject,
        })
    }

    /// `Promise.prototype.then(onFulfilled, onRejected)`
    /// (`fx_Promise_prototype_then` → `fxPromiseThen`): register the reaction
    /// on the receiver promise and return the selected species capability's
    /// result object. A non-callable handler is treated as absent
    /// (pass-through). If the receiver is already settled,
    /// the reaction is queued as a job immediately (run at the drain);
    /// otherwise it is appended to the promise's reaction list. Returns the
    /// capability result slot.
    pub(in crate::interp) fn promise_then(
        &mut self,
        code: &[u8],
        promise: crate::value::SlotIndex,
        base: usize,
    ) -> Result<Slot, Step> {
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg1 = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        self.promise_then_with(code, promise, arg0, arg1)
    }

    /// The core of `.then` (`fxPromiseThen`), given the raw handler slots. A
    /// handler is present only when callable.
    /// Shared by `.then` and `.catch` (which passes `(undefined, onRejected)`).
    fn promise_then_with(
        &mut self,
        code: &[u8],
        promise: crate::value::SlotIndex,
        arg0: Slot,
        arg1: Slot,
    ) -> Result<Slot, Step> {
        let on_fulfilled = if self.is_callable_value(arg0) {
            arg0
        } else {
            Slot::undefined()
        };
        let on_rejected = if self.is_callable_value(arg1) {
            arg1
        } else {
            Slot::undefined()
        };
        self.meter.tick_raw(PROMISE_THEN_METERING);
        let promise_slot = Slot::of(Kind::Reference, Payload::Reference(promise));
        let constructor = self.promise_species_constructor(code, promise_slot)?;
        let capability = self.new_promise_capability_for(code, constructor)?;
        // `fxPromiseThen`: the reaction instance's 6 `fxNewSlot`s (the reaction
        // instance + resolve/reject/onFulfilled/onRejected/result slots),
        // always built regardless of the promise's state.
        for _ in 0..6 {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_REACTION_METERING);
        let reaction = PromiseReaction {
            on_fulfilled,
            on_rejected,
            resolve: capability.resolve,
            reject: capability.reject,
            kind: ReactionKind::User,
        };
        // A `.then`/`.catch` observes the promise: mark it handled for the
        // unhandled-rejection latch (XS clears `the->rejection` when a reaction
        // is registered). Unmetered bookkeeping.
        self.promises.get_mut(&promise).unwrap().ever_handled = true;
        let state = self.promises[&promise].state;
        match state {
            PromiseState::Pending => {
                // Append to the promise's reaction list (XS's +1 THENS-list
                // reference slot linking the reaction).
                self.meter.tick_slot_alloc();
                self.promises
                    .get_mut(&promise)
                    .unwrap()
                    .reactions
                    .push(reaction);
            }
            PromiseState::Fulfilled | PromiseState::Rejected => {
                // Already settled: queue the reaction as a job immediately.
                let value = self.promises[&promise].result;
                let rejected = state == PromiseState::Rejected;
                self.queue_promise_job(PromiseJob::Reaction {
                    reaction,
                    value,
                    rejected,
                });
            }
        }
        Ok(capability.promise)
    }

    /// Register a **native** reaction on `promise` (XS's `fxPromiseThen` with a
    /// null capability, `resolveFunction == C_NULL`): the path `await`,
    /// `Promise.prototype.finally`, and the combinators use. Unlike the user
    /// `.then` path it builds **no** derived promise/capability and allocates
    /// **5** reaction slots (not 6 — no `__result__` slot; xsPromise.c:580); the
    /// reaction carries no user handler, only its `kind`, which the drain
    /// (`run_promise_job`) dispatches on. A pending promise appends the reaction
    /// (+1 THENS-list slot); an already-settled promise queues the job now.
    pub(in crate::interp) fn promise_then_native(
        &mut self,
        promise: crate::value::SlotIndex,
        kind: ReactionKind,
    ) {
        // A handler-less null-capability reaction carrying only its `kind`
        // (the drain drives the native behavior). Shares the 5-slot
        // registration with `finally`/the combinators.
        let reaction = PromiseReaction {
            on_fulfilled: Slot::undefined(),
            on_rejected: Slot::undefined(),
            resolve: Slot::undefined(),
            reject: Slot::undefined(),
            kind,
        };
        self.register_native_reaction(promise, reaction);
    }

    /// A promise resolve/reject function call (XS's `fxResolvePromise`/
    /// `fxRejectPromise`, dispatched from the `RUN` handler by a
    /// `promise_functions` lookup). Settles the bound promise with argument 0
    /// (or `undefined`), returning `undefined`. The value stack holds the call
    /// frame `[THIS, FUNCTION, RESULT, FRAME, arg0?]` from `base`.
    pub(in crate::interp) fn call_promise_function(
        &mut self,
        code: &[u8],
        f: crate::value::SlotIndex,
        base: usize,
        _argc: usize,
    ) -> Result<(), Step> {
        let data = self.promise_functions[&f];
        if data.guard == PROMISE_FINALLY_HANDLER_GUARD || data.guard == PROMISE_FINALLY_VALUE_GUARD
        {
            let value = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            let result = self.call_promise_finally_function(code, data, value);
            return match result {
                Ok(result) => {
                    self.stack.truncate(base);
                    self.push(result);
                    Ok(())
                }
                Err(halt) => Err(halt),
            };
        }
        if data.guard == PROMISE_CAPABILITY_EXECUTOR_GUARD {
            let resolve_id = self.intern_static_key("[[PromiseCapabilityResolve]]");
            let reject_id = self.intern_static_key("[[PromiseCapabilityReject]]");
            let resolve = self.mop_get(
                code,
                data.promise,
                resolve_id,
                Slot::of(Kind::Reference, Payload::Reference(data.promise)),
            )?;
            let reject = self.mop_get(
                code,
                data.promise,
                reject_id,
                Slot::of(Kind::Reference, Payload::Reference(data.promise)),
            )?;
            if !matches!(resolve.kind, Kind::Undefined | Kind::Uninitialized)
                || !matches!(reject.kind, Kind::Undefined | Kind::Uninitialized)
            {
                return Err(self.catchable_type_error_msg("executor already called".into()));
            }
            let supplied_resolve = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            let supplied_reject = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            self.set_own_unmetered(data.promise, resolve_id, supplied_resolve);
            self.set_own_unmetered(data.promise, reject_id, supplied_reject);
            self.stack.truncate(base);
            self.push(Slot::undefined());
            return Ok(());
        }
        let value = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // XS's `fxResolvePromise`/`fxRejectPromise` first consult the pair's
        // shared `[[AlreadyResolved]]` boolean: if already tripped, return right
        // after the check (a near-zero residual). Otherwise trip it and settle.
        if self.promise_guards.get(data.guard).copied().unwrap_or(true) {
            self.meter.tick_raw(PROMISE_SETTLE_GUARDED_METERING);
        } else {
            self.promise_guards[data.guard] = true;
            let direct = self.promises.get(&data.promise).and_then(|promise| {
                if promise.state != PromiseState::Pending || promise.reactions.len() != 1 {
                    return None;
                }
                match promise.reactions[0].kind {
                    ReactionKind::CombineDirect(ci, ei) => Some((ci, ei)),
                    _ => None,
                }
            });
            if let Some((ci, ei)) = direct {
                // This private bridge is the representation of a combinator
                // element closure, not a promise-resolution boundary. Record
                // its one-shot completion, then run the element algorithm in
                // the same call stack as the custom `then` invocation.
                let promise = self.promises.get_mut(&data.promise).unwrap();
                promise.state = if data.reject {
                    PromiseState::Rejected
                } else {
                    PromiseState::Fulfilled
                };
                promise.result = value;
                promise.reactions.clear();
                self.run_combine_reaction(code, ci as usize, ei as usize, value, data.reject)?;
            } else {
                self.settle_promise(code, data.promise, value, data.reject)?;
            }
        }
        self.stack.truncate(base);
        self.push(Slot::undefined());
        Ok(())
    }

    /// Invoke one persisted native closure created by
    /// `Promise.prototype.finally`. Handler closures perform
    /// `PromiseResolve(C, onFinally()).then(valueThunk)` and return that
    /// invocation's result. Value thunks restore or throw the captured
    /// original completion.
    fn call_promise_finally_function(
        &mut self,
        code: &[u8],
        data: PromiseFnData,
        argument: Slot,
    ) -> Result<Slot, Step> {
        if data.guard == PROMISE_FINALLY_VALUE_GUARD {
            let value_id = self.intern_static_key("[[PromiseFinallyValue]]");
            let value = self.mop_get(
                code,
                data.promise,
                value_id,
                Slot::of(Kind::Reference, Payload::Reference(data.promise)),
            )?;
            if data.reject {
                return Err(self.raise_js(value));
            }
            return Ok(value);
        }
        if data.guard != PROMISE_FINALLY_HANDLER_GUARD {
            return Err(Step::Host(Halt::EngineInvariant(
                "promise:unknown-finally-function",
            )));
        }
        let handler_id = self.intern_static_key("[[PromiseFinallyHandler]]");
        let constructor_id = self.intern_static_key("[[PromiseFinallyConstructor]]");
        let on_finally = self.mop_get(
            code,
            data.promise,
            handler_id,
            Slot::of(Kind::Reference, Payload::Reference(data.promise)),
        )?;
        let constructor = self.mop_get(
            code,
            data.promise,
            constructor_id,
            Slot::of(Kind::Reference, Payload::Reference(data.promise)),
        )?;
        let result = self.call_any(code, on_finally, Slot::undefined(), &[])?;
        let promise = self.promise_resolve_with_constructor(code, constructor, result)?;
        let value_thunk = self.make_promise_finally_value(argument, data.reject);
        self.invoke_value_method(code, promise, "then", &[value_thunk])
    }

    /// Resolve or reject a promise and queue its registered reactions.
    /// Reference resolution probes `.then`: a non-callable value fulfills with
    /// the object, while callable thenables are adopted asynchronously.
    /// Promises whose `.then` is the intrinsic method use a native reaction;
    /// other callable thenables queue a `PromiseResolveThenableJob`.
    /// Resolving with the promise itself rejects
    /// it with a TypeError. Rejection accepts any value.
    pub(in crate::interp) fn settle_promise(
        &mut self,
        code: &[u8],
        promise: crate::value::SlotIndex,
        value: Slot,
        reject: bool,
    ) -> Result<(), Step> {
        if !self.promises.contains_key(&promise) {
            return Err(Step::Host(Halt::EngineInvariant(
                "promise:settle-non-promise",
            )));
        }
        // The resolve-with-thenable branch (`fxResolvePromise`, `mxIsReference`):
        // probe `.then`; a callable one adopts the thenable rather than settling.
        if !reject && value.kind == Kind::Reference {
            if let Payload::Reference(obj) = value.value {
                if obj == promise {
                    // `resolve(promise)` rejects that promise with a TypeError.
                    let error = self.internal_error("TypeError", "promise resolves itself".into());
                    return self.finish_promise_settlement(promise, error, true);
                }
                // `Get(resolution, "then")` is observable even for branded
                // promises: an own or inherited accessor may throw, and a
                // monkeypatch may replace the intrinsic method. Run it behind
                // the resolving function's native try boundary so an abrupt
                // completion rejects this promise with the thrown value.
                self.meter.tick_raw(PROMISE_RESOLVE_THEN_PROBE_METERING);
                let then = match self.then_id {
                    Some(tid) => {
                        match self.array_from_try(|this| this.mop_get(code, obj, tid, value))? {
                            Ok(then) => then,
                            Err(thrown) => {
                                return self.finish_promise_settlement(promise, thrown, true)
                            }
                        }
                    }
                    None => Slot::undefined(),
                };
                let intrinsic_then = matches!(then.value,
                    Payload::Reference(function)
                        if then.kind == Kind::Reference
                            && self.method_of(function) == Some(NativeMethod::PromiseThen));
                if self.promises.contains_key(&obj) && intrinsic_then {
                    // Promise adoption is a native `then` registration whose
                    // pass-through reaction forwards the source settlement to
                    // the target promise. An own `.then` override still goes
                    // through ordinary thenable assimilation below. Adoption
                    // must remain asynchronous even when the source is already
                    // settled.
                    let (resolve, reject) = self.make_resolving_functions(promise);
                    let reaction = PromiseReaction {
                        on_fulfilled: Slot::undefined(),
                        on_rejected: Slot::undefined(),
                        resolve,
                        reject,
                        kind: ReactionKind::User,
                    };
                    self.register_native_reaction(obj, reaction);
                    return Ok(());
                }
                if self.is_callable_value(then) {
                    // Adoption drives `then.call(thenable, res, rej)` at the
                    // drain through the general callable dispatcher.
                    return self.adopt_thenable(promise, value, then);
                }
                // A non-callable `.then`: fall through and fulfill with `obj`.
            }
        }
        self.finish_promise_settlement(promise, value, reject)
    }

    /// Commit a promise's final state and enqueue its pending reactions after
    /// every resolving-algorithm branch that can inspect a fulfillment value
    /// has completed. A direct rejection enters here without a bytecode buffer
    /// because it performs no thenable property access.
    fn finish_promise_settlement(
        &mut self,
        promise: crate::value::SlotIndex,
        value: Slot,
        reject: bool,
    ) -> Result<(), Step> {
        if !self.promises.contains_key(&promise) {
            return Err(Step::Host(Halt::EngineInvariant(
                "promise:settle-non-promise",
            )));
        }
        let state = if reject {
            PromiseState::Rejected
        } else {
            PromiseState::Fulfilled
        };
        let reactions = {
            let pd = self.promises.get_mut(&promise).unwrap();
            pd.state = state;
            pd.result = value;
            std::mem::take(&mut pd.reactions)
        };
        // Queue one job per registered reaction (XS's `fxQueueJob` per THEN),
        // preserving registration (FIFO) order.
        for reaction in reactions {
            self.queue_promise_job(PromiseJob::Reaction {
                reaction,
                value,
                rejected: reject,
            });
        }
        // The native frame residual of the resolve/reject function body over
        // its `RUN` dispatch (the settle path allocates nothing when there are
        // no reactions and no thenable). `fxRejectPromise` charges slightly
        // more than `fxResolvePromise`.
        self.charge_and_check(if reject {
            PROMISE_REJECT_FN_METERING
        } else {
            PROMISE_RESOLVE_FN_METERING
        })?;
        Ok(())
    }

    /// Queue one reaction promise job (XS's `fxQueueJob(the, 1, promise)`): a
    /// one-argument job, 6 `fxNewSlot`s. See [`Self::queue_promise_job_n`].
    fn queue_promise_job(&mut self, job: PromiseJob) {
        self.queue_promise_job_n(job, 1);
    }

    /// Queue one promise job (XS's `fxQueueJob(the, count, promise)`): capture
    /// the job instance and its `count + 4` argument slots (`count + 5`
    /// `fxNewSlot`s total in XS; the pin's count-1 job measures 6, so
    /// `count + 5`) and append it FIFO to the pending queue. `count` is 1 for a
    /// reaction job and 3 for a resolve-with-thenable job (which captures the
    /// resolve/reject/then triple beyond the folded this+function).
    fn queue_promise_job_n(&mut self, job: PromiseJob, count: usize) {
        for _ in 0..(count + 5) {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_QUEUE_JOB_METERING);
        self.promise_jobs.push_back(job);
    }

    /// The keystone: adopt a thenable resolution (`fxResolvePromise`'s callable
    /// `.then` branch → `PromiseResolveThenableJob`). Build the promise's
    /// *second* resolving pair (a fresh guard), charge the thenable-branch frame
    /// residual, and queue a count-3 thenable job that at the drain calls
    /// `then.call(thenable, resolve, reject)`. The promise stays pending until
    /// that inner settle fires — the two-level guard structure.
    fn adopt_thenable(
        &mut self,
        promise: crate::value::SlotIndex,
        thenable: Slot,
        then: Slot,
    ) -> Result<(), Step> {
        // `fxPushPromiseFunctions(the, promise)` — the second resolving pair
        // (13 `fxNewSlot`s, its own `[[AlreadyResolved]]` guard).
        let (resolve, reject) = self.make_resolving_functions(promise);
        // `fxQueueJob(the, 3, promise)` — the thenable job captures
        // (fxOnThenable, thenable, resolve, reject, then).
        self.queue_promise_job_n(
            PromiseJob::Thenable {
                then,
                thenable,
                resolve,
                reject,
            },
            3,
        );
        // The resolve-fn frame beyond the base plus the extra thenable-branch
        // work (`mxGetID(_then)` probe + `fxIsCallable` + `mxCall` framing).
        self.meter.tick_raw(PROMISE_RESOLVE_FN_METERING);
        self.meter.tick_raw(PROMISE_RESOLVE_THENABLE_METERING);
        Ok(())
    }

    /// Drain the promise job queue (XS's `fxRunPromiseJobs`, the host-driven
    /// microtask drain the ironhorse embedding runs after a crank — the pump-loop
    /// latch). Each job runs its reaction handler against the settled value and
    /// settles the derived promise, which may queue further jobs; the drain
    /// continues until the queue empties. Metering accumulates through the
    /// reactions, matching the oracle shim's post-`fxRunScript` drain.
    pub(in crate::interp) fn run_promise_jobs(&mut self, code: &[u8]) -> Result<(), Step> {
        while let Some(job) = self.promise_jobs.pop_front() {
            self.run_promise_job(code, job)?;
        }
        Ok(())
    }

    /// Run one queued promise job. A **reaction** job is XS's
    /// `fxOnResolvedPromise`/`fxOnRejectedPromise` trampoline: the handler (if
    /// present) runs against the settled value, then the derived promise is
    /// resolved with the handler's result (or the pass-through value when no
    /// handler), or rejected with the thrown value if the handler throws. A
    /// **thenable** job is XS's `fxOnThenable`: it calls `then.call(thenable,
    /// resolve, reject)`.
    fn run_promise_job(&mut self, code: &[u8], job: PromiseJob) -> Result<(), Step> {
        let (reaction, value, rejected) = match job {
            PromiseJob::Reaction {
                reaction,
                value,
                rejected,
            } => (reaction, value, rejected),
            PromiseJob::Thenable {
                then,
                thenable,
                resolve,
                reject,
            } => return self.run_thenable_job(code, then, thenable, resolve, reject),
        };
        // A **native** reaction drives dedicated C behavior rather than a user
        // handler + derived-promise settle. `AsyncAwait(inst)` resumes the
        // suspended async instance with the settled value: a fulfilled promise
        // resumes `NoStatus` (the resolved value becomes the `await` expression's
        // result), a rejected one resumes `Throw` (the reason is re-thrown into
        // the body). XS's `fxResolveAwait`/`fxRejectAwait` → `fxStepAsync`.
        if let ReactionKind::AsyncAwait(inst) = reaction.kind {
            // The `fxOnResolvedPromise`/`fxOnRejectedPromise` trampoline runs the
            // native `fxResolveAwait`/`fxRejectAwait` as its handler (a
            // `mxRunCount` frame), like a user-handler job.
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            let status = if rejected {
                ResumeStatus::Throw
            } else {
                ResumeStatus::NoStatus
            };
            return self.step_async(code, inst, status, value, false);
        }
        if let ReactionKind::AsyncGeneratorAwait(gen) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            let status = if rejected {
                ResumeStatus::Throw
            } else {
                ResumeStatus::NoStatus
            };
            return self.step_async_generator(code, gen, status, value, false);
        }
        if let ReactionKind::AsyncGeneratorYield(gen) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            if rejected {
                let data = self.async_generators.get_mut(&gen).ok_or(Step::Host(
                    Halt::EngineInvariant("async-generator:yield-reaction-missing"),
                ))?;
                data.state = AsyncGeneratorState::Completed;
                data.frame = None;
                return self.finish_async_generator_request(code, gen, value, true);
            }
            let result = self.new_generator_result(value, false);
            self.async_generators.get_mut(&gen).unwrap().state =
                AsyncGeneratorState::SuspendedYield;
            return self.finish_async_generator_request(code, gen, result, false);
        }
        if let ReactionKind::AsyncGeneratorReturn(gen) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            if rejected {
                return self.finish_async_generator_request(code, gen, value, true);
            }
            let result = self.new_generator_result(value, true);
            return self.finish_async_generator_request(code, gen, result, false);
        }
        // The `finally` native reaction: run `onFinally` and pass the
        // settlement through (the `fxOnResolvedPromise`/`fxOnRejectedPromise`
        // trampoline frame).
        if reaction.kind == ReactionKind::FinallyReturn {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.run_finally_reaction(code, reaction, value, rejected);
        }
        // The promise returned by `onFinally` has now settled. Its rejection
        // overrides the original completion; fulfillment restores the
        // original value/reason captured in `on_fulfilled`.
        if let ReactionKind::FinallyAwait(original_rejected) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            let (settle_value, settle_reject) = if rejected {
                (value, true)
            } else {
                (reaction.on_fulfilled, original_rejected)
            };
            return self.settle_capability(
                code,
                reaction.resolve,
                reaction.reject,
                settle_value,
                settle_reject,
            );
        }
        // A combinator element reaction: fold this element's settlement into
        // the shared `Promise.all`/`allSettled`/`race`/`any` state.
        if let ReactionKind::Combine(ci, ei) | ReactionKind::CombineDirect(ci, ei) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.run_combine_reaction(code, ci as usize, ei as usize, value, rejected);
        }
        // An `Array.fromAsync` native async-machine await resumption.
        if let ReactionKind::FromAsyncNext(id) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.from_async_resume_next(code, id as usize, value, rejected);
        }
        if let ReactionKind::FromAsyncElem(id) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.from_async_resume_elem(code, id as usize, value, rejected);
        }
        if let ReactionKind::FromAsyncMap(id) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.from_async_resume_map(code, id as usize, value, rejected);
        }
        if let ReactionKind::FromAsyncClose(id) = reaction.kind {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
            return self.from_async_resume_close(id as usize);
        }
        let handler = if rejected {
            reaction.on_rejected
        } else {
            reaction.on_fulfilled
        };
        // The `fxOnResolvedPromise`/`fxOnRejectedPromise` frame: a job WITH a
        // handler runs two `mxRunCount`s (the handler, modeled by
        // `run_callback`, then the settle); a pass-through job (no handler)
        // runs only the settle, so it skips the handler-call framing.
        if handler.kind == Kind::Undefined {
            self.meter.tick_raw(PROMISE_JOB_PASSTHROUGH_FRAME_METERING);
        } else {
            self.meter.tick_raw(PROMISE_JOB_FRAME_METERING);
        }
        // The default outcome: with no handler, a fulfilled job resolves the
        // capability with the value, a rejected job rejects it with the reason
        // (pass-through).
        let (settle_value, settle_reject) = if handler.kind == Kind::Undefined {
            (value, rejected)
        } else {
            // Run the handler(value). Success → resolve the derived with the
            // result; a throw → the derived is REJECTED with the thrown value
            // (XS's `fxOnResolvedPromise` `mxCatch`: `*argument = mxException;
            // function = rejectFunction`). The thrown value arrives in the
            // `Halt::Throw` the native try catches at the host boundary.
            // The handler may be any callable — a user function, or a native /
            // bound / **promise resolving function** (the last is what
            // `promise.then(resolveFn, rejectFn)` installs, e.g. test262's
            // `assert.throwsAsync`). Dispatch through `call_any` so a native
            // reaction handler settles correctly rather than self-naming.
            // The job has been dequeued. Its capability must remain reachable
            // while the guest handler runs, even when nothing else retains the
            // derived promise. Both functions are needed until we know whether
            // the handler returned or threw. Callable slots contain stable slot
            // identities; their function metadata is relocated by the collector.
            let root_sp = self.stack.len();
            self.stack.extend([reaction.resolve, reaction.reject]);
            let handled =
                self.call_any_catching_throw(code, handler, Slot::undefined(), &[value])?;
            self.stack.truncate(root_sp);
            match handled {
                Ok(r) => (r, false),
                Err(thrown) => (thrown, true),
            }
        };
        // Call the captured capability function. For the intrinsic capability
        // this retains the direct promise-settlement path; a custom species
        // constructor's callbacks are invoked observably.
        self.settle_capability(
            code,
            reaction.resolve,
            reaction.reject,
            settle_value,
            settle_reject,
        )
    }

    /// Run a resolve-with-thenable job (XS's `fxOnThenable`): call
    /// `then.call(thenable, resolve, reject)`. The `then` body typically calls
    /// `resolve`/`reject` synchronously (each a modeled resolving function that
    /// settles the promise through [`Self::call_promise_function`]). A `then`
    /// that throws rejects via the reject function (`fxRejectException`).
    fn run_thenable_job(
        &mut self,
        code: &[u8],
        then: Slot,
        thenable: Slot,
        resolve: Slot,
        reject: Slot,
    ) -> Result<(), Step> {
        self.meter.tick_raw(PROMISE_THENABLE_JOB_FRAME_METERING);
        // The dequeued job still owns these functions when a callable proxy
        // discards its arguments. In particular, reject must survive a throw.
        let root_sp = self.stack.len();
        self.stack.extend([resolve, reject]);
        let called = self.run_callback_catching_throw(code, then, thenable, &[resolve, reject])?;
        self.stack.truncate(root_sp);
        match called {
            Ok(_) => Ok(()),
            Err(thrown) => self.reject_via_function(reject, thrown),
        }
    }

    /// Register a fully-built native reaction on `promise` (the shared core of
    /// [`Self::promise_then_native`] and the `finally`/combinator paths): a
    /// null-capability reaction (5 `fxNewSlot`s, no derived `__result__` slot)
    /// whose `kind` the drain dispatches on. A pending promise appends it (+1
    /// THENS-list slot); an already-settled promise queues the job now. Marks
    /// the promise handled for the unhandled-rejection latch.
    fn register_native_reaction(
        &mut self,
        promise: crate::value::SlotIndex,
        reaction: PromiseReaction,
    ) {
        for _ in 0..5 {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw(PROMISE_REACTION_METERING);
        self.promises.get_mut(&promise).unwrap().ever_handled = true;
        let state = self.promises[&promise].state;
        match state {
            PromiseState::Pending => {
                self.meter.tick_slot_alloc();
                self.promises
                    .get_mut(&promise)
                    .unwrap()
                    .reactions
                    .push(reaction);
            }
            PromiseState::Fulfilled | PromiseState::Rejected => {
                let value = self.promises[&promise].result;
                let rejected = state == PromiseState::Rejected;
                self.queue_promise_job(PromiseJob::Reaction {
                    reaction,
                    value,
                    rejected,
                });
            }
        }
    }

    /// `Promise.prototype.finally(onFinally)` (`fx_Promise_prototype_finally`):
    /// register a native FINALLY reaction carrying `onFinally` (in the
    /// reaction's `on_fulfilled` slot) plus the derived promise's capability,
    /// and return the derived promise. The reaction runs `onFinally` at the
    /// drain and passes the original settlement through
    /// ([`Self::run_finally_reaction`]).
    fn promise_finally(
        &mut self,
        code: &[u8],
        promise: crate::value::SlotIndex,
        on_finally: Slot,
        constructor: Slot,
    ) -> Result<Slot, Step> {
        self.meter.tick_raw(PROMISE_FINALLY_FRAME_METERING);
        let capability = self.new_promise_capability_for(code, constructor)?;
        let reaction = PromiseReaction {
            on_fulfilled: on_finally,
            // The selected species constructor is needed again at the job
            // drain for `PromiseResolve(C, onFinally())`.
            on_rejected: constructor,
            resolve: capability.resolve,
            reject: capability.reject,
            kind: ReactionKind::FinallyReturn,
        };
        self.register_native_reaction(promise, reaction);
        Ok(capability.promise)
    }

    /// `SpeciesConstructor(promise, %Promise%)` for `Promise.prototype.then`
    /// and `Promise.prototype.finally`. The constructor and `@@species` reads are
    /// observable through accessors and proxies; `undefined` constructor and
    /// nullish species select the realm's intrinsic Promise constructor.
    fn promise_species_constructor(&mut self, code: &[u8], promise: Slot) -> Result<Slot, Step> {
        let promise_inst = match promise.value {
            Payload::Reference(inst) if promise.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let default_ref = *self
            .intrinsics
            .get("Promise")
            .expect("Promise intrinsic is linked");
        let default = Slot::of(Kind::Reference, Payload::Reference(default_ref));
        let constructor_id = self.intern_static_key("constructor");
        let constructor = self.mop_get(code, promise_inst, constructor_id, promise)?;
        if constructor.kind == Kind::Undefined {
            return Ok(default);
        }
        let constructor_inst = match constructor.value {
            Payload::Reference(inst) if constructor.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("no constructor".into())),
        };
        let species_id = self
            .well_known_symbol_property_id("species")
            .expect("well-known species symbol");
        let species = self.mop_get(code, constructor_inst, species_id, constructor)?;
        let selected = if matches!(species.kind, Kind::Null | Kind::Undefined) {
            default
        } else {
            species
        };
        if !self.is_constructor_value(selected) {
            return Err(self.catchable_type_error_msg("no constructor".into()));
        }
        Ok(selected)
    }

    /// `PromiseResolve(C, x)` for the constructor selected by `finally`.
    /// A branded promise whose observable constructor is `C` is returned
    /// unchanged; every other value is resolved through a fresh capability so
    /// custom constructors and resolving callbacks remain observable.
    fn promise_resolve_with_constructor(
        &mut self,
        code: &[u8],
        constructor: Slot,
        value: Slot,
    ) -> Result<Slot, Step> {
        if let Payload::Reference(inst) = value.value {
            if value.kind == Kind::Reference && self.promises.contains_key(&inst) {
                let constructor_id = self.intern_static_key("constructor");
                let observed = self.mop_get(code, inst, constructor_id, value)?;
                if self.same_value(observed, constructor) {
                    return Ok(value);
                }
            }
        }
        let capability = self.new_promise_capability_for(code, constructor)?;
        self.call_any(code, capability.resolve, Slot::undefined(), &[value])?;
        Ok(capability.promise)
    }

    /// Observable entry path for `Promise.prototype.finally`. A non-callable
    /// handler is fully generic and is forwarded unchanged to the receiver's
    /// once-read `then`. A callable handler uses the direct native-reaction
    /// representation for an intrinsic promise/`then`; every other receiver
    /// gets the specification's anonymous `thenFinally` and `catchFinally`
    /// closures, whose captured state persists with the Promise cluster.
    pub(in crate::interp) fn promise_finally_dispatch(
        &mut self,
        code: &[u8],
        promise: Slot,
        on_finally: Slot,
    ) -> Result<Slot, Step> {
        let promise_inst = match promise.value {
            Payload::Reference(inst) if promise.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let constructor = self.promise_species_constructor(code, promise)?;
        let then_id = self.intern_static_key("then");
        let then = self.mop_get(code, promise_inst, then_id, promise)?;
        if !self.is_callable_value(then) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        if !self.is_callable_value(on_finally) {
            self.meter.tick_raw(PROMISE_FINALLY_FRAME_METERING);
            return self.call_any(code, then, promise, &[on_finally, on_finally]);
        }

        let intrinsic_then = matches!(then.value,
            Payload::Reference(function)
                if self.method_of(function) == Some(NativeMethod::PromiseThen));
        if self.promises.contains_key(&promise_inst) && intrinsic_then {
            return self.promise_finally(code, promise_inst, on_finally, constructor);
        }
        self.meter.tick_raw(PROMISE_FINALLY_FRAME_METERING);
        let then_finally = self.make_promise_finally_handler(on_finally, constructor, false);
        let catch_finally = self.make_promise_finally_handler(on_finally, constructor, true);
        self.call_any(code, then, promise, &[then_finally, catch_finally])
    }

    /// The drain behavior of a `Promise.prototype.finally` reaction: recover the
    /// derived promise, run `onFinally()` (a user function, no args) when
    /// callable, then settle the derived with the ORIGINAL `(value, rejected)`
    /// pass-through. A non-callable `onFinally` is a pure pass-through
    /// (`this.then(x, x)`). A callable result is normalized through the
    /// intrinsic Promise constructor and a persisted `FinallyAwait` reaction
    /// sequences the derived promise behind it.
    fn run_finally_reaction(
        &mut self,
        code: &[u8],
        reaction: PromiseReaction,
        value: Slot,
        rejected: bool,
    ) -> Result<(), Step> {
        // The active job is no longer in the queue. Keep its capability,
        // constructor and original settlement live across the callback. Read
        // the settlement back from the stack because a string/BigInt may move.
        let root_sp = self.stack.len();
        self.stack.extend([
            reaction.resolve,
            reaction.reject,
            reaction.on_rejected,
            value,
        ]);
        let outcome = (|| {
            let on_finally = reaction.on_fulfilled;
            if self.is_callable_value(on_finally) {
                match self.call_any_catching_throw(code, on_finally, Slot::undefined(), &[])? {
                    Ok(r) => self.await_finally_result(
                        code,
                        reaction,
                        r,
                        self.stack[root_sp + 3],
                        rejected,
                    ),
                    Err(thrown) => self.settle_capability(
                        code,
                        reaction.resolve,
                        reaction.reject,
                        thrown,
                        true,
                    ),
                }
            } else {
                self.settle_capability(code, reaction.resolve, reaction.reject, value, rejected)
            }
        })();
        // Host halts preserve the failed activation and its operands. Keep
        // this root range too; the next run resets the abandoned activation.
        if outcome.is_ok() {
            self.stack.truncate(root_sp);
        }
        outcome
    }

    /// Perform the default-native `PromiseResolve(C, result)` and
    /// `resultPromise.then(valueThunk, thrower)` portion of `finally` without
    /// allocating non-persisted closure state. Native promises use a
    /// `FinallyAwait` reaction directly. An observable custom `then` is called
    /// with a private resolving pair whose bridge promise carries that same
    /// reaction, retaining one-shot behavior and snapshot resumability.
    fn await_finally_result(
        &mut self,
        code: &[u8],
        reaction: PromiseReaction,
        result: Slot,
        original: Slot,
        original_rejected: bool,
    ) -> Result<(), Step> {
        // PromiseResolve and the observable constructor/then lookups can all
        // call guest code. Keep both values and the eventual promise in traced
        // storage until the original settlement reaches its await reaction.
        let root_sp = self.stack.len();
        self.stack.extend([result, original, Slot::undefined()]);
        let outcome = (|| {
            let constructor = reaction.on_rejected;

            // PromiseResolve returns an already-native promise unchanged only when
            // its observable constructor is the selected constructor.
            let identity = if let Payload::Reference(inst) = result.value {
                if result.kind == Kind::Reference && self.promises.contains_key(&inst) {
                    let constructor_id = self.intern_static_key("constructor");
                    match self
                        .array_from_try(|this| this.mop_get(code, inst, constructor_id, result))?
                    {
                        Ok(observed) => self.same_value(observed, constructor),
                        Err(error) => {
                            return self.settle_capability(
                                code,
                                reaction.resolve,
                                reaction.reject,
                                error,
                                true,
                            );
                        }
                    }
                } else {
                    false
                }
            } else {
                false
            };

            let awaited_slot = if identity {
                self.stack[root_sp]
            } else {
                let capability = match self
                    .array_from_try(|this| this.new_promise_capability_for(code, constructor))?
                {
                    Ok(capability) => capability,
                    Err(error) => {
                        return self.settle_capability(
                            code,
                            reaction.resolve,
                            reaction.reject,
                            error,
                            true,
                        );
                    }
                };
                self.stack[root_sp + 2] = capability.promise;
                match self.call_any_catching_throw(
                    code,
                    capability.resolve,
                    Slot::undefined(),
                    &[self.stack[root_sp]],
                )? {
                    Ok(_) => self.stack[root_sp + 2],
                    Err(error) => {
                        return self.settle_capability(
                            code,
                            reaction.resolve,
                            reaction.reject,
                            error,
                            true,
                        );
                    }
                }
            };
            self.stack[root_sp + 2] = awaited_slot;
            let awaited = match awaited_slot.value {
                Payload::Reference(inst) if awaited_slot.kind == Kind::Reference => inst,
                _ => {
                    let error = self.internal_error("TypeError", "call: not a function".into());
                    return self.settle_capability(
                        code,
                        reaction.resolve,
                        reaction.reject,
                        error,
                        true,
                    );
                }
            };
            let then_id = self.intern_static_key("then");
            self.install_pending_intrinsics();
            self.then_id = Some(then_id);
            let then = match self
                .array_from_try(|this| this.mop_get(code, awaited, then_id, awaited_slot))?
            {
                Ok(method) if self.is_callable_value(method) => method,
                Ok(_) => {
                    let error = self.internal_error("TypeError", "call: not a function".into());
                    return self.settle_capability(
                        code,
                        reaction.resolve,
                        reaction.reject,
                        error,
                        true,
                    );
                }
                Err(error) => {
                    return self.settle_capability(
                        code,
                        reaction.resolve,
                        reaction.reject,
                        error,
                        true,
                    )
                }
            };
            let await_reaction = PromiseReaction {
                on_fulfilled: self.stack[root_sp + 1],
                on_rejected: Slot::undefined(),
                resolve: reaction.resolve,
                reject: reaction.reject,
                kind: ReactionKind::FinallyAwait(original_rejected),
            };
            if self.promises.contains_key(&awaited)
                && matches!(then.value,
                Payload::Reference(function)
                    if self.method_of(function) == Some(NativeMethod::PromiseThen))
            {
                self.register_native_reaction(awaited, await_reaction);
                return Ok(());
            }

            let (bridge, bridge_resolve, bridge_reject) = self.new_promise_capability();
            self.register_native_reaction(bridge, await_reaction);
            // A callable proxy can discard its argument array before throwing.
            // The argument list alone therefore cannot keep the bridge alive
            // until we use its reject function after the call.
            self.stack.extend([bridge_resolve, bridge_reject]);
            match self.call_any_catching_throw(
                code,
                then,
                awaited_slot,
                &[bridge_resolve, bridge_reject],
            )? {
                Ok(_) => Ok(()),
                Err(error) => self.reject_via_function(bridge_reject, error),
            }
        })();
        // Host halts preserve the failed activation and its operands. Keep
        // this root range too; the next run resets the abandoned activation.
        if outcome.is_ok() {
            self.stack.truncate(root_sp);
        }
        outcome
    }

    /// `Promise.all`/`allSettled`/`race`/`any` (`fx_Promise_all` …): build the
    /// result capability and its shared [`CombinatorState`], consume the input's
    /// live iterator protocol, resolve each yielded value through the
    /// constructor's once-read `resolve` method, and register an element
    /// reaction on each result. Iterator advancement errors reject without
    /// closing; abrupt completions after a value is obtained close the iterator
    /// before rejecting. Native Promise inputs settle into shared state at the
    /// drain; callbacks invoked by a custom `then` do so synchronously.
    pub(in crate::interp) fn promise_combinator(
        &mut self,
        code: &[u8],
        kind: CombinatorKind,
        iterable: Slot,
        constructor: Slot,
    ) -> Result<Slot, Step> {
        // `NewPromiseCapability(C)` is outside the algorithm's rejection
        // conversion. Its abrupt completion must reach the caller's active
        // `try` statement synchronously.
        self.meter.tick_raw(PROMISE_COMBINATOR_FRAME_METERING);
        let capability = self.new_promise_capability_for(code, constructor)?;
        // Promise combinator algorithms catch every abrupt completion after
        // capability construction and reject that capability. Temporarily
        // hide the caller's jump targets so a getter/callback throw escapes to
        // the native boundary as a value instead of synchronously resuming the
        // caller's surrounding `try` statement.
        self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.promise_combinator_inner(code, kind, iterable, constructor, capability)
        })
    }

    fn promise_combinator_inner(
        &mut self,
        code: &[u8],
        kind: CombinatorKind,
        iterable: Slot,
        constructor: Slot,
        capability: PromiseCapability,
    ) -> Result<Slot, Step> {
        // Static combinators use their `this` value directly as the capability
        // constructor; unlike `.then`, they must not consult `@@species`.
        // Capability construction happens before every caught algorithm step,
        // so a constructor failure remains a synchronous abrupt completion.
        let result_promise = capability.promise;
        let resolve = capability.resolve;
        let reject = capability.reject;

        // GetPromiseResolve(C) precedes GetIterator in the current algorithm.
        // In particular, a throwing `resolve` getter must not invoke the
        // iterable's @@iterator method or attempt IteratorClose.
        let constructor_inst = match constructor.value {
            Payload::Reference(inst) if constructor.kind == Kind::Reference => inst,
            _ => {
                let error = self.internal_error("TypeError", "this: not an object".into());
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
        };
        let resolve_id = self.intern_static_key("resolve");
        self.install_pending_intrinsics();
        let promise_resolve = match self
            .array_from_try(|this| this.mop_get(code, constructor_inst, resolve_id, constructor))?
        {
            Ok(method) if self.is_callable_value(method) => method,
            Ok(_) => {
                let error = self.internal_error("TypeError", "resolve: not a function".into());
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
            Err(error) => {
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
        };

        // Intrinsic iterator result objects materialize only cached fields, so
        // seed the two IteratorResult keys before an intrinsic iterator runs.
        let value_id = self.intern_static_key("value");
        let done_id = self.intern_static_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);

        // GetMethod(iterable, @@iterator), including GetV through primitive
        // wrapper prototypes. Every abrupt completion after capability
        // creation becomes a rejection of the returned promise.
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match iterable.value {
            Payload::Reference(inst) if iterable.kind == Kind::Reference => {
                match self.array_from_try(|this| this.mop_get(code, inst, iterator_id, iterable))? {
                    Ok(method) => method,
                    Err(error) => {
                        self.settle_capability(code, resolve, reject, error, true)?;
                        return Ok(result_promise);
                    }
                }
            }
            _ => {
                let proto = match iterable.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&c| self.ctor_prototype.get(&c).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    Slot::undefined()
                } else {
                    match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, iterable))?
                    {
                        Ok(method) => method,
                        Err(error) => {
                            self.settle_capability(code, resolve, reject, error, true)?;
                            return Ok(result_promise);
                        }
                    }
                }
            }
        };
        if !self.is_callable_value(iterator_method) {
            let error = self.internal_error(
                "TypeError",
                match iterable.kind {
                    Kind::Null => "cannot coerce null to object",
                    Kind::Undefined => "cannot coerce undefined to object",
                    _ => "call: not a function",
                }
                .into(),
            );
            self.settle_capability(code, resolve, reject, error, true)?;
            return Ok(result_promise);
        }
        let iterator = match self.call_any_catching_throw(code, iterator_method, iterable, &[])? {
            Ok(iterator) if iterator.kind == Kind::Reference => iterator,
            Ok(_) => {
                let error = self.internal_error("TypeError", "iterator: not an object".into());
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
            Err(error) => {
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
        };
        let iterator_inst = match iterator.value {
            Payload::Reference(inst) => inst,
            _ => unreachable!(),
        };
        let next_id = self.intern_static_key("next");
        let next_method = match self
            .array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))?
        {
            Ok(method) if self.is_callable_value(method) => method,
            Ok(_) => {
                let error = self.internal_error("TypeError", "call: not a function".into());
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
            Err(error) => {
                self.settle_capability(code, resolve, reject, error, true)?;
                return Ok(result_promise);
            }
        };

        // Keep the specification's initial +1 sentinel while iteration is in
        // progress. Promise jobs do not drain until this call returns, so the
        // final decrement can safely happen after the live loop completes.
        let results = self.new_array();
        let comb_idx = self.combinators.len();
        self.combinators.push(CombinatorState {
            kind,
            resolve,
            reject,
            remaining: 1,
            results,
        });

        for index in 0..1_000_000u32 {
            let step = match self.call_any_catching_throw(code, next_method, iterator, &[])? {
                Ok(step) => step,
                Err(error) => {
                    // IteratorStepValue failures set [[Done]] and reject
                    // directly; IteratorClose must not run.
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
            };
            let step_inst = match step.value {
                Payload::Reference(inst) if step.kind == Kind::Reference => inst,
                _ => {
                    let error =
                        self.internal_error("TypeError", "iterator result: not an object".into());
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => {
                        self.settle_capability(code, resolve, reject, error, true)?;
                        return Ok(result_promise);
                    }
                };
            if self.truthy(&done) {
                self.arrays.get_mut(&results).unwrap().length = index;
                self.combinators[comb_idx].remaining -= 1;
                if self.combinators[comb_idx].remaining == 0 {
                    match self
                        .array_from_try(|this| this.settle_empty_combinator(code, comb_idx))?
                    {
                        Ok(()) => {}
                        Err(error) => {
                            self.settle_capability(code, resolve, reject, error, true)?;
                        }
                    }
                }
                return Ok(result_promise);
            }
            let value =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(value) => value,
                    Err(error) => {
                        self.settle_capability(code, resolve, reject, error, true)?;
                        return Ok(result_promise);
                    }
                };

            self.meter.tick_raw(PROMISE_COMBINATOR_PER_ELEMENT_METERING);
            self.combinators[comb_idx].remaining = self.combinators[comb_idx]
                .remaining
                .checked_add(1)
                .ok_or(Step::Host(Halt::StepLimit(self.n_dispatched)))?;
            let next_promise =
                match self.call_any_catching_throw(code, promise_resolve, constructor, &[value])? {
                    Ok(value) => value,
                    Err(error) => {
                        let error = self.array_from_close(code, iterator, error)?;
                        self.settle_capability(code, resolve, reject, error, true)?;
                        return Ok(result_promise);
                    }
                };
            let next_promise_inst = match next_promise.value {
                Payload::Reference(inst) if next_promise.kind == Kind::Reference => inst,
                _ => {
                    let error = self.internal_error(
                        "TypeError",
                        match next_promise.kind {
                            Kind::Null => "cannot coerce null to object",
                            Kind::Undefined => "cannot coerce undefined to object",
                            _ => "call: not a function",
                        }
                        .into(),
                    );
                    let error = self.array_from_close(code, iterator, error)?;
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
            };
            let then_id = self.intern_static_key("then");
            self.install_pending_intrinsics();
            self.then_id = Some(then_id);
            let then = match self.array_from_try(|this| {
                this.mop_get(code, next_promise_inst, then_id, next_promise)
            })? {
                Ok(method) if self.is_callable_value(method) => method,
                Ok(_) => {
                    let error = self.internal_error("TypeError", "call: not a function".into());
                    let error = self.array_from_close(code, iterator, error)?;
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
                Err(error) => {
                    let error = self.array_from_close(code, iterator, error)?;
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
            };

            if self.promises.contains_key(&next_promise_inst)
                && matches!(then.value,
                    Payload::Reference(function)
                        if self.method_of(function) == Some(NativeMethod::PromiseThen))
            {
                let reaction = PromiseReaction {
                    on_fulfilled: Slot::undefined(),
                    on_rejected: Slot::undefined(),
                    resolve: Slot::undefined(),
                    reject: Slot::undefined(),
                    kind: ReactionKind::Combine(comb_idx as u32, index),
                };
                self.register_native_reaction(next_promise_inst, reaction);
                continue;
            }

            // Promise resolving functions already provide exactly the
            // anonymous, length-1, non-constructable, one-shot callback shape
            // the per-element algorithms require. For all/allSettled/any, a
            // private bridge promise gives those callbacks a shared one-shot
            // guard while `CombineDirect` folds their calls into the shared
            // state synchronously. Race passes the result capability pair
            // itself, as specified. The bridge also keeps callbacks captured
            // by a custom `then` live and is represented by the promise cluster.
            let handlers = if kind == CombinatorKind::Race {
                (resolve, reject)
            } else {
                let (bridge, bridge_resolve, bridge_reject) = self.new_promise_capability();
                let reaction = PromiseReaction {
                    on_fulfilled: Slot::undefined(),
                    on_rejected: Slot::undefined(),
                    resolve: bridge_resolve,
                    reject: bridge_reject,
                    kind: ReactionKind::CombineDirect(comb_idx as u32, index),
                };
                self.register_native_reaction(bridge, reaction);
                match kind {
                    CombinatorKind::All => (bridge_resolve, reject),
                    CombinatorKind::AllSettled => (bridge_resolve, bridge_reject),
                    CombinatorKind::Any => (resolve, bridge_reject),
                    CombinatorKind::Race => unreachable!(),
                }
            };
            match self.call_any_catching_throw(
                code,
                then,
                next_promise,
                &[handlers.0, handlers.1],
            )? {
                Ok(_) => continue,
                Err(error) => {
                    let error = self.array_from_close(code, iterator, error)?;
                    self.settle_capability(code, resolve, reject, error, true)?;
                    return Ok(result_promise);
                }
            }
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// Settle a combinator whose iterable was empty: `all`/`allSettled` resolve
    /// with the empty results Array; `any` rejects with a zero-error
    /// `AggregateError`; `race` stays pending forever (no settlement).
    fn settle_empty_combinator(&mut self, code: &[u8], ci: usize) -> Result<(), Step> {
        let kind = self.combinators[ci].kind;
        let completion = match kind {
            CombinatorKind::All | CombinatorKind::AllSettled => {
                let results = self.combinators[ci].results;
                Some((
                    Slot::of(Kind::Reference, Payload::Reference(results)),
                    false,
                ))
            }
            CombinatorKind::Race => None,
            CombinatorKind::Any => {
                let agg = self.new_aggregate_error(Vec::new());
                Some((agg, true))
            }
        };
        if let Some((value, rejected)) = completion {
            let resolve = self.combinators[ci].resolve;
            let reject = self.combinators[ci].reject;
            self.settle_capability(code, resolve, reject, value, rejected)?;
        }
        Ok(())
    }

    /// The drain behavior of one combinator element reaction (XS's per-element
    /// resolve/reject closures over the shared `remainingElementsCount`).
    fn run_combine_reaction(
        &mut self,
        code: &[u8],
        ci: usize,
        ei: usize,
        value: Slot,
        rejected: bool,
    ) -> Result<(), Step> {
        let resolve = self.combinators[ci].resolve;
        let reject = self.combinators[ci].reject;
        match self.combinators[ci].kind {
            // `all`: reject on the first rejection; otherwise store the value
            // and resolve with the results Array once all have fulfilled.
            CombinatorKind::All => {
                if rejected {
                    self.settle_capability(code, resolve, reject, value, true)
                } else {
                    let results = self.combinators[ci].results;
                    self.array_set_dense(results, ei as u32, value);
                    self.combinators[ci].remaining -= 1;
                    if self.combinators[ci].remaining == 0 {
                        self.settle_capability(
                            code,
                            resolve,
                            reject,
                            Slot::of(Kind::Reference, Payload::Reference(results)),
                            false,
                        )
                    } else {
                        Ok(())
                    }
                }
            }
            // `allSettled`: never rejects; store a `{status, value|reason}`
            // record per element and resolve once all have settled.
            CombinatorKind::AllSettled => {
                let record = self.make_settled_record(value, rejected);
                let results = self.combinators[ci].results;
                self.array_set_dense(results, ei as u32, record);
                self.combinators[ci].remaining -= 1;
                if self.combinators[ci].remaining == 0 {
                    self.settle_capability(
                        code,
                        resolve,
                        reject,
                        Slot::of(Kind::Reference, Payload::Reference(results)),
                        false,
                    )
                } else {
                    Ok(())
                }
            }
            // `race`: the first element to settle (fulfill or reject) wins.
            CombinatorKind::Race => self.settle_capability(code, resolve, reject, value, rejected),
            // `any`: the first fulfillment wins; store each rejection's reason
            // and reject with an `AggregateError` once all have rejected.
            CombinatorKind::Any => {
                if !rejected {
                    self.settle_capability(code, resolve, reject, value, false)
                } else {
                    let results = self.combinators[ci].results;
                    self.array_set_dense(results, ei as u32, value);
                    self.combinators[ci].remaining -= 1;
                    if self.combinators[ci].remaining == 0 {
                        let errs: Vec<Slot> = {
                            let data = &self.arrays[&results];
                            (0..data.length)
                                .map(|i| {
                                    data.items()
                                        .get(&i)
                                        .copied()
                                        .unwrap_or_else(Slot::undefined)
                                })
                                .collect()
                        };
                        let agg = self.new_aggregate_error(errs);
                        self.settle_capability(code, resolve, reject, agg, true)
                    } else {
                        Ok(())
                    }
                }
            }
        }
    }

    /// Build an `allSettled` result record: `{status:"fulfilled", value}` for a
    /// fulfilled element, `{status:"rejected", reason}` for a rejected one. The
    /// keys/`status` string resolve through the global intern table so a guest
    /// `.status`/`.value`/`.reason` read hits the same ids.
    fn make_settled_record(&mut self, value: Slot, rejected: bool) -> Slot {
        let inst = self.new_object();
        let status_text: &[u8] = if rejected { b"rejected" } else { b"fulfilled" };
        let off = self.alloc_str_text(status_text);
        let status = Slot::of(Kind::String, Payload::String(off));
        self.define_descriptor_field(inst, "status", status);
        if rejected {
            self.define_descriptor_field(inst, "reason", value);
        } else {
            self.define_descriptor_field(inst, "value", value);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Build an `AggregateError` instance over `errors` (no message) — the
    /// rejection reason `Promise.any` produces when every element rejects.
    /// Shares the `errors`-Array installation with
    /// [`Self::build_aggregate_error`].
    fn new_aggregate_error(&mut self, errors: Vec<Slot>) -> Slot {
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get("AggregateError")
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name: "AggregateError",
                message: None,
                frames,
            },
        );
        let n = errors.len() as u64;
        self.meter
            .tick_raw(AGGREGATE_ERROR_EXTRA + n * AGGREGATE_ERROR_PER_ELEMENT);
        self.install_aggregate_errors(inst, errors);
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }
}
