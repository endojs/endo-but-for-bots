//! Serial release controls for Promise native method boundaries.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial native Promise timing control"]
fn promise_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("constructor_then", "var total=0; for(var i=0;i<1000;i++){new Promise(function(resolve){resolve(3);}).then(function(v){total+=v;});} 0;", "3000"),
        ("thenable", "var total=0; for(var i=0;i<1000;i++){Promise.resolve({then:function(resolve){resolve(7);}}).then(function(v){total+=v;});} 0;", "7000"),
        ("finally", "var total=0; for(var i=0;i<1000;i++){Promise.resolve(3).finally(function(){total+=2;}).then(function(v){total+=v;});} 0;", "5000"),
        ("combinators", "var total=0; for(var i=0;i<500;i++){Promise.all([1,Promise.resolve(2)]).then(function(v){total+=v[0]+v[1];}); Promise.any([Promise.reject(0),Promise.resolve(4)]).then(function(v){total+=v;});} 0;", "3500"),
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let symbols = parse_symbols(&symbols);
        let mut times = Vec::new();
        let mut raw = None;
        for round in 0..6 {
            let mut vm = Interp::new();
            vm.link_intrinsics(&symbols);
            let start = Instant::now();
            let outcome = vm.run(&code);
            let elapsed = start.elapsed().as_secs_f64();
            assert!(outcome.completed, "{name}: {:?}", outcome.halt);
            // run includes the job drain, but its completion value precedes
            // that drain. Read the settled global after timing instead.
            assert_eq!(vm.global_string("total").as_deref(), Some(expected), "{name}");
            assert!(!vm.has_unhandled_rejection(), "{name}");
            let actual = vm.meter_index();
            if let Some(old) = raw { assert_eq!(actual, old); }
            raw = Some(actual);
            if round > 0 { times.push(elapsed); }
        }
        times.sort_by(f64::total_cmp);
        println!("PROMISE_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
