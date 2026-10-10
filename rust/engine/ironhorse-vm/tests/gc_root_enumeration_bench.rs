//! Serial release control for the generated GC root walk.
use ironhorse_vm::Interp;
use std::hint::black_box;
use std::time::Instant;

#[test]
#[ignore = "serial GC root enumeration timing control"]
fn root_enumeration() {
    assert!(!cfg!(debug_assertions));
    let expected = Interp::new().gc_roots();
    let mut times = Vec::new();
    for round in 0..6 {
        let vm = Interp::new();
        assert_eq!(vm.gc_roots(), expected);
        let raw = vm.meter_index();
        let start = Instant::now();
        for _ in 0..5000 {
            black_box(vm.gc_roots());
        }
        let elapsed = start.elapsed().as_secs_f64();
        println!(
            "ROOT_ENUM_SAMPLE round={round} warmup={} seconds={elapsed:.9}",
            round == 0
        );
        assert_eq!(vm.gc_roots(), expected);
        assert_eq!(vm.meter_index(), raw);
        if round > 0 {
            times.push(elapsed);
        }
    }
    times.sort_by(f64::total_cmp);
    println!("ROOT_ENUM_METRIC seconds={:.9}", times[2]);
    println!(
        "ROOT_ENUM_VALUES {:?}",
        expected.iter().map(|r| r.0).collect::<Vec<_>>()
    );
}
