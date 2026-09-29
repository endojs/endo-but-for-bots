//! MUST FAIL the classification-discipline lint (designs/ironhorse-panic.md
//! § Verification, the classification-discipline bullet).
//!
//! A commit-path release-or-discard decision that reproduces `is_panic()`
//! by matching raw `Halt` variant shape. It compiles today, and it would
//! silently drift the day the panic set changes (for example if the open
//! question on `Decode` membership flips). Parsed by the lint, not compiled.

use ironhorse_vm::Halt;

use crate::supervisor::{Crank, Delivery};

/// Decide whether a finished crank's embargoed effects are released.
pub fn settle_crank(delivery: &mut Delivery, crank: Crank) {
    match crank.halt {
        Halt::StackOverflow(_) | Halt::Decode(_) => delivery.discard_and_terminate(),
        _ => delivery.commit(),
    }
}
