//! Exception handler unwinding and guest throw propagation.
use super::*;

impl Interp {
    /// `fxJump`: unwind to the innermost jump-buffer entry (XS's
    /// `the->firstJump`), restoring exactly what the `c_setjmp` restore in
    /// `CATCH` restores — the call frames back to the establishing frame,
    /// then that frame's value-stack and scope cuts — and returning the
    /// code segment and target pc to resume at. Returns `None` when the chain
    /// is empty (the throw escapes every JS handler and reaches the host boundary), so
    /// the caller yields `Halt::Throw`.
    pub(super) fn unwind_to_jump(&mut self) -> Option<ResumeTarget> {
        // A throw between `XS_CODE_SUPER` (which arms the pending
        // new-target for the construct about to happen) and the
        // construct frame that consumes it abandons that construct.
        // Leaving it armed would give a later constructor the stale target
        // as its `new.target`. Disarm BEFORE the
        // empty-chain return below, so the uncaught direct
        // `THROW`/`RETHROW` (and rejected-await) host escapes are
        // covered exactly like the caught path and `raise_js`.
        self.pending_new_target = None;
        let jump = self.jumps.pop()?;
        // A handler live across a suspend costs XS one extra dispatch to
        // land in (see [`RESUMED_HANDLER_THROW_METERING`]); a handler
        // pushed by a `CATCH` in this run costs nothing beyond the
        // ordinary caught-throw modeling.
        if jump.rebased {
            self.meter.tick_raw(RESUMED_HANDLER_THROW_METERING);
        }
        // Pop any callee activations opened since the catch was
        // established (a throw crossing called functions), restoring the
        // establishing frame's saved activation each time (XS restores
        // `mxFrame`). Discard the callee results — the throw abandons them.
        while self.call_stack.len() > jump.call_depth {
            let _ = self.leave_call();
        }
        // Restore the establishing frame's value-stack and scope cuts
        // (XS's `mxStack = jump->stack; mxScope = jump->scope`) and the
        // exact environment name map at catch time.
        self.stack.truncate(jump.stack_len);
        self.locals.truncate(jump.locals_len);
        self.id_map = jump.id_map;
        // Restore the environment head active at catch establishment (XS's
        // `mxEnvironment` restore from `jump->scope`), so a throw out of a
        // `with` body resets the environment for the surviving catch/finally.
        self.env = jump.env;
        let _ = jump.flag; // every ironhorse jump is a JS jump (flag == 1)
        Some(ResumeTarget {
            pc: jump.target_pc,
            segment: jump.segment,
        })
    }

    /// Raise an engine-created JavaScript value through the same jump-buffer
    /// chain as the `throw` opcode.  Native semantic failures must use this
    /// path so `try`/`catch`/`finally` can observe the realm-correct Error
    /// object instead of seeing an uncatchable host-side `Unsupported` halt.
    ///
    /// The result is always a control transfer for the enclosing dispatch
    /// loop to consume: `Step::Unwound(target)` when a handler caught the
    /// value (the loop that OWNS the handler's frame resumes there, which
    /// `dispatch_halt!`'s depth and buffer tests decide), or `Halt::Throw` when the
    /// chain is empty and the throw escapes to the host. Yielding the caught
    /// case as `Resume` rather than a bare `Ok(target)` is what makes the
    /// depth test unskippable: a raise site cannot assign the target to its
    /// own `pc` without going through the macro.
    pub(super) fn raise_js(&mut self, value: Slot) -> Step {
        self.exception = value;
        match self.unwind_to_jump() {
            Some(target) => Step::Unwound(target),
            None => {
                // Uncaught: the host-escape leaves the machine
                // post-throw ([`Self::unwind_to_jump`] disarmed the
                // pending new-target for every escape path). The
                // value travels through native catches without rendering;
                // only finish_step renders an uncaught host escape.
                self.meter_host_escape();
                Step::Threw { value }
            }
        }
    }

    /// Raise a realm-local TypeError carrying a diagnostic message. Existing
    /// oracle-pinned messages remain verbatim; profile-specific guards supply
    /// descriptive diagnostics even where XS has no corresponding refusal.
    pub(super) fn catchable_type_error_msg(&mut self, message: String) -> Step {
        let error = self.internal_error("TypeError", message);
        self.raise_js(error)
    }

    /// Raise a realm-local, catchable `SyntaxError` from a native helper —
    /// the shape `new RegExp(badPattern)` throws (`fxThrowMessage` with
    /// `XS_SYNTAX_ERROR`). Like [`Self::catchable_type_error_msg`], `try`/`catch`
    /// observes a realm-correct `SyntaxError` object (so `instanceof
    /// SyntaxError` and `assert.throws(SyntaxError, …)` hold) rather than an
    /// uncatchable host `Unsupported` halt.
    pub(super) fn catchable_syntax_error(&mut self) -> Step {
        let error = self.build_error("SyntaxError", 0, 0);
        self.raise_js(error)
    }

    /// As [`Self::catchable_syntax_error`], but carrying XS's parser diagnostic
    /// text so the thrown `SyntaxError` renders `SyntaxError: <message>` — the
    /// pinned oracle's exact `String(exception)` for an early error the source
    /// bridge (eval / dynamic `Function`) rejects. An empty message falls back
    /// to the bare form.
    pub(super) fn catchable_syntax_error_with_message(&mut self, message: String) -> Step {
        if message.is_empty() {
            return self.catchable_syntax_error();
        }
        let error = self.internal_error("SyntaxError", message);
        self.raise_js(error)
    }
}
