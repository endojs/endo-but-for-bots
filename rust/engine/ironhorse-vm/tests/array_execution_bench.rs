//! Serial release controls for the array module boundary.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial array timing control"]
fn array_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("dense", "var a=[1,2,3,4,5],total=0;for(var i=0;i<1000;i++){a.push(a.shift());total+=a.length;}total;", "5000"),
        ("sparse_generic", "var total=0;for(var i=0;i<1000;i++){total+=Array.prototype.map.call({0:1,2:3,length:3},x=>x+1).join(':').length+[1,[2,3]].flat().length;}total;", "7000"),
        ("from_of", "var total=0;for(var i=0;i<1000;i++){total+=Array.from({length:4},(_,i)=>i+1).reduce((a,b)=>a+b,0)+Array.of(2,3).length;}total;", "12000"),
        ("from_async", "var total=0;for(var i=0;i<200;i++){Array.fromAsync([Promise.resolve(1),2],x=>x+1).then(a=>{total+=a[0]+a[1];});}total;", "1000"),
        ("sort_copy", "var total=0;for(var i=0;i<1000;i++){var a=[3,1,2];total+=a.toSorted()[0]+a.toReversed()[0]+a.toSpliced(1,1,4).join(':').length;}total;", "8000"),
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
            // run() drains queued jobs after capturing its completion value.
            assert_eq!(vm.global_string("total").as_deref(), Some(expected), "{name}");
            assert!(!vm.has_unhandled_rejection(), "{name}");
            let actual = vm.meter_index();
            if let Some(old) = raw { assert_eq!(actual, old); }
            raw = Some(actual);
            if round > 0 { times.push(elapsed); }
        }
        times.sort_by(f64::total_cmp);
        println!("ARRAY_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
