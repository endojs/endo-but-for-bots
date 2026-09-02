//! Cross-version compatibility gates and semantic migrations for snapshots
//! whose container schema remains current while VM behavior evolves.
//!
//! `compat-8047.container` was produced by exact commit `8047fd52f` from:
//!
//! ```js
//! function capture() { return arguments; }
//! var held = capture(1, 2);
//! var seed = 1;
//! seed
//! ```
//!
//! That revision predates the current boot layout and must now be rejected
//! before adoption. `compat-a50-custom-arguments.container` was produced by
//! exact commit `a50bc6e21` and re-signed for boot generation 2 after selecting
//! `Array.prototype` for an arguments object and deleting its own `@@iterator`.
//! Boot generation 3 adds standard Object constructor methods, so that image
//! is now likewise incompatible and must be rejected rather than mis-adopted.

use ironhorse_snapshot::machine::from_snapshot_bytes;
use ironhorse_snapshot::{Signature, SnapshotError};

fn signature() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .expect("read the frozen cross-version fixture")
}

#[test]
fn incompatible_legacy_boot_containers_are_rejected_before_adoption() {
    for name in [
        "compat-8047.container",
        "compat-a50-custom-arguments.container",
    ] {
        match from_snapshot_bytes(&fixture(name), &signature()) {
            Err(SnapshotError::SignatureMismatch { .. }) => {}
            Err(other) => panic!("{name} refused for the wrong reason: {other:?}"),
            Ok(_) => panic!("{name} must not reach arena adoption"),
        }
    }
}
