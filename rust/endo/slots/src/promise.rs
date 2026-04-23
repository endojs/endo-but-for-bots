//! Promise state tracked per kref.
//!
//! Every promise that crosses a session boundary gets a kref just
//! like an object would.  In addition, we remember:
//!   * which session (if any) is the decider — `None` means this
//!     daemon is the decider;
//!   * whether it has resolved, and with what capdata blob.

use serde::{Deserialize, Serialize};

use crate::session::SessionId;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum PromiseResolution {
    Pending,
    Fulfilled(Vec<u8>),
    Rejected(Vec<u8>),
}

impl Default for PromiseResolution {
    fn default() -> Self {
        PromiseResolution::Pending
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PromiseState {
    pub decider: Option<SessionId>,
    pub resolution: PromiseResolution,
}

impl PromiseState {
    pub fn new(decider: Option<SessionId>) -> Self {
        PromiseState { decider, resolution: PromiseResolution::Pending }
    }

    pub fn is_resolved(&self) -> bool {
        !matches!(self.resolution, PromiseResolution::Pending)
    }
}
