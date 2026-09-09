//! Shared activation capture and reinstallation for yield/await drivers.
use super::{CatchJump, Halt, Interp, SavedFrame, SavedJump, GENERATOR_YIELD_METERING};

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
        self.env = saved.env;
        self.cur_func = saved.cur_func;
        self.cur_target = saved.cur_target;
        self.target_func = saved.target_func;
        self.strict = saved.strict;
        self.result = saved.result;
        self.stack.extend(saved.stack_slice);
        self.jumps
            .extend(saved.jumps.into_iter().map(|jump| CatchJump {
                target_pc: jump.target_pc,
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
