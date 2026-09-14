//! Native-owned guest boundaries: handler isolation and caught-throw cleanup.
use super::{Halt, Interp, Slot, Step};

/// Whether guest execution owns a native catch boundary or shares its caller's.
#[derive(Clone, Copy)]
pub(super) enum CallerHandlers {
    Isolate,
    Preserve,
}

impl Interp {
    /// Run guest code with an explicit caller-handler policy.
    /// A fenced guest cannot resume a caller handler; such an escaping transfer
    /// is an invariant failure. Restore the chain for success and host failure.
    ///
    /// The fence restores the caller's chain by REPLACING the register, so a
    /// handler the body installed and never consumed would otherwise vanish
    /// here without a trace. A body that completes (`Ok`) or lets a throw
    /// escape (`Threw`) must therefore leave the chain empty; anything else
    /// is refused as an engine invariant in every build profile, never
    /// discarded silently. `Threw` is produced only once
    /// [`Self::unwind_to_jump`] has popped the chain empty, so a `Threw`
    /// arriving here with handlers installed means a nested native boundary
    /// returned one verbatim through a live dispatch loop instead of
    /// re-raising it (`raise_js`), abandoning that loop's handlers — the
    /// defect this refusal exists to surface. A host halt abandons the body
    /// mid-flight, so its leftover handlers are expected and dropped with
    /// the rest of the abandoned activation.
    pub(super) fn run_guest_under_native_try<T>(
        &mut self,
        handlers: CallerHandlers,
        body: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<T, Step> {
        if matches!(handlers, CallerHandlers::Preserve) {
            return body(self);
        }
        let fenced_jumps = std::mem::take(&mut self.jumps);
        let outcome = match body(self) {
            Err(Step::Unwound(_)) => Err(Step::Host(Halt::EngineInvariant(
                "native-try:resume-escaped-fence",
            ))),
            Ok(_) | Err(Step::Threw { .. }) if !self.jumps.is_empty() => Err(Step::Host(
                Halt::EngineInvariant("native-try:handlers-left-behind"),
            )),
            outcome => outcome,
        };
        self.jumps = fenced_jumps;
        outcome
    }

    /// Catch a guest throw as a value for native rejection/iterator-close logic.
    /// Capture cleanup floors before running the operation, behind its fence.
    /// Host failures remain distinct from catchable guest completions.
    pub(super) fn native_try<T>(
        &mut self,
        body: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<Result<T, Slot>, Step> {
        self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            let stack_base = machine.stack.len();
            let call_depth = machine.call_stack.len();
            match body(machine) {
                Ok(value) => Ok(Ok(value)),
                Err(Step::Threw { value, .. }) => {
                    machine.unwind_native_try(stack_base, call_depth);
                    // The caught throw becomes an `Ok` outcome of the fenced
                    // body, so the fence's leftover-handler refusal applies
                    // to it: the chain is NOT truncated here, or a nested
                    // boundary's abandoned handlers would vanish before the
                    // fence could see them.
                    Ok(Err(value))
                }
                Err(halt) => Err(halt),
            }
        })
    }

    /// Abandon caught callee activations and reverse speculative host-escape
    /// metering. The caught value travels in Step::Threw; clear its register.
    /// The handler chain is the fence's business (see
    /// [`Self::run_guest_under_native_try`]) and is left alone.
    fn unwind_native_try(&mut self, stack_base: usize, call_depth: usize) {
        while self.call_stack.len() > call_depth {
            let _ = self.leave_call();
        }
        self.stack.truncate(stack_base);
        self.exception = Slot::undefined();
        self.unmeter_host_escape();
    }
}

#[cfg(test)]
mod tests {
    use super::{CallerHandlers, Halt, Interp, Slot, Step};
    use crate::interp::{CatchJump, ResumeTarget};

    fn handler(target_pc: usize) -> CatchJump {
        CatchJump {
            target_pc,
            segment: None,
            stack_len: 0,
            locals_len: 0,
            id_map: Default::default(),
            call_depth: 0,
            env: Slot::undefined(),
            flag: 1,
            rebased: false,
        }
    }

    /// The fence's own invariant holds in every build profile (F170): a body
    /// that completes or throws past the fence with a handler still installed
    /// is refused as an engine invariant, never silently discarded, and the
    /// caller's chain comes back intact either way.
    #[test]
    fn leftover_handlers_behind_the_fence_are_refused_in_release_too() {
        for leave_by_throw in [false, true] {
            let mut vm = Interp::new();
            vm.jumps.push(handler(123));
            let outcome = vm.run_guest_under_native_try::<()>(CallerHandlers::Isolate, |machine| {
                machine.jumps.push(handler(456));
                if leave_by_throw {
                    Err(Step::Threw {
                        value: Slot::undefined(),
                    })
                } else {
                    Ok(())
                }
            });
            assert!(
                matches!(
                    outcome,
                    Err(Step::Host(Halt::EngineInvariant(
                        "native-try:handlers-left-behind"
                    )))
                ),
                "leave_by_throw={leave_by_throw}"
            );
            assert_eq!(vm.jumps.len(), 1, "the caller's chain is restored whole");
            assert_eq!(vm.jumps[0].target_pc, 123);
        }
    }

    /// A host halt abandons the body mid-flight: its handlers are dropped
    /// with the abandoned activation and the halt propagates unchanged.
    #[test]
    fn a_host_halt_drops_the_abandoned_bodys_handlers_and_propagates() {
        let mut vm = Interp::new();
        vm.jumps.push(handler(123));
        let outcome = vm.run_guest_under_native_try::<()>(CallerHandlers::Isolate, |machine| {
            machine.jumps.push(handler(456));
            Err(Step::Host(Halt::MeterAbort))
        });
        assert!(matches!(outcome, Err(Step::Host(Halt::MeterAbort))));
        assert_eq!(vm.jumps.len(), 1);
        assert_eq!(vm.jumps[0].target_pc, 123);
    }

    /// A body that consumes every handler it installs passes the fence, and
    /// the caller's chain is exactly what it was.
    #[test]
    fn a_clean_body_passes_the_fence_with_the_caller_chain_restored() {
        let mut vm = Interp::new();
        vm.jumps.push(handler(123));
        let outcome = vm.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.jumps.push(handler(456));
            let consumed = machine.jumps.pop().expect("the body's own handler");
            Ok(consumed.target_pc)
        });
        assert!(matches!(outcome, Ok(456)));
        assert_eq!(vm.jumps.len(), 1);
        assert_eq!(vm.jumps[0].target_pc, 123);
    }

    #[test]
    fn escaped_resume_is_refused_after_restoring_the_caller_chain() {
        let mut vm = Interp::new();
        vm.jumps.push(CatchJump {
            target_pc: 123,
            segment: None,
            stack_len: 0,
            locals_len: 0,
            id_map: Default::default(),
            call_depth: 0,
            env: Slot::undefined(),
            flag: 1,
            rebased: false,
        });
        let outcome = vm.run_guest_under_native_try::<()>(CallerHandlers::Isolate, |machine| {
            assert!(machine.jumps.is_empty());
            Err(Step::Unwound(ResumeTarget {
                pc: 17,
                segment: None,
            }))
        });
        assert!(matches!(
            outcome,
            Err(Step::Host(Halt::EngineInvariant(
                "native-try:resume-escaped-fence"
            )))
        ));
        assert_eq!(vm.jumps.len(), 1);
        assert_eq!(vm.jumps[0].target_pc, 123);
    }

    #[test]
    fn preserving_caller_handlers_allows_a_cross_frame_resume() {
        let mut vm = Interp::new();
        vm.jumps.push(CatchJump {
            target_pc: 123,
            segment: None,
            stack_len: 0,
            locals_len: 0,
            id_map: Default::default(),
            call_depth: 0,
            env: Slot::undefined(),
            flag: 1,
            rebased: false,
        });
        let outcome = vm.run_guest_under_native_try::<()>(CallerHandlers::Preserve, |machine| {
            let handler = machine
                .jumps
                .pop()
                .expect("caller handler stays accessible");
            Err(Step::Unwound(ResumeTarget {
                pc: handler.target_pc,
                segment: handler.segment,
            }))
        });
        assert!(matches!(
            outcome,
            Err(Step::Unwound(ResumeTarget {
                pc: 123,
                segment: None
            }))
        ));
        assert!(
            vm.jumps.is_empty(),
            "consumed handlers must not be restored"
        );
    }
}
