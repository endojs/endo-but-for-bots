//! What a [`crate::Worker`] step that touches the store can fail with.

use ironhorse_snapshot::store::StoreError;

/// The step that failed, with the store's own error where there is one, so
/// that a shell can classify it ([`StoreError::classify`]). `Display` is the
/// text the native worker has always printed for that step.
#[derive(Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum WorkerError {
    /// The engine refused a configured ceiling: the refusal's own text.
    Limits(String),
    /// The first commit into an empty store failed.
    Begin(StoreError),
    /// Upgrading the store to the current schema failed.
    Migrate(StoreError),
    /// Restoring the stored machine failed.
    Restore(StoreError),
    /// A commit failed. A failed commit forgets nothing; unless the worker
    /// is dead, the next checkpoint re-offers the same dirt.
    Checkpoint(StoreError),
    /// An earlier crank failed, so nothing more may run or be committed;
    /// carries that crank's message.
    Dead(String),
    /// The store is still held after the session went; an engine defect.
    StoreShared,
}

impl WorkerError {
    /// The store's error, for the steps that have one.
    pub fn store_error(&self) -> Option<&StoreError> {
        match self {
            WorkerError::Begin(e)
            | WorkerError::Migrate(e)
            | WorkerError::Restore(e)
            | WorkerError::Checkpoint(e) => Some(e),
            WorkerError::Limits(_) | WorkerError::Dead(_) | WorkerError::StoreShared => None,
        }
    }
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerError::Limits(refusal) => f.write_str(refusal),
            WorkerError::Begin(e) => write!(f, "begin: {e:?}"),
            WorkerError::Migrate(e) => write!(f, "migrate: {e:?}"),
            WorkerError::Restore(e) => write!(f, "restore: {e:?}"),
            WorkerError::Checkpoint(e) => write!(f, "checkpoint: {e:?}"),
            WorkerError::Dead(crank) => write!(f, "{}", dead_message(crank)),
            WorkerError::StoreShared => f.write_str("close: the store is still shared"),
        }
    }
}

impl std::error::Error for WorkerError {}

/// The refusal of anything asked of a dead worker.
pub(crate) fn dead_message(crank: &str) -> String {
    format!("worker is dead after a failed crank: {crank}")
}
