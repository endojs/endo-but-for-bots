//! Slot-machine: per-session capability lists with a unified kref
//! registry, suitable for durable persistence when the daemon is
//! idle and suspended.
//!
//! Layered identity:
//!
//! ```text
//!   formula-id   (daemon, durable JSON on disk — optional back-pointer)
//!        ↑  bound 1:1 for durable capabilities
//!        |
//!    kref        (slot-machine, session-wide; persisted in SQLite)
//!        ↑  per-session translation
//!        |
//!    vref        (worker-local string, e.g. "o+1", "p-3"; never persisted)
//! ```
//!
//! One [`SlotMachine`] owns the kref table and a [`Session`] for each
//! connected worker.  When worker A sends a message that includes a
//! capability imported from the daemon, slot-machine translates
//! vref → kref → vref-in-B.  When the daemon quiesces, a single
//! SQLite transaction commits the c-lists, refcounts, and promise
//! state so that resuming workers can pick up the same identities.

pub mod error;
pub mod gc;
pub mod kref;
pub mod promise;
pub mod refcount;
pub mod session;
pub mod store;
pub mod table;
pub mod vref;
pub mod wire;

pub use error::SlotError;
pub use gc::RetireReport;
pub use kref::{Kref, KrefAllocator};
pub use promise::{PromiseResolution, PromiseState};
pub use refcount::Pillar;
pub use session::{Session, SessionId};
pub use store::SlotStore;
pub use table::{KrefEntry, KrefKind, SlotMachine, TranslateOutcome};
pub use vref::{Direction, Vref, VrefType};
