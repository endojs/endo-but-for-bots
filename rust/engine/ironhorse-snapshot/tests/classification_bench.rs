//! F119 dispatch medians; compile/link/realm boot are outside the timer.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "dispatch classification benchmark: release timing"]
fn property_and_callee_classification() {
    assert!(!cfg!(debug_assertions));
    for realm in ["small", "populated"] {
        for (name, source, expected) in [
            (
                "ordinary_get",
                "var o={x:1}; var s=0; for(var i=0;i<500000;i++){s+=o.x;} s",
                "500000",
            ),
            (
                "plain_call",
                "function f(x){return x+1;} var s=0; for(var i=0;i<500000;i++){s=f(s);} s",
                "500000",
            ),
            (
                "array_length",
                "var a=[1,2,3]; var s=0; for(var i=0;i<500000;i++){s+=a.length;} s",
                "1500000",
            ),
            (
                "native_call",
                "var s=0; for(var i=0;i<500000;i++){s+=Math.abs(-1);} s",
                "500000",
            ),
        ] {
            let setup = if realm == "populated" {
                "var keep=[new Map(),new Set(),new Uint8Array(4),new ArrayBuffer(4),new DataView(new ArrayBuffer(4)),/x/,new String('x'),new Intl.Locale('en'),new Intl.Collator('en'),new Proxy({}, {})];"
            } else {
                ""
            };
            let source = format!("{setup}{source}");
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let names = parse_symbols(&symbols);
            let mut times = Vec::new();
            let mut charge = None;
            for round in 0..6 {
                let mut machine = Interp::new();
                machine.link_intrinsics(&names);
                let start = Instant::now();
                let result = machine.run(&code);
                let seconds = start.elapsed().as_secs_f64();
                assert!(result.completed, "{:?}", result.halt);
                assert_eq!(result.result, expected);
                let current = (result.meter_raw, result.dispatched);
                if let Some(old) = charge {
                    assert_eq!(old, current);
                }
                charge = Some(current);
                if round > 0 {
                    times.push(seconds);
                }
            }
            times.sort_by(f64::total_cmp);
            let (raw, dispatched) = charge.unwrap();
            println!(
                "CLASSIFICATION {realm}_{name} seconds={:.9} raw={raw} dispatched={dispatched}",
                times[2]
            );
        }
    }
}
