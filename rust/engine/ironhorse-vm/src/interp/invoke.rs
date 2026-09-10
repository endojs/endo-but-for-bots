//! Callable dispatch and callbacks that can re-enter the interpreter.
use super::*;

impl Interp {
    /// Invoke a callback through the shared, complete ECMAScript `Call`
    /// dispatcher. Native algorithms use this name at callback-taking sites;
    /// keeping it as a thin wrapper prevents those sites from growing their
    /// own incompatible callable-shape subsets.
    pub(super) fn run_callback(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        self.invoke_value(code, func, this, args)
    }

    /// Invoke a known function callback with receiver `this` and `args`.
    /// Native methods and native callables use their frame-dispatch seams;
    /// bound functions return through the shared Call operation. Bytecode
    /// callbacks run nested dispatch until their frame returns, restoring the
    /// caller's activation. Propagate callback throws and meter aborts.
    pub(super) fn run_user_callback(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        // Resolve the callee to a known function row before selecting its
        // bytecode, native, method, or bound-function path.
        let f = match func.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "callback:non-user-function",
                )))
            }
        };
        // A bound wrapper has no bytecode body of its own. Route it back
        // through the shared abstract Call operation, which recursively
        // composes all bound argument lists and supports user, native, method,
        // and proxy targets without ever entering that bodyless wrapper.
        if self.bound_functions.contains_key(&f) {
            return self.invoke_value(code, func, this, args);
        }
        let (this_eff, func_eff, args_eff): (Slot, Slot, Vec<Slot>) =
            if let Some(m) = self.method_of(f) {
                // A **native-method** callback (`a.map(nf.format)` — the
                // NumberFormat bound-format function; or any prototype method
                // passed by reference). Dispatch it through the same seam
                // `invoke_getter` uses: build the [THIS, FUNCTION, RESULT, FRAME]
                // frame + args and call `call_native_method`. A bound native
                // (`nf.format`) recovers its owning instance from its side table,
                // not from `this`, so the callback's `this` is irrelevant. On a
                // throw `call_native_method` returns WITHOUT truncating, so the
                // stack is restored to `base` before propagating.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_native_method(m, base, args.len(), code) {
                    Ok(()) => self.pop_checked(),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            } else if let Some(native) = self.functions[&f].native {
                // A native *callable* callback (`[..].map(parseInt)`,
                // `[..].forEach(print)`, `arr.filter(Boolean)`, …). It reaches
                // the `call_native` seam rather than `call_native_method`; drive
                // it through the same in-place frame the native-method branch
                // uses. A native *constructor* invoked as a callback (no `new`,
                // so `has_target = false`) either produces its call-completion
                // or throws a catchable TypeError inside `call_native`, matching
                // the oracle. On a throw `call_native` may return WITHOUT
                // truncating, so restore the stack to `base` before propagating.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_native(native, base, args.len(), false, code) {
                    Ok(()) => self.pop_checked(),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            } else {
                (this, func, args.to_vec())
            };
        let argc = args_eff.len();
        // Push the callee frame geometry [THIS, FUNCTION, RESULT, FRAME] + args.
        self.push(this_eff);
        self.push(func_eff);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for a in &args_eff {
            self.push(*a);
        }
        let body_start = self.enter_call(argc, 0, false)?;
        // After `enter_call` the callee frame's `CallerState` is on the call
        // stack; run until its `END` pops the stack back to this depth.
        let return_depth = self.call_stack.len();
        // Dispatch over the callee's own buffer when it lives in a different
        // segment than the caller's `code` (an eval-defined function handed to
        // a native driver such as `Array.prototype.map`, or the `Function`
        // result invoked as a callback). Same-segment callbacks keep using the
        // passed `code` with no allocation.
        let callee_seg = match func_eff.value {
            Payload::Reference(f) => self.callee_segment(f),
            _ => None,
        };
        let seg_buf = if callee_seg == self.active_segment {
            None
        } else {
            self.segment_buffer(callee_seg)
        };
        let saved_segment = self.active_segment;
        if seg_buf.is_some() {
            self.active_segment = callee_seg;
        }
        let body_code: &[u8] = match &seg_buf {
            Some(buf) => &buf[..],
            None => code,
        };
        let outcome = self.dispatch_at(body_code, body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            // Only this activation's normal return supplies a callback result.
            // A caller's handler travels outward as Step::Unwound instead.
            Step::Returned => self.pop_checked(),
            other => Err(other),
        }
    }

    /// Run a callback behind a native `mxTry` boundary ([`Self::native_try`]).
    /// Promise executors, thenable jobs and disposers catch a guest throw in
    /// native code: the callback activation is abandoned, the thrown value is
    /// returned as `Ok(Err(thrown))`, and the caller rejects with it instead
    /// of the machine halting or a surrounding guest `try` observing it.
    pub(super) fn run_callback_catching_throw(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Result<Slot, Slot>, Step> {
        self.native_try(|machine| machine.run_callback(code, func, this, args))
    }

    /// Dispatch a plain (non-`new`) call to an intrinsic native function.
    /// The value stack below the `argc` args holds the frame geometry
    /// `[THIS, FUNCTION, RESULT, FRAME]` beginning at `base`; the handler
    /// reads its arguments, collapses the whole `[THIS..argN-1]` region to a
    /// single result slot (XS's `mxStack = mxFrameEnd; *mxStack =
    /// *mxFrameResult`), and meters exactly what the C built-in meters.
    /// A native whose call behavior ironhorse does not yet model returns
    /// [`Halt::NotImplemented`] naming the built-in — an honest skip, never a
    /// mis-executed result.
    pub(super) fn call_native(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        has_target: bool,
        code: &[u8],
    ) -> Result<(), Step> {
        // The native-constructor/function dispatcher is one of the two
        // monolithic activations of this crate (with `call_native_method`):
        // charge the native-recursion budget's heavy class for it, so a
        // built-in that re-enters another built-in or guest code (through
        // `invoke_value`/`construct_value`; a guest callback's own
        // `dispatch_at` beneath it charges itself) is bounded by
        // [`NATIVE_DEPTH_LIMIT`] rather than by the host stack.
        self.with_native_frame(HEAVY_FRAME_COST, |vm| {
            vm.call_native_inner(native, base, argc, has_target, code)
        })
    }

    /// Normalize one operation executed behind a native try boundary
    /// (Array.from's steps, the resolving function's `Get(resolution,
    /// "then")`). A JS throw becomes its realm value; an implementation halt
    /// remains a halt. This is [`Self::native_try`]: the fence is taken
    /// BEFORE the operation runs, so a caller's live `try` never sees the
    /// throw — classifying afterwards let `Promise.resolve({ get then() {
    /// throw 5 } })` land in the caller's catch where XS rejects the promise.
    pub(super) fn array_from_try<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<Result<T, Slot>, Step> {
        self.native_try(operation)
    }

    /// Compatibility alias for the shared `Call(F, thisArg, args)` dispatcher.
    /// Kept at the iterator/Promise sites so their abstract-operation naming
    /// remains readable; all callable shapes are dispatched by
    /// [`Self::invoke_value`].
    pub(super) fn call_any(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        self.invoke_value(code, func, this, args)
    }

    /// [`Self::call_any`] under a native `mxTry` ([`Self::native_try`]): a JS
    /// throw is captured as `Ok(Err(thrown))`, a real host halt propagates.
    pub(super) fn call_any_catching_throw(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Result<Slot, Slot>, Step> {
        self.native_try(|machine| machine.call_any(code, func, this, args))
    }

    /// `GetV(value, key)` followed by the callable check used by the `Invoke`
    /// abstract operation. Primitive receivers read through their realm
    /// wrapper prototype while retaining the primitive as the call receiver.
    pub(super) fn invoke_value_method(
        &mut self,
        code: &[u8],
        value: Slot,
        name: &'static str,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        if matches!(value.kind, Kind::Null | Kind::Undefined) {
            return Err(self.catchable_type_error_msg(
                if value.kind == Kind::Undefined {
                    "cannot coerce undefined to object"
                } else {
                    "cannot coerce null to object"
                }
                .into(),
            ));
        }
        let id = self.intern_static_key(name);
        let method = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.mop_get(code, inst, id, value)?
            }
            _ => {
                let proto = match value.kind {
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
                    return Err(self.catchable_type_error());
                }
                self.mop_get(code, proto, id, value)?
            }
        };
        if !self.is_callable_value(method) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.call_any(code, method, value, args)
    }

    pub(super) fn call_native_method(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<(), Step> {
        // The central native-method dispatch is the largest activation in the
        // crate. A method that invokes another native without entering
        // `dispatch_at` — `Array.prototype.join` stringifying an element that
        // is itself an array, `Function.prototype.call` trampolining, an
        // accessor's native setter re-entering itself — nests this frame on
        // the host stack, so it is charged at the heavy class and bounded by
        // [`NATIVE_DEPTH_LIMIT`].
        self.with_native_frame(HEAVY_FRAME_COST, |vm| {
            // These accessors can recursively Set their own copied descriptor.
            // Keep the large dispatch frame out of that forwarding cycle.
            if matches!(
                m,
                NativeMethod::IteratorConstructorSetter | NativeMethod::IteratorToStringTagSetter
            ) {
                vm.cost.on_builtin(m);
                let this = vm.stack.get(base).copied().unwrap_or_else(Slot::undefined);
                let arg0 = vm
                    .stack
                    .get(base + 4)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let result = vm.iterator_prototype_setter(code, m, this, arg0)?;
                vm.stack.truncate(base);
                vm.push(result);
                Ok(())
            } else {
                vm.call_native_method_inner(m, base, argc, code)
            }
        })
    }

    /// The single complete `Call(F, thisArg, args)` dispatcher. Promise
    /// resolving functions, bound chains, native functions/methods, bytecode
    /// functions, and callable proxies all route through this operation so
    /// abstract `Call` sites cannot recognize incompatible callable subsets.
    pub(super) fn invoke_value(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        initial_args: &[Slot],
    ) -> Result<Slot, Step> {
        // The bound-function fold and the `Function.prototype.call`/`apply`
        // trampolines below each redispatch to another callable. They loop
        // here rather than recurse: neither enters a charged frame, so a chain
        // `c = c.call.bind(c)` (bound wrapper → `call` → bound wrapper …) of
        // 10,000 links overflowed the host stack while the pinned XS completes
        // it. `owned_args` is the argument list the last step rebuilt; until a
        // step rebuilds one, `initial_args` serves.
        let mut func = func;
        let mut this = this;
        let mut owned_args: Option<Vec<Slot>> = None;
        loop {
            let args: &[Slot] = owned_args.as_deref().unwrap_or(initial_args);
            let f = match func.value {
                Payload::Reference(f) if func.kind == Kind::Reference => f,
                _ => return Err(self.catchable_type_error_msg("call: not a function".into())),
            };
            if self.proxies.contains_key(&f) {
                return self.proxy_call(code, f, this, args);
            }
            // Promise resolve/reject functions carry a native-method marker for
            // reflection, but their [[Call]] settles the captured promise.
            if self.promise_functions.contains_key(&f) {
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_promise_function(code, f, base, args.len()) {
                    Ok(()) => self.pop_checked(),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
            // BoundFunctionExoticObject.[[Call]] prepends this level's
            // arguments, substitutes its bound this, and redispatches the
            // target.
            if self.bound_functions.contains_key(&f) {
                // Fold the whole chain iteratively rather than recursing once
                // per wrapper: a 20,000-link chain overflowed the real thread
                // stack and aborted the host, while the pinned XS completes the
                // same program. `enter_construct_bound` already folds the
                // construct side this way. Each level prepends its own bound
                // arguments and replaces the receiver, and is charged exactly
                // as the recursive form charged it, so the meter is unchanged.
                // `bind` always allocates a fresh exotic whose target already
                // exists, so the chain is acyclic and this terminates.
                let mut current = f;
                let mut this_arg = this;
                let mut combined: Vec<Slot> = match owned_args.take() {
                    Some(rebuilt) => rebuilt,
                    None => Self::fill_scratch(
                        self.reserve_work_scratch(initial_args.len())?,
                        initial_args.iter().copied(),
                    ),
                };
                while let Some(data) = self.bound_functions.get(&current) {
                    let target = data.target;
                    let receiver = data.this_arg;
                    let length = data
                        .args
                        .len()
                        .checked_add(combined.len())
                        .ok_or(Step::Host(Halt::HeapExhausted))?;
                    self.charge_and_check(BIND_CALL_METERING + length as u64 * BIND_CALL_PER_ARG)?;
                    let mut next = self.reserve_scratch(length)?;
                    next.extend_from_slice(&self.bound_functions[&current].args);
                    next.extend_from_slice(&combined);
                    combined = next;
                    this_arg = receiver;
                    current = target;
                }
                func = Slot::of(Kind::Reference, Payload::Reference(current));
                this = this_arg;
                owned_args = Some(combined);
                continue;
            }
            let fi = match self.functions.get(&f) {
                Some(fi) => fi,
                None => return Err(self.catchable_type_error_msg("call: not a function".into())),
            };
            let native = fi.native;
            let method = fi.method;
            // Function.prototype.call/apply are themselves ordinary callable
            // built-ins whose receiver is the function to redispatch. The
            // opcode RUN path has an in-place trampoline for them, but abstract
            // Call sites arrive here without that opcode context. Handle the
            // same semantics at the shared dispatcher so a bound call/apply
            // function, a Proxy trap, or another native algorithm can invoke
            // them too.
            if method == Some(NativeMethod::FunctionCall) {
                if !self.is_callable_value(this) {
                    return Err(
                        self.catchable_type_error_msg("this: not a Function instance".into())
                    );
                }
                let this_arg = args.first().copied().unwrap_or_else(Slot::undefined);
                let tail = args.get(1..).unwrap_or_default();
                let forwarded = Self::fill_scratch(
                    self.reserve_work_scratch(tail.len())?,
                    tail.iter().copied(),
                );
                self.charge_and_check(
                    CALL_TRAMPOLINE_METERING + forwarded.len() as u64 * CALL_TRAMPOLINE_PER_ARG,
                )?;
                func = this;
                this = this_arg;
                owned_args = Some(forwarded);
                continue;
            }
            if method == Some(NativeMethod::FunctionApply) {
                if !self.is_callable_value(this) {
                    return Err(
                        self.catchable_type_error_msg("this: not a Function instance".into())
                    );
                }
                let this_arg = args.first().copied().unwrap_or_else(Slot::undefined);
                let arg_array = args.get(1).copied().unwrap_or_else(Slot::undefined);
                let (forwarded, array_read_meter) = if arg_array.kind == Kind::Undefined
                    || arg_array.kind == Kind::Null
                {
                    (Vec::new(), 0)
                } else {
                    if arg_array.kind != Kind::Reference {
                        return Err(self.catchable_type_error_msg("argArray: not an object".into()));
                    }
                    let forwarded = self.arraylike_to_vec(code, arg_array)?;
                    let meter = self.apply_arraylike_metering(arg_array, forwarded.len());
                    (forwarded, meter)
                };
                self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
                func = this;
                this = this_arg;
                owned_args = Some(forwarded);
                continue;
            }
            if native.is_some() || method.is_some() {
                // Native / native-method: build the [THIS, FUNCTION, RESULT,
                // FRAME] frame + args, dispatch, and take the pushed result.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                let result = if let Some(n) = native {
                    self.call_native(n, base, args.len(), false, code)
                } else {
                    self.call_native_method(method.unwrap(), base, args.len(), code)
                };
                return match result {
                    Ok(()) => self.pop_checked(),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
            return self.run_user_callback(code, func, this, args);
        }
    }

    /// Construct any constructor value with an explicit argument list — the
    /// substrate `Reflect.construct` and a proxy's default `[[Construct]]` need.
    /// A native constructor dispatches with the construct flag; a callable proxy
    /// routes to its `construct` trap; a user constructor re-enters through the
    /// construct-capable callback path.
    pub(super) fn construct_value(
        &mut self,
        code: &[u8],
        func: Slot,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let f = match func.value {
            Payload::Reference(f) if func.kind == Kind::Reference => f,
            _ => return Err(self.catchable_type_error_msg("new: not a constructor".into())),
        };
        if !self.is_constructor_value(func) {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        if self.proxies.contains_key(&f) {
            return self.proxy_construct(code, f, args, new_target);
        }
        if let Some(n) = self.native_of(f) {
            let target = match new_target.value {
                Payload::Reference(target) if new_target.kind == Kind::Reference => target,
                _ => return Err(self.catchable_type_error_msg("new: not a constructor".into())),
            };
            let base = self.stack.len();
            self.push(Slot::of(Kind::Uninitialized, Payload::None)); // THIS = construct flag
            self.push(func);
            self.push(Slot::undefined());
            self.push(Slot::of(Kind::Uninitialized, Payload::None));
            for a in args {
                self.push(*a);
            }
            // Plain `new Native` derives NewTarget from the function slot.
            // Reflect.construct can supply a distinct constructor; hand that
            // one-shot identity to native dispatch so it can select the
            // requested prototype without leaking into a later construction.
            let saved_pending_new_target = self.pending_new_target;
            self.pending_new_target = (target != f).then_some(target);
            let result = self.call_native(n, base, args.len(), true, code);
            self.pending_new_target = saved_pending_new_target;
            result?;
            return self.pop_checked();
        }
        // A user-defined constructor: re-enter with the construct geometry.
        self.run_callback_construct(code, func, args, new_target)
    }

    /// Run a user (bytecode) constructor to completion with an explicit
    /// argument list, returning the constructed object (ECMA-262 Ordinary
    /// [[Construct]] shape, modeled on [`Self::run_callback`] but with the
    /// construct flag set so the callee body's `this` is a fresh instance).
    /// A constructor retained from an earlier crank executes against its own
    /// persisted code segment, just like an ordinary cross-crank callback.
    pub(super) fn run_callback_construct(
        &mut self,
        code: &[u8],
        func: Slot,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let f = match func.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            _ => return Err(self.catchable_type_error()),
        };
        if self.functions[&f].native.is_some()
            || self.functions[&f].method.is_some()
            || self.bound_functions.contains_key(&f)
        {
            // Only a plain user constructor is driven here.
            return Err(Step::Host(Halt::NotImplemented(
                "proxy:construct-nonuser-target",
            )));
        }
        let _ = new_target;
        let argc = args.len();
        self.push(Slot::of(Kind::Uninitialized, Payload::None)); // THIS (construct)
        self.push(func);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for a in args {
            self.push(*a);
        }
        let body_start = self.enter_call(argc, 0, true)?;
        let return_depth = self.call_stack.len();
        let callee_seg = self.callee_segment(f);
        let seg_buf = if callee_seg == self.active_segment {
            None
        } else {
            self.segment_buffer(callee_seg)
        };
        let saved_segment = self.active_segment;
        if seg_buf.is_some() {
            self.active_segment = callee_seg;
        }
        let body_code: &[u8] = match &seg_buf {
            Some(buf) => &buf[..],
            None => code,
        };
        let outcome = self.dispatch_at(body_code, body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            Step::Returned => self.pop_checked(),
            other => Err(other),
        }
    }
}
