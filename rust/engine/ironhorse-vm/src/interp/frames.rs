//! Value-stack limits, call-frame entry, and normal return.
use super::*;

impl Interp {
    /// The slots the *active* frame holds live: the shared value stack, the
    /// current scope, the current arguments, and the frame quartet. Added
    /// to [`Self::frame_slots`] (the suspended frames) it mirrors XS's
    /// `stackTop - stack` closely enough that the overflow abort brackets
    /// XS's — over-counting slightly (the value stack still carries the
    /// pre-truncation frame region at a call site) rather than under, so
    /// ironhorse never *completes* a program XS overflows on.
    #[inline]
    pub(super) fn live_stack_slots(&self) -> usize {
        self.stack.len() + self.locals.len() + self.args.len() + FRAME_OVERHEAD_SLOTS
    }

    /// Total concurrent slot usage across the active and suspended frames
    /// (XS's `stackTop - stack`). The stack-overflow guard compares this
    /// against the fixed budget.
    #[inline]
    pub(super) fn stack_slots_in_use(&self) -> usize {
        self.frame_slots + self.live_stack_slots()
    }

    /// Whether allocating `extra` more slots would exhaust the fixed value
    /// stack (XS's `fxOverflow`: `stack + count < stackBottom`). The usable
    /// budget is [`STACK_SLOT_COUNT`] minus the reserved root band.
    #[inline]
    pub(super) fn would_overflow(&self, extra: usize) -> bool {
        self.stack_slots_in_use() + extra > STACK_SLOT_COUNT - STACK_SLOT_RESERVED
    }

    #[inline]
    pub(super) fn push(&mut self, s: Slot) {
        self.stack.push(s);
    }

    #[inline]
    pub(super) fn pop_checked(&mut self) -> Result<Slot, Step> {
        self.stack
            .pop()
            .ok_or(Step::Host(Halt::EngineInvariant("value-stack:underflow")))
    }

    /// Read an operand without manufacturing `undefined` for corrupt code.
    #[inline]
    pub(super) fn peek_checked(&self) -> Result<Slot, Step> {
        self.stack
            .last()
            .copied()
            .ok_or(Step::Host(Halt::EngineInvariant("value-stack:underflow")))
    }

    /// Charge `cost` budget units for a native activation about to be entered,
    /// or refuse with [`Halt::ReentryLimit`] when the charge would exceed
    /// [`NATIVE_DEPTH_LIMIT`]. Pair with [`Self::leave_native_frame`] around the
    /// activation (or use [`Self::with_native_frame`], which cannot forget to).
    #[inline]
    pub(super) fn enter_native_frame(&mut self, cost: usize) -> Result<(), Step> {
        if self.native_depth + cost > NATIVE_DEPTH_LIMIT {
            return Err(Step::Host(Halt::ReentryLimit {
                depth: self.native_depth + cost,
                limit: NATIVE_DEPTH_LIMIT,
            }));
        }
        self.native_depth += cost;
        Ok(())
    }

    /// Release the budget [`Self::enter_native_frame`] charged.
    #[inline]
    pub(super) fn leave_native_frame(&mut self, cost: usize) {
        debug_assert!(self.native_depth >= cost, "native-frame budget underflow");
        self.native_depth -= cost;
    }

    /// Run `f` as one guarded native activation of `cost` units: the
    /// budget is charged before `f` runs and released on every return path,
    /// including a `?` propagation inside `f`.
    #[inline]
    pub(super) fn with_native_frame<T>(
        &mut self,
        cost: usize,
        f: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<T, Step> {
        self.enter_native_frame(cost)?;
        let result = f(self);
        self.leave_native_frame(cost);
        result
    }

    /// One step of an iterative prototype-chain walk that may pass through a
    /// Proxy (`OrdinaryHasInstance`, `Object.prototype.isPrototypeOf`). A
    /// Proxy forwards `[[GetPrototypeOf]]` to its target, and a spec-legal
    /// cycle through one (`OrdinarySetPrototypeOf`'s cycle check stops at a
    /// Proxy) makes such a walk infinite — a stuck worker rather than a
    /// crashed one. Count the walk's Proxy steps in `proxy_steps` against the
    /// native-recursion budget, exactly what the recursive shape of the same
    /// walk would have consumed, so the cycle halts with
    /// [`Halt::ReentryLimit`] after at most the budget's worth of forwarding.
    /// Ordinary steps are free: an ordinary chain is acyclic by construction.
    pub(super) fn charge_proxy_chain_step(
        &self,
        object: crate::value::SlotIndex,
        proxy_steps: &mut usize,
    ) -> Result<(), Step> {
        if self.proxies.contains_key(&object) {
            *proxy_steps += LIGHT_FRAME_COST;
            if self.native_depth + *proxy_steps > NATIVE_DEPTH_LIMIT {
                return Err(Step::Host(Halt::ReentryLimit {
                    depth: self.native_depth + *proxy_steps,
                    limit: NATIVE_DEPTH_LIMIT,
                }));
            }
        }
        Ok(())
    }

    /// `XS_CODE_RUN`'s inline argument count (pushed as an integer just
    /// below the frame). The variadic `run` reads it off the stack.
    pub(super) fn pop_run_count(&mut self) -> Result<usize, Step> {
        match self.pop_checked()?.value {
            Payload::Integer(i) if i >= 0 => Ok(i as usize),
            _ => Err(Step::Host(Halt::EngineInvariant("run:argument-count"))),
        }
    }

    /// Enter a user-function call with `argc` arguments (`XS_CODE_RUN_ALL`).
    /// The value stack below the `argc` args holds the frame geometry
    /// `[THIS, FUNCTION, RESULT, FRAME]`; read the function and `this`,
    /// collect the arguments, unwind those `4 + argc` slots, save the
    /// caller's activation, and install the callee's fresh scope. Returns
    /// the callee body's start pc, or `Halt::Throw` when the callee is not a
    /// known user function (the covered grammar only calls functions it
    /// defined).
    pub(super) fn enter_call(
        &mut self,
        argc: usize,
        ret_pc: usize,
        has_target: bool,
    ) -> Result<usize, Step> {
        let base = self
            .stack
            .len()
            .checked_sub(argc)
            .and_then(|n| n.checked_sub(4))
            .ok_or(Step::Host(Halt::EngineInvariant("call:stack-underflow")))?; // THIS
        let func_slot = self.stack[base + 1];
        // Collect arguments (arg0 is the deepest of the argc; XS's
        // `mxFrameArgv(i) = mxFrame - 1 - i`).
        let args: Vec<Slot> = self.stack[base + 4..base + 4 + argc].to_vec();
        let this_val = self.stack[base];
        // Keep the existing conservative overflow decision, which includes
        // the pending tuple, but retire that tuple before any validation can
        // return or unwind. The reported slot count describes the cleaned
        // stack rather than retaining the old deliberate over-count.
        let exceeds_budget = self.would_overflow(FRAME_OVERHEAD_SLOTS + argc);
        self.stack.truncate(base);
        let func = match func_slot.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            // The callee is not callable (a non-function reference, or a
            // primitive). ECMA-262 `Call` (7.3.14) requires a **catchable**
            // TypeError here, not an uncatchable host abort — a program that
            // wraps the call in `try`/`catch` (or `assert.throws`) must observe
            // a realm-correct `TypeError` object. Raise it through the same
            // jump-buffer chain as the `throw` opcode. A handler in the current
            // frame is a *resume*, not a callee body address: preserve that
            // distinction with `Step::Unwound` so `RUN` does not enter the catch
            // target as though it were a function.
            _ => {
                let message = if has_target {
                    "new: not a constructor"
                } else {
                    "call: not a function"
                };
                return Err(self.catchable_type_error_msg(message.into()));
            }
        };
        // The single choke point every user-function dispatch funnels through.
        // A `None` body means the callee has no runnable bytecode — a bound
        // function (or any bodyless instance) that reached here past a missed
        // gate. Fail loud and self-named rather than dispatch at pc 0 (the
        // whole-program re-execution that aborts / silently diverges); the
        // in-range gates trampoline bound callees before they get here.
        let body_start = match self.functions[&func].body_start {
            Some(bs) => bs,
            None => return Err(Step::Host(Halt::EngineInvariant("bind:bound-callback"))),
        };
        // Stack-overflow guard (XS's `fxOverflow` on the callee's frame
        // allocation): entering this call suspends the caller (its frame
        // quartet, args, and scope stay live) and opens a fresh callee
        // frame. If the resulting concurrent slot count would cross the
        // fixed budget, abort to the host exactly as XS does — this is
        // what makes unbounded recursion overflow on ironhorse too, rather than
        // completing where XS aborts.
        let caller_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();
        // Opening the callee frame allocates its quartet and argument slots
        // on top of everything currently live (the caller's frame stays
        // suspended on the stack). If that crosses the fixed budget, abort
        // to the host exactly as XS's `fxOverflow`.
        if exceeds_budget {
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        // The caller's frame is now suspended: account its live slots.
        self.frame_slots += caller_footprint;
        // Save the caller's activation and install the callee's.
        self.call_stack.push(CallerState {
            global_env: self.capture_global_environment(),
            locals: std::mem::take(&mut self.locals),
            id_map: std::mem::take(&mut self.id_map),
            result: self.result,
            strict: self.strict,
            args: std::mem::take(&mut self.args),
            this_val: self.this_val,
            this_captures: std::mem::take(&mut self.this_captures),
            env: self.env,
            cur_func: self.cur_func,
            cur_target: self.cur_target,
            target_func: self.target_func,
            ret_pc,
        });
        self.switch_environment(self.functions[&func].global_env);
        self.result = Slot::undefined();
        self.strict = false;
        self.args = args;
        self.this_val = this_val;
        self.this_captures.clear();
        // Install the callee's captured `with`/eval environment (XS resets
        // `mxEnvironment` at frame setup to the function instance's closure
        // environment). A function defined inside a `with` has a closure
        // environment that chains (non-null prototype) to that `with`, so its
        // free names resolve through it; an ordinary function's closure
        // environment has a null prototype (or none), so the callee begins with
        // an empty environment — byte-identical to the pre-`with` engine. The
        // caller's head is saved above and restored by `leave_call`.
        let closures = self.functions.get(&func).map(|fi| fi.closures);
        self.env = match closures {
            Some(c) if !c.is_null() && !self.instance_prototype(c).is_null() => {
                Slot::of(Kind::Reference, Payload::Reference(c))
            }
            _ => Slot::undefined(),
        };
        self.cur_func = func;
        self.cur_target = has_target;
        self.target_func = if has_target {
            self.pending_new_target.take().unwrap_or(func)
        } else {
            crate::value::SlotIndex::NULL
        };
        Ok(body_start)
    }

    /// Apply the constructor-specific completion rules associated with the
    /// body's terminating opcode. In particular a derived constructor may
    /// return an object directly, but otherwise must have initialized `this`
    /// with `super()` and may not return a different primitive.
    pub(super) fn end_completion(&mut self, op: Opcode) -> Result<Slot, Step> {
        // An arrow frame may carry `mxFrameHasTarget` solely so its lexical
        // `new.target` is observable. It is still an ordinary call: XS's
        // `END_ARROW` always returns `mxFrameResult` and never substitutes the
        // captured `this` as a constructor completion.
        if op == Opcode::XS_CODE_END_ARROW {
            return Ok(self.result);
        }
        if !self.cur_target {
            return Ok(self.result);
        }
        match op {
            Opcode::XS_CODE_END_DERIVED => {
                if self.result.kind == Kind::Reference {
                    Ok(self.result)
                } else if self.result.kind == Kind::Undefined {
                    if self.this_val.kind == Kind::Uninitialized {
                        let error =
                            self.internal_error("ReferenceError", "this: not initialized".into());
                        Err(self.raise_js(error))
                    } else {
                        Ok(self.this_val)
                    }
                } else {
                    let error =
                        self.internal_error("TypeError", "result: invalid constructor".into());
                    Err(self.raise_js(error))
                }
            }
            _ if self.result.kind != Kind::Reference => Ok(self.this_val),
            _ => Ok(self.result),
        }
    }

    /// Leave a user-function call (`XS_CODE_END`): restore the caller's
    /// saved activation and return the pc to resume the caller at. The
    /// callee's result has already been captured by the caller of this
    /// method (which pushes it onto the shared value stack, matching XS's
    /// `mxStack = mxFrameEnd; *mxStack = *result`).
    pub(super) fn leave_call(&mut self) -> usize {
        let caller = self
            .call_stack
            .pop()
            .expect("leave_call with empty call stack");
        // The suspended caller is resumed: release its accounted frame
        // slots (the inverse of the `enter_call` accrual).
        self.frame_slots = self
            .frame_slots
            .saturating_sub(FRAME_OVERHEAD_SLOTS + caller.args.len() + caller.locals.len());
        self.locals = caller.locals;
        self.id_map = caller.id_map;
        self.result = caller.result;
        self.strict = caller.strict;
        self.args = caller.args;
        self.this_val = caller.this_val;
        self.this_captures = caller.this_captures;
        self.switch_environment(caller.global_env);
        self.env = caller.env;
        self.cur_func = caller.cur_func;
        self.cur_target = caller.cur_target;
        self.target_func = caller.target_func;
        caller.ret_pc
    }
}
