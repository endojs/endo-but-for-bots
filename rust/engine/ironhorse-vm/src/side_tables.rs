//! Shared checkpoint section roster.
//!
//! Numeric identities preserve schema 28 framing. Append-only changes require
//! the snapshot format's migration discipline; reordering is never permitted.
//! All 32 dirty-mask bits are occupied, so another section also requires widening
//! the VM tracker.
//!
//! This macro supplies names and identities to both crates so dirty tracking
//! and persisted section dispatch cannot acquire independent inventories.

/// Invoke a section consumer with the complete ordered checkpoint roster.
#[doc(hidden)]
#[macro_export]
macro_rules! snapshot_sections {
    ($consumer:ident) => {
        $consumer! {
            Stack = 0,
            RetiredFreeList = 1,
            Keys = 2,
            Names = 3,
            Symbols = 4,
            Meter = 5,
            Arrays = 6,
            Collections = 7,
            Registry = 8,
            Errors = 9,
            Buffers = 10,
            TypedArrays = 11,
            DataViews = 12,
            Wrappers = 13,
            Regexps = 14,
            ArgumentsBrands = 15,
            Temporal = 16,
            Intl = 17,
            NameFloor = 18,
            Iterators = 19,
            Dates = 20,
            Functions = 21,
            Proxies = 22,
            Accessors = 23,
            IntlBoundFunctions = 24,
            PrivateElements = 25,
            DisposableStacks = 26,
            Generators = 27,
            ErrorFrames = 28,
            Promises = 29,
            AsyncInstances = 30,
            IndexProperties = 31,
        }
    };
}
