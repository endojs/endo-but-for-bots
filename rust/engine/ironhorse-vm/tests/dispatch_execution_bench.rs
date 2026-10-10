//! Longer serial diagnostic for dispatch factoring.
//! This supplements the 2,000-iteration property controls and the pinned gate;
//! it does not replace either or alter their thresholds.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial extended dispatch timing control"]
fn dispatch_execution_longer() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("ordinary", "var o={x:1,y:2},total=0; for(var i=0;i<20000;i++){o.x+=1;total+=o.y;} total+o.x;", "60001"),
        ("indexed", "var a=[1,2,3]; for(var i=0;i<20000;i++){a[i%3]+=1;} a[0]+a[1]+a[2];", "20006"),
        ("proxy", "var o={x:1},total=0; var p=new Proxy(o,{get(t,k,r){return Reflect.get(t,k,r)},set(t,k,v,r){return Reflect.set(t,k,v,r)}}); for(var i=0;i<20000;i++){p.x=p.x+1;total+=p.x;} total;", "200030000"),
        ("descriptors", "var total=0; for(var i=0;i<20000;i++){var o={x:3};Object.defineProperty(o,'y',{get(){return 7},enumerable:true});Object.freeze(o);total+=Reflect.ownKeys(o).length+o.y+!Object.getOwnPropertyDescriptor(o,'x').writable;} total;", "200000"),
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
            if let Some(old) = raw { assert_eq!(actual, old); }
            raw = Some(actual);
            println!("DISPATCH_MODULE_SAMPLE {name} round={round} warmup={} seconds={elapsed:.9} raw={actual} result={expected}", round == 0);
            if round > 0 { times.push(elapsed); }
        }
        times.sort_by(f64::total_cmp);
        println!("DISPATCH_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
