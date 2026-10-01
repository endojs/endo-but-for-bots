//! Bytecode dispatch and ownership-aware control-transfer handling.
//!
//! The dispatch (the loop and the arms outlined from it, below) owns decoding,
//! instruction advancement, budgets, branches, calls, suspension, and catch
//! resumption. Property, environment, iterator, private, super-property, and
//! larger operator semantics live in the child modules. Their handlers return
//! `Result<(), Step>` without consuming a transfer: an error reaches
//! `dispatch_result!` (or `dispatch_result_flow!`) before any instruction
//! advancement, while success advances exactly once. These are ordinary Rust
//! helper calls, not additional guest/native entries, and do not add a
//! metering frame.
//!
//! Most opcodes run outside the loop's frame, in an `exec_*` function per arm
//! that returns a [`Flow`]: continue at a program counter, or leave the loop
//! with a [`Step`]. The loop's frame, which every guest re-entry through
//! [`Interp::dispatch_at`] carries, then holds only the state of the arms that
//! stay inline, the frequent ones whose fast path is small
//! (STACK-DEPTH-REFACTOR.md §4.3 A2). An outlined arm consumes a transfer only
//! through `dispatch_halt_flow!`/`dispatch_result_flow!`, the loop macros'
//! twins with the same ownership and metering checks.
//! `tests/dispatch_loop_control_transfer.rs` locks this boundary and its roster.
use super::invoke::RunCall;
use super::{
    branch_target, cannot_coerce_to_object, canonicalize_nan, cesu8_to_units, count_new_locals,
    to_int32, to_number, unary_minus, units_to_be16, ArithOp, AsyncGeneratorState, BitOp,
    CatchJump, GeneratorState, Halt, Interp, Kind, MeterCheck, Native, NativeMethod, Opcode,
    Payload, RelOp, ResumeStatus, Slot, Step, Suspension, BIGINT_LITERAL_METERING,
    BIGINT_NEG_FRAME_METERING, BOUNDED_RUN_SLOT_CEILING, FUNCTION_LOCAL_METERING, HEAVY_FRAME_COST,
    LIGHT_FRAME_COST, USING_DECL_METERING, USING_RESOURCE_METERING, WITH_ENV_SETUP_METERING,
    XS_DONT_DELETE_FLAG, XS_DONT_ENUM_FLAG, XS_DONT_SET_FLAG,
};
use crate::DecodeError;

/// Consume a [`Step`] inside the bytecode dispatch loop. This is the ONLY
/// way a `Step::Unwound` may be acted on: a handler that lives in a frame
/// below this loop's `return_depth`, or in a different bytecode buffer,
/// belongs to an enclosing dispatch, so the unwind propagates out to it.
/// A handler owned by this loop resumes here, paying XS's `mxFirstCode` meter check
/// at the catch landing (`xsRun.c` `XS_CODE_CATCH`, after the `c_setjmp`
/// restore). Every other halt leaves the loop as-is.
///
/// Every engine raise in the loop (`raise_js`, the `catchable_*` helpers)
/// and every native re-entry that can raise must pass through here or
/// [`dispatch_result!`], or in an outlined arm their `Flow` twins
/// [`dispatch_halt_flow!`] and [`dispatch_result_flow!`];
/// `tests/dispatch_loop_control_transfer.rs` parses the source and rejects
/// hand-expanded arms so they cannot bypass handler ownership checks or
/// expose an internal unwind as a host result.
macro_rules! dispatch_halt {
    ($halt:expr, $program_counter:ident, $machine:expr, $return_depth:expr, $code:expr) => {
        match $halt {
            Step::Unwound(target)
                if $machine.call_stack.len() < $return_depth
                    || !$machine.resume_target_belongs_to(target, $code) =>
            {
                return Step::Unwound(target);
            }
            Step::Unwound(target) => {
                $machine.assert_resume_target(target, $code);
                $program_counter = target.pc;
                if $machine.check_meter() == MeterCheck::Abort {
                    return Step::Host(Halt::MeterAbort);
                }
                continue;
            }
            halt => return halt,
        }
    };
}

/// Propagate a native/helper result from the bytecode dispatch loop, resuming
/// at a JavaScript catch/finally target when a native helper raised an error
/// (see [`dispatch_halt!`]).
macro_rules! dispatch_result {
    ($expression:expr, $program_counter:ident, $machine:expr, $return_depth:expr, $code:expr) => {
        match $expression {
            Ok(value) => value,
            Err(halt) => dispatch_halt!(halt, $program_counter, $machine, $return_depth, $code),
        }
    };
}

/// What an arm outlined from the dispatch loop asks of it: continue at a
/// program counter, or leave the loop with a [`Step`]. An outlined arm
/// (`exec_*`) runs its opcode in its own frame, so the loop's frame, which
/// every guest re-entry through [`Interp::dispatch_at`] carries, holds only
/// the inline arms' state (STACK-DEPTH-REFACTOR.md §4.3 A2).
#[must_use]
enum Flow {
    Next(usize),
    Exit(Step),
}

/// Act on an outlined arm's [`Flow`] in the dispatch loop. The arm built its
/// exit explicitly or through [`dispatch_halt_flow!`], which keeps every
/// unwind's ownership and catch-landing checks.
macro_rules! dispatch_flow {
    ($flow:expr, $program_counter:ident) => {
        match $flow {
            Flow::Next(next) => $program_counter = next,
            Flow::Exit(step) => return step,
        }
    };
}

/// [`dispatch_halt!`] for an outlined arm: the same ownership test and
/// catch landing, reported to the loop as a [`Flow`], which carries the
/// landing's program counter.
macro_rules! dispatch_halt_flow {
    ($halt:expr, $machine:expr, $return_depth:expr, $code:expr) => {
        match $halt {
            Step::Unwound(target)
                if $machine.call_stack.len() < $return_depth
                    || !$machine.resume_target_belongs_to(target, $code) =>
            {
                return Flow::Exit(Step::Unwound(target));
            }
            Step::Unwound(target) => {
                $machine.assert_resume_target(target, $code);
                if $machine.check_meter() == MeterCheck::Abort {
                    return Flow::Exit(Step::Host(Halt::MeterAbort));
                }
                return Flow::Next(target.pc);
            }
            halt => return Flow::Exit(halt),
        }
    };
}

/// [`dispatch_result!`] for an outlined arm.
macro_rules! dispatch_result_flow {
    ($expression:expr, $machine:expr, $return_depth:expr, $code:expr) => {
        match $expression {
            Ok(value) => value,
            Err(halt) => dispatch_halt_flow!(halt, $machine, $return_depth, $code),
        }
    };
}

/// A signed 1-byte operand at `pc + off` (XS `mxRunS1`).
fn operand_s1(code: &[u8], pc: usize, off: usize) -> i32 {
    code[pc + off] as i8 as i32
}

/// An unsigned 1-byte operand (a scope index; XS `mxRunU1`).
fn operand_u1(code: &[u8], pc: usize, off: usize) -> usize {
    code[pc + off] as usize
}

/// A 2-byte little-endian ID operand (XS `mxRunID`).
fn operand_id(code: &[u8], pc: usize, off: usize) -> u16 {
    u16::from_le_bytes([code[pc + off], code[pc + off + 1]])
}

mod environment;
mod iteration;
mod operators;
mod private;
mod property_read;
mod property_write;
mod super_property;

impl Interp {
    pub(super) fn dispatch(&mut self, code: &[u8]) -> Step {
        // The top-level program: start at pc 0, return to the host (C
        // boundary) when the call stack fully unwinds (depth 0).
        self.dispatch_at(code, 0, 0)
    }

    /// The interpreter dispatch loop, runnable from any `start_pc` and stopping
    /// when an `END` pops the call stack back to `return_depth` (the top-level
    /// program uses `0`/`0`). A native method drives a callback by entering its
    /// frame and calling this with the callback's `body_start` and the caller's
    /// current call depth, so the callback runs to its own `END` and returns
    /// control here — the re-entrant substrate the callback-taking
    /// `Array.prototype` methods (`forEach`/`map`/…) need.
    ///
    /// This thin wrapper charges the **native-recursion budget** for the
    /// `dispatch_at_inner` activation and aborts with
    /// [`Halt::ReentryLimit`] once [`super::NATIVE_DEPTH_LIMIT`] is exceeded, so a
    /// degenerate callback/async/generator nest cannot overflow the real thread
    /// stack (endojs/endo-but-for-bots#1046). It manages the counter across the
    /// inner loop's many early returns; every re-entry site
    /// (`run_callback`/`step_async`/`step_async_generator`/`resume_generator`)
    /// calls back through here, so their native recursion is counted uniformly.
    #[inline]
    pub(super) fn dispatch_at(
        &mut self,
        code: &[u8],
        start_pc: usize,
        return_depth: usize,
    ) -> Step {
        // Do not descend; the innermost re-entry that tipped the ceiling
        // aborts to the host exactly as the value-stack `fxOverflow` guard.
        if let Err(halt) = self.enter_native_frame(HEAVY_FRAME_COST) {
            return halt;
        }
        let halt = self.dispatch_at_inner(code, start_pc, return_depth);
        // Frames this loop ran in place and left on the call stack release
        // their charge now, where the nested loops they replace released it.
        if self.call_stack.len() > return_depth {
            self.release_held_above(return_depth);
        }
        self.leave_native_frame(HEAVY_FRAME_COST);
        halt
    }

    fn dispatch_at_inner(&mut self, code: &[u8], start_pc: usize, return_depth: usize) -> Step {
        let len = code.len();
        let mut pc: usize = start_pc;

        loop {
            if self.n_dispatched != 0
                && self.n_dispatched.is_multiple_of(4096)
                && self.check_meter() == MeterCheck::Abort
            {
                return Step::Host(Halt::MeterAbort);
            }
            // Bounded-execution guard (default `u64::MAX` = unbounded, so the
            // oracle-differential paths are untouched). A finite ceiling makes
            // a non-terminating program — a self-targeting backward branch, an
            // unbounded loop reached with no metering host armed — abort here
            // in bounded time instead of spinning forever. Checked at the loop
            // top so every recursive `dispatch_at` entry (callbacks, promise
            // jobs) shares the one cumulative ceiling.
            #[cfg(test)]
            {
                if super::tests::GC_AT_STEP.with(|step| {
                    if step.get() == Some(self.n_dispatched) {
                        step.set(None);
                        true
                    } else {
                        false
                    }
                }) {
                    let before = super::tests::refusal_state(self);
                    assert_eq!(
                        self.collect_garbage(),
                        Err(crate::gc::GcAdmissionError::NotQuiescent)
                    );
                    assert_eq!(
                        self.free_pages(&[]),
                        Err(crate::gc::GcAdmissionError::NotQuiescent)
                    );
                    assert_eq!(super::tests::refusal_state(self), before);
                    assert!(!self.gc_failed);
                    super::tests::GC_HITS.with(|hits| hits.set(hits.get() + 1));
                }
                if super::tests::PANIC_AT_STEP.with(|step| step.get() == Some(self.n_dispatched)) {
                    super::tests::PANIC_AT_STEP.with(|step| step.set(None));
                    panic!("PANIC_AT_STEP");
                }
            }
            if self.n_dispatched >= self.step_limit {
                return Step::Host(Halt::StepLimit(self.n_dispatched));
            }
            // Memory wedge guard, bounded mode ONLY (`step_limit` is
            // `u64::MAX` in production, which relies on the computron
            // meter to bound allocation). A hostile program can mint a
            // retained side-table entry per dispatch — e.g. a
            // self-feeding `START_ASYNC` loop allocates an async
            // instance (and its saved-frame Vecs) each step — so the
            // dispatch ceiling alone lets an unmetered bounded run
            // (the decoder fuzz harness) reach it 2M times and OOM
            // before it halts. Bound live slots too: a bounded wedge is
            // memory as much as time, and no real ≤21-byte fuzz input
            // legitimately reaches a million live slots.
            if self.step_limit != u64::MAX && self.slots.live_count() >= BOUNDED_RUN_SLOT_CEILING {
                return Step::Host(Halt::StepLimit(self.n_dispatched));
            }
            // Property-key id-space poison latch:
            // an intern that would alias sets the flag instead of handing
            // out a duplicate id; the halt here fires before the next
            // instruction so no aliased read or write is guest-observable.
            // The latch holds for the machine's lifetime — every later
            // crank halts identically — and `is_quiescent` keeps the
            // poisoned machine out of the persist gates.
            if self.id_space_exhausted {
                return Step::Host(Halt::Refused("property-key:id-space-exhausted"));
            }
            if pc >= len {
                return Step::Host(Halt::Decode(DecodeError::ProgramCounterOutOfBounds {
                    pc,
                    len,
                }));
            }
            let byte = code[pc];
            let op = match Opcode::from_u8(byte) {
                Some(o) => o,
                None => return Step::Host(Halt::Decode(DecodeError::InvalidOpcode { pc, byte })),
            };
            // Every dispatched opcode meters one code unit (mxBreak /
            // the switch-path `meterIndex += XS_CODE_METERING`).
            self.meter.tick_code();
            self.n_dispatched += 1;
            // Cost-calibration opcode histogram, at the same seam as the
            // scalar `n_dispatched` it generalizes (so the two reconcile).
            // Compiles away when the `cost-calibration` feature is off.
            self.cost.on_dispatch(op);

            let size = op.size();
            // The resolved instruction length (fixed size, or the
            // 1+ID_SIZE / length-prefixed length for the variable
            // opcodes). ID-operand opcodes have `size == 0`, so they
            // must advance by `ilen`, never by `size` (a zero-advance
            // infinite loop).
            let ilen = match crate::opcode::encoded_instruction_len(code, pc) {
                Some(l) if l > 0 => l,
                _ => {
                    return Step::Host(Halt::Decode(DecodeError::UnresolvableInstructionLength {
                        pc,
                        opcode: byte,
                    }))
                }
            };
            // Bounds-check the operands before reading.
            if pc + ilen > len {
                return Step::Host(Halt::Decode(DecodeError::TruncatedInstruction {
                    pc,
                    opcode: byte,
                    needed: ilen,
                    remaining: len - pc,
                }));
            }

            use Opcode::*;
            match op {
                // ---- program prologue / frame -----------------------
                XS_CODE_BEGIN_SLOPPY => {
                    dispatch_flow!(self.exec_begin_sloppy(code, pc, return_depth, size), pc)
                }
                XS_CODE_BEGIN_STRICT
                | XS_CODE_BEGIN_STRICT_BASE
                | XS_CODE_BEGIN_STRICT_DERIVED
                | XS_CODE_BEGIN_STRICT_FIELD => {
                    dispatch_flow!(self.exec_begin_strict(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_ARGUMENTS | XS_CODE_ARGUMENTS_SLOPPY | XS_CODE_ARGUMENTS_STRICT => {
                    dispatch_flow!(self.exec_arguments(code, pc, op, size), pc)
                }
                XS_CODE_EVAL_ENVIRONMENT | XS_CODE_PROGRAM_ENVIRONMENT => {
                    dispatch_flow!(self.exec_eval_environment(code, pc, return_depth, size), pc)
                }
                XS_CODE_EVAL_PRIVATE => {
                    dispatch_flow!(self.exec_eval_private(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_EVAL_REFERENCE | XS_CODE_PROGRAM_REFERENCE => {
                    dispatch_flow!(self.exec_eval_reference(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_WITH => dispatch_flow!(self.exec_with(code, pc, return_depth, size), pc),
                XS_CODE_WITHOUT => dispatch_flow!(self.exec_without(pc, size), pc),
                // ---- scope slots ------------------------------------
                // XS reserves the scope region (RESERVE) and fills it
                // downward with NEW_LOCAL/NEW_TEMPORARY (`--mxScope`); a
                // 1-based scope index `k` addresses the k-th declared
                // slot. Here the frame's `locals` vector is that region.
                XS_CODE_RESERVE_1 | XS_CODE_RESERVE_2 => {
                    // Space is grown lazily as NEW_LOCAL/NEW_TEMPORARY
                    // append; nothing to pre-allocate.
                    pc += size as usize;
                }
                XS_CODE_NEW_LOCAL => dispatch_flow!(self.exec_new_local(code, pc, ilen), pc),
                XS_CODE_NEW_TEMPORARY => {
                    self.locals.push(Slot::undefined());
                    pc += size as usize;
                }
                // Initialize/assign a scope slot from the stack top,
                // WITHOUT popping (the compiler emits an explicit POP
                // when the value is not wanted). `PULL_LOCAL` is the
                // popping variant.
                XS_CODE_VAR_LOCAL_1 | XS_CODE_VAR_LOCAL_2 | XS_CODE_LET_LOCAL_1
                | XS_CODE_LET_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    let top = dispatch_result!(self.peek_checked(), pc, self, return_depth, code);
                    self.set_local(k, top);
                    pc += size as usize;
                }
                XS_CODE_CONST_LOCAL_1 | XS_CODE_CONST_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    let top = dispatch_result!(self.peek_checked(), pc, self, return_depth, code);
                    self.set_local(k, top);
                    if let Some(index) = self.local_index(k) {
                        self.locals[index].flag |= XS_DONT_SET_FLAG;
                    }
                    pc += size as usize;
                }
                XS_CODE_SET_LOCAL_1 | XS_CODE_SET_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    let immutable = self
                        .local_index(k)
                        .is_some_and(|index| self.locals[index].flag & XS_DONT_SET_FLAG != 0);
                    if immutable {
                        let id = self.locals[self.local_index(k).expect("immutable binding")].id;
                        let error = self.internal_error(
                            "TypeError",
                            format!("set {}: const", self.id_name(id)),
                        );
                        dispatch_halt!(self.raise_js(error), pc, self, return_depth, code);
                    }
                    let top = dispatch_result!(self.peek_checked(), pc, self, return_depth, code);
                    self.set_local(k, top);
                    pc += size as usize;
                }
                XS_CODE_PULL_LOCAL_1 | XS_CODE_PULL_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    let immutable = self
                        .local_index(k)
                        .is_some_and(|index| self.locals[index].flag & XS_DONT_SET_FLAG != 0);
                    if immutable {
                        let id = self.locals[self.local_index(k).expect("immutable binding")].id;
                        let error = self.internal_error(
                            "TypeError",
                            format!("set {}: const", self.id_name(id)),
                        );
                        dispatch_halt!(self.raise_js(error), pc, self, return_depth, code);
                    }
                    let v = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    self.set_local(k, v);
                    pc += size as usize;
                }
                XS_CODE_GET_LOCAL_1 | XS_CODE_GET_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    match self.get_local(k) {
                        Some(s) => {
                            self.push(s);
                            pc += size as usize;
                        }
                        None => dispatch_flow!(
                            self.exec_get_local_uninitialized(code, return_depth, k),
                            pc
                        ),
                    }
                }
                // `reset_local #k` (xsRun.c:RESET_LOCAL): restore a lexical
                // loop-head binding to the uninitialized state before the
                // next iteration initializes it. Unlike RESET_CLOSURE this
                // reuses the existing scope slot and performs no allocation.
                XS_CODE_RESET_LOCAL_1 | XS_CODE_RESET_LOCAL_2 => {
                    let k = self.local_operand(op, code, pc);
                    if let Some(i) = self.local_index(k) {
                        let id = self.locals[i].id;
                        self.locals[i] = Slot::uninitialized();
                        self.locals[i].id = id;
                    }
                    pc += size as usize;
                }
                XS_CODE_UNWIND_1 | XS_CODE_UNWIND_2 => {
                    let n = self.local_operand(op, code, pc);
                    // Discard the n most-recently-declared scope slots
                    // (XS advances mxScope past them); prune their names.
                    let keep = self.locals.len().saturating_sub(n);
                    self.locals.truncate(keep);
                    std::rc::Rc::make_mut(&mut self.id_map).retain(|_, &mut idx| idx < keep);
                    pc += size as usize;
                }
                // ---- variables (environment-resolved names) ---------
                XS_CODE_GET_VARIABLE | XS_CODE_GET_THIS_VARIABLE => {
                    dispatch_flow!(self.exec_get_variable(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_TO_INSTANCE => {
                    dispatch_flow!(self.exec_to_instance(code, pc, return_depth, size), pc)
                }
                XS_CODE_SET_VARIABLE => {
                    dispatch_flow!(self.exec_set_variable(code, pc, return_depth, ilen), pc)
                }
                // ---- objects and properties -------------------------
                XS_CODE_OBJECT => dispatch_flow!(self.exec_object(pc, size), pc),
                XS_CODE_INSTANTIATE => {
                    dispatch_flow!(self.exec_instantiate(code, pc, return_depth, size), pc)
                }
                XS_CODE_ARRAY => dispatch_flow!(self.exec_array(pc, size), pc),
                XS_CODE_AT | XS_CODE_AT_2 => {
                    dispatch_flow!(self.exec_at(code, pc, return_depth, op, size), pc)
                }
                // `arr[k]` read (`XS_CODE_GET_PROPERTY_AT`). Stack:
                // [.., objectRef, atKey] → [.., value]. Like `GET_PROPERTY`,
                // meters no built-in step.
                XS_CODE_GET_PROPERTY_AT => {
                    let key = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let obj = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let s = dispatch_result!(
                        self.property_at_get(code, obj, key),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    self.push(s);
                    pc += size as usize;
                }
                // `arr[k] = v` (`XS_CODE_SET_PROPERTY_AT`). Stack:
                // [.., objectRef, atKey, value] → [.., value].
                XS_CODE_SET_PROPERTY_AT => {
                    let value = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let key = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let obj = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    dispatch_result!(
                        self.property_at_set(code, obj, key, value, false),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    self.push(value);
                    pc += size as usize;
                }
                XS_CODE_NEW_PROPERTY_AT => {
                    dispatch_flow!(self.exec_new_property_at(code, pc, return_depth), pc)
                }
                XS_CODE_FOR_OF | XS_CODE_FOR_AWAIT_OF => {
                    dispatch_flow!(self.exec_for_of(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_FOR_IN => {
                    dispatch_flow!(self.exec_for_in(code, pc, return_depth, size), pc)
                }
                XS_CODE_CHECK_INSTANCE => {
                    dispatch_flow!(self.exec_check_instance(code, pc, return_depth, size), pc)
                }
                XS_CODE_NEW_PROPERTY => {
                    dispatch_flow!(self.exec_new_property(code, pc, return_depth), pc)
                }
                XS_CODE_NEW_PRIVATE_1 | XS_CODE_NEW_PRIVATE_2 => {
                    dispatch_flow!(self.exec_new_private(code, pc, return_depth, op, ilen), pc)
                }
                XS_CODE_GET_PRIVATE_1 | XS_CODE_GET_PRIVATE_2 => {
                    dispatch_flow!(self.exec_get_private(code, pc, return_depth, op, ilen), pc)
                }
                XS_CODE_SET_PRIVATE_1 | XS_CODE_SET_PRIVATE_2 => {
                    dispatch_flow!(self.exec_set_private(code, pc, return_depth, op, ilen), pc)
                }
                XS_CODE_HAS_PRIVATE_1 | XS_CODE_HAS_PRIVATE_2 => {
                    dispatch_flow!(self.exec_has_private(code, pc, return_depth, op, ilen), pc)
                }
                // `o.k = v`. Stack: [.., objectRef, value] → [.., value].
                // Unlike `SET_VARIABLE`, the handler runs no `fxRunHas`
                // pre-check, so an overwrite meters nothing and a create
                // meters only the property allocation (536) — verified
                // against the pin's raw meter.
                XS_CODE_SET_PROPERTY => {
                    let id = operand_id(code, pc, 1);
                    dispatch_result!(
                        self.dispatch_set_property(code, id),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += ilen;
                }
                // `o.k`. Stack: [.., objectRef] → [.., value]. The handler
                // calls `mxBehaviorGetProperty` directly (no `mxGetID`
                // wrapper), so — like `GET_VARIABLE` — a property read
                // meters no built-in step (verified against the pin: a
                // repeated `o.a;` adds only its dispatch computrons).
                XS_CODE_GET_PROPERTY => {
                    let id = operand_id(code, pc, 1);
                    dispatch_result!(
                        self.dispatch_get_property(code, id),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += ilen;
                }
                XS_CODE_DELETE_PROPERTY => {
                    dispatch_flow!(self.exec_delete_property(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_DELETE_PROPERTY_AT => dispatch_flow!(
                    self.exec_delete_property_at(code, pc, return_depth, size),
                    pc
                ),
                XS_CODE_COPY_OBJECT => dispatch_flow!(self.exec_copy_object(pc, ilen), pc),
                // ---- user functions: definition ---------------------
                XS_CODE_CONSTRUCTOR_FUNCTION | XS_CODE_FUNCTION => {
                    dispatch_flow!(self.exec_constructor_function(code, pc, op, ilen), pc)
                }
                XS_CODE_GENERATOR_FUNCTION => {
                    dispatch_flow!(self.exec_generator_function(code, pc, ilen), pc)
                }
                XS_CODE_ASYNC_FUNCTION => {
                    dispatch_flow!(self.exec_async_function(code, pc, ilen), pc)
                }
                XS_CODE_ASYNC_GENERATOR_FUNCTION => {
                    dispatch_flow!(self.exec_async_generator_function(code, pc, ilen), pc)
                }
                XS_CODE_CODE_1 | XS_CODE_CODE_2 | XS_CODE_CODE_4 => {
                    dispatch_flow!(self.exec_code(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_FUNCTION_ENVIRONMENT | XS_CODE_ENVIRONMENT => dispatch_flow!(
                    self.exec_function_environment(code, pc, return_depth, op, size),
                    pc
                ),
                XS_CODE_EXTEND => {
                    dispatch_flow!(self.exec_extend(code, pc, return_depth, size), pc)
                }
                XS_CODE_CLASS => dispatch_flow!(self.exec_class(code, pc, return_depth, size), pc),
                XS_CODE_SET_HOME => {
                    dispatch_flow!(self.exec_set_home(code, pc, return_depth, size), pc)
                }
                XS_CODE_NAME => dispatch_flow!(self.exec_name(code, pc, return_depth, ilen), pc),
                // ---- user functions: call --------------------------
                // `call` (`XS_CODE_CALL`): reserve the RESULT (undefined)
                // and FRAME (marker) slots above the already-pushed
                // FUNCTION and THIS. No heap allocation — the frame lives on
                // the value stack (metered by dispatch only).
                XS_CODE_CALL => {
                    self.push(Slot::undefined()); // RESULT
                    self.push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
                    pc += size as usize;
                }
                XS_CODE_NEW => dispatch_flow!(self.exec_new(code, pc, return_depth, size), pc),
                XS_CODE_SUPER => dispatch_flow!(self.exec_super(code, pc, return_depth, size), pc),
                XS_CODE_EVAL | XS_CODE_EVAL_TAIL => {
                    dispatch_flow!(self.exec_eval(code, pc, return_depth, size), pc)
                }
                XS_CODE_RUN | XS_CODE_RUN_1 | XS_CODE_RUN_2 | XS_CODE_RUN_4 | XS_CODE_RUN_TAIL
                | XS_CODE_RUN_TAIL_1 | XS_CODE_RUN_TAIL_2 | XS_CODE_RUN_TAIL_4 => {
                    dispatch_flow!(self.exec_run(code, pc, return_depth, op, size), pc)
                }
                // `argument i` (`XS_CODE_ARGUMENT`): push the frame's i-th
                // positional argument (`mxFrameArgv(i)`), or `undefined`
                // when fewer were passed.
                XS_CODE_ARGUMENT => {
                    let i = operand_u1(code, pc, 1);
                    let v = self.args.get(i).copied().unwrap_or_else(Slot::undefined);
                    self.push(v);
                    pc += size as usize;
                }
                // ---- closures (captured variables via heap cells) ---
                XS_CODE_NEW_CLOSURE => dispatch_flow!(self.exec_new_closure(code, pc, ilen), pc),
                XS_CODE_GET_CLOSURE_1 | XS_CODE_GET_CLOSURE_2 => {
                    dispatch_flow!(self.exec_get_closure(code, pc, return_depth, op), pc)
                }
                // `var_closure #k` / `set_closure #k` / `let_closure #k` /
                // `const_closure #k`: write the shared cell from the stack
                // top **without** popping (an explicit `pop` discards it when
                // unwanted). XS's `let_closure`/`const_closure`
                // (xsRun.c:LET_CLOSURE/CONST_CLOSURE) initialize a
                // `let`/`const` binding's cell exactly as `set_closure`
                // writes it; the const "already initialized" guard and the
                // DONT_SET/DONT_ENUM flags are stamped by CONST_CLOSURE below;
                // a later SET_CLOSURE must enforce the immutable binding with
                // a catchable TypeError.
                XS_CODE_VAR_CLOSURE_1
                | XS_CODE_VAR_CLOSURE_2
                | XS_CODE_LET_CLOSURE_1
                | XS_CODE_LET_CLOSURE_2 => {
                    let k = self.closure_index(op, code, pc);
                    let top = dispatch_result!(self.peek_checked(), pc, self, return_depth, code);
                    self.write_closure_cell(k, top);
                    pc += op.size() as usize;
                }
                XS_CODE_SET_CLOSURE_1 | XS_CODE_SET_CLOSURE_2 => {
                    dispatch_flow!(self.exec_set_closure(code, pc, return_depth, op), pc)
                }
                XS_CODE_CONST_CLOSURE_1 | XS_CODE_CONST_CLOSURE_2 => {
                    dispatch_flow!(self.exec_const_closure(code, pc, return_depth, op), pc)
                }
                XS_CODE_RESET_CLOSURE_1 | XS_CODE_RESET_CLOSURE_2 => {
                    dispatch_flow!(self.exec_reset_closure(code, pc, op), pc)
                }
                XS_CODE_REFRESH_CLOSURE_1 | XS_CODE_REFRESH_CLOSURE_2 => {
                    dispatch_flow!(self.exec_refresh_closure(code, pc, op), pc)
                }
                XS_CODE_REFRESH_LOCAL_1 | XS_CODE_REFRESH_LOCAL_2 => {
                    dispatch_flow!(self.exec_refresh_local(pc, op), pc)
                }
                XS_CODE_PULL_CLOSURE_1 | XS_CODE_PULL_CLOSURE_2 => {
                    dispatch_flow!(self.exec_pull_closure(code, pc, return_depth, op), pc)
                }
                XS_CODE_RETRIEVE_1 | XS_CODE_RETRIEVE_2 => {
                    dispatch_flow!(self.exec_retrieve(code, pc, op), pc)
                }
                XS_CODE_RETRIEVE_TARGET => dispatch_flow!(self.exec_retrieve_target(pc, size), pc),
                XS_CODE_RETRIEVE_THIS => dispatch_flow!(self.exec_retrieve_this(pc, size), pc),
                XS_CODE_STORE_1 | XS_CODE_STORE_2 => {
                    dispatch_flow!(self.exec_store(code, pc, return_depth, op), pc)
                }
                XS_CODE_STORE_ARROW => dispatch_flow!(self.exec_store_arrow(pc, size), pc),
                // ---- literals ---------------------------------------
                XS_CODE_INTEGER_1 => {
                    self.push(Slot::integer(operand_s1(code, pc, 1)));
                    pc += size as usize;
                }
                XS_CODE_INTEGER_2 => {
                    let v = i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32;
                    self.push(Slot::integer(v));
                    pc += size as usize;
                }
                XS_CODE_INTEGER_4 => {
                    let v = i32::from_le_bytes([
                        code[pc + 1],
                        code[pc + 2],
                        code[pc + 3],
                        code[pc + 4],
                    ]);
                    self.push(Slot::integer(v));
                    pc += size as usize;
                }
                XS_CODE_NUMBER => {
                    let mut b = [0u8; 8];
                    b.copy_from_slice(&code[pc + 1..pc + 9]);
                    self.push(Slot::number(f64::from_le_bytes(b)));
                    pc += size as usize;
                }
                XS_CODE_TRUE => {
                    self.push(Slot::boolean(true));
                    pc += size as usize;
                }
                XS_CODE_FALSE => {
                    self.push(Slot::boolean(false));
                    pc += size as usize;
                }
                XS_CODE_NULL => {
                    self.push(Slot::null());
                    pc += size as usize;
                }
                XS_CODE_UNDEFINED => {
                    self.push(Slot::undefined());
                    pc += size as usize;
                }
                XS_CODE_SYMBOL => dispatch_flow!(self.exec_symbol(code, pc, ilen), pc),
                XS_CODE_REGEXP => dispatch_flow!(self.exec_regexp(pc, size), pc),
                XS_CODE_STRING_1 | XS_CODE_STRING_2 | XS_CODE_STRING_4 => {
                    dispatch_flow!(self.exec_string(code, pc, op, ilen), pc)
                }
                XS_CODE_BIGINT_1 | XS_CODE_BIGINT_2 => {
                    dispatch_flow!(self.exec_bigint(code, pc, op, ilen), pc)
                }
                XS_CODE_TYPEOF => {
                    dispatch_flow!(self.exec_typeof(code, pc, return_depth, size), pc)
                }
                // ---- arithmetic -------------------------------------
                XS_CODE_ADD => {
                    dispatch_result!(self.op_add(code), pc, self, return_depth, code);
                    pc += size as usize;
                }
                XS_CODE_SUBTRACT => {
                    dispatch_result!(
                        self.binary_arith(code, ArithOp::Sub),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_MULTIPLY => {
                    dispatch_result!(
                        self.binary_arith(code, ArithOp::Mul),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_DIVIDE => {
                    dispatch_result!(
                        self.binary_arith(code, ArithOp::Div),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_MODULO => {
                    dispatch_result!(
                        self.binary_arith(code, ArithOp::Mod),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                // ---- bitwise ----------------------------------------
                XS_CODE_BIT_AND => {
                    dispatch_flow!(self.exec_bit_and(code, pc, return_depth, size), pc)
                }
                XS_CODE_BIT_OR => {
                    dispatch_flow!(self.exec_bit_or(code, pc, return_depth, size), pc)
                }
                XS_CODE_BIT_XOR => {
                    dispatch_flow!(self.exec_bit_xor(code, pc, return_depth, size), pc)
                }
                XS_CODE_LEFT_SHIFT => {
                    dispatch_flow!(self.exec_left_shift(code, pc, return_depth, size), pc)
                }
                XS_CODE_SIGNED_RIGHT_SHIFT => dispatch_flow!(
                    self.exec_signed_right_shift(code, pc, return_depth, size),
                    pc
                ),
                XS_CODE_UNSIGNED_RIGHT_SHIFT => dispatch_flow!(
                    self.exec_unsigned_right_shift(code, pc, return_depth, size),
                    pc
                ),
                XS_CODE_BIT_NOT => {
                    dispatch_flow!(self.exec_bit_not(code, pc, return_depth, size), pc)
                }
                // ---- comparison -------------------------------------
                XS_CODE_LESS => {
                    dispatch_result!(
                        self.relational(code, RelOp::Less),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_LESS_EQUAL => {
                    dispatch_result!(
                        self.relational(code, RelOp::LessEqual),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_MORE => {
                    dispatch_result!(
                        self.relational(code, RelOp::More),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_MORE_EQUAL => {
                    dispatch_result!(
                        self.relational(code, RelOp::MoreEqual),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_STRICT_EQUAL => {
                    dispatch_result!(
                        self.equality(code, true, false),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_STRICT_NOT_EQUAL => {
                    dispatch_result!(
                        self.equality(code, true, true),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_EQUAL => {
                    dispatch_result!(
                        self.equality(code, false, false),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                XS_CODE_NOT_EQUAL => {
                    dispatch_result!(
                        self.equality(code, false, true),
                        pc,
                        self,
                        return_depth,
                        code
                    );
                    pc += size as usize;
                }
                // ---- unary ------------------------------------------
                XS_CODE_MINUS => dispatch_flow!(self.exec_minus(code, pc, return_depth, size), pc),
                XS_CODE_PLUS => dispatch_flow!(self.exec_plus(code, pc, return_depth, size), pc),
                XS_CODE_NOT => dispatch_flow!(self.exec_not(code, pc, return_depth, size), pc),
                XS_CODE_VOID => dispatch_flow!(self.exec_void(code, pc, return_depth, size), pc),
                // ---- Global and object opcodes ---------------------
                XS_CODE_GLOBAL => dispatch_flow!(self.exec_global(pc, size), pc),
                XS_CODE_GET_THIS => {
                    dispatch_flow!(self.exec_get_this(code, pc, return_depth, size), pc)
                }
                XS_CODE_SUPER_AT | XS_CODE_SUPER_AT_2 => {
                    dispatch_flow!(self.exec_super_at(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_SET_THIS => {
                    dispatch_flow!(self.exec_set_this(code, pc, return_depth, size), pc)
                }
                XS_CODE_GET_SUPER => {
                    dispatch_flow!(self.exec_get_super(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_GET_SUPER_AT => {
                    dispatch_flow!(self.exec_get_super_at(code, pc, return_depth, size), pc)
                }
                XS_CODE_SET_SUPER => {
                    dispatch_flow!(self.exec_set_super(code, pc, return_depth, ilen), pc)
                }
                XS_CODE_SET_SUPER_AT => {
                    dispatch_flow!(self.exec_set_super_at(code, pc, return_depth, size), pc)
                }
                XS_CODE_TEMPLATE_CACHE => dispatch_flow!(self.exec_template_cache(pc, size), pc),
                XS_CODE_TEMPLATE => dispatch_flow!(self.exec_template(pc, size), pc),
                // `this` (XS_CODE_THIS, xsRun.c:1334): push the frame's
                // `this` (`*mxFrameThis`). Bound to the realm global for a
                // top-level script frame (set at program entry) and for a
                // sloppy function call; dispatch-metered.
                XS_CODE_THIS => {
                    let t = self.this_val;
                    self.push(t);
                    pc += size as usize;
                }
                XS_CODE_TARGET => dispatch_flow!(self.exec_target(pc, size), pc),
                XS_CODE_CURRENT => dispatch_flow!(self.exec_current(pc, size), pc),
                XS_CODE_TO_NUMERIC => {
                    dispatch_flow!(self.exec_to_numeric(code, pc, return_depth, size), pc)
                }
                XS_CODE_TO_STRING => {
                    dispatch_flow!(self.exec_to_string(code, pc, return_depth, size), pc)
                }
                XS_CODE_INCREMENT | XS_CODE_DECREMENT => {
                    dispatch_flow!(self.exec_increment(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_EXPONENTIATION => {
                    dispatch_flow!(self.exec_exponentiation(code, pc, return_depth, size), pc)
                }
                XS_CODE_INSTANCEOF => {
                    dispatch_flow!(self.exec_instanceof(code, pc, return_depth, size), pc)
                }
                XS_CODE_IN => dispatch_flow!(self.exec_in(code, pc, return_depth, size), pc),
                // ---- stack ------------------------------------------
                XS_CODE_DUB => {
                    let top = dispatch_result!(self.peek_checked(), pc, self, return_depth, code);
                    self.push(top);
                    pc += size as usize;
                }
                XS_CODE_DUB_AT => dispatch_flow!(self.exec_dub_at(pc, size), pc),
                XS_CODE_POP => {
                    let _ = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    pc += size as usize;
                }
                // `swap` (`XS_CODE_SWAP`): exchange the top two stack slots
                // (`aSlot = mxStack[0]; mxStack[0] = mxStack[1];
                // mxStack[1] = aSlot`). Pure stack, dispatch-metered.
                XS_CODE_SWAP => {
                    let n = self.stack.len();
                    if n < 2 {
                        return Step::Host(Halt::EngineInvariant("value-stack:underflow"));
                    }
                    self.stack.swap(n - 1, n - 2);
                    pc += size as usize;
                }
                // Debug / source markers (`line`, `file`, `debugger`,
                // `profile`): semantics-free in the run — a debug build
                // uses them for source mapping and breakpoints, the engine
                // otherwise steps past them. Dispatch-metered (as XS
                // meters them under `mxMetering`), no stack/heap effect.
                // The covered grammar's captured bytecode does not emit
                // them, but stubbing keeps decode+dispatch total.
                // (`file` is an ID-operand opcode, `size == 0`, so it must
                // advance by the resolved `ilen`, never `size`.)
                XS_CODE_LINE | XS_CODE_FILE | XS_CODE_DEBUGGER | XS_CODE_PROFILE => {
                    pc += ilen;
                }
                // ---- branches ---------------------------------------
                // mxBranch: target = pc + INDEX(size) + OFFSET(operand).
                // XS runs `mxCheckMeter` only when the taken offset is
                // negative (a backward branch — the loop-closing point);
                // an armed host refusal aborts with `Halt::MeterAbort`.
                XS_CODE_BRANCH_1 => {
                    let off = operand_s1(code, pc, 1);
                    if off < 0 && self.check_meter() == MeterCheck::Abort {
                        return Step::Host(Halt::MeterAbort);
                    }
                    pc = branch_target(pc, size, off);
                }
                XS_CODE_BRANCH_2 => {
                    let off = i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32;
                    if off < 0 && self.check_meter() == MeterCheck::Abort {
                        return Step::Host(Halt::MeterAbort);
                    }
                    pc = branch_target(pc, size, off);
                }
                XS_CODE_BRANCH_4 => {
                    let off = i32::from_le_bytes([
                        code[pc + 1],
                        code[pc + 2],
                        code[pc + 3],
                        code[pc + 4],
                    ]);
                    if off < 0 && self.check_meter() == MeterCheck::Abort {
                        return Step::Host(Halt::MeterAbort);
                    }
                    pc = branch_target(pc, size, off);
                }
                XS_CODE_BRANCH_STATUS_1 | XS_CODE_BRANCH_STATUS_2 | XS_CODE_BRANCH_STATUS_4 => {
                    dispatch_flow!(
                        self.exec_branch_status(code, pc, return_depth, op, size),
                        pc
                    )
                }
                // mxBranchElse: the fall-through (cond true) takes INDEX
                // with no check; only the branch-taken (cond false) path
                // is an `mxBranch`, so it checks when its offset < 0.
                XS_CODE_BRANCH_ELSE_1 => {
                    let off = operand_s1(code, pc, 1);
                    let v = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let cond = self.truthy(&v);
                    if cond {
                        pc += size as usize;
                    } else {
                        if off < 0 && self.check_meter() == MeterCheck::Abort {
                            return Step::Host(Halt::MeterAbort);
                        }
                        pc = branch_target(pc, size, off);
                    }
                }
                XS_CODE_BRANCH_ELSE_2 => {
                    let off = i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32;
                    let v = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let cond = self.truthy(&v);
                    if cond {
                        pc += size as usize;
                    } else {
                        if off < 0 && self.check_meter() == MeterCheck::Abort {
                            return Step::Host(Halt::MeterAbort);
                        }
                        pc = branch_target(pc, size, off);
                    }
                }
                // mxBranchIf: the branch-taken (cond true) path is the
                // `mxBranch`, so it checks when its offset < 0; the
                // fall-through takes INDEX with no check.
                XS_CODE_BRANCH_IF_1 => {
                    let off = operand_s1(code, pc, 1);
                    let v = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let cond = self.truthy(&v);
                    if cond {
                        if off < 0 && self.check_meter() == MeterCheck::Abort {
                            return Step::Host(Halt::MeterAbort);
                        }
                        pc = branch_target(pc, size, off);
                    } else {
                        pc += size as usize;
                    }
                }
                XS_CODE_BRANCH_IF_2 => {
                    let off = i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32;
                    let v = dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    let cond = self.truthy(&v);
                    if cond {
                        if off < 0 && self.check_meter() == MeterCheck::Abort {
                            return Step::Host(Halt::MeterAbort);
                        }
                        pc = branch_target(pc, size, off);
                    } else {
                        pc += size as usize;
                    }
                }
                XS_CODE_BRANCH_COALESCE_1
                | XS_CODE_BRANCH_COALESCE_2
                | XS_CODE_BRANCH_COALESCE_4 => dispatch_flow!(
                    self.exec_branch_coalesce(code, pc, return_depth, op, size),
                    pc
                ),
                XS_CODE_BRANCH_CHAIN_1 | XS_CODE_BRANCH_CHAIN_2 | XS_CODE_BRANCH_CHAIN_4 => {
                    dispatch_flow!(self.exec_branch_chain(code, pc, return_depth, op, size), pc)
                }
                // ---- result / return --------------------------------
                XS_CODE_SET_RESULT => {
                    self.result =
                        dispatch_result!(self.pop_checked(), pc, self, return_depth, code);
                    pc += size as usize;
                }
                XS_CODE_GET_RESULT => {
                    let r = self.result;
                    self.push(r);
                    pc += size as usize;
                }
                XS_CODE_END | XS_CODE_END_ARROW | XS_CODE_END_BASE | XS_CODE_END_DERIVED => {
                    dispatch_flow!(self.exec_end(code, return_depth, op), pc)
                }
                XS_CODE_RETURN => dispatch_flow!(self.exec_return(return_depth), pc),
                // ---- generators -------------------------------------
                XS_CODE_START_GENERATOR => {
                    dispatch_flow!(self.exec_start_generator(pc, return_depth, size), pc)
                }
                XS_CODE_YIELD | XS_CODE_YIELD_STAR => {
                    dispatch_flow!(self.exec_yield(code, pc, return_depth, size), pc)
                }
                // ---- async functions --------------------------------
                XS_CODE_START_ASYNC_GENERATOR => {
                    dispatch_flow!(self.exec_start_async_generator(pc, return_depth, size), pc)
                }
                XS_CODE_START_ASYNC => {
                    dispatch_flow!(self.exec_start_async(code, pc, return_depth, size), pc)
                }
                XS_CODE_AWAIT => dispatch_flow!(self.exec_await(code, pc, return_depth, size), pc),
                // ---- exceptions: the jump-buffer chain --------------
                XS_CODE_CATCH_1 | XS_CODE_CATCH_2 | XS_CODE_CATCH_4 => {
                    dispatch_flow!(self.exec_catch(code, pc, op, size), pc)
                }
                // `uncatch` (`XS_CODE_UNCATCH`, xsRun.c:1440): the try body
                // completed normally; pop the handler off the chain.
                XS_CODE_UNCATCH => {
                    self.jumps.pop();
                    pc += size as usize;
                }
                XS_CODE_EXCEPTION => dispatch_flow!(self.exec_exception(pc, size), pc),
                XS_CODE_THROW => dispatch_flow!(self.exec_throw(code, return_depth), pc),
                XS_CODE_RETHROW => dispatch_flow!(self.exec_rethrow(code, return_depth), pc),
                XS_CODE_THROW_STATUS => dispatch_flow!(self.exec_throw_status(pc, size), pc),
                XS_CODE_USING | XS_CODE_USING_ASYNC => {
                    dispatch_flow!(self.exec_using(code, pc, return_depth, op, size), pc)
                }
                XS_CODE_USED_1 | XS_CODE_USED_2 => {
                    dispatch_flow!(self.exec_used(code, pc, op, size), pc)
                }
                XS_CODE_TRANSFER | XS_CODE_TRANSFER_JSON => {
                    dispatch_flow!(self.exec_transfer(code, pc, return_depth, size), pc)
                }
                XS_CODE_MODULE => {
                    dispatch_flow!(self.exec_module(code, pc, return_depth, size), pc)
                }
                XS_CODE_IMPORT => dispatch_flow!(self.exec_import(), pc),
                XS_CODE_IMPORT_META => dispatch_flow!(self.exec_import_meta(), pc),
                other => {
                    // `XS_NO_CODE` (byte 0) has an empty mnemonic, and an
                    // empty label names nothing to a reader and registers
                    // nothing: give the nameless opcode its own literal so the
                    // refusal still says what stopped the run.
                    if other.name().is_empty() {
                        return Step::Host(Halt::NotImplemented("opcode:no-code"));
                    }
                    return Step::Host(Halt::NotImplemented(other.name()));
                }
            }
        }
    }
}

/// The arms outlined from [`Interp::dispatch_at_inner`], in the loop's order.
/// Each runs one opcode in its own frame and tells the loop how to go on
/// ([`Flow`]); the loop enters each through [`dispatch_flow!`].
impl Interp {
    // ---- program prologue / frame -----------------------

    /// The dispatch loop's `BEGIN_SLOPPY` arm.
    #[inline(never)]
    fn exec_begin_sloppy(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        // `this` setup (`XS_CODE_BEGIN_SLOPPY` in `xsRun.c`):
        // an `undefined`/`null` `this` in a sloppy frame binds
        // to the realm global. The program-frame + eval-env
        // setup overhead XS meters outside the captured
        // bytecode is a property of the *program* invocation
        // (`fxRunProgram`), so it accrues only on the top-level
        // program's `begin` — a function frame's `begin` (a
        // stack-based `run` set it up, dispatch-only) does not.
        if self.call_stack.is_empty() {
            self.tick_program_overhead();
            if !self.direct_eval_hoist {
                self.bind_program_this();
            }
        } else if self.cur_target {
            // A constructor frame (`new f(...)`): allocate the
            // `this` instance (`fxRunConstructor`) before the body.
            dispatch_result_flow!(self.run_constructor(code), self, return_depth, code);
        } else {
            self.bind_this_sloppy();
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `BEGIN_STRICT` arm, which also runs `BEGIN_STRICT_BASE`,
    /// `BEGIN_STRICT_DERIVED` and `BEGIN_STRICT_FIELD`.
    #[inline(never)]
    fn exec_begin_strict(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        self.strict = true;
        if self.call_stack.is_empty() {
            self.tick_program_overhead();
            // A top-level *script* frame's `this` is the realm
            // global in strict mode too (only an ES module's is
            // `undefined`). A direct eval instead retains its
            // caller's `this` binding across the nested dispatch.
            if !self.direct_eval_hoist {
                self.bind_program_this();
            }
        } else {
            match op {
                XS_CODE_BEGIN_STRICT_BASE => {
                    // A class constructor is never callable without
                    // `new`.  Base construction allocates `this`
                    // before the constructor body begins.
                    if !self.cur_target {
                        let error = self.internal_error("TypeError", "call: class".into());
                        dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
                    }
                    dispatch_result_flow!(self.run_constructor(code), self, return_depth, code);
                }
                XS_CODE_BEGIN_STRICT_DERIVED => {
                    // A derived constructor starts with an
                    // uninitialized `this`; `super()` supplies it.
                    if !self.cur_target {
                        let error = self.internal_error("TypeError", "call: class".into());
                        dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
                    }
                    self.this_val = Slot::uninitialized();
                }
                XS_CODE_BEGIN_STRICT if self.cur_target => {
                    dispatch_result_flow!(self.run_constructor(code), self, return_depth, code);
                }
                // Field initializers run as strict methods with an
                // already-supplied receiver.
                _ => {}
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // Materialize the active frame's arguments as an iterable
    // indexed object. The default derived constructor uses the plain
    // `XS_CODE_ARGUMENTS` form to forward all arguments through
    // `super(...args)`, where the operand is a leading-slot offset.
    // The `_SLOPPY`/`_STRICT` forms build the `arguments` object
    // itself: there the operand is the formal-parameter count
    // (`fxRunArguments`'s aliasing count), NOT a skip offset — the
    // object contains ALL passed arguments, so `arguments.length`
    // must equal the actual argument count.
    /// The dispatch loop's `ARGUMENTS` arm, which also runs `ARGUMENTS_SLOPPY` and
    /// `ARGUMENTS_STRICT`.
    #[inline(never)]
    fn exec_arguments(&mut self, code: &[u8], mut pc: usize, op: Opcode, size: i8) -> Flow {
        use Opcode::*;
        let offset = if op == XS_CODE_ARGUMENTS {
            code[pc + 1] as usize
        } else {
            0
        };
        let values: Vec<Slot> = self.args.iter().copied().skip(offset).collect();
        let array = self.new_array();
        if let Some(data) = self.arrays.get_mut(&array) {
            data.length = values.len() as u32;
            for (index, value) in values.into_iter().enumerate() {
                data.insert_item(index as u32, value, &mut self.side_refs);
            }
        }
        // The `_SLOPPY`/`_STRICT` forms build the user-visible
        // `arguments` exotic object (the plain `XS_CODE_ARGUMENTS`
        // form is an internal `super(...args)` spread array, never
        // `arguments` itself). Mark it so a bare `arguments`
        // completion renders as its `[object Arguments]` builtinTag
        // (`render`), not `Array.prototype.join`. Display-only — the
        // indexed element storage is unchanged.
        if op == XS_CODE_ARGUMENTS_SLOPPY || op == XS_CODE_ARGUMENTS_STRICT {
            self.arguments_objects.insert(array);
            // Compact indexed storage is independent of the
            // language-visible prototype. Arguments objects start
            // on `%Object.prototype%`; keeping that prototype in
            // the instance slot also lets an explicit later
            // `%Array.prototype%` assignment expose inherited
            // Array methods normally.
            self.slots.get_mut(array).value = Payload::Reference(self.object_proto);
            // CreateMappedArgumentsObject and
            // CreateUnmappedArgumentsObject both install an own
            // @@iterator whose value is Array.prototype.values.
            // The former inherited implementation happened to
            // expose that method through the storage prototype;
            // reify the required own property now that storage and
            // language prototypes are distinct.
            if let Some(iterator_id) = self.well_known_symbol_property_id("iterator") {
                let values = self
                    .proto_methods
                    .iter()
                    .find(|(holder, name, _)| *holder == self.array_proto && *name == "values")
                    .map(|(_, _, method)| *method);
                if let Some(values) = values {
                    self.set_own_unmetered_with_flag(
                        array,
                        iterator_id,
                        Slot::of(Kind::Reference, Payload::Reference(values)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            }
            // Unlike an Array's exotic, non-configurable `length`,
            // an arguments object's `length` is an ordinary own data
            // property: writable and configurable, but not
            // enumerable. Keep it in the ordinary slot chain so
            // assignment, definition, deletion, ownKeys, snapshots,
            // and proxy forwarding all observe those attributes.
            let length_id = self.intern_static_key_unmetered("length");
            self.set_own_unmetered_with_flag(
                array,
                length_id,
                Slot::integer(self.arrays[&array].length as i32),
                XS_DONT_ENUM_FLAG,
            );
            // `callee`, after `length` as XS's `fxNewArgumentsSloppyInstance`
            // and `fxNewArgumentsStrictInstance` add it: the running function,
            // writable and configurable, in a mapped object;
            // `%ThrowTypeError%` as both accessor halves, non-configurable, in
            // an unmapped one.
            let callee_id = self.intern_static_key_unmetered("callee");
            if op == XS_CODE_ARGUMENTS_SLOPPY {
                if !self.cur_func.is_null() {
                    self.set_own_unmetered_with_flag(
                        array,
                        callee_id,
                        Slot::of(Kind::Reference, Payload::Reference(self.cur_func)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            } else if let Some(thrower) = self.throw_type_error_function() {
                let thrower = Slot::of(Kind::Reference, Payload::Reference(thrower));
                self.set_own_accessor_unmetered(array, callee_id, Some(thrower), Some(thrower));
                if let Some(property) = self.find_property(array, callee_id) {
                    self.slots.get_mut(property).flag |= XS_DONT_DELETE_FLAG;
                }
            }
            // A non-strict simple parameter list creates a mapped
            // arguments object. XS compiles each formal's
            // initialization immediately after this instruction as
            // `argument i; var_closure k`; retain the closure-cell
            // edge in the indexed item so later parameter writes are
            // observed by `arguments[i]`, including after the frame
            // returns or a snapshot round-trip. Duplicate parameter
            // names map only their last occurrence.
            if op == XS_CODE_ARGUMENTS_SLOPPY {
                let formal_count = code[pc + 1] as usize;
                let cells = self.sloppy_argument_cells(code, pc + size as usize, formal_count);
                for (index, cell) in cells.into_iter().enumerate() {
                    let Some(cell) = cell else { continue };
                    if index >= self.arrays[&array].length as usize {
                        continue;
                    }
                    let mut mapped = Slot::of(Kind::Closure, Payload::Reference(cell));
                    mapped.flag = self.arrays[&array]
                        .items()
                        .get(&(index as u32))
                        .map(|item| item.flag)
                        .unwrap_or(0);
                    self.arrays.get_mut(&array).unwrap().insert_item(
                        index as u32,
                        mapped,
                        &mut self.side_refs,
                    );
                }
            }
        }
        self.push(Slot::of(Kind::Reference, Payload::Reference(array)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // The environment opcodes establish/refer to the frame's
    // variable environment. `EVAL_ENVIRONMENT` /
    // `PROGRAM_ENVIRONMENT` build it (a no-op here: the
    // frame's `locals` + `id_map` are the environment);
    // `EVAL_REFERENCE` / `PROGRAM_REFERENCE` push the
    // reference `GET_VARIABLE`/`SET_VARIABLE` resolve a name
    // against — the frame scope when the id is a declared
    // local, else the global object.
    /// The dispatch loop's `EVAL_ENVIRONMENT` arm, which also runs `PROGRAM_ENVIRONMENT`.
    #[inline(never)]
    fn exec_eval_environment(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        // `fxRunEvalEnvironment`: a top-level program's `var`
        // bindings hoist onto the global object as own
        // properties (varEnvironment is null, so the global
        // branch runs). Materialize each declared name's
        // global property here — that is where XS allocates
        // it — metering the allocation faithfully. The frame
        // property slots hold the working value from here on. A
        // top-level function declaration that fails
        // `CanDeclareGlobalFunction` (e.g. `function NaN(){}`)
        // raises a realm `TypeError` here, before any body runs.
        if let Err(error) = self.hoist_vars_to_global() {
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        // `fxRunEvalEnvironment` ends `the->scope = top + 1`,
        // resetting the scope region: the hoisted vars now live
        // in the global object, and their scope slots are freed
        // and reused (a following `RESERVE`/`NEW_TEMPORARY`
        // reuses scope index 1 — this is why an object-literal
        // temporary and a hoisted var can both address `#1`).
        // Reads/writes of a top-level var resolve to its global
        // property from here (`resolve_get`/`resolve_set`).
        self.locals.clear();
        std::rc::Rc::make_mut(&mut self.id_map).clear();
        pc += size as usize;
        Flow::Next(pc)
    }

    // `eval_private` (xsRun.c:XS_CODE_EVAL_PRIVATE): a direct eval's private
    // name, found as the closure its caller's environment publishes; the
    // following `CONST_CLOSURE` binds it. A name no enclosing class declares
    // is XS's SyntaxError.
    /// The dispatch loop's `EVAL_PRIVATE` arm.
    #[inline(never)]
    fn exec_eval_private(
        &mut self,
        code: &[u8],
        pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        use Opcode::*;
        let name = operand_id(code, pc, 1);
        let Some(brand) = self.eval_private_brand(name) else {
            let error = self.internal_error(
                "SyntaxError",
                format!("eval {}: undefined private property", self.id_name(name)),
            );
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        };
        // The coder always follows `EVAL_PRIVATE` with the `CONST_CLOSURE`
        // that binds the eval's private name. Bind it here, to the brand's
        // own cell, since a brand is its cell's identity, not a value it
        // holds: the brand never enters the stack, where another
        // `CONST_CLOSURE` could bind it. The bound instruction is metered and
        // counted as XS dispatches it, and `undefined` stands for the value
        // its `POP` drops.
        let next = pc + ilen;
        let bind = code
            .get(next)
            .copied()
            .and_then(Opcode::from_u8)
            .filter(|op| {
                matches!(op, XS_CODE_CONST_CLOSURE_1 | XS_CODE_CONST_CLOSURE_2)
                    && next + op.size() as usize <= code.len()
            });
        let Some(bind) = bind else {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("eval_private:unbound")));
        };
        let k = self.closure_index(bind, code, next);
        self.alias_eval_private(k, brand);
        self.meter.tick_code();
        self.n_dispatched += 1;
        self.cost.on_dispatch(bind);
        self.push(Slot::undefined());
        Flow::Next(next + bind.size() as usize)
    }

    /// The dispatch loop's `EVAL_REFERENCE` arm, which also runs `PROGRAM_REFERENCE`.
    #[inline(never)]
    fn exec_eval_reference(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let name = operand_id(code, pc, 1);
        dispatch_result_flow!(
            self.dispatch_eval_reference(code, name),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    // `with` (`XS_CODE_WITH`, xsRun.c ~L4429): establish an object
    // environment over the top-of-stack `with` value (already
    // `ToObject`-coerced by the preceding `TO_INSTANCE`).
    // `fxNewEnvironmentInstance` allocates the 2-slot environment
    // instance (prototype = prior head, behavior slot = the `with`
    // value), makes it the new `mxEnvironment` head, and **replaces**
    // the top of stack with a reference to it — the compiled `POP`
    // that follows balances the stack, and a later `STORE`
    // (child B) can target the head. Metering is the two slot
    // allocations only (the dispatch code unit is charged centrally).
    /// The dispatch loop's `WITH` arm.
    #[inline(never)]
    fn exec_with(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let with_value = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        self.meter.tick_raw(WITH_ENV_SETUP_METERING);
        let inst = self.new_environment_instance(with_value);
        let head = Slot::of(Kind::Reference, Payload::Reference(inst));
        if let Some(top) = self.stack.last_mut() {
            *top = head;
        } else {
            self.push(head);
        }
        self.env = head;
        pc += size as usize;
        Flow::Next(pc)
    }

    // `without` (`XS_CODE_WITHOUT`, xsRun.c ~L4438): leave the
    // innermost `with`/eval environment — set `mxEnvironment` to the
    // current head's prototype. A `NULL` prototype (the outermost
    // `with` in the frame) restores the empty environment, so the
    // frame's own scope + global path resumes byte-identically.
    // Pure register manipulation: dispatch-metered only.
    /// The dispatch loop's `WITHOUT` arm.
    #[inline(never)]
    fn exec_without(&mut self, mut pc: usize, size: i8) -> Flow {
        if self.env.kind == Kind::Reference {
            if let Payload::Reference(cur) = self.env.value {
                let proto = self.instance_prototype(cur);
                self.env = if proto.is_null() {
                    Slot::undefined()
                } else {
                    Slot::of(Kind::Reference, Payload::Reference(proto))
                };
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- scope slots ------------------------------------

    /// The dispatch loop's `NEW_LOCAL` arm.
    #[inline(never)]
    fn exec_new_local(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let name = operand_id(code, pc, 1);
        let mut local = Slot::uninitialized();
        local.id = name;
        self.locals.push(local);
        std::rc::Rc::make_mut(&mut self.id_map).insert(name, self.locals.len() - 1);
        pc += ilen;
        Flow::Next(pc)
    }

    /// `GET_LOCAL` of a lexical binding still in its temporal dead zone
    /// (`let`/`const` before its initializer): a **catchable**
    /// `ReferenceError` (ECMA-262 `GetValue` → an uninitialized binding), not
    /// an uncatchable host abort, so a `try`/catch (and `typeof x`, which the
    /// compiler codes as this resolvable-local read) observes a realm-correct
    /// error. Mirrors the `GET_VARIABLE` unresolved arm.
    #[cold]
    #[inline(never)]
    fn exec_get_local_uninitialized(&mut self, code: &[u8], return_depth: usize, k: usize) -> Flow {
        let id = self.local_index(k).map(|i| self.locals[i].id).unwrap_or(0);
        let error = self.internal_error(
            "ReferenceError",
            format!("get {}: not initialized yet", self.property_debug_name(id)),
        );
        dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
    }

    // ---- variables (environment-resolved names) ---------

    // `get_this_variable` shares `get_variable`'s handler in
    // `xsRun.c` (a fused case): it resolves the name against the
    // top-of-stack environment reference and replaces it with
    // the value, which for a plain call is exactly a variable
    // read (the frame's `this` was pushed separately as
    // `undefined` before the reference).
    /// The dispatch loop's `GET_VARIABLE` arm, which also runs `GET_THIS_VARIABLE`.
    #[inline(never)]
    fn exec_get_variable(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let name = operand_id(code, pc, 1);
        dispatch_result_flow!(
            self.dispatch_get_variable(code, name, code.get(pc + ilen).copied()),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    // `to_instance` (`XS_CODE_TO_INSTANCE`): ToObject on the
    // top-of-stack value (ECMA-262 7.1.18), XS's `mxToInstance`.
    // Emitted by the base-class constructor bind (before `CLASS`),
    // object-destructuring of a value RHS, and `with`. An object is
    // returned unchanged (the hot path — a class constructor is
    // already a reference); `null`/`undefined` raise a catchable
    // TypeError; every other primitive boxes to its wrapper object
    // so subsequent property reads resolve against the wrapper.
    /// The dispatch loop's `TO_INSTANCE` arm.
    #[inline(never)]
    fn exec_to_instance(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_to_instance(), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_VARIABLE` arm.
    #[inline(never)]
    fn exec_set_variable(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let name = operand_id(code, pc, 1);
        dispatch_result_flow!(
            self.dispatch_set_variable(code, name),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    // ---- objects and properties -------------------------

    // `fxNewObject`: push a reference to a fresh instance.
    /// The dispatch loop's `OBJECT` arm.
    #[inline(never)]
    fn exec_object(&mut self, mut pc: usize, size: i8) -> Flow {
        let inst = self.new_object();
        self.push(Slot::of(Kind::Reference, Payload::Reference(inst)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `instantiate` (`XS_CODE_INSTANTIATE`): create the object
    // literal whose written `__proto__: value` member selected
    // this prelude. An object value becomes the exact prototype,
    // `null` creates a null-prototype object, and every primitive
    // is ignored in favor of `%Object.prototype%`. The member is
    // not subsequently defined as an own data property.
    /// The dispatch loop's `INSTANTIATE` arm.
    #[inline(never)]
    fn exec_instantiate(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        let value = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let proto = match (value.kind, value.value) {
            (Kind::Reference, Payload::Reference(proto)) => proto,
            (Kind::Null, _) => crate::value::SlotIndex::NULL,
            _ => self.object_proto,
        };
        self.meter.tick_builtin();
        self.meter.tick_slot_alloc();
        let inst = self.slots.alloc(Slot::instance(proto));
        self.push(Slot::of(Kind::Reference, Payload::Reference(inst)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `array` (`XS_CODE_ARRAY`): `fxNewArray(the, 0)` — push a
    // reference to a fresh empty exotic array. The array-literal
    // prelude stores it, sets `.length`, then fills item slots via
    // `NEW_PROPERTY_AT`.
    /// The dispatch loop's `ARRAY` arm.
    #[inline(never)]
    fn exec_array(&mut self, mut pc: usize, size: i8) -> Flow {
        let inst = self.new_array();
        self.push(Slot::of(Kind::Reference, Payload::Reference(inst)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `at` / `at_2` (`XS_CODE_AT`/`AT_2`): convert a computed key on
    // the stack (`o[k]`) into an `XS_AT_KIND` key the
    // `*_PROPERTY_AT` opcodes consume. `AT` operates on the top
    // slot; `AT_2` on `mxStack+1` (used by the define/set forms
    // where the value sits on top). An integer/number that is a
    // valid array index becomes an index key; a symbol or a string
    // that names a program symbol becomes a named key. XS meters a
    // non-index string key `2 × XS_CODE_METERING` extra; the
    // integer/symbol paths are dispatch-only.
    /// The dispatch loop's `AT` arm, which also runs `AT_2`.
    #[inline(never)]
    fn exec_at(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let depth = if op == XS_CODE_AT_2 { 1 } else { 0 };
        let Some(base_index) = self.stack.len().checked_sub(2 + depth) else {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("at:stack-underflow")));
        };
        let idx = base_index + 1;
        let key = self.stack[idx];
        // XS coerces the BASE first (`mxToInstance(mxStack + 1)`,
        // below the key): `null[k]` throws before `k`'s
        // `toString` ever runs, and `null[k] = rhs` throws after
        // the RHS (the compiler's `at_2` follows it) but before
        // the key coercion.
        let base = self.stack[base_index];
        if matches!(base.kind, Kind::Null | Kind::Undefined) {
            dispatch_halt_flow!(
                self.catchable_type_error_msg(cannot_coerce_to_object(base.kind)),
                self,
                return_depth,
                code
            );
        }
        let key = if key.kind == Kind::Reference {
            dispatch_result_flow!(self.to_primitive(code, key, true), self, return_depth, code)
        } else {
            key
        };
        let at = match dispatch_result_flow!(self.resolve_at_key(key), self, return_depth, code) {
            Some(at) => at,
            // Every primitive kind resolves; `None` is a payload that does
            // not match its kind, the engine's own value being malformed.
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("at:key-kind"))),
        };
        self.stack[idx] = at;
        pc += size as usize;
        Flow::Next(pc)
    }

    // `arr[k] = v` in a literal / definition (`NEW_PROPERTY_AT`).
    // Stack: [.., objectRef, atKey, value]; a 2-byte trailing
    // operand carries the property attributes (the AT form has no
    // id operand, so its total length is opcode + 2 = 3 bytes, and
    // the flag is the *second* of those two — see the `xsRun.c`
    // `NEW_PROPERTY_ALL` pointer walk). Consumes all three stack
    // slots (defines the item), leaving the base object the
    // literal keeps below.
    /// The dispatch loop's `NEW_PROPERTY_AT` arm.
    #[inline(never)]
    fn exec_new_property_at(&mut self, code: &[u8], mut pc: usize, return_depth: usize) -> Flow {
        let len = code.len();
        let byte = code[pc];
        if pc + 3 > len {
            return Flow::Exit(Step::Host(Halt::Decode(
                DecodeError::TruncatedInstruction {
                    pc,
                    opcode: byte,
                    needed: 3,
                    remaining: len - pc,
                },
            )));
        }
        let property_flag = code[pc + 2];
        dispatch_result_flow!(
            self.dispatch_new_property_at(code, property_flag),
            self,
            return_depth,
            code
        );
        pc += 3;
        Flow::Next(pc)
    }

    // `for_of` (`XS_CODE_FOR_OF` → `fxRunForOf` → `fxGetIterator`):
    // replace the top-of-stack iterable with its iterator,
    // `iterable[Symbol.iterator]()`. Guest-defined methods take
    // precedence; arrays, strings, collections, and generators
    // retain allocation-faithful intrinsic fast paths. The
    // surrounding loop drives the returned `{value, done}`
    // protocol through ordinary property/call opcodes.
    /// The dispatch loop's `FOR_OF` arm, which also runs `FOR_AWAIT_OF`.
    #[inline(never)]
    fn exec_for_of(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_for_of(code, op), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // `for_in` (`XS_CODE_FOR_IN`): call the enumerator function on
    // the top-of-stack object, replacing it with a for-in
    // enumerator; the surrounding loop reads `.next` and drives the
    // key-yielding {value,done} protocol through already-modeled
    // opcodes. A non-object (or an object with a non-covered
    // prototype) self-names an honest skip. XS's `XS_CODE_FOR_IN`
    // sets up a `RUN_ALL` of `mxEnumeratorFunction`; ironhorse builds
    // the enumerator in place with the equivalent metering.
    /// The dispatch loop's `FOR_IN` arm.
    #[inline(never)]
    fn exec_for_in(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        dispatch_result_flow!(self.dispatch_for_in(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // `check_instance` (`XS_CODE_CHECK_INSTANCE`): the iterator
    // result must be an object; a non-reference top throws a
    // `TypeError` (XS's `fxRunDebug`). Dispatch-metered only.
    /// The dispatch loop's `CHECK_INSTANCE` arm.
    #[inline(never)]
    fn exec_check_instance(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        if top.kind != Kind::Reference {
            dispatch_halt_flow!(
                self.catchable_type_error_msg("iterator result: not an object".into()),
                self,
                return_depth,
                code
            );
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // Define a new own property (object-literal member).
    // Stack: [.., objectRef, value]; consumes both. Encoded
    // as 5 bytes — opcode + 2-byte id + a 2-byte inline flag
    // operand the compiler emits (`fxRunDefine`'s attributes),
    // which `gxCodeSizes` marks as an ID opcode (3) but whose
    // handler advances two further bytes (`xsRun.c` NEW_PROPERTY),
    // so the flag pair is NOT a separate dispatched opcode.
    /// The dispatch loop's `NEW_PROPERTY` arm.
    #[inline(never)]
    fn exec_new_property(&mut self, code: &[u8], mut pc: usize, return_depth: usize) -> Flow {
        let len = code.len();
        let byte = code[pc];
        if pc + 5 > len {
            return Flow::Exit(Step::Host(Halt::Decode(
                DecodeError::TruncatedInstruction {
                    pc,
                    opcode: byte,
                    needed: 5,
                    remaining: len - pc,
                },
            )));
        }
        let id = operand_id(code, pc, 1);
        let property_flag = code[pc + 4];
        dispatch_result_flow!(
            self.dispatch_new_property(code, id, property_flag),
            self,
            return_depth,
            code
        );
        pc += 5;
        Flow::Next(pc)
    }

    // Private elements use the captured private-name closure cell
    // itself as their unforgeable brand key. This mirrors XS's
    // `slot->value.closure->value.reference` lookup while keeping
    // the ordinary public-property MOP untouched.
    /// The dispatch loop's `NEW_PRIVATE_1` arm, which also runs `NEW_PRIVATE_2`.
    #[inline(never)]
    fn exec_new_private(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        ilen: usize,
    ) -> Flow {
        let len = code.len();
        let byte = code[pc];
        if pc + ilen + 2 > len {
            return Flow::Exit(Step::Host(Halt::Decode(
                DecodeError::TruncatedInstruction {
                    pc,
                    opcode: byte,
                    needed: ilen + 2,
                    remaining: len - pc,
                },
            )));
        }
        let index = self.closure_index(op, code, pc);
        let flag = code[pc + ilen + 1];
        dispatch_result_flow!(
            self.dispatch_new_private(index, flag),
            self,
            return_depth,
            code
        );
        pc += ilen + 2;
        Flow::Next(pc)
    }

    /// The dispatch loop's `GET_PRIVATE_1` arm, which also runs `GET_PRIVATE_2`.
    #[inline(never)]
    fn exec_get_private(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        ilen: usize,
    ) -> Flow {
        let index = self.closure_index(op, code, pc);
        dispatch_result_flow!(
            self.dispatch_get_private(code, index),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_PRIVATE_1` arm, which also runs `SET_PRIVATE_2`.
    #[inline(never)]
    fn exec_set_private(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        ilen: usize,
    ) -> Flow {
        let index = self.closure_index(op, code, pc);
        dispatch_result_flow!(
            self.dispatch_set_private(code, index),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `HAS_PRIVATE_1` arm, which also runs `HAS_PRIVATE_2`.
    #[inline(never)]
    fn exec_has_private(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        ilen: usize,
    ) -> Flow {
        let index = self.closure_index(op, code, pc);
        dispatch_result_flow!(self.dispatch_has_private(index), self, return_depth, code);
        pc += ilen;
        Flow::Next(pc)
    }

    // `delete o.k` (XS_CODE_DELETE_PROPERTY, xsRun.c): remove the
    // own property `id` from the top-of-stack object, replacing
    // the object slot with the boolean result (XS keeps the stack
    // slot in place). A configurable own data property (all the
    // covered grammar creates) deletes to `true`; deleting an
    // absent own property is also `true`. A non-reference target
    // needs `mxToInstance` (which throws), so it self-names
    // unsupported.
    /// The dispatch loop's `DELETE_PROPERTY` arm.
    #[inline(never)]
    fn exec_delete_property(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let id = operand_id(code, pc, 1);
        dispatch_result_flow!(
            self.dispatch_delete_property(code, id),
            self,
            return_depth,
            code
        );
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `DELETE_PROPERTY_AT` arm.
    #[inline(never)]
    fn exec_delete_property_at(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(
            self.dispatch_delete_property_at(code),
            self,
            return_depth,
            code
        );
        pc += size as usize;
        Flow::Next(pc)
    }

    // `%CopyObject%`, the internal callable emitted for object
    // spread/rest. The following CALL opcode supplies the target
    // and source as arguments zero and one, then (for rest) the
    // excluded property keys as the remaining arguments.
    /// The dispatch loop's `COPY_OBJECT` arm.
    #[inline(never)]
    fn exec_copy_object(&mut self, mut pc: usize, ilen: usize) -> Flow {
        let function = self.alloc_method(NativeMethod::CopyObject);
        self.push(Slot::of(Kind::Reference, Payload::Reference(function)));
        pc += ilen;
        Flow::Next(pc)
    }

    // ---- user functions: definition ---------------------

    // `constructor_function` / `function` (`fxNewFunctionInstance`):
    // push a fresh callable instance. `constructor_function`
    // additionally runs `fxDefaultFunctionPrototype` (the
    // `.prototype`/`constructor` pair); both allocation clusters
    // are the measured [`FUNCTION_DEFINE_METERING`]. The body
    // range and closures are filled in by the following `code`
    // and `function_environment` opcodes.
    /// The dispatch loop's `CONSTRUCTOR_FUNCTION` arm, which also runs `FUNCTION`.
    #[inline(never)]
    fn exec_constructor_function(
        &mut self,
        code: &[u8],
        mut pc: usize,
        op: Opcode,
        ilen: usize,
    ) -> Flow {
        use Opcode::*;
        let name = operand_id(code, pc, 1);
        let f = self.new_function(name);
        // Only `constructor_function` carries XS's
        // `fxDefaultFunctionPrototype` own `prototype` property;
        // plain `function` (a method shape) has none.
        if op == XS_CODE_CONSTRUCTOR_FUNCTION {
            self.install_own_function_prototype(f);
        } else {
            // Methods and arrows have [[Call]] but no
            // [[Construct]]. `new_function` materializes the
            // default prototype allocation shared with the
            // constructor opcode for metering; discard the
            // semantic link for the non-constructor opcode.
            self.ctor_prototype.remove(&f);
        }
        self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        pc += ilen;
        Flow::Next(pc)
    }

    // `generator` (`XS_CODE_GENERATOR_FUNCTION` →
    // `fxNewGeneratorFunctionInstance`): like `function`, but the
    // instance's `.prototype` object chains to `%GeneratorPrototype%`
    // (so a generator instance resolves `next`/`return`/`throw`) and
    // the body's leading `START_GENERATOR` produces a generator
    // object rather than running. The body range/closures are filled
    // by the following `code`/`function_environment`, exactly as a
    // plain function.
    /// The dispatch loop's `GENERATOR_FUNCTION` arm.
    #[inline(never)]
    fn exec_generator_function(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let name = operand_id(code, pc, 1);
        let f = self.new_generator_function(name);
        // A generator function carries the same own `prototype`
        // slot (`fxDefaultFunctionPrototype` over the generator
        // prototype object it re-chained).
        self.install_own_function_prototype(f);
        self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        pc += ilen;
        Flow::Next(pc)
    }

    // `async_function` (`XS_CODE_ASYNC_FUNCTION` →
    // `fxNewFunctionInstance` with `[[Prototype]]` =
    // `%AsyncFunction.prototype%`): like `function`, but the instance
    // chains to the async-function prototype and has no own
    // `.prototype`; the body leads with `START_ASYNC`. The body
    // range/closures are filled by the following `code`/
    // `function_environment`, exactly as a plain function.
    /// The dispatch loop's `ASYNC_FUNCTION` arm.
    #[inline(never)]
    fn exec_async_function(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let name = operand_id(code, pc, 1);
        let f = self.new_async_function(name);
        self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `ASYNC_GENERATOR_FUNCTION` arm.
    #[inline(never)]
    fn exec_async_generator_function(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let name = operand_id(code, pc, 1);
        let f = self.new_async_generator_function(name);
        self.install_own_function_prototype(f);
        self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        pc += ilen;
        Flow::Next(pc)
    }

    // `code N` (`XS_CODE_CODE_*`): `fxNewChunk(N)` copies the N
    // body bytes into a chunk (metered per byte) and records the
    // body address on the top-of-stack function; execution skips
    // past the body (it runs only when the function is called).
    /// The dispatch loop's `CODE_1` arm, which also runs `CODE_2` and `CODE_4`.
    #[inline(never)]
    fn exec_code(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let function = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let n = match op {
            XS_CODE_CODE_1 => code[pc + 1] as usize,
            XS_CODE_CODE_2 => u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize,
            _ => u32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]])
                as usize,
        };
        let body_start = pc + size as usize;
        // `fxNewChunk(N)` meters the header+alignment-adjusted
        // body size, not N (see `Meter::tick_chunk_new`).
        self.meter.tick_chunk_new(n as u64);
        // The function's declared parameters/locals each carry a
        // fixed definition-time allocation cost
        // ([`FUNCTION_LOCAL_METERING`]); count the `new_local`
        // opcodes in this body (skipping nested function bodies)
        // and accrue it here, where XS incurs it at
        // definition rather than per call.
        let locals = count_new_locals(code, body_start, n);
        self.meter.tick_raw(FUNCTION_LOCAL_METERING * locals as u64);
        if let Payload::Reference(f) = function.value {
            // `fxNewFunctionLength(the, variable, *(code+1))`: XS
            // sets the function's `.length` from the second byte of
            // the body chunk — `begin`'s declared-parameter-count
            // operand. (No metering: the `length` own property was
            // allocated at `fxNewFunctionInstance`, folded into
            // [`FUNCTION_DEFINE_METERING`]; this only updates its
            // integer value.)
            let arity = code.get(body_start + 1).copied().unwrap_or(0) as u32;
            self.functions.update_or_default(f, |info| {
                info.body_start = Some(body_start);
                info.body_len = n;
                info.arity = arity;
            });
            // Every guest function names an owned segment,
            // including a top-level crank function. Dynamic/eval
            // dispatch already has an active segment; the first
            // top-level definition lazily promotes this crank's
            // retained buffer and makes it active for the rest of
            // the dispatch.
            let seg = self.ensure_active_code_segment(code);
            self.func_segments.insert(f, seg);
        }
        pc = body_start + n;
        Flow::Next(pc)
    }

    // `function_environment` (`fxNewEnvironmentInstance`): the
    // function captures its defining scope through a fresh
    // closure environment instance whose prototype is the
    // defining frame's environment. XS pushes the env reference
    // on top of the function (net +1 slot); the following
    // `store` opcodes append captured closure cells to it, then
    // a `pop` discards it. (For a non-capturing function no
    // `store` follows and the `pop` discards the env directly.)
    /// The dispatch loop's `FUNCTION_ENVIRONMENT` arm, which also runs `ENVIRONMENT`.
    #[inline(never)]
    fn exec_function_environment(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let function = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let env = self.new_environment();
        // Plain `environment` captures no surrounding dynamic
        // environment (`fxNewEnvironmentInstance(the, NULL)`),
        // whereas `function_environment` chains to the current
        // with/eval environment.
        if op == XS_CODE_ENVIRONMENT {
            self.slots.get_mut(env).value = Payload::None;
        }
        // The function is the current top; record its captured
        // environment before pushing the env reference.
        if let Payload::Reference(f) = function.value {
            self.functions
                .update_or_default(f, |info| info.closures = env);
        }
        self.push(Slot::of(Kind::Reference, Payload::Reference(env)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `extend` validates the heritage constructor and leaves both
    // the heritage and the newly-created prototype on the stack.
    // `class` later consumes `[heritage, prototype, constructor]`.
    /// The dispatch loop's `EXTEND` arm.
    #[inline(never)]
    fn exec_extend(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let heritage = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let parent_proto = dispatch_result_flow!(
            self.class_heritage_prototype(code, heritage),
            self,
            return_depth,
            code
        );
        let proto = self.slots.alloc(Slot::instance(parent_proto));
        self.push(Slot::of(Kind::Reference, Payload::Reference(proto)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // Finalize a class constructor and its prototype. The
    // ordinary object MOP remains the behavior seam: only the
    // class-created links and standard descriptors are installed
    // here; subsequent reads/writes use ordinary_get/set.
    /// The dispatch loop's `CLASS` arm.
    #[inline(never)]
    fn exec_class(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        use Opcode::*;
        let constructor = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let prototype = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let heritage = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let (ctor, proto) = match (constructor.value, prototype.value) {
            (Payload::Reference(ctor), Payload::Reference(proto))
                if constructor.kind == Kind::Reference
                    && prototype.kind == Kind::Reference
                    && self.functions.contains_key(&ctor) =>
            {
                (ctor, proto)
            }
            _ => return Flow::Exit(Step::Host(Halt::EngineInvariant("class:invalid-stack"))),
        };
        let derived = self
            .functions
            .get(&ctor)
            .and_then(|info| info.body_start)
            .and_then(|start| code.get(start))
            .and_then(|byte| Opcode::from_u8(*byte))
            == Some(XS_CODE_BEGIN_STRICT_DERIVED);
        self.functions.update(&ctor, |info| {
            info.home = proto;
            info.class_derived = Some(derived);
        });
        self.ctor_prototype.insert(ctor, proto);
        // A derived class constructor inherits static properties
        // from its heritage constructor. A base class continues
        // to inherit from %Function.prototype%.
        if derived && heritage.kind == Kind::Reference {
            if let Payload::Reference(parent) = heritage.value {
                self.slots.get_mut(ctor).value = Payload::Reference(parent);
            }
        }
        let prototype_id = self.intern_static_key("prototype");
        let constructor_id = self.intern_static_key("constructor");
        self.set_own_unmetered_with_flag(
            ctor,
            prototype_id,
            Slot::of(Kind::Reference, Payload::Reference(proto)),
            XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG,
        );
        self.set_own_unmetered_with_flag(
            proto,
            constructor_id,
            Slot::of(Kind::Reference, Payload::Reference(ctor)),
            XS_DONT_ENUM_FLAG,
        );
        pc += size as usize;
        Flow::Next(pc)
    }

    // Attach the current function/method's [[HomeObject]]. The
    // home object is on top and is consumed; the function remains
    // for capture/call by the following opcode.
    /// The dispatch loop's `SET_HOME` arm.
    #[inline(never)]
    fn exec_set_home(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let home = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let function = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        if let (Payload::Reference(f), Payload::Reference(h)) = (function.value, home.value) {
            self.functions.update(&f, |info| {
                info.home = h;
            });
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // Give an anonymous/class function its inferred binding name
    // (`fxRenameFunction`). The callable stays on the stack.
    /// The dispatch loop's `NAME` arm.
    #[inline(never)]
    fn exec_name(&mut self, code: &[u8], mut pc: usize, return_depth: usize, ilen: usize) -> Flow {
        let function = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let id = operand_id(code, pc, 1);
        if let Payload::Reference(f) = function.value {
            let name = (id as usize)
                .checked_sub(1)
                .and_then(|i| self.symbol_names.get(i).cloned())
                .unwrap_or_default();
            let name_chunk = self.chunks.alloc(&units_to_be16(&name.to_units()));
            self.functions.update(&f, |info| {
                info.name = name.to_string();
                info.name_chunk = name_chunk;
            });
            self.meter.tick_builtin_some(2);
        }
        pc += ilen;
        Flow::Next(pc)
    }

    // ---- user functions: call --------------------------

    // `new` (`XS_CODE_NEW`, xsRun.c): the constructor is already
    // on the stack (from `get_variable`). Reshape the single
    // constructor slot into the construct frame geometry
    // `[THIS, FUNCTION, RESULT, FRAME]`, where `THIS` is the
    // **uninitialized** construct placeholder — XS's `RUN_ALL`
    // reads that (`mxFrameThis->kind == XS_UNINITIALIZED_KIND`) as
    // the target flag, and `begin`'s `fxRunConstructor` fills it
    // with the fresh instance. No heap allocation here (the frame
    // is stack slots); dispatch-metered only, as XS's `NEW`.
    /// The dispatch loop's `NEW` arm.
    #[inline(never)]
    fn exec_new(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let ctor = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        self.push(Slot::uninitialized()); // THIS (construct placeholder)
        self.push(ctor); // FUNCTION
        self.push(Slot::undefined()); // RESULT
        self.push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        pc += size as usize;
        Flow::Next(pc)
    }

    // `super()` constructs the current constructor's heritage.
    // The following `run_*` consumes this standard construct
    // frame, and `set_this` installs the returned object in the
    // derived frame.
    /// The dispatch loop's `SUPER` arm.
    #[inline(never)]
    fn exec_super(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let parent = self.super_parent();
        if parent.is_null() || !self.slot_is_constructor(parent) {
            let error = self.internal_error("TypeError", "super: not a constructor".into());
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        // The frame carries `new.target` in its RESULT slot, as XS's frame
        // carries its target, and `run_*` hands it to the construct once the
        // arguments have run. Setting the one-shot `pending_new_target` latch
        // here let any construct inside the arguments — `super(new
        // Array(n))` — take it: that object got the derived prototype and the
        // super object the intrinsic one.
        self.push(Slot::uninitialized());
        self.push(Slot::of(Kind::Reference, Payload::Reference(parent)));
        self.push(if self.target_func.is_null() {
            Slot::undefined()
        } else {
            Slot::of(Kind::Reference, Payload::Reference(self.target_func))
        });
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        pc += size as usize;
        Flow::Next(pc)
    }

    // Direct `eval(...)` uses its own dynamic-count opcode. The
    // spec's non-string fast path performs no parsing and returns
    // argument zero unchanged; this is independently useful and
    // exact even before runtime source compilation lands. A
    // syntactically-direct call whose binding was replaced is not
    // eval and must use ordinary Call; retain that as a precise
    // gap instead of accidentally granting eval semantics.
    /// The dispatch loop's `EVAL` arm, which also runs `EVAL_TAIL`.
    #[inline(never)]
    fn exec_eval(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let argc = dispatch_result_flow!(self.pop_run_count(), self, return_depth, code);
        let Some(base) = self.stack.len().checked_sub(argc + 4) else {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("eval:frame-underflow")));
        };
        let native = match self.stack.get(base + 1).and_then(|slot| match slot.value {
            Payload::Reference(function) => self.native_of(function),
            _ => None,
        }) {
            Some(native) => native,
            None => return Flow::Exit(Step::Host(Halt::NotImplemented("eval:shadowed-call"))),
        };
        if native != Native::Eval {
            return Flow::Exit(Step::Host(Halt::NotImplemented("eval:shadowed-call")));
        }
        // This opcode is emitted only for a **direct** eval call,
        // so the source (if a string) evaluates in the caller's
        // scope and strictness. The flag scopes that signal to this
        // one native call; `eval_source` clears it for any nested
        // eval the unit itself performs.
        self.eval_direct = self
            .stack
            .get(base + 1)
            .is_some_and(|slot| match slot.value {
                Payload::Reference(function) => self.functions.get(&function).is_some_and(|info| {
                    info.global_env.is_null() || info.global_env == self.environment.global_obj
                }),
                _ => false,
            });
        let outcome = self.call_native(Native::Eval, base, argc, false, code);
        self.eval_direct = false;
        dispatch_result_flow!(outcome, self, return_depth, code);
        if self.check_meter() == MeterCheck::Abort {
            return Flow::Exit(Step::Host(Halt::MeterAbort));
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `run`/`run_N` (`XS_CODE_RUN*`): invoke the function with N
    // arguments. Stack below the N args is
    // `[THIS, FUNCTION, RESULT, FRAME]` (XS's frame geometry:
    // args below the frame, `result`/`function`/`this` at fixed
    // offsets). Enter the callee's body frame; the call-entry
    // `mxFirstCode` meter check fires here.
    /// The dispatch loop's `RUN` arm, which also runs `RUN_1`, `RUN_2`, `RUN_4`, `RUN_TAIL`,
    /// `RUN_TAIL_1`, `RUN_TAIL_2` and `RUN_TAIL_4`.
    #[inline(never)]
    fn exec_run(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let argc = match op {
            XS_CODE_RUN | XS_CODE_RUN_TAIL => {
                dispatch_result_flow!(self.pop_run_count(), self, return_depth, code)
            }
            XS_CODE_RUN_1 | XS_CODE_RUN_TAIL_1 => code[pc + 1] as usize,
            XS_CODE_RUN_2 | XS_CODE_RUN_TAIL_2 => {
                u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize
            }
            _ => u32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]])
                as usize,
        };
        let ret_pc = pc + size as usize;
        // A native (intrinsic) callee runs a C handler in place
        // rather than entering a bytecode frame (XS's
        // `XS_CALLBACK_KIND` branch of `RUN_ALL`): no call-entry
        // `mxFirstCode` check (the C path leaves `mxCode` null),
        // the handler meters its own steps, and control returns
        // into this JS frame — where `END_ALL`'s `mxFirstCode`
        // does check. A non-target (plain) call only; `new` on a
        // native is a separate, not-yet-modeled path.
        // A construct call (`new`) leaves the `THIS` slot as the
        // uninitialized placeholder (XS's `RUN_ALL` target
        // detection: `mxFrameThis->kind == XS_UNINITIALIZED_KIND`);
        // a plain call pushed a real/`undefined` `this`.
        let base_opt = self.stack.len().checked_sub(argc + 4);
        let has_target = base_opt
            .and_then(|b| self.stack.get(b))
            .map(|s| s.kind == Kind::Uninitialized)
            .unwrap_or(false);
        // A `super(...)` frame's `new.target` (see `XS_CODE_SUPER`), armed
        // for the construct this frame enters.
        if has_target {
            if let Some(base) = base_opt {
                self.arm_super_frame_target(base);
            }
        }
        let func_ref = base_opt.and_then(|base| match self.stack.get(base + 1).map(|s| s.value) {
            Some(Payload::Reference(f)) => Some((f, base)),
            _ => None,
        });
        // Consult authoritative tables directly. Restored roles
        // may overlap; the dispatch order below remains decisive.
        let metadata = func_ref.and_then(|(f, base)| {
            self.functions
                .get(&f)
                .map(|info| (info.native, info.method, base))
        });
        let callee = metadata.and_then(|(native, _, base)| native.map(|native| (native, base)));
        let method = metadata.and_then(|(_, method, base)| method.map(|method| (method, base)));
        // Promise functions precede their generic method marker.
        let promise_fn = func_ref.filter(|(f, _)| self.promise_functions.contains_key(f));
        if let Some((f, base)) = promise_fn {
            if has_target {
                dispatch_halt_flow!(
                    self.catchable_type_error_msg("new: not a constructor".into()),
                    self,
                    return_depth,
                    code
                );
            }
            let result = self.call_promise_function(code, f, base, argc);
            dispatch_result_flow!(result, self, return_depth, code);
            if self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = ret_pc;
        } else if let Some((native, base)) = callee {
            // A native (intrinsic) constructor callee.
            dispatch_result_flow!(
                self.call_native(native, base, argc, has_target, code),
                self,
                return_depth,
                code
            );
            // Return into the JS caller: `END_ALL` checks.
            if self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = ret_pc;
        } else if let Some((NativeMethod::FunctionCall, base)) = method {
            // `Function.prototype.call` is a built-in that is **not**
            // a constructor (ECMA-262: built-ins lack [[Construct]]
            // unless specified). `new fn.call()` must therefore
            // throw a catchable TypeError, not trampoline.
            let _ = base;
            if has_target {
                dispatch_halt_flow!(
                    self.catchable_type_error_msg("new: not a constructor".into()),
                    self,
                    return_depth,
                    code
                );
            }
            // A native receiver can be dispatched in place; a user
            // receiver re-enters its bytecode frame through the
            // trampoline.
            match dispatch_result_flow!(
                self.call_dot_call_native(base, argc, code),
                self,
                return_depth,
                code
            ) {
                true => {
                    if self.check_meter() == MeterCheck::Abort {
                        return Flow::Exit(Step::Host(Halt::MeterAbort));
                    }
                    pc = ret_pc;
                }
                false => match self.enter_call_dot_call(base, argc, ret_pc) {
                    Ok(body_start) => {
                        if self.check_meter() == MeterCheck::Abort {
                            return Flow::Exit(Step::Host(Halt::MeterAbort));
                        }
                        pc = body_start;
                    }
                    Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),
                },
            }
        } else if let Some((NativeMethod::FunctionApply, base)) = method {
            // `Function.prototype.apply` is a built-in that is **not**
            // a constructor: `new fn.apply()` throws a catchable
            // TypeError rather than trampolining.
            if has_target {
                dispatch_halt_flow!(
                    self.catchable_type_error_msg("new: not a constructor".into()),
                    self,
                    return_depth,
                    code
                );
            }
            // A native receiver dispatches in place (dense-array or
            // no-array argument shapes); a user receiver re-enters
            // its bytecode frame through the trampoline.
            match dispatch_result_flow!(
                self.call_dot_apply_native(base, code),
                self,
                return_depth,
                code
            ) {
                true => {
                    if self.check_meter() == MeterCheck::Abort {
                        return Flow::Exit(Step::Host(Halt::MeterAbort));
                    }
                    pc = ret_pc;
                }
                false => match self.enter_call_dot_apply(base, argc, ret_pc, code) {
                    Ok(body_start) => {
                        if self.check_meter() == MeterCheck::Abort {
                            return Flow::Exit(Step::Host(Halt::MeterAbort));
                        }
                        pc = body_start;
                    }
                    // A non-object argArray raises a **catchable**
                    // TypeError: resume a caller's handler (or escape
                    // to the host if uncaught) rather than propagate
                    // the raw `Resume`.
                    Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),
                },
            }
        } else if let Some((m, base)) = method {
            // A native prototype method: the call's receiver is
            // `this` (stack[base]); its arguments follow. `code` is
            // threaded through so a callback-taking method
            // (`forEach`/`map`/…) can drive the callback via
            // `run_callback`.
            // Native methods have `[[Call]]` but no `[[Construct]]`;
            // reject a direct `new method()` just as the
            // `Reflect.construct` constructor gate already does.
            if has_target {
                dispatch_halt_flow!(
                    self.catchable_type_error_msg("new: not a constructor".into()),
                    self,
                    return_depth,
                    code
                );
            }
            dispatch_result_flow!(
                self.call_native_method(m, base, argc, code),
                self,
                return_depth,
                code
            );
            if self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = ret_pc;
        } else if let Some((bf, base)) =
            func_ref.filter(|(f, _)| self.bound_functions.contains_key(f))
        {
            // A bound function (`fx_Function_prototype_bound`):
            // re-enter the target with the bound `this` and the
            // bound args prepended to the call args.
            if has_target {
                // `new boundF(...)`: a non-constructor target throws
                // a catchable TypeError; otherwise construct the
                // ultimate target with the bound args prepended
                // (`new.target` → the ultimate target).
                if !self.slot_is_constructor(bf) {
                    dispatch_halt_flow!(
                        self.catchable_type_error_msg("new: not a constructor".into()),
                        self,
                        return_depth,
                        code
                    );
                }
                if !self.bound_construct_enters_bytecode(bf) {
                    let result = dispatch_result_flow!(
                        self.construct_bound_native(code, bf, base, argc),
                        self,
                        return_depth,
                        code
                    );
                    self.push(result);
                    if self.check_meter() == MeterCheck::Abort {
                        return Flow::Exit(Step::Host(Halt::MeterAbort));
                    }
                    pc = ret_pc;
                    return Flow::Next(pc);
                }
                match self.enter_construct_bound(bf, base, argc, ret_pc) {
                    Ok(body_start) => {
                        if self.check_meter() == MeterCheck::Abort {
                            return Flow::Exit(Step::Host(Halt::MeterAbort));
                        }
                        pc = body_start;
                        return Flow::Next(pc);
                    }
                    Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),
                }
            }
            // BoundFunction.[[Call]] is ordinary abstract Call
            // redispatch: prepend this wrapper's arguments,
            // substitute its `this`, and repeat for a chain. A target
            // that is a user function over this loop's buffer runs in
            // this loop (STACK-DEPTH-REFACTOR.md C1); any other goes
            // through the shared dispatcher, so user/native/method
            // targets have identical semantics at opcode and callback
            // call sites.
            match dispatch_result_flow!(
                self.bound_call(bf, base, argc, ret_pc),
                self,
                return_depth,
                code
            ) {
                RunCall::Entered(body_start) => return Flow::Next(body_start),
                RunCall::Call(target, receiver, args) => {
                    let result = dispatch_result_flow!(
                        self.invoke_value(code, target, receiver, &args),
                        self,
                        return_depth,
                        code
                    );
                    self.push(result);
                }
            }
            if self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = ret_pc;
        } else if let Some((px, base)) = func_ref.filter(|(f, _)| self.proxies.contains_key(f)) {
            // `p(...)` / `new p(...)`: run the proxy's
            // `[[Call]]`/`[[Construct]]` (its `apply`/`construct`
            // trap, or the target) on the frame's args and receiver.
            if has_target {
                let args = dispatch_result_flow!(
                    self.frame_arguments(base, argc),
                    self,
                    return_depth,
                    code
                );
                let nt = self.proxy_construct_new_target(base, px);
                self.stack.truncate(base);
                // A Proxy takes its `new.target` as an argument, never from
                // the latch, which nothing on this path would consume: left
                // set, it leaked into the next construct, so a later plain
                // `new Map()` built a subclass instance.
                self.pending_new_target = None;
                let result = dispatch_result_flow!(
                    self.proxy_construct(code, px, &args, nt),
                    self,
                    return_depth,
                    code
                );
                self.push(result);
            } else {
                // A trap or target that is a user function over this
                // loop's buffer runs in this loop (STACK-DEPTH-REFACTOR.md
                // C1); any other is called here, inside the layer's light
                // unit.
                match dispatch_result_flow!(
                    self.proxy_run_call(code, px, base, argc, ret_pc),
                    self,
                    return_depth,
                    code
                ) {
                    RunCall::Entered(body_start) => return Flow::Next(body_start),
                    RunCall::Call(callee, receiver, args) => {
                        let result = self.invoke_value(code, callee, receiver, &args);
                        self.leave_native_frame(LIGHT_FRAME_COST);
                        let result = dispatch_result_flow!(result, self, return_depth, code);
                        self.push(result);
                    }
                }
            }
            if self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = ret_pc;
        } else if let Some(seg) = self.cross_segment_callee(argc) {
            // The callee's body lives in a different code segment
            // than this loop's buffer (an eval-defined function
            // called from here, or a top-level function called back
            // from an eval). Dispatch it over its own buffer rather
            // than continuing in-loop at an offset into the wrong
            // bytes — the eval-lifetime seam.
            match self.call_cross_segment(argc, has_target, seg) {
                Ok(result) => {
                    self.push(result);
                    if self.check_meter() == MeterCheck::Abort {
                        return Flow::Exit(Step::Host(Halt::MeterAbort));
                    }
                    pc = ret_pc;
                }
                // An uncaught throw in the cross-segment callee
                // whose catch lives in THIS caller loop resumes at
                // the catch target here (the same handling
                // `dispatch_result_flow!` gives a throwing native);
                // a catch below this frame propagates the resume
                // outward. Without this, a throw from an
                // eval-/`Function`-defined callee returned straight
                // out of the caller, bypassing its `try`/`catch`.
                Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),
            }
        } else {
            match self.enter_call(argc, ret_pc, has_target) {
                Ok(body_start) => {
                    // Call entry: `mxFirstCode()` runs a meter check
                    // before the callee's first opcode.
                    if self.check_meter() == MeterCheck::Abort {
                        return Flow::Exit(Step::Host(Halt::MeterAbort));
                    }
                    pc = body_start;
                }
                // A non-callable value raises before a callee frame
                // is entered. Resume the catch/finally in this loop,
                // or propagate to the dispatch loop that owns a
                // handler below this one.
                Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),
            }
        }
        Flow::Next(pc)
    }

    // ---- closures (captured variables via heap cells) ---

    // `new_closure id` (`XS_CODE_NEW_CLOSURE`): declare a
    // captured binding. Allocate a heap cell (`fxNewSlot`,
    // metered) initialized uninitialized, and append a
    // closure-kind scope slot pointing at it. The cell is what
    // the capturing closures share.
    /// The dispatch loop's `NEW_CLOSURE` arm.
    #[inline(never)]
    fn exec_new_closure(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let name = operand_id(code, pc, 1);
        let cell = self.slots.alloc(Slot::uninitialized());
        self.meter.tick_slot_alloc(); // fxNewSlot for the cell
        let mut slot = Slot::of(Kind::Closure, Payload::Reference(cell));
        slot.id = name;
        self.locals.push(slot);
        std::rc::Rc::make_mut(&mut self.id_map).insert(name, self.locals.len() - 1);
        pc += ilen;
        Flow::Next(pc)
    }

    // `get_closure #k`: read the shared cell of scope closure k.
    /// The dispatch loop's `GET_CLOSURE_1` arm, which also runs `GET_CLOSURE_2`.
    #[inline(never)]
    fn exec_get_closure(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
    ) -> Flow {
        let k = self.closure_index(op, code, pc);
        match self.closure_cell(k) {
            Some(cell) => {
                let s = self.slots.get(cell);
                if s.kind == Kind::Uninitialized {
                    let id = self.local_index(k).map(|i| self.locals[i].id).unwrap_or(0);
                    let error = self.internal_error(
                        "ReferenceError",
                        format!("get {}: not initialized yet", self.property_debug_name(id)),
                    );
                    dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
                }
                self.push(Slot::of(s.kind, s.value));
            }
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("get_closure:no-cell"))),
        }
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_CLOSURE_1` arm, which also runs `SET_CLOSURE_2`.
    #[inline(never)]
    fn exec_set_closure(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
    ) -> Flow {
        let k = self.closure_index(op, code, pc);
        let immutable = self
            .closure_cell(k)
            .is_some_and(|cell| self.slots.get(cell).flag & XS_DONT_SET_FLAG != 0);
        if immutable {
            let id = self.locals[self.local_index(k).expect("immutable binding")].id;
            let error =
                self.internal_error("TypeError", format!("set {}: const", self.id_name(id)));
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        self.write_closure_cell(k, top);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `CONST_CLOSURE_1` arm, which also runs `CONST_CLOSURE_2`.
    #[inline(never)]
    fn exec_const_closure(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
    ) -> Flow {
        let k = self.closure_index(op, code, pc);
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        if let Some(cell) = self.closure_cell(k) {
            let target = self.slots.get_mut(cell);
            target.kind = top.kind;
            target.value = top.value;
            // XS stamps the shared cell (not the closure-kind scope
            // indirection), so an eval-published reference observes
            // the same const guard as GET/SET_CLOSURE.
            target.flag |= XS_DONT_SET_FLAG;
        }
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // `reset_closure #k` (xsRun.c:RESET_CLOSURE): point scope
    // closure `k` at a **fresh** uninitialized cell
    // (`fxNewSlot`, metered) — a loop body's per-iteration
    // `let` binding gets a new cell each turn.
    /// The dispatch loop's `RESET_CLOSURE_1` arm, which also runs `RESET_CLOSURE_2`.
    #[inline(never)]
    fn exec_reset_closure(&mut self, code: &[u8], mut pc: usize, op: Opcode) -> Flow {
        let k = self.closure_index(op, code, pc);
        let cell = self.slots.alloc(Slot::uninitialized());
        self.meter.tick_slot_alloc();
        self.repoint_closure(k, cell);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // `refresh_closure #k` (xsRun.c:REFRESH_CLOSURE): point scope
    // closure `k` at a fresh cell (`fxNewSlot`, metered) that
    // **copies** the old cell's flag/kind/value — a per-iteration
    // `let` capture that snapshots the current binding.
    /// The dispatch loop's `REFRESH_CLOSURE_1` arm, which also runs `REFRESH_CLOSURE_2`.
    #[inline(never)]
    fn exec_refresh_closure(&mut self, code: &[u8], mut pc: usize, op: Opcode) -> Flow {
        let k = self.closure_index(op, code, pc);
        let old = self.closure_cell(k);
        let src = old
            .map(|c| self.slots.get(c))
            .unwrap_or_else(Slot::uninitialized);
        let mut fresh = Slot::of(src.kind, src.value);
        fresh.flag = src.flag;
        let cell = self.slots.alloc(fresh);
        self.meter.tick_slot_alloc();
        self.repoint_closure(k, cell);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // `refresh_local #k` (xsRun.c:REFRESH_LOCAL): a no-op in the
    // run (`variable = mxEnvironment - index` then nothing);
    // dispatch-metered only.
    /// The dispatch loop's `REFRESH_LOCAL_1` arm, which also runs `REFRESH_LOCAL_2`.
    #[inline(never)]
    fn exec_refresh_local(&mut self, mut pc: usize, op: Opcode) -> Flow {
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // `pull_closure #k`: pop and write the shared cell.
    /// The dispatch loop's `PULL_CLOSURE_1` arm, which also runs `PULL_CLOSURE_2`.
    #[inline(never)]
    fn exec_pull_closure(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
    ) -> Flow {
        let k = self.closure_index(op, code, pc);
        let immutable = self
            .closure_cell(k)
            .is_some_and(|cell| self.slots.get(cell).flag & XS_DONT_SET_FLAG != 0);
        if immutable {
            let id = self.locals[self.local_index(k).expect("immutable binding")].id;
            let error =
                self.internal_error("TypeError", format!("set {}: const", self.id_name(id)));
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        let v = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        self.write_closure_cell(k, v);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // `retrieve #k` (`XS_CODE_RETRIEVE_*`): import the callee's
    // `k` captured closures from its closure environment into
    // the frame scope (copying the closure-kind slots, which
    // point at the shared cells — no allocation).
    /// The dispatch loop's `RETRIEVE_1` arm, which also runs `RETRIEVE_2`.
    #[inline(never)]
    fn exec_retrieve(&mut self, code: &[u8], mut pc: usize, op: Opcode) -> Flow {
        let k = self.closure_index(op, code, pc);
        self.retrieve_closures(k);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    // An arrow imports the lexical `new.target` and `this` values
    // that `STORE_ARROW` appended to its closure environment at
    // definition time. The captures are ordinary arena slots, so
    // they naturally survive snapshots and GC tracing.
    /// The dispatch loop's `RETRIEVE_TARGET` arm.
    #[inline(never)]
    fn exec_retrieve_target(&mut self, mut pc: usize, size: i8) -> Flow {
        let closures = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.closures)
            .unwrap_or(crate::value::SlotIndex::NULL);
        let id = self.intern_static_key_unmetered("new.target");
        if !closures.is_null() {
            if let Some(property) = self.find_property(closures, id) {
                let target = self.slots.get(property);
                self.cur_target = true;
                self.target_func = match target.value {
                    Payload::Reference(function) => function,
                    _ => crate::value::SlotIndex::NULL,
                };
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `RETRIEVE_THIS` arm.
    #[inline(never)]
    fn exec_retrieve_this(&mut self, mut pc: usize, size: i8) -> Flow {
        let closures = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.closures)
            .unwrap_or(crate::value::SlotIndex::NULL);
        let id = self.intern_static_key_unmetered("this");
        if !closures.is_null() {
            if let Some(property) = self.find_property(closures, id) {
                let captured = self.slots.get(property);
                self.this_val = Slot::of(captured.kind, captured.value);
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `store #k` / `store_arrow` (`XS_CODE_STORE_*`): capture the
    // scope closure `k` into the top-of-stack environment,
    // appending a shared-cell reference (`fxNewSlot`, metered).
    /// The dispatch loop's `STORE_1` arm, which also runs `STORE_2`.
    #[inline(never)]
    fn exec_store(&mut self, code: &[u8], mut pc: usize, return_depth: usize, op: Opcode) -> Flow {
        let k = self.closure_index(op, code, pc);
        dispatch_result_flow!(self.store_closure(k), self, return_depth, code);
        pc += op.size() as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `STORE_ARROW` arm.
    #[inline(never)]
    fn exec_store_arrow(&mut self, mut pc: usize, size: i8) -> Flow {
        let env = self.stack.last().and_then(|slot| match slot.value {
            Payload::Reference(env) => Some(env),
            _ => None,
        });
        let arrow =
            self.stack
                .len()
                .checked_sub(2)
                .and_then(|index| match self.stack[index].value {
                    Payload::Reference(function) => Some(function),
                    _ => None,
                });
        let (Some(env), Some(arrow)) = (env, arrow) else {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("store_arrow:frame")));
        };
        let home = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.home)
            .unwrap_or(crate::value::SlotIndex::NULL);
        self.functions
            .update_or_default(arrow, |info| info.home = home);
        if self.cur_target {
            let id = self.intern_static_key_unmetered("new.target");
            let target = Slot::of(Kind::Reference, Payload::Reference(self.target_func));
            self.append_environment_capture(env, id, target);
        }
        let id = self.intern_static_key_unmetered("this");
        let capture = self.append_environment_capture(env, id, self.this_val);
        if self.this_val.kind == Kind::Uninitialized {
            self.this_captures.push(capture);
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- literals ---------------------------------------

    // `symbol id` is XS's internal, already-interned property-key
    // value (used by object-rest exclusion lists and module
    // transfer records), not a freshly-created ECMAScript Symbol.
    // Represent it directly as an `At` key so the following `AT`
    // opcode is allocation-free and preserves the program id.
    /// The dispatch loop's `SYMBOL` arm.
    #[inline(never)]
    fn exec_symbol(&mut self, code: &[u8], mut pc: usize, ilen: usize) -> Flow {
        let id = operand_id(code, pc, 1);
        self.push(Slot::of(Kind::At, Payload::At(id, 0)));
        pc += ilen;
        Flow::Next(pc)
    }

    // `regexp` (XS_CODE_REGEXP, xsRun.c:2786): push the `RegExp`
    // constructor (`mxRegExpConstructor`). A `/.../` literal
    // compiles to `regexp; new; string <pattern>; string <flags>;
    // run 2` — i.e. `new RegExp(pattern, flags)` — so this handler
    // just materializes the constructor reference for the `new`
    // machinery. Pure dispatch, no allocation, no meter (like
    // `global`).
    /// The dispatch loop's `REGEXP` arm.
    #[inline(never)]
    fn exec_regexp(&mut self, mut pc: usize, size: i8) -> Flow {
        let ctor = self
            .intrinsics
            .get("RegExp")
            .copied()
            .unwrap_or(crate::value::SlotIndex::NULL);
        self.push(Slot::of(Kind::Reference, Payload::Reference(ctor)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `string` (XS_CODE_STRING_1/2/4, xsRun.c:3044): a string
    // literal. The operand is a length-prefixed run of inline
    // CESU-8 bytes (including the compiler's trailing NUL). Ironhorse
    // decodes that CESU-8 into UTF-16 code units (the stored form,
    // design § Value and heap model) and copies them into a fresh
    // chunk as UTF-16BE. The allocation is metered by code-unit
    // length (`n_units + 1`, the O(n) string-op weight re-based to
    // code units — for ASCII this equals the old CESU-8 byte count
    // including the NUL, so ASCII literals meter identically).
    /// The dispatch loop's `STRING_1` arm, which also runs `STRING_2` and `STRING_4`.
    #[inline(never)]
    fn exec_string(&mut self, code: &[u8], mut pc: usize, op: Opcode, ilen: usize) -> Flow {
        use Opcode::*;
        let (n, data) = match op {
            XS_CODE_STRING_1 => (code[pc + 1] as usize, pc + 2),
            XS_CODE_STRING_2 => (
                u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize,
                pc + 3,
            ),
            _ => (
                u32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]])
                    as usize,
                pc + 5,
            ),
        };
        let units = cesu8_to_units(&code[data..data + n]);
        self.meter.tick_string(units.len() as u64);
        let off = self.chunks.alloc(&units_to_be16(&units));
        self.push(Slot::of(Kind::String, Payload::String(off)));
        pc += ilen;
        Flow::Next(pc)
    }

    // `bigint` (XS_CODE_BIGINT_1/2, xsRun.c): a BigInt literal. The
    // operand is a length-prefixed run of the magnitude's
    // little-endian bytes (a literal is always non-negative — a
    // `-1n` is unary minus over `1n`). `fxNewBigInt` copies them
    // into a fresh digit chunk (`make_bigint` meters the
    // `fxNewChunk(size * 4)`), plus the measured literal residual.
    /// The dispatch loop's `BIGINT_1` arm, which also runs `BIGINT_2`.
    #[inline(never)]
    fn exec_bigint(&mut self, code: &[u8], mut pc: usize, op: Opcode, ilen: usize) -> Flow {
        use Opcode::*;
        let (n, data) = match op {
            XS_CODE_BIGINT_1 => (code[pc + 1] as usize, pc + 2),
            _ => (
                u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize,
                pc + 3,
            ),
        };
        let mut limbs = Vec::with_capacity(n / 4 + 1);
        let bytes = &code[data..data + n];
        let mut i = 0;
        while i < bytes.len() {
            let mut w = [0u8; 4];
            for (k, wk) in w.iter_mut().enumerate() {
                if i + k < bytes.len() {
                    *wk = bytes[i + k];
                }
            }
            limbs.push(u32::from_le_bytes(w));
            i += 4;
        }
        if limbs.is_empty() {
            limbs.push(0);
        }
        self.meter.tick_raw(BIGINT_LITERAL_METERING);
        let v = self.make_bigint(false, limbs);
        self.push(v);
        pc += ilen;
        Flow::Next(pc)
    }

    // `typeof` (XS_CODE_TYPEOF, xsRun.c:4162): replace the stack
    // top with the interned type-name string. A reference is a
    // "function" when it is a callable instance (ironhorse tracks
    // those in `functions`), else "object"; `null` is "object".
    // Dispatch-only: the type strings are preinterned.
    /// The dispatch loop's `TYPEOF` arm.
    #[inline(never)]
    fn exec_typeof(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let off = match top.kind {
            Kind::Undefined => self.static_str.undefined,
            Kind::Null => self.static_str.object,
            Kind::Boolean => self.static_str.boolean,
            Kind::Integer | Kind::Number => self.static_str.number,
            Kind::String => self.static_str.string,
            Kind::Reference => match top.value {
                // A callable proxy (target is callable) is a
                // function for `typeof`; any function instance is.
                Payload::Reference(r) if self.slot_is_callable(r) => self.static_str.function,
                _ => self.static_str.object,
            },
            Kind::Symbol => self.static_str.symbol,
            Kind::BigInt => self.static_str.bigint,
            // Closure/EnvReference/Uninitialized are never live
            // stack *values*: reaching one here is the engine's
            // own state being wrong, not an unported shape.
            _ => return Flow::Exit(Step::Host(Halt::EngineInvariant("typeof:non-value-kind"))),
        };
        if let Some(s) = self.stack.last_mut() {
            *s = Slot::of(Kind::String, Payload::String(off));
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- bitwise ----------------------------------------

    /// The dispatch loop's `BIT_AND` arm.
    #[inline(never)]
    fn exec_bit_and(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::And), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `BIT_OR` arm.
    #[inline(never)]
    fn exec_bit_or(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::Or), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `BIT_XOR` arm.
    #[inline(never)]
    fn exec_bit_xor(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::Xor), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `LEFT_SHIFT` arm.
    #[inline(never)]
    fn exec_left_shift(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::Shl), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SIGNED_RIGHT_SHIFT` arm.
    #[inline(never)]
    fn exec_signed_right_shift(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::Sar), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `UNSIGNED_RIGHT_SHIFT` arm.
    #[inline(never)]
    fn exec_unsigned_right_shift(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.binary_bit(code, BitOp::Shr), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `BIT_NOT` arm.
    #[inline(never)]
    fn exec_bit_not(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let raw = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let a = dispatch_result_flow!(
            self.to_numeric_integer_value(code, raw),
            self,
            return_depth,
            code
        );
        if let Payload::BigInt(off) = a.value {
            let result = self.bigint_bit_not(off);
            self.push(result);
        } else {
            self.push(Slot::integer(!to_int32(to_number(&a))));
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- unary ------------------------------------------

    /// The dispatch loop's `MINUS` arm.
    #[inline(never)]
    fn exec_minus(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let raw = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let a = dispatch_result_flow!(self.to_number_value(code, raw), self, return_depth, code);
        // `-aBigInt` (XS_CODE_MINUS general path →
        // `fxToNumericNumberUnary(the, a, gxTypeBigInt._neg)`):
        // `fxBigInt_neg` copies the magnitude into a fresh chunk
        // (charged by `make_bigint`) with the sign flipped; `-0n`
        // stays `+0n`. Frame residual measured against the pin.
        if let Payload::BigInt(off) = a.value {
            let (neg, mag) = self.read_bigint(off);
            self.meter.tick_raw(BIGINT_NEG_FRAME_METERING);
            let v = self.make_bigint(!neg, mag);
            self.push(v);
        } else {
            self.push(unary_minus(&a));
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `PLUS` arm.
    #[inline(never)]
    fn exec_plus(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let raw = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let a = dispatch_result_flow!(self.to_number_value(code, raw), self, return_depth, code);
        // Unary plus performs ToNumber rather than ToNumeric, so
        // a BigInt is a catchable TypeError. Preserve XS's integer
        // fast kind for every other integral conversion.
        if a.kind == Kind::BigInt {
            let error = self.internal_error("TypeError", "cannot coerce bigint to number".into());
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        self.push(a);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `NOT` arm.
    #[inline(never)]
    fn exec_not(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let a = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let t = self.truthy(&a);
        self.push(Slot::boolean(!t));
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `VOID` arm.
    #[inline(never)]
    fn exec_void(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let _ = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        self.push(Slot::undefined());
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- Global and object opcodes ---------------------

    // `global` (XS_CODE_GLOBAL, xsRun.c:2733): push a
    // reference to the realm's global object. Dispatch-metered
    // (no allocation).
    /// The dispatch loop's `GLOBAL` arm.
    #[inline(never)]
    fn exec_global(&mut self, mut pc: usize, size: i8) -> Flow {
        let g = self.environment.global_obj;
        self.push(Slot::of(Kind::Reference, Payload::Reference(g)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // Derived-constructor `this` access is guarded by its
    // uninitialized binding until `super()` completes.
    /// The dispatch loop's `GET_THIS` arm.
    #[inline(never)]
    fn exec_get_this(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        if self.this_val.kind == Kind::Uninitialized {
            let error = self.internal_error("ReferenceError", "this: not initialized yet".into());
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        self.push(self.this_val);
        pc += size as usize;
        Flow::Next(pc)
    }

    // Prepare a computed super reference. XS carries the actual
    // receiver and the home prototype together in an ephemeral
    // `XS_SUPER_KIND` stack slot; ironhorse uses an EnvReference
    // slot with `value = receiver` and `next = base prototype` for
    // the same transient geometry.
    /// The dispatch loop's `SUPER_AT` arm, which also runs `SUPER_AT_2`.
    #[inline(never)]
    fn exec_super_at(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let receiver_depth = if op == XS_CODE_SUPER_AT_2 { 3 } else { 2 };
        let receiver_pos = match self.stack.len().checked_sub(receiver_depth) {
            Some(pos) => pos,
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("super_at:stack"))),
        };
        let key_pos = receiver_pos + 1;
        let receiver = self.stack[receiver_pos];
        let receiver_ref = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => object,
            _ => {
                return Flow::Exit(Step::Host(Halt::NotImplemented(
                    "super_at:primitive-receiver",
                )))
            }
        };
        let home = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.home)
            .unwrap_or(crate::value::SlotIndex::NULL);
        if home.is_null() {
            return Flow::Exit(Step::Host(Halt::NotImplemented("super_at:no-home")));
        }
        let base = self.instance_prototype(home);
        let key = match dispatch_result_flow!(
            self.resolve_at_key(self.stack[key_pos]),
            self,
            return_depth,
            code
        ) {
            Some(key) => key,
            None => return Flow::Exit(Step::Host(Halt::NotImplemented("super_at:key"))),
        };
        let mut super_ref = Slot::of(Kind::EnvReference, Payload::Reference(receiver_ref));
        super_ref.next = base;
        self.stack[receiver_pos] = super_ref;
        self.stack[key_pos] = key;
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_THIS` arm.
    #[inline(never)]
    fn exec_set_this(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let value = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        // An arrow's `this` is the one its derived constructor binds (XS's
        // frames share one `this` cell): the arrow's capture says whether it
        // is bound yet, whatever the arrow read when it was entered.
        let capture = self.arrow_this_capture(self.cur_func);
        let bound = match capture {
            Some(capture) => self.slots.get(capture).kind != Kind::Uninitialized,
            None => self.this_val.kind != Kind::Uninitialized,
        };
        if bound {
            let error = self.internal_error("ReferenceError", "this: already initialized".into());
            dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
        }
        self.this_val = value;
        for capture in self.this_captures.drain(..) {
            let slot = self.slots.get_mut(capture);
            slot.kind = self.this_val.kind;
            slot.value = self.this_val.value;
        }
        if let Some(capture) = capture {
            self.publish_arrow_this(capture, value);
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // A fixed-name `super.k` starts lookup at
    // [[HomeObject]].[[Prototype]] while retaining the actual
    // receiver for getter/setter `this`.
    /// The dispatch loop's `GET_SUPER` arm.
    #[inline(never)]
    fn exec_get_super(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let id = operand_id(code, pc, 1);
        dispatch_result_flow!(self.dispatch_get_super(code, id), self, return_depth, code);
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `GET_SUPER_AT` arm.
    #[inline(never)]
    fn exec_get_super_at(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_get_super_at(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_SUPER` arm.
    #[inline(never)]
    fn exec_set_super(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        ilen: usize,
    ) -> Flow {
        let id = operand_id(code, pc, 1);
        dispatch_result_flow!(self.dispatch_set_super(code, id), self, return_depth, code);
        pc += ilen;
        Flow::Next(pc)
    }

    /// The dispatch loop's `SET_SUPER_AT` arm.
    #[inline(never)]
    fn exec_set_super_at(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_set_super_at(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // The current realm's hidden template registry. The following
    // compiler-emitted get/set-property uses the site's private
    // key, so a repeated evaluation of the same parse node reuses
    // its frozen template object.
    /// The dispatch loop's `TEMPLATE_CACHE` arm.
    #[inline(never)]
    fn exec_template_cache(&mut self, mut pc: usize, size: i8) -> Flow {
        self.push(Slot::of(
            Kind::Reference,
            Payload::Reference(self.template_cache),
        ));
        pc += size as usize;
        Flow::Next(pc)
    }

    // Freeze the compiler-created cooked/raw template pair. The
    // cooked array remains on the stack as the tag's first
    // argument and as the value cached by the following store.
    /// The dispatch loop's `TEMPLATE` arm.
    #[inline(never)]
    fn exec_template(&mut self, mut pc: usize, size: i8) -> Flow {
        let cooked = match self.stack.last().map(|slot| (slot.kind, slot.value)) {
            Some((Kind::Reference, Payload::Reference(cooked))) => cooked,
            _ => return Flow::Exit(Step::Host(Halt::EngineInvariant("template:object"))),
        };
        if !self.freeze_template_object(cooked) {
            return Flow::Exit(Step::Host(Halt::NotImplemented("template:raw")));
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `new.target` (XS_CODE_TARGET, xsRun.c:1324): push
    // `mxFrameTarget` when the running frame was entered as a
    // construct (`mxFrameHasTarget`), else `undefined`. XS holds
    // the target constructor in a dedicated frame slot; ironhorse
    // records it as (`cur_target`, `cur_func`) — for a `new f()`
    // the target IS the invoked constructor (there is no
    // `Reflect.construct`/`super()` retargeting in the covered
    // grammar, both of which self-name elsewhere). Pure dispatch:
    // XS's handler only allocs a stack slot and advances, so the
    // generic `tick_code` in the loop's prelude is the whole cost.
    /// The dispatch loop's `TARGET` arm.
    #[inline(never)]
    fn exec_target(&mut self, mut pc: usize, size: i8) -> Flow {
        if self.cur_target && !self.target_func.is_null() {
            let f = self.target_func;
            self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        } else {
            self.push(Slot::undefined());
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `current` (XS_CODE_CURRENT, xsRun.c:1308): push the
    // running function (`*mxFrameFunction`). Defined only inside
    // a user-function frame; at program level there is no user
    // function instance to name, so it self-names unsupported
    // rather than pushing a bogus value.
    /// The dispatch loop's `CURRENT` arm.
    #[inline(never)]
    fn exec_current(&mut self, mut pc: usize, size: i8) -> Flow {
        if self.cur_func.is_null() {
            return Flow::Exit(Step::Host(Halt::NotImplemented("current:program-level")));
        }
        let f = self.cur_func;
        self.push(Slot::of(Kind::Reference, Payload::Reference(f)));
        pc += size as usize;
        Flow::Next(pc)
    }

    // `to_numeric` (XS_CODE_TO_NUMERIC, xsRun.c:3358): coerce
    // the stack top to a numeric. An int/number is already
    // numeric (a no-op, exactly as XS); boolean/null/undefined
    // coerce with `ToNumber` (no metering — `fxToNumber` on a
    // primitive allocates nothing); a string/reference/bigint
    // needs the ToPrimitive/BigInt path outside the covered
    // primitive subset, so it self-names unsupported.
    /// The dispatch loop's `TO_NUMERIC` arm.
    #[inline(never)]
    fn exec_to_numeric(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        match top.kind {
            Kind::Integer | Kind::Number | Kind::BigInt => {}
            Kind::Boolean | Kind::Null | Kind::Undefined => {
                if let Some(s) = self.stack.last_mut() {
                    *s = Slot::number(to_number(&top));
                }
            }
            Kind::String | Kind::Reference => {
                let numeric = dispatch_result_flow!(
                    self.to_number_value(code, top),
                    self,
                    return_depth,
                    code
                );
                if let Some(s) = self.stack.last_mut() {
                    *s = numeric;
                }
            }
            _ => {
                return Flow::Exit(Step::Host(Halt::NotImplemented(
                    "to_numeric:unmodeled-kind",
                )))
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `to_string`: the shared abstract operation used by template
    // substitutions and other compiler-emitted string contexts.
    /// The dispatch loop's `TO_STRING` arm.
    #[inline(never)]
    fn exec_to_string(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_to_string(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // `increment`/`decrement` (XS_CODE_INCREMENT/DECREMENT,
    // xsRun.c:3391/3366): ±1 on the numeric stack top, with XS's
    // exact int-boundary promotion to number (INT_MAX for
    // increment, -(INT_MAX) for decrement). XS performs ToNumeric
    // inside this opcode. A postfix expression that preserves its
    // old value also emits `TO_NUMERIC` first. BigInt uses XS's
    // `_inc`/`_dec`, which add/subtract the static BigInt one.
    /// The dispatch loop's `INCREMENT` arm, which also runs `DECREMENT`.
    #[inline(never)]
    fn exec_increment(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let inc = op == XS_CODE_INCREMENT;
        let current = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let numeric = match current.kind {
            Kind::Integer | Kind::Number | Kind::BigInt => current,
            _ => dispatch_result_flow!(
                self.to_number_value(code, current),
                self,
                return_depth,
                code
            ),
        };
        if let Payload::BigInt(off) = numeric.value {
            let result = self.bigint_update(off, inc);
            if let Some(top) = self.stack.last_mut() {
                *top = result;
            }
            pc += size as usize;
            return Flow::Next(pc);
        }
        if let Some(top) = self.stack.last_mut() {
            *top = numeric;
        }
        let top = match self.stack.last_mut() {
            Some(s) => s,
            None => {
                return Flow::Exit(Step::Host(Halt::EngineInvariant(
                    "increment:stack-underflow",
                )))
            }
        };
        match (top.kind, top.value) {
            (Kind::Integer, Payload::Integer(v)) => {
                let boundary = if inc { i32::MAX } else { -i32::MAX };
                if v != boundary {
                    top.value = Payload::Integer(if inc { v + 1 } else { v - 1 });
                } else {
                    top.kind = Kind::Number;
                    top.value = Payload::Number(if inc { v as f64 + 1.0 } else { v as f64 - 1.0 });
                }
            }
            (Kind::Number, Payload::Number(n)) => {
                top.value = Payload::Number(canonicalize_nan(if inc { n + 1.0 } else { n - 1.0 }));
            }
            // `ToNumeric` above yields an Integer, Number, or
            // BigInt (handled before); anything else is the
            // engine's own coercion result being malformed.
            _ => {
                return Flow::Exit(Step::Host(Halt::EngineInvariant(
                    "increment:non-numeric-result",
                )))
            }
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    // `exponentiation` (XS_CODE_EXPONENTIATION, xsRun.c:3574):
    // ToNumeric is applied to the already-evaluated left operand
    // first, then the right operand. This order is observable when
    // either conversion calls a guest hook. Number operands use
    // `fx_pow`; mixed Number/BigInt operands throw TypeError.
    // Two BigInts use exponentiation by squaring, with a bounded
    // projected result size so an untrusted exponent cannot make
    // the host allocate without limit.
    /// The dispatch loop's `EXPONENTIATION` arm.
    #[inline(never)]
    fn exec_exponentiation(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_exponentiation(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // `instanceof` (`XS_CODE_INSTANCEOF`, xsRun.c →
    // `fxRunInstanceOf`): `GetMethod(C, @@hasInstance)`, invoke a
    // custom method when present, otherwise require a callable and
    // apply `OrdinaryHasInstance`. Stack: [.., left, right].
    /// The dispatch loop's `INSTANCEOF` arm.
    #[inline(never)]
    fn exec_instanceof(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        dispatch_result_flow!(self.dispatch_instanceof(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // `in` (`XS_CODE_IN`, xsRun.c → fxRunIn → fxHasAt = fxAt +
    // fxHasAll): does the right operand (object) have a property
    // named by the left (key). Stack: [.., left (key), right
    // (object)]. The key passes through `ToPropertyKey`, then is
    // resolved through the global intern table exactly as `fxAt`
    // does and answered by a full prototype-chain walk
    // (`fxHasAll`). A program symbol present own-or-inherited ⇒
    // `true`. Computed non-index names complete create-only
    // intrinsic linking before lookup; canonical integer-index
    // keys remain uninterned and follow exotic own-property
    // behavior. A non-object RHS throws a catchable TypeError
    // before coercing the left operand.
    /// The dispatch loop's `IN` arm.
    #[inline(never)]
    fn exec_in(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        dispatch_result_flow!(self.dispatch_in(code), self, return_depth, code);
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- stack ------------------------------------------

    /// The dispatch loop's `DUB_AT` arm.
    #[inline(never)]
    fn exec_dub_at(&mut self, mut pc: usize, size: i8) -> Flow {
        // Preserve both the receiver and the already-coerced key
        // for a computed compound assignment (xsRun.c DUB_AT).
        let n = self.stack.len();
        if n < 2 {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("dub_at:stack-underflow")));
        }
        let receiver = self.stack[n - 2];
        let key = self.stack[n - 1];
        self.push(receiver);
        self.push(key);
        pc += size as usize;
        Flow::Next(pc)
    }

    // ---- branches ---------------------------------------

    // `branch_status` (`XS_CODE_BRANCH_STATUS_*`, xsRun.c:1577): the
    // generator/async resume epilogue, right after `YIELD`/`AWAIT`.
    // XS branches on `the->status` (the resume mode): `next`
    // (`XS_NO_STATUS`) takes `index + offset` (branch past the
    // return/throw handling and continue the body, leaving the sent/
    // resolved value on the stack as the yield/await expression's
    // result); `return` takes `index` (fall into the return handling
    // path); `throw` sets `mxException = *mxStack` (the top = the
    // rejection value the resume pushed) and `fxJump`s to the
    // innermost handler. Generator resumes thread all three modes;
    // async `await` resumes use `NoStatus` and `Throw`. XS meters
    // this as one dispatch, mirrored at the loop top.
    /// The dispatch loop's `BRANCH_STATUS_1` arm, which also runs `BRANCH_STATUS_2` and
    /// `BRANCH_STATUS_4`.
    #[inline(never)]
    fn exec_branch_status(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let off = match op {
            XS_CODE_BRANCH_STATUS_1 => operand_s1(code, pc, 1),
            XS_CODE_BRANCH_STATUS_2 => i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32,
            _ => i32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]]),
        };
        let status = self.resume_status;
        self.resume_status = ResumeStatus::NoStatus;
        match status {
            ResumeStatus::Throw => {
                // A rejected await resume: the rejection reason is the
                // top of stack (pushed as `sent`). `mxException =
                // *mxStack` (peek), then unwind to the innermost
                // handler — or escape to the host (`Halt::Throw`),
                // which `step_async` turns into a result-promise
                // rejection.
                let v = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
                dispatch_halt_flow!(self.raise_js(v), self, return_depth, code);
            }
            ResumeStatus::Return => {
                // Fall through to the compiler-emitted generator
                // return path immediately after `BRANCH_STATUS`.
                // That path stores the sent value as the function
                // result and branches through any aliased finally
                // targets before reaching `END`.
                pc += size as usize;
            }
            ResumeStatus::NoStatus => {
                if off < 0 && self.check_meter() == MeterCheck::Abort {
                    return Flow::Exit(Step::Host(Halt::MeterAbort));
                }
                pc = branch_target(pc, size, off);
            }
        }
        Flow::Next(pc)
    }

    // `branch_coalesce` (`??`, xsRun.c:BRANCH_COALESCE): if the
    // stack top is undefined/null, **pop** it and fall through
    // (evaluate the right operand); otherwise keep it and branch
    // (skip the right operand). The kept-value branch is the
    // `mxBranch`, so it meter-checks on a backward offset.
    /// The dispatch loop's `BRANCH_COALESCE_1` arm, which also runs `BRANCH_COALESCE_2` and
    /// `BRANCH_COALESCE_4`.
    #[inline(never)]
    fn exec_branch_coalesce(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let off = match op {
            XS_CODE_BRANCH_COALESCE_1 => operand_s1(code, pc, 1),
            XS_CODE_BRANCH_COALESCE_2 => i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32,
            _ => i32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]]),
        };
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        if matches!(top.kind, Kind::Undefined | Kind::Null) {
            let _ = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
            pc += size as usize;
        } else {
            if off < 0 && self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = branch_target(pc, size, off);
        }
        Flow::Next(pc)
    }

    // `branch_chain` (`?.`, xsRun.c:BRANCH_CHAIN): if the stack
    // top is undefined/null, normalize it to undefined and branch
    // (short-circuit the optional chain); otherwise fall through
    // (continue the chain), keeping the value.
    /// The dispatch loop's `BRANCH_CHAIN_1` arm, which also runs `BRANCH_CHAIN_2` and
    /// `BRANCH_CHAIN_4`.
    #[inline(never)]
    fn exec_branch_chain(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        let off = match op {
            XS_CODE_BRANCH_CHAIN_1 => operand_s1(code, pc, 1),
            XS_CODE_BRANCH_CHAIN_2 => i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32,
            _ => i32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]]),
        };
        let top = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        if matches!(top.kind, Kind::Undefined | Kind::Null) {
            if let Some(s) = self.stack.last_mut() {
                *s = Slot::undefined();
            }
            if off < 0 && self.check_meter() == MeterCheck::Abort {
                return Flow::Exit(Step::Host(Halt::MeterAbort));
            }
            pc = branch_target(pc, size, off);
        } else {
            pc += size as usize;
        }
        Flow::Next(pc)
    }

    // ---- result / return --------------------------------

    // `end` (`XS_CODE_END`, xsRun.c:1049): a function body's
    // terminator. Pop the callee frame, reset the value stack to
    // the frame boundary, push the callee's result into the
    // caller, and resume the caller. XS runs `mxFirstCode()`
    // (a meter check) **only when the caller is a JS frame**;
    // when the popped frame's caller is the C boundary (an empty
    // call stack here), it returns to C with **no** check. The
    // top-level program never reaches `end` (it ends in
    // `return`), so a JS caller always exists when `end` runs in
    // the covered grammar — but the guard is explicit so the
    // return-depth guard determines whether to leave dispatch
    // or restore a caller frame.
    /// The dispatch loop's `END` arm, which also runs `END_ARROW`, `END_BASE` and `END_DERIVED`.
    #[inline(never)]
    fn exec_end(&mut self, code: &[u8], return_depth: usize, op: Opcode) -> Flow {
        if self.call_stack.len() == return_depth {
            // The frame this dispatch was entered to run has
            // returned: hand control back to the caller (the C/host
            // boundary for the top-level program at depth 0, or the
            // native method driving a callback via `run_callback`).
            // Construct/`this` return still applies; leave the
            // result on the value stack for the caller to read.
            let ret = dispatch_result_flow!(self.end_completion(op), self, return_depth, code);
            if return_depth != 0 {
                // A callback frame: pop the activation and push its
                // result, exactly as a normal `END` does, so
                // `run_callback` can read it and the caller's
                // activation is restored.
                let _ = self.leave_call_to_frame_base();
                self.push(ret);
            }
            return Flow::Exit(Step::Returned);
        }
        // Guard the non-boundary resume against a frame underflow:
        // crafted bytecode can reach this return-family opcode with
        // the call stack already **below** the depth this dispatch
        // was entered at (`call_stack.len() < return_depth`), so the
        // frame `leave_call` would pop belongs to an OUTER dispatch
        // context — popping it corrupts the caller's frame
        // accounting and, cascaded through nested async/generator
        // re-entry, empties the stack (the `leave_call with empty
        // call stack` fuzz abort, endojs/endo-but-for-bots#1046). A
        // leave/return with no matching active frame is malformed
        // control flow, so degrade to a host-facing `Halt` exactly
        // as the sibling stack-underflow guards do (`yield:`/
        // `await:`/`add:stack-underflow`), never `panic!`.
        if self.call_stack.len() < return_depth {
            return Flow::Exit(Step::Host(Halt::EngineInvariant("end:frame-underflow")));
        }
        // Construct return (XS's `END` with `mxFrameHasTarget`):
        // a constructor's completion is its `this` instance unless
        // the body explicitly returned an object.
        let ret = dispatch_result_flow!(self.end_completion(op), self, return_depth, code);
        let resume = self.leave_call_to_frame_base();
        self.push(ret);
        let pc = resume;
        // Returning into a JS caller: `mxFirstCode()` checks.
        if self.check_meter() == MeterCheck::Abort {
            return Flow::Exit(Step::Host(Halt::MeterAbort));
        }
        Flow::Next(pc)
    }

    // `return` (`XS_CODE_RETURN`, xsRun.c:1080): the top-level
    // program's terminator. XS always returns to the C caller
    // here with **no** meter check. Only the program frame emits
    // it (a `return x` inside a function compiles to
    // `set_result; end`), so this is the exit-to-host boundary.
    /// The dispatch loop's `RETURN` arm.
    #[inline(never)]
    fn exec_return(&mut self, return_depth: usize) -> Flow {
        if return_depth != 0 || !self.call_stack.is_empty() {
            return Flow::Exit(Step::Host(Halt::EngineInvariant(
                "return:non-program-frame",
            )));
        }
        Flow::Exit(Step::Returned)
    }

    // ---- generators -------------------------------------

    // `start_generator` (`XS_CODE_START_GENERATOR`, xsRun.c:1172):
    // the leading opcode of a generator body. Rather than running,
    // it creates the generator instance, snapshots the fresh
    // activation into the `generators` side table (resume cursor =
    // just past this opcode), and returns the instance to `g()`'s
    // caller — exactly as `END` returns a completion value. The body
    // proper runs on the first `.next` (`resume_generator`).
    /// The dispatch loop's `START_GENERATOR` arm.
    #[inline(never)]
    fn exec_start_generator(&mut self, mut pc: usize, return_depth: usize, size: i8) -> Flow {
        // A generator built with `new` is a `TypeError` in XS
        // (`mxFrameHasTarget`); self-name rather than mis-handle.
        if self.cur_target {
            return Flow::Exit(Step::Host(Halt::NotImplemented("generator:new-target")));
        }
        let resume_pc = pc + size as usize;
        let proto = self
            .prototype_of(self.cur_func)
            .unwrap_or(self.generator_proto);
        let gen = self.new_generator_instance(proto, resume_pc);
        let gen_slot = Slot::of(Kind::Reference, Payload::Reference(gen));
        // Return the generator to the caller, mirroring `END`'s
        // boundary/non-boundary split (no construct-return: guarded).
        if self.call_stack.len() == return_depth {
            if return_depth != 0 {
                let _ = self.leave_call();
                self.push(gen_slot);
            }
            return Flow::Exit(Step::Returned);
        }
        // Same frame-underflow guard as `END` (see there): a
        // `start_generator` reached below `return_depth` on crafted
        // bytecode must not pop an outer frame (#1046).
        if self.call_stack.len() < return_depth {
            return Flow::Exit(Step::Host(Halt::EngineInvariant(
                "start_generator:frame-underflow",
            )));
        }
        let resume = self.leave_call();
        self.push(gen_slot);
        pc = resume;
        if self.check_meter() == MeterCheck::Abort {
            return Flow::Exit(Step::Host(Halt::MeterAbort));
        }
        Flow::Next(pc)
    }

    // `yield` (`XS_CODE_YIELD`, xsRun.c:1213): suspend the running
    // generator. Snapshot its activation (scope + own stack
    // temporaries + resume cursor) back into the `generators` table
    // and unwind to the `resume_generator` driver via
    // [`Step::Yielded`], carrying the yielded value (the `.next`
    // result). `YIELD_STAR` uses the same suspension machinery,
    // carrying the delegate's iterator-result object as-is.
    /// The dispatch loop's `YIELD` arm, which also runs `YIELD_STAR`.
    #[inline(never)]
    fn exec_yield(&mut self, code: &[u8], pc: usize, return_depth: usize, size: i8) -> Flow {
        // A synchronous generator can run inside an async-generator
        // step (for example, a custom iterator used by parameter
        // destructuring), and the reverse nesting is possible too.
        // Suspend the innermost driver, not merely whichever flavor
        // happens to have a non-empty stack.
        let async_is_innermost = self.async_gen_run_stack.last().is_some_and(|a| {
            self.gen_run_stack
                .last()
                .is_none_or(|g| a.call_depth_base > g.call_depth_base)
        });
        if async_is_innermost {
            let a = self.async_gen_run_stack.last().unwrap();
            let (gen, stack_base, jumps_base, call_depth_base) =
                (a.gen, a.stack_base, a.jumps_base, a.call_depth_base);
            let resume_pc = pc + size as usize;
            let yielded = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
            let frame = match self.suspend_activation(
                stack_base,
                jumps_base,
                call_depth_base,
                resume_pc,
                Suspension::Yield,
            ) {
                Ok(frame) => frame,
                Err(halt) => return Flow::Exit(Step::Host(halt)),
            };
            if let Some(g) = self.async_generators.get_mut(&gen) {
                g.frame = Some(frame);
                g.state = AsyncGeneratorState::Awaiting;
            }
            return Flow::Exit(Step::AsyncYielded(yielded));
        }
        let (gen, stack_base, jumps_base, call_depth_base) = match self.gen_run_stack.last() {
            Some(g) => (g.gen, g.stack_base, g.jumps_base, g.call_depth_base),
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("yield:no-generator"))),
        };
        let resume_pc = pc + size as usize;
        let yielded = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let frame = match self.suspend_activation(
            stack_base,
            jumps_base,
            call_depth_base,
            resume_pc,
            Suspension::Yield,
        ) {
            Ok(frame) => frame,
            Err(halt) => return Flow::Exit(Step::Host(halt)),
        };
        if let Some(g) = self.generators.get_mut(&gen) {
            g.state = GeneratorState::SuspendedYield;
            g.frame = Some(frame);
        }
        Flow::Exit(Step::Yielded(yielded))
    }

    // ---- async functions --------------------------------

    /// The dispatch loop's `START_ASYNC_GENERATOR` arm.
    #[inline(never)]
    fn exec_start_async_generator(&mut self, mut pc: usize, return_depth: usize, size: i8) -> Flow {
        if self.cur_target {
            return Flow::Exit(Step::Host(Halt::NotImplemented(
                "async-generator:new-target",
            )));
        }
        let resume_pc = pc + size as usize;
        let proto = self
            .prototype_of(self.cur_func)
            .unwrap_or(self.async_generator_proto);
        let gen = self.new_async_generator_instance(proto, resume_pc);
        let slot = Slot::of(Kind::Reference, Payload::Reference(gen));
        if self.call_stack.len() == return_depth {
            if return_depth != 0 {
                let _ = self.leave_call();
                self.push(slot);
            }
            return Flow::Exit(Step::Returned);
        }
        // Same frame-underflow guard as `END` (see there): a
        // `start_async_generator` reached below `return_depth` on
        // crafted bytecode must not pop an outer frame (#1046).
        if self.call_stack.len() < return_depth {
            return Flow::Exit(Step::Host(Halt::EngineInvariant(
                "start_async_generator:frame-underflow",
            )));
        }
        let resume = self.leave_call();
        self.push(slot);
        pc = resume;
        if self.check_meter() == MeterCheck::Abort {
            return Flow::Exit(Step::Host(Halt::MeterAbort));
        }
        Flow::Next(pc)
    }

    // `start_async` (`XS_CODE_START_ASYNC`, xsRun.c:1094): the
    // leading opcode of an async-function body. Create the async
    // instance (result promise + resolving/await functions), snapshot
    // the fresh activation (resume cursor = just past this opcode),
    // run the body synchronously to the first `await` or completion
    // via `step_async`, then return the RESULT PROMISE to the caller
    // — exactly as `START_GENERATOR` returns the generator. The frame
    // is CLONED (not taken) so this driver frame survives for the
    // `leave_call` that returns the promise.
    /// The dispatch loop's `START_ASYNC` arm.
    #[inline(never)]
    fn exec_start_async(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        size: i8,
    ) -> Flow {
        // `new asyncFn()` throws before the body is entered (an async
        // function has no [[Construct]]), so a target frame here is an async
        // arrow that took its enclosing constructor's `new.target`
        // (`RETRIEVE_TARGET`), which its activation keeps across `await`.
        let resume_pc = pc + size as usize;
        let inst = self.new_async_instance(resume_pc);
        // Run to the first await/completion. An un-modeled surface in
        // the body (a named skip) propagates out as the async call's
        // own skip.
        dispatch_result_flow!(
            self.step_async(code, inst, ResumeStatus::NoStatus, Slot::undefined(), true),
            self,
            return_depth,
            code
        );
        let promise = self.async_instances[&inst].result_promise;
        let promise_slot = Slot::of(Kind::Reference, Payload::Reference(promise));
        // Return the result promise to the caller, mirroring `END`'s
        // boundary/non-boundary split (no construct-return: guarded).
        if self.call_stack.len() == return_depth {
            if return_depth != 0 {
                let _ = self.leave_call();
                self.push(promise_slot);
            }
            return Flow::Exit(Step::Returned);
        }
        // Same frame-underflow guard as `END` (see there): a
        // `start_async` reached below `return_depth` on crafted
        // bytecode must not pop an outer frame — this is the exact
        // site the `leave_call with empty call stack` fuzz abort
        // hit (#1046).
        if self.call_stack.len() < return_depth {
            return Flow::Exit(Step::Host(Halt::EngineInvariant(
                "start_async:frame-underflow",
            )));
        }
        let resume = self.leave_call();
        self.push(promise_slot);
        pc = resume;
        if self.check_meter() == MeterCheck::Abort {
            return Flow::Exit(Step::Host(Halt::MeterAbort));
        }
        Flow::Next(pc)
    }

    // `await` (`XS_CODE_AWAIT`, xsRun.c:1212): suspend the running
    // async instance. Shares XS's `YIELD` `mxCase` — snapshot the
    // activation (scope + own stack temporaries + resume cursor) into
    // the `async_instances` table and unwind to the `step_async`
    // driver via [`Step::Awaited`], carrying the awaited value (popped
    // to the frame result). The per-suspend metering is the identical
    // C code as `YIELD`, so it reuses [`GENERATOR_YIELD_METERING`].
    // `await` inside a live `try` travels like `yield`'s: the run's
    // handlers ride the saved frame and the resume rebases them.
    /// The dispatch loop's `AWAIT` arm.
    #[inline(never)]
    fn exec_await(&mut self, code: &[u8], pc: usize, return_depth: usize, size: i8) -> Flow {
        // A plain async function can run inside an async
        // generator's step (the generator body synchronously
        // calls it and its body awaits) — suspend the INNERMOST
        // driver, exactly as the YIELD arm selects between the
        // sync- and async-generator stacks. Preferring the
        // async-generator stack unconditionally snapshotted the
        // helper's activation into the GENERATOR's side-table
        // entry: the helper's own resume then found no frame
        // (`async:no-frame`) and the generator's saved frame was
        // transiently clobbered. The deepest active frame owns
        // the suspension.
        let async_gen_is_innermost = self.async_gen_run_stack.last().is_some_and(|a| {
            self.async_run_stack
                .last()
                .is_none_or(|p| a.call_depth_base > p.call_depth_base)
        });
        if async_gen_is_innermost {
            let a = self.async_gen_run_stack.last().unwrap();
            let (gen, stack_base, jumps_base, call_depth_base) =
                (a.gen, a.stack_base, a.jumps_base, a.call_depth_base);
            let resume_pc = pc + size as usize;
            let awaited = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
            let frame = match self.suspend_activation(
                stack_base,
                jumps_base,
                call_depth_base,
                resume_pc,
                Suspension::Await,
            ) {
                Ok(frame) => frame,
                Err(halt) => return Flow::Exit(Step::Host(halt)),
            };
            if let Some(g) = self.async_generators.get_mut(&gen) {
                g.frame = Some(frame);
                g.state = AsyncGeneratorState::Awaiting;
            }
            return Flow::Exit(Step::Awaited(awaited));
        }
        let (inst, stack_base, jumps_base, call_depth_base) = match self.async_run_stack.last() {
            Some(a) => (a.inst, a.stack_base, a.jumps_base, a.call_depth_base),
            None => {
                return Flow::Exit(Step::Host(Halt::EngineInvariant("await:no-async-instance")))
            }
        };
        let resume_pc = pc + size as usize;
        let awaited = dispatch_result_flow!(self.pop_checked(), self, return_depth, code);
        let frame = match self.suspend_activation(
            stack_base,
            jumps_base,
            call_depth_base,
            resume_pc,
            Suspension::Await,
        ) {
            Ok(frame) => frame,
            Err(halt) => return Flow::Exit(Step::Host(halt)),
        };
        if let Some(a) = self.async_instances.get_mut(&inst) {
            a.frame = Some(frame);
        }
        Flow::Exit(Step::Awaited(awaited))
    }

    // ---- exceptions: the jump-buffer chain --------------

    // `catch L` (`XS_CODE_CATCH_*`, xsRun.c:1365): establish a
    // handler. Push a jump recording the resume target
    // (`pc + size + offset`), the value-stack/scope cuts, and
    // the call depth — the state a throw longjmps back to.
    // Execution continues into the try body (no branch). The
    // `c_malloc(txJump)` is not a slot allocation, so — like
    // XS — `catch` meters only its dispatch.
    /// The dispatch loop's `CATCH_1` arm, which also runs `CATCH_2` and `CATCH_4`.
    #[inline(never)]
    fn exec_catch(&mut self, code: &[u8], mut pc: usize, op: Opcode, size: i8) -> Flow {
        use Opcode::*;
        let len = code.len();
        let off = match op {
            XS_CODE_CATCH_1 => operand_s1(code, pc, 1),
            XS_CODE_CATCH_2 => i16::from_le_bytes([code[pc + 1], code[pc + 2]]) as i32,
            _ => i32::from_le_bytes([code[pc + 1], code[pc + 2], code[pc + 3], code[pc + 4]]),
        };
        let target = branch_target(pc, size, off);
        // A handler must name a byte in this buffer. Validate the
        // untrusted offset before retaining it, so a later throw
        // cannot reach the resume-target invariant with bad input.
        if target >= len {
            return Flow::Exit(Step::Host(Halt::Decode(DecodeError::InvalidCatchTarget {
                pc,
                target,
                len,
            })));
        }
        self.jumps.push(CatchJump {
            target_pc: target,
            segment: self
                .active_segment
                .or_else(|| self.func_segments.get(&self.cur_func).copied()),
            stack_len: self.stack.len(),
            locals_len: self.locals.len(),
            id_map: self.id_map.clone(),
            call_depth: self.call_stack.len(),
            env: self.env,
            flag: 1,
            // Pushed by this dispatch, not re-established on a
            // resume — no rebase surcharge.
            rebased: false,
        });
        pc += size as usize;
        Flow::Next(pc)
    }

    // `exception` (`XS_CODE_EXCEPTION`, xsRun.c:1359): push the
    // pending thrown value onto the stack (the catch clause
    // binds it) and clear `mxException` back to `undefined`.
    /// The dispatch loop's `EXCEPTION` arm.
    #[inline(never)]
    fn exec_exception(&mut self, mut pc: usize, size: i8) -> Flow {
        let ex = self.exception;
        self.push(ex);
        self.exception = Slot::undefined();
        pc += size as usize;
        Flow::Next(pc)
    }

    // `throw` (`XS_CODE_THROW`, xsRun.c:1409): `mxException =
    // *mxStack` (peek), then `fxJump` — unwind to the innermost
    // handler, restoring its recorded state and resuming at its
    // target (a `mxFirstCode` meter check fires on resume). With
    // no handler the throw escapes to the host: `Halt::Throw`.
    /// The dispatch loop's `THROW` arm.
    #[inline(never)]
    fn exec_throw(&mut self, code: &[u8], return_depth: usize) -> Flow {
        let v = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        dispatch_halt_flow!(self.raise_js(v), self, return_depth, code);
    }

    // `rethrow` (`XS_CODE_RETHROW`, xsRun.c:1405): re-`fxJump`
    // with the current `mxException` (a finally re-raising a
    // saved throw). Same unwind as `throw`, but the value is
    // already in `mxException` rather than on the stack.
    /// The dispatch loop's `RETHROW` arm.
    #[inline(never)]
    fn exec_rethrow(&mut self, code: &[u8], return_depth: usize) -> Flow {
        let v = self.exception;
        dispatch_halt_flow!(self.raise_js(v), self, return_depth, code);
    }

    // `throw_status` (`XS_CODE_THROW_STATUS`, xsRun.c:1423):
    // throw only when the frame's status carries `XS_THROW_STATUS`
    // (a for-in/for-of/optional-chaining status check). The
    // covered grammar never sets a throw status, so this always
    // falls through; it is dispatched (metered) and advances.
    /// The dispatch loop's `THROW_STATUS` arm.
    #[inline(never)]
    fn exec_throw_status(&mut self, mut pc: usize, size: i8) -> Flow {
        pc += size as usize;
        Flow::Next(pc)
    }

    // Explicit resource management. `USING` validates the
    // resource's well-known disposer and replaces the value on
    // the stack with that callable (or null for a nullish
    // resource). The compiler stores it in the declaration's
    // adjacent synthetic disposal slot while preserving the
    // resource as the binding value.
    /// The dispatch loop's `USING` arm, which also runs `USING_ASYNC`.
    #[inline(never)]
    fn exec_using(
        &mut self,
        code: &[u8],
        mut pc: usize,
        return_depth: usize,
        op: Opcode,
        size: i8,
    ) -> Flow {
        use Opcode::*;
        // Measured declaration residue (see the constants):
        // one unit always, one more for a real resource.
        self.meter.tick_raw(USING_DECL_METERING);
        let error_message = if op == XS_CODE_USING_ASYNC {
            "using: neither [Symbol.asyncDispose] nor [Symbol.dispose] are function"
        } else {
            "using: [Symbol.dispose] is not a function"
        };
        let resource = dispatch_result_flow!(self.peek_checked(), self, return_depth, code);
        let disposer = if matches!(resource.kind, Kind::Null | Kind::Undefined) {
            Slot::null()
        } else {
            self.meter.tick_raw(USING_RESOURCE_METERING);
            let object =
                dispatch_result_flow!(self.array_to_object(resource), self, return_depth, code);
            let Payload::Reference(inst) = object.value else {
                unreachable!("ToObject result")
            };
            let mut value = Slot::undefined();
            if op == XS_CODE_USING_ASYNC {
                if let Some(id) = self.well_known_symbol_property_id("asyncDispose") {
                    value = dispatch_result_flow!(
                        self.mop_get(code, inst, id, resource),
                        self,
                        return_depth,
                        code
                    );
                }
            }
            // The @@dispose lookup serves BOTH forms: it is the
            // sync `using`'s primary protocol and the async
            // form's fallback. Both opcodes must perform this
            // lookup before rejecting a non-callable disposer.
            if !self.is_callable_value(value) {
                if let Some(id) = self.well_known_symbol_property_id("dispose") {
                    value = dispatch_result_flow!(
                        self.mop_get(code, inst, id, resource),
                        self,
                        return_depth,
                        code
                    );
                }
            }
            if !self.is_callable_value(value) {
                let error = self.internal_error("TypeError", error_message.into());
                dispatch_halt_flow!(self.raise_js(error), self, return_depth, code);
            }
            value
        };
        if let Some(top) = self.stack.last_mut() {
            *top = disposer;
        }
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `USED_1` arm, which also runs `USED_2`.
    #[inline(never)]
    fn exec_used(&mut self, code: &[u8], mut pc: usize, op: Opcode, size: i8) -> Flow {
        let selector_index = self.local_operand(op, code, pc);
        let exception_index = selector_index.saturating_sub(1);
        let current = self.exception;
        let selector = self
            .get_local(selector_index)
            .unwrap_or_else(Slot::undefined);
        let has_prior = matches!(selector.value, Payload::Integer(0));
        if has_prior {
            let prior = self
                .get_local(exception_index)
                .unwrap_or_else(Slot::undefined);
            let suppressed = self.build_suppressed_error(current, prior, None);
            self.set_local(exception_index, suppressed);
        } else {
            self.set_local(exception_index, current);
            self.set_local(selector_index, Slot::integer(0));
        }
        self.exception = Slot::undefined();
        pc += size as usize;
        Flow::Next(pc)
    }

    // A compiled Module-goal unit ends in a small loader envelope:
    // `[initialize, execute, ...transfers, count]; module flags`.
    // `TRANSFER` first condenses each transfer's stack operands to
    // one record. For a single hosted module, local/export-only
    // transfers need no cross-module wiring—the functions already
    // share their closure cells—so a Boolean marker is sufficient.
    // An import/re-export carries a source string and remains a
    // named static-linking boundary until the filesystem loader is
    // connected to the bytecode interpreter.
    /// The dispatch loop's `TRANSFER` arm, which also runs `TRANSFER_JSON`.
    #[inline(never)]
    fn exec_transfer(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let count = match dispatch_result_flow!(self.pop_checked(), self, return_depth, code).value
        {
            Payload::Integer(n) if n >= 3 => n as usize,
            _ => return Flow::Exit(Step::Host(Halt::EngineInvariant("module:transfer-shape"))),
        };
        let start = match self.stack.len().checked_sub(count) {
            Some(start) => start,
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("module:transfer-stack"))),
        };
        let imported = self.stack[start + 1].kind == Kind::String;
        let local_id = match self.stack[start].value {
            Payload::At(id, _) => id,
            _ => crate::value::XS_NO_ID,
        };
        self.stack.truncate(start);
        self.push(Slot::of(
            Kind::At,
            Payload::At(local_id, u32::from(imported)),
        ));
        pc += size as usize;
        Flow::Next(pc)
    }

    /// The dispatch loop's `MODULE` arm.
    #[inline(never)]
    fn exec_module(&mut self, code: &[u8], mut pc: usize, return_depth: usize, size: i8) -> Flow {
        let flags = code.get(pc + 1).copied().unwrap_or_default();
        if flags & 32 != 0 {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:dynamic-import")));
        }
        if flags & 64 != 0 {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:import-meta")));
        }
        let count = match dispatch_result_flow!(self.pop_checked(), self, return_depth, code).value
        {
            Payload::Integer(n) if n >= 2 => n as usize,
            _ => return Flow::Exit(Step::Host(Halt::EngineInvariant("module:envelope-shape"))),
        };
        let start = match self.stack.len().checked_sub(count) {
            Some(start) => start,
            None => return Flow::Exit(Step::Host(Halt::EngineInvariant("module:envelope-stack"))),
        };
        let initialize = self.stack[start];
        let execute = self.stack[start + 1];
        let transfers = self.stack[start + 2..].to_vec();
        if transfers
            .iter()
            .any(|transfer| matches!(transfer.value, Payload::At(_, imported) if imported != 0))
        {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:static-linking")));
        }
        let Some((execute_function, execute_record)) = self.module_envelope_function(execute)
        else {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:execute-function")));
        };
        if execute_record.body_start.is_none() {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:execute-body")));
        }
        let execute_environment = execute_record.closures;
        if self.instance_prototype(execute_function) == self.async_function_proto {
            return Flow::Exit(Step::Host(Halt::NotImplemented("module:top-level-await")));
        }
        let (initialize_function, initialize_environment) = match initialize.value {
            Payload::Reference(_) if initialize.kind == Kind::Reference => {
                match self.module_envelope_function(initialize) {
                    Some((function, record)) => (Some(function), record.closures),
                    None => {
                        return Flow::Exit(Step::Host(Halt::EngineInvariant(
                            "module:envelope-shape",
                        )))
                    }
                }
            }
            _ => (None, crate::value::SlotIndex::NULL),
        };
        for transfer in &transfers {
            let Payload::At(local_id, _) = transfer.value else {
                return Flow::Exit(Step::Host(Halt::EngineInvariant("module:transfer-record")));
            };
            if local_id == crate::value::XS_NO_ID {
                continue;
            }
            self.meter.tick_slot_alloc();
            let cell = self.slots.alloc(Slot::uninitialized());
            if !initialize_environment.is_null() {
                self.append_module_closure(initialize_environment, local_id, cell);
            }
            self.append_module_closure(execute_environment, local_id, cell);
        }
        self.stack.truncate(start);
        if initialize_function.is_some() {
            let _ = dispatch_result_flow!(
                self.run_callback(code, initialize, Slot::undefined(), &[]),
                self,
                return_depth,
                code
            );
        }
        let _ = dispatch_result_flow!(
            self.run_callback(code, execute, Slot::undefined(), &[]),
            self,
            return_depth,
            code
        );
        // `fxPrepareModule` returns a module instance to the host
        // loader. The test262 execution boundary observes only the
        // body completion/throw; an opaque undefined placeholder is
        // sufficient until namespace objects are wired here.
        self.push(Slot::undefined());
        pc += size as usize;
        Flow::Next(pc)
    }

    // Dynamic import and import.meta need an asynchronous host
    // loader and per-module metadata. The static linkage engine
    // in `ironhorse_vm::module` supplies neither capability, so
    // these operations return specific unsupported labels.
    /// The dispatch loop's `IMPORT` arm.
    #[inline(never)]
    fn exec_import(&mut self) -> Flow {
        Flow::Exit(Step::Host(Halt::NotImplemented("module:dynamic-import")))
    }

    /// The dispatch loop's `IMPORT_META` arm.
    #[inline(never)]
    fn exec_import_meta(&mut self) -> Flow {
        Flow::Exit(Step::Host(Halt::NotImplemented("module:import-meta")))
    }
}
