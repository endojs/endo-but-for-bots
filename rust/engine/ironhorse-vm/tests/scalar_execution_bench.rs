//! Serial release controls for VM-facing scalar module boundaries.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial scalar timing control"]
fn scalar_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("string", "var t=0; for(var i=0;i<500;i++){t+='abc'.repeat(2).indexOf('b');} t;", "500"),
        ("number", "var t=0; for(var i=0;i<500;i++){t+=Math.max(1,2,3)+(255).toString(16).length;} t;", "2500"),
        ("bigint", "var t=0; for(var i=0;i<500;i++){t+=((123n+7n)*2n).toString().length;} t;", "1500"),
        ("reflect", "var t=0; for(var i=0;i<500;i++){t+=Reflect.get({x:3},'x')+Reflect.ownKeys({x:1,y:2}).length;} t;", "2500"),
        ("resource", "var t=0; for(var i=0;i<500;i++){var s=new DisposableStack();s.defer(function(){t++;});s.dispose();} t;", "500"),
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
            assert_eq!(outcome.result, expected, "{name}");
            let actual = vm.meter_index();
            if let Some(old) = raw {
                assert_eq!(actual, old);
            }
            raw = Some(actual);
            println!("SCALAR_MODULE_SAMPLE {name} round={round} warmup={} seconds={elapsed:.9}", round == 0);
            if round > 0 {
                times.push(elapsed);
            }
        }
        times.sort_by(f64::total_cmp);
        println!("SCALAR_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
