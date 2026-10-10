//! The counted-reference parity net as an integration test (F038): the
//! standing per-page counts the bulk tables' counted accessors maintain
//! must agree, to the exact count, with a fresh recount of those tables
//! after every crank and every collection — checked through the public
//! [`Interp::side_ref_parity`] entry point, which runs in every build
//! profile, rather than the `debug_assertions`/`store-integrity`-gated
//! check inside the page projection. Oracle-free, so it runs on the
//! macOS lane too.
//!
//! Each fixture drives one mutation family of one bulk table — array
//! items, ordinary index properties, collection entries — through the
//! guest paths that rebuild, displace, clear, tombstone and prune rows.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run the cranks in order on one machine, asserting parity after every
/// crank and again after a full collection at each boundary, and return
/// the last crank's result.
fn run_cranks(cranks: &[&str]) -> String {
    let mut m = Interp::new();
    let mut result = String::new();
    for (i, crank) in cranks.iter().enumerate() {
        let (b, n) = compile(crank);
        let b = if i == 0 {
            m.link_intrinsics(&n);
            b
        } else {
            m.relink_crank(&b, &n).expect("relink")
        };
        let o = m.run(&b);
        assert!(o.completed, "crank {i}: {:?}", o.halt);
        assert_eq!(m.side_ref_parity(), Ok(()), "after crank {i}");
        m.collect_garbage().expect("boundary collection");
        assert_eq!(m.side_ref_parity(), Ok(()), "after collection {i}");
        result = o.result;
    }
    result
}

#[test]
fn array_item_mutations_keep_the_counts_exact() {
    let result = run_cranks(&[
        "var a = 0; var keep = 0; a = []; keep = {}; \
         for (var i = 0; i < 40; i++) { a.push({ i: i }); } \
         a.pop(); a.shift(); a.unshift({ u: 1 }, keep); \
         a.splice(3, 5, keep, keep, { s: 1 }); a.reverse(); \
         a.sort(function (x, y) { return 0; }); \
         delete a[2]; a[100] = keep; a.length = 60; a.fill(keep, 5, 9); \
         a.copyWithin(0, 10, 20); a.length",
        "var a; var keep; a[7] = { late: 1 }; a[7] = keep; a[7] = 5; \
         a.length = 0; a.push(keep); a.concat([keep, keep]).length",
        "var a; var keep; a = [keep, keep, keep]; keep = 0; a.length",
    ]);
    assert_eq!(result, "3");
}

#[test]
fn index_property_mutations_keep_the_counts_exact() {
    let result = run_cranks(&[
        "var o = 0; var keep = 0; o = {}; keep = {}; \
         for (var i = 0; i < 40; i++) { o[i] = { i: i }; } \
         delete o[3]; o[3] = keep; o[41] = keep; o[41] = 7; \
         Object.defineProperty(o, 5, { value: keep, enumerable: false }); \
         Object.keys(o).length",
        "var o; var keep; for (var i = 0; i < 40; i++) { delete o[i]; } \
         o[0] = keep; Object.keys(o).length",
        "var o; var keep; o = { 0: keep, 1: keep }; keep = 0; Object.keys(o).length",
    ]);
    assert_eq!(result, "2");
}

#[test]
fn collection_entry_mutations_keep_the_counts_exact() {
    let result = run_cranks(&[
        "var m = 0; var s = 0; var wm = 0; var ws = 0; var keep = 0; var keys = 0; \
         m = new Map(); s = new Set(); wm = new WeakMap(); ws = new WeakSet(); \
         keep = {}; keys = []; \
         for (var i = 0; i < 40; i++) { var k = { i: i }; keys.push(k); \
           m.set(k, { v: i }); s.add(k); wm.set(k, keep); ws.add(k); } \
         m.set(keys[1], keep); m.delete(keys[2]); s.delete(keys[3]); \
         wm.delete(keys[4]); ws.delete(keys[5]); m.set(keys[2], keep); \
         m.size + ':' + s.size",
        // Drop every key the guest still names (`keys[7]` here, and the
        // loop's global `k`, the last key minted): the boundary collection
        // prunes the other dead weak entries through the counted path.
        "var m; var s; var wm; var ws; var keep; var keys; \
         keys = [keys[7]]; m.clear(); s.clear(); wm.has(keys[0]) + ':' + ws.has(keys[0])",
        "var m; var s; var wm; var ws; var keep; var keys; \
         m.set(keys[0], keys[0]); s.add(keep); keys = 0; keep = 0; m.size + ':' + s.size",
    ]);
    assert_eq!(result, "1:1");
}

/// The bulk-only comparand is exactly the three counted tables, as the
/// roster declares them — never a tail table, never one fewer.
#[test]
fn the_bulk_walk_names_exactly_the_counted_tables() {
    let bulk = ironhorse_vm::diagnostics::BULK_EDGE_SOURCE;
    let rows = ironhorse_vm::diagnostics::ROW_EDGE_SOURCE;
    assert_eq!(bulk.len(), rows.len());
    let walked: Vec<&str> = rows
        .iter()
        .zip(bulk)
        .filter(|(_, walk)| !walk.trim().is_empty())
        .map(|((field, _, _, _), _)| *field)
        .collect();
    assert_eq!(walked, ["arrays", "index_props", "collections"]);
    for ((field, _, _, _), walk) in rows.iter().zip(bulk) {
        if !walk.trim().is_empty() {
            let compact: String = walk.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(
                compact.contains(&format!("self.{field}.values()")),
                "{field}: the bulk walk must enumerate the table's rows"
            );
        }
    }
}
