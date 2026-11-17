// AUDIT PROBE (temporary): `endor run -e ironhorse` evaluates on the process
// main thread (rust/endo/src/ironhorse_engine.rs:823-830, no stack_size
// thread). Run the VM's own budget-ceiling program on an 8 MiB thread (the
// Linux default main-thread stack) in this (debug) profile.
#[test]
fn probe() {
    println!("NATIVE_STACK_BYTES (this profile) = {}", ironhorse_vm::NATIVE_STACK_BYTES);
    for src in ["var a = []; a[0] = a; a.join()", "var x = []; for (var i = 0; i < 2040; i++) x = [x]; JSON.stringify(x).length", "var s = ''; for (var i = 0; i < 2040; i++) s = '[' + s + ']'; JSON.parse(s).length", "function f(n) { if (n) [1].forEach(function () { f(n - 1); }); return n; } f(62)", "var p = {}; for (var i = 0; i < 2000; i++) p = new Proxy(p, {}); p.x", "var x = []; for (var i = 0; i < 2040; i++) x = [x]; x.flat(Infinity).length"] {
        let r = std::thread::Builder::new()
            .stack_size(8 << 20)
            .spawn(move || {
                let (code, symbols) = ironhorse_compile::compile_atoms_with(src, false).unwrap();
                let mut vm = ironhorse_vm::Interp::new();
                vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
                let o = vm.run(&code);
                format!("completed={} halt={:?}", o.completed, o.halt)
            })
            .unwrap()
            .join();
        println!("{src}: {r:?}");
    }
}
