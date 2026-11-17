use ironhorse_vm::{parse_symbols, ChunkOffset, Halt, Interp, Kind, Payload, RunOutcome, Slot, SlotIndex};
use std::mem::size_of;

fn measure(label: &str, src: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let symbols = parse_symbols(&symbols);
    let mut vm = Interp::new();
    vm.link_intrinsics(&symbols);
    let s0 = vm.slots().live_count();
    let c0 = vm.chunks().byte_size();
    let m0 = vm.meter_index();
    let out = vm.run(&code);
    let s1 = vm.slots().live_count();
    let c1 = vm.chunks().byte_size();
    println!(
        "AUDIT {label}: completed={} halt={:?} slots+={} chunk_bytes+={} raw_meter+={}",
        out.completed, out.halt, s1 - s0, c1 - c0, vm.meter_index() - m0
    );
}

#[test]
fn zz_audit_vmcore_sizes_and_allocation() {
    println!("AUDIT size_of Slot={} Payload={} Kind={} SlotIndex={} ChunkOffset={} Option<Slot>={} Halt={} RunOutcome={} Result<Slot,Halt>={}",
        size_of::<Slot>(), size_of::<Payload>(), size_of::<Kind>(), size_of::<SlotIndex>(),
        size_of::<ChunkOffset>(), size_of::<Option<Slot>>(), size_of::<Halt>(), size_of::<RunOutcome>(),
        size_of::<Result<Slot, Halt>>());
    println!("AUDIT size_of Interp={}", size_of::<Interp>());
    measure("baseline", "(function(){})();");
    measure("1000 arrows", "(function(){ var f; for (var i=0;i<1000;i++){ f = x => x; } })();");
    measure("1000 arrows +constructor named", "var constructor; (function(){ var f; for (var i=0;i<1000;i++){ f = x => x; } })();");
    measure("1000 methods", "(function(){ var o; for (var i=0;i<1000;i++){ o = { m() {} }; } })();");
    measure("1000 fn exprs", "(function(){ var f; for (var i=0;i<1000;i++){ f = function () {}; } })();");
    measure("1000 named fn exprs", "(function(){ var f; for (var i=0;i<1000;i++){ f = function someLongFunctionName () {}; } })();");
    measure("1000 calls 3 locals", "(function(){ function f(a){ var x=a, y=x+1, z=y+1; return z; } for (var i=0;i<1000;i++){ f(i); } })();");
    measure("1000 calls with try", "(function(){ function f(a){ try { var x=a; return x; } catch (e) {} } for (var i=0;i<1000;i++){ f(i); } })();");
    measure("1000 string literals", "(function(){ var s; for (var i=0;i<1000;i++){ s = 'abcdefgh'; } })();");
    measure("1000 let-block closures", "(function(){ var f; for (let i=0;i<1000;i++){ f = function(){ return i; }; } })();");
}
