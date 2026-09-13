//! Activation capture, reinstallation, and generator/async resume drivers.
use super::{
    AsyncGenRunFrame, AsyncGeneratorRequest, AsyncGeneratorState, AsyncRunFrame, CallerHandlers,
    CallerState, CatchJump, GenRunFrame, GenStatus, GeneratorState, Halt, Interp, Kind, Payload,
    ReactionKind, ResumeStatus, SavedFrame, SavedJump, Slot, Step, ASYNC_AWAIT_FASTPATH_CREDIT,
    ASYNC_AWAIT_GENERAL_METERING, ASYNC_GENERATOR_BRAND_REJECT_CALL_METERING,
    ASYNC_START_REJECT_BOUNDARY_METERING, ASYNC_STEP_SETTLE_METERING, FRAME_OVERHEAD_SLOTS,
    GENERATOR_RESULT_METERING, GENERATOR_RESUME_METERING, GENERATOR_YIELD_METERING,
};

pub(super) enum Suspension {
    Yield,
    Await,
}

impl Interp {
    /// Capture a running activation after its yielded/awaited value is popped.
    /// Relative jump cuts are rebased when another driver resumes this frame.
    /// Refuse an invalid stack cut before taking any activation state or charge.
    pub(super) fn suspend_activation(
        &mut self,
        stack_base: usize,
        jumps_base: usize,
        call_depth_base: usize,
        resume_pc: usize,
        suspension: Suspension,
    ) -> Result<SavedFrame, Halt> {
        if stack_base > self.stack.len() {
            return Err(match suspension {
                Suspension::Yield => Halt::EngineInvariant("yield:stack-underflow"),
                Suspension::Await => Halt::EngineInvariant("await:stack-underflow"),
            });
        }
        let stack_slice = self.stack.split_off(stack_base);
        let jumps = self
            .jumps
            .split_off(jumps_base)
            .into_iter()
            .map(|jump| SavedJump {
                target_pc: jump.target_pc,
                segment: jump.segment,
                stack_offset: jump.stack_len.saturating_sub(stack_base),
                locals_len: jump.locals_len,
                id_map: jump.id_map,
                call_depth_offset: jump.call_depth.saturating_sub(call_depth_base),
                env: jump.env,
                flag: jump.flag,
            })
            .collect();
        self.meter.tick_raw(GENERATOR_YIELD_METERING);
        Ok(SavedFrame {
            global_env: self.capture_global_environment(),
            locals: std::mem::take(&mut self.locals),
            id_map: std::mem::take(&mut self.id_map),
            args: std::mem::take(&mut self.args),
            this_val: self.this_val,
            env: self.env,
            cur_func: self.cur_func,
            cur_target: self.cur_target,
            target_func: self.target_func,
            strict: self.strict,
            result: self.result,
            stack_slice,
            jumps,
            resume_pc,
        })
    }

    /// Clone the freshly entered activation while its caller still needs it
    /// for leave_call. START opcodes have no private stack or jump entries yet.
    pub(super) fn fresh_activation(&self, resume_pc: usize) -> SavedFrame {
        SavedFrame {
            global_env: self.capture_global_environment(),
            locals: self.locals.clone(),
            id_map: self.id_map.clone(),
            args: self.args.clone(),
            this_val: self.this_val,
            env: self.env,
            cur_func: self.cur_func,
            cur_target: self.cur_target,
            target_func: self.target_func,
            strict: self.strict,
            result: self.result,
            stack_slice: Vec::new(),
            jumps: Vec::new(),
            resume_pc,
        }
    }

    /// Reinstall a saved activation above the driver's stack and call bases.
    /// Drivers retain their own fencing, sent-value, and completion policies.
    pub(super) fn reinstall_activation(
        &mut self,
        saved: SavedFrame,
        stack_base: usize,
        return_depth: usize,
    ) -> usize {
        self.locals = saved.locals;
        self.id_map = saved.id_map;
        self.args = saved.args;
        self.this_val = saved.this_val;
        self.switch_environment(saved.global_env);
        self.env = saved.env;
        self.cur_func = saved.cur_func;
        self.cur_target = saved.cur_target;
        self.target_func = saved.target_func;
        self.strict = saved.strict;
        self.result = saved.result;
        self.stack.extend(saved.stack_slice);
        // Legacy saved rows carry no explicit handler segment. Resolve them
        // only after all restore phases have installed the function cluster:
        // async instances restore before FUNC, generators restore after it.
        let restored_segment = self.func_segments.get(&self.cur_func).copied();
        self.jumps
            .extend(saved.jumps.into_iter().map(|jump| CatchJump {
                target_pc: jump.target_pc,
                segment: jump.segment.or(restored_segment),
                stack_len: stack_base + jump.stack_offset,
                locals_len: jump.locals_len,
                id_map: jump.id_map,
                call_depth: return_depth + jump.call_depth_offset,
                env: jump.env,
                flag: jump.flag,
                // Re-established on this resume: a throw reaching it pays
                // [`RESUMED_HANDLER_THROW_METERING`].
                rebased: true,
            }));
        saved.resume_pc
    }
}

impl Interp {
    /// Select the bytecode buffer a suspended body (generator / async /
    /// async-generator) must resume over. A body defined in an `eval` or
    /// dynamic-`Function` code segment resumes over *that* segment's persisted
    /// buffer, not the caller-supplied `code` — which is the segment the
    /// `.next`/await driver happens to run in, and would decode wrong bytes at
    /// the saved `resume_pc`. Returns the segment to install and an owned
    /// buffer handle when a cross-segment switch is needed; a `None` buffer
    /// keeps the caller's `code`. Mirrors the callback cross-segment routing in
    /// [`Self::run_callback`]; for a top-level body (`func` not in
    /// [`Self::func_segments`]) it is a no-op.
    fn resume_segment_buffer(
        &self,
        func: crate::value::SlotIndex,
    ) -> (Option<usize>, Option<std::rc::Rc<[u8]>>) {
        let callee_seg = self.callee_segment(func);
        if callee_seg == self.active_segment {
            (self.active_segment, None)
        } else {
            (callee_seg, self.segment_buffer(callee_seg))
        }
    }

    /// Build a generator `{value, done}` result object (`fxNewGeneratorResult`):
    /// a fresh `%Object.prototype%`-chained object with `value`/`done` own data
    /// properties, metering the calibrated [`GENERATOR_RESULT_METERING`]. The
    /// property ids are the program-local `value`/`done` symbols (resolved in
    /// `link_intrinsics`); a program that never names them still runs (the
    /// object is unread), so a `None` id just omits that property.
    pub(super) fn new_generator_result(&mut self, value: Slot, done: bool) -> Slot {
        self.meter.tick_raw(GENERATOR_RESULT_METERING);
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        // The `value`/`done` key ids are cached from the top-level program's
        // symbols (`bind_program_symbols`). When the generator was defined in
        // an `eval` / dynamic-`Function` unit that the *outer* program never
        // named `value`/`done` for, those caches are `None` — but the eval
        // unit's relink interned the names into the realm table, so fall back
        // to that shared table before omitting the property (else a completed
        // eval-generator's host-built `{value, done}` result would silently
        // drop both keys, rendering `{}` where XS renders `{done:true}`).
        let vid = self
            .value_id
            .or_else(|| self.symbol_ids.get("value").copied());
        let did = self
            .done_id
            .or_else(|| self.symbol_ids.get("done").copied());
        if let Some(vid) = vid {
            self.set_own_unmetered(result, vid, value);
        }
        if let Some(did) = did {
            self.set_own_unmetered(result, did, Slot::boolean(done));
        }
        Slot::of(Kind::Reference, Payload::Reference(result))
    }

    /// The `{value, done}` a `next`/`return`/`throw` on an already-completed
    /// generator produces (`fx_Generator_prototype_aux`, the `state == END`
    /// branch): `next` → `{undefined, true}`; `return(v)` → `{v, true}`;
    /// `throw(e)` re-throws `e`.
    fn generator_done_result(&mut self, status: GenStatus, sent: Slot) -> Result<Slot, Step> {
        match status {
            GenStatus::Next => Ok(self.new_generator_result(Slot::undefined(), true)),
            GenStatus::Return => Ok(self.new_generator_result(sent, true)),
            GenStatus::Throw => Err(self.raise_js(sent)),
        }
    }

    /// Drive a generator's `.next(v)` / `.return(v)` / `.throw(e)`
    /// (`fx_Generator_prototype_aux` + `fxRunID`): reinstall the suspended
    /// activation, run a nested [`Self::dispatch_at`] to the next `yield` or
    /// completion, and return the `{value, done}` result. The driver's
    /// activation is suspended onto `call_stack` (exactly as [`Self::enter_call`]
    /// does) so the generator's `END`/`leave_call` restores it; a `yield`
    /// unwinds here via [`Step::Yielded`] with the driver still suspended, which
    /// this restores. `.return`/`.throw` resume through the compiler's
    /// `BRANCH_STATUS` epilogue, including live catch/finally handlers.
    pub(super) fn resume_generator(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
        sent: Slot,
        status: GenStatus,
    ) -> Result<Slot, Step> {
        let state = self.generators.get(&gen).map(|g| g.state).ok_or_else(|| {
            self.catchable_type_error_msg("this: not a Generator instance".into())
        })?;
        match state {
            GeneratorState::Executing => {
                // Re-entrant resume of a running generator is an ordinary
                // catchable `TypeError` ("generator is running" in XS).
                return Err(self.catchable_type_error_msg("generator is running".into()));
            }
            GeneratorState::Completed => return self.generator_done_result(status, sent),
            GeneratorState::SuspendedStart => {
                // `return`/`throw` before the first `next`: XS marks the
                // generator done without running the body.
                if status != GenStatus::Next {
                    if let Some(g) = self.generators.get_mut(&gen) {
                        g.state = GeneratorState::Completed;
                        g.frame = None;
                    }
                    return self.generator_done_result(status, sent);
                }
            }
            GeneratorState::SuspendedYield => {}
        }
        let was_start = state == GeneratorState::SuspendedStart;
        let saved = self
            .generators
            .get_mut(&gen)
            .and_then(|g| g.frame.take())
            .ok_or(Step::Host(Halt::EngineInvariant("generator:no-frame")))?;
        // Admit the complete restored activation before changing the driver.
        // A resumed expression also receives the sent value on its stack.
        let extra = saved.stack_slice.len()
            + saved.locals.len()
            + saved.args.len()
            + FRAME_OVERHEAD_SLOTS
            + usize::from(!was_start);
        if self.would_overflow(extra) {
            self.generators
                .get_mut(&gen)
                .expect("instance exists")
                .frame = Some(saved);
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        // The per-resume native-frame residual (`fx_Generator_prototype_aux` +
        // `fxRunID` re-entry) over the `RUN` trampoline already metered.
        self.meter.tick_raw(GENERATOR_RESUME_METERING);
        // Suspend the driver activation onto `call_stack` (mirroring
        // `enter_call`), then install the generator frame.
        let driver_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();
        self.frame_slots += driver_footprint;
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
            ret_pc: 0,
        });
        // Sync generators may unwind directly into a caller's live handler.
        self.run_guest_under_native_try(CallerHandlers::Preserve, |machine| {
            let stack_base = machine.stack.len();
            let jumps_base = machine.jumps.len();
            let return_depth = machine.call_stack.len();
            let resume_pc = machine.reinstall_activation(saved, stack_base, return_depth);
            // On a yield-resume the sent value becomes the yield expression's value
            // (XS overwrites the saved yield slot with `the->scratch`); the first
            // `next`'s argument is discarded per spec.
            if !was_start {
                machine.push(sent);
            }
            machine.resume_status = match status {
                GenStatus::Next => ResumeStatus::NoStatus,
                GenStatus::Return => ResumeStatus::Return,
                GenStatus::Throw => ResumeStatus::Throw,
            };
            if let Some(g) = machine.generators.get_mut(&gen) {
                g.state = GeneratorState::Executing;
            }

            machine.gen_run_stack.push(GenRunFrame {
                gen,
                stack_base,
                jumps_base,
                call_depth_base: return_depth,
            });
            // Resume over the generator function's own code segment (a dynamic
            // `%GeneratorFunction%` / eval-defined body lives in a persisted
            // segment, not the driver's `code`).
            let (resume_seg, resume_buf) = machine.resume_segment_buffer(machine.cur_func);
            let saved_segment = machine.active_segment;
            if resume_buf.is_some() {
                machine.active_segment = resume_seg;
            }
            let body_code: &[u8] = match &resume_buf {
                Some(buf) => &buf[..],
                None => code,
            };
            let outcome = machine.dispatch_at(body_code, resume_pc, return_depth);
            machine.active_segment = saved_segment;
            machine.gen_run_stack.pop();
            machine.resume_status = ResumeStatus::NoStatus;
            match outcome {
                Step::Yielded(v) => {
                    // The `YIELD` arm snapshotted the generator and truncated the
                    // stack to `stack_base`; the driver is still suspended — restore
                    // it (its own `leave_call`). `v` is the `{value, done: false}`
                    // object the generator body **built by bytecode** (`OBJECT` +
                    // `NEW_PROPERTY`×2 before `YIELD`), so it is the `.next` result
                    // as-is — NOT re-wrapped (its allocation is already metered by
                    // those opcodes both engines dispatch).
                    let _ = machine.leave_call();
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    Ok(v)
                }
                Step::Returned => {
                    // The generator's `END` boundary branch already ran
                    // `leave_call` (driver restored) and pushed the completion, so
                    // `call_stack.len() < return_depth` here. A body terminated by
                    // the top-level-*only* `RETURN` opcode instead returns
                    // `Halt::Return` WITHOUT that boundary `leave_call`, leaking the
                    // driver frame — the generator twin of the async
                    // `START_ASYNC, RETURN` frame-leak (endojs/endo-but-for-bots
                    // #1046). Pop the leaked frame(s) and degrade to a named skip,
                    // symmetric with the `other` arm and the frame-underflow guards.
                    if machine.call_stack.len() >= return_depth {
                        while machine.call_stack.len() >= return_depth {
                            let _ = machine.leave_call();
                        }
                        machine.stack.truncate(stack_base);
                        machine.jumps.truncate(jumps_base);
                        if let Some(g) = machine.generators.get_mut(&gen) {
                            g.state = GeneratorState::Completed;
                            g.frame = None;
                        }
                        return Err(Step::Host(Halt::EngineInvariant(
                            "generator:non-boundary-return",
                        )));
                    }
                    let ret = machine.pop_checked()?;
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    if let Some(g) = machine.generators.get_mut(&gen) {
                        g.state = GeneratorState::Completed;
                        g.frame = None;
                    }
                    Ok(machine.new_generator_result(ret, true))
                }
                other => {
                    // A throw / meter-abort / overflow escaped the body. Restore the
                    // driver best-effort, mark the generator done, propagate.
                    while machine.call_stack.len() >= return_depth {
                        let _ = machine.leave_call();
                    }
                    if machine.stack.len() > stack_base {
                        machine.stack.truncate(stack_base);
                    }
                    if machine.jumps.len() > jumps_base {
                        machine.jumps.truncate(jumps_base);
                    }
                    if let Some(g) = machine.generators.get_mut(&gen) {
                        g.state = GeneratorState::Completed;
                        g.frame = None;
                    }
                    Err(other)
                }
            }
        })
    }

    pub(super) fn enqueue_async_generator(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
        value: Slot,
        status: GenStatus,
    ) -> Result<Slot, Step> {
        if !self.async_generators.contains_key(&gen) {
            return Err(Step::Host(Halt::EngineInvariant(
                "async-generator:not-an-async-generator",
            )));
        }
        let (promise, resolve, reject) = self.new_promise_capability();
        self.async_generators
            .get_mut(&gen)
            .unwrap()
            .requests
            .push_back(AsyncGeneratorRequest {
                status,
                value,
                resolve,
                reject,
            });
        self.kick_async_generator(code, gen)?;
        Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
    }

    /// Return the rejected promise required when an AsyncGenerator prototype
    /// method is borrowed onto a receiver without `[[AsyncGeneratorState]]`.
    /// Unlike the synchronous Generator methods, this validation failure does
    /// not throw from the call itself.
    pub(super) fn reject_async_generator_brand(&mut self) -> Result<Slot, Step> {
        let (promise, _resolve, reject) = self.new_promise_capability();
        let error = self.internal_error("TypeError", "this: not an AsyncGenerator instance".into());
        self.meter
            .tick_raw(ASYNC_GENERATOR_BRAND_REJECT_CALL_METERING);
        self.reject_via_function(reject, error)?;
        Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
    }

    /// `AsyncGeneratorResumeNext` (XS's `fxAsyncGeneratorResumeNext`): take
    /// the next queued request and act on it — resume the body, schedule the
    /// await a `return` needs, or, on a completed generator, settle the
    /// request immediately. The immediate settlements **loop** here rather
    /// than recursing through [`Self::finish_async_generator_request`]: a
    /// guest that queues `g.next()` ten thousand times on a finished generator
    /// drains ten thousand iterations, where the mutual `kick` ↔ `finish`
    /// recursion this replaces nested one native frame per request and
    /// overflowed the host stack at about 1,200 (debug build).
    fn kick_async_generator(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
    ) -> Result<(), Step> {
        loop {
            let state = self.async_generators[&gen].state;
            if matches!(
                state,
                AsyncGeneratorState::Executing | AsyncGeneratorState::Awaiting
            ) || self.async_generators[&gen].active.is_some()
            {
                return Ok(());
            }
            let request = match self
                .async_generators
                .get_mut(&gen)
                .unwrap()
                .requests
                .pop_front()
            {
                Some(r) => r,
                None => return Ok(()),
            };
            self.async_generators.get_mut(&gen).unwrap().active = Some(request);
            match state {
                AsyncGeneratorState::Completed => match request.status {
                    GenStatus::Next => {
                        let result = self.new_generator_result(Slot::undefined(), true);
                        self.settle_active_async_generator_request(code, gen, result, false)?;
                    }
                    GenStatus::Return => {
                        return self.schedule_native_await(
                            code,
                            request.value,
                            ReactionKind::AsyncGeneratorReturn(gen),
                        )
                    }
                    GenStatus::Throw => {
                        self.settle_active_async_generator_request(code, gen, request.value, true)?;
                    }
                },
                AsyncGeneratorState::SuspendedStart if request.status != GenStatus::Next => {
                    let data = self.async_generators.get_mut(&gen).unwrap();
                    data.state = AsyncGeneratorState::Completed;
                    data.frame = None;
                    match request.status {
                        GenStatus::Return => {
                            return self.schedule_native_await(
                                code,
                                request.value,
                                ReactionKind::AsyncGeneratorReturn(gen),
                            )
                        }
                        GenStatus::Throw => {
                            self.settle_active_async_generator_request(
                                code,
                                gen,
                                request.value,
                                true,
                            )?;
                        }
                        GenStatus::Next => unreachable!(),
                    }
                }
                _ => {
                    return self.step_async_generator(
                        code,
                        gen,
                        match request.status {
                            GenStatus::Next => ResumeStatus::NoStatus,
                            GenStatus::Return => ResumeStatus::Return,
                            GenStatus::Throw => ResumeStatus::Throw,
                        },
                        request.value,
                        state == AsyncGeneratorState::SuspendedStart,
                    )
                }
            }
            // The request settled synchronously; drain the next one.
        }
    }

    /// Settle the active request's promise with `value` (rejecting when
    /// `reject`), then resume draining the queue.
    pub(super) fn finish_async_generator_request(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
        value: Slot,
        reject: bool,
    ) -> Result<(), Step> {
        self.settle_active_async_generator_request(code, gen, value, reject)?;
        self.kick_async_generator(code, gen)
    }

    /// Take the active request and settle its promise through the resolving
    /// function the request carries (`fxAsyncGeneratorResolve` /
    /// `fxAsyncGeneratorReject`), leaving the generator ready for the next.
    fn settle_active_async_generator_request(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
        value: Slot,
        reject: bool,
    ) -> Result<(), Step> {
        let request = self
            .async_generators
            .get_mut(&gen)
            .and_then(|g| g.active.take())
            .ok_or(Step::Host(Halt::EngineInvariant(
                "async-generator:no-active-request",
            )))?;
        self.settle_via_function(
            code,
            if reject {
                request.reject
            } else {
                request.resolve
            },
            value,
        )
    }

    pub(super) fn step_async_generator(
        &mut self,
        code: &[u8],
        gen: crate::value::SlotIndex,
        status: ResumeStatus,
        sent: Slot,
        is_start: bool,
    ) -> Result<(), Step> {
        let saved = self
            .async_generators
            .get_mut(&gen)
            .and_then(|g| g.frame.take())
            .ok_or(Step::Host(Halt::EngineInvariant(
                "async-generator:no-frame",
            )))?;
        // Admit the complete restored activation before changing the driver.
        // A resumed expression also receives the sent value on its stack.
        let extra = saved.stack_slice.len()
            + saved.locals.len()
            + saved.args.len()
            + FRAME_OVERHEAD_SLOTS
            + usize::from(!is_start);
        if self.would_overflow(extra) {
            self.async_generators
                .get_mut(&gen)
                .expect("instance exists")
                .frame = Some(saved);
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        if !is_start {
            self.meter.tick_raw(GENERATOR_RESUME_METERING);
        }
        let driver_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();
        self.frame_slots += driver_footprint;
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
            ret_pc: 0,
        });
        // Async body throws reject their promise, without consuming a handler
        // live around the caller's synchronous start. Rebased body handlers
        // run behind the shared fence and are consumed before it is restored.
        self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            let stack_base = machine.stack.len();
            let jumps_base = machine.jumps.len();
            let return_depth = machine.call_stack.len();
            let resume_pc = machine.reinstall_activation(saved, stack_base, return_depth);
            if !is_start {
                machine.push(sent);
            }
            machine.resume_status = if is_start {
                ResumeStatus::NoStatus
            } else {
                status
            };
            machine.async_generators.get_mut(&gen).unwrap().state = AsyncGeneratorState::Executing;

            machine.async_gen_run_stack.push(AsyncGenRunFrame {
                gen,
                stack_base,
                jumps_base,
                call_depth_base: return_depth,
            });
            // Resume over the async-generator function's own code segment (a
            // dynamic `%AsyncGeneratorFunction%` / eval-defined body is persisted
            // in its own segment).
            let (resume_seg, resume_buf) = machine.resume_segment_buffer(machine.cur_func);
            let saved_segment = machine.active_segment;
            if resume_buf.is_some() {
                machine.active_segment = resume_seg;
            }
            let body_code: &[u8] = match &resume_buf {
                Some(buf) => &buf[..],
                None => code,
            };
            let outcome = machine.dispatch_at(body_code, resume_pc, return_depth);
            machine.active_segment = saved_segment;
            machine.async_gen_run_stack.pop();
            machine.resume_status = ResumeStatus::NoStatus;
            let step_result = match outcome {
                Step::AsyncYielded(value) => {
                    let _ = machine.leave_call();
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    machine.schedule_native_await(
                        code,
                        value,
                        ReactionKind::AsyncGeneratorYield(gen),
                    )
                }
                Step::Awaited(value) => {
                    let _ = machine.leave_call();
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    machine.schedule_native_await(
                        code,
                        value,
                        ReactionKind::AsyncGeneratorAwait(gen),
                    )
                }
                Step::Returned => {
                    // A boundary `END` already ran `leave_call` (driver restored),
                    // so `call_stack.len() < return_depth`. A body terminated by the
                    // top-level-*only* `RETURN` opcode instead skips that boundary
                    // `leave_call`, leaking the driver frame — the async-generator
                    // twin of the `START_ASYNC, RETURN` frame-leak
                    // (endojs/endo-but-for-bots#1046). Pop the leaked frame(s) and
                    // degrade to a named skip, symmetric with the `other` arm.
                    if machine.call_stack.len() >= return_depth {
                        while machine.call_stack.len() >= return_depth {
                            let _ = machine.leave_call();
                        }
                        machine.stack.truncate(stack_base);
                        machine.jumps.truncate(jumps_base);
                        let data = machine.async_generators.get_mut(&gen).unwrap();
                        data.state = AsyncGeneratorState::Completed;
                        data.frame = None;
                        return Err(Step::Host(Halt::EngineInvariant(
                            "async-generator:non-boundary-return",
                        )));
                    }
                    let value = machine.pop_checked()?;
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    let data = machine.async_generators.get_mut(&gen).unwrap();
                    data.state = AsyncGeneratorState::Completed;
                    data.frame = None;
                    machine.schedule_native_await(
                        code,
                        value,
                        ReactionKind::AsyncGeneratorReturn(gen),
                    )
                }
                Step::Threw { value: reason, .. } => {
                    while machine.call_stack.len() >= return_depth {
                        let _ = machine.leave_call();
                    }
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    machine.exception = Slot::undefined();
                    let data = machine.async_generators.get_mut(&gen).unwrap();
                    data.state = AsyncGeneratorState::Completed;
                    data.frame = None;
                    machine.finish_async_generator_request(code, gen, reason, true)
                }
                other => {
                    while machine.call_stack.len() >= return_depth {
                        let _ = machine.leave_call();
                    }
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    // A halt (meter abort, unsupported opcode) abandons the
                    // step. Complete the instance so a later next() cannot
                    // observe Executing with no saved frame.
                    let data = machine.async_generators.get_mut(&gen).unwrap();
                    data.state = AsyncGeneratorState::Completed;
                    data.frame = None;
                    Err(other)
                }
            };
            debug_assert!(machine.jumps.is_empty(), "async body left handlers behind");
            step_result
        })
    }

    /// Run one step of an async-function instance (XS's `fxStepAsync`): install
    /// the suspended activation, run a nested [`Self::dispatch_at`] to the next
    /// `await` or completion, then act on the outcome — schedule the await, or
    /// settle the result promise. Modeled on [`Self::resume_generator`]: the
    /// ambient activation is suspended onto `call_stack`, the async frame
    /// installed, and a `return`/`throw` from the body settles the result
    /// promise via its resolve/reject function.
    ///
    /// - `is_start` is the initial synchronous run from `START_ASYNC` (no sent
    ///   value pushed; runs the body from just past `START_ASYNC`).
    /// - a resume (`is_start == false`) is driven by an `AsyncAwait` native
    ///   reaction at the promise-job drain: `sent` is the resolved value (or the
    ///   rejection reason), pushed as the `await` expression's result, and
    ///   `status` threads into the `BRANCH_STATUS` epilogue.
    ///
    /// Returns `Ok(())` when the step completed (the result promise settled or
    /// the body re-suspended at another `await`); propagates `Halt::NotImplemented`
    /// / `MeterAbort` / `StackOverflow` when the body hit an un-modeled surface.
    /// A body `throw` is *not* propagated — it rejects the result promise.
    pub(super) fn step_async(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        status: ResumeStatus,
        sent: Slot,
        is_start: bool,
    ) -> Result<(), Step> {
        // A resume of an already-settled instance (a promise firing twice) is a
        // no-op — the two-level guard XS's resolving functions enforce.
        if self
            .async_instances
            .get(&inst)
            .map(|a| a.done)
            .unwrap_or(true)
            && !is_start
        {
            return Ok(());
        }
        let saved = self
            .async_instances
            .get_mut(&inst)
            .and_then(|a| a.frame.take())
            .ok_or(Step::Host(Halt::EngineInvariant("async:no-frame")))?;
        // Admit the complete restored activation before changing the driver.
        // A resumed expression also receives the sent value on its stack.
        let extra = saved.stack_slice.len()
            + saved.locals.len()
            + saved.args.len()
            + FRAME_OVERHEAD_SLOTS
            + usize::from(!is_start);
        if self.would_overflow(extra) {
            self.async_instances
                .get_mut(&inst)
                .expect("instance exists")
                .frame = Some(saved);
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        if !is_start {
            // The per-resume native-frame residual (`fxResolveAwait`/
            // `fxRejectAwait` → `fxStepAsync` → `fxRunID` re-entry), the async
            // analog of the generator resume residual.
            self.meter.tick_raw(GENERATOR_RESUME_METERING);
        }
        // Suspend the ambient activation onto `call_stack` (mirroring
        // `enter_call`/`resume_generator`), then install the async frame.
        let driver_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();
        self.frame_slots += driver_footprint;
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
            ret_pc: 0,
        });
        // Async body throws reject their promise, without consuming a handler
        // live around the caller's synchronous start. Rebased body handlers
        // run behind the shared fence and are consumed before it is restored.
        self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            let stack_base = machine.stack.len();
            let jumps_base = machine.jumps.len();
            let return_depth = machine.call_stack.len();
            let resume_pc = machine.reinstall_activation(saved, stack_base, return_depth);
            // On a resume the sent value becomes the `await` expression's value (XS
            // writes `the->scratch` at the resume slot in `fxRunID`); the initial
            // synchronous start pushes nothing (the body runs from a clean frame).
            if !is_start {
                machine.push(sent);
            }
            machine.resume_status = if is_start {
                ResumeStatus::NoStatus
            } else {
                status
            };

            machine.async_run_stack.push(AsyncRunFrame {
                inst,
                stack_base,
                jumps_base,
                call_depth_base: return_depth,
            });
            // Resume over the async function's own code segment (a dynamic
            // `%AsyncFunction%` / eval-defined body is persisted in its own
            // segment, not the await-driver's `code`).
            let (resume_seg, resume_buf) = machine.resume_segment_buffer(machine.cur_func);
            let saved_segment = machine.active_segment;
            if resume_buf.is_some() {
                machine.active_segment = resume_seg;
            }
            let body_code: &[u8] = match &resume_buf {
                Some(buf) => &buf[..],
                None => code,
            };
            let outcome = machine.dispatch_at(body_code, resume_pc, return_depth);
            machine.active_segment = saved_segment;
            machine.async_run_stack.pop();
            // Any `BRANCH_STATUS` will have consumed the status; reset defensively.
            machine.resume_status = ResumeStatus::NoStatus;
            let step_result = match outcome {
                Step::Awaited(v) => {
                    // The `AWAIT` arm snapshotted the instance and truncated the
                    // stack to `stack_base`; the ambient frame is still suspended —
                    // restore it (its own `leave_call`), then schedule the await.
                    let _ = machine.leave_call();
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    machine.await_schedule(code, inst, v)
                }
                Step::Returned => {
                    // The body's `END` boundary branch already ran `leave_call`
                    // (ambient restored) and pushed the completion value — so the
                    // driver frame is gone (`call_stack.len() < return_depth`).
                    // Crafted bytecode can instead terminate the async body with
                    // `RETURN`, the top-level-*only* terminator, which returns
                    // `Halt::Return` WITHOUT the boundary `leave_call`: the driver
                    // frame is left on `call_stack` and the async activation is
                    // still current. `START_ASYNC` would then `leave_call` that
                    // stray driver and resume at its sentinel `ret_pc` (0),
                    // re-executing this very `START_ASYNC` and allocating a fresh
                    // async instance every step until the fuzz OOM / `StepLimit`
                    // (the `[193, 169]` = `START_ASYNC, RETURN` reproducer,
                    // endojs/endo-but-for-bots#1046). Degrade that malformed exit
                    // to a named skip, symmetric with the `other` arm below and the
                    // `start_async:frame-underflow` guard — pop the leaked driver
                    // frame(s) so the caller's frame accounting is not corrupted.
                    if machine.call_stack.len() >= return_depth {
                        while machine.call_stack.len() >= return_depth {
                            let _ = machine.leave_call();
                        }
                        machine.stack.truncate(stack_base);
                        machine.jumps.truncate(jumps_base);
                        if let Some(a) = machine.async_instances.get_mut(&inst) {
                            a.done = true;
                            a.frame = None;
                        }
                        return Err(Step::Host(Halt::EngineInvariant(
                            "async:non-boundary-return",
                        )));
                    }
                    let ret = machine.pop_checked()?;
                    machine.stack.truncate(stack_base);
                    machine.jumps.truncate(jumps_base);
                    if let Some(a) = machine.async_instances.get_mut(&inst) {
                        a.done = true;
                        a.frame = None;
                    }
                    // Resolve the result promise with the completion value (XS calls
                    // the instance's `resolveFunction` via `mxRunCount(1)`; a thenable
                    // return value adopts). The direct-settle omits the native call
                    // framing, carried by `ASYNC_STEP_SETTLE_METERING`.
                    machine.meter.tick_raw(ASYNC_STEP_SETTLE_METERING);
                    let resolve_fn = machine.async_instances[&inst].resolve_fn;
                    machine.settle_via_function(code, resolve_fn, ret)
                }
                Step::Threw { value: reason, .. } => {
                    // A body throw that escaped every handler rejects the result
                    // promise (XS's `mxCatch` → `fxRejectException`), not the host.
                    while machine.call_stack.len() >= return_depth {
                        let _ = machine.leave_call();
                    }
                    if machine.stack.len() > stack_base {
                        machine.stack.truncate(stack_base);
                    }
                    if machine.jumps.len() > jumps_base {
                        machine.jumps.truncate(jumps_base);
                    }
                    machine.exception = Slot::undefined();
                    if let Some(a) = machine.async_instances.get_mut(&inst) {
                        a.done = true;
                        a.frame = None;
                    }
                    machine.meter.tick_raw(ASYNC_STEP_SETTLE_METERING);
                    if is_start {
                        // See the constant's doc: the sync-start reject
                        // crosses one more dispatch in XS than the
                        // drain-side reject.
                        machine.meter.tick_raw(ASYNC_START_REJECT_BOUNDARY_METERING);
                    }
                    let reject_fn = machine.async_instances[&inst].reject_fn;
                    machine.settle_via_function(code, reject_fn, reason)
                }
                other => {
                    // An un-modeled surface (a named skip), meter abort, or overflow
                    // escaped the body: restore the ambient frame best-effort, mark
                    // the instance done, and propagate — the whole async call becomes
                    // an honest named skip rather than a wrong settlement.
                    while machine.call_stack.len() >= return_depth {
                        let _ = machine.leave_call();
                    }
                    if machine.stack.len() > stack_base {
                        machine.stack.truncate(stack_base);
                    }
                    if machine.jumps.len() > jumps_base {
                        machine.jumps.truncate(jumps_base);
                    }
                    if let Some(a) = machine.async_instances.get_mut(&inst) {
                        a.done = true;
                        a.frame = None;
                    }
                    Err(other)
                }
            };
            debug_assert!(machine.jumps.is_empty(), "async body left handlers behind");
            step_result
        })
    }

    /// Schedule an `await` (XS's `fxStepAsync` await-branch): register the
    /// instance's `AsyncAwait` native reaction so the body resumes when the
    /// awaited value settles. Two branches, exactly as XS:
    ///
    /// - **Native-promise fast path** (`value` is a native `Promise` — its
    ///   `constructor === %Promise%`): register the `AsyncAwait` reaction
    ///   directly on `value`'s promise (the identity check meters the same
    ///   `2.5<<16` the keystone froze for `Promise.resolve(nativePromise)`).
    /// - **General path**: build a fresh capability, register the reaction on
    ///   its promise, then call the capability's `resolve` with `value` — which
    ///   fulfills with a primitive (queuing the resume for the next microtask
    ///   turn, so a bare `await 1` still costs one turn) or adopts a thenable.
    fn await_schedule(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        value: Slot,
    ) -> Result<(), Step> {
        self.schedule_native_await(code, value, ReactionKind::AsyncAwait(inst))
    }

    pub(super) fn schedule_native_await(
        &mut self,
        code: &[u8],
        value: Slot,
        kind: ReactionKind,
    ) -> Result<(), Step> {
        if let Payload::Reference(r) = value.value {
            if self.promises.contains_key(&r) {
                // XS's fast path is `mxGetID(_constructor)` + `fxIsSameValue` +
                // `fxPromiseThen` (null capability, 5 slots) — no capability, no
                // resolve call. It is *cheaper* than the general path: registering
                // the native reaction on the (typically already-settled) awaited
                // promise via `promise_then_native` is the whole cost. The single
                // calibrated credit nets `promise_then_native`'s settled-promise
                // job-queue accounting (shaped for the general/`.then` path) down
                // to XS's leaner null-capability `fxPromiseThen`.
                self.meter.untick_raw(ASYNC_AWAIT_FASTPATH_CREDIT);
                self.promise_then_native(r, kind);
                return Ok(());
            }
        }
        self.meter.tick_raw(ASYNC_AWAIT_GENERAL_METERING);
        let (derived, resolve, _reject) = self.new_promise_capability();
        self.promise_then_native(derived, kind);
        self.settle_via_function(code, resolve, value)
    }
}

#[cfg(test)]
mod tests {
    use super::{Interp, Suspension};
    use crate::value::{Payload, Slot};

    #[test]
    fn invalid_stack_cut_preserves_activation_and_meter() {
        for (kind, label) in [
            (Suspension::Yield, "yield:stack-underflow"),
            (Suspension::Await, "await:stack-underflow"),
        ] {
            let mut vm = Interp::new();
            vm.locals.push(Slot::integer(42));
            vm.args.push(Slot::integer(7));
            let raw = vm.meter.raw();
            let result = vm.suspend_activation(vm.stack.len() + 1, 0, 0, 12, kind);
            assert_eq!(
                result.err().map(|halt| format!("{halt:?}")),
                Some(format!("EngineInvariant({label:?})")),
            );
            assert_eq!(vm.locals.len(), 1);
            assert!(matches!(vm.locals[0].value, Payload::Integer(42)));
            assert_eq!(vm.args.len(), 1);
            assert!(matches!(vm.args[0].value, Payload::Integer(7)));
            assert_eq!(vm.meter.raw(), raw);
        }
    }
}

// Saved-frame owners come from the same state roster as the GC frame walks.
// A code compaction must rewrite handlers in all three suspension families.
macro_rules! remap_frame_table {
    ($vm:ident, $field:ident, $remap:ident, frame) => {
        for data in $vm.$field.values_mut() {
            if let Some(frame) = &mut data.frame {
                for jump in &mut frame.jumps {
                    if let Some(segment) = &mut jump.segment {
                        *segment = $remap[segment];
                    }
                }
            }
        }
    };
    ($vm:ident, $field:ident, $remap:ident, async_frame) => {
        remap_frame_table!($vm, $field, $remap, frame);
    };
    ($vm:ident, $field:ident, $remap:ident, queued_frame) => {
        remap_frame_table!($vm, $field, $remap, frame);
    };
    ($vm:ident, $field:ident, $remap:ident, $other:ident) => {};
}

macro_rules! define_frame_segment_remap {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
        impl Interp {
            pub(super) fn remap_saved_handler_segments(
                &mut self,
                remap: &std::collections::BTreeMap<usize, usize>,
            ) {
                $(remap_frame_table!(self, $field, remap, $chunk);)*
            }
        }
    };
}
interp_state!(define_frame_segment_remap);
