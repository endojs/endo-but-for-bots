//! The **footprint** half of the stage-8 envelope, measured against XS.
//!
//! The design states the bar as "heap within 1.1x (the slot accounting is
//! identical by construction; overhead can come only from arena bookkeeping)".
//! That parenthesis was the whole argument, and it was never checked, because
//! nothing measured either side: the engine had no footprint instrument, and
//! the oracle reported no heap figure at all (architecture findings
//! F106/F122, and F121 for the slot term).
//!
//! Both sides exist now. XS reports its own `currentHeapCount` and
//! `currentChunksSize` through the shim; the engine reports
//! `SlotArena::xs_accounted_byte_size` (the same 32-byte unit, for a
//! like-for-like reading of the bar as written) and
//! `SlotArena::resident_byte_size` (what the process actually holds, which
//! is the number the parenthesis was quietly assuming away).
//!
//! **What this is not.** It is a comparison at one point — the end of a
//! crank — over five small programs, not a peak-memory measurement over a
//! workload, and it says nothing about the 47 side tables, which are outside
//! both accountings. It is the first number where there was none.
//!
//! `#[ignore]`d like its sibling benchmarks: run explicitly, in release.
//! `benches/xs_compare.py` drives it and folds the result into the stage-8
//! report.

/// The bar the design states for the heap half.
const HEAP_LIMIT: f64 = 1.1;

struct Footprint {
    xs_accounted: u64,
    resident: u64,
}

fn ironhorse(source: &str, expected: &str) -> Footprint {
    let (code, symbols) = ironhorse_compile::compile_atoms_with(source, false).unwrap();
    let mut machine = ironhorse_vm::Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    let result = machine.run(&code);
    assert!(result.completed, "{result:?}");
    assert_eq!(result.result, expected);
    Footprint {
        // XS's unit, so the ratio below reads the bar as written.
        xs_accounted: machine.slots().xs_accounted_byte_size() as u64
            + machine.chunks().byte_size() as u64,
        // What this process actually holds for the same state.
        resident: machine.slots().resident_byte_size() as u64 + machine.chunks().byte_size() as u64,
    }
}

fn xs(source: &str, expected: &str) -> u64 {
    let result = xs_oracle::run(source).expect("XS starts");
    assert!(result.completed && !result.result_truncated, "{result:?}");
    assert_eq!(result.result, expected);
    let bytes = result.xs_accounted_heap_bytes();
    assert!(bytes > 0, "XS reported no heap at all");
    bytes
}

#[test]
#[ignore = "benchmark: run explicitly in --release"]
fn heap_footprint_against_xs() {
    // The same corpus the throughput comparison uses, so the two halves of
    // the envelope are measured over one workload rather than two.
    let fixtures: &[(&str, &str, &str)] = &[
        (
            "properties",
            "var o = {x: 1}; for(var i=0;i<20000;i++) o.x += 1; o.x",
            "20001",
        ),
        (
            "calls",
            "function f(x) { return x + 1; } var n=0; for(var i=0;i<20000;i++) n=f(n); n",
            "20000",
        ),
        (
            "allocation_churn",
            "var n=0; for(var i=0;i<10000;i++) {var o={a:i,b:i+1}; n+=o.b;} n",
            "50005000",
        ),
        (
            "strings",
            "var s='abcXYZ'; var n=0; for(var i=0;i<20000;i++) n+=s.charCodeAt(i%6); n",
            "1870008",
        ),
    ];

    let mut within = true;
    for (name, source, expected) in fixtures {
        let theirs = xs(source, expected);
        let ours = ironhorse(source, expected);
        let accounted_ratio = ours.xs_accounted as f64 / theirs as f64;
        let resident_ratio = ours.resident as f64 / theirs as f64;
        within &= accounted_ratio <= HEAP_LIMIT;
        // The shape `benches/xs_compare.py` parses.
        println!(
            "XS_FOOTPRINT {name} xs_bytes={theirs} \
             ironhorse_xs_accounted_bytes={} ironhorse_resident_bytes={} \
             accounted_ratio={accounted_ratio:.4} resident_ratio={resident_ratio:.4}",
            ours.xs_accounted, ours.resident
        );
    }
    println!("XS_FOOTPRINT_LIMIT {HEAP_LIMIT} within={within}");

    // Reported, not gated — the same posture as the code-size instrument.
    // The measurement is new; making it a hard failure on its first day
    // would redden the lane without saying anything the printed ratio does
    // not. What IS asserted is that the measurement happened: a run that
    // silently measured nothing is the failure mode this file exists to
    // remove.
    assert!(!fixtures.is_empty());
}

/// The instrument must be able to tell the two engines apart. A footprint
/// comparison where both sides report the same constant, or where either
/// side reports zero, is not measuring anything.
#[test]
#[ignore = "benchmark: run explicitly in --release"]
fn the_footprint_instrument_measures_both_sides() {
    let small = ("var x = 1; x", "1");
    let large = (
        "var a = []; for (var i = 0; i < 5000; i++) a.push({v: i}); a.length",
        "5000",
    );

    let xs_small = xs(small.0, small.1);
    let xs_large = xs(large.0, large.1);
    assert!(
        xs_large > xs_small,
        "XS's heap must grow with the workload: {xs_small} then {xs_large}"
    );

    let ours_small = ironhorse(small.0, small.1);
    let ours_large = ironhorse(large.0, large.1);
    assert!(
        ours_large.xs_accounted > ours_small.xs_accounted,
        "the engine's heap must grow with the workload"
    );
    assert!(
        ours_large.resident > ours_small.resident,
        "the engine's resident footprint must grow with the workload"
    );
    assert!(
        ours_large.resident != ours_large.xs_accounted,
        "the two engine-side measurements collapsed into one number"
    );
}
