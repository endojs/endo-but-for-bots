//! F045 control: writes to an existing property must retain the name index.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "property lookup benchmark: release timing"]
fn existing_property_updates_are_independent_of_object_size() {
    assert!(!cfg!(debug_assertions));
    let (code, symbols) =
        ironhorse_compile::compile_atoms("for(var i=0;i<10000;i++){o.k0=i;} o.k0").unwrap();
    let names = parse_symbols(&symbols);
    let mut previous = None;
    let mut failures = Vec::new();
    let mut expected_cost = None;
    for n in [256, 1024, 4096, 16384] {
        let setup = format!("var o={{}}; for(var j=0;j<{n};j++){{o['k'+j]=j;}} 0");
        let (build, symbols) = ironhorse_compile::compile_atoms(&setup).unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&parse_symbols(&symbols));
        let start = Instant::now();
        let built = machine.run(&build);
        let setup_seconds = start.elapsed().as_secs_f64();
        assert!(built.completed, "{:?}", built.halt);
        let code = machine.relink_crank(&code, &names).unwrap();
        let mut times = Vec::new();
        let mut cost = (0, 0);
        let mut prior_dispatched = built.dispatched;
        for round in 0..6 {
            let raw = machine.meter_index();
            let start = Instant::now();
            let result = machine.run(&code);
            let seconds = start.elapsed().as_secs_f64();
            assert!(result.completed, "{:?}", result.halt);
            assert_eq!(result.result, "9999");
            cost = (result.meter_raw - raw, result.dispatched - prior_dispatched);
            prior_dispatched = result.dispatched;
            if round > 0 {
                if let Some(old) = expected_cost {
                    assert_eq!(cost, old);
                }
                expected_cost = Some(cost);
                times.push(seconds);
            }
        }
        times.sort_by(f64::total_cmp);
        let elapsed = times[2];
        println!("PROPERTY_UPDATE n={n} seconds={elapsed:.9} setup_seconds={setup_seconds:.9} raw={} dispatched={}",cost.0,cost.1);
        if let Some(old) = previous {
            if elapsed / old >= 2.5 {
                failures.push(n);
            }
        }
        previous = Some(elapsed);
    }
    assert!(
        failures.is_empty(),
        "existing-property updates scale with object size: {failures:?}"
    );
}
