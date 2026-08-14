//! Inter-worker wire protocol.
//!
//! Slot-machine claims four envelope verbs on the bus:
//!
//! * [`VERB_DELIVER`]  — method call on a kref.  Sync when the
//!   envelope's `nonce` is non-zero, fire-and-forget otherwise.
//! * [`VERB_RESOLVE`]  — fulfil or reject a promise kref.
//! * [`VERB_DROP`]     — decrement one or more pillars on a kref.
//! * [`VERB_ABORT`]    — session teardown; slot-machine calls
//!   [`crate::SlotMachine::close_session`].
//!
//! Every other bus verb (`spawn`, `suspend`, the `meter-*` and
//! `cas-*` families, etc.) is untouched by slot-machine.
//!
//! Payloads are canonical CBOR (RFC 8949 §4.2).  We borrow the
//! parallel-slot-arrays shape from OCapN — it's what lets an
//! intermediary translate positions without parsing the body — but
//! we don't wrap payloads in OCapN `Tag 27` records.  The envelope
//! verb is the operation; the payload is a plain 2–5 element CBOR
//! array whose fields are positional.

pub mod codec;
pub mod descriptor;
pub mod payload;
pub mod translate;

pub use descriptor::{Descriptor, Direction, Kind};
pub use payload::{AbortPayload, DeliverPayload, DropDelta, DropPayload, ResolvePayload};
pub use translate::translate_deliver;

pub const VERB_DELIVER: &str = "deliver";
pub const VERB_RESOLVE: &str = "resolve";
pub const VERB_DROP: &str = "drop";
pub const VERB_ABORT: &str = "abort";

/// Returns true when the envelope verb is one slot-machine claims.
pub fn is_slot_verb(verb: &str) -> bool {
    matches!(verb, VERB_DELIVER | VERB_RESOLVE | VERB_DROP | VERB_ABORT)
}
