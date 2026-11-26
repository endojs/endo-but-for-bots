//! The host-neutral part of the Thixotrope Ironhorse worker: one machine over
//! any `HeapStore`, its crank loop, and the NDJSON protocol every shell
//! speaks. A shell supplies the store, the boot sources and the pipes; it
//! does no filesystem, stdio, thread or clock work through this crate.
//!
//! The machine's recursion budget assumes `ironhorse_vm::NATIVE_STACK_BYTES`
//! of native stack under every crank. The native shell runs its worker on a
//! thread of that size; any other host must provide it by its own means.
//!
//! A shell's serving loop, after opening (and, for a fresh heap, booting and
//! checkpointing) a [`Worker`]:
//!
//! ```text
//! write(ready_line())?;
//! for request in lines {
//!     match worker.respond(&request) {
//!         Step::Continue(line) => write(line)?,
//!         Step::Close => break,
//!         Step::Die { line, error } => {
//!             write(line)?;
//!             return Err(error);
//!         }
//!     }
//! }
//! let store = worker.close()?;
//! ```
#![forbid(unsafe_code)]

mod compiler;
mod crank;
mod error;
mod limits;
mod protocol;
mod worker;

pub use crank::{crank_halted, deliver, eval, FINALIZATION_ROUNDS};
pub use error::WorkerError;
pub use limits::{positive_integer, WorkerLimits};
pub use protocol::{parse_request, ready_line, respond, Step, FEATURES};
pub use worker::{Resume, Worker};

#[cfg(test)]
mod tests;
