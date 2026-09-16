//! Capture the current-format container the architecture map draws.
//!
//! The map shows a real slot arena rather than a sketch of one, and the only
//! containers otherwise checked in are compatibility fixtures pinned at older
//! formats. This example boots a machine, runs a short program chosen to put
//! recognizable shapes in the heap, and writes the container the map decodes.
//!
//! Run from `rust/engine`:
//!
//! ```sh
//! cargo run --example capture-map-heap -- architecture-map-heap.container
//! ```
//!
//! Re-run it after a format bump, then regenerate the map. The map prints the
//! container's own format version, so a stale capture is visible on the page
//! rather than silently wrong.

use std::path::PathBuf;

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::MachineSnapshot;
use ironhorse_vm::{parse_symbols, Interp};

/// Guest source for the captured heap.
///
/// Each statement exists to leave one identifiable shape behind: objects and a
/// prototype chain for `Instance` and `Reference` slots, string literals and a
/// built string for `String` slots pointing into the chunk arena, integers and
/// a float for inline payloads, a closure over a captured binding, and an array
/// plus a Map so the array and collection side tables are populated. The
/// program ends quiescent, because a snapshot refuses a halted crank.
const SOURCE: &str = r#"
var origin = { name: 'origin', x: 0, y: 0 };
var point = { __proto__: origin, name: 'point', x: 3, y: 4 };
var label = point.name + ' at ' + point.x + ',' + point.y;
var distance = 5.0;
var counter = (function () {
  var count = 0;
  return function () { count = count + 1; return count; };
})();
counter();
counter();
var samples = [1, 2, 3, 5, 8, 13];
var index = new Map();
index.set('point', point);
index.set('origin', origin);
var total = 0;
for (var i = 0; i < samples.length; i = i + 1) { total = total + samples[i]; }
total;
"#;

fn main() {
    let target = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("architecture-map-heap.container"));

    let (bytecode, symbols) = ironhorse_compile::compile_atoms(SOURCE).expect("compiles");
    let names = parse_symbols(&symbols);

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(
        outcome.completed,
        "the captured program must finish; halted with {:?}",
        outcome.halt
    );

    // The same signature the worker uses, so the container is one a real host
    // would accept rather than a shape only this example can read.
    let signature = Signature::new("ironhorse-worker-v1");
    let bytes = machine
        .write_snapshot(&signature)
        .expect("a quiescent machine serializes");

    std::fs::write(&target, &bytes).expect("write container");
    println!(
        "{} bytes -> {} (completed={}, computrons={})",
        bytes.len(),
        target.display(),
        outcome.completed,
        outcome.computrons
    );
}
