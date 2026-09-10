//! Function.call, Function.apply, and bound-constructor frame preparation.
use super::*;

impl Interp {
    /// Must a `.call`/`.apply` receiver take the abstract-Call dispatcher
    /// ([`Self::invoke_value`]) rather than the native-frame fast path? A
    /// promise resolving function, finally thunk, or capability executor
    /// (every function in `promise_functions`) carries a native-method marker
    /// for reflection but its [[Call]] settles a captured promise, and
    /// `Function.prototype.call`/`apply` themselves redispatch their
    /// receiver; `call_native_method` refuses all of them as "never reaches
    /// here", so `Function.prototype.apply.call({}, {}, [])` or
    /// `resolve.call(undefined, 1)` must not be sent there. `invoke_value`
    /// handles exactly these shapes.
    pub(super) fn needs_abstract_call(
        &self,
        target_ref: crate::value::SlotIndex,
        method: Option<NativeMethod>,
    ) -> bool {
        self.promise_functions.contains_key(&target_ref)
            || matches!(
                method,
                Some(NativeMethod::FunctionCall | NativeMethod::FunctionApply)
            )
    }

    /// Dispatch `native.call(thisArg, ...args)` or a bound receiver without
    /// entering the `.call` bytecode trampoline. Returns `false` for an
    /// ordinary user function, allowing its in-place trampoline to run.
    pub(super) fn call_dot_call_native(
        &mut self,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<bool, Step> {
        let target = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(target) {
            return Err(self.catchable_type_error_msg("this: not a Function instance".into()));
        }
        let target_ref = match target.value {
            Payload::Reference(r) => r,
            _ => return Ok(false),
        };
        let native = self.native_of(target_ref);
        let method = self.method_of(target_ref);
        let is_bound = self.bound_functions.contains_key(&target_ref);
        let is_proxy = self.proxies.contains_key(&target_ref);
        if native.is_none() && method.is_none() && !is_bound && !is_proxy {
            return Ok(false);
        }
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let forwarded: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc - 1)?,
                self.stack[base + 5..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let forwarded_len = forwarded.len();
        self.stack.truncate(base);
        self.charge_and_check(
            CALL_TRAMPOLINE_METERING + forwarded_len as u64 * CALL_TRAMPOLINE_PER_ARG,
        )?;
        if is_proxy {
            self.meter.tick_raw(CALLABLE_PROXY_DOT_TRAMPOLINE_METERING);
        }
        if is_bound || is_proxy || self.needs_abstract_call(target_ref, method) {
            let result = self.invoke_value(code, target, this_arg, &forwarded);
            return match result {
                Ok(value) => {
                    self.push(value);
                    Ok(true)
                }
                Err(halt) => {
                    self.stack.truncate(base);
                    Err(halt)
                }
            };
        }
        self.push(this_arg);
        self.push(target);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for arg in forwarded {
            self.push(arg);
        }
        if let Some(native) = native {
            self.call_native(native, base, forwarded_len, false, code)?;
        } else if let Some(method) = method {
            self.call_native_method(method, base, forwarded_len, code)?;
        }
        Ok(true)
    }

    /// Dispatch `native.apply(thisArg, argsArray)` or a bound receiver without
    /// entering a bytecode frame — the `.apply` analog of
    /// [`Self::call_dot_call_native`]. An ordinary user function returns
    /// `Ok(false)` for the in-place trampoline. Every native, native-method,
    /// and bound receiver accepts modeled array-like shapes through
    /// `CreateListFromArrayLike`.
    pub(super) fn call_dot_apply_native(&mut self, base: usize, code: &[u8]) -> Result<bool, Step> {
        let target = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(target) {
            return Err(self.catchable_type_error_msg("this: not a Function instance".into()));
        }
        let target_ref = match target.value {
            Payload::Reference(r) => r,
            _ => return Ok(false),
        };
        let native = self.native_of(target_ref);
        let method = self.method_of(target_ref);
        let is_bound = self.bound_functions.contains_key(&target_ref);
        let is_proxy = self.proxies.contains_key(&target_ref);
        if native.is_none() && method.is_none() && !is_bound && !is_proxy {
            return Ok(false);
        }
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // Expand the arguments array (arg 1 of `.apply`) into the forwarded
        // slice. A dense intrinsic Array retains the calibrated bulk path;
        // every other object takes observable CreateListFromArrayLike reads.
        let arg_array = self.stack.get(base + 5).copied();
        let (forwarded, array_read_meter) = match arg_array.map(|s| (s.kind, s.value)) {
            None | Some((Kind::Undefined, _)) | Some((Kind::Null, _)) => (Vec::new(), 0),
            Some((Kind::Reference, Payload::Reference(arr)))
                if self.arrays.contains_key(&arr) && !self.arguments_objects.contains(&arr) =>
            {
                let data = &self.arrays[&arr];
                let len = data.length;
                // Reads route through the counted-accessor view (the
                // seam's bulk-table discipline); no counts move.
                if data.items().len() != len as usize {
                    let args = self.arraylike_to_vec(code, arg_array.unwrap())?;
                    let meter = APPLY_ARRAY_BASE_METERING
                        + args.len() as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                } else {
                    let buffer = self.reserve_work_scratch(len as usize)?;
                    let data = &self.arrays[&arr];
                    let args = Self::fill_scratch(buffer, (0..len).map(|i| data.items()[&i]));
                    let meter =
                        APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                }
            }
            Some((Kind::Reference, _)) | Some((Kind::Instance, _)) => {
                let arg_slot = arg_array.unwrap();
                let args = self.arraylike_to_vec(code, arg_slot)?;
                let meter = self.apply_arraylike_metering(arg_slot, args.len());
                (args, meter)
            }
            Some(_) => return Err(self.catchable_type_error_msg("argArray: not an object".into())),
        };
        let forwarded_len = forwarded.len();
        self.stack.truncate(base);
        self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
        if is_proxy {
            self.meter.tick_raw(CALLABLE_PROXY_DOT_TRAMPOLINE_METERING);
        }
        if is_bound || is_proxy || self.needs_abstract_call(target_ref, method) {
            let result = self.invoke_value(code, target, this_arg, &forwarded);
            return match result {
                Ok(value) => {
                    self.push(value);
                    Ok(true)
                }
                Err(halt) => {
                    self.stack.truncate(base);
                    Err(halt)
                }
            };
        }
        self.push(this_arg);
        self.push(target);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for arg in forwarded {
            self.push(arg);
        }
        if let Some(native) = native {
            self.call_native(native, base, forwarded_len, false, code)?;
        } else if let Some(method) = method {
            self.call_native_method(method, base, forwarded_len, code)?;
        }
        Ok(true)
    }

    /// `Function.prototype.call` trampoline: reshape the call frame from
    /// `[f, callMethod, RESULT, FRAME, thisArg, args…]` into a direct call
    /// `[thisArg, f, RESULT, FRAME, args…]` and enter the receiver's body,
    /// so the receiver runs with `thisArg` as `this` and the trailing
    /// arguments, resuming the caller after this `run`. The receiver must be
    /// a user function (a native/method receiver self-names). Meters the fixed
    /// `.call` re-dispatch overhead ([`CALL_TRAMPOLINE_METERING`]) beyond the
    /// visible opcodes and the callee body.
    pub(super) fn enter_call_dot_call(
        &mut self,
        base: usize,
        argc: usize,
        ret_pc: usize,
    ) -> Result<usize, Step> {
        let f = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callee = match f.value {
            Payload::Reference(r)
                if self
                    .functions
                    .get(&r)
                    .map_or(false, |fi| fi.native.is_none() && fi.method.is_none()) =>
            {
                r
            }
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "call:non-user-function-receiver",
                )))
            }
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // A primitive `thisArg` is boxed to its wrapper object in a sloppy
        // callee (XS's `fxToInstance`) but left as-is in a strict callee. The
        // strictness is only known at the callee's `begin`, so the boxing (or
        // pass-through) is deferred there via [`Self::bind_this_sloppy`] /
        // `BEGIN_STRICT`: every primitive family uses its realm wrapper in a
        // sloppy callee, `undefined`/`null` bind to the global, and strict
        // callees retain the original value.
        let real_args: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc - 1)?,
                self.stack[base + 5..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let n = real_args.len();
        self.stack.truncate(base);
        self.stack.push(this_arg); // THIS
        self.stack.push(f); // FUNCTION (the receiver)
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in real_args {
            self.stack.push(a);
        }
        self.charge_and_check(CALL_TRAMPOLINE_METERING + n as u64 * CALL_TRAMPOLINE_PER_ARG)?;
        let body_start = self.enter_call(n, ret_pc, false)?;
        let callee_segment = self.callee_segment(callee);
        if callee_segment != self.active_segment {
            let result = self.dispatch_entered_cross_segment(body_start, callee_segment)?;
            self.push(result);
            Ok(ret_pc)
        } else {
            Ok(body_start)
        }
    }

    /// `Function.prototype.apply` trampoline for a user-function receiver:
    /// read the nullable array-like argument list, reshape the frame, and enter
    /// the receiver's body with the rebound `this`. A function retained from a
    /// prior crank is synchronously driven over its defining code segment.
    pub(super) fn enter_call_dot_apply(
        &mut self,
        base: usize,
        // Kept for signature symmetry with `enter_call`: `.apply`'s
        // own arity is immaterial — thisArg/argArray read positionally.
        _argc: usize,
        ret_pc: usize,
        code: &[u8],
    ) -> Result<usize, Step> {
        let f = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callee = match f.value {
            Payload::Reference(r)
                if self
                    .functions
                    .get(&r)
                    .map_or(false, |fi| fi.native.is_none() && fi.method.is_none()) =>
            {
                r
            }
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "apply:non-user-function-receiver",
                )))
            }
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // See `enter_call_dot_call`: sloppy/strict `this` normalization is
        // handled at the callee's `begin` for every primitive family.
        // The arguments array (the second argument). Absent/undefined/null is
        // the no-array subset (zero args). A **dense** Array instance forwards
        // its elements as the call arguments (XS reads `length` then each
        // element). A non-array object (an array-like / `arguments`) or a
        // sparse array uses CreateListFromArrayLike so holes read through the
        // prototype and accessor failures propagate.
        let arg_array = self.stack.get(base + 5).copied();
        let (real_args, array_read_meter) = match arg_array.map(|s| (s.kind, s.value)) {
            None | Some((Kind::Undefined, _)) | Some((Kind::Null, _)) => (Vec::new(), 0),
            Some((Kind::Reference, Payload::Reference(arr)))
                if self.arrays.contains_key(&arr) && !self.arguments_objects.contains(&arr) =>
            {
                let data = &self.arrays[&arr];
                let len = data.length;
                // Dense only: every index in `[0, length)` must be a present
                // compact element. A hole or materialized accessor needs the
                // observable property path.
                if data.items().len() != len as usize {
                    let args = self.arraylike_to_vec(code, arg_array.unwrap())?;
                    let meter = APPLY_ARRAY_BASE_METERING
                        + args.len() as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                } else {
                    let buffer = self.reserve_work_scratch(len as usize)?;
                    let data = &self.arrays[&arr];
                    let args = Self::fill_scratch(buffer, (0..len).map(|i| data.items()[&i]));
                    // The array path's fixed setup plus the per-element read +
                    // forwarding (`mxGetID(_length)` + `mxGetIndex(i)` + copy).
                    let meter =
                        APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                }
            }
            // A non-dense-array **object** argArray (array-like / `arguments` /
            // sparse array): `CreateListFromArrayLike` (ECMA-262 7.3.18) reads
            // `length` (`ToLength`) then each indexed element, with any getter
            // throw propagated. The shared helper below splits the residual
            // from the metering already paid by those property reads.
            Some((Kind::Reference, _)) | Some((Kind::Instance, _)) => {
                let arg_slot = arg_array.unwrap_or_else(Slot::undefined);
                let args = self.arraylike_to_vec(code, arg_slot)?;
                let meter = self.apply_arraylike_metering(arg_slot, args.len());
                (args, meter)
            }
            // A non-object, non-nullish argArray (a Boolean/Number/String/
            // Symbol/BigInt primitive): `CreateListFromArrayLike` step 2
            // (ECMA-262 7.3.18) throws a catchable TypeError.
            Some(_) => return Err(self.catchable_type_error_msg("argArray: not an object".into())),
        };
        let n = real_args.len();
        self.stack.truncate(base);
        self.stack.push(this_arg); // THIS
        self.stack.push(f); // FUNCTION (the receiver)
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in real_args {
            self.stack.push(a);
        }
        // The no-array base ([`CALL_TRAMPOLINE_METERING`]) plus the array
        // path's extra (`array_read_meter`); the per-element forwarding is
        // already folded into [`APPLY_ARRAY_PER_ELEMENT_METERING`].
        self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
        let body_start = self.enter_call(n, ret_pc, false)?;
        let callee_segment = self.callee_segment(callee);
        if callee_segment != self.active_segment {
            let result = self.dispatch_entered_cross_segment(body_start, callee_segment)?;
            self.push(result);
            Ok(ret_pc)
        } else {
            Ok(body_start)
        }
    }

    /// A bound function's **construct** (`new boundF(...)`, ECMA-262 10.4.1.2
    /// `[[Construct]]`): construct the ultimate target with the bound leading
    /// arguments prepended to the call arguments, and the fresh instance's
    /// `new.target` resolved to that ultimate target. The stack at `base` holds
    /// the construct frame `[THIS(uninit), FUNCTION(bound), RESULT, FRAME,
    /// callArgs...]`; reshape it to the target's construct frame and enter.
    ///
    /// The bound chain is walked to its ultimate target, prepending each
    /// level's bound args **inner-first** (`args = innerBound ++ … ++ outerBound
    /// ++ callArgs`, the fold of step 1's `boundArgs ++ argumentsList` down the
    /// chain). For the plain `new` operator the `new.target` supplied to the
    /// outermost bound is the bound itself, and step 5 (`SameValue(F, newTarget)
    /// → target`) applies at every level, so the effective `new.target` is the
    /// ultimate target — its `.prototype` becomes the instance's prototype
    /// (via [`Self::run_constructor`] reading `target_func`). A native or
    /// non-constructor ultimate target is not yet modeled and self-names.
    pub(super) fn enter_construct_bound(
        &mut self,
        bf: crate::value::SlotIndex,
        base: usize,
        argc: usize,
        ret_pc: usize,
    ) -> Result<usize, Step> {
        let call_args: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc)?,
                self.stack[base + 4..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let mut acc = call_args;
        let mut cur = bf;
        let target = loop {
            let data = &self.bound_functions[&cur];
            let t = data.target;
            let length = data
                .args
                .len()
                .checked_add(acc.len())
                .ok_or(Step::Host(Halt::HeapExhausted))?;
            let mut prepended = self.reserve_work_scratch(length)?;
            prepended.extend_from_slice(&self.bound_functions[&cur].args);
            prepended.extend_from_slice(&acc);
            acc = prepended;
            if self.bound_functions.contains_key(&t) {
                cur = t;
                continue;
            }
            match self.functions.get(&t) {
                Some(fi) if fi.native.is_none() && fi.method.is_none() => break t,
                _ => return Err(Step::Host(Halt::NotImplemented("bind:new-bound-target"))),
            }
        };
        let total = acc.len();
        self.stack.truncate(base);
        self.stack.push(Slot::uninitialized()); // THIS (construct placeholder)
        self.stack
            .push(Slot::of(Kind::Reference, Payload::Reference(target))); // FUNCTION
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in acc {
            self.stack.push(a);
        }
        // `new.target` resolves to the ultimate target (see the doc comment).
        self.pending_new_target = Some(target);
        self.charge_and_check(BIND_CALL_METERING + total as u64 * BIND_CALL_PER_ARG)?;
        self.enter_call(total, ret_pc, true)
    }
}
