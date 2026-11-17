//! MUST PASS the classification-discipline lint: the same commit-path
//! decision as `commit_path_raw_match.rs`, routed through the predicate and
//! the classifier instead of variant shape. Parsed by the lint, not compiled.

use ironhorse_vm::Halt;

use crate::ironhorse_engine::engine::ExecutionOutcome;
use crate::supervisor::{Crank, Delivery};

/// Decide whether a finished crank's embargoed effects are released.
pub fn settle_crank(delivery: &mut Delivery, crank: Crank) {
    if crank.halt.is_panic() {
        delivery.discard_and_terminate();
    } else {
        delivery.commit();
    }
}

/// The same decision through the three-way classifier.
pub fn settle_classified(delivery: &mut Delivery, halt: Halt) {
    match ExecutionOutcome::classify(halt) {
        ExecutionOutcome::Quiesced => delivery.commit(),
        ExecutionOutcome::Uncaught(_) => delivery.discard(),
        ExecutionOutcome::Panicked(_) => delivery.discard_and_terminate(),
        _ => delivery.discard_and_terminate(),
    }
}

/// Constructing a variant is not matching one.
pub fn meter_refused() -> Halt {
    Halt::MeterAbort
}
