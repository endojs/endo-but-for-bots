//! Deliberate capture/restore row contract for `ironhorse-snapshot`.
//!
//! Rows are implementation-independent data, not direct arena mutation powers.
//! Field additions, removals, order or type changes require a row-schema release
//! and corresponding container/store versions. The snapshot crate's append-only
//! row-schema ledger pins the declarations as well as both encoding versions.
//! Shared Machine contexts travel in the function cluster; standalone snapshots
//! retain their existing row defaults and require no shared-state extension.

/// Version of the capture/restore row declarations, distinct from wire encoding.
pub const ROW_SCHEMA_VERSION: u32 = 2;

pub use crate::interp::MAP_MIN_TABLE_LENGTH;
pub use crate::interp::{
    AccessorRow, ArraySnapshot, AsyncRow, BoundFunctionRow, CollatorData, CollectionSnapshot,
    CombinatorRow, DateTimeFormatData, DisposableStackRow, DisposalRecordRow, EnvironmentRow,
    EvaluatorRow, FunctionRow, FunctionStateSnapshot, GeneratorRow, IndexPropsSnapshot,
    IntlBoundFunctionRow, IntlTables, IteratorRow, ListFormatData, LocaleData, ModuleGraphSnapshot,
    ModuleRecordRow, NumberFormatData, PluralRulesData, PrivateAccessorRow, PrivateElementSnapshot,
    PrivateValueRow, PromiseClusterSnapshot, PromiseFnRow, PromiseJobRow, PromiseReactionRow,
    PromiseRow, ProxyRevokerRow, ProxyRow, ProxyStateSnapshot, SavedFrameRow, SavedJumpRow,
    SegmentIteratorData, SegmenterData, SegmentsData, SharedMachineSnapshot,
};
