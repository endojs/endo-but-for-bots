//! TEMPORARY audit verification probe (vm-boot-realm-modules). Deleted after the audit.
use ironhorse_vm::{parse_symbols, Interp, Machine};
use std::time::Instant;
fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    (code, parse_symbols(&symbols))
}
fn run(src: &str) -> (f64, u64, String) {
    let (code, names) = compile(src);
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let t = Instant::now();
    let out = vm.run(&code);
    let dt = t.elapsed().as_secs_f64();
    assert!(out.completed, "{src}: {:?}", out.halt);
    (dt, out.computrons, out.result)
}
#[test]
fn verify() {
    std::thread::Builder::new().stack_size(ironhorse_vm::NATIVE_STACK_BYTES).spawn(body).unwrap().join().unwrap();
}
fn body() {
    for (label, src) in [
        ("index_keys_20k", "var o = {}; for (var j = 0; j < 20000; j++) o[j] = j; 0"),
        ("novel_computed_keys_20k", "var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0"),
        ("novel_computed_keys_5k", "var o = {}; for (var j = 0; j < 5000; j++) o['k' + j] = j; 0"),
        ("existing_computed_keys_20k", "var o = {k0:0}; var k='k0'; for (var j = 0; j < 20000; j++) o[k] = j; 0"),
        ("json_parse_keys_20k", "var p = []; for (var j = 0; j < 20000; j++) p.push('\"k' + j + '\":' + j); var o = JSON.parse('{' + p.join(',') + '}'); 0"),
        ("fns_50k_then_novel_keys_20k", "var f = []; for (var i = 0; i < 50000; i++) f.push(function () {}); var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0"),
        ("static_reads_200k", "var p = { k: 1 }; var s = 0; for (var i = 0; i < 200000; i++) s += p.k; s"),
        ("computed_reads_200k", "var p = { k: 1 }; var k = 'k'; var s = 0; for (var i = 0; i < 200000; i++) s += p[k]; s"),
    ] {
        let (dt, c, r) = run(src);
        println!("VERIFY {label} seconds={dt:.3} computrons={c} result={r}");
    }
    // BOOT-6
    drop(Machine::new());
    let m = 5;
    let t = Instant::now();
    for _ in 0..m { drop(Machine::new()); }
    println!("VERIFY machine_new_ms={:.1}", t.elapsed().as_secs_f64() * 1e3 / m as f64);
    let t = Instant::now();
    for _ in 0..20 { drop(Interp::new()); }
    println!("VERIFY interp_new_us={:.0}", t.elapsed().as_secs_f64() * 1e6 / 20.0);
    // BOOT-5
    let mut crank = String::new();
    for i in 0..200 { crank.push_str(&format!("var fresh_{i} = {i}; ")); }
    crank.push('0');
    for keys in [0usize, 10_000, 50_000] {
        let setup = format!("var p = []; for (var j = 0; j < {keys}; j++) p.push('\"k' + j + '\":0'); var o = JSON.parse('{{' + p.join(',') + '}}'); 0");
        let (code, names) = compile(&setup);
        let mut vm = Interp::new(); vm.link_intrinsics(&names); assert!(vm.run(&code).completed);
        let (ccode, cnames) = compile(&crank);
        let t = Instant::now(); let relinked = vm.relink_crank(&ccode, &cnames).unwrap();
        let dt = t.elapsed().as_secs_f64() * 1e3; assert!(vm.run(&relinked).completed);
        let (c2, n2) = compile("fresh_1 + fresh_2");
        let t = Instant::now(); let r2 = vm.relink_crank(&c2, &n2).unwrap();
        let dt2 = t.elapsed().as_secs_f64() * 1e3; assert!(vm.run(&r2).completed);
        println!("VERIFY runtime_keys={keys} growing_relink_ms={dt:.2} reuse_relink_ms={dt2:.2}");
    }
}
