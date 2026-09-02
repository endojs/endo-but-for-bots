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
//! exact commit `a50bc6e21`, which has the current boot layout, after selecting
//! `Array.prototype` for an arguments object and deleting its own `@@iterator`.

use ironhorse_snapshot::machine::from_snapshot_bytes;
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::parse_symbols;

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
fn incompatible_legacy_boot_container_is_rejected_before_adoption() {
    match from_snapshot_bytes(&fixture("compat-8047.container"), &signature()) {
        Err(SnapshotError::SignatureMismatch { .. }) => {}
        Err(other) => panic!("legacy boot refused for the wrong reason: {other:?}"),
        Ok(_) => panic!("legacy boot layout must not reach arena adoption"),
    }
}

#[test]
fn intermediate_container_preserves_guest_arguments_edits() {
    let mut machine = from_snapshot_bytes(
        &fixture("compat-a50-custom-arguments.container"),
        &signature(),
    )
    .expect("restore intermediate container");
    let source = "var held; var seed; \
                  (Object.getPrototypeOf(held) === Array.prototype) + '|' + \
                    Object.prototype.hasOwnProperty.call(held, Symbol.iterator) + '|' + seed";
    let (bytecode, symbols) =
        ironhorse_compile::compile_atoms(source).expect("observation compiles");
    let names = parse_symbols(&symbols);
    let bytecode = machine
        .relink_crank(&bytecode, &names)
        .expect("observation relinks");
    let outcome = machine.run(&bytecode);

    assert!(outcome.completed, "observation crank: {:?}", outcome.halt);
    assert_eq!(outcome.result, "true|false|1");
}
