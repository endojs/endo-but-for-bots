use ironhorse_vm::Interp;

#[test]
fn step_limit_does_not_bound_matcher() {
    for n in [16u32, 20, 22] {
        let src = format!("var r = /(a+)+$/.test('a'.repeat({n}) + '!'); r;");
        let (code, symbols) = ironhorse_compile::compile_atoms(&src).unwrap();
        let names = ironhorse_vm::parse_symbols(&symbols);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        let t = std::time::Instant::now();
        let out = vm.run_bounded(&code, 1_000);
        println!("n={n} step_limit=1000 halt={:?} completed={} dispatched={} computrons={} wall={:?}", out.halt, out.completed, out.dispatched, out.computrons, t.elapsed());
    }
}
