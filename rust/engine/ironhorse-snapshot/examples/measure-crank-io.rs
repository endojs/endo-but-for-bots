//! Measure what one crank costs a paged store: how much state changes, and
//! how much the store has to write to make that change durable.
//!
//! The two are not the same number, and the gap is the point. The store's
//! unit is a page of [`SLOTS_PER_PAGE`] slots, so a crank that rewrites one
//! integer still rewrites the page that integer sits in. This example runs the
//! counter from `capture-map-heap.rs`, checkpoints after every increment, and
//! reports both the change and the write.
//!
//! Run from `rust/engine`:
//!
//! ```sh
//! cargo run --example measure-crank-io
//! ```

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{
    chunk_extent_len, slot_page_len, HeapStore, MemoryStore, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE,
};
use ironhorse_vm::{parse_symbols, Interp, SymbolName};

/// The serialized width of one slot record.
const SLOT_BYTES: usize = ironhorse_snapshot::SLOT_RECORD_BYTES;

const SETUP: &str = r#"
var counter = (function () {
  var count = 0;
  return function () { count = count + 1; return count; };
})();
var seen = 0;
seen;
"#;

const BUMP: &str = "seen = counter(); seen;";

const STEPS: u32 = 8;

fn compile(source: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Every slot record in the machine, as fixed-width rows.
fn slot_image(machine: &Interp) -> Vec<u8> {
    let signature = Signature::new("ironhorse-worker-v1");
    let container = {
        use ironhorse_snapshot::machine::MachineSnapshot;
        machine.write_snapshot(&signature).expect("serializes")
    };
    let total = u32::from_be_bytes(container[0..4].try_into().expect("size")) as usize;
    let mut offset = 8;
    while offset + 8 <= total.min(container.len()) {
        let size = u32::from_be_bytes(container[offset..offset + 4].try_into().expect("atom size"))
            as usize;
        if &container[offset + 4..offset + 8] == b"HEAP" {
            // 8 bytes of atom framing, then HEAP's 12-byte header.
            return container[offset + 20..offset + size].to_vec();
        }
        if size < 8 {
            break;
        }
        offset += size;
    }
    Vec::new()
}

/// Slot indices whose records differ, and the pages those indices fall in.
fn changed(before: &[u8], after: &[u8]) -> (Vec<usize>, Vec<u32>) {
    let slots: Vec<usize> = before
        .chunks_exact(SLOT_BYTES)
        .zip(after.chunks_exact(SLOT_BYTES))
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
    let signature = Signature::new("ironhorse-worker-v1");
    let (setup, names) = compile(SETUP);
    let (bump, bump_names) = compile(BUMP);

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&setup).completed, "setup crank");

    let mut store = MemoryStore::new();
    let mut session = begin_store_session(machine, &signature, &mut store)
        .map_err(|(_, error)| error)
        .expect("bind the store");

    let first = store.last_commit_stats();
    let total_slots = slot_image(session.machine()).len() / SLOT_BYTES;
    println!("machine: {total_slots} slots, {SLOTS_PER_PAGE} per page, {SLOT_BYTES}-byte records");
    println!(
        "initial checkpoint: {} slot pages, {} chunk extents, {} free segs, \
         {} small sections ({} bytes)",
        first.slot_pages_written,
        first.chunk_extents_written,
        first.free_segs_written,
        first.small_sections_written,
        first.small_bytes_written
    );
    println!();
    println!(
        "{:>4}  {:>7}  {:>5}  {:>7}  {:>7}  {:>8}  {:>5}  {:>7}  {:>9}  {:>6}",
        "step",
        "changed",
        "pages",
        "slotB",
        "extRows",
        "freeRows",
        "sects",
        "smallB",
        "writtenB",
        "ratio"
    );

    let mut previous = slot_image(session.machine());
    for step in 1..=STEPS {
        let linked = session
            .machine_mut()
            .relink_crank(&bump, &bump_names)
            .expect("relink");
        assert!(
            session.machine_mut().run(&linked).completed,
            "increment {step}"
        );
        checkpoint_to_store(&mut session, &signature, &mut store).expect("checkpoint");

        let stats = store.last_commit_stats();
        let current = slot_image(session.machine());
        let (slots, pages) = changed(&previous, &current);
        previous = current;

        // Charge each dirtied page its real stored width: the last page of the
        // arena is short, so assuming a full page would overstate the write.
        let manifest = store.manifest().expect("manifest");
        let slot_bytes: usize = pages
            .iter()
            .map(|page| slot_page_len(manifest.slot_count, *page) * SLOT_BYTES)
            .sum();
        let written = slot_bytes + stats.small_bytes_written;
        let touched = slots.len() * SLOT_BYTES;
        println!(
            "{:>4}  {:>7}  {:>5}  {:>7}  {:>7}  {:>8}  {:>5}  {:>7}  {:>9}  {:>5}x",
            step,
            slots.len(),
            pages.len(),
            slot_bytes,
            stats.chunk_extents_written,
            stats.free_segs_written,
            stats.small_sections_written,
            stats.small_bytes_written,
            written,
            if touched > 0 { written / touched } else { 0 }
        );
        if step == 1 {
            println!(
                "        slots {slots:?} in page(s) {pages:?} — {touched} bytes of records \
                 actually changed"
            );
        }
    }

    // What a cold resume has to read back, for comparison with the per-crank write.
    let resumed = resume_from_store(&store, &signature).expect("resume");
    let manifest = store.manifest().expect("manifest");
    let slot_rows: usize = (0..ironhorse_snapshot::store::slot_page_count(manifest.slot_count))
        .map(|page| slot_page_len(manifest.slot_count, page) * SLOT_BYTES)
        .sum();
    let extent_rows: usize = (0..ironhorse_snapshot::store::chunk_extent_count(manifest.chunk_len))
        .map(|ext| chunk_extent_len(manifest.chunk_len, ext))
        .sum();
    let small = store.read_small_state().expect("small state").len();
    println!();
    println!(
        "cold resume at epoch {}: {} slot bytes + {} chunk bytes + {} small bytes = {} total",
        resumed.epoch(),
        slot_rows,
        extent_rows,
        small,
        slot_rows + extent_rows + small
    );
    println!(
        "  ({} slots over {} pages; extent width {} bytes)",
        manifest.slot_count,
        ironhorse_snapshot::store::slot_page_count(manifest.slot_count),
        CHUNK_EXTENT_BYTES
    );
}
