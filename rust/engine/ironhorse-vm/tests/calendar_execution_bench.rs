//! Serial release controls for VM-facing locale and calendar module boundaries.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial locale and calendar timing control"]
fn calendar_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("intl_number", "var f=new Intl.NumberFormat('en-US'); var t=0; for(var i=0;i<500;i++){t+=f.format(1234.5).length;} t;", "3500"),
        ("intl_list", "var f=new Intl.ListFormat('en-US'); var t=0; for(var i=0;i<500;i++){t+=f.format(['a','b']).length;} t;", "3500"),
        ("temporal", "var d=Temporal.PlainDate.from('2024-02-28'); var t=0; for(var i=0;i<500;i++){t+=d.add({days:1}).day;} t;", "14500"),
        ("date", "var d=new Date(0); var t=0; for(var i=0;i<500;i++){t+=d.getUTCFullYear();} t;", "985000"),
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
            println!("CALENDAR_MODULE_SAMPLE {name} round={round} warmup={} seconds={elapsed:.9}", round == 0);
            if round > 0 {
                times.push(elapsed);
            }
        }
        times.sort_by(f64::total_cmp);
        println!("CALENDAR_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
