//! Serial release controls for the regexp/string-protocol module boundary.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial native regexp timing control"]
fn regexp_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("exec", "var r=/(ab)+/g; var total=0; for(var i=0;i<3000;i++){r.lastIndex=0; var m=r.exec('zzababyy'); total+=m.index+m[0].length;} total;", "18000"),
        ("replace_generic", "var r=/a/g; var original=r.exec; r.exec=function(s){return original.call(this,s);}; var total=0; for(var i=0;i<3000;i++){total+='banana'.replace(r,'xx').length;} total;", "27000"),
        ("split_match_all", "var total=0; for(var i=0;i<2000;i++){total+='a1b2c'.split(/\\d/).length; var it='a1a2'.matchAll(/a\\d/g); total+=it.next().value[0].length; total+=it.next().value[0].length;} total;", "14000"),
        ("unicode_empty_replace", "var total=0; for(var i=0;i<3000;i++){total+='😀x'.replaceAll(/(?:)/gu,'_').length;} total;", "18000"),
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
        println!("REGEXP_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
