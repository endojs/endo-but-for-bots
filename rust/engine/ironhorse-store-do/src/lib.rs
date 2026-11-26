//! [`DoStore`]: a [`HeapStore`](ironhorse_snapshot::store::HeapStore) over a
//! Durable Object's SQLite (design `designs/thixotrope-wasm-worker.md` § 4.3
//! and § 5), on the `MemoryStore` pattern: the required reads, one commit of
//! plain statements, the trait's dense reachability defaults, an `IRON` stamp
//! in a meta row, every value at most [`MAX_VALUE_BYTES`], and the small-state
//! sections stored in chunks of [`SECTION_CHUNK_BYTES`].
//!
//! The crate runs no SQL itself. It hands each statement to a
//! [`SqlExecutor`] the embedder supplies: in the wasm shell, the host-import
//! block over `ctx.storage.sql` (whose `unsafe extern` declarations stay in
//! that shell); natively, the rusqlite executor of
//! `rust/endo/ironhorse-store-do-rusqlite`, which runs the engine's store
//! acceptance suite against real SQLite. [`wire`] is the value encoding the
//! host imports carry.
//!
//! # The host contract
//!
//! An executor must:
//!
//! 1. **Run exactly one statement per [`SqlExecutor::exec`]**, binding the
//!    parameters positionally (`?1`, `?2`, …) and answering every row the
//!    statement produces, each with exactly the statement's columns, in
//!    order. A statement that writes answers no rows.
//! 2. **Never re-enter the store.** `exec` does not call back into this
//!    crate, so nothing here is borrowed twice.
//! 3. **Run each committing call inside one host transaction**: a
//!    [`HeapStore::commit_verified`](ironhorse_snapshot::store::HeapStore::commit_verified)
//!    (begin, import, a crank with its checkpoint),
//!    [`HeapStore::replace_for_migration`](ironhorse_snapshot::store::HeapStore::replace_for_migration),
//!    [`DoStore::open`] (which may create the schema and the stamp) and
//!    [`DoStore::reset_for_harness`], and roll it back when the call fails.
//!    The crate issues no `BEGIN`, `COMMIT` or `SAVEPOINT`: a Durable Object
//!    refuses them and offers `transactionSync` instead. Within a committing
//!    call every read, and every refusal the store raises itself (the value
//!    cap, a framing it cannot store), precedes the first write: the writes
//!    are planned in full before any runs. Once writing starts only the
//!    executor can fail, and the atomicity of a call that fails part-way is
//!    the host's transaction, and nothing else.
//!    [`DoStore::record_failure`] is the exception: the host writes it in a
//!    transaction of its own after the failed one has rolled back, which is
//!    what lets a failure outlive the crank it describes.
//!
//! The store also relies on there being one writer: the read of the stored
//! manifest that a commit or a migration compares against and the writes
//! that follow it are atomic only inside the host's transaction, which a
//! Durable Object's single thread and input gates make exclusive.
//!
//! # Several stores in one database
//!
//! Every row carries a store id, so several stores share one database: the
//! acceptance suite creates a fresh store per case, and a production object
//! holds one. Store id 0 is the database's own (the stamp) and is refused.
//!
//! # Failure classes
//!
//! Executor-supplied data is never indexed blindly: a short row, a column of
//! the wrong type or an integer outside the domain is an error, not a panic.
//! Such an answer contradicts the schema this crate writes, so it is
//! [`SnapshotError::Corrupt`],
//! which classifies as
//! [`StoreFailure::Poisoned`](ironhorse_snapshot::store::StoreFailure::Poisoned):
//! nothing read beside it can be trusted, and a retry would read the same
//! rows. A value over the cap is
//! [`StoreError::Unsupported`]
//! (refused, deterministic). An executor's own failure is whatever the
//! executor answers; the host imports answer
//! [`StoreError::Io`] for a failed
//! statement.

#![forbid(unsafe_code)]

mod store;
pub mod wire;

pub use store::{DoStore, MAX_VALUE_BYTES, SECTION_CHUNK_BYTES};

use ironhorse_snapshot::store::StoreError;
use ironhorse_snapshot::SnapshotError;

/// A bound parameter or a returned column.
///
/// Integers are integers here: store ids, page indexes, chunk numbers and
/// lengths are `u32` in the domain and travel as [`Value::Integer`]. How a
/// host carries them (the Durable Object's `sql.exec` binds and returns
/// doubles) is the host's concern; [`wire`] does that mapping, checked both
/// ways. There is no floating-point variant because the store writes none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Integer(i64),
    Blob(Vec<u8>),
    Text(String),
}

impl From<u32> for Value {
    fn from(n: u32) -> Value {
        Value::Integer(i64::from(n))
    }
}

impl Value {
    /// An integer column read back into the u32 domain, range-checked rather
    /// than truncated: a negative, oversized or non-integer value is a
    /// corrupt row, never a plausible index.
    pub(crate) fn into_u32(self) -> Result<u32, StoreError> {
        match self {
            Value::Integer(n) => u32::try_from(n)
                .map_err(|_| corrupt("do sql: an integer column is outside the u32 range")),
            _ => Err(corrupt("do sql: an integer column holds another type")),
        }
    }

    /// A blob column's bytes.
    pub(crate) fn into_blob(self) -> Result<Vec<u8>, StoreError> {
        match self {
            Value::Blob(bytes) => Ok(bytes),
            _ => Err(corrupt("do sql: a blob column holds another type")),
        }
    }
}

/// Runs one SQL statement and answers its rows. See the crate's host
/// contract: one statement per call, no re-entry, and one host transaction
/// around each committing call.
pub trait SqlExecutor {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError>;
}

pub(crate) fn corrupt(message: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(message))
}
