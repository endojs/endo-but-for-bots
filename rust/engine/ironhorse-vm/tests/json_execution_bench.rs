//! Serial release controls for the JSON native module boundary.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial native JSON timing control"]
fn json_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("parse", "var total=0; for(var i=0;i<2000;i++){var v=JSON.parse('{\"a\":[1,2,3],\"b\":\"text\"}'); total+=v.a[0]+v.a[1]+v.a[2];} total;", "12000"),
        ("reviver", "var total=0; for(var i=0;i<2000;i++){var v=JSON.parse('{\"a\":[1,2],\"b\":3}',function(k,v){return typeof v==='number'?v+1:v;}); total+=v.a[0]+v.a[1]+v.b;} total;", "18000"),
        ("stringify", "var total=0; var v={a:[1,2,3],b:'text'}; for(var i=0;i<2000;i++){total+=JSON.stringify(v).length;} total;", "48000"),
        ("to_json_replacer", "var total=0; var v={toJSON:function(){return [9,99,999];}}; for(var i=0;i<2000;i++){total+=JSON.stringify(v,function(k,v){return typeof v==='number'?v+1:v;}).length;} total;", "26000"),
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
            if round > 0 { times.push(elapsed); }
        }
        times.sort_by(f64::total_cmp);
        println!("JSON_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
