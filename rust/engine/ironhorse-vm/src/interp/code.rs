//! Retained bytecode segments and dispatch-buffer ownership.
use super::*;

impl Interp {
    /// The persisted bytecode buffer for `segment` (`None` ⇒ the top-level
    /// program). Returns an owned [`std::rc::Rc`] handle so the caller can
    /// dispatch over it without holding a borrow of `&mut self`.
    pub(super) fn segment_buffer(&self, segment: Option<usize>) -> Option<std::rc::Rc<[u8]>> {
        match segment {
            Some(seg) => self.code_segments.get(seg).cloned(),
            None => self.top_level_code.clone(),
        }
    }

    /// Ensure the currently executing buffer has an owned segment.
    ///
    /// Eval/dynamic-Function dispatch installs its segment before entering.
    /// A top-level crank stays segment-free until its first function body is
    /// defined, then promotes the `top_level_code` buffer already shared with the
    /// machine. This is the crank-code retention half of cross-crank calls.
    pub(super) fn ensure_active_code_segment(&mut self, code: &[u8]) -> usize {
        if let Some(segment) = self.active_segment {
            return segment;
        }
        let segment = self.code_segments.len();
        let buffer = self
            .top_level_code
            .clone()
            .unwrap_or_else(|| std::rc::Rc::from(code));
        self.code_segments.push(buffer);
        self.active_segment = Some(segment);
        segment
    }

    /// A dispatch may consume a handler only when it borrows that handler's
    /// buffer. The depth guard alone cannot distinguish nested code buffers.
    pub(super) fn resume_target_belongs_to(&self, target: ResumeTarget, code: &[u8]) -> bool {
        let buffer = match target.segment {
            Some(segment) => self.code_segments.get(segment),
            None => self.top_level_code.as_ref(),
        };
        buffer.is_some_and(|buffer| std::ptr::eq(buffer.as_ref(), code))
    }

    /// Check the immutable buffer borrowed by the landing dispatch. Native
    /// wrappers can restore `active_segment`, and top-level promotion can turn
    /// an earlier `None` identity into `Some`, without changing that buffer.
    pub(super) fn assert_resume_target(&self, target: ResumeTarget, code: &[u8]) {
        debug_assert!(
            self.resume_target_belongs_to(target, code),
            "catch target belongs to another dispatch buffer"
        );
        debug_assert!(target.pc < code.len(), "catch target is outside its buffer");
    }

    /// The code segment a callee function's body lives in, and whether it
    /// differs from the segment the current dispatch loop runs over — i.e.
    /// whether entering it needs a cross-segment nested dispatch rather than
    /// an in-loop `enter_call`. Cheap and allocation-free; the whole check is
    /// gated by the caller on [`Self::func_segments`] being non-empty, so a
    /// program that never evals never reaches it.
    #[inline]
    pub(super) fn callee_segment(&self, f: crate::value::SlotIndex) -> Option<usize> {
        self.func_segments.get(&f).copied()
    }

    /// For the ordinary user-function call arm (`XS_CODE_RUN`): peek the callee
    /// on the value stack and, if its body lives in a different segment than
    /// this loop's buffer, return `Some(callee_segment)` to route it through a
    /// cross-segment dispatch. Returns `None` (stay in-loop) in the common
    /// same-segment case, and immediately when no retained function exists.
    ///
    /// The fast-path guard is `code_segments` empty (no function has retained
    /// a defining buffer):
    /// only then is every callee guaranteed same-segment. Once an eval has
    /// run, the check is needed both ways — the top-level program calling an
    /// eval-defined function, and (while dispatching an eval segment) that
    /// unit calling back into a top-level function.
    #[inline]
    pub(super) fn cross_segment_callee(&self, argc: usize) -> Option<Option<usize>> {
        if self.code_segments.is_empty() {
            return None;
        }
        let base = self.stack.len().checked_sub(argc + 4)?;
        let f = match self.stack.get(base + 1).map(|slot| slot.value) {
            Some(Payload::Reference(f)) => f,
            _ => return None,
        };
        // Only a user function has a body segment to dispatch over. A
        // non-callable reference (a plain object, an array) is not a
        // cross-segment callee: it stays in-loop, where `enter_call` raises
        // the catchable `TypeError` `Call` requires.
        if !self.functions.contains_key(&f) {
            return None;
        }
        let seg = self.callee_segment(f);
        (seg != self.active_segment).then_some(seg)
    }

    /// Enter a user function whose body lives in a **different** code segment
    /// than the current dispatch loop (an eval-defined function called from
    /// the top-level program or another unit, or a top-level function called
    /// back from an eval). The call args are already on the value stack in
    /// frame geometry; this enters the callee frame, dispatches over the
    /// callee's own buffer until its `END` returns to this depth, and yields
    /// the completion — the same nested-dispatch shape as [`Self::run_callback`],
    /// keeping each dispatch loop over a single buffer. Restores the active
    /// segment afterward.
    pub(super) fn call_cross_segment(
        &mut self,
        argc: usize,
        has_target: bool,
        callee_segment: Option<usize>,
    ) -> Result<Slot, Step> {
        let body_start = self.enter_call(argc, 0, has_target)?;
        self.dispatch_entered_cross_segment(body_start, callee_segment)
    }

    /// Dispatch a frame that has already been entered over its retained
    /// segment. Shared by ordinary and bound cross-crank calls.
    pub(super) fn dispatch_entered_cross_segment(
        &mut self,
        body_start: usize,
        callee_segment: Option<usize>,
    ) -> Result<Slot, Step> {
        let buf = match self.segment_buffer(callee_segment) {
            Some(buf) => buf,
            None => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "function:missing-segment",
                )))
            }
        };
        let return_depth = self.call_stack.len();
        let saved_segment = self.active_segment;
        self.active_segment = callee_segment;
        let outcome = self.dispatch_at(&buf[..], body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            // A caller's handler travels outward as Step::Unwound; only
            // this activation's normal return supplies a call result.
            Step::Returned => self.pop_checked(),
            other => Err(other),
        }
    }
}
