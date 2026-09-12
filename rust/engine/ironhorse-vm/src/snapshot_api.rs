//! The deliberate wire-format surface `ironhorse-snapshot` builds its on-disk
//! representation from.
//!
//! These row and snapshot records are data types, not interpreter API. They
//! live in their own module, rather than leaking out of `interp`, so that
//! `interp` can stay private and a field change here is an explicit format
//! decision. [`ROW_SCHEMA_VERSION`] names the row schema; a snapshot-side test
//! keeps it in lockstep with `ironhorse_snapshot::format::IRONHORSE_FORMAT_VERSION`,
//! so the two version identifiers move together. The enforcement of a new row
//! field is the exhaustive destructure/visit in the snapshot crate, which
//! forces a deliberate metadata or codec decision for every field.

pub use crate::interp::{
    AccessorRow, ArraySnapshot, AsyncRow, BoundFunctionRow, CollatorData, CollectionSnapshot,
    CombinatorRow, DateTimeFormatData, DisposableStackRow, DisposalRecordRow, FunctionRow,
    FunctionStateSnapshot, GeneratorRow, IndexPropsSnapshot, IntlBoundFunctionRow, IntlTables,
    IteratorRow, ListFormatData, LocaleData, NumberFormatData, PluralRulesData, PrivateAccessorRow,
    PrivateElementSnapshot, PrivateValueRow, PromiseClusterSnapshot, PromiseFnRow,
    PromiseReactionRow, PromiseRow, ProxyRevokerRow, ProxyRow, ProxyStateSnapshot, SavedFrameRow,
    SavedJumpRow, SegmentIteratorData, SegmenterData, SegmentsData, MAP_MIN_TABLE_LENGTH,
};

/// Version of the row schema this module exposes.
///
/// Tied to `ironhorse_snapshot::format::IRONHORSE_FORMAT_VERSION` by
/// `ironhorse-snapshot/tests/row_schema.rs`: a change to any row type above
/// must move both this constant and the container format version together.
pub const ROW_SCHEMA_VERSION: u32 = 20;
