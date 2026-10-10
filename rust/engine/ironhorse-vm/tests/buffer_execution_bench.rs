//! Serial release controls for the buffer module boundary.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial buffer timing control"]
fn buffer_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected) in [
        ("typed_index", "var a=new Uint32Array(16),total=0;for(var i=0;i<2000;i++){a[i%16]=i;total+=a[i%16];}total;", "1999000"),
        ("typed_methods", "var total=0;for(var i=0;i<500;i++){var a=Uint8Array.of(4,3,2,1);a.sort();var b=a.map(x=>x+1).slice(1);total+=b[0]+b[2];}total;", "4000"),
        ("data_view", "var v=new DataView(new ArrayBuffer(16)),total=0;for(var i=0;i<2000;i++){v.setUint32(1,i,true);total+=v.getUint32(1,true);}total;", "1999000"),
        ("buffer_slice", "var total=0;for(var i=0;i<500;i++){var b=new ArrayBuffer(16);new Uint8Array(b)[3]=7;total+=new Uint8Array(b.slice(2,6))[1];}total;", "3500"),
        ("atomics", "var a=new Int32Array(new SharedArrayBuffer(16)),total=0;for(var i=0;i<2000;i++){Atomics.store(a,0,i);total+=Atomics.add(a,0,1);}total;", "1999000"),
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
            if round > 0 {
                times.push(elapsed);
            }
        }
        times.sort_by(f64::total_cmp);
        println!("BUFFER_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}", times[2], raw.unwrap());
    }
}
