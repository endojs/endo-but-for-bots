//! Capture the current-format container the architecture map draws, and find
//! the slots that hold a counter's value.
//!
//! The map shows a real slot arena rather than a sketch of one. It also has to
//! point at a slot and say "this one holds the count", which no amount of
//! reading the source establishes on its own. So this example boots one
//! machine, sets up a counter, and then takes the increment as a separate
//! crank, capturing the heap after each one. A slot whose contents track the
//! number of increments is a slot that holds the count. That is evidence, not
//! a guess.
//!
//! The cranks share one machine and one pair of compiled programs, which is
//! what makes the slot indices comparable across captures: a differently
//! worded program would allocate differently and the indices would not line
//! up. It is also how a persistent machine actually runs.
//!
//! Run from `rust/engine`:
//!
//! ```sh
//! cargo run --example capture-map-heap
//! ```
//!
//! It writes `architecture-map-heap.container` (the heap at
//! [`CANONICAL_COUNT`] increments) and `architecture-map-heap.counters.json`
//! (the slots that vary, with their value at each count). Re-run it after a
//! format bump, then regenerate the map. The map prints the container's own
//! format version, so a stale capture is visible on the page.

use std::collections::BTreeMap;
use std::path::PathBuf;

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::MachineSnapshot;
use ironhorse_vm::{parse_symbols, Interp};

/// The counter program.
///
/// `count` lives in the closure the immediately-invoked function returns, so
/// it is not a global: it sits in a scope cell that the returned function
/// captures, which is the arrangement worth showing. `seen` holds the value
/// the last call returned, so the same number reaches the heap two ways.
const SETUP: &str = r#"
var counter = (function () {
  var count = 0;
  return function () { count = count + 1; return count; };
})();
var seen = 0;
seen;
"#;

/// One increment, run as its own crank so every capture shares this bytecode.
const BUMP: &str = "seen = counter(); seen;";

/// The same increment with the result discarded. `count` still advances;
/// `seen` does not. Comparing the two series is what separates the closure's
/// captured cell from the global that merely saw the last result.
const BUMP_DISCARDING: &str = "counter(); seen;";

/// How many increments the last capture has taken. The map steps through
/// `0..=LAST_COUNT`.
const LAST_COUNT: u32 = 5;

/// The count whose container is checked in and drawn.
const CANONICAL_COUNT: u32 = 3;

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Boot once, then capture the heap after each increment.
fn capture_series(increment: &str) -> Vec<(u32, Vec<u8>, u64)> {
    let (setup, names) = compile(SETUP);
    let (bump, bump_names) = compile(increment);
    let signature = Signature::new("ironhorse-worker-v1");

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&setup);
    assert!(
        outcome.completed,
        "the setup crank must finish; halted with {:?}",
        outcome.halt
    );

    let mut series = Vec::new();
    let mut computrons = outcome.computrons;
    for count in 0..=LAST_COUNT {
        if count > 0 {
            let linked = machine
                .relink_crank(&bump, &bump_names)
                .expect("relink the increment");
            let outcome = machine.run(&linked);
            assert!(
                outcome.completed,
                "increment {count} must finish; halted with {:?}",
                outcome.halt
            );
            computrons += outcome.computrons;
        }
        let bytes = machine
            .write_snapshot(&signature)
            .expect("a quiescent machine serializes");
        series.push((count, bytes, computrons));
    }
    series
}

/// The `HEAP` atom's slot records, as fixed-width rows.
fn slot_records(container: &[u8]) -> Vec<Vec<u8>> {
    let total = u32::from_be_bytes(container[0..4].try_into().expect("size")) as usize;
    let mut offset = 8;
    while offset + 8 <= total.min(container.len()) {
        let size = u32::from_be_bytes(container[offset..offset + 4].try_into().expect("atom size"))
            as usize;
        let tag = &container[offset + 4..offset + 8];
        if tag == b"HEAP" {
            // 8 bytes of atom framing, then HEAP's own 12-byte header
            // (slot count, reserved, live count) before the first record.
            let body = &container[offset + 20..offset + size];
            return body.chunks_exact(20).map(<[u8]>::to_vec).collect();
        }
        if size < 8 {
            break;
        }
        offset += size;
    }
    Vec::new()
}

/// A slot record's payload as the integer it holds, if it holds one.
///
/// Payload tag 2 is `Payload::Integer`; the value occupies the first four
/// payload bytes, big-endian like every other multi-byte field.
fn integer_payload(record: &[u8]) -> Option<i32> {
    (record[8] == 2)
        .then(|| i32::from_be_bytes(record[10..14].try_into().expect("integer payload")))
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let captures = capture_series(BUMP);
    let discarding = capture_series(BUMP_DISCARDING);

    let heaps: Vec<Vec<Vec<u8>>> = captures
        .iter()
        .map(|(_, bytes, _)| slot_records(bytes))
        .collect();
    let width = heaps.iter().map(Vec::len).min().expect("captures");

    let other: Vec<Vec<Vec<u8>>> = discarding
        .iter()
        .map(|(_, bytes, _)| slot_records(bytes))
        .collect();

    // A slot that holds the count reads back as the number of increments at
    // every capture. Anything that merely differs between heaps -- a
    // bookkeeping counter, a different allocation -- fails that test.
    let tracks = |series: &[Vec<Vec<u8>>], index: usize| -> Option<Vec<i32>> {
        let values: Option<Vec<i32>> = series
            .iter()
            .map(|heap| heap.get(index).and_then(|record| integer_payload(record)))
            .collect();
        values.filter(|values| {
            values
                .iter()
                .enumerate()
                .all(|(step, value)| *value == step as i32)
        })
    };

    let mut tracking: BTreeMap<usize, (Vec<i32>, &'static str)> = BTreeMap::new();
    for index in 0..width {
        if let Some(values) = tracks(&heaps, index) {
            // The closure's captured cell advances whether or not the caller
            // keeps the result; the global that stored it does not.
            let role = if tracks(&other, index).is_some() {
                "the counter's own `count`, held in the closure's scope cell"
            } else {
                "`seen`, the global holding what the last call returned"
            };
            tracking.insert(index, (values, role));
        }
    }

    let canonical = captures
        .iter()
        .find(|(bumps, _, _)| *bumps == CANONICAL_COUNT)
        .expect("canonical count is captured");
    let container = dir.join("architecture-map-heap.container");
    std::fs::write(&container, &canonical.1).expect("write container");

    let slots = tracking
        .iter()
        .map(|(index, (values, role))| {
            let rendered = values
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(",");
            format!("    {{ \"slot\": {index}, \"role\": {role:?}, \"values\": [{rendered}] }}")
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let counts = captures
        .iter()
        .map(|(count, _, _)| count.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    // The two programs stay separate in the report: one boots the counter, the
    // other is the crank that runs once per capture.
    let report = format!(
        "{{\n  \"setup\": {:?},\n  \"increment\": {:?},\n  \
         \"discarding\": {:?},\n  \"counts\": [{counts}],\n  \
         \"canonical\": {CANONICAL_COUNT},\n  \"slots\": [\n{slots}\n  ]\n}}\n",
        SETUP.trim(),
        BUMP,
        BUMP_DISCARDING
    );
    let report_path = dir.join("architecture-map-heap.counters.json");
    std::fs::write(&report_path, report).expect("write counter report");

    println!(
        "{} bytes -> {} (count {}, computrons {})",
        canonical.1.len(),
        container.display(),
        CANONICAL_COUNT,
        canonical.2
    );
    println!(
        "{} slot(s) track the count -> {}",
        tracking.len(),
        report_path.display()
    );
    for (index, (values, role)) in &tracking {
        println!("    slot {index}: {values:?}  {role}");
    }
}
