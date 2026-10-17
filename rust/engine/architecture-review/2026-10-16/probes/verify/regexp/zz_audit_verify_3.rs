use ironhorse_vm::Interp;

fn run(src: &str) -> (u64, std::time::Duration) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let t = std::time::Instant::now();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    (out.computrons, t.elapsed())
}

#[test]
fn per_exec_subject_cost() {
    for len in [16u32, 1 << 22] {
        let mk = |iters: u32| format!("var s='b'.repeat({len}); var r=/a/y; var c=0; for (var i=0;i<{iters};i++) {{ r.lastIndex=0; if (r.test(s)) c++; }} c;");
        let (c1, t1) = run(&mk(1));
        let (c201, t201) = run(&mk(201));
        println!("len={len}: computrons/exec={} wall/exec={:?}", (c201 - c1) / 200, (t201 - t1) / 200);
    }
}
