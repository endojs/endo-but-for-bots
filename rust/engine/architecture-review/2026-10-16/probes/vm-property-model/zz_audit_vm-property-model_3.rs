//! TEMPORARY audit probe (vm-property-model region, run 3). Not part of the tree.
//! Computrons charged per operation for the workloads whose host time the JS
//! probes measured, so host-time-per-computron can be compared.

fn run(source: &str) -> (u64, bool, String) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let out = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
    (out.computrons, out.completed, format!("{:?}", out.halt))
}

#[test]
fn computrons_per_op() {
    let build = "var parts = []; for (var i = 0; i < 8000; i++) parts.push('\"k' + i + '\":' + i); var o = JSON.parse('{' + parts.join(',') + '}'); var ks = Object.keys(o);";
    let cases: Vec<(&str, String, f64)> = vec![
        ("queue_base", format!("{build}"), 1.0),
        ("queue_500", format!("{build} for (var i = 0; i < 500; i++) {{ delete o[ks[i]]; o[ks[i]] = i; }}"), 500.0),
        ("loop_base_500", format!("{build} for (var i = 0; i < 500; i++) {{ ks[i]; ks[i]; }}"), 500.0),
        ("small_set_500", format!("{build} var q = {{a: 1}}; for (var i = 0; i < 500; i++) {{ ks[i]; q.a = i; }}"), 500.0),
        ("fn_static_10k", "(function(){ var o = {alpha: 1}; var s = 0; for (var i = 0; i < 10000; i++) { s += o.alpha; } })();".to_string(), 10000.0),
        ("fn_computed_10k", "(function(){ var o = {alpha: 1}; var k = 'alpha'; var s = 0; for (var i = 0; i < 10000; i++) { s += o[k]; } })();".to_string(), 10000.0),
        ("keys_base", "var parts = []; for (var i = 0; i < 5000; i++) parts.push('\"key_number_' + i + '\":' + i); var o = JSON.parse('{' + parts.join(',') + '}');".to_string(), 1.0),
        ("keys_5x5000", "var parts = []; for (var i = 0; i < 5000; i++) parts.push('\"key_number_' + i + '\":' + i); var o = JSON.parse('{' + parts.join(',') + '}'); for (var r = 0; r < 5; r++) Object.keys(o);".to_string(), 25000.0),
    ];
    let mut got = std::collections::BTreeMap::new();
    for (name, src, _) in &cases {
        let t = std::time::Instant::now();
        let (c, done, halt) = run(src);
        println!("{name:20} computrons={c:>12} completed={done} halt={halt} t={:?}", t.elapsed());
        got.insert(name.to_string(), c);
    }
    let d = |a: &str, b: &str, n: f64| (got[a] as f64 - got[b] as f64) / n;
    println!("queue op (delete+set, N=8000): {:.1} computrons/op", d("queue_500", "loop_base_500", 500.0));
    println!("small-object set: {:.1} computrons/op", d("small_set_500", "loop_base_500", 500.0));
    println!("computed o[k] minus static o.alpha: {:.1} computrons/op", d("fn_computed_10k", "fn_static_10k", 10000.0));
    println!("Object.keys per key (5000-key object): {:.1} computrons/key", d("keys_5x5000", "keys_base", 25000.0));
}
