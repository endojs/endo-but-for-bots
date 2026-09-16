//! Capture the container the architecture map draws, find the slots that hold
//! a counter's value, and measure what each increment costs a paged store.
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
//! Because the machine is bound to a store, each increment also reports what
//! it cost to make durable. The store's unit is a page of [`SLOTS_PER_PAGE`]
//! slots, so a crank that changes one integer still rewrites the page holding
//! it; the gap between the change and the write is the number worth having.
//!
//! Run from `rust/engine`:
//!
//! ```sh
//! cargo run --example capture-map-heap
//! ```
//!
//! It writes `architecture-map-heap.container` (the heap at
//! [`CANONICAL_COUNT`] increments) and `architecture-map-heap.counters.json`
//! (the tracking slots and the per-crank store traffic). Re-run it after a
//! format bump, then regenerate the map. The map prints the container's own
//! format version, so a stale capture is visible on the page.

use std::collections::BTreeMap;
use std::path::PathBuf;

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, MachineSnapshot, StoreSession,
};
use ironhorse_snapshot::store::{
    chunk_extent_count, chunk_extent_len, slot_page_count, slot_page_len, CommitStats, HeapStore,
    MemoryStore, SLOTS_PER_PAGE,
};
use ironhorse_snapshot::SLOT_RECORD_BYTES;
use ironhorse_vm::{parse_symbols, Interp, SymbolName};

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

/// One capture: the increments taken, the container, and what the checkpoint
/// after that increment wrote.
struct Step {
    count: u32,
    container: Vec<u8>,
    stats: CommitStats,
}

fn compile(source: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Boot once, then capture and checkpoint after each increment.
fn capture_series(increment: &str, store: &mut MemoryStore) -> (Vec<Step>, StoreSession) {
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

    let mut session = begin_store_session(machine, &signature, store)
        .map_err(|(_, error)| error)
        .expect("bind the store");

    let mut steps = Vec::new();
    for count in 0..=LAST_COUNT {
        if count > 0 {
            let linked = session
                .machine_mut()
                .relink_crank(&bump, &bump_names)
                .expect("relink the increment");
            let outcome = session.machine_mut().run(&linked);
            assert!(
                outcome.completed,
                "increment {count} must finish; halted with {:?}",
                outcome.halt
            );
            checkpoint_to_store(&mut session, &signature, store).expect("checkpoint");
        }
        steps.push(Step {
            count,
            container: session
                .machine()
                .write_snapshot(&signature)
                .expect("a quiescent machine serializes"),
            stats: store.last_commit_stats(),
        });
    }
    (steps, session)
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
            return body
                .chunks_exact(SLOT_RECORD_BYTES)
                .map(<[u8]>::to_vec)
                .collect();
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

/// Slot indices whose records differ, and the pages holding them.
fn changed(before: &[Vec<u8>], after: &[Vec<u8>]) -> (Vec<usize>, Vec<u32>) {
    let slots: Vec<usize> = before
        .iter()
        .zip(after.iter())
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(index, _)| index)
        .collect();
    let mut pages: Vec<u32> = slots
        .iter()
        .map(|index| (*index as u32) / SLOTS_PER_PAGE)
        .collect();
    pages.dedup();
    (slots, pages)
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut store = MemoryStore::new();
    let (steps, session) = capture_series(BUMP, &mut store);
    let mut discard_store = MemoryStore::new();
    let (discard_steps, _) = capture_series(BUMP_DISCARDING, &mut discard_store);

    let heaps: Vec<Vec<Vec<u8>>> = steps
        .iter()
        .map(|step| slot_records(&step.container))
        .collect();
    let other: Vec<Vec<Vec<u8>>> = discard_steps
        .iter()
        .map(|step| slot_records(&step.container))
        .collect();
    let width = heaps.iter().map(Vec::len).min().expect("captures");

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

    let manifest = store.manifest().expect("manifest");
    let canonical = steps
        .iter()
        .find(|step| step.count == CANONICAL_COUNT)
        .expect("canonical count is captured");
    let container = dir.join("architecture-map-heap.container");
    std::fs::write(&container, &canonical.container).expect("write container");

    // Per-step store traffic. Each dirtied page is charged its real stored
    // width: the arena's last page is short, so assuming a full page would
    // overstate the write by roughly a factor of two.
    let mut rows = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let (slots, pages) = if index == 0 {
            (Vec::new(), Vec::new())
        } else {
            changed(&heaps[index - 1], &heaps[index])
        };
        let slot_bytes: usize = if index == 0 {
            // The first commit lands the whole arena, not a dirty subset.
            (0..slot_page_count(manifest.slot_count))
                .map(|page| slot_page_len(manifest.slot_count, page) * SLOT_RECORD_BYTES)
                .sum()
        } else {
            pages
                .iter()
                .map(|page| slot_page_len(manifest.slot_count, *page) * SLOT_RECORD_BYTES)
                .sum()
        };
        let extent_bytes: usize = if step.stats.chunk_extents_written == 0 {
            0
        } else {
            (0..chunk_extent_count(manifest.chunk_len))
                .map(|ext| chunk_extent_len(manifest.chunk_len, ext))
                .sum()
        };
        let written = slot_bytes + extent_bytes + step.stats.small_bytes_written;
        rows.push(format!(
            "    {{ \"count\": {}, \"changed_slots\": {}, \"pages\": {}, \
             \"slot_bytes\": {}, \"extent_rows\": {}, \"extent_bytes\": {}, \
             \"free_rows\": {}, \"sections\": {}, \"small_bytes\": {}, \
             \"written\": {}, \"changed_bytes\": {} }}",
            step.count,
            slots.len(),
            if index == 0 {
                slot_page_count(manifest.slot_count) as usize
            } else {
                pages.len()
            },
            slot_bytes,
            step.stats.chunk_extents_written,
            extent_bytes,
            step.stats.free_segs_written,
            step.stats.small_sections_written,
            step.stats.small_bytes_written,
            written,
            slots.len() * SLOT_RECORD_BYTES,
        ));
    }

    let resume_slots: usize = (0..slot_page_count(manifest.slot_count))
        .map(|page| slot_page_len(manifest.slot_count, page) * SLOT_RECORD_BYTES)
        .sum();
    let resume_chunks: usize = (0..chunk_extent_count(manifest.chunk_len))
        .map(|ext| chunk_extent_len(manifest.chunk_len, ext))
        .sum();
    let resume_small = store.read_small_state().expect("small state").len();

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
    let counts = steps
        .iter()
        .map(|step| step.count.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let report = format!(
        "{{\n  \"setup\": {:?},\n  \"increment\": {:?},\n  \"discarding\": {:?},\n  \
         \"counts\": [{counts}],\n  \"canonical\": {CANONICAL_COUNT},\n  \
         \"slots_per_page\": {},\n  \"slot_record_bytes\": {},\n  \
         \"resume\": {{ \"slot_bytes\": {resume_slots}, \"chunk_bytes\": {resume_chunks}, \
         \"small_bytes\": {resume_small}, \"total\": {} }},\n  \
         \"slots\": [\n{slots}\n  ],\n  \"io\": [\n{}\n  ]\n}}\n",
        SETUP.trim(),
        BUMP,
        BUMP_DISCARDING,
        SLOTS_PER_PAGE,
        SLOT_RECORD_BYTES,
        resume_slots + resume_chunks + resume_small,
        rows.join(",\n"),
    );
    let report_path = dir.join("architecture-map-heap.counters.json");
    std::fs::write(&report_path, report).expect("write counter report");

    println!(
        "{} bytes -> {} (count {})",
        canonical.container.len(),
        container.display(),
        CANONICAL_COUNT
    );
    println!(
        "{} slot(s) track the count; {} steps measured -> {}",
        tracking.len(),
        steps.len(),
        report_path.display()
    );
    for (index, (values, role)) in &tracking {
        println!("    slot {index}: {values:?}  {role}");
    }
    drop(session);
}
