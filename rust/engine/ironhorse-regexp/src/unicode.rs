//! Shared XS Unicode identifier classification.
//! Kept as a public compatibility path; the implementation lives in the leaf crate.

pub use ironhorse_unicode::{
    is_identifier_first, is_identifier_next, IDENTIFIER_FIRST, IDENTIFIER_NEXT,
};
