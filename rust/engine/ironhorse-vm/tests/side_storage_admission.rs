//! B7/B8: guest-sized side storage is admitted against the chunk ceiling.
//!
//! Array items, index properties, Map/Set entries and `Intl.Segmenter`
//! results live in host side tables. They are charged against the chunk
//! ceiling at declared 64-bit widths, by capacity class (`side_storage.rs`),
//! so a guest that keeps growing them halts with an uncatchable
//! `HeapExhausted` at a deterministic computron count instead of exhausting
//! host memory. The same counts are reproduced on `wasm32-wasip1` under
//! Wasmtime with the stack-lanes probe
//! (`ih-stack-probe source --slot-ceiling=50000 --chunk-ceiling=1048576`).
//!
//! The slot ceiling is 50,000 throughout, the figure `WASM-BLOCKERS.md` B7
//! used to show side tables escaping it. Side storage holds no slot records,
//! so the slot ceiling alone never bounded it; the chunk ceiling does now.
use ironhorse_vm::{Halt, Interp};

const SLOT_CEILING: u32 = 50_000;
const CHUNK_CEILING: usize = 1024 * 1024;

fn machine(source: &str) -> (Interp, Vec<u8>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    vm.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
    vm.set_slot_ceiling(SLOT_CEILING).unwrap();
    vm.set_chunk_ceiling(CHUNK_CEILING).unwrap();
    (vm, code)
}

/// Run `source` under the test ceilings: (halt, result, computrons).
fn run(source: &str) -> (Halt, String, u64) {
    let (mut vm, code) = machine(source);
    let out = vm.run(&code);
    let (charged, derived) = vm.side_storage_parity();
    assert_eq!(charged, derived, "{source}: ledger drifted from the tables");
    assert!(
        vm.chunks().byte_size() as u64 + charged <= CHUNK_CEILING as u64,
        "{source}: the ceiling bounds chunks and side storage together"
    );
    (out.halt, out.result, out.computrons)
}

fn assert_halts_at(source: &str, computrons: u64) {
    let first = run(source);
    assert_eq!(first.0, Halt::HeapExhausted, "{source}: {:?}", first.1);
    assert_eq!(first.2, computrons, "{source}: pinned halt point");
    assert_eq!(run(source), first, "{source}: deterministic");
    // A guest handler cannot observe the halt.
    let guarded = format!("try {{ {source} }} catch (e) {{ 'caught' }}");
    assert_eq!(run(&guarded).0, Halt::HeapExhausted, "{guarded}");
}

#[test]
fn map_entries_halt_at_the_ceiling() {
    assert_halts_at(
        "var m = new Map(); var i = 0; for (;;) { m.set(i, i); i++; }",
        206_989,
    );
}

#[test]
fn set_entries_halt_at_the_ceiling() {
    assert_halts_at(
        "var s = new Set(); var i = 0; for (;;) { s.add(i); i++; }",
        186_474,
    );
}

#[test]
fn array_items_halt_at_the_ceiling() {
    assert_halts_at(
        "var a = []; var i = 0; for (;;) { a.push(i); i++; }",
        475_194,
    );
}

#[test]
fn index_properties_halt_at_the_ceiling() {
    assert_halts_at(
        "var o = {}; var i = 0; for (;;) { o[i] = i; i++; }",
        430_133,
    );
}

#[test]
fn segmenter_segments_halt_at_the_ceiling() {
    assert_halts_at(
        "var seg = new Intl.Segmenter('en', { granularity: 'grapheme' }); \
         var t = 'abcdefgh'.repeat(512); var kept = []; \
         for (;;) { kept.push(seg.segment(t)); }",
        369,
    );
}

#[test]
fn deleted_entries_are_not_charged_and_do_not_accumulate() {
    // Tombstones are compacted before they outnumber the live entries, so
    // set/delete churn on distinct keys runs in bounded storage. Charged at
    // 96 bytes each, these 25,000 entries would pass the 1 MiB ceiling twice.
    let (halt, result, _) = run("var m = new Map(); var s = new Set(); \
         for (var i = 0; i < 12500; i++) { m.set(i, i); m.delete(i); s.add(i); s.delete(i); } \
         m.size + s.size");
    assert_eq!((halt, result.as_str()), (Halt::Return, "0"));
}

#[test]
fn released_storage_can_be_charged_again() {
    // Clearing, popping and truncating release their charge at once. Each
    // round charges 640 KiB (an 8,192-item class and a 4,096-entry class),
    // so a missing release passes the 1 MiB ceiling in the second round.
    let (halt, result, _) = run("var n = 0; \
         for (var round = 0; round < 4; round++) { \
           var a = []; for (var i = 0; i < 5000; i++) a.push(i); \
           while (a.length > 10) a.pop(); a.length = 0; \
           var m = new Map(); for (var i = 0; i < 2500; i++) m.set(i, i); m.clear(); \
           n++; } n");
    assert_eq!((halt, result.as_str()), (Halt::Return, "4"));
}

#[test]
fn ledger_follows_every_table_mutation_and_collection() {
    let source = "var a = [5, 3, 1]; var o = {}; var m = new Map(); var s = new Set(); \
         var w = new WeakMap(); var keys = []; \
         for (var i = 0; i < 300; i++) { a.push(i); o[i] = i; m.set('k' + i, i); s.add(i); \
           var k = {}; keys.push(k); w.set(k, i); } \
         a.shift(); a.unshift(1, 2, 3); a.splice(10, 50, 'x', 'y'); a.reverse(); a.sort(); \
         a.fill(0, 5, 9); a.length = 100; delete a[3]; a.copyWithin(0, 50); \
         for (var i = 0; i < 200; i++) { m.delete('k' + i); s.delete(i); delete o[i]; w.delete(keys[i]); } \
         var it = m.keys(); it.next(); m.set('late', 1); \
         var seg = new Intl.Segmenter('en', { granularity: 'word' }).segment('a b c d'); \
         var f = new Intl.ListFormat('en').formatToParts(['a', 'b', 'c']); \
         Array.from(m.values()).concat(Object.keys(o)).flat().length";
    let (mut vm, code) = machine(source);
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    let (charged, derived) = vm.side_storage_parity();
    assert_eq!(charged, derived);
    assert!(charged > 0);
    vm.collect_garbage().expect("collect");
    let (charged, derived) = vm.side_storage_parity();
    assert_eq!(charged, derived, "collection re-derives the ledger");
}

#[test]
fn list_format_type_error_still_precedes_any_admission() {
    // Native threw this catchable TypeError while wasm32 ran out of memory
    // copying the 2,000 references first; the list is no longer copied.
    let (halt, result, _) = run("var s = 'x'.repeat(100000); var list = []; \
         for (var i = 0; i < 2000; i++) list.push(s); list.push(1); \
         try { new Intl.ListFormat('en').format(list); 'formatted' } \
         catch (e) { e instanceof TypeError }");
    assert_eq!((halt, result.as_str()), (Halt::Return, "true"));
}

#[test]
fn guest_amplified_host_copies_are_refused_before_they_grow() {
    for source in [
        "var s = 'x'.repeat(100000); var list = []; \
         for (var i = 0; i < 100; i++) list.push(s); new Intl.ListFormat('en').format(list)",
        "var s = 'x'.repeat(100000); var list = []; \
         for (var i = 0; i < 100; i++) list.push(s); \
         new Intl.ListFormat('en').formatToParts(list).length",
        "new Uint8Array(1000).join('y'.repeat(10000)).length",
        "new Uint8Array(750000).toLocaleString().length",
        "Array(100).fill('x'.repeat(100000)).toLocaleString().length",
        "var s = 'a'.repeat(100000); var p = []; \
         for (var i = 0; i < 100; i++) p.push(s); p.push(''); Function.apply(null, p).length",
    ] {
        let first = run(source);
        assert_eq!(first.0, Halt::HeapExhausted, "{source}: {:?}", first.1);
        assert_eq!(run(source), first, "{source}: deterministic");
    }
}
