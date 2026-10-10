//! Serial release controls for VM-facing collection module boundaries.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial collection timing control"]
fn collection_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("map", "var m=new Map([[1,2],[3,4]]); var t=0; for(var i=0;i<500;i++){t+=m.get(1)+m.get(3);} t;", "3000"),
        ("set", "var a=new Set([1,2]); var b=new Set([2,3]); var t=0; for(var i=0;i<500;i++){t+=a.union(b).size;} t;", "1500"),
        ("iterator", "var t=0; for(var i=0;i<500;i++){t+=Iterator.from([1,2,3]).reduce(function(a,b){return a+b;},0);} t;", "3000"),
        ("string_iterator", "var t=0; for(var i=0;i<500;i++){for(var x of 'abc'){t++;}} t;", "1500"),
        ("grouping", "var t=0; for(var i=0;i<500;i++){var g=Object.groupBy([1,2,3],function(v){return v%2;});t+=g[1].length+g[0].length;} t;", "1500"),
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
            println!("COLLECTION_MODULE_SAMPLE {name} round={round} warmup={} seconds={elapsed:.9}", round == 0);
            if round > 0 {
                times.push(elapsed);
            }
        }
        times.sort_by(f64::total_cmp);
        println!("COLLECTION_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
