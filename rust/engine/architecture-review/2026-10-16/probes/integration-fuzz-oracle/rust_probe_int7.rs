// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
// `endor run -e ironhorse` evaluates on the process MAIN thread
// (rust/endo/src/ironhorse_engine.rs:823-830 called from endor.rs:146), whose
// size the OS decides (8 MiB Linux default, `ulimit -s`; 1 MiB on Windows).
// Every other IronHorse host spawns a NATIVE_STACK_BYTES thread. Run the VM's
// own budget-ceiling programs on a thread of AUDIT_STACK_KB.
#[test]
fn probe() {
    let kb: usize = std::env::var("AUDIT_STACK_KB").unwrap().parse().unwrap();
    let src = std::env::var("AUDIT_SRC").unwrap();
    println!("NATIVE_STACK_BYTES={} thread={} KiB src={src}", ironhorse_vm::NATIVE_STACK_BYTES, kb);
    let r = std::thread::Builder::new()
        .stack_size(kb * 1024)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms_with(&src, false).unwrap();
            let mut vm = ironhorse_vm::Interp::new();
            vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
            let o = vm.run(&code);
            format!("completed={} halt={:?}", o.completed, o.halt)
        })
        .unwrap()
        .join();
    println!("RESULT {r:?}");
}
