use std::fmt;

#[derive(Debug)]
pub enum SlotError {
    /// Vref string did not parse.  The offending input is included
    /// verbatim so callers can log it.
    ParseVref(String),
    /// Translation or insertion refused because a worker tried to
    /// allocate a local position that is already bound to a
    /// different kref (or vice versa).
    Conflict(String),
    /// Required row missing from the c-list or kref registry.
    NotFound(String),
    /// SQLite-level failure during checkpoint or restore.
    Store(rusqlite::Error),
    /// Internal invariant violation that indicates a bug.
    Invariant(String),
}

impl fmt::Display for SlotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SlotError::ParseVref(s) => write!(f, "cannot parse vref {s:?}"),
            SlotError::Conflict(s) => write!(f, "slot conflict: {s}"),
            SlotError::NotFound(s) => write!(f, "not found: {s}"),
            SlotError::Store(e) => write!(f, "slot store: {e}"),
            SlotError::Invariant(s) => write!(f, "slot invariant: {s}"),
        }
    }
}

impl std::error::Error for SlotError {}

impl From<rusqlite::Error> for SlotError {
    fn from(e: rusqlite::Error) -> Self {
        SlotError::Store(e)
    }
}

pub type Result<T> = std::result::Result<T, SlotError>;
