use ironhorse_vm::Interp;

fn crank(m: &mut Interp, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    let symbols = ironhorse_vm::parse_symbols(&symbols);
    let code = if m.program_symbol_names().is_empty() {
        m.link_intrinsics(&symbols);
        code
    } else {
        m.relink_crank(&code, &symbols).expect("relink")
    };
    let outcome = m.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

#[test]
fn recycled_objects_do_not_inherit_dead_indexed_properties() {
    let mut m = Interp::new();
    crank(
        &mut m,
        "(() => { for (let i = 0; i < 100; i++) { const dead = {}; dead[17] = 'ghost'; } })(); 0",
    );
    m.collect_garbage();
    let result = crank(&mut m, "(() => { for (let i = 0; i < 1000; i++) { const fresh = {}; if (fresh[17] !== undefined) return 'ghost'; } return 'clean'; })()");
    assert_eq!(result, "clean");
}
