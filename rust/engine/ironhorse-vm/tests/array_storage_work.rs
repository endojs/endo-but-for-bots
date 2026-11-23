//! Host work per computron of the array item store's representation changes.
//!
//! `ArrayItems` converts a store between its dense vector and its ordered map
//! in O(n). Computrons must stay proportional to host work, so a guest must not
//! be able to trigger conversions more cheaply than the operations that pay
//! for them. The store's rule makes each conversion owe one mutation per item
//! it moves (see `bulk::ArrayItems`), so the items moved by conversions are at
//! most about twice the item mutations the guest has run, whatever pattern it
//! uses. This test drives patterns aimed at the thresholds and checks the
//! deterministic work counter `array_item_conversion_work` against computrons;
//! it also prints wall time per computron beside a plain loop's, as evidence
//! only (wall time is never asserted).

use ironhorse_vm::diagnostics::array_item_conversion_work;
use ironhorse_vm::{parse_symbols, Interp};

struct Measured {
    computrons: u64,
    moved: u64,
    nanos: u128,
}

fn measure(source: &str) -> Measured {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let mut machine = Interp::new();
    machine.link_intrinsics(&parse_symbols(&symbols));
    let before = array_item_conversion_work();
    let start = std::time::Instant::now();
    let outcome = machine.run(&code);
    let nanos = start.elapsed().as_nanos();
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    Measured {
        computrons: outcome.computrons,
        moved: array_item_conversion_work() - before,
        nanos,
    }
}

/// Patterns that sit on a transition threshold and push across it on every
/// iteration, each against a loop of the same shape that does not convert.
const TOGGLES: &[(&str, &str)] = &[
    (
        "far_write_and_delete",
        "var a = []; for (var i = 0; i < 20000; i++) a.push(i); \
         for (var k = 0; k < 20000; k++) { a[400000] = 1; delete a[400000]; a[k] = k; } a.length",
    ),
    (
        "thin_past_the_leave_rule",
        "var a = []; for (var i = 0; i < 20000; i++) a.push(i); \
         for (var i = 0; i < 20000; i += 2) delete a[i]; \
         delete a[1]; delete a[3]; \
         for (var k = 0; k < 20000; k++) { delete a[5]; a[5] = 5; a[7] = 7; } a.length",
    ),
    (
        "push_pop_at_the_span_bound",
        "var a = []; a[0] = 0; for (var i = 1; i < 10000; i++) a[i * 2] = i; \
         for (var k = 0; k < 20000; k++) { a.push(k); a.pop(); a[k % 20000] = k; } a.length",
    ),
    (
        "length_shrink_and_regrow",
        "var a = []; for (var i = 0; i < 20000; i++) a.push(i); \
         for (var k = 0; k < 2000; k++) { a[100000 + k] = 1; a.length = 20000; } a.length",
    ),
];

const PLAIN: &str = "var a = []; for (var i = 0; i < 20000; i++) a.push(i); \
     for (var k = 0; k < 20000; k++) { a[k] = 1; a[k] = k; a[k] = k; } a.length";

#[test]
fn conversions_are_paid_for_by_the_operations_before_them() {
    let plain = measure(PLAIN);
    eprintln!(
        "ARRAY_WORK plain computrons={} moved={} ns_per_computron={:.1}",
        plain.computrons,
        plain.moved,
        plain.nanos as f64 / plain.computrons as f64
    );
    for (name, source) in TOGGLES {
        let m = measure(source);
        let per = m.moved as f64 / m.computrons as f64;
        eprintln!(
            "ARRAY_WORK {name} computrons={} moved={} moved_per_computron={per:.4} ns_per_computron={:.1}",
            m.computrons,
            m.moved,
            m.nanos as f64 / m.computrons as f64
        );
        // Every guest item mutation costs at least one computron, and each
        // conversion moves at most the items earlier mutations paid for, so
        // the items moved stay within twice the computrons.
        // Each pattern holds at most 20,000 items and toggles 2,000-20,000
        // times; the debt rule leaves it a bounded number of conversions.
        assert!(m.moved <= 3 * 20_001, "{name}: {} items moved", m.moved);
        assert!(
            m.moved <= 2 * m.computrons,
            "{name}: {} items moved for {} computrons",
            m.moved,
            m.computrons
        );
    }
}
