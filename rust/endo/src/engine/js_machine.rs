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
//! Evaluation and lifecycle. Those are the concerns where both engines do the
//! same job under different names, and they are what the daemon calls: a
//! survey of `rust/endo/src` finds `evaluate`/`eval` dominating, with
//! `collect` and `epoch` appearing twice each.
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
    /// The program ran and did not complete normally: a throw, a resource
    /// stop, an engine fault. Which one is in the source error.
    Halt,
    /// This engine does not serve this verb. The detail names it.
    ///
    /// An explicit, typed gap rather than an absent method, which is what
    /// F068 asked for: "leaving the verbs it cannot yet serve as explicit
    /// `Err(Unavailable)` so the gap stays named and typed rather than
    /// absent".
    Unavailable,
    /// Anything else the engine reports — a store refusal, a relink failure.
    Engine,
}

/// A [`JsMachine`] verb's failure.
#[derive(Debug)]
pub struct JsMachineError {
    kind: JsMachineErrorKind,
    detail: String,
    source: Option<Box<dyn std::error::Error + 'static>>,
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
        source: impl std::error::Error + 'static,
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
        self.source.as_deref()
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
    /// An engine that drains as part of [`Self::eval`] answers `Ok(())`: the
    /// queue is empty, which is what the caller asked for, and reporting
    /// `Unavailable` for a postcondition already met would be wrong.
    fn drain_jobs(&mut self) -> Result<(), JsMachineError>;

    /// Reclaim unreachable objects.
    ///
    /// `Err(Unavailable)` from an engine with no collector reachable at this
    /// seam, which is a typed gap rather than a silent success.
    fn collect_garbage(&mut self) -> Result<(), JsMachineError>;
}

/// The xsnap implementation, which changes no behaviour: every method below is
/// the existing call with its answer re-spelled.
///
/// Two honest losses, both xsnap's rather than the trait's.
///
/// **It cannot say why.** `Machine::eval` answers `Option`, so a failed
/// evaluation cannot distinguish a source that did not compile from a program
/// that threw. It arrives as [`JsMachineErrorKind::Halt`] with a detail saying
/// the distinction is unavailable, rather than as a `Compile` guess.
///
/// **In practice it cannot fail at all.** `Machine::eval`'s own documentation
/// says it "Returns `None` if the evaluation throws". It does not: it installs
/// no outermost `txJump`, so an XS throw longjmps past a frame Rust no longer
/// owns and the process takes SIGSEGV. `throw new Error('boom')` crashes,
/// under this trait or without it. That is a pre-existing defect in the FFI
/// wrapper, not something this extraction introduced or can fix — the fix is a
/// `c_setjmp` guard of the shape `fxRunPromiseJobsMetered` already uses in
/// `xsnap/xsnap-platform.c`, which is a change to the XS glue and belongs in
/// its own review. `xsnap::Machine::eval` had no caller outside `#[cfg(test)]`
/// before this impl, which is why nothing had met it.
///
/// So: the `Err` arm below is correct, and reachable only for an evaluation
/// that fails WITHOUT throwing. `ignored_a_guest_throw_through_xsnap_segfaults`
/// in `tests/js_machine_trait.rs` pins the defect and is `#[ignore]`d because
/// running it kills the test binary.
impl JsMachine for xsnap::Machine {
    fn eval(&mut self, source: &str) -> Result<String, JsMachineError> {
        xsnap::Machine::eval_to_string(self, source).ok_or_else(|| {
            JsMachineError::new(
                JsMachineErrorKind::Halt,
                "xsnap: evaluation failed (xsnap does not report whether the \
                 source failed to compile or the program threw)",
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
}

#[cfg(feature = "ironhorse-engine")]
mod ironhorse {
    use super::{JsMachine, JsMachineError, JsMachineErrorKind};
    use crate::ironhorse_engine::engine::{Machine, MachineError, PersistentMachine};

    /// Every `MachineError` keeps its own identity under the coarse kind.
    fn classify(error: MachineError) -> JsMachineError {
        let kind = match &error {
            MachineError::Compile { .. } => JsMachineErrorKind::Compile,
            MachineError::Halt(_) => JsMachineErrorKind::Halt,
            MachineError::Unavailable(_) => JsMachineErrorKind::Unavailable,
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
            // The VM drains its job queue inside the crank and reports
            // `completed` only once it is empty, so there is nothing left to
            // pump and the postcondition holds.
            Ok(())
        }

        fn collect_garbage(&mut self) -> Result<(), JsMachineError> {
            // A typed gap, not a silent no-op: collection is a
            // `PersistentMachine` verb, and the stateless facade has no
            // reachable collector. This is the shape F068 asked for.
            Err(JsMachineError::unavailable("collect_garbage"))
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
    }
}
