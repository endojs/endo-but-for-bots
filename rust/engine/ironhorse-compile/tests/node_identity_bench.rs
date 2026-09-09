//! F148's sparse-table cost control. Run each shape in a separate release
//! process under a peak-RSS recorder; building the binary is not timed.
use ironhorse_compile::{compile_atoms_goal_with_meter, Goal, ParseMeter};
use std::time::Instant;

#[test]
#[ignore = "serial compiler allocation/timing diagnostic"]
fn sparse_class_tables() {
    assert!(!cfg!(debug_assertions));
    let shape = std::env::var("IH_NODE_BENCH_SHAPE").unwrap();
    let n: usize = std::env::var("IH_NODE_BENCH_N").unwrap().parse().unwrap();
    let class = "class B{}; class C extends B { #x=outer; [key]=outer; static x=outer; m(){return this.#x;} }";
    let prefix = "0;".repeat(n);
    let source = match shape.as_str() {
        "early_class" => format!("{class}{prefix}"),
        "late_class" => format!("{prefix}{class}"),
        _ => panic!("unknown shape"),
    };
    let mut times = Vec::new();
    let mut expected = None;
    for round in 0..6 {
        let meter = ParseMeter::new();
        let start = Instant::now();
        let (code, symbols) =
            compile_atoms_goal_with_meter(&source, Goal::Eval, false, meter.clone()).unwrap();
        let elapsed = start.elapsed().as_secs_f64();
        let digest = code
            .iter()
            .chain(&symbols)
            .fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            });
        let result = (code.len(), symbols.len(), digest, meter.raw());
        if let Some(previous) = expected {
            assert_eq!(result, previous);
        }
        expected = Some(result);
        if round > 0 {
            times.push(elapsed);
        }
    }
    times.sort_by(f64::total_cmp);
    let (code, symbols, digest, raw) = expected.unwrap();
    println!("NODE_TABLE_METRIC shape={shape} n={n} seconds={:.9} code={code} symbols={symbols} digest={digest:016x} raw={raw}", times[2]);
}
