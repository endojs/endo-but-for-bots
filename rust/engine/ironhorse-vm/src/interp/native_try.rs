//! Native-owned guest boundaries: handler isolation and caught-throw cleanup.
use super::{Halt, Interp, Slot, Step};

impl Interp {
    /// Isolate the caller's handlers for a native-owned guest operation.
    /// A fenced guest cannot resume a caller handler; such an escaping transfer
    /// is an invariant failure. Restore the chain for success and host failure.
    pub(super) fn run_guest_under_native_try<T>(
        &mut self,
        body: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<T, Step> {
        let fenced_jumps = std::mem::take(&mut self.jumps);
        let outcome = match body(self) {
            Err(Step::Unwound(_)) => Err(Step::Host(Halt::EngineInvariant(
                "native-try:resume-escaped-fence",
            ))),
            outcome => outcome,
        };
        debug_assert!(
            !matches!(outcome, Ok(_)) || self.jumps.is_empty(),
            "guest code left handlers behind a native try"
        );
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
        self.run_guest_under_native_try(|machine| {
            let stack_base = machine.stack.len();
            let call_depth = machine.call_stack.len();
            match body(machine) {
                Ok(value) => Ok(Ok(value)),
                Err(Step::Threw { value, .. }) => {
                    machine.unwind_native_try(stack_base, call_depth, 0);
                    Ok(Err(value))
                }
                Err(halt) => Err(halt),
            }
        })
    }

    /// Abandon caught callee activations and reverse speculative host-escape
    /// metering. The caught value travels in Step::Threw; clear its register.
    fn unwind_native_try(&mut self, stack_base: usize, call_depth: usize, jump_depth: usize) {
        while self.call_stack.len() > call_depth {
            let _ = self.leave_call();
        }
        self.stack.truncate(stack_base);
        self.jumps.truncate(jump_depth);
        self.exception = Slot::undefined();
        self.unmeter_host_escape();
    }
}

#[cfg(test)]
mod tests {
    use super::{Halt, Interp, Slot, Step};
    use crate::interp::CatchJump;

    #[test]
    fn escaped_resume_is_refused_after_restoring_the_caller_chain() {
        let mut vm = Interp::new();
        vm.jumps.push(CatchJump {
            target_pc: 123,
            stack_len: 0,
            locals_len: 0,
            id_map: Default::default(),
            call_depth: 0,
            env: Slot::undefined(),
            flag: 1,
            rebased: false,
        });
        let outcome = vm.run_guest_under_native_try::<()>(|machine| {
            assert!(machine.jumps.is_empty());
            Err(Step::Unwound(17))
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
}
