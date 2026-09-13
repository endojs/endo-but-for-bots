//! Read-only source registries for in-tree invariant tests, not execution APIs.
//! This explicit list does not expose interpreter implementation modules.
pub use crate::interp::boundary::QUIESCENCE_SOURCE;
pub use crate::interp::gc_tables::{
    CHUNK_WALK_SOURCE, EPHEMERON_SOURCE, FULL_EDGE_SOURCE, FULL_SWEEP_SOURCE, PARTIAL_EDGE_SOURCE,
    PARTIAL_SWEEP_SOURCE, ROW_EDGE_SOURCE, TAIL_EDGE_SOURCE, WEAK_PRUNE_SOURCE,
};
pub use crate::interp::persistence::{PERSIST_HOLDER_SOURCE, RUNTIME_KEY_HOLDER_SOURCE};
pub use crate::interp::roots::ROOT_SOURCE;
pub use crate::interp::{INTERP_FIELDS, XS_ENVIRONMENT_BEHAVIOR_ID, XS_INTERNAL_FLAG};
