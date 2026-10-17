//! TEMPORARY audit probe (vm-boot-realm-modules). Deleted after the audit.
//! Crank relink cost as the machine's name table grows with runtime keys.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    (code, parse_symbols(&symbols))
}

#[test]
fn relink_cost_vs_table_size() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(body)
        .unwrap()
        .join()
        .unwrap();
}

fn body() {
    // A crank naming 200 fresh identifiers.
    let mut crank = String::new();
    for i in 0..200 {
        crank.push_str(&format!("var fresh_{i} = {i}; "));
    }
    crank.push('0');
    for keys in [0usize, 10_000, 50_000] {
        let setup = format!(
            "var p = []; for (var j = 0; j < {keys}; j++) p.push('\"k' + j + '\":0'); \
             var o = JSON.parse('{{' + p.join(',') + '}}'); 0"
        );
        let (code, names) = compile(&setup);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        let out = vm.run(&code);
        assert!(out.completed, "{:?}", out.halt);
        let (ccode, cnames) = compile(&crank);
        let t = Instant::now();
        let relinked = vm.relink_crank(&ccode, &cnames).unwrap();
        let dt = t.elapsed().as_secs_f64() * 1e3;
        let out = vm.run(&relinked);
        assert!(out.completed, "{:?}", out.halt);
        // A second crank reusing names already in the table (no growth).
        let (c2, n2) = compile("fresh_1 + fresh_2");
        let t = Instant::now();
        let r2 = vm.relink_crank(&c2, &n2).unwrap();
        let dt2 = t.elapsed().as_secs_f64() * 1e3;
        assert!(vm.run(&r2).completed);
        println!(
            "AUDIT runtime_keys={keys} growing_relink_ms={dt:.2} reuse_relink_ms={dt2:.2}"
        );
    }
}
