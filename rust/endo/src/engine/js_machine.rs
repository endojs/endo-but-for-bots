//! `JsMachine`: the slice of a JavaScript machine the daemon actually drives
//! (architecture finding F068).
//!
//! `rust/endo` runs two unrelated machine types with nothing in common:
//! `xsnap::Machine` behind FFI, and `ironhorse_engine::Machine` /
//! `PersistentMachine`. F068's point is not that an abstraction is missing for
//! its own sake — it is that **the retrofit cost grows with every call site
//! written against a concrete type**, and that extracting the trait and
//! implementing it for `xsnap::Machine` first is the cheap part that caps that
//! cost.
//!
//! ## What this covers, and why only this
//!
//! Evaluation and lifecycle: the concerns where both engines do the same job
//! under different names, per
//! `designs/ironhorse-engine-trait-research.md`'s recommendation.
//!
//! **Not** from a census of what the daemon calls, because there is nothing to
//! count. Every machine-verb call site in `rust/endo/src` is either inside
//! `#[cfg(test)]` (`inproc.rs:292` onward, `ironhorse_engine.rs:1732` onward)
//! or inside the engine module calling itself. The number of concrete call
//! sites this extraction retrofits is **zero**, and an earlier version of this
//! paragraph cited those test-only counts as if they were the daemon's.
//!
//! That cuts both ways and the honest reading is the unflattering one: F068's
//! stated impact — "the retrofit cost grows with each new call site written
//! against the concrete `xsnap::Machine`" — was not actually accruing inside
//! `rust/endo/src`. What this buys is a shape for the call sites that do not
//! exist yet, and two design decisions (`Err(Unavailable)` for a gap, the
//! engine's own error preserved for a downcast) that would otherwise be made
//! ad hoc at the first one. It caps a cost rather than paying one down.
//!
//! The one genuine production consumer of `xsnap::Machine::eval` lives in
//! another crate — `xsnap/src/archive.rs`'s `install_archive`, six calls — and
//! is **not** retrofitted. It wants `Option`-shaped fail-fast and it sits
//! below this trait, not above it.
//!
//! Deliberately absent, following
//! `designs/ironhorse-engine-trait-research.md`:
//!
//! * **Metering.** xsnap models it as something the host drives around a call
//!   (`begin_metering`/`end_metering`); IronHorse models it as an invariant the
//!   machine holds, set at construction through `MeterBounds`. Putting xsnap's
//!   shape in a trait would export the fail-open seam F014/F020 argued against
//!   and IronHorse has already left.
//! * **Persistence.** xsnap produces a byte blob and reconstructs a machine
//!   from it, across four transports. An IronHorse `PersistentMachine` is
//!   *continuously* backed by a heap store and has no blob to hand around.
//!   These are two designs, not two spellings, and a trait over both would be
//!   fiction.
//! * **Host integration.** `define_function`, `register_powers`,
//!   `import_archive` and friends exist on xsnap and **nowhere** in IronHorse,
//!   which is F054's open half rather than a naming difference.
//!
//! ## The three shapes, settled
//!
//! 1. `Result<_, JsMachineError>` rather than `Option`. xsnap answers `Option`
//!    and IronHorse answers a structured `MachineError`; picking `Option` would
//!    discard that taxonomy, which is F157 committed a second time.
//!    [`JsMachineError::source`] carries the engine's own error, so nothing is
//!    thrown away — a caller that wants `MachineError` downcasts to it.
//! 2. `&mut self`. `PersistentMachine::eval` needs it because a crank
//!    checkpoints; xsnap satisfies it trivially, and the reverse is not true.
//! 3. Metering out, as above.
//!
//! ## What is still open, and this does not pretend otherwise
//!
//! F068's third clause — add `Engine::Ironhorse` and select it in
//! [`super::engine_for_spawn_request`] from the spawn payload — is NOT done.
//! That enum answers "how is a peer started", and an `Ironhorse` variant means
//! an IronHorse worker that speaks the daemon's transport. There is no such
//! worker: the protocol is the seam the W6 decision named as a trigger, and it
//! has not landed. Adding the variant now would be a spawn path that fails at
//! runtime, which is worse than its absence.
//!
//! This also reopens **W6 decision 2**, which deferred the extraction. See
//! `designs/ironhorse-w6-decisions.md` for the reopening and its reasons.

use std::fmt;

/// Why a [`JsMachine`] verb did not produce its result.
///
/// Coarse on purpose: four kinds a caller can branch on, with the engine's own
/// error preserved underneath. The kinds are what every engine can answer; the
/// [`std::error::Error::source`] is where the engine's own taxonomy lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsMachineErrorKind {
    /// The source did not compile.
    Compile,
    /// The program ran and did not complete normally: a guest throw or a
    /// resource stop (a metered refusal, a heap ceiling). Which one is in the
    /// source error.
    Halt,
    /// This engine does not serve what was asked. The detail names it.
    ///
    /// Three things land here and they are the same thing from the caller's
    /// side — "this engine cannot do that, and it is not your program's
    /// fault": a verb the engine has no implementation for, an
    /// `ironhorse_engine::MachineError::Unavailable` (a surface not built
    /// yet), and a `Halt::NotImplemented`/`Halt::Refused` (a named, unlanded
    /// engine gap or a profile refusal). The first version sent the last of
    /// those to [`Self::Halt`], which read as "your program did something",
    /// and it did not.
    ///
    /// An explicit, typed gap rather than an absent method, which is what
    /// F068 asked for: "leaving the verbs it cannot yet serve as explicit
    /// `Err(Unavailable)` so the gap stays named and typed rather than
    /// absent".
    Unavailable,
    /// Anything else the engine reports: a store refusal, a relink failure, a
    /// poisoned machine, a lost session.
    ///
    /// **This bucket does NOT tell a caller whether the machine survived.**
    /// `MachineError::CollectionPanicked` says the machine is quiescent and
    /// usable; `Poisoned` says tear it down and open a fresh one; `SessionLost`
    /// says it is unusable for good. All three arrive here. A caller that must
    /// branch on that downcasts [`std::error::Error::source`] to
    /// `MachineError` and asks it — the taxonomy is carried precisely so it
    /// can. Widening the kinds until they answered every such question would
    /// make this enum a second, drifting copy of an engine-specific one.
    Engine,
}

/// A [`JsMachine`] verb's failure.
#[derive(Debug)]
pub struct JsMachineError {
    kind: JsMachineErrorKind,
    detail: String,
    source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
}

impl JsMachineError {
    /// A failure with no engine error under it.
    pub fn new(kind: JsMachineErrorKind, detail: impl Into<String>) -> JsMachineError {
        JsMachineError {
            kind,
            detail: detail.into(),
            source: None,
        }
    }

    /// A failure carrying the engine's own error, which a caller may downcast
    /// through [`std::error::Error::source`].
    pub fn with_source(
        kind: JsMachineErrorKind,
        detail: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> JsMachineError {
        JsMachineError {
            kind,
            detail: detail.into(),
            source: Some(Box::new(source)),
        }
    }

    /// A verb this engine does not serve, named.
    pub fn unavailable(verb: &str) -> JsMachineError {
        JsMachineError::new(
            JsMachineErrorKind::Unavailable,
            format!("this engine does not serve `{verb}`"),
        )
    }

    /// The coarse class, for a caller that branches rather than reports.
    pub fn kind(&self) -> JsMachineErrorKind {
        self.kind
    }

    /// The human-readable detail.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for JsMachineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.detail)
    }
}

impl std::error::Error for JsMachineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|e| e as &(dyn std::error::Error + 'static))
    }
}

/// The JavaScript machine verbs `rust/endo` drives.
///
/// Three verbs, and the number is the point: a trait this size can be
/// implemented by both engines without either inventing anything, and every
/// call site written against it is one that does not have to be found again
/// when a second engine ships. See the module documentation for what is
/// excluded and why.
pub trait JsMachine {
    /// Evaluate `source` and render its completion value as a string.
    ///
    /// `&mut self` because a `PersistentMachine` crank checkpoints. Engines
    /// that do not need it ignore it.
    fn eval(&mut self, source: &str) -> Result<String, JsMachineError>;

    /// Drain the microtask queue.
    ///
    /// The postcondition is **the queue is empty**, not "a pump was called".
    /// An engine that drains as part of [`Self::eval`] may answer `Ok(())`
    /// only where that postcondition is already met; where it is not, and the
    /// engine cannot pump at this seam, the honest answer is
    /// `Err(Unavailable)`.
    ///
    /// The distinction is not academic. The first version of this trait
    /// returned a bare `Ok(())` for both IronHorse types on the argument that
    /// "a crank drains its own job queue". That is true of a crank that
    /// COMPLETES: `Interp::run` pumps only on `Step::Returned`, and a metered
    /// refusal can abandon the queue mid-drain. After a halted or refused
    /// `Machine::eval`, jobs really are still queued, and `Ok(())` was a lie
    /// with a comment explaining why it was not.
    fn drain_jobs(&mut self) -> Result<(), JsMachineError>;

    /// Reclaim unreachable objects.
    ///
    /// `Err(Unavailable)` from an engine with no collector reachable at this
    /// seam, which is a typed gap rather than a silent success.
    fn collect_garbage(&mut self) -> Result<(), JsMachineError>;

    /// Release the machine, flushing whatever it owes.
    ///
    /// `self: Box<Self>` rather than `self`, which is what makes it callable
    /// through `Box<dyn JsMachine>`. Without it the trait could hold a
    /// `PersistentMachine` and never release one: `PersistentMachine::close`
    /// consumes by value, so a boxed machine would be dropped instead — losing
    /// the final flush and the `StoreLeakedAtClose` detection that close
    /// performs. An engine with nothing to flush answers `Ok(())`.
    fn close(self: Box<Self>) -> Result<(), JsMachineError>;
}

/// The xsnap implementation, which changes no behaviour: every method below is
/// the existing call with its answer re-spelled.
///
/// **`Machine::eval` cannot report a failed evaluation at all: it crashes.**
/// Its own documentation says it "Returns `None` if the evaluation throws". It
/// does not. `fxBeginHost` installs no outermost `txJump`, so anything that
/// unwinds inside XS longjmps past a frame Rust no longer owns and the process
/// takes SIGSEGV. Measured, each in its own process: a guest `throw`, a SYNTAX
/// ERROR (`var = ;`) and a `ReferenceError` all crash. Only a source carrying
/// an interior NUL comes back `None` — and that fails in `CString::new`,
/// before any JS runs.
///
/// So the two `Err` arms below are the only reachable ones, and they are
/// classified for what they actually are rather than for what a failed
/// evaluation would be: an interior NUL is a source this engine cannot be
/// handed (`Compile`), and a null host frame is an engine fault (`Engine`).
/// The first version of this impl answered [`JsMachineErrorKind::Halt`] — "the
/// program ran and did not complete normally" — for both, which is wrong in
/// 100% of reachable cases, because the program never runs.
///
/// **This is not new and was not found here.** `xsnap/src/archive.rs`'s
/// `install_archive` calls `Machine::eval` six times in production, and the
/// comment above them already names the crash: "a throw that unwinds out of an
/// eval into the host frame crashes XS, and a ReferenceError in the program
/// being run must surface as a clean failure, not a SIGSEGV". Its workaround
/// is `eval_wrapped`, which inlines the source into a `try`/`catch` and
/// returns a bool.
///
/// **Why this impl does not use `eval_wrapped`.** Wrapping is not
/// semantics-preserving: a `function` declaration inside a `try` block does
/// not hoist to global scope, which is why `install_archive` leaves its first
/// four evals unwrapped and wraps only the ones that run user code. A
/// `JsMachine::eval` that silently changed declaration hoisting would be a
/// wrong answer where there is currently a crash, and `eval_wrapped` returns
/// no completion value. The real fix is a `c_setjmp` guard of the shape
/// `fxRunPromiseJobsMetered` uses in `xsnap/xsnap-platform.c` — with the
/// caveat that that function lives under `#ifdef mxMetering` and restores from
/// `exitStatus` rather than rendering a thrown value, so it is a template and
/// not a copy. That is XS-glue work with its own review.
///
/// `a_failing_eval_through_xsnap_segfaults` in `tests/js_machine_trait.rs`
/// pins the defect across all three shapes and is `#[ignore]`d because running
/// it kills the test binary.
impl JsMachine for xsnap::Machine {
    fn eval(&mut self, source: &str) -> Result<String, JsMachineError> {
        // Checked here so the two reachable failures can be told apart. XS
        // takes a C string, so a source carrying an interior NUL is one this
        // engine cannot be handed — a fact about the source.
        if source.as_bytes().contains(&0) {
            return Err(JsMachineError::new(
                JsMachineErrorKind::Compile,
                "xsnap: the source carries an interior NUL and cannot be \
                 passed to an engine that takes a C string",
            ));
        }
        xsnap::Machine::eval_to_string(self, source).ok_or_else(|| {
            JsMachineError::new(
                JsMachineErrorKind::Engine,
                "xsnap: the host frame could not be entered. A failed \
                 EVALUATION does not reach here — it crashes the process; see \
                 this impl's documentation.",
            )
        })
    }

    fn drain_jobs(&mut self) -> Result<(), JsMachineError> {
        xsnap::Machine::run_promise_jobs(self);
        Ok(())
    }

    fn collect_garbage(&mut self) -> Result<(), JsMachineError> {
        xsnap::Machine::collect_garbage(self);
        Ok(())
    }

    fn close(self: Box<Self>) -> Result<(), JsMachineError> {
        // An xsnap machine owes nothing at release: `Drop` frees the XS
        // machine, and there is no store behind it to flush.
        Ok(())
    }
}

#[cfg(feature = "ironhorse-engine")]
mod ironhorse {
    use super::{JsMachine, JsMachineError, JsMachineErrorKind};
    use crate::ironhorse_engine::engine::{Halt, Machine, MachineError, PersistentMachine};

    /// Every `MachineError` keeps its own identity under the coarse kind.
    ///
    /// Three of these arms exist because the obvious mapping was wrong:
    ///
    /// * `MeterAbort` is a RESOURCE STOP, which is what
    ///   [`JsMachineErrorKind::Halt`] says it covers. It used to fall to the
    ///   `_` arm and arrive as `Engine`, in the same bucket as a relink
    ///   failure — and it is the one variant `MachineError`'s own comment
    ///   singles out as "distinct from every other halt because it is the one
    ///   a supervisor budgets for". Worse, the same refusal took two different
    ///   kinds depending on whether a limit was attached
    ///   (`MachineError::MeterAbort {..}` vs `Halt(Halt::MeterAbort)`).
    /// * `Halt::NotImplemented` and `Halt::Refused` are engine gaps and
    ///   profile refusals, not things the program did. They belong with
    ///   `MachineError::Unavailable`, which is the same statement from the
    ///   other of IronHorse's two "not built yet" channels.
    /// * `Halt::Decode` is malformed bytecode, which is an engine-side fault
    ///   rather than a guest one, so it goes to `Engine`.
    fn classify(error: MachineError) -> JsMachineError {
        let kind = match &error {
            MachineError::Compile { .. } => JsMachineErrorKind::Compile,
            MachineError::MeterAbort { .. } => JsMachineErrorKind::Halt,
            MachineError::Unavailable(_) => JsMachineErrorKind::Unavailable,
            MachineError::Halt(halt) => match halt {
                Halt::NotImplemented(_) | Halt::Refused(_) => JsMachineErrorKind::Unavailable,
                Halt::Decode(_) => JsMachineErrorKind::Engine,
                _ => JsMachineErrorKind::Halt,
            },
            _ => JsMachineErrorKind::Engine,
        };
        let detail = error.to_string();
        JsMachineError::with_source(kind, detail, error)
    }

    /// The stateless facade.
    ///
    /// `eval` takes `&self` here and `&mut self` on the trait, which is the
    /// direction that works: the trait's signature is the one
    /// `PersistentMachine` needs, and an engine that needs less can always
    /// satisfy it.
    impl JsMachine for Machine {
        fn eval(&mut self, source: &str) -> Result<String, JsMachineError> {
            Machine::eval(self, source).map_err(classify)
        }

        fn drain_jobs(&mut self) -> Result<(), JsMachineError> {
            // ASKED, not assumed. A completed crank drains its own queue, so
            // the common answer is `Ok(())` — but `Interp::run` pumps only on
            // `Step::Returned`, and `drain_promise_jobs` can abandon the rest
            // of the queue on a metered refusal, so after a halted or refused
            // `eval` there really are jobs left. This facade cannot pump them:
            // the only reachable pump at this seam is the raw, UNMETERED
            // `Interp::run_promise_jobs`, and reaching for it here would open
            // exactly the fail-open metering seam F014/F020 closed. It also
            // could not help — the next `evaluate` discards the queue anyway.
            //
            // So when the postcondition does not hold, say so. Returning
            // `Ok(())` regardless is what this did first, under a comment
            // asserting the postcondition it was violating.
            let pending = self
                .vm_machine()
                .with_persistence(|interp| interp.has_pending_jobs())
                .map_err(|halt| {
                    JsMachineError::new(
                        JsMachineErrorKind::Engine,
                        format!("the machine is already executing: {halt:?}"),
                    )
                })?;
            if pending {
                return Err(JsMachineError::new(
                    JsMachineErrorKind::Unavailable,
                    "`drain_jobs`: jobs are queued behind a crank that did not \
                     complete, and this facade has no metered pump to run them \
                     with. The next evaluation discards them.",
                ));
            }
            Ok(())
        }

        fn collect_garbage(&mut self) -> Result<(), JsMachineError> {
            // A typed gap, not a silent no-op: collection is a
            // `PersistentMachine` verb, and the stateless facade has no
            // reachable collector. This is the shape F068 asked for.
            Err(JsMachineError::unavailable("collect_garbage"))
        }

        fn close(self: Box<Self>) -> Result<(), JsMachineError> {
            // Nothing is owed: a stateless facade has no store behind it.
            Ok(())
        }
    }

    /// The store-backed machine.
    impl JsMachine for PersistentMachine {
        fn eval(&mut self, source: &str) -> Result<String, JsMachineError> {
            PersistentMachine::eval(self, source)
                .map(|outcome| outcome.result)
                .map_err(classify)
        }

        fn drain_jobs(&mut self) -> Result<(), JsMachineError> {
            // `Ok(())` unconditionally, and here the postcondition holds where
            // it does not for the stateless facade above: a
            // `PersistentMachine` crank that halts or is refused REWINDS to
            // the last checkpoint rather than returning with the queue
            // half-drained, so there is no window in which a failed `eval`
            // leaves jobs behind.
            // `a_failed_persistent_crank_leaves_no_jobs_behind` in
            // `tests/js_machine_trait.rs` is that claim as a test, because the
            // stateless facade is the proof that it cannot simply be assumed.
            Ok(())
        }

        fn collect_garbage(&mut self) -> Result<(), JsMachineError> {
            // The reclaimed count is dropped, not lost: `collect` is still
            // there for a caller that wants it. The trait answers the
            // question both engines can answer.
            PersistentMachine::collect(self)
                .map(|_| ())
                .map_err(classify)
        }

        fn close(self: Box<Self>) -> Result<(), JsMachineError> {
            // The one impl that owes something: the final flush, and the
            // `StoreLeakedAtClose` detection that only `close` performs.
            PersistentMachine::close(*self).map_err(classify)
        }
    }
}
