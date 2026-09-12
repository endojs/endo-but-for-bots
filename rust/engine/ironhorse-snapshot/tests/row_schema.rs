//! The row schema and the container format version move together.
//!
//! `ironhorse_vm::snapshot_api` is the deliberate wire-format surface the
//! snapshot crate builds on. This test keeps the two version identifiers in
//! lockstep; the exhaustive row destructures in `stored_slots.rs` are what
//! force a deliberate visit/metadata decision when a row field changes.

#[test]
fn row_schema_version_matches_the_container_format() {
    assert_eq!(
        ironhorse_vm::snapshot_api::ROW_SCHEMA_VERSION,
        ironhorse_snapshot::format::IRONHORSE_FORMAT_VERSION,
        "a snapshot_api row-type change must move IRONHORSE_FORMAT_VERSION, and a container \
         format bump must move ROW_SCHEMA_VERSION"
    );
}
