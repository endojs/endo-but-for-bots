//! The supervisor-visible outcome of a worker run.
//!
//! Design `designs/ironhorse-panic.md` § Architectural Boundary: the engine
//! and its adapter classify how execution ended; the supervisor reads only
//! the three-way outcome and decides what becomes durable. For the live C-XS
//! worker, this module is that adapter: it maps the `fxAbort` exits
//! (`XsnapError::Aborted`) together with the FFI guard's
//! `XsnapError::Panicked` to one `Panicked` arm, so the supervisor never
//! reconstructs the classification from error variants or exit codes.
//!
//! [`WorkerOutcome::from_xs_run`] is the only C-XS classifier. With the
//! `ironhorse-engine` feature, `From<ExecutionOutcome>` joins the Ironhorse
//! `Machine`-seam outcome onto the same arms. That Ironhorse worker is not on
//! the delivery path yet (roadmap stage 8/9, `designs/ironhorse-engine.md`
//! § Integration dependency), so only the C-XS adapter has a live consumer.

use xsnap::{XsAbort, XsnapError};

/// How one worker run ended, as the supervisor sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerOutcome {
    /// The run returned normally: the worker shut down, suspended, or lost
    /// its transport without an abort. Nothing is claimed about commit.
    Quiesced,
    /// A guest-level error escaped every handler. Catchable in principle,
    /// so not a panic, but the crank is still discarded and the worker is
    /// terminated (design § Uncaught throws versus rejected deliveries).
    Uncaught(String),
    /// The run terminated uncatchably, or failed closed. The supervisor
    /// branches on this arm, never on the reason's shape.
    Panicked(PanicReason),
}

/// Why a run landed in [`WorkerOutcome::Panicked`], kept for diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub enum PanicReason {
    /// A C-XS `fxAbort` exit, with the crank's meter reading.
    Abort { abort: XsAbort, computrons: u64 },
    /// A Rust panic caught by the FFI guard or the run-entry net.
    EngineFault {
        message: String,
        location: Option<String>,
    },
    /// Not a panic: the worker could not start or run (machine init, I/O,
    /// archive, bootstrap), or reported an unrecognized error or abort
    /// status. Fails closed so the crank is discarded.
    Refused(String),
    /// The Ironhorse `Machine` seam's reason, payload intact.
    #[cfg(feature = "ironhorse-engine")]
    Halt(crate::ironhorse_engine::engine::Halt),
}

impl PanicReason {
    /// Whether this reason is a member of the formal panic category, as
    /// opposed to a fail-closed refusal that shares the `Panicked` arm.
    pub fn is_panic(&self) -> bool {
        match self {
            PanicReason::Abort { abort, .. } => abort.is_panic(),
            PanicReason::EngineFault { .. } => true,
            PanicReason::Refused(_) => false,
            #[cfg(feature = "ironhorse-engine")]
            PanicReason::Halt(halt) => halt.is_panic(),
        }
    }
}

impl std::fmt::Display for PanicReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PanicReason::Abort { abort, computrons } => {
                write!(f, "{abort} (used {computrons} computrons)")
            }
            PanicReason::EngineFault { message, location } => match location {
                Some(location) => write!(f, "engine fault at {location}: {message}"),
                None => write!(f, "engine fault: {message}"),
            },
            PanicReason::Refused(message) => write!(f, "refused: {message}"),
            #[cfg(feature = "ironhorse-engine")]
            PanicReason::Halt(halt) => {
                f.write_str(&crate::ironhorse_engine::engine::describe_halt(halt))
            }
        }
    }
}

/// What the supervisor does with the crank and the worker for an outcome
/// (design § Architectural Boundary, step 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrankDisposition {
    /// Commit the crank and release its effects.
    Commit,
    /// Discard the crank and its embargoed effects; terminate the worker.
    DiscardAndTerminate,
    /// Discard and terminate, then apply the terminate/restore/replay
    /// policy: the crank is retryable.
    DiscardAndRecover,
}

impl WorkerOutcome {
    /// Classify the result of a C-XS worker run
    /// (`xsnap::run_xs_worker_inproc` and siblings).
    pub fn from_xs_run(result: &Result<(), XsnapError>) -> WorkerOutcome {
        let error = match result {
            Ok(()) => return WorkerOutcome::Quiesced,
            Err(error) => error,
        };
        match error {
            XsnapError::Aborted { abort, computrons } => match abort {
                XsAbort::UnhandledException | XsAbort::UnhandledRejection => {
                    WorkerOutcome::Uncaught(abort.to_string())
                }
                XsAbort::StackOverflow
                | XsAbort::NativeStackOverflow
                | XsAbort::MeterAbort
                | XsAbort::OutOfMemory
                | XsAbort::NoMoreKeys
                | XsAbort::Unknown(_) => WorkerOutcome::Panicked(PanicReason::Abort {
                    abort: *abort,
                    computrons: *computrons,
                }),
            },
            XsnapError::Panicked { message, location } => {
                WorkerOutcome::Panicked(PanicReason::EngineFault {
                    message: message.clone(),
                    location: location.clone(),
                })
            }
            // Startup failures and any future variant fail closed.
            other => WorkerOutcome::Panicked(PanicReason::Refused(other.to_string())),
        }
    }

    /// The supervisor's crank decision for this outcome. Only a genuine
    /// panic enters recovery; an uncaught error or a fail-closed refusal
    /// discards and terminates without retry.
    pub fn disposition(&self) -> CrankDisposition {
        match self {
            WorkerOutcome::Quiesced => CrankDisposition::Commit,
            WorkerOutcome::Uncaught(_) => CrankDisposition::DiscardAndTerminate,
            WorkerOutcome::Panicked(reason) if reason.is_panic() => {
                CrankDisposition::DiscardAndRecover
            }
            WorkerOutcome::Panicked(_) => CrankDisposition::DiscardAndTerminate,
        }
    }
}

impl std::fmt::Display for WorkerOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerOutcome::Quiesced => write!(f, "quiesced"),
            WorkerOutcome::Uncaught(message) => write!(f, "uncaught: {message}"),
            WorkerOutcome::Panicked(reason) => write!(f, "panicked: {reason}"),
        }
    }
}

#[cfg(feature = "ironhorse-engine")]
impl From<crate::ironhorse_engine::engine::ExecutionOutcome> for WorkerOutcome {
    fn from(outcome: crate::ironhorse_engine::engine::ExecutionOutcome) -> WorkerOutcome {
        use crate::ironhorse_engine::engine::ExecutionOutcome;
        match outcome {
            ExecutionOutcome::Quiesced => WorkerOutcome::Quiesced,
            ExecutionOutcome::Uncaught(message) => WorkerOutcome::Uncaught(message),
            ExecutionOutcome::Panicked(halt) => WorkerOutcome::Panicked(PanicReason::Halt(halt)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aborted(abort: XsAbort) -> Result<(), XsnapError> {
        Err(XsnapError::Aborted {
            abort,
            computrons: 42,
        })
    }

    #[test]
    fn clean_exit_is_quiesced_and_commits() {
        let outcome = WorkerOutcome::from_xs_run(&Ok(()));
        assert_eq!(outcome, WorkerOutcome::Quiesced);
        assert_eq!(outcome.disposition(), CrankDisposition::Commit);
    }

    #[test]
    fn every_panic_source_surfaces_one_panicked_arm() {
        let sources = [
            aborted(XsAbort::StackOverflow),
            aborted(XsAbort::NativeStackOverflow),
            aborted(XsAbort::MeterAbort),
            aborted(XsAbort::OutOfMemory),
            aborted(XsAbort::NoMoreKeys),
            Err(XsnapError::Panicked {
                message: "injected callback panic".into(),
                location: Some("worker_io.rs:1:1".into()),
            }),
        ];
        for source in &sources {
            let outcome = WorkerOutcome::from_xs_run(source);
            match &outcome {
                WorkerOutcome::Panicked(reason) => {
                    assert!(reason.is_panic(), "{source:?} must be a panic member");
                }
                other => panic!("{source:?} classified as {other:?}"),
            }
            assert_eq!(outcome.disposition(), CrankDisposition::DiscardAndRecover);
        }
    }

    #[test]
    fn panicked_reason_preserves_the_source() {
        assert_eq!(
            WorkerOutcome::from_xs_run(&aborted(XsAbort::StackOverflow)),
            WorkerOutcome::Panicked(PanicReason::Abort {
                abort: XsAbort::StackOverflow,
                computrons: 42,
            }),
        );
        let fault = WorkerOutcome::from_xs_run(&Err(XsnapError::Panicked {
            message: "boom".into(),
            location: None,
        }));
        assert_eq!(fault.to_string(), "panicked: engine fault: boom");
    }

    #[test]
    fn unhandled_errors_are_uncaught_not_panics() {
        for abort in [XsAbort::UnhandledException, XsAbort::UnhandledRejection] {
            let outcome = WorkerOutcome::from_xs_run(&aborted(abort));
            assert_eq!(outcome, WorkerOutcome::Uncaught(abort.to_string()));
            assert_eq!(outcome.disposition(), CrankDisposition::DiscardAndTerminate);
        }
    }

    #[test]
    fn refusals_fail_closed_without_recovery() {
        let sources = [
            aborted(XsAbort::Unknown(3)),
            Err(XsnapError::MachineInit("no machine".into())),
            Err(XsnapError::Io("pipe closed".into())),
            Err(XsnapError::Archive("bad archive".into())),
            Err(XsnapError::Bootstrap("bad bundle".into())),
        ];
        for source in &sources {
            let outcome = WorkerOutcome::from_xs_run(source);
            match &outcome {
                WorkerOutcome::Panicked(reason) => {
                    assert!(!reason.is_panic(), "{source:?} is not a panic member");
                }
                other => panic!("{source:?} must fail closed, got {other:?}"),
            }
            assert_eq!(outcome.disposition(), CrankDisposition::DiscardAndTerminate);
        }
    }

    #[cfg(feature = "ironhorse-engine")]
    #[test]
    fn ironhorse_outcome_joins_the_same_arms() {
        use crate::ironhorse_engine::engine::{ExecutionOutcome, Halt};
        assert_eq!(
            WorkerOutcome::from(ExecutionOutcome::classify(Halt::Return)),
            WorkerOutcome::Quiesced,
        );
        let outcome = WorkerOutcome::from(ExecutionOutcome::classify(Halt::MeterAbort));
        assert_eq!(outcome.disposition(), CrankDisposition::DiscardAndRecover);
        let gap = WorkerOutcome::from(ExecutionOutcome::classify(Halt::NotImplemented("GAP")));
        assert_eq!(gap.disposition(), CrankDisposition::DiscardAndTerminate);
    }
}
